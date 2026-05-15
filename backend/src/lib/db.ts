import { CamelCasePlugin, Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { auth } from "./auth";
import type { DB } from "../db/types";

type DbResult<T = unknown> = {
  data: T | null;
  error: { message: string } | null;
  count?: number | null;
};

type Filter = {
  column: string;
  operator: string;
  value: unknown;
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
  plugins: [new CamelCasePlugin()],
});

function camelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function camelRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [camelCase(key), value]),
  );
}

function snakeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [snakeCase(key), value]),
  );
}

function snakeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(snakeRow);
}

function selectedColumns(columns: string): string[] | null {
  const trimmed = columns.trim();
  if (!trimmed || trimmed === "*") return null;
  return trimmed.split(",").map((part) => camelCase(part.trim()));
}

function splitOrParts(filter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of filter) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function parseOrFilter(filter: string): Filter[] {
  const filters: Filter[] = [];
  for (const part of splitOrParts(filter)) {
    const [column, operator, ...rest] = part.split(".");
    const raw = rest.join(".");
    if (!column || !operator) continue;
    if (operator === "in") {
      const list = raw.replace(/^\(/, "").replace(/\)$/, "");
      filters.push({ column, operator, value: list ? list.split(",") : [] });
      continue;
    }
    filters.push({ column, operator, value: raw });
  }
  return filters;
}

function applyFilter(query: any, filter: Filter): any {
  const column = camelCase(filter.column);
  if (filter.operator === "eq") return query.where(column, "=", filter.value);
  if (filter.operator === "neq") return query.where(column, "!=", filter.value);
  if (filter.operator === "in") return query.where(column, "in", filter.value as unknown[]);
  if (filter.operator === "is") {
    if (filter.value === null) return query.where(column, "is", null);
    if (filter.value === "NOT NULL") return query.where(column, "is not", null);
  }
  if (filter.operator === "cs") {
    const jsonValue =
      typeof filter.value === "string" ? filter.value : JSON.stringify(filter.value);
    return query.where(sql`${sql.ref(column)} @> ${jsonValue}::jsonb`);
  }
  throw new Error(`Unsupported filter operator: ${filter.operator}`);
}

class KyselyResultQuery<T = unknown> implements PromiseLike<DbResult<T>> {
  private action: "select" | "insert" | "update" | "delete" | "upsert" =
    "select";
  private columns = "*";
  private rows: Record<string, unknown>[] = [];
  private updates: Record<string, unknown> = {};
  private onConflict: string[] | null = null;
  private filters: Filter[] = [];
  private orFilters: Filter[] = [];
  private orderByClause: { column: string; ascending: boolean } | null = null;
  private limitCount: number | null = null;
  private wantsSingle = false;
  private wantsMaybeSingle = false;
  private head = false;
  private countMode: "exact" | null = null;

  constructor(private table: string) {}

  values(rowOrRows: Record<string, unknown> | Record<string, unknown>[]): this {
    this.rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    return this;
  }

  set(values: Record<string, unknown>): this {
    this.updates = values;
    return this;
  }

  returningAll(): this {
    this.columns = "*";
    return this;
  }

  selectAll(): this {
    this.columns = "*";
    return this;
  }

  select(columns = "*", options?: { count?: "exact"; head?: boolean }): this {
    this.columns = columns;
    this.head = options?.head ?? false;
    this.countMode = options?.count ?? null;
    return this;
  }

  insert(rowOrRows: Record<string, unknown> | Record<string, unknown>[]): this {
    this.action = "insert";
    this.rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.action = "update";
    this.updates = values;
    return this;
  }

  upsert(
    rowOrRows: Record<string, unknown> | Record<string, unknown>[],
    options?: { onConflict?: string },
  ): this {
    this.action = "upsert";
    this.rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    this.onConflict = options?.onConflict
      ? options.onConflict.split(",").map((key) => camelCase(key.trim()))
      : null;
    return this;
  }

