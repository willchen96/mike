"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import type { MikeEditAnnotation } from "../shared/types";

function normalizeText(s: string) {
    return s.replace(/\s+/g, " ").trim();
}

function findMatch(
    container: Element,
    tag: "ins" | "del",
    opts: { w_id?: string | null; text?: string },
): HTMLElement | null {
    if (opts.w_id) {
        // Values are numeric strings from our own backend — CSS.escape
        // makes them hex-encoded which works but is harder to debug.
        const byId = container.querySelector(
            `${tag}[data-w-id="${opts.w_id}"]`,
        ) as HTMLElement | null;
        console.log("[EditCard] findMatch by w_id", {
            tag,
            w_id: opts.w_id,
            found: !!byId,
            totalTagged: container.querySelectorAll(`${tag}[data-w-id]`).length,
            totalAny: container.querySelectorAll(tag).length,
        });
        if (byId) return byId;
    }
    const text = opts.text ?? "";
    const target = normalizeText(text);
    if (!target) return null;
    const candidates = Array.from(
        container.querySelectorAll(tag),
    ) as HTMLElement[];
    const byText =
        candidates.find(
            (el) => normalizeText(el.textContent ?? "") === target,
        ) ??
        candidates.find((el) =>
            normalizeText(el.textContent ?? "").includes(target),
        ) ??
        null;
    console.log("[EditCard] findMatch by text", {
        tag,
        target,
        found: !!byText,
        candidateCount: candidates.length,
    });
    return byText;
}

/**
 * Ephemeral DOM mutation so the tracked change visually resolves the
 * instant the user clicks Accept/Reject, instead of waiting for the
 * backend round-trip + re-render. The real re-render from the new
 * version supersedes this shortly after.
 */
/**
 * Apply the optimistic DOM mutation for an accept/reject click. Returns
 * a revert function that undoes every style + class the mutation added,
 * so if the backend call later fails we can restore the original look.
 */
export function applyOptimisticResolution(
    annotation: MikeEditAnnotation,
    verb: "accept" | "reject",
): () => void {
    const reverts: (() => void)[] = [];
    if (typeof document === "undefined") return () => {};

    const hide = (el: HTMLElement) => {
        el.classList.add("docx-edit-hidden");
        const prev = el.style.getPropertyValue("display");
        const prevPriority = el.style.getPropertyPriority("display");
        el.style.setProperty("display", "none", "important");
        reverts.push(() => {
            el.classList.remove("docx-edit-hidden");
            if (prev) el.style.setProperty("display", prev, prevPriority);
            else el.style.removeProperty("display");
        });
    };
    const keep = (el: HTMLElement) => {
        el.classList.add("docx-edit-kept");
        const snapshot = {
            color: [
                el.style.getPropertyValue("color"),
                el.style.getPropertyPriority("color"),
            ] as const,
            bg: [
                el.style.getPropertyValue("background-color"),
                el.style.getPropertyPriority("background-color"),
            ] as const,
            td: [
                el.style.getPropertyValue("text-decoration"),
                el.style.getPropertyPriority("text-decoration"),
            ] as const,
        };
        el.style.setProperty("color", "inherit", "important");
        el.style.setProperty("background-color", "transparent", "important");
        el.style.setProperty("text-decoration", "none", "important");
        reverts.push(() => {
            el.classList.remove("docx-edit-kept");
            const restore = (
                prop: "color" | "background-color" | "text-decoration",
                [v, p]: readonly [string, string],
            ) => {
                if (v) el.style.setProperty(prop, v, p);
                else el.style.removeProperty(prop);
            };
            restore("color", snapshot.color);
            restore("background-color", snapshot.bg);
            restore("text-decoration", snapshot.td);
        });
    };

    const scrolls = document.querySelectorAll(
        `[data-document-id="${CSS.escape(annotation.document_id)}"]`,
    );
    console.log("[EditCard] optimistic scrolls found:", scrolls.length, {
        document_id: annotation.document_id,
        ins_w_id: annotation.ins_w_id,
        del_w_id: annotation.del_w_id,
        inserted_text: annotation.inserted_text?.slice(0, 40),
        deleted_text: annotation.deleted_text?.slice(0, 40),
    });
    scrolls.forEach((scroll) => {
        const container = scroll.querySelector(".docx-view-container");
        if (!container) return;

        const insEl = findMatch(container, "ins", {
            w_id: annotation.ins_w_id,
            text: annotation.inserted_text,
        });
        const delEl = findMatch(container, "del", {
            w_id: annotation.del_w_id,
            text: annotation.deleted_text,
        });

        if (verb === "accept") {
            if (insEl) keep(insEl);
            if (delEl) hide(delEl);
        } else {
            if (insEl) hide(insEl);
            if (delEl) keep(delEl);
        }
    });

    return () => reverts.forEach((fn) => fn());
}

