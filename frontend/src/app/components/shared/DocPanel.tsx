"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { applyOptimisticResolution } from "../assistant/EditCard";
import { DocView } from "./DocView";
import { DocxView } from "./DocxView";
import {
    displayCitationQuote,
    expandCitationToEntries,
    formatCitationPage,
} from "./types";
import type {
    CitationQuote,
    MikeCitationAnnotation,
    MikeEditAnnotation,
} from "./types";

function isDocxFilename(name: string): boolean {
    const ext = name.split(".").pop()?.toLowerCase();
    return ext === "docx" || ext === "doc";
}

/**
 * Discriminated-union describing what the panel is showing above the viewer.
 *   - "document":  no header card, no label — just the viewer.
 *   - "citation":  "Citation Quote" card with the quoted text and page ref.
 *   - "edit":      "Tracked Change" card with the diff + Accept/Reject.
 */
export type DocPanelMode =
    | { kind: "document" }
    | { kind: "citation"; citation: MikeCitationAnnotation }
    | {
          kind: "edit";
          edit: MikeEditAnnotation;
          /**
           * True while an accept/reject request for this exact edit is in
           * flight. Scoped per-edit (not per-document) so sibling edits on
           * the same doc stay clickable.
           */
          isEditReloading?: boolean;
          onResolveStart?: (args: {
              editId: string;
              documentId: string;
              verb: "accept" | "reject";
          }) => void;
          onResolved?: (args: {
              editId: string;
              documentId: string;
              status: "accepted" | "rejected";
              versionId: string | null;
              downloadUrl: string | null;
          }) => void;
          onError?: (args: {
              editId: string;
              documentId: string;
              versionId: string | null;
              message: string;
          }) => void;
      };

interface Props {
    documentId: string;
    filename: string;
    versionId: string | null;
    versionNumber: number | null;
    mode: DocPanelMode;
    /** Spinner on the Download button while an accept/reject is in flight. */
    isReloading?: boolean;
    warning?: string | null;
    onWarningDismiss?: () => void;
    initialScrollTop?: number | null;
    onScrollChange?: (scrollTop: number) => void;
}

/**
 * Unified side-panel body for the assistant. Renders a single document
 * with optionally a citation quote OR a tracked change highlighted above
 * the viewer. No selector UI — caller picks the one thing to show; if the
 * user wants a different citation/edit, the panel gets a new tab.
 */
