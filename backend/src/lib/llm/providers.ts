import { gatewayModelId, requireGatewayModel } from "./gateway";
import {
  aiSdkFetch,
  completeAiSdkText,
  streamAiSdk,
  type AiSdkAdapterConfig,
} from "./aiSdk";
import {
  isOpenCodeGoChatCompletionsModel,
  isOpenCodeGoMessagesModel,
  normalizeReasoningLevelForModel,
  openCodeGoModelId,
  openRouterModelId,
  providerForModel,
  vercelModelId,
} from "./models";
import type {
  Provider,
  ReasoningLevel,
  StreamChatParams,
  StreamChatResult,
  UserApiKeys,
} from "./types";
import { REASONING_LEVELS } from "./types";

const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL?.trim().replace(/\/+$/, "") ||
  "https://openrouter.ai/api/v1";
const OPENCODE_GO_BASE_URL =
  process.env.OPENCODE_GO_BASE_URL?.trim().replace(/\/+$/, "") ||
  "https://opencode.ai/zen/go/v1";
const VERCEL_GATEWAY_BASE_URL =
  process.env.VERCEL_AI_GATEWAY_BASE_URL?.trim().replace(/\/+$/, "");

type CompleteProviderParams = {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: UserApiKeys;
};

type RouterProvider = Extract<
  Provider,
  "openrouter" | "vercel" | "opencode-go"
>;

const ROUTER_LABELS: Record<RouterProvider, string> = {
  openrouter: "OpenRouter",
  vercel: "Vercel AI Gateway",
  "opencode-go": "OpenCode Go",
};

const ROUTER_KEY_ENV_HINTS: Record<RouterProvider, string> = {
  openrouter: "OPENROUTER_API_KEY",
  vercel: "AI_GATEWAY_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
};

function requiredKey(
  label: string,
  environmentVariable: string,
  override?: string | null,
): string {
  const key =
    override?.trim() || process.env[environmentVariable]?.trim() || "";
  if (!key) {
    throw new Error(
      `${label} API key is not configured. Set ${environmentVariable} or add a user ${label} key.`,
    );
  }
  return key;
}

function routerEnvironmentKey(provider: RouterProvider): string | undefined {
  if (provider === "vercel") {
    return (
      process.env.AI_GATEWAY_API_KEY?.trim() ||
      process.env.VERCEL_AI_GATEWAY_API_KEY?.trim()
    );
  }
  if (provider === "opencode-go") return process.env.OPENCODE_API_KEY?.trim();
  return process.env.OPENROUTER_API_KEY?.trim();
}

function routerUserKey(
  provider: RouterProvider,
  apiKeys?: UserApiKeys,
): string | null | undefined {
  if (provider === "vercel") return apiKeys?.vercel;
  if (provider === "opencode-go") return apiKeys?.["opencode-go"];
  return apiKeys?.openrouter;
}

function routerKey(provider: RouterProvider, apiKeys?: UserApiKeys): string {
  const key =
    routerUserKey(provider, apiKeys)?.trim() || routerEnvironmentKey(provider);
  if (!key) {
    throw new Error(
      `${ROUTER_LABELS[provider]} API key is not configured. Set ${ROUTER_KEY_ENV_HINTS[provider]} or add a user ${ROUTER_LABELS[provider]} key.`,
    );
  }
  return key;
}

async function createAnthropicAdapter(args: {
  provider: Extract<Provider, "claude" | "opencode-go">;
  label: string;
  model: string;
  apiKey: string;
  baseURL?: string;
  supportsReasoning: boolean;
}): Promise<AiSdkAdapterConfig> {
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const anthropic = createAnthropic({
    apiKey: args.apiKey,
    baseURL: args.baseURL,
    name: `${args.provider}.messages`,
    fetch: aiSdkFetch,
  });
  return {
    provider: args.provider,
    label: args.label,
    model: anthropic(args.model),
    modelId: args.model,
    supportsReasoning: args.supportsReasoning,
  };
}

