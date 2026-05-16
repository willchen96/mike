"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/app/contexts/AuthContext";
import { fetchBuiltinWorkflows, fetchModels } from "@/app/lib/mikeApi";
import type { MikeWorkflow, ModelsCatalog } from "@/app/components/shared/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ManifestsValue =
    | { status: "loading"; workflows: MikeWorkflow[]; models: ModelsCatalog | null }
    | { status: "ready"; workflows: MikeWorkflow[]; models: ModelsCatalog }
    | { status: "error"; workflows: MikeWorkflow[]; models: ModelsCatalog | null; error: string };

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ManifestsContext = createContext<ManifestsValue | undefined>(undefined);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ManifestsProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const [value, setValue] = useState<ManifestsValue>({
        status: "loading",
        workflows: [],
        models: null,
    });

    useEffect(() => {
        if (!user) {
            // Not authenticated yet — reset to loading state so that when the
            // user signs in the fetch fires fresh.
            setValue({ status: "loading", workflows: [], models: null });
            return;
        }

        let cancelled = false;

        Promise.all([fetchBuiltinWorkflows(), fetchModels()])
            .then(([workflowsResponse, models]) => {
                if (cancelled) return;
                setValue({
                    status: "ready",
                    workflows: workflowsResponse.workflows,
                    models,
                });
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                console.error("[manifests] fetch failed", err);
                setValue({
                    status: "error",
                    workflows: [],
                    models: null,
                    error: String(err),
                });
            });

        return () => {
            cancelled = true;
        };
    }, [user]);

    return (
        <ManifestsContext.Provider value={value}>
            {children}
        </ManifestsContext.Provider>
    );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useManifests(): ManifestsValue {
    const ctx = useContext(ManifestsContext);
    if (ctx === undefined) {
        throw new Error("useManifests must be used within a ManifestsProvider");
    }
    return ctx;
}
