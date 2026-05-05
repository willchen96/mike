// Thin wrapper around the MCP TypeScript SDK's Streamable-HTTP client.
//
// Mike opens one client per (user, MCP server) per chat request. Connections
// are short-lived: we initialize, list tools, run any tools the model calls,
// then close in a `finally` on the request handler. There is no connection
// pool — each chat request pays an `initialize` round-trip per enabled
// server. This keeps the design stateless and avoids needing a worker.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;

export class McpHttpClient {
    private client: Client | null = null;
    private transport: StreamableHTTPClientTransport | null = null;

    constructor(
        private readonly url: string,
        private readonly headers: Record<string, string>,
        private readonly authProvider?: OAuthClientProvider,
    ) {}

    async connect(): Promise<void> {
        this.transport = new StreamableHTTPClientTransport(new URL(this.url), {
            requestInit: {
                headers: this.headers,
            },
            ...(this.authProvider ? { authProvider: this.authProvider } : {}),
        });
        this.client = new Client(
            { name: "mike", version: "1.0.0" },
            { capabilities: {} },
        );
        await withTimeout(
            this.client.connect(this.transport),
            CONNECT_TIMEOUT_MS,
            "MCP connect",
        );
    }

    async listTools(): Promise<Tool[]> {
        if (!this.client) throw new Error("MCP client not connected");
        const result = await withTimeout(
            this.client.listTools(),
            CONNECT_TIMEOUT_MS,
            "MCP listTools",
        );
        return result.tools as Tool[];
    }

    /**
     * Calls a tool and returns its text content joined by blank lines.
     * Errors (transport failures, MCP `isError`) are turned into a text
     * response so the model can surface them rather than crashing the chat.
     */
    async callTool(
        name: string,
        args: Record<string, unknown>,
    ): Promise<string> {
        if (!this.client) return "MCP client not connected";
        try {
            const result = await withTimeout(
                this.client.callTool({ name, arguments: args }),
                CALL_TIMEOUT_MS,
                `MCP callTool(${name})`,
            );
            const blocks = (result.content ?? []) as Array<{
                type?: string;
                text?: string;
            }>;
            const text = blocks
                .filter((b) => b?.type === "text" && typeof b.text === "string")
                .map((b) => b.text)
                .join("\n\n");
            if (result.isError) {
                return `MCP tool '${name}' returned error: ${text || "(no detail)"}`;
            }
            return text || "(tool returned no text content)";
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `MCP tool '${name}' failed: ${msg}`;
        }
    }

    async close(): Promise<void> {
        try {
            await this.client?.close();
        } catch {
            /* ignore */
        }
        try {
            await this.transport?.close();
        } catch {
            /* ignore */
        }
        this.client = null;
        this.transport = null;
    }
}

function withTimeout<T>(
    p: Promise<T>,
    ms: number,
    label: string,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(
            () => reject(new Error(`${label} timed out after ${ms}ms`)),
            ms,
        );
        p.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            (e) => {
                clearTimeout(t);
                reject(e);
            },
        );
    });
}
