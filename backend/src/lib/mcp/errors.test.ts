import { describe, expect, it } from "vitest";
import {
    formatMcpErrorForAgent,
    mcpToolResultErrorMessage,
    sanitizeMcpToolErrorResult,
} from "./errors";

describe("formatMcpErrorForAgent", () => {
    it("reports an HTTP permission denial without forwarding a tools payload", () => {
        const error = Object.assign(
            new Error(
                `Streamable HTTP error: Error POSTing to endpoint: ${JSON.stringify(
                    {
                        jsonrpc: "2.0",
                        id: 1,
                        result: {
                            tools: [
                                {
                                    name: "search_files",
                                    description: "x".repeat(10_000),
                                },
                            ],
                        },
                    },
                )}`,
            ),
            { code: 403 },
        );

        expect(formatMcpErrorForAgent(error)).toEqual({
            message: "MCP server denied permission (HTTP 403).",
            httpStatus: 403,
        });
    });

    it("preserves a structured Google permission error", () => {
        const error = Object.assign(
            new Error(
                `Streamable HTTP error: Error POSTing to endpoint: ${JSON.stringify(
                    {
                        error: {
                            code: 403,
                            status: "PERMISSION_DENIED",
                            message: "The caller does not have permission.",
                        },
                    },
                )}`,
            ),
            { code: 403 },
        );

        expect(formatMcpErrorForAgent(error)).toEqual({
            message:
                "MCP server denied permission (HTTP 403). The caller does not have permission.",
            httpStatus: 403,
            serverError: {
                code: 403,
                status: "PERMISSION_DENIED",
                message: "The caller does not have permission.",
            },
        });
    });

    it("preserves MCP error data returned by the server", () => {
        const error = Object.assign(
            new Error("MCP error -32603: Tool execution failed"),
            {
                code: -32603,
                data: {
                    code: 403,
                    status: "PERMISSION_DENIED",
                    message: "The caller does not have permission.",
                },
            },
        );

        expect(formatMcpErrorForAgent(error)).toEqual({
            message:
                "MCP server returned an error. The caller does not have permission.",
            mcpCode: -32603,
            serverError: {
                code: 403,
                status: "PERMISSION_DENIED",
                message: "The caller does not have permission.",
            },
        });
    });

    it("prefers a permission error nested inside JSON-RPC error data", () => {
        const error = Object.assign(
            new Error(
                `Streamable HTTP error: Error POSTing to endpoint: ${JSON.stringify(
                    {
                        jsonrpc: "2.0",
                        id: 1,
                        error: {
                            code: -32603,
                            message: "Internal error",
                            data: {
                                code: 403,
                                status: "PERMISSION_DENIED",
                                message:
                                    "The caller does not have permission.",
                            },
                        },
                    },
                )}`,
            ),
            { code: 403 },
        );

        expect(formatMcpErrorForAgent(error)).toEqual({
            message:
                "MCP server denied permission (HTTP 403). The caller does not have permission.",
            httpStatus: 403,
            serverError: {
                code: 403,
                status: "PERMISSION_DENIED",
                message: "The caller does not have permission.",
            },
        });
    });
});

describe("mcpToolResultErrorMessage", () => {
    it("extracts text from an isError tool result", () => {
        expect(
            mcpToolResultErrorMessage({
                isError: true,
                content: [
                    {
                        type: "text",
                        text: "The caller does not have permission.",
                    },
                ],
            }),
        ).toBe("The caller does not have permission.");
    });

    it("ignores successful tool results", () => {
        expect(
            mcpToolResultErrorMessage({
                isError: false,
                content: [{ type: "text", text: "ok" }],
            }),
        ).toBeNull();
    });

    it("keeps error text but strips unrecognized fields from logs", () => {
        expect(
            sanitizeMcpToolErrorResult({
                isError: true,
                content: [
                    {
                        type: "text",
                        text: "The caller does not have permission.",
                        accessToken: "must-not-be-logged",
                    },
                ],
                _meta: {
                    authorization: "must-not-be-logged",
                },
            }),
        ).toEqual({
            isError: true,
            content: [
                {
                    type: "text",
                    text: "The caller does not have permission.",
                },
            ],
        });
    });
});
