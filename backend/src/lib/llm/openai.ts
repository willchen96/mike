import OpenAI from "openai";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
    NormalizedToolResult,
} from "./types";
import { toClaudeTools } from "./tools";

type OpenAIMessage = {
    role: "user" | "assistant" | "system";
    content: string;
};

type OpenAIToolCall = {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
};

const MAX_TOKENS = 16384;

function getClient(override?: string | null): OpenAI {
    const apiKey = override?.trim() || process.env.VLLM_API_KEY || "";
    const baseURL = process.env.VLLM_BASE_URL || "http://localhost:8000/v1";
    console.log("[localllm] Client init:", { baseURL, apiKeyPresent: !!apiKey });
    return new OpenAI({
        apiKey,
        baseURL,
    });
}

function getActualModelName(model: string): string {
    if (model === "localllm-main") {
        return process.env.VLLM_MAIN_MODEL || "BredaAI";
    }
    if (model === "localllm-lite") {
        return process.env.VLLM_LIGHT_MODEL || "unsloth/gemma-4-E2B-it-GGUF:Q5_K_S";
    }
    return model;
}

function toNativeMessages(
    messages: StreamChatParams["messages"],
): OpenAIMessage[] {
    return messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
    }));
}

export async function streamOpenAI(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        apiKeys,
        enableThinking,
    } = params;
    const maxIter = params.maxIterations ?? 10;
    
    const actualModel = getActualModelName(model);
    console.log("[localllm] streaming request:", { 
        internalModel: model, 
        actualModel,
        baseURL: process.env.VLLM_BASE_URL 
    });
    
    const client = getClient(apiKeys?.openai);

    const messages: OpenAIMessage[] = toNativeMessages(params.messages);
    let fullText = "";

    try {
        for (let iter = 0; iter < maxIter; iter++) {
            const systemMessage = systemPrompt
                ? [{ role: "system" as const, content: systemPrompt }]
                : [];
            
            const stream = await client.chat.completions.create({
                model: actualModel,
                messages: [...systemMessage, ...messages] as any,
                tools: tools.length
                    ? tools.map((t) => ({
                          type: "function",
                          function: {
                              name: t.function.name,
                              description: t.function.description,
                              parameters: t.function.parameters,
                          },
                      }))
                    : undefined,
                stream: true,
            });

            let toolCalls: NormalizedToolCall[] = [];
            let currentText = "";

            for await (const chunk of stream) {
                const choice = chunk.choices?.[0];
                if (!choice) continue;

                const delta = choice.delta;

                if (delta?.content) {
                    currentText += delta.content;
                    callbacks.onContentDelta?.(delta.content);
                }

                if (delta?.tool_calls && delta.tool_calls.length > 0) {
                    for (const tc of delta.tool_calls) {
                        if (tc.type === "function" && tc.function) {
                            const call: NormalizedToolCall = {
                                id: tc.id || `call-${toolCalls.length}`,
                                name: tc.function.name || "unknown",
                                input: tc.function.arguments
                                    ? JSON.parse(tc.function.arguments)
                                    : {},
                            };
                            callbacks.onToolCallStart?.(call);
                            toolCalls.push(call);
                        }
                    }
                }
            }

            fullText += currentText;

            if (toolCalls.length > 0 && runTools) {
                const results = await runTools(toolCalls);

                const assistantMessage: OpenAIMessage = {
                    role: "assistant",
                    content: currentText,
                };
                messages.push(assistantMessage);

                const toolMessages: OpenAIMessage[] = results.map((r) => ({
                    role: "tool" as any,
                    content: r.content,
                }));
                messages.push(...toolMessages);
            } else {
                break;
            }
        }
    } catch (error: any) {
        console.error("[localllm] streaming error:", error.message);
        console.error("[localllm] error details:", JSON.stringify(error, null, 2));
        throw error;
    }

    return { fullText };
}

export async function completeOpenAIText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { openai?: string | null };
}): Promise<string> {
    const client = getClient(params.apiKeys?.openai);
    const actualModel = getActualModelName(params.model);

    const messages: OpenAIMessage[] = [
        ...(params.systemPrompt
            ? [{ role: "system" as const, content: params.systemPrompt }]
            : []),
        { role: "user", content: params.user },
    ];

    const response = await client.chat.completions.create({
        model: actualModel,
        messages: messages as any,
        max_tokens: params.maxTokens ?? 512,
    });

    return response.choices?.[0]?.message?.content || "";
}

export type { NormalizedToolResult };