export function DocPanel({
    documentId,
    filename,
    versionId,
    versionNumber,
    mode,
    isReloading = false,
    warning,
    onWarningDismiss,
    initialScrollTop,
    onScrollChange,
}: Props) {
    // Pick the viewer from the filename only, not from mode. Switching
    // headers (citation ↔ edit ↔ document) for the same document must
    // not unmount and remount the body — otherwise the user sees a full
    // re-fetch every time they toggle. Tracked-change rendering still
    // only lives in DocxView, which is fine because edits are DOCX-only.
    const useDocxView = isDocxFilename(filename);

    const quotes: CitationQuote[] | undefined = useMemo(() => {
        if (mode.kind !== "citation") return undefined;
        return expandCitationToEntries(mode.citation);
    }, [mode]);

    const highlightEdit = useMemo(() => {
        if (mode.kind !== "edit") return null;
        return {
            key: `${mode.edit.edit_id}`,
            inserted_text: mode.edit.inserted_text,
            deleted_text: mode.edit.deleted_text,
            ins_w_id: mode.edit.ins_w_id ?? null,
            del_w_id: mode.edit.del_w_id ?? null,
        };
    }, [mode]);

    return (
        <div className="flex h-full flex-col px-3 pb-3">
            {mode.kind === "citation" ? (
                <CitationHeader
                    citation={mode.citation}
                    documentId={documentId}
                    versionId={versionId}
                    filename={filename}
                    isReloading={isReloading}
                />
            ) : mode.kind === "edit" ? (
                <TrackedChangeHeader
                    mode={mode}
                    documentId={documentId}
                    versionId={versionId}
                    filename={filename}
                    isReloading={isReloading}
                />
            ) : (
                <div className="flex items-center justify-end gap-2 py-2">
                    <div className="mr-auto flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm text-[#292629]/80">
                            {filename}
                        </span>
                        {versionNumber && versionNumber > 0 && (
                            <span className="shrink-0 inline-flex items-center rounded-md border border-[#C7C7B2] bg-white px-1.5 py-0.5 text-[10px] font-medium text-[#292629]/60">
                                V{versionNumber}
                            </span>
                        )}
                    </div>
                    <DownloadButton
                        documentId={documentId}
                        versionId={versionId}
                        filename={filename}
                        isReloading={isReloading}
                    />
                </div>
            )}

            {useDocxView ? (
                <DocxView
                    documentId={documentId}
                    versionId={versionId ?? undefined}
                    quotes={quotes}
                    highlightEdit={highlightEdit}
                    warning={warning ?? null}
                    onWarningDismiss={onWarningDismiss}
                    initialScrollTop={initialScrollTop ?? null}
                    onScrollChange={onScrollChange}
                />
            ) : (
                <DocView
                    doc={{
                        document_id: documentId,
                        version_id: versionId,
                    }}
                    quotes={quotes}
                />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Header variants
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
    return <p className="text-xs font-medium text-[#292629]/80">{children}</p>;
}

function CitationHeader({
    citation,
    documentId,
    versionId,
    filename,
    isReloading,
}: {
    citation: MikeCitationAnnotation;
    documentId: string;
    versionId: string | null;
    filename: string;
    isReloading: boolean;
}) {
    const displayQuote = displayCitationQuote(citation);
    const pagesLabel = formatCitationPage(citation);
    return (
        <div className="pt-2 pb-3">
            <div className="flex items-center gap-2 mb-2">
                <SectionLabel>Citation</SectionLabel>
                <div className="ml-auto shrink-0">
                    <DownloadButton
                        documentId={documentId}
                        versionId={versionId}
                        filename={filename}
                        isReloading={isReloading}
                    />
                </div>
            </div>
            <div className="w-full rounded-md bg-[#F5F5F5] border border-[#C7C7B2] px-2 py-2">
                <p className="text-sm font-sans text-[#292629]/60">
                    &ldquo;{displayQuote}&rdquo;
                    {pagesLabel && (
                        <span className="ml-1 text-[#292629]/40">
                            ({pagesLabel})
                        </span>
                    )}
                </p>
            </div>
        </div>
    );
}

function TrackedChangeHeader({
    mode,
    documentId,
    versionId,
    filename,
    isReloading,
}: {
    mode: Extract<DocPanelMode, { kind: "edit" }>;
    documentId: string;
    versionId: string | null;
    filename: string;
    isReloading: boolean;
}) {
    const { edit, isEditReloading, onResolveStart, onResolved, onError } = mode;
    return (
        <div className="pt-2 pb-3">
            <div className="flex items-center gap-2 mb-2">
                <SectionLabel>Tracked Change</SectionLabel>
                <div className="ml-auto flex items-center gap-2 shrink-0">
                    <EditResolveButtons
                        edit={edit}
                        isReloading={isEditReloading}
                        onResolveStart={onResolveStart}
                        onResolved={onResolved}
                        onError={onError}
                    />
                    <DownloadButton
                        documentId={documentId}
                        versionId={versionId}
                        filename={filename}
                        isReloading={isReloading}
                    />
                </div>
            </div>
            {edit.reason && (
                <p className="mb-2 text-xs text-[#292629]/50">{edit.reason}</p>
            )}
            <div className="w-full rounded-md bg-[#F5F5F5] border border-[#C7C7B2] px-2 py-2">
                <div className="text-sm leading-relaxed font-sans">
                    {edit.inserted_text && (
                        <span className="text-green-700">
                            {edit.inserted_text}
                        </span>
                    )}
                    {edit.deleted_text && (
                        <span className="text-red-600 line-through">
                            {edit.deleted_text}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Accept / Reject controls
// ---------------------------------------------------------------------------

function EditResolveButtons({
    edit,
    isReloading,
    onResolveStart,
    onResolved,
    onError,
}: {
    edit: MikeEditAnnotation;
    /**
     * True while an accept/reject for any edit on this document is in
     * flight (triggered from here, the inline EditCard, the bulk bar, or
     * elsewhere). Disables both buttons so the user can't double-submit
     * while a resolution is racing to change the status.
     */
    isReloading?: boolean;
    onResolveStart?: (args: {
        editId: string;
        documentId: string;
        verb: "accept" | "reject";
    }) => void;
    onResolved?: (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => void;
    onError?: (args: {
        editId: string;
        documentId: string;
        versionId: string | null;
        message: string;
    }) => void;
}) {
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<"pending" | "accepted" | "rejected">(
        edit.status,
    );
    // Sync with the prop when this edit is resolved elsewhere (bulk
    // accept/reject, inline per-edit card, another open panel for the same
    // edit). Skips while our own request is in flight so we don't flicker.
    useEffect(() => {
        if (busy) return;
        setStatus(edit.status);
    }, [edit.status, edit.edit_id, busy]);
    const resolved = status !== "pending";

    const handle = useCallback(
        async (verb: "accept" | "reject") => {
            if (busy || resolved) return;
            setBusy(true);
            onResolveStart?.({
                editId: edit.edit_id,
                documentId: edit.document_id,
                verb,
            });
            // Optimistically mutate the DOM in the open viewer so the
            // change reflects immediately. Revert if the backend errors.
            let revert: (() => void) | null = null;
            try {
                revert = applyOptimisticResolution(edit, verb);
            } catch (e) {
                console.error(
                    "[DocPanel] optimistic update threw",
                    e,
                );
            }
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const token = session?.access_token;
                const apiBase =
                    process.env.NEXT_PUBLIC_API_BASE_URL ??
                    "http://localhost:3001";
                const resp = await fetch(
                    `${apiBase}/single-documents/${edit.document_id}/edits/${edit.edit_id}/${verb}`,
                    {
                        method: "POST",
                        headers: token
                            ? { Authorization: `Bearer ${token}` }
                            : undefined,
                    },
                );
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = (await resp.json()) as {
                    ok: boolean;
                    status?: "accepted" | "rejected";
                    version_id: string | null;
                    download_url: string | null;
                };
                const nextStatus =
                    data.status ??
                    (verb === "accept" ? "accepted" : "rejected");
                setStatus(nextStatus);
                onResolved?.({
                    editId: edit.edit_id,
                    documentId: edit.document_id,
                    status: nextStatus,
                    versionId: data.version_id,
                    downloadUrl: data.download_url,
                });
            } catch (e) {
                console.error("[DocPanel] resolve failed", e);
                try {
                    revert?.();
                } catch (revertErr) {
                    console.error(
                        "[DocPanel] revert threw",
                        revertErr,
                    );
                }
                onError?.({
                    editId: edit.edit_id,
                    documentId: edit.document_id,
                    versionId: edit.version_id ?? null,
                    message:
                        verb === "accept"
                            ? "Couldn't save accept — please retry."
                            : "Couldn't save reject — please retry.",
                });
            } finally {
                setBusy(false);
            }
        },
        [busy, resolved, edit, onResolveStart, onResolved, onError],
    );

    const inFlight = busy || !!isReloading;
    return (
        <div className="flex items-center gap-2">
            <button
                onClick={() => handle("accept")}
                disabled={inFlight || resolved}
                className="inline-flex items-center gap-1 rounded-lg border border-[#292629] bg-[#292629] px-2 py-1.5 text-xs font-medium text-white hover:bg-[#292629]/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {status === "accepted" ? "Accepted" : "Accept"}
            </button>
            <button
                onClick={() => handle("reject")}
                disabled={inFlight || resolved}
                className="inline-flex items-center gap-1 rounded-lg border border-[#C7C7B2] bg-white px-2 py-1.5 text-xs font-medium text-[#292629]/80 hover:bg-[#F5F5F5] disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {status === "rejected" ? "Rejected" : "Reject"}
            </button>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Download button
// ---------------------------------------------------------------------------

function DownloadButton({
    documentId,
    versionId,
    filename,
    isReloading,
}: {
    documentId: string;
    versionId: string | null;
    filename: string;
    isReloading?: boolean;
}) {
    const [busy, setBusy] = useState(false);

    const handleClick = async () => {
        if (busy || isReloading) return;
        setBusy(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const token = session?.access_token;
            const apiBase =
                process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
            const qs = versionId
                ? `?version_id=${encodeURIComponent(versionId)}`
                : "";
            const resp = await fetch(
                `${apiBase}/single-documents/${documentId}/docx${qs}`,
                {
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                },
            );
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        } finally {
            setBusy(false);
        }
    };

    const spinning = busy || isReloading;
    return (
        <button
            onClick={handleClick}
            disabled={spinning}
            className="inline-flex items-center gap-1 rounded-lg border border-[#C7C7B2] px-2 py-1.5 text-xs font-medium text-[#292629]/60 hover:bg-[#F5F5F5] hover:text-[#292629]/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
            {spinning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
                <Download className="h-3.5 w-3.5" />
            )}
            Download
        </button>
    );
}
