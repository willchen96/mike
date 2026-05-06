"use client";

import { useCallback, useRef, useState } from "react";
import { X } from "lucide-react";
import { DocPanel, type DocPanelMode } from "../shared/DocPanel";
import type {
    MikeCitationAnnotation,
    MikeEditAnnotation,
} from "../shared/types";

// ---------------------------------------------------------------------------
// Tab data
// ---------------------------------------------------------------------------
//
// Each tab represents ONE of:
//   - a document view (no specific annotation),
//   - a single citation quote,
//   - a single tracked change.
// There is no selector UI inside the panel — the user picks what to view
// by clicking a different tab (or opening a new one from a citation pill,
// an EditCard's View button, or the download card).

type CommonTab = {
    id: string;
    documentId: string;
    filename: string;
    versionId: string | null;
    versionNumber: number | null;
    warning?: string | null;
    initialScrollTop?: number | null;
};

export type DocumentTab = CommonTab & { kind: "document" };

export type CitationTab = CommonTab & {
    kind: "citation";
    citation: MikeCitationAnnotation;
};

export type EditTab = CommonTab & {
    kind: "edit";
    edit: MikeEditAnnotation;
};

export type AssistantSidePanelTab = DocumentTab | CitationTab | EditTab;

interface Props {
    tabs: AssistantSidePanelTab[];
    activeTabId: string | null;
    onActivateTab: (id: string) => void;
    onCloseTab: (id: string) => void;
    onCloseAll: () => void;
    /**
     * Parent-driven reloading flag per document. Download buttons in
     * DocPanel show a spinner iff this returns true for the tab's
     * documentId. Used to signal "accept/reject in flight".
     */
    isEditorReloading?: (documentId: string) => boolean;
    /**
     * True while an accept/reject for this exact edit is in flight.
     * Disables the panel's Accept/Reject buttons for only the edit
     * currently being resolved — sibling edits stay clickable.
     */
    isEditReloading?: (editId: string) => boolean;
    onEditResolveStart?: (args: {
        editId: string;
        documentId: string;
        verb: "accept" | "reject";
    }) => void;
    onEditResolved?: (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => void;
    onEditError?: (args: {
        editId: string;
        documentId: string;
        versionId: string | null;
        message: string;
    }) => void;
    onWarningDismiss?: (tabId: string) => void;
    onScrollChange?: (tabId: string, scrollTop: number) => void;
}

const MIN_WIDTH = 300;
const MAX_WIDTH_OFFSET = 56; // sidebar width

export function AssistantSidePanel({
    tabs,
    activeTabId,
    onActivateTab,
    onCloseTab,
    onCloseAll,
    isEditorReloading,
    isEditReloading,
    onEditResolveStart,
    onEditResolved,
    onEditError,
    onWarningDismiss,
    onScrollChange,
}: Props) {
    const panelRef = useRef<HTMLDivElement>(null);
    const [panelWidth, setPanelWidth] = useState(() =>
        typeof window !== "undefined"
            ? Math.round((window.innerWidth - MAX_WIDTH_OFFSET) / 2)
            : 600,
    );

    const dragStartX = useRef<number>(0);
    const dragStartWidth = useRef<number>(0);

    const onMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            dragStartX.current = e.clientX;
            dragStartWidth.current =
                panelRef.current?.offsetWidth ?? panelWidth;

            const onMouseMove = (ev: MouseEvent) => {
                const delta = dragStartX.current - ev.clientX;
                const maxWidth = window.innerWidth - MAX_WIDTH_OFFSET - 200;
                setPanelWidth(
                    Math.min(
                        maxWidth,
                        Math.max(MIN_WIDTH, dragStartWidth.current + delta),
                    ),
                );
            };
            const onMouseUp = () => {
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
            };

            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
        },
        [panelWidth],
    );

    const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;
    if (!active) return null;

    return (
        <div
            ref={panelRef}
            className="flex h-full shrink-0 flex-col bg-white relative border-l border-[#C7C7B2] shadow-[-4px_0_12px_rgba(0,0,0,0.02)]"
            style={{ width: panelWidth }}
        >
            {/* Drag handle */}
            <div
                onMouseDown={onMouseDown}
                className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-[#898344] transition-colors z-10"
                style={{ marginLeft: -2 }}
            />

            {/* Tab strip (Chrome-style) */}
            <div className="flex items-end gap-1 pr-2 pt-2 bg-[#F5F5F5]">
                <div className="flex-1 flex items-end gap-1 overflow-x-auto pl-2 pr-2">
                    {tabs.map((tab) => {
                        const isActive = tab.id === active.id;
                        const showVersionBadge =
                            typeof tab.versionNumber === "number" &&
                            Number.isFinite(tab.versionNumber) &&
                            tab.versionNumber > 1;
                        return (
                            <div
                                key={tab.id}
                                onClick={() => onActivateTab(tab.id)}
                                className={`group relative flex items-center gap-1.5 pl-3 pr-1.5 h-8 min-w-0 max-w-[220px] rounded-t-lg cursor-pointer select-none transition-colors ${
                                    isActive
                                        ? "bg-white text-[#292629]/90 before:content-[''] before:absolute before:bottom-0 before:-left-2 before:w-2 before:h-2 before:bg-[radial-gradient(circle_at_top_left,transparent_8px,white_9px)] after:content-[''] after:absolute after:bottom-0 after:-right-2 after:w-2 after:h-2 after:bg-[radial-gradient(circle_at_top_right,transparent_8px,white_9px)]"
                                        : "bg-[#C7C7B2]/40/70 text-[#292629]/60 hover:bg-[#C7C7B2]/40"
                                }`}
                            >
                                <span
                                    className={`min-w-0 flex-1 truncate text-xs ${isActive ? "font-medium" : "font-normal"}`}
                                    title={tab.filename}
                                >
                                    {tab.filename}
                                </span>
                                {showVersionBadge && (
                                    <span
                                        className={`shrink-0 inline-flex items-center rounded border px-1 py-px text-[9px] font-medium ${
                                            isActive
                                                ? "border-[#C7C7B2] bg-white text-[#292629]/60"
                                                : "border-[#C7C7B2] bg-white/70 text-[#292629]/50"
                                        }`}
                                    >
                                        V{tab.versionNumber}
                                    </span>
                                )}
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onCloseTab(tab.id);
                                    }}
                                    className="shrink-0 rounded-full p-0.5 text-[#292629]/40 hover:bg-[#C7C7B2] hover:text-[#292629]/80"
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </div>
                        );
                    })}
                </div>
                <button
                    onClick={onCloseAll}
                    className="shrink-0 mb-1 ml-1 rounded-lg p-1.5 text-[#292629]/40 hover:bg-[#C7C7B2]/40 hover:text-[#292629]/80"
                    title="Close panel"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>

            {/* Tab bodies — all mounted, inactive ones hidden. Each tab
                preserves its state (scroll, docx-preview render, etc.)
                when inactive. */}
            <div className="flex-1 min-h-0 relative">
                {tabs.map((tab) => {
                    const isActive = tab.id === active.id;
                    const mode: DocPanelMode =
                        tab.kind === "citation"
                            ? {
                                  kind: "citation",
                                  citation: tab.citation,
                              }
                            : tab.kind === "edit"
                              ? {
                                    kind: "edit",
                                    edit: tab.edit,
                                    isEditReloading:
                                        isEditReloading?.(tab.edit.edit_id) ??
                                        false,
                                    onResolveStart: onEditResolveStart,
                                    onResolved: onEditResolved,
                                    onError: onEditError,
                                }
                              : { kind: "document" };
                    return (
                        <div
                            key={tab.id}
                            className={`absolute inset-0 flex flex-col ${isActive ? "" : "invisible pointer-events-none"}`}
                            aria-hidden={!isActive}
                        >
                            <DocPanel
                                documentId={tab.documentId}
                                filename={tab.filename}
                                versionId={tab.versionId}
                                versionNumber={tab.versionNumber}
                                mode={mode}
                                isReloading={
                                    isEditorReloading?.(tab.documentId) ?? false
                                }
                                warning={tab.warning ?? null}
                                onWarningDismiss={() =>
                                    onWarningDismiss?.(tab.id)
                                }
                                initialScrollTop={tab.initialScrollTop ?? null}
                                onScrollChange={(scrollTop) =>
                                    onScrollChange?.(tab.id, scrollTop)
                                }
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
