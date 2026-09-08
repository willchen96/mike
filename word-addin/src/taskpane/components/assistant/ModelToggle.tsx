import React, { useEffect, useMemo, useState } from "react";
import {
  ModelToggleUI,
  nearestReasoningLevelForModel,
  reasoningLevelsForModel,
  type ReasoningLevel,
} from "@mike/model-toggle-ui";
import { getOllamaModels, type ApiKeyStatus } from "../../api/mikeApi";
import {
  isModelAvailable,
  modelDisplayName,
  openCodeGoModelOptions,
  openRouterModelOptions,
  vercelModelOptions,
  STATIC_MODELS,
  type ModelOption,
} from "../../lib/modelCatalog";

export function ModelToggle({
  value,
  onChange,
  keyStatus,
  keyStatusLoading = false,
  openRouterModels,
  vercelModels,
  openCodeGoModels,
  compact = false,
  onNoModelsClick,
  reasoningLevel,
  onReasoningChange,
}: {
  value: string;
  onChange: (model: string) => void;
  keyStatus: ApiKeyStatus | null;
  /** True while the key-status preflight is in flight: render a neutral
   *  disabled trigger instead of flashing "No Models". */
  keyStatusLoading?: boolean;
  openRouterModels: string[];
  vercelModels: string[];
  openCodeGoModels: string[];
  compact?: boolean;
  onNoModelsClick?: () => void;
  reasoningLevel?: ReasoningLevel;
  onReasoningChange?: (level: ReasoningLevel) => void;
}): React.ReactElement {
  const [ollamaModels, setOllamaModels] = useState<ModelOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void getOllamaModels()
      .then((models) => {
        if (!cancelled) setOllamaModels(models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const models = useMemo(() => {
    const openRouterOptions = openRouterModelOptions(openRouterModels);
    const vercelOptions = vercelModelOptions(vercelModels);
    const openCodeGoOptions = openCodeGoModelOptions(openCodeGoModels);
    const localOptions = ollamaModels.map((model) => ({
      ...model,
      label: modelDisplayName(model.id),
      source: "Local",
    }));
    return [
      ...STATIC_MODELS,
      ...(keyStatus?.gateway?.models ?? []),
      ...openRouterOptions,
      ...vercelOptions,
      ...openCodeGoOptions,
      ...localOptions,
    ].filter(
      (model) =>
        model.group === "Local" || isModelAvailable(model.id, keyStatus),
    );
  }, [
    keyStatus,
    ollamaModels,
    openRouterModels,
    vercelModels,
    openCodeGoModels,
  ]);
  const selected = models.find((model) => model.id === value);
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

  return (
    <ModelToggleUI
      value={value}
      onChange={onChange}
      models={models}
      selectedLabel={
        keyStatusLoading
          ? (selected?.label ?? "Select model")
          : (selected?.label ??
            (models.length > 0 ? "Select model" : "No Models"))
      }
      selectedAvailable={selected !== undefined}
      loading={keyStatusLoading}
      compact={compact}
      emptyLabel="No Models"
      onEmptyClick={onNoModelsClick}
      reasoningLevel={value.startsWith("gateway/") ? undefined : normalizedReasoningLevel}
      onReasoningChange={onReasoningChange}
      reasoningLevels={supportedReasoningLevels}
    />
  );
}
