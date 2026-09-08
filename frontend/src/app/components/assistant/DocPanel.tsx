"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import { API_BASE } from "@/app/lib/mikeApi";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { PillButton } from "@/app/components/ui/pill-button";
import { PdfView } from "../shared/views/PdfView";
import { DocxView } from "../shared/views/DocxView";
import { SpreadsheetView } from "../shared/views/SpreadsheetView";
import {
    CitationQuotesSection,
    documentQuoteId,
} from "./CitationQuotesSection";
import { EditCard } from "./EditCard";
import { expandDocumentQuoteEntry } from "../shared/types";
import type { Citation, EditAnnotation, PanelDocument } from "../shared/types";
import { quoteVerificationState } from "./message/citationVerification";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { CaseView } from "./CaseView";
import { useResolvedPanelDocument } from "./useResolvedPanelDocument";
import { resolveDocumentViewType } from "@/app/lib/documentViewType";

/**
 * Discriminated-union describing what the panel is showing above the viewer.
 *   - "document":  title row + viewer.
 *   - "citation":  title row + relevant quote + viewer.
 *   - "edit":      title row + tracked change + viewer.
 */
export type DocPanelMode =
    | { kind: "document" }
    | { kind: "citation"; citation: Citation }
    | {
          kind: "edit";
          edit: EditAnnotation;
          changeNumber?: number;
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
    document: PanelDocument;
    mode: DocPanelMode;
    isReloading?: boolean;
    compactActions?: boolean;
    warning?: string | null;
    onWarningDismiss?: () => void;
    initialScrollTop?: number | null;
    onScrollChange?: (scrollTop: number) => void;
}

