import { GoogleGenAI } from "@google/genai";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
} from "./types";
import { heyJudeApiKey, heyJudeBaseUrl, heyJudeEnabled } from "./heyJude";
import { toGeminiTools } from "./tools";

type GeminiPart = {
    text?: string;
    // Set by Gemini when the text content is a thought summary rather than
    // final-answer prose. Requires `thinkingConfig.includeThoughts: true`.
    thought?: boolean;
    functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
    functionResponse?: {
        id?: string;
        name: string;
        response: Record<string, unknown>;
    };
    // Gemini 3 returns a thoughtSignature on parts that contain reasoning or
    // a functionCall. It must be echoed back verbatim on the same part when
    // we replay the model's turn, or the API rejects the next call.
    thoughtSignature?: string;
};

type GeminiContent = {
    role: "user" | "model";
    parts: GeminiPart[];
};

function apiKey(override?: string | null): string {
    const key = override?.trim() || process.env.GEMINI_API_KEY?.trim() || "";
    if (!key) {
        throw new Error(
            "Gemini API key is not configured. Set GEMINI_API_KEY or add a user Gemini key.",
        );
    }
    return key;
}

function client(override?: string | null): GoogleGenAI {
    if (heyJudeEnabled()) {
        return new GoogleGenAI({
            apiKey: heyJudeApiKey(),
            httpOptions: { baseUrl: heyJudeBaseUrl() },
        });
    }
    return new GoogleGenAI({ apiKey: apiKey(override) });
}

function toNativeContents(messages: StreamChatParams["messages"]): GeminiContent[] {
    return messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
    }));
}

export async function streamGemini(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const { model, systemPrompt, tools = [], callbacks = {}, runTools, apiKeys, enableThinking } = params;
    const maxIter = params.maxIterations ?? 10;
    const ai = client(apiKeys?.gemini);
    const functionDeclarations = toGeminiTools(tools);

    const contents: GeminiContent[] = toNativeContents(params.messages);
    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        const stream = await ai.models.generateContentStream({
            model,
            contents: contents as never,
            config: {
                systemInstruction: systemPrompt,
                tools: functionDeclarations.length
                    ? [{ functionDeclarations } as never]
                    : undefined,
                // When enabled, ask Gemini to surface thought summaries.
                // When disabled, explicitly zero the thinking budget so the
                // model skips thinking entirely (saves tokens and latency
                // for bulk extraction jobs).
                thinkingConfig: enableThinking
                    ? { includeThoughts: true }
                    : { thinkingBudget: 0 },
            },
        });

        // Per-iteration accumulators.
        const textParts: string[] = [];
        const callParts: GeminiPart[] = [];
        const toolCalls: NormalizedToolCall[] = [];
        let sawThinking = false;

        for await (const chunk of stream) {
            const parts =
                (chunk as { candidates?: { content?: { parts?: GeminiPart[] } }[] })
                    .candidates?.[0]?.content?.parts ?? [];

            for (const part of parts) {
                if (part.text) {
                    if (part.thought) {
                        sawThinking = true;
                        callbacks.onReasoningDelta?.(part.text);
                    } else {
                        textParts.push(part.text);
                        callbacks.onContentDelta?.(part.text);
                    }
                }
                if (part.functionCall) {
                    // Preserve the whole part (including thoughtSignature)
                    // so it can be echoed verbatim in the replay turn.
                    callParts.push(part);
                    const call: NormalizedToolCall = {
                        id: part.functionCall.id ?? `${part.functionCall.name}-${toolCalls.length}`,
                        name: part.functionCall.name,
                        input: part.functionCall.args ?? {},
                    };
                    callbacks.onToolCallStart?.(call);
                    toolCalls.push(call);
                }
            }
        }

        if (sawThinking) callbacks.onReasoningBlockEnd?.();

        fullText += textParts.join("");

        if (!toolCalls.length || !runTools) {
            break;
        }

        const results = await runTools(toolCalls);

        // Append the model's turn (text + functionCall parts, in that order)
        // and the matching functionResponse turn.
        const modelParts: GeminiPart[] = [];
        if (textParts.length) modelParts.push({ text: textParts.join("") });
        for (const cp of callParts) modelParts.push(cp);
        contents.push({ role: "model", parts: modelParts });

        contents.push({
            role: "user",
            parts: results.map((r) => {
                const match = toolCalls.find((c) => c.id === r.tool_use_id);
                return {
                    functionResponse: {
                        ...(r.tool_use_id && !r.tool_use_id.startsWith(match?.name ?? "")
                            ? { id: r.tool_use_id }
                            : {}),
                        name: match?.name ?? "tool",
                        response: { output: r.content },
                    },
                };
            }),
        });
    }

    return { fullText };
}

export async function completeGeminiText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    apiKeys?: { gemini?: string | null };
}): Promise<string> {
    const ai = client(params.apiKeys?.gemini);
    const resp = await ai.models.generateContent({
        model: params.model,
        contents: [{ role: "user", parts: [{ text: params.user }] }],
        config: params.systemPrompt
            ? { systemInstruction: params.systemPrompt }
            : undefined,
    });
    return resp.text ?? "";
}