async function createRouterAdapter(
  provider: RouterProvider,
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  if (provider === "opencode-go" && !isOpenCodeGoChatCompletionsModel(model)) {
    throw unsupportedOpenCodeGoModel(model);
  }
  const key = routerKey(provider, apiKeys);

  if (provider === "openrouter") {
    const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
    const openrouter = createOpenRouter({
      apiKey: key,
      baseURL: OPENROUTER_BASE_URL,
      compatibility: "strict",
      appName: "Mike",
      appUrl: process.env.FRONTEND_URL,
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: ROUTER_LABELS[provider],
      model: openrouter.chat(openRouterModelId(model)),
      modelId: model,
    };
  }

  if (provider === "vercel") {
    const { createGateway } = await import("ai");
    const gateway = createGateway({
      apiKey: key,
      ...(VERCEL_GATEWAY_BASE_URL ? { baseURL: VERCEL_GATEWAY_BASE_URL } : {}),
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: ROUTER_LABELS[provider],
      model: gateway.chat(vercelModelId(model)),
      modelId: model,
    };
  }

  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const openCodeGo = createOpenAICompatible({
    name: "opencodeGo",
    apiKey: key,
    baseURL: OPENCODE_GO_BASE_URL,
    fetch: aiSdkFetch,
  });
  return {
    provider,
    label: ROUTER_LABELS[provider],
    model: openCodeGo(openCodeGoModelId(model)),
    modelId: model,
    supportsReasoning: false,
  };
}

function unsupportedOpenCodeGoModel(model: string): Error {
  return new Error(
    `OpenCode Go model ${openCodeGoModelId(model)} requires a protocol Mike does not support yet. Select a model listed in Settings → Bring Your Own Keys → Routers.`,
  );
}

function ollamaBaseUrl(): string {
  return (
    process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434/v1"
  ).replace(/\/$/, "");
}

function ollamaModelName(model: string): string {
  const tag = model.replace(/^ollama\/?/, "");
  return tag || process.env.OLLAMA_MODEL?.trim() || "qwen3.6";
}

export function ollamaAuthHeaders(): Record<string, string> {
  const key = process.env.OLLAMA_API_KEY?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function createProviderAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const provider = providerForModel(model);

  if (provider === "gateway") {
    const config = requireGatewayModel(model);
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const gateway = createOpenAICompatible({
      name: "gateway",
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: config.label,
      model: gateway(gatewayModelId(model)),
      modelId: model,
      // Reasoning controls stay off until Mike can tell which models behind
      // an arbitrary gateway accept them: the field is an optional OpenAI
      // extension that stricter gateways reject outright, and levels are
      // forwarded verbatim without Vercel's provider-specific translation.
      supportsReasoning: false,
    };
  }

  if (provider === "claude") {
    return createAnthropicAdapter({
      provider,
      label: "Claude",
      model,
      apiKey: requiredKey("Anthropic", "ANTHROPIC_API_KEY", apiKeys?.claude),
      supportsReasoning: true,
    });
  }

  if (provider === "gemini") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const google = createGoogleGenerativeAI({
      apiKey: requiredKey("Gemini", "GEMINI_API_KEY", apiKeys?.gemini),
      fetch: aiSdkFetch,
    });
    return { provider, label: "Gemini", model: google(model), modelId: model };
  }

  if (provider === "openai") {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({
      apiKey: requiredKey("OpenAI", "OPENAI_API_KEY", apiKeys?.openai),
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: "OpenAI",
      model: openai.responses(model),
      modelId: model,
      courtlistenerCitationReminder: true,
    };
  }

  if (provider === "openrouter" || provider === "vercel") {
    return createRouterAdapter(provider, model, apiKeys);
  }

  if (provider === "opencode-go") {
    if (isOpenCodeGoMessagesModel(model)) {
      return createAnthropicAdapter({
        provider,
        label: "OpenCode Go",
        model: openCodeGoModelId(model),
        apiKey: routerKey(provider, apiKeys),
        baseURL: OPENCODE_GO_BASE_URL,
        supportsReasoning: false,
      });
    }
    return createRouterAdapter(provider, model, apiKeys);
  }

  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const ollama = createOpenAICompatible({
    name: "ollama",
    baseURL: ollamaBaseUrl(),
    headers: ollamaAuthHeaders(),
    fetch: aiSdkFetch,
  });
  return {
    provider,
    label: "Ollama",
    model: ollama(ollamaModelName(model)),
    modelId: model,
    supportsReasoning: false,
  };
}

export async function streamWithProvider(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const normalizedParams = {
    ...params,
    reasoning: normalizeReasoningLevelForModel(params.model, params.reasoning),
  };
  try {
    return await streamAiSdk(
      normalizedParams,
      await createProviderAdapter(params.model, params.apiKeys),
    );
  } catch (error) {
    const retryReasoning = fallbackReasoningLevelFromProviderError(
      error,
      normalizedParams.reasoning,
    );
    if (retryReasoning) {
      return streamAiSdk(
        { ...normalizedParams, reasoning: retryReasoning },
        await createProviderAdapter(params.model, params.apiKeys),
      );
    }
    if (
      providerForModel(params.model) === "ollama" &&
      params.tools?.length &&
      /does not support tools/i.test(
        error instanceof Error ? error.message : String(error),
      )
    ) {
      return streamAiSdk(
        { ...normalizedParams, tools: undefined, runTools: undefined },
        await createProviderAdapter(params.model, params.apiKeys),
      );
    }
    throw error;
  }
}

/**
 * Provider model capabilities can change ahead of the SDK's shared types.
 * Retry request-validation failures at the nearest level advertised by the
 * provider, before any stream content has been emitted.
 */
export function fallbackReasoningLevelFromProviderError(
  error: unknown,
  requested: ReasoningLevel | undefined,
): ReasoningLevel | undefined {
  if (!requested) return undefined;
  const message = error instanceof Error ? error.message : String(error);
  const marker = "supported values are:";
  const markerIndex = message.toLocaleLowerCase().indexOf(marker);
  if (markerIndex < 0) return undefined;
  const supportedText = message.slice(markerIndex + marker.length).trimStart();
  if (!supportedText) return undefined;

  const supported = [...supportedText.matchAll(/'([^']+)'/g)]
    .map((match) => match[1])
    .filter(
      (level): level is ReasoningLevel =>
        !!level && (REASONING_LEVELS as readonly string[]).includes(level),
    );
  if (!supported.length || supported.includes(requested)) return undefined;

  const requestedIndex = REASONING_LEVELS.indexOf(requested);
  return supported.reduce((nearest, candidate) => {
    const nearestDistance = Math.abs(
      REASONING_LEVELS.indexOf(nearest) - requestedIndex,
    );
    const candidateDistance = Math.abs(
      REASONING_LEVELS.indexOf(candidate) - requestedIndex,
    );
    return candidateDistance <= nearestDistance ? candidate : nearest;
  });
}

export async function completeWithProvider(
  params: CompleteProviderParams,
): Promise<string> {
  return completeAiSdkText(
    params,
    await createProviderAdapter(params.model, params.apiKeys),
  );
}
