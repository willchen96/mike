import { streamClaude, completeClaudeText } from "./claude";
import { streamGemini, completeGeminiText } from "./gemini";
import { streamOpenAI, completeOpenAIText } from "./openai";
import { providerForModel } from "./models";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";
import { assertFreeTierAllowed } from "./freeTierGuard";

export * from "./types";
export * from "./models";
export { isFreeTierModel } from "./freeTierGuard";

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    assertFreeTierAllowed({
        model: params.model,
        documentFilenames: params.documentFilenames,
    });
    const provider = providerForModel(params.model);
    if (provider === "claude") return streamClaude(params);
    if (provider === "openai") return streamOpenAI(params);
    return streamGemini(params);
}

export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
    documentFilenames?: string[];
}): Promise<string> {
    assertFreeTierAllowed({
        model: params.model,
        documentFilenames: params.documentFilenames,
    });
    const provider = providerForModel(params.model);
    if (provider === "claude") return completeClaudeText(params);
    if (provider === "openai") return completeOpenAIText(params);
    return completeGeminiText(params);
}
