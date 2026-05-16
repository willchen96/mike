"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/app/lib/supabase";

export interface FetchDocxResult {
    bytes: ArrayBuffer | null;
    downloadUrl: string | null;
    loading: boolean;
    error: string | null;
}

// Module-level cache keyed by `${documentId}:${versionId}:${refetchKey}`.
// The same cache is shared across every hook instance so tab switches
// (which remount new DocxView subtrees or re-run the effect because of an
// unstable prop upstream) don't cause a refetch as long as the tuple is
// unchanged. Promises are cached too, so concurrent mounts for the same
// key share a single in-flight request.
const bytesCache = new Map<string, ArrayBuffer>();
const inFlight = new Map<string, Promise<ArrayBuffer>>();

function cacheKey(
    documentId: string,
    versionId?: string | null,
    refetchKey?: number,
): string {
    return `${documentId}:${versionId ?? ""}:${refetchKey ?? ""}`;
}

/**
 * Fetch the raw .docx bytes for a document, optionally targeting a specific
 * tracked-changes version. Results are cached so the DocxView can re-render
 * cheaply when switching between versions, and tab switches don't refetch.
 */
export function useFetchDocxBytes(
    documentId: string | null | undefined,
    versionId?: string | null,
    refetchKey?: number,
): FetchDocxResult {
    const initialKey = documentId
        ? cacheKey(documentId, versionId, refetchKey)
        : null;
    const [bytes, setBytes] = useState<ArrayBuffer | null>(
        initialKey ? (bytesCache.get(initialKey) ?? null) : null,
    );
    const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!documentId) {
            setBytes(null);
            setDownloadUrl(null);
            return;
        }

        const key = cacheKey(documentId, versionId, refetchKey);
        const apiBase =
            process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
        const qs = versionId
            ? `?version_id=${encodeURIComponent(versionId)}`
            : "";
        const url = `${apiBase}/single-documents/${documentId}/docx${qs}`;

        // Cache hit: reuse bytes synchronously, no network, no spinner.
        const cached = bytesCache.get(key);
        if (cached) {
            setBytes(cached);
            setDownloadUrl(url);
            setLoading(false);
            setError(null);
            return;
        }

        let cancelled = false;
        setLoading(true);
        setError(null);

        const pending =
            inFlight.get(key) ??
            (async () => {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const token = session?.access_token;
                // Stream bytes through the backend (avoids CORS on R2
                // signed URLs).
                const bin = await fetch(url, {
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                });
                if (!bin.ok) throw new Error(`HTTP ${bin.status}`);
                const buf = await bin.arrayBuffer();
                bytesCache.set(key, buf);
                return buf;
            })();
        if (!inFlight.has(key)) inFlight.set(key, pending);

        pending
            .then((buf) => {
                if (cancelled) return;
                setBytes(buf);
                setDownloadUrl(url);
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setError(e instanceof Error ? e.message : String(e));
            })
            .finally(() => {
                inFlight.delete(key);
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [documentId, versionId, refetchKey]);

    return { bytes, downloadUrl, loading, error };
}

/**
 * Evict cache entries for a given document (e.g. after accept/reject
 * writes new bytes at the same storage path, or the user uploads a new
 * version). Pass a versionId to scope eviction; omit to clear every
 * cached version for that document.
 */
export function invalidateDocxBytes(
    documentId: string,
    versionId?: string | null,
): void {
    if (versionId !== undefined) {
        for (const key of Array.from(bytesCache.keys())) {
            if (key.startsWith(`${documentId}:${versionId ?? ""}:`)) {
                bytesCache.delete(key);
            }
        }
        return;
    }
    for (const key of Array.from(bytesCache.keys())) {
        if (key.startsWith(`${documentId}:`)) bytesCache.delete(key);
    }
}
