"use client";

import { useEffect, useState } from "react";
import { authSession } from "@/lib/auth-session";

export interface DocumentVersionRow {
    id: string;
    version_number: number | null;
    source:
        | "upload"
        | "assistant_edit"
        | "user_accept"
        | "user_reject"
        | "generated";
    created_at: string;
}

export interface DocumentVersionsResult {
    versions: DocumentVersionRow[];
    currentVersionId: string | null;
    loading: boolean;
    error: string | null;
    /** Refetch externally; used after accept/reject or new assistant edits. */
    refresh: () => void;
}

/**
 * Fetch the list of tracked versions for a document, with the numeric
 * version_number we use in UI labels ("V1", "V2", …).
 */
export function useDocumentVersions(
    documentId: string | null | undefined,
    refreshKey?: number,
): DocumentVersionsResult {
    const [versions, setVersions] = useState<DocumentVersionRow[]>([]);
    const [currentVersionId, setCurrentVersionId] = useState<string | null>(
        null,
    );
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [tick, setTick] = useState(0);

    useEffect(() => {
        if (!documentId) {
            setVersions([]);
            setCurrentVersionId(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);

        (async () => {
            try {
                const {
                    data: { session },
                } = await authSession.auth.getSession();
                const token = session?.access_token;
                const apiBase =
                    process.env.NEXT_PUBLIC_API_BASE_URL ??
                    "http://localhost:3001";
                const resp = await fetch(
                    `${apiBase}/single-documents/${documentId}/versions`,
                    {
                        credentials: "include",
                        headers: token
                            ? { Authorization: `Bearer ${token}` }
                            : {},
                    },
                );
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = (await resp.json()) as {
                    versions: DocumentVersionRow[];
                    current_version_id: string | null;
                };
                if (cancelled) return;
                setVersions(data.versions ?? []);
                setCurrentVersionId(data.current_version_id ?? null);
            } catch (e) {
                if (!cancelled)
                    setError(e instanceof Error ? e.message : String(e));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [documentId, refreshKey, tick]);

    return {
        versions,
        currentVersionId,
        loading,
        error,
        refresh: () => setTick((t) => t + 1),
    };
}
