import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

(hasDatabaseUrl ? describe : describe.skip)(
  "RLS — helper function shape (D-01)",
  () => {
    let client: Client;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
    });
    afterAll(async () => {
      await client.end();
    });

    const helpers = [
      "is_project_member",
      "is_review_member",
      "is_workflow_visible",
      "is_chat_owner",
      "is_document_member",
    ] as const;

    for (const name of helpers) {
      it(`${name} is language sql, stable, security definer`, async () => {
        const { rows } = await client.query(
          `select l.lanname, p.provolatile, p.prosecdef
             from pg_proc p
             join pg_language l on l.oid = p.prolang
            where p.proname = $1
              and p.pronamespace = 'public'::regnamespace`,
          [name],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].lanname).toBe("sql");        // NOT plpgsql — kills GIN-pushdown (RESEARCH §2 Pitfall 1)
        expect(rows[0].provolatile).toBe("s");      // STABLE = 's' (per pg_proc docs)
        expect(rows[0].prosecdef).toBe(true);       // SECURITY DEFINER
      });
    }

    it("all 5 helpers have search_path = public in proconfig", async () => {
      const { rows } = await client.query(
        `select proname, proconfig
           from pg_proc
          where proname = ANY($1::text[])
            and pronamespace = 'public'::regnamespace`,
        [Array.from(helpers)],
      );
      expect(rows.length).toBe(5);
      for (const row of rows) {
        const cfg: string[] = row.proconfig ?? [];
        const hasSearchPath = cfg.some((s) => s.startsWith("search_path="));
        expect(hasSearchPath).toBe(true);
      }
    });
  },
);
