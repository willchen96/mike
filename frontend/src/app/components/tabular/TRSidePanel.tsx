"use client";

import { useEffect, useRef, useState } from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Loader2,
    RefreshCw,
    X,
} from "lucide-react";
import type { ColumnConfig, MikeDocument, TabularCell } from "../shared/types";
import { preprocessCitations, type ParsedCitation } from "./citation-utils";
import { getPillClass } from "./pillUtils";
import { DocView } from "../shared/DocView";
import { DocxView } from "../shared/DocxView";

function isDocxDocument(d: {
    file_type?: string | null;
    filename?: string;
}): boolean {
    const ft = (d.file_type ?? "").toLowerCase();
    if (ft === "docx" || ft === "doc") return true;
    const ext = d.filename?.split(".").pop()?.toLowerCase();
    return ext === "docx" || ext === "doc";
}

interface Props {
    cell: TabularCell;
    document: MikeDocument;
    column: ColumnConfig;
    columns: ColumnConfig[];
    onClose: () => void;
    onNavigate: (columnIndex: number) => void;
    onRegenerate?: () => Promise<void>;
    /** If true, open the document panel immediately */
    displayDocument?: boolean;
    /** Quote to highlight when opening document panel */
    citationQuote?: string;
    /** Page to scroll to when opening document panel */
    citationPage?: number;
}

const FLAG_BADGE: Record<string, string> = {
    green: "bg-emerald-600 backdrop-blur-md border border-emerald-300/20 text-white shadow-md",
    grey: "bg-slate-500 backdrop-blur-md border border-slate-300/20 text-white shadow-md",
    yellow: "bg-amber-500 backdrop-blur-md border border-amber-300/20 text-white shadow-md",
    red: "bg-red-600 backdrop-blur-md border border-red-300/20 text-white shadow-md",
};

// ---------------------------------------------------------------------------
// TRSidePanel
// ---------------------------------------------------------------------------

