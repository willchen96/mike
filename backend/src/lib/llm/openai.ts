import type {
    LlmMessage,
    NormalizedToolCall,
    NormalizedToolResult,
    OpenAIToolSchema,
    StreamChatParams,
    StreamChatResult,
} from "./types";
import { heyJudeApiKey, heyJudeBaseUrl, heyJudeEnabled } from "./heyJude";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_OUTPUT_TOKENS = 16384;

type ResponseInputItem =
    | { role: "user" | "assistant"; content: string }
    | { type: "function_call_output"; call_id: string; output: string };

type ResponseFunctionTool = {
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
};

type ResponseFunctionCallItem = {
    type: "function_call";
    call_id?: string;
    name?: string;
    arguments?: string;
};

type ResponseStreamEvent = {
    type?: string;
    delta?: string;
    response?: { id?: string; output_text?: string };
    item?: ResponseFunctionCallItem;
};

function apiKey(override?: string | null): string {
    if (heyJudeEnabled()) {
        return heyJudeApiKey();
    }
    const key = override?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
    if (!key) {
        throw new Error(
            "OpenAI API key is not configured. Set OPENAI_API_KEY or add a user OpenAI key.",
        );
    }
    return key;
}

function responsesUrl(): string {
    if (heyJudeEnabled()) {
        return `${heyJudeBaseUrl()}/v1/responses`;
    }
    return OPENAI_RESPONSES_URL;
}

function toResponseTools(tools: OpenAIToolSchema[]): ResponseFunctionTool[] {
    return tools.map((tool) => ({
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
}

function toResponseInput(messages: LlmMessage[]): ResponseInputItem[] {
    return messages.map((message) => ({
        role: message.role,
        content: message.content,
    }));
}

function extractSseJson(buffer: string): { events: unknown[]; rest: string } {
    const events: unknown[] = [];
    const chunks = buffer.split(/\n\n/);
    const rest = chunks.pop() ?? "";

    for (const chunk of chunks) {
        const dataLines = chunk
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());

        for (const data of dataLines) {
            if (!data || data === "[DONE]") continue;
            try {
                events.push(JSON.parse(data));
            } catch {
                // Incomplete events stay buffered until the next read.
            }
        }
    }

    return { events, rest };
}

function parseFunctionCall(item: ResponseFunctionCallItem): NormalizedToolCall {
    let input: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(item.arguments || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
        }
    } catch {
        input = {};
    }

    return {
        id: item.call_id ?? item.name ?? "function_call",
        name: item.name ?? "",
        input,
    };
}

async function createResponse(params: {
    model: string;
    input: ResponseInputItem[];
    instructions?: string;
    tools?: ResponseFunctionTool[];
    stream?: boolean;
    maxTokens?: number;
    previousResponseId?: string;
    reasoningSummary?: boolean;
    apiKey: string;
}): Promise<Response> {
    const response = await fetch(responsesUrl(), {
        method: "POST",
        headers: {
            Authorization: `Bearer ${params.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: params.model,
            instructions: params.instructions || undefined,
            input: params.input,
            tools: params.tools?.length ? params.tools : undefined,
            stream: params.stream,
            max_output_tokens: params.maxTokens ?? MAX_OUTPUT_TOKENS,
            previous_response_id: params.previousResponseId,
            reasoning: params.reasoningSummary
                ? { summary: "auto" }
                : undefined,
        }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        const err = new Error(
            `OpenAI request failed (${response.status}): ${text || response.statusText}`,
        );
        (err as { status?: number }).status = response.status;
        throw err;
    }

    return response;
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
    const key = apiKey(apiKeys?.openai);
    const responseTools = toResponseTools(tools);
    let input = toResponseInput(params.messages);
    let previousResponseId: string | undefined;
    let fullText = "";
    const hasTools = responseTools.length > 0;

    for (let iter = 0; iter < maxIter; iter++) {
        const response = await createResponse({
            model,
            instructions: iter === 0 ? systemPrompt : undefined,
            input,
            tools: responseTools,
            stream: true,
            previousResponseId,
            reasoningSummary: !!enableThinking,
            apiKey: key,
        });
        if (!response.body) throw new Error("OpenAI response had no body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const toolCalls: NormalizedToolCall[] = [];
        const startedToolCallIds = new Set<string>();
        let buffer = "";
        let pendingText = "";
        let sawReasoning = false;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const extracted = extractSseJson(buffer);
            buffer = extracted.rest;

            for (const event of extracted.events as ResponseStreamEvent[]) {
                if (event.response?.id) {
                    previousResponseId = event.response.id;
                }

                if (
                    event.type === "response.reasoning_summary_text.delta" &&
                    typeof event.delta === "string"
                ) {
                    sawReasoning = true;
                    callbacks.onReasoningDelta?.(event.delta);
                }

                if (
                    event.type === "response.output_text.delta" &&
                    typeof event.delta === "string"
                ) {
                    if (hasTools) {
                        pendingText += event.delta;
                    } else {
                        fullText += event.delta;
                        callbacks.onContentDelta?.(event.delta);
                    }
                }

                if (
                    event.type === "response.output_item.added" &&
                    event.item?.type === "function_call"
                ) {
                    const call = parseFunctionCall(event.item);
                    startedToolCallIds.add(call.id);
                    callbacks.onToolCallStart?.(call);
                }

                if (
                    event.type === "response.output_item.done" &&
                    event.item?.type === "function_call"
                ) {
                    const call = parseFunctionCall(event.item);
                    if (!startedToolCallIds.has(call.id)) {
                        callbacks.onToolCallStart?.(call);
                    }
                    toolCalls.push(call);
                }
            }
        }

        if (sawReasoning) callbacks.onReasoningBlockEnd?.();

        if (!toolCalls.length || !runTools) {
            if (pendingText) {
                fullText += pendingText;
                callbacks.onContentDelta?.(pendingText);
            }
            break;
        }

        const results = await runTools(toolCalls);
        input = results.map((result) => ({
            type: "function_call_output",
            call_id: result.tool_use_id,
            output: result.content,
        }));
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
    const response = await createResponse({
        model: params.model,
        instructions: params.systemPrompt,
        input: [{ role: "user", content: params.user }],
        maxTokens: params.maxTokens ?? 512,
        apiKey: apiKey(params.apiKeys?.openai),
    });
    const json = (await response.json()) as {
        output_text?: string;
        output?: {
            content?: { type?: string; text?: string }[];
        }[];
    };

    if (typeof json.output_text === "string") return json.output_text;

    return (
        json.output
            ?.flatMap((item) => item.content ?? [])
            .filter((content) => content.type === "output_text")
            .map((content) => content.text ?? "")
            .join("") ?? ""
    );
}

export type { NormalizedToolResult };
