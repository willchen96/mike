"use client";

import { useEffect } from "react";
import {
  ModelToggleUI,
  nearestReasoningLevelForModel,
  reasoningLevelsForModel,
  type ModelToggleOption,
  type ReasoningLevel,
} from "@/shared/ui/ModelToggleUI";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import type { ApiKeyState } from "@/app/lib/mikeApi";
import { useOllamaModels } from "@/app/hooks/useOllamaModels";

export type ModelOption = ModelToggleOption;
export type { ReasoningLevel };

export const MODELS: ModelOption[] = [
  { id: "claude-fable-5", label: "Claude Fable 5", group: "Anthropic" },
  { id: "claude-opus-5", label: "Claude Opus 5", group: "Anthropic" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", group: "Anthropic" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", group: "Anthropic" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", group: "Anthropic" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", group: "Google" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", group: "Google" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", group: "Google" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", group: "Google" },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", group: "Google" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", group: "OpenAI" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", group: "OpenAI" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", group: "OpenAI" },
  { id: "gpt-5.5", label: "GPT-5.5", group: "OpenAI" },
  { id: "gpt-5.4", label: "GPT-5.4", group: "OpenAI" },
  // Local (Ollama) models are appended dynamically — see useOllamaModels.
];

export const SETTINGS_MODELS: ModelOption[] = [
  ...MODELS,
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", group: "Anthropic" },
  {
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    group: "Google",
  },
  {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    group: "Google",
  },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", group: "OpenAI" },
];

for (const model of MODELS) model.source = "Direct";
for (const model of SETTINGS_MODELS) model.source ??= "Direct";

export const DEFAULT_MODEL_ID = "";

export const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));

// Renamed/retired static ids → their current equivalents. Stored preferences
// (profile fields, localStorage selections) outlive catalog renames; mapping
// them on read keeps an old saved value working instead of orphaning it.
// Kept in sync with backend/src/lib/llm/models.ts LEGACY_MODEL_IDS.
export const LEGACY_MODEL_IDS: Record<string, string> = {
  "gemini-3.1-flash-lite-preview": "gemini-3.5-flash-lite",
  "gpt-5.4-lite": "gpt-5.4-mini",
};

export function canonicalModelId(id: string): string {
  return LEGACY_MODEL_IDS[id] ?? id;
}

const MODEL_NAME_ACRONYMS: Record<string, string> = {
  ai: "AI",
  gpt: "GPT",
  oss: "OSS",
  r1: "R1",
};

