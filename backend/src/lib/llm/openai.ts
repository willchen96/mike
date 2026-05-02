import OpenAI from "openai";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
} from "./types";

function client(override?: string | null): OpenAI {
    const apiKey = override?.trim() || process.env.OPENAI_API_KEY || "";
    return new OpenAI({ apiKey });
}

function toOpenAITools(
    tools: StreamChatParams["tools"],
): OpenAI.ChatCompletionTool[] | undefined {
    if (!tools?.length) return undefined;
    return tools.map((t) => ({
        type: "function" as const,
        function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
        },
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
    } = params;
    const maxIter = params.maxIterations ?? 10;
    const openai = client(apiKeys?.openai);
    const openaiTools = toOpenAITools(tools);

    const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
        ...params.messages.map(
            (m): OpenAI.ChatCompletionMessageParam => ({
                role: m.role,
                content: m.content,
            }),
        ),
    ];

    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        const stream = await openai.chat.completions.create({
            model,
            messages,
            tools: openaiTools,
            stream: true,
        });

        const textParts: string[] = [];
        const toolCalls: NormalizedToolCall[] = [];
        const toolCallAccumulators: Map<
            number,
            { id: string; name: string; args: string }
        > = new Map();

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
                textParts.push(delta.content);
                callbacks.onContentDelta?.(delta.content);
            }

            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const existing = toolCallAccumulators.get(tc.index);
                    if (existing) {
                        if (tc.function?.arguments)
                            existing.args += tc.function.arguments;
                    } else {
                        toolCallAccumulators.set(tc.index, {
                            id: tc.id ?? `tool-${tc.index}`,
                            name: tc.function?.name ?? "",
                            args: tc.function?.arguments ?? "",
                        });
                    }
                }
            }
        }

        for (const [, acc] of toolCallAccumulators) {
            let input: Record<string, unknown> = {};
            try {
                input = JSON.parse(acc.args);
            } catch {}
            const call: NormalizedToolCall = {
                id: acc.id,
                name: acc.name,
                input,
            };
            callbacks.onToolCallStart?.(call);
            toolCalls.push(call);
        }

        fullText += textParts.join("");

        if (!toolCalls.length || !runTools) {
            break;
        }

        const results = await runTools(toolCalls);

        messages.push({
            role: "assistant",
            content: textParts.join("") || null,
            tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.input),
                },
            })),
        });

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

export async function completeOpenAIText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { openai?: string | null };
}): Promise<string> {
    const openai = client(params.apiKeys?.openai);
    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    if (params.systemPrompt) {
        messages.push({ role: "system", content: params.systemPrompt });
    }
    messages.push({ role: "user", content: params.user });
    const resp = await openai.chat.completions.create({
        model: params.model,
        messages,
        max_tokens: params.maxTokens ?? 512,
    });
    return resp.choices[0]?.message?.content ?? "";
}
