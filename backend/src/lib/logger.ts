/**
 * Tiny zero-dependency structured logger. Every call emits one JSON
 * line to stdout/stderr, which is the shape any log aggregator (CW
 * Logs, Loki, Datadog) is happy to ingest. Fields are merged into the
 * top-level object so a query like `{level=error route=/chat err_msg=*}`
 * works without parsing message strings.
 *
 * We didn't pull in pino because we only need ~30 lines, and adding a
 * dep + a bunch of transport configuration is overkill for the current
 * single-process backend. If the project grows into multi-process or
 * async transports, replace the body of this file with pino — the
 * call sites won't have to change.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

type Fields = Record<string, unknown>;

const LEVEL_RANK: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

function resolveMinLevel(): LogLevel {
    const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
    if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error")
        return raw;
    return process.env.NODE_ENV === "production" ? "info" : "debug";
}

const MIN_LEVEL = resolveMinLevel();

function serializeError(err: unknown): Fields {
    if (err instanceof Error) {
        return {
            err_name: err.name,
            err_msg: err.message,
            err_stack: err.stack,
        };
    }
    return { err: typeof err === "string" ? err : JSON.stringify(err) };
}

function emit(level: LogLevel, fields: Fields, msg?: string) {
    if (LEVEL_RANK[level] < LEVEL_RANK[MIN_LEVEL]) return;
    const merged: Fields = {
        ts: new Date().toISOString(),
        level,
        ...fields,
    };
    if (msg !== undefined) merged.msg = msg;
    const line = JSON.stringify(merged);
    if (level === "error" || level === "warn") {
        process.stderr.write(line + "\n");
    } else {
        process.stdout.write(line + "\n");
    }
}

export type Logger = {
    debug(fields: Fields, msg?: string): void;
    info(fields: Fields, msg?: string): void;
    warn(fields: Fields, msg?: string): void;
    error(fields: Fields, msg?: string): void;
    /** Returns a child logger that prefixes every event with `fields`. */
    child(fields: Fields): Logger;
};

function make(baseFields: Fields): Logger {
    return {
        debug: (fields, msg) => emit("debug", { ...baseFields, ...fields }, msg),
        info: (fields, msg) => emit("info", { ...baseFields, ...fields }, msg),
        warn: (fields, msg) => emit("warn", { ...baseFields, ...fields }, msg),
        error: (fields, msg) => emit("error", { ...baseFields, ...fields }, msg),
        child: (fields) => make({ ...baseFields, ...fields }),
    };
}

export const logger: Logger = make({});

/** Helper for `catch (err)` blocks. */
export function errFields(err: unknown): Fields {
    return serializeError(err);
}