export function TRSidePanel({
    cell,
    document: doc,
    column,
    columns,
    onClose,
    onNavigate,
    onRegenerate,
    displayDocument = false,
    citationQuote,
    citationPage,
}: Props) {
    const sortedColumns = [...columns].sort((a, b) => a.index - b.index);
    const currentPos = sortedColumns.findIndex((c) => c.index === column.index);
    const prevColumn = currentPos > 0 ? sortedColumns[currentPos - 1] : null;
    const nextColumn =
        currentPos < sortedColumns.length - 1
            ? sortedColumns[currentPos + 1]
            : null;
    const [regenerating, setRegenerating] = useState(false);
    const [quoteExpanded, setQuoteExpanded] = useState(false);
    const [isTruncated, setIsTruncated] = useState(false);
    const quoteParagraphRef = useRef<HTMLParagraphElement>(null);

    // Internal state — initialised from props, also toggled by badge clicks inside the panel
    const [docCitation, setDocCitation] = useState<
        { quote: string; page: number } | undefined
    >(
        displayDocument && citationQuote
            ? { quote: citationQuote, page: citationPage ?? 1 }
            : undefined,
    );

    // Re-sync when the panel opens for a different cell or citation
    useEffect(() => {
        setDocCitation(
            displayDocument && citationQuote
                ? { quote: citationQuote, page: citationPage ?? 1 }
                : undefined,
        );
        setQuoteExpanded(false);
    }, [cell.id, displayDocument, citationQuote, citationPage]);

    useEffect(() => {
        const el = quoteParagraphRef.current;
        if (!el || quoteExpanded) return;
        setIsTruncated(el.scrollWidth > el.clientWidth);
    }, [docCitation?.quote, quoteExpanded]);

    const { processed: summaryText, citations: summaryCitations } =
        preprocessCitations(cell.content?.summary ?? "");
    const { processed: reasoningText, citations: reasoningCitations } =
        preprocessCitations(cell.content?.reasoning ?? "");

    useEffect(() => {
        console.log("[TRSidePanel] summary:", cell.content?.summary ?? "");
    }, [cell.id, cell.content?.summary]);

    return (
        <div
            className="fixed right-0 top-0 bottom-0 z-100 flex flex-row shadow-md border-l border-gray-200"
            style={{
                background: "rgba(255,255,255,0.08)",
                backdropFilter: "blur(10px) saturate(50%)",
                WebkitBackdropFilter: "blur(10px) saturate(50%)",
            }}
        >
            {/* Document panel — left, 600px */}
            {docCitation !== undefined && (
                <div className="relative flex w-[600px] shrink-0 flex-col border-r border-white/30 px-3">
                    {/* Doc header */}
                    <div className="flex items-center gap-2 pt-3 shrink-0 border-b border-white/30">
                        <p
                            className="flex-1 truncate text-sm font-semibold font-sans text-slate-700 font-serif"
                            title={doc.filename}
                        >
                            {doc.filename}
                        </p>
                        <button
                            onClick={() => setDocCitation(undefined)}
                            className="shrink-0 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/40 hover:text-slate-600"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                    {/* Quote row */}
                    {docCitation.quote && (
                        <div className="py-2 shrink-0">
                            <div className="w-full rounded-md bg-gray-50 border border-gray-200 px-2 py-2">
                                <button
                                    onClick={() =>
                                        isTruncated || quoteExpanded
                                            ? setQuoteExpanded((v) => !v)
                                            : undefined
                                    }
                                    className={`flex w-full items-start gap-1 text-left ${!(isTruncated || quoteExpanded) ? "cursor-default" : ""}`}
                                >
                                    <p
                                        ref={quoteParagraphRef}
                                        className={`flex-1 text-sm text-gray-600 ${quoteExpanded ? "" : "truncate"}`}
                                    >
                                        "{docCitation.quote}"
                                    </p>
                                    {(isTruncated || quoteExpanded) && (
                                        <ChevronDown
                                            className={`mt-0.5 h-3 w-3 shrink-0 text-gray-500 transition-transform ${quoteExpanded ? "rotate-180" : ""}`}
                                        />
                                    )}
                                </button>
                            </div>
                        </div>
                    )}
                    {isDocxDocument(doc) && !doc.pdf_storage_path ? (
                        <DocxView
                            documentId={doc.id}
                            quotes={[
                                {
                                    page: docCitation.page,
                                    quote: docCitation.quote,
                                },
                            ]}
                        />
                    ) : (
                        <DocView
                            doc={{ document_id: doc.id }}
                            pdfStatus={doc.pdf_conversion_status}
                            quote={docCitation.quote}
                            fallbackPage={docCitation.page}
                        />
                    )}
                </div>
            )}

            {/* Info column — right, 300px fixed */}
            <div className="flex w-[300px] shrink-0 flex-col overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-end gap-3 px-5 pt-3 pb-1 shrink-0 border-b border-white/30">
                    <div className="flex items-center gap-1 mr-auto">
                        <button
                            onClick={() =>
                                prevColumn && onNavigate(prevColumn.index)
                            }
                            disabled={!prevColumn}
                            title={prevColumn ? prevColumn.name : undefined}
                            className="rounded-lg p-0.5 text-slate-600 transition-colors hover:bg-slate-200 hover:text-slate-900 disabled:opacity-30 disabled:cursor-default"
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </button>
                        <span className="text-xs text-slate-600 font-sans tabular-nums">
                            {currentPos + 1} / {sortedColumns.length}
                        </span>
                        <button
                            onClick={() =>
                                nextColumn && onNavigate(nextColumn.index)
                            }
                            disabled={!nextColumn}
                            title={nextColumn ? nextColumn.name : undefined}
                            className="rounded-lg p-0.5 text-slate-600 transition-colors hover:bg-slate-200 hover:text-slate-900 disabled:opacity-30 disabled:cursor-default"
                        >
                            <ChevronRight className="h-4 w-4" />
                        </button>
                    </div>
                    {onRegenerate && (
                        <button
                            onClick={async () => {
                                setRegenerating(true);
                                try {
                                    await onRegenerate();
                                } finally {
                                    setRegenerating(false);
                                }
                            }}
                            disabled={regenerating}
                            title="Regenerate"
                            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
                        >
                            {regenerating ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <RefreshCw className="h-4 w-4" />
                            )}
                        </button>
                    )}
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Analysis panel */}
                <div className="flex-1 overflow-y-auto">
                    <div className="pb-2 px-5">
                        {/* Column name */}
                        <div className="mb-1">
                            <span className="text-lg font-semibold text-slate-900">
                                {column.name}
                            </span>
                        </div>
                        {/* Document name */}
                        <p className="text-xs mb-4">{doc.filename}</p>

                        {/* Flag section */}
                        {cell.content?.flag && (
                            <div className="mb-5">
                                <h4 className="mb-2 text-sm font-semibold tracking-wider font-sans">
                                    Flag
                                </h4>
                                <span
                                    className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${FLAG_BADGE[cell.content.flag] ?? FLAG_BADGE.grey}`}
                                >
                                    {cell.content.flag.charAt(0).toUpperCase() +
                                        cell.content.flag.slice(1)}
                                </span>
                            </div>
                        )}

                        {/* Results */}
                        <div className="mb-6">
                            <h4 className="mb-2 text-sm font-semibold tracking-wider font-sans">
                                Results
                            </h4>
                            <div className="text-xs leading-relaxed text-slate-600">
                                <MarkdownContent
                                    citations={summaryCitations}
                                    onCitationClick={setDocCitation}
                                    column={column}
                                >
                                    {summaryText || "—"}
                                </MarkdownContent>
                            </div>
                        </div>

                        {/* Reasoning */}
                        {cell.content?.reasoning && (
                            <div>
                                <h4 className="mb-2 text-sm font-semibold tracking-wider font-sans">
                                    Reasoning
                                </h4>
                                <div className="text-xs leading-relaxed text-slate-600">
                                    <MarkdownContent
                                        citations={reasoningCitations}
                                        onCitationClick={setDocCitation}
                                        citationOffset={summaryCitations.length}
                                        column={column}
                                        inline
                                    >
                                        {reasoningText}
                                    </MarkdownContent>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function CitationBadge({
    index,
    citation,
    onClick,
}: {
    index: number;
    citation: ParsedCitation;
    onClick: (c: { quote: string; page: number }) => void;
}) {
    return (
        <button
            type="button"
            data-page={citation.page}
            data-quote={citation.quote}
            title={`Page ${citation.page}: "${citation.quote}"`}
            onClick={() =>
                onClick({ quote: citation.quote, page: citation.page })
            }
            className="inline-flex items-center justify-center rounded-full bg-gray-200 w-3.5 h-3.5 text-[9px] font-medium text-gray-700 align-super cursor-pointer hover:bg-gray-300 transition-colors"
        >
            {index + 1}
        </button>
    );
}

function MarkdownContent({
    children,
    citations,
    onCitationClick,
    citationOffset = 0,
    column,
    inline,
}: {
    children: string;
    citations: ParsedCitation[];
    onCitationClick: (c: { quote: string; page: number }) => void;
    inline?: boolean;
    citationOffset?: number;
    column?: ColumnConfig;
}) {
    if (!children) return null;

    const pills: string[] = [];
    let processed = children.replace(/\[\[([^\]]+)\]\]/g, (_, content) => {
        const idx = pills.length;
        pills.push(content);
        return `\`§p${idx}§\``;
    });
    processed = processed.replace(/§(\d+)§/g, (_, idx) => `\`§c${idx}§\``);

    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                p: ({ node, ...props }) =>
                    inline ? (
                        <span {...props} />
                    ) : (
                        <p
                            className="mb-1.5 last:mb-0 leading-relaxed"
                            {...props}
                        />
                    ),
                ul: ({ node, ...props }) => (
                    <ul
                        className="list-disc pl-4 space-y-0.5 mb-1.5 last:mb-0"
                        {...props}
                    />
                ),
                ol: ({ node, ...props }) => (
                    <ol
                        className="list-decimal pl-4 space-y-0.5 mb-1.5 last:mb-0"
                        {...props}
                    />
                ),
                li: ({ node, ...props }) => <li {...props} />,
                strong: ({ node, ...props }) => (
                    <strong className="font-semibold" {...props} />
                ),
                em: ({ node, ...props }) => (
                    <em className="italic" {...props} />
                ),
                a: ({ node, href, children, ...props }) => (
                    <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-700 underline"
                        {...props}
                    >
                        {children}
                    </a>
                ),
                code: ({ node, children: codeChildren, ...props }) => {
                    const t = String(codeChildren);
                    const citMatch = t.match(/^§c(\d+)§$/);
                    if (citMatch) {
                        const idx = parseInt(citMatch[1]);
                        const citation = citations[idx];
                        if (citation) {
                            return (
                                <CitationBadge
                                    index={citationOffset + idx}
                                    citation={citation}
                                    onClick={onCitationClick}
                                />
                            );
                        }
                    }
                    const pillMatch = t.match(/^§p(\d+)§$/);
                    if (pillMatch) {
                        const content = pills[parseInt(pillMatch[1])];
                        if (content !== undefined) {
                            return (
                                <span
                                    className={`inline-block rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-none ${getPillClass(content, column)}`}
                                >
                                    {content}
                                </span>
                            );
                        }
                    }
                    return (
                        <code
                            className="bg-gray-100 px-1 py-0.5 rounded text-[11px] font-mono"
                            {...props}
                        >
                            {codeChildren}
                        </code>
                    );
                },
            }}
        >
            {processed}
        </ReactMarkdown>
    );
}