  delete(): this {
    this.action = "delete";
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ column, operator: "eq", value });
    return this;
  }

  where(column: string, operator: string, value: unknown): this {
    const op =
      operator === "="
        ? "eq"
        : operator === "!=" || operator === "<>"
          ? "neq"
          : operator;
    this.filters.push({ column: snakeCase(column), operator: op, value });
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push({ column, operator: "neq", value });
    return this;
  }

  filter(column: string, operator: string, value: unknown): this {
    this.filters.push({ column, operator, value });
    return this;
  }

  in(column: string, value: unknown[]): this {
    this.filters.push({ column, operator: "in", value });
    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push({ column, operator: "is", value });
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    if (operator === "is" && value === null) {
      this.filters.push({ column, operator: "is", value: "NOT NULL" });
      return this;
    }
    throw new Error(`Unsupported not operator: ${operator}`);
  }

  or(filter: string): this {
    this.orFilters.push(...parseOrFilter(filter));
    return this;
  }

  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean },
  ): this {
    this.orderByClause = { column, ascending: options?.ascending ?? true };
    return this;
  }

  orderBy(column: string, direction: "asc" | "desc" = "asc"): this {
    this.orderByClause = { column: snakeCase(column), ascending: direction === "asc" };
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  single(): this {
    this.wantsSingle = true;
    this.limitCount ??= 1;
    return this;
  }

  maybeSingle(): this {
    this.wantsMaybeSingle = true;
    this.limitCount ??= 1;
    return this;
  }

  async then<TResult1 = DbResult<T>, TResult2 = never>(
    onfulfilled?:
      | ((value: DbResult<T>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private applyFilters(query: any): any {
    let next = query;
    for (const filter of this.filters) next = applyFilter(next, filter);
    if (this.orFilters.length) {
      next = next.where((eb: any) =>
        eb.or(
          this.orFilters.map((filter) => {
            const column = camelCase(filter.column);
            if (filter.operator === "eq") return eb(column, "=", filter.value);
            if (filter.operator === "in") {
              return eb(column, "in", filter.value as unknown[]);
            }
            throw new Error(`Unsupported or operator: ${filter.operator}`);
          }),
        ),
      );
    }
    return next;
  }

  private async selectRows(): Promise<DbResult<T>> {
    if (this.head) {
      let countQuery = db
        .selectFrom(camelCase(this.table) as never)
        .select((eb) => eb.fn.countAll<number>().as("count"));
      countQuery = this.applyFilters(countQuery);
      const row = await countQuery.executeTakeFirst();
      return { data: null, error: null, count: Number(row?.count ?? 0) };
    }

    let query = db.selectFrom(camelCase(this.table) as never);
    const columns = selectedColumns(this.columns);
    query = columns ? query.select(columns as never) : query.selectAll();
    query = this.applyFilters(query);
    if (this.orderByClause) {
      query = query.orderBy(
        camelCase(this.orderByClause.column) as never,
        this.orderByClause.ascending ? "asc" : "desc",
      );
    }
    if (this.limitCount != null) query = query.limit(this.limitCount);

    const rows = (await query.execute()) as Record<string, unknown>[];
    if (this.wantsSingle || this.wantsMaybeSingle) {
      return { data: (rows[0] ? snakeRow(rows[0]) : null) as T, error: null };
    }
    return {
      data: snakeRows(rows) as T,
      error: null,
      count: this.countMode === "exact" ? rows.length : undefined,
    };
  }

  private async execute(): Promise<DbResult<T>> {
    try {
      const table = camelCase(this.table) as never;
      if (this.action === "select") return await this.selectRows();

      if (this.action === "delete") {
        let query = db.deleteFrom(table).returningAll();
        query = this.applyFilters(query);
        const rows = (await query.execute()) as Record<string, unknown>[];
        return { data: snakeRows(rows) as T, error: null };
      }

      if (this.action === "update") {
        let query = db
          .updateTable(table)
          .set(camelRow(this.updates) as never)
          .returningAll();
        query = this.applyFilters(query);
        const rows = (await query.execute()) as Record<string, unknown>[];
        if (this.wantsSingle || this.wantsMaybeSingle) {
          return { data: (rows[0] ? snakeRow(rows[0]) : null) as T, error: null };
        }
        return { data: snakeRows(rows) as T, error: null };
      }

      const rows = this.rows.map(camelRow);
      if (rows.length === 0) return { data: [] as T, error: null };
      let query = db.insertInto(table).values(rows as never).returningAll();
      if (this.action === "upsert") {
        const conflictKeys = this.onConflict ?? [
          Object.hasOwn(rows[0], "id") ? "id" : Object.keys(rows[0])[0],
        ];
        query = query.onConflict((oc) =>
          oc.columns(conflictKeys as never).doUpdateSet(
            Object.fromEntries(
              Object.keys(rows[0])
                .filter((key) => !conflictKeys.includes(key))
                .map((key) => [key, sql`excluded.${sql.ref(key)}`]),
            ) as never,
          ),
        );
      }
      const result = (await query.execute()) as Record<string, unknown>[];
      if (this.wantsSingle || this.wantsMaybeSingle) {
        return {
          data: (result[0] ? snakeRow(result[0]) : null) as T,
          error: null,
        };
      }
      return { data: snakeRows(result) as T, error: null };
    } catch (error) {
      return {
        data: null,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}

async function listUsers(
  _options?: Record<string, unknown>,
): Promise<DbResult<{ users: { id: string; email: string }[] }>> {
  try {
    const users = await db
      .selectFrom("user")
      .select(["id", "email"])
      .orderBy("email", "asc")
      .execute();
    return { data: { users }, error: null };
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function getUserById(
  id: string,
): Promise<DbResult<{ user: { id: string; email: string } | null }>> {
  try {
    const user = await db
      .selectFrom("user")
      .select(["id", "email"])
      .where("id", "=", id)
      .executeTakeFirst();
    return { data: { user: user ?? null }, error: null };
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function deleteUser(id: string): Promise<DbResult<null>> {
  try {
    await db.deleteFrom("user").where("id", "=", id).execute();
    return { data: null, error: null };
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }
}

export function createServerDb(): any {
  return {
    selectFrom(table: string): any {
      return new KyselyResultQuery(snakeCase(table));
    },
    insertInto(table: string): any {
      const query = new KyselyResultQuery(snakeCase(table));
      query.insert([]);
      return query;
    },
    updateTable(table: string): any {
      const query = new KyselyResultQuery(snakeCase(table));
      query.update({});
      return query;
    },
    deleteFrom(table: string): any {
      const query = new KyselyResultQuery(snakeCase(table));
      query.delete();
      return query;
    },
    auth: {
      admin: {
        listUsers,
        getUserById,
        deleteUser,
      },
    },
  };
}

export async function getUserIdFromRequest(req: Request): Promise<string> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    throw new Response("Invalid or expired session", { status: 401 });
  }
  return session.user.id;
}
