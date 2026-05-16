"use client";

import { useCallback, useEffect, useState } from "react";

// Fallback default used before the ManifestsContext loads the real catalog.
const FALLBACK_DEFAULT_MODEL_ID = "gemini-3-flash-preview";

const STORAGE_KEY = "mike.selectedModel";

function readStored(): string {
    if (typeof window === "undefined") return FALLBACK_DEFAULT_MODEL_ID;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ?? FALLBACK_DEFAULT_MODEL_ID;
}

export function useSelectedModel(): [string, (id: string) => void] {
    const [model, setModelState] = useState<string>(FALLBACK_DEFAULT_MODEL_ID);

    useEffect(() => {
        setModelState(readStored());
    }, []);

    const setModel = useCallback((id: string) => {
        setModelState(id);
        if (typeof window !== "undefined") {
            window.localStorage.setItem(STORAGE_KEY, id);
        }
    }, []);

    return [model, setModel];
}