/** One shared panel shell with a document-type-specific body. */
export function DocPanel({
    document,
    mode,
    isReloading = false,
    compactActions = false,
    warning,
    onWarningDismiss,
    initialScrollTop,
    onScrollChange,
}: Props) {
    const {
        document: resolvedDocument,
        isLoading: isDocumentLoading,
        error: documentError,
        retry: retryDocument,
    } = useResolvedPanelDocument(document);

    const documentId = resolvedDocument.document_id;
    const versionId = resolvedDocument.version_id ?? null;
    const isLegalSource =
        resolvedDocument.type === "case" || documentId.startsWith("mcp:");
    const viewType = resolveDocumentViewType({
        filename: resolvedDocument.title,
        fileType: resolvedDocument.type,
    });
    const firstSelectableQuoteIndex =
        mode.kind === "citation"
            ? resolvedDocument.quotes.findIndex(
                  (quote) => quoteVerificationState(quote) !== "unverified",
              )
            : -1;
    const citationQuoteId =
        firstSelectableQuoteIndex >= 0
            ? documentQuoteId(documentId, firstSelectableQuoteIndex)
            : null;
    const [activeCitationQuoteId, setActiveCitationQuoteId] = useState<
        string | null
    >(citationQuoteId);
    const [quoteFocusKey, setQuoteFocusKey] = useState(0);
    const [editFocusKey, setEditFocusKey] = useState(0);

    const activeQuoteIndex = activeCitationQuoteId
        ? Number(activeCitationQuoteId.split(":quote:").at(-1))
        : Number.NaN;
    const activeDocumentQuote = Number.isFinite(activeQuoteIndex)
        ? resolvedDocument.quotes[activeQuoteIndex]
        : undefined;

    const { activeViewerQuotes, activeHighlightCells } = useMemo(() => {
        if (mode.kind !== "citation" || isLegalSource) {
            return {
                activeViewerQuotes: undefined,
                activeHighlightCells: undefined,
            };
        }
        if (!activeDocumentQuote) {
            return {
                activeViewerQuotes: [],
                activeHighlightCells: [],
            };
        }

        return {
            activeViewerQuotes: expandDocumentQuoteEntry({
                page: activeDocumentQuote.target.page,
                quote: activeDocumentQuote.quote,
            }),
            activeHighlightCells:
                activeDocumentQuote.target.cell ||
                activeDocumentQuote.target.sheet
                    ? [
                          {
                              sheet: activeDocumentQuote.target.sheet,
                              cell: activeDocumentQuote.target.cell,
                          },
                      ]
                    : [],
        };
    }, [activeDocumentQuote, isLegalSource, mode.kind]);

    useEffect(() => {
        setActiveCitationQuoteId(citationQuoteId);
    }, [citationQuoteId]);

    const handleCitationQuoteSelect = useCallback(
        (quoteId: string) => {
            const shouldSelect = activeCitationQuoteId !== quoteId;
            setActiveCitationQuoteId(shouldSelect ? quoteId : null);
            if (shouldSelect) setQuoteFocusKey((current) => current + 1);
        },
        [activeCitationQuoteId],
    );

    const highlightEdit = useMemo(() => {
        if (mode.kind !== "edit") return null;
        return {
            key: `${mode.edit.edit_id}:${editFocusKey}`,
            inserted_text: mode.edit.inserted_text,
            deleted_text: mode.edit.deleted_text,
            ins_w_id: mode.edit.ins_w_id ?? null,
            del_w_id: mode.edit.del_w_id ?? null,
        };
    }, [editFocusKey, mode]);

    return (
        <div className="flex h-full flex-col">
            <DocumentTitleRow
                document={resolvedDocument}
                isReloading={isReloading}
                compactActions={compactActions}
            />

            {mode.kind === "citation" && (
                <CitationQuotesSection
                    document={resolvedDocument}
                    activeQuoteId={activeCitationQuoteId}
                    citationRef={mode.citation.ref}
                    onSelect={(quote) => {
                        if (quote.verificationState !== "unverified") {
                            handleCitationQuoteSelect(quote.id);
                        }
                    }}
                    onIndexChange={(index) => {
                        handleCitationQuoteSelect(
                            documentQuoteId(documentId, index),
                        );
                    }}
                />
            )}

            {mode.kind === "edit" && !isLegalSource && (
                <div className="px-2 pb-2">
                    <EditCard
                        annotation={mode.edit}
                        changeNumber={mode.changeNumber}
                        isReloading={mode.isEditReloading}
                        onResolveStart={mode.onResolveStart}
                        onResolved={mode.onResolved}
                        onError={mode.onError}
                        onViewClick={() =>
                            setEditFocusKey((current) => current + 1)
                        }
                    />
                </div>
            )}

            <div className="flex flex-1 min-h-0 flex-col">
                {isLegalSource ? (
                    <CaseView
                        document={resolvedDocument}
                        activeQuote={activeDocumentQuote}
                        quoteFocusKey={quoteFocusKey}
                        isLoading={isDocumentLoading}
                        error={documentError}
                        onRetry={retryDocument}
                        onClearQuote={() => setActiveCitationQuoteId(null)}
                    />
                ) : viewType === "docx" ? (
                    <DocxView
                        documentId={documentId}
                        versionId={versionId ?? undefined}
                        rounded={false}
                        quotes={activeViewerQuotes}
                        quoteFocusKey={quoteFocusKey}
                        highlightEdit={highlightEdit}
                        warning={warning ?? null}
                        onWarningDismiss={onWarningDismiss}
                        initialScrollTop={initialScrollTop ?? null}
                        onScrollChange={onScrollChange}
                    />
                ) : viewType === "spreadsheet" ? (
                    <SpreadsheetView
                        documentId={documentId}
                        versionId={versionId}
                        rounded={false}
                        highlightCells={activeHighlightCells}
                    />
                ) : (
                    <PdfView
                        doc={{
                            document_id: documentId,
                            version_id: versionId,
                        }}
                        rounded={false}
                        quotes={activeViewerQuotes}
                        quoteFocusKey={quoteFocusKey}
                    />
                )}
            </div>
        </div>
    );
}

type ExternalSourceLink = {
    href: string;
    label: string;
    title: string;
};