interface Props {
    annotation: MikeEditAnnotation;
    /**
     * External override for this edit's status. When set, takes
     * precedence over the annotation's DB status and the card's own
     * internal state — used so bulk-resolved edits flip their per-card
     * UI the moment the bulk handler calls onResolved.
     */
    resolvedStatus?: "accepted" | "rejected";
    /**
     * True while an accept/reject request for any edit on this document
     * is in flight (from here, DocPanel, or the bulk bar). When true the
     * Accept/Reject buttons disable so the user can't race resolutions.
     */
    isReloading?: boolean;
    onViewClick?: (ann: MikeEditAnnotation) => void;
    /**
     * Fires immediately when the user clicks Accept or Reject, before the
     * backend round-trip. Parents use this to show an in-progress spinner
     * on download cards / editor panels tied to the same document while
     * the version is being mutated.
     */
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
    /**
     * Fires when the backend accept/reject call fails. The optimistic
     * DOM mutation has already been reverted. Parent should surface a
     * warning (e.g. on the DocxView for this document + version) and
     * clear the per-edit in-flight state keyed on `editId`.
     */
    onError?: (args: {
        editId: string;
        documentId: string;
        versionId: string | null;
        message: string;
    }) => void;
}

/**
 * Renders a single tracked-change proposal as a card in the assistant
 * message with Accept / Reject / View controls.
 */
export function EditCard({
    annotation,
    resolvedStatus,
    isReloading,
    onViewClick,
    onResolveStart,
    onResolved,
    onError,
}: Props) {
    const [busy, setBusy] = useState(false);
    const [localStatus, setLocalStatus] = useState<
        "pending" | "accepted" | "rejected"
    >(annotation.status);
    // External override (from a bulk resolve) takes precedence over the
    // card's own click-driven state.
    const status = resolvedStatus ?? localStatus;
    const setStatus = setLocalStatus;

    const resolved = status !== "pending";
    // True while an accept/reject request for any edit on this card's
    // document is in flight — triggered here, in DocPanel, or in the
    // bulk bar. Disables the buttons so the user can't race resolutions.
    const inFlight = busy || !!isReloading;

    const handle = async (verb: "accept" | "reject") => {
        if (busy || resolved) return;
        setBusy(true);
        onResolveStart?.({
            editId: annotation.edit_id,
            documentId: annotation.document_id,
            verb,
        });
        let revert: (() => void) | null = null;
        try {
            revert = applyOptimisticResolution(annotation, verb);
        } catch (e) {
            console.error("[EditCard] optimistic update threw", e);
        }
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const token = session?.access_token;
            const apiBase =
                process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
            const resp = await fetch(
                `${apiBase}/single-documents/${annotation.document_id}/edits/${annotation.edit_id}/${verb}`,
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
                already_resolved?: boolean;
                status?: "accepted" | "rejected";
                version_id: string | null;
                download_url: string | null;
            };
            const nextStatus =
                data.status ?? (verb === "accept" ? "accepted" : "rejected");
            setStatus(nextStatus);
            onResolved?.({
                editId: annotation.edit_id,
                documentId: annotation.document_id,
                status: nextStatus,
                versionId: data.version_id,
                downloadUrl: data.download_url,
            });
        } catch (e) {
            console.error("EditCard resolve failed", e);
            try {
                revert?.();
            } catch (revertErr) {
                console.error("[EditCard] revert threw", revertErr);
            }
            onError?.({
                editId: annotation.edit_id,
                documentId: annotation.document_id,
                versionId: annotation.version_id ?? null,
                message:
                    verb === "accept"
                        ? "Couldn't save accept — reverted."
                        : "Couldn't save reject — reverted.",
            });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="border border-[#C7C7B2] rounded-lg p-3 bg-[#F5F5F5]">
            {annotation.reason && (
                <p className="text-xs text-[#292629]/50 mb-2">
                    {annotation.reason}
                </p>
            )}
            <div className="text-sm leading-relaxed font-sans bg-white border border-[#C7C7B2] rounded-md px-2 py-2">
                {annotation.inserted_text && (
                    <span className="text-green-700">
                        {annotation.inserted_text}
                    </span>
                )}
                {annotation.deleted_text && (
                    <span className="text-red-600 line-through">
                        {annotation.deleted_text}
                    </span>
                )}
            </div>
            <div className="flex gap-2 mt-3">
                <button
                    onClick={() => handle("accept")}
                    disabled={inFlight || resolved}
                    className="px-2 py-1 text-xs rounded border border-[#292629] bg-[#292629] text-white hover:bg-[#292629]/90 disabled:opacity-50"
                >
                    {status === "accepted" ? "Accepted" : "Accept"}
                </button>
                <button
                    onClick={() => handle("reject")}
                    disabled={inFlight || resolved}
                    className="px-2 py-1 text-xs rounded border border-[#C7C7B2] bg-white text-[#292629]/80 hover:bg-[#F5F5F5] disabled:opacity-50"
                >
                    {status === "rejected" ? "Rejected" : "Reject"}
                </button>
                {onViewClick && (
                    <button
                        onClick={() => onViewClick(annotation)}
                        disabled={resolved}
                        title={
                            resolved
                                ? "This change has been resolved and is no longer in the document."
                                : undefined
                        }
                        className="ml-auto px-2 py-1 text-xs rounded border border-[#C7C7B2] bg-white text-[#292629]/80 hover:bg-[#F5F5F5] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white"
                    >
                        View
                    </button>
                )}
            </div>
        </div>
    );
}
