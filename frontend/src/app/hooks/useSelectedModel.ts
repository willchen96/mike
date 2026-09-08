"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ALLOWED_MODEL_IDS,
    canonicalModelId,
    ROUTER_SLUGS,
    type RouterSlug,
    type ReasoningLevel,
} from "../components/assistant/ModelToggle";
import { isModelAvailable } from "../lib/modelAvailability";
import type { ApiKeyState } from "../lib/mikeApi";

/**
 * The composer's accepted-id surface. Exported so the Word add-in drift guard
 * (frontend/src/wordAddin/catalogParity.test.ts) can compare it against the
 * add-in's hand-mirrored copy instead of restating the rule.
 */
export function isAllowedModelId(id: string): boolean {
    return (
        ALLOWED_MODEL_IDS.has(id) ||
        id.startsWith("ollama/") ||
        id.startsWith("gateway/") ||
        ROUTER_SLUGS.some((slug) => id.startsWith(`${slug}/`))
    );
}

export interface SelectedModelSources {
    selectionKey?: string | null;
    chatModel?: string | null;
    lastSelectedModel?: string | null;
    routerSelections?: {
        openRouterModels: string[];
        vercelModels: string[];
        openCodeGoModels: string[];
    } | null;
    /** Undefined means availability is unknown and must fail open. */
    apiKeys?: ApiKeyState;
}

function usableStoredModel(
    value: string | null | undefined,
    sources: SelectedModelSources,
): string | null {
    if (!value) return null;
    const canonical = canonicalModelId(value);
    if (!isAllowedModelId(canonical)) return null;

    const router = ROUTER_SLUGS.find((slug) =>
        canonical.startsWith(`${slug}/`),
    );
    if (router && sources.routerSelections) {
        const selections: Record<RouterSlug, string[]> = {
            openrouter: sources.routerSelections.openRouterModels,
            vercel: sources.routerSelections.vercelModels,
            "opencode-go": sources.routerSelections.openCodeGoModels,
        };
        if (!selections[router].includes(canonical.slice(router.length + 1))) {
            return null;
        }
    }
    if (sources.apiKeys && !isModelAvailable(canonical, sources.apiKeys)) {
        return null;
    }
    return canonical;
}

/** Resolve chat model → profile last-selected model, without a product default. */
export function useSelectedModel(
    sources: SelectedModelSources = {},
): [string, (id: string) => void] {
    const [model, setModelState] = useState("");
    const manuallySelected = useRef(false);
    const previousSelectionKey = useRef(sources.selectionKey);
    const openRouterModels = sources.routerSelections?.openRouterModels;
    const vercelModels = sources.routerSelections?.vercelModels;
    const openCodeGoModels = sources.routerSelections?.openCodeGoModels;
    const hasRouterSelections = sources.routerSelections != null;
    const selectionSources = useMemo<SelectedModelSources>(
        () => ({
            selectionKey: sources.selectionKey,
            chatModel: sources.chatModel,
            lastSelectedModel: sources.lastSelectedModel,
            routerSelections: hasRouterSelections
                ? {
                      openRouterModels: openRouterModels ?? [],
                      vercelModels: vercelModels ?? [],
                      openCodeGoModels: openCodeGoModels ?? [],
                  }
                : null,
            apiKeys: sources.apiKeys,
        }),
        [
            sources.selectionKey,
            sources.chatModel,
            sources.lastSelectedModel,
            hasRouterSelections,
            openRouterModels,
            vercelModels,
            openCodeGoModels,
            sources.apiKeys,
        ],
    );

    /* eslint-disable react-hooks/set-state-in-effect -- persisted profile/chat settings arrive asynchronously and initialize controlled composer state */
    useEffect(() => {
        if (previousSelectionKey.current !== selectionSources.selectionKey) {
            previousSelectionKey.current = selectionSources.selectionKey;
            manuallySelected.current = false;
        }
        if (manuallySelected.current) return;
        if (
            selectionSources.selectionKey &&
            selectionSources.chatModel === undefined
        ) {
            // Existing chat settings have not loaded yet. Do not flash the
            // profile fallback before the chat's own selection arrives.
            setModelState("");
            return;
        }
        const next =
            usableStoredModel(selectionSources.chatModel, selectionSources) ??
            usableStoredModel(
                selectionSources.lastSelectedModel,
                selectionSources,
            ) ??
            "";
        setModelState(next);
    }, [selectionSources]);
    /* eslint-enable react-hooks/set-state-in-effect */

    const setModel = useCallback((id: string) => {
        const canonical = canonicalModelId(id);
        const next = isAllowedModelId(canonical) ? canonical : "";
        manuallySelected.current = true;
        setModelState(next);
    }, []);

    return [model, setModel];
}

export function useSelectedReasoning(sources: {
    selectionKey?: string | null;
    chatReasoningLevel?: ReasoningLevel | null;
    lastSelectedReasoningLevel?: ReasoningLevel | null;
}): [ReasoningLevel, (level: ReasoningLevel) => void] {
    const [level, setLevelState] = useState<ReasoningLevel>("high");
    const manuallySelected = useRef(false);
    const previousSelectionKey = useRef(sources.selectionKey);

    /* eslint-disable react-hooks/set-state-in-effect -- persisted profile/chat settings arrive asynchronously and initialize controlled composer state */
    useEffect(() => {
        if (previousSelectionKey.current !== sources.selectionKey) {
            previousSelectionKey.current = sources.selectionKey;
            manuallySelected.current = false;
        }
        if (manuallySelected.current) return;
        if (sources.selectionKey && sources.chatReasoningLevel === undefined) {
            return;
        }
        setLevelState(
            sources.chatReasoningLevel ??
                sources.lastSelectedReasoningLevel ??
                "high",
        );
    }, [
        sources.selectionKey,
        sources.chatReasoningLevel,
        sources.lastSelectedReasoningLevel,
    ]);
    /* eslint-enable react-hooks/set-state-in-effect */

    const setLevel = useCallback((next: ReasoningLevel) => {
        manuallySelected.current = true;
        setLevelState(next);
    }, []);

    return [level, setLevel];
}