export function DocumentTitleRow({
    document,
    isReloading,
    compactActions,
}: {
    document: PanelDocument;
    isReloading: boolean;
    compactActions: boolean;
}) {
    const isFile =
        document.type === "docx" ||
        document.type === "pdf" ||
        document.type === "spreadsheet";
    const versionNumber = document.version_number;

    return (
        <div className="px-3 py-2">
            <div className="flex items-start gap-3">
                <div className="flex min-w-0 flex-1 items-start gap-2">
                    <span className="mt-0.5 shrink-0">
                        {document.type === "case" ||
                        document.type === "legislation" ? (
                            <Image
                                src={
                                    document.type === "case"
                                        ? "/icons/legal-sources/case-law.svg"
                                        : "/icons/legal-sources/legislation.svg"
                                }
                                alt=""
                                aria-hidden="true"
                                width={16}
                                height={16}
                                className="h-4 w-4 shrink-0 object-contain"
                            />
                        ) : (
                            <FileTypeIcon
                                fileType={document.title}
                                className="h-4 w-4"
                            />
                        )}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                        <h2
                            className="min-w-0 break-words text-sm font-medium text-gray-800"
                            title={document.title}
                        >
                            {document.title}
                        </h2>
                        {versionNumber && versionNumber > 0 ? (
                            <span className="inline-flex shrink-0 items-center rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                                V{versionNumber}
                            </span>
                        ) : null}
                    </div>
                </div>
                <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">
                    {isFile && (
                        <DownloadButton
                            documentId={document.document_id}
                            versionId={document.version_id ?? null}
                            filename={document.title}
                            isReloading={isReloading}
                            compact={compactActions}
                        />
                    )}
                    {(document.actions ?? []).map((action, index) =>
                        action.type === "download" ? (
                            <UrlDownloadButton
                                key={`${action.type}:${action.url}:${index}`}
                                href={action.url}
                                compact={compactActions}
                            />
                        ) : (
                            <ExternalSourceLinkButton
                                key={`${action.type}:${action.url}:${index}`}
                                link={{
                                    href: action.url,
                                    label: action.label,
                                    title: action.title ?? action.label,
                                }}
                                compact={compactActions}
                            />
                        ),
                    )}
                </div>
            </div>
            {document.metadata.length > 0 && (
                <div className="mt-1 flex w-full flex-wrap items-center gap-x-3 gap-y-1 font-serif text-sm text-gray-600">
                    {document.metadata.map((item, index) => (
                        <span key={`${item.label}:${item.value}:${index}`}>
                            {item.label}: {formatMetadataValue(item)}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Source actions
// ---------------------------------------------------------------------------

function formatMetadataValue(item: PanelDocument["metadata"][number]): string {
    if (item.format !== "date") return item.value;
    const value = item.value;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? new Date(`${value}T00:00:00Z`)
        : new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
    }).format(date);
}

function UrlDownloadButton({
    href,
    compact,
}: {
    href: string;
    compact: boolean;
}) {
    return (
        <PillButton
            asChild
            tone="white"
            size={compact ? "icon-xs" : "sm"}
        >
            <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                download
                aria-label="Download"
                title="Download"
            >
                <Download className="h-3.5 w-3.5" />
                <span className={compact ? "sr-only" : undefined}>
                    Download
                </span>
            </a>
        </PillButton>
    );
}

function ExternalSourceLinkButton({
    link,
    compact,
}: {
    link: ExternalSourceLink;
    compact: boolean;
}) {
    return (
        <PillButton
            asChild
            tone="white"
            size={compact ? "icon-xs" : "sm"}
        >
            <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={link.title}
                title={link.title}
            >
                <ExternalLink className="h-3.5 w-3.5" />
                <span className={compact ? "sr-only" : undefined}>
                    {link.label}
                </span>
            </a>
        </PillButton>
    );
}

function DownloadButton({
    documentId,
    versionId,
    filename,
    isReloading,
    compact,
}: {
    documentId: string;
    versionId: string | null;
    filename: string;
    isReloading?: boolean;
    compact: boolean;
}) {
    const [busy, setBusy] = useState(false);

    const handleClick = async () => {
        if (busy || isReloading) return;
        setBusy(true);
        try {
            const qs = versionId
                ? `?version_id=${encodeURIComponent(versionId)}`
                : "";
            const resp = await authenticatedFetch(
                `${API_BASE}/single-documents/${documentId}/docx${qs}`,
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
        <PillButton
            tone="white"
            size={compact ? "icon-xs" : "sm"}
            onClick={handleClick}
            disabled={spinning}
        >
            {spinning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
                <Download className="h-3.5 w-3.5" />
            )}
            <span className={compact ? "sr-only" : undefined}>Download</span>
        </PillButton>
    );
}
