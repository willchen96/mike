import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
} from "./types";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_TOKENS = 16384;

type OpenRouterMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
    }[];
    tool_call_id?: string;
};

type OpenRouterChoice = {
    delta?: {
        content?: string | null;
        tool_calls?: {
            index: number;
            id?: string;
            type?: "function";
            function?: { name?: string; arguments?: string };
        }[];
    };
    finish_reason?: string | null;
};

type OpenRouterStreamChunk = {
    choices: OpenRouterChoice[];
};

function getApiKey(override?: string | null): string {
    return override?.trim() || process.env.OPENROUTER_API_KEY || "";
}

/**
 * Strip the "openrouter/" prefix from model IDs.
 * e.g., "openrouter/openai/gpt-4o" -> "openai/gpt-4o"
 */
function toOpenRouterModelId(model: string): string {
    return model.startsWith("openrouter/") ? model.slice("openrouter/".length) : model;
}

function toOpenRouterMessages(
    systemPrompt: string,
    messages: StreamChatParams["messages"],
): OpenRouterMessage[] {
    const result: OpenRouterMessage[] = [];
    if (systemPrompt) {
        result.push({ role: "system", content: systemPrompt });
    }
    for (const m of messages) {
        result.push({ role: m.role, content: m.content });
    }
    return result;
}

export async function streamOpenRouter(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        apiKeys,
    } = params;
    const maxIter = params.maxIterations ?? 10;
    const apiKey = getApiKey(apiKeys?.openrouter);
    const openRouterModel = toOpenRouterModelId(model);

    const messages: OpenRouterMessage[] = toOpenRouterMessages(systemPrompt, params.messages);
    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        const body: Record<string, unknown> = {
            model: openRouterModel,
            messages,
            max_tokens: MAX_TOKENS,
            stream: true,
        };

        if (tools.length > 0) {
            body.tools = tools;
            body.tool_choice = "auto";
        }

        const response = await fetch(OPENROUTER_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
                "X-Title": "Mike",
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
        }

        if (!response.body) {
            throw new Error("OpenRouter response body is null");
        }

        // Parse SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // Per-iteration accumulators
        const textParts: string[] = [];
        const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === "data: [DONE]") continue;
                if (!trimmed.startsWith("data: ")) continue;

                const jsonStr = trimmed.slice(6);
                let chunk: OpenRouterStreamChunk;
                try {
                    chunk = JSON.parse(jsonStr);
                } catch {
                    continue;
                }

                console.log("[openrouter stream chunk]", JSON.stringify(chunk, null, 2));

                const choice = chunk.choices?.[0];
                if (!choice?.delta) continue;

                // Handle text content
                if (choice.delta.content) {
                    textParts.push(choice.delta.content);
                    callbacks.onContentDelta?.(choice.delta.content);
                }

                // Handle tool calls
                if (choice.delta.tool_calls) {
                    for (const tc of choice.delta.tool_calls) {
                        const existing = toolCalls.get(tc.index);
                        if (existing) {
                            // Accumulate function arguments
                            if (tc.function?.arguments) {
                                existing.arguments += tc.function.arguments;
                            }
                        } else {
                            // New tool call
                            toolCalls.set(tc.index, {
                                id: tc.id || `tool-${tc.index}`,
                                name: tc.function?.name || "",
                                arguments: tc.function?.arguments || "",
                            });
                        }
                    }
                }
            }
        }

        fullText += textParts.join("");

        // Convert accumulated tool calls to normalized format
        const normalizedCalls: NormalizedToolCall[] = [];
        for (const [, tc] of toolCalls) {
            if (!tc.name) continue;
            let input: Record<string, unknown> = {};
            try {
                input = JSON.parse(tc.arguments || "{}");
            } catch {
                input = {};
            }
            const call: NormalizedToolCall = {
                id: tc.id,
                name: tc.name,
                input,
            };
            callbacks.onToolCallStart?.(call);
            normalizedCalls.push(call);
        }

        // If no tool calls or no runTools handler, we're done
        if (!normalizedCalls.length || !runTools) {
            break;
        }

        // Execute tools and continue the loop
        const results = await runTools(normalizedCalls);

        // Add assistant message with tool calls
        messages.push({
            role: "assistant",
            content: textParts.join("") || null,
            tool_calls: normalizedCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: {
                    name: c.name,
                    arguments: JSON.stringify(c.input),
                },
            })),
        });

        // Add tool results
        for (const r of results) {
            messages.push({
                role: "tool",
                tool_call_id: r.tool_use_id,
                content: r.content,
            });
        }
    }

    return { fullText };
}

export async function completeOpenRouterText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { openrouter?: string | null };
}): Promise<string> {
    const apiKey = getApiKey(params.apiKeys?.openrouter);
    const openRouterModel = toOpenRouterModelId(params.model);

    const messages: OpenRouterMessage[] = [];
    if (params.systemPrompt) {
        messages.push({ role: "system", content: params.systemPrompt });
    }
    messages.push({ role: "user", content: params.user });

    const response = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
            "X-Title": "Mike",
        },
        body: JSON.stringify({
            model: openRouterModel,
            messages,
            max_tokens: params.maxTokens ?? 512,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? "";
}
