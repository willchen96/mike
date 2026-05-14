"use client";

import { useRef } from "react";
import { FileText, X } from "lucide-react";
import { DocView } from "@/app/components/shared/DocView";
import { DocxView } from "@/app/components/shared/DocxView";
import type { CitationQuote, MikeDocument } from "@/app/components/shared/types";

export type DocTab = {
    documentId: string;
    filename: string;
    quotes?: CitationQuote[];
    versionId?: string | null;
    pdfConversionStatus?: "pending" | "ok" | "failed" | null;
    onRetryPdf?: () => void | Promise<void>;
    refetchKey?: number;
    warning?: string | null;
    scrollTop?: number;
};

export type EditScrollTarget = {
    key: string;
    documentId: string;
    inserted_text?: string;
    deleted_text?: string;
    ins_w_id?: string | null;
    del_w_id?: string | null;
};

function isDocxTab(filename: string) {
    const ext = filename.split(".").pop()?.toLowerCase();
    return ext === "docx" || ext === "doc";
}

interface Props {
    tabs: DocTab[];
    activeTabId: string | null;
    activeQuotes: CitationQuote[] | null;
    editScrollTarget: EditScrollTarget | null;
    documents: MikeDocument[];
    onSwitchTab: (docId: string) => void;
    onCloseTab: (docId: string) => void;
    onDocxReady: (docId: string) => void;
    onWarningDismiss: (docId: string) => void;
    onScrollChange: (docId: string, scrollTop: number) => void;
}

export function ProjectDocPanel({
    tabs,
    activeTabId,
    activeQuotes,
    editScrollTarget,
    documents,
    onSwitchTab,
    onCloseTab,
    onDocxReady,
    onWarningDismiss,
    onScrollChange,
}: Props) {
    const tabBarRef = useRef<HTMLDivElement | null>(null);
    const tabItemRefs = useRef<Record<string, HTMLDivElement | null>>({});

    const activeTab = tabs.find((t) => t.documentId === activeTabId) ?? null;

    return (
        <div className="flex-1 flex flex-col min-w-0 border-r border-gray-200">
            {/* Tab bar */}
            <div
                ref={tabBarRef}
                className="h-10 flex items-end border-b border-gray-200 shrink-0 overflow-x-auto min-w-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            >
                {tabs.length === 0 ? (
                    <span className="px-4 self-center text-xs text-gray-700">
                        Document Viewer
                    </span>
                ) : (
                    tabs.map((tab) => {
                        const isActive = tab.documentId === activeTabId;
                        const ext = tab.filename.split(".").pop()?.toLowerCase();
                        const iconColor =
                            ext === "pdf"
                                ? "text-red-500"
                                : ext === "doc" || ext === "docx"
                                  ? "text-blue-500"
                                  : "text-gray-400";
                        const versionNumber = documents.find(
                            (d) => d.id === tab.documentId,
                        )?.latest_version_number as number | null | undefined;
                        const showVersionBadge =
                            typeof versionNumber === "number" &&
                            Number.isFinite(versionNumber) &&
                            versionNumber > 1;
                        return (
                            <div
                                key={tab.documentId}
                                ref={(el) => {
                                    tabItemRefs.current[tab.documentId] = el;
                                }}
                                onClick={() => onSwitchTab(tab.documentId)}
                                className={`group flex items-center gap-1.5 px-3 h-full border-r border-gray-200 cursor-pointer shrink-0 max-w-[260px] transition-colors ${
                                    isActive
                                        ? "bg-gray-100"
                                        : "bg-white hover:bg-gray-50"
                                }`}
                            >
                                <FileText
                                    className={`h-3.5 w-3.5 shrink-0 ${iconColor}`}
                                />
                                <span
                                    className={`text-xs truncate ${isActive ? "text-gray-900 font-medium" : "text-gray-500"}`}
                                >
                                    {tab.filename}
                                </span>
                                {showVersionBadge && (
                                    <span
                                        className={`shrink-0 inline-flex items-center rounded border px-1 py-px text-[9px] font-medium ${
                                            isActive
                                                ? "border-gray-200 bg-white text-gray-600"
                                                : "border-gray-200 bg-gray-50 text-gray-500"
                                        }`}
                                    >
                                        V{versionNumber}
                                    </span>
                                )}
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onCloseTab(tab.documentId);
                                    }}
                                    className={`shrink-0 transition-colors ${isActive ? "text-gray-500 hover:text-gray-700" : "text-gray-300 hover:text-gray-600"}`}
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </div>
                        );
                    })
                )}
            </div>
            {/* Document viewer */}
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                {activeTab ? (
                    isDocxTab(activeTab.filename) ? (
                        <DocxView
                            key={activeTab.documentId}
                            documentId={activeTab.documentId}
                            versionId={activeTab.versionId}
                            refetchKey={activeTab.refetchKey}
                            quotes={activeQuotes ?? undefined}
                            highlightEdit={
                                editScrollTarget &&
                                editScrollTarget.documentId ===
                                    activeTab.documentId
                                    ? editScrollTarget
                                    : null
                            }
                            onReady={() => onDocxReady(activeTab.documentId)}
                            warning={activeTab.warning ?? null}
                            onWarningDismiss={() =>
                                onWarningDismiss(activeTab.documentId)
                            }
                            initialScrollTop={activeTab.scrollTop ?? null}
                            onScrollChange={(top) =>
                                onScrollChange(activeTab.documentId, top)
                            }
                            rounded={false}
                            bordered={false}
                        />
                    ) : (
                        <DocView
                            key={activeTab.documentId}
                            doc={{ document_id: activeTab.documentId }}
                            quotes={activeQuotes ?? undefined}
                            pdfStatus={activeTab.pdfConversionStatus ?? null}
                            onRetryPdf={activeTab.onRetryPdf}
                            rounded={false}
                            bordered={false}
                        />
                    )
                ) : (
                    <div className="flex items-center justify-center h-full px-8 bg-gray-100">
                        <div className="text-center space-y-3">
                            <p className="font-serif text-gray-700 text-xl">
                                Click on a document to display here.
                            </p>
                            <p className="font-serif text-base text-gray-500">
                                Pro tip: Drag a document from the Project
                                Explorer to the Assistant to direct it to read
                                or edit.
                            </p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