export function modelDisplayName(modelId: string): string {
  const normalized = modelId
    .replace(/^(?:openrouter|vercel|opencode-go|ollama)\//, "")
    .split("/")
    .at(-1)!
    .replace(/(\d)-(\d)/g, "$1.$2");
  const [rawName, variant] = normalized.split(":", 2);
  const name = rawName ?? normalized;
  const label = name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((token) => {
      const lower = token.toLowerCase();
      if (MODEL_NAME_ACRONYMS[lower]) {
        return MODEL_NAME_ACRONYMS[lower];
      }
      if (/^\d+[bk]$/i.test(token)) return token.toUpperCase();
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(" ");
  if (!variant) return label;
  const variantLabel = variant
    .split(/[-_]+/)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
  return `${label} (${variantLabel})`;
}

/**
 * Router slugs, which double as model-id prefixes and API-key provider names.
 * Kept in sync with backend/src/lib/routerModels.ts ROUTER_SLUGS.
 */
export const ROUTER_SLUGS = ["openrouter", "vercel", "opencode-go"] as const;
export type RouterSlug = (typeof ROUTER_SLUGS)[number];

const ROUTER_VENDOR_GROUPS: Record<string, string> = {
  anthropic: "Anthropic",
  claude: "Anthropic",
  google: "Google",
  gemini: "Google",
  openai: "OpenAI",
  gpt: "OpenAI",
  moonshot: "Moonshot AI",
  moonshotai: "Moonshot AI",
  kimi: "Moonshot AI",
  zhipu: "Zhipu AI",
  zhipuai: "Zhipu AI",
  zai: "Zhipu AI",
  minimax: "MiniMax",
  qwen: "Alibaba",
  alibaba: "Alibaba",
  deepseek: "DeepSeek",
  xiaomi: "Xiaomi",
  mimo: "Xiaomi",
  mistral: "Mistral AI",
  mistralai: "Mistral AI",
};

/** Model maker used for grouping; the router remains a separate source. */
export function underlyingProviderGroup(
  catalogModelId: string,
  router: RouterSlug,
): string {
  const vendor = catalogModelId.includes("/")
    ? catalogModelId.split("/", 1)[0]!.toLowerCase()
    : catalogModelId.toLowerCase().split(/[-_.]/, 1)[0]!;
  const mapped = ROUTER_VENDOR_GROUPS[vendor];
  if (mapped) return mapped;
  if (catalogModelId.includes("/")) {
    return vendor
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  if (router === "opencode-go") {
    if (/^glm-/i.test(catalogModelId)) return "Zhipu AI";
    if (/^kimi-/i.test(catalogModelId)) return "Moonshot AI";
    if (/^minimax-/i.test(catalogModelId)) return "MiniMax";
    if (/^qwen/i.test(catalogModelId)) return "Alibaba";
    if (/^deepseek-/i.test(catalogModelId)) return "DeepSeek";
    if (/^mimo-/i.test(catalogModelId)) return "Xiaomi";
  }
  return "Other providers";
}

interface Props {
  value: string;
  onChange: (id: string) => void;
  /**
   * Loaded key state, or undefined when it is UNKNOWN (profile still
   * loading, or the fetch failed and the app degrades). Unknown state fails
   * open — the backend authoritatively rejects models it cannot serve.
   */
  apiKeys?: ApiKeyState;
  /** True while the profile is still loading: render a neutral disabled
   *  trigger instead of flashing "No Models" on every page load. */
  apiKeysLoading?: boolean;
  openRouterModels?: string[];
  vercelModels?: string[];
  openCodeGoModels?: string[];
  compact?: boolean;
  /** Render as a full-width liquid-glass control inside a modal form. */
  modalInput?: boolean;
  onNoModelsClick?: (reason: NoModelsReason) => void;
  reasoningLevel?: ReasoningLevel;
  onReasoningChange?: (level: ReasoningLevel) => void;
}

export type NoModelsReason = "api-keys" | "router-models";

export function noModelsReason(
  apiKeys: ApiKeyState | undefined,
  routerModels: Partial<Record<RouterSlug, string[]>>,
): NoModelsReason {
  const configuredRouterWithoutModels = ROUTER_SLUGS.some(
    (slug) =>
      apiKeys?.[slug]?.configured === true &&
      (routerModels[slug]?.length ?? 0) === 0,
  );
  return configuredRouterWithoutModels ? "router-models" : "api-keys";
}

export function openRouterModelOptions(models: string[]): ModelOption[] {
  return models.map((model) => ({
    id: `openrouter/${model}`,
    label: modelDisplayName(model),
    group: underlyingProviderGroup(model, "openrouter"),
    source: "OpenRouter",
  }));
}

export function vercelModelOptions(models: string[]): ModelOption[] {
  return models.map((model) => ({
    id: `vercel/${model}`,
    label: modelDisplayName(model),
    group: underlyingProviderGroup(model, "vercel"),
    source: "Vercel AI Gateway",
  }));
}

export function openCodeGoModelOptions(models: string[]): ModelOption[] {
  return models.map((model) => ({
    id: `opencode-go/${model}`,
    label: modelDisplayName(model),
    group: underlyingProviderGroup(model, "opencode-go"),
    source: "OpenCode Go",
  }));
}

export function ModelToggle({
  value,
  onChange,
  apiKeys,
  apiKeysLoading = false,
  openRouterModels = [],
  vercelModels = [],
  openCodeGoModels = [],
  compact = false,
  modalInput = false,
  onNoModelsClick,
  reasoningLevel,
  onReasoningChange,
}: Props) {
  const ollamaModels = useOllamaModels();
  const models = [
    ...MODELS,
    ...(apiKeys?.gateway?.models ?? []),
    ...openRouterModelOptions(openRouterModels),
    ...vercelModelOptions(vercelModels),
    ...openCodeGoModelOptions(openCodeGoModels),
    ...ollamaModels.map((model) => ({
      ...model,
      label: modelDisplayName(model.id),
      source: "Local",
    })),
  ];
  const availableModels = models.filter((model) => {
    if (model.group === "Local") return true;
    if (apiKeysLoading) return false; // nothing offered until known
    if (!apiKeys) return true; // unknown after a failed load → fail open
    return isModelAvailable(model.id, apiKeys);
  });
  const selected = availableModels.find((model) => model.id === value);
  const supportedReasoningLevels = reasoningLevelsForModel(value);
  const normalizedReasoningLevel = reasoningLevel
    ? nearestReasoningLevelForModel(value, reasoningLevel)
    : undefined;
  useEffect(() => {
    if (
      reasoningLevel &&
      normalizedReasoningLevel &&
      normalizedReasoningLevel !== reasoningLevel &&
      onReasoningChange
    ) {
      onReasoningChange(normalizedReasoningLevel);
    }
  }, [normalizedReasoningLevel, onReasoningChange, reasoningLevel]);
  const selectedLabel = apiKeysLoading
    ? (models.find((model) => model.id === value)?.label ?? "Select model")
    : (selected?.label ??
      (availableModels.length > 0 ? "Select model" : "No Models"));
  const emptyReason = noModelsReason(apiKeys, {
    openrouter: openRouterModels,
    vercel: vercelModels,
    "opencode-go": openCodeGoModels,
  });
  return (
    <ModelToggleUI
      value={value}
      onChange={onChange}
      models={availableModels}
      selectedLabel={selectedLabel}
      selectedAvailable={selected !== undefined}
      loading={apiKeysLoading}
      compact={compact}
      modalInput={modalInput}
      emptyLabel="No Models"
      onEmptyClick={
        onNoModelsClick ? () => onNoModelsClick(emptyReason) : undefined
      }
      reasoningLevel={value.startsWith("gateway/") ? undefined : normalizedReasoningLevel}
      onReasoningChange={onReasoningChange}
      reasoningLevels={supportedReasoningLevels}
    />
  );
}
