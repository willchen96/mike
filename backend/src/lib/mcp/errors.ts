import { mcpOAuthProviderFor } from "./providers";

const MAX_MCP_ERROR_MESSAGE_CHARS = 2_000;
const POST_ERROR_MARKER = "Error POSTing to endpoint:";

type UnknownRecord = Record<string, unknown>;

export type McpErrorDiagnostic = {
    message: string;
    httpStatus?: number;
    mcpCode?: number | string;
    serverError?: {
        code?: number | string;
        status?: string;
        message: string;
    };
};

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as UnknownRecord)
        : null;
}

function truncate(value: string) {
    if (value.length <= MAX_MCP_ERROR_MESSAGE_CHARS) return value;
    return `${value.slice(0, MAX_MCP_ERROR_MESSAGE_CHARS)}…`;
}

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

function responseBodyFromMessage(message: string): unknown {
    const markerIndex = message.indexOf(POST_ERROR_MARKER);
    if (markerIndex < 0) return undefined;
    const body = message
        .slice(markerIndex + POST_ERROR_MARKER.length)
        .trim();
    return parseJson(body);
}

function serverErrorFrom(value: unknown): McpErrorDiagnostic["serverError"] {
    const record = asRecord(value);
    if (!record) return undefined;

    const nestedError = asRecord(record.error);
    const nestedData = asRecord(nestedError?.data ?? record.data);
    const candidate =
        nestedData && typeof nestedData.message === "string"
            ? nestedData
            : (nestedError ?? record);
    const message =
        typeof candidate.message === "string"
            ? candidate.message.trim()
            : typeof record.error === "string"
              ? record.error.trim()
              : "";
    if (!message) return undefined;

    return {
        ...(typeof candidate.code === "number" ||
        typeof candidate.code === "string"
            ? { code: candidate.code }
            : {}),
        ...(typeof candidate.status === "string"
            ? { status: candidate.status }
            : {}),
        message: truncate(message),
    };
}

function errorCode(error: unknown): number | string | undefined {
    const record = asRecord(error);
    return typeof record?.code === "number" ||
        typeof record?.code === "string"
        ? record.code
        : undefined;
}

/**
 * Converts SDK and remote-server failures into a compact diagnostic suitable
 * for both the model's tool result and server-side audit logs.
 *
 * In particular, Google's MCP endpoints can return a non-2xx HTTP status with
 * the entire public tools/list schema as the body. The MCP SDK embeds that body
 * in the thrown Error message. We retain the status and any real structured
 * error, but deliberately discard successful result payloads and other large
 * response bodies.
 */
export function formatMcpErrorForAgent(error: unknown): McpErrorDiagnostic {
    const rawMessage =
        error instanceof Error && error.message
            ? error.message
            : "MCP tool call failed.";
    const code = errorCode(error);
    const httpStatus =
        typeof code === "number" && code >= 100 && code <= 599
            ? code
            : undefined;
    const record = asRecord(error);
    const responseBody = responseBodyFromMessage(rawMessage);
    const serverError =
        serverErrorFrom(responseBody) ?? serverErrorFrom(record?.data);

    let message: string;
    if (httpStatus === 401) {
        message = "MCP server rejected the authentication (HTTP 401).";
    } else if (httpStatus === 403) {
        message = "MCP server denied permission (HTTP 403).";
    } else if (httpStatus) {
        message = `MCP server request failed (HTTP ${httpStatus}).`;
    } else if (serverError) {
        message = "MCP server returned an error.";
    } else {
        const markerIndex = rawMessage.indexOf(POST_ERROR_MARKER);
        message = truncate(
            markerIndex >= 0
                ? rawMessage.slice(0, markerIndex).trim()
                : rawMessage,
        );
    }

    if (
        serverError?.message &&
        !message
            .toLowerCase()
            .includes(serverError.message.toLowerCase())
    ) {
        message = `${message} ${serverError.message}`;
    }

    return {
        message: truncate(message),
        ...(httpStatus ? { httpStatus } : {}),
        ...(code !== undefined && httpStatus === undefined
            ? { mcpCode: code }
            : {}),
        ...(serverError ? { serverError } : {}),
    };
}

/**
 * One-line, user-facing failure message for connector management routes
 * (create/refresh/oauth). Reuses the agent-facing diagnostic — which already
 * strips embedded response bodies such as Google's full HTML 400 page — and
 * appends any provider-specific endpoint hint from the provider registry
 * (e.g. Google's discovery metadata advertises an unversioned `…/mcp` path
 * that yields an opaque generic 400; the hint points at the versioned one).
 */
export function conciseMcpErrorMessage(
    error: unknown,
    serverUrl?: string,
): string {
    const diagnostic = formatMcpErrorForAgent(error);
    let message = diagnostic.message;
    if (serverUrl && diagnostic.httpStatus) {
        try {
            const url = new URL(serverUrl);
            const hint = mcpOAuthProviderFor(url)?.endpointHint?.(
                url,
                diagnostic.httpStatus,
            );
            if (hint) message += ` ${hint}`;
        } catch {
            // Unparseable URL — no hint to add.
        }
    }
    return message;
}

export function mcpToolResultErrorMessage(result: unknown): string | null {
    const record = asRecord(result);
    if (record?.isError !== true) return null;

    if (Array.isArray(record.content)) {
        const messages = record.content
            .map((item) => asRecord(item))
            .map((item) =>
                item?.type === "text" && typeof item.text === "string"
                    ? item.text.trim()
                    : "",
            )
            .filter(Boolean);
        if (messages.length) return truncate(messages.join("\n"));
    }

    const structuredError = serverErrorFrom(record.structuredContent);
    return structuredError?.message ?? "MCP server reported a tool error.";
}

export function sanitizeMcpToolErrorResult(result: unknown): UnknownRecord {
    const record = asRecord(result);
    if (!record) return { isError: true };

    const content = Array.isArray(record.content)
        ? record.content.map((item) => {
              const contentItem = asRecord(item);
              if (!contentItem) return { type: "unknown" };
              return {
                  type:
                      typeof contentItem.type === "string"
                          ? contentItem.type
                          : "unknown",
                  ...(contentItem.type === "text" &&
                  typeof contentItem.text === "string"
                      ? { text: truncate(contentItem.text.trim()) }
                      : {}),
              };
          })
        : undefined;
    const structuredError = serverErrorFrom(record.structuredContent);

    return {
        isError: true,
        ...(content ? { content } : {}),
        ...(structuredError ? { structuredError } : {}),
    };
}

/**
 * A connector cannot start because THIS DEPLOYMENT is missing operator-side
 * configuration: an OAuth client for a provider that refuses to register one
 * dynamically (Google, Slack), so no amount of clicking will get past it.
 *
 * Why this is its own class: main's error posture forbids returning
 * SDK-derived text to the browser, because the MCP SDK embeds entire upstream
 * response bodies (Google's full HTML 400 page included) in `Error.message`.
 * A plain `Error` therefore has to be sanitized into a fixed string — and
 * that fixed string is useless to the person who actually needs to act,
 * who on a fresh self-hosted install is usually the one clicking Connect.
 *
 * The message carried here is static text this repository authors (the
 * provider registry's `setupInstructions`, or the Drive integration's own
 * copy) with only the deployment's redirect URI interpolated — nothing a
 * remote server or the SDK produced. Routes may therefore allowlist this
 * class and return `message` verbatim without weakening the rule for
 * everything else.
 */
export class ConnectorSetupError extends Error {
    readonly code = "connector_setup_required";
    constructor(message: string) {
        super(message);
        this.name = "ConnectorSetupError";
    }
}
