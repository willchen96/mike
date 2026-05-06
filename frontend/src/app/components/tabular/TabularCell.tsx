"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, Expand } from "lucide-react";
import type { ColumnConfig, TabularCell as TCell } from "../shared/types";
import { preprocessCitations, type ParsedCitation } from "./citation-utils";
import { getPillClass } from "./pillUtils";

interface Props {
    cell: TCell;
    column?: ColumnConfig;
    onExpand: () => void;
    onCitationClick?: (page: number, quote: string) => void;
}

const FLAG_STYLES = {
    green: "bg-green-500",
    grey: "bg-[#C7C7B2]",
    yellow: "bg-amber-400",
    red: "bg-red-500",
} as const;

// Replace citations and pills with inline-code tokens so ReactMarkdown passes
// them through its `code` component, where we render the final UI.
function preprocessCellMarkdown(text: string): {
    processed: string;
    citations: ParsedCitation[];
    pills: string[];
} {
    const { processed: withCits, citations } = preprocessCitations(text);
    const pills: string[] = [];
    let out = withCits.replace(/\[\[([^\]]+)\]\]/g, (_, content) => {
        const idx = pills.length;
        pills.push(content);
        return `\`§p${idx}§\`\u200B`;
    });
    out = out.replace(/§(\d+)§/g, (_, idx) => `\`§c${idx}§\`\u200B`);
    return { processed: out, citations, pills };
}

function CellMarkdown({
    text,
    citations,
    pills,
    column,
    onCitationClick,
    onExpand,
    inline,
}: {
    text: string;
    citations: ParsedCitation[];
    pills: string[];
    column?: ColumnConfig;
    onCitationClick?: (page: number, quote: string) => void;
    onExpand: () => void;
    inline?: boolean;
}) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                p: ({ node, ...props }) =>
                    inline ? (
                        <span {...props} />
                    ) : (
                        <p className="mb-1 last:mb-0 leading-relaxed" {...props} />
                    ),
                ul: ({ node, ...props }) => (
                    <ul className="list-disc pl-4 space-y-0.5" {...props} />
                ),
                ol: ({ node, ...props }) => (
                    <ol className="list-decimal pl-4 space-y-0.5" {...props} />
                ),
                li: ({ node, ...props }) => <li {...props} />,
                strong: ({ node, ...props }) => (
                    <strong className="font-semibold" {...props} />
                ),
                em: ({ node, ...props }) => <em className="italic" {...props} />,
                a: ({ node, href, children, ...props }) => (
                    <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#898344] hover:text-[#536049] underline"
                        {...props}
                    >
                        {children}
                    </a>
                ),
                code: ({ node, children, ...props }) => {
                    const t = String(children);
                    const citMatch = t.match(/^§c(\d+)§$/);
                    if (citMatch) {
                        const idx = parseInt(citMatch[1]);
                        const citation = citations[idx];
                        if (citation) {
                            return (
                                <span
                                    title={`Page ${citation.page}: "${citation.quote}"`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (onCitationClick) {
                                            onCitationClick(
                                                citation.page,
                                                citation.quote,
                                            );
                                        } else {
                                            onExpand();
                                        }
                                    }}
                                    className="mx-0.5 inline-flex items-center justify-center rounded-full bg-[#C7C7B2]/40 w-3.5 h-3.5 text-[9px] font-medium text-[#292629]/80 align-super cursor-pointer hover:bg-[#C7C7B2] transition-colors"
                                >
                                    {idx + 1}
                                </span>
                            );
                        }
                    }
                    const pillMatch = t.match(/^§p(\d+)§$/);
                    if (pillMatch) {
                        const content = pills[parseInt(pillMatch[1])];
                        if (content !== undefined) {
                            return (
                                <span
                                    className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ${getPillClass(content, column)}`}
                                >
                                    {content}
                                </span>
                            );
                        }
                    }
                    return (
                        <code
                            className="bg-[#F5F5F5] px-1 py-0.5 rounded text-[11px] font-mono"
                            {...props}
                        >
                            {children}
                        </code>
                    );
                },
            }}
        >
            {text}
        </ReactMarkdown>
    );
}

export function TabularCell({
    cell,
    column,
    onExpand,
    onCitationClick,
}: Props) {
    const [inlineExpanded, setInlineExpanded] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!inlineExpanded) return;
        function handleClickOutside(e: MouseEvent) {
            if (
                containerRef.current &&
                !containerRef.current.contains(e.target as Node)
            ) {
                setInlineExpanded(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, [inlineExpanded]);

    if (cell.status === "generating") {
        return (
            <div className="h-10 px-2 flex items-center">
                <div className="h-4 w-full rounded bg-[#F5F5F5] animate-pulse" />
            </div>
        );
    }

    if (cell.status === "error") {
        return (
            <div className="h-10 flex items-center justify-center text-[#292629]/30">
                <AlertCircle className="h-4 w-4 text-red-300" />
            </div>
        );
    }

    if (!cell.content?.summary) {
        return <div className="h-10" />;
    }

    const { processed, citations, pills } = preprocessCellMarkdown(
        cell.content.summary,
    );

    const firstLine = processed.split("\n").find((l) => l.trim()) ?? processed;
    const collapsedDisplay = firstLine.replace(/^[-*•]\s+/, "");

    function handleCitationClickInOverlay(page: number, quote: string) {
        setInlineExpanded(false);
        onCitationClick?.(page, quote);
    }

    function handleSeeDetails() {
        setInlineExpanded(false);
        onExpand();
    }

    return (
        <div ref={containerRef} className="relative">
            {/* Normal cell row — always visible, preserves table layout */}
            <div
                className="group relative h-10 px-2 flex items-center text-xs text-[#292629]/90 leading-relaxed cursor-pointer hover:bg-[#F5F5F5] transition-colors"
                onClick={() => setInlineExpanded((v) => !v)}
            >
                {cell.content.flag && (
                    <span
                        className={`absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${FLAG_STYLES[cell.content.flag]}`}
                        title={cell.content.flag}
                    />
                )}
                <div className="line-clamp-1 w-full min-w-0">
                    <CellMarkdown
                        text={collapsedDisplay}
                        citations={citations}
                        pills={pills}
                        column={column}
                        onCitationClick={onCitationClick}
                        onExpand={onExpand}
                        inline
                    />
                </div>
            </div>

            {/* Inline expanded overlay — absolutely positioned so it overlays without disrupting table layout */}
            {inlineExpanded && (
                <div className="absolute left-0 top-0 z-50 w-full bg-white border border-[#C7C7B2] shadow-lg rounded-sm">
                    <div className="relative p-2 pr-4 text-xs text-[#292629]/90 leading-relaxed">
                        {cell.content.flag && (
                            <span
                                className={`absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${FLAG_STYLES[cell.content.flag]}`}
                                title={cell.content.flag}
                            />
                        )}
                        <CellMarkdown
                            text={processed}
                            citations={citations}
                            pills={pills}
                            column={column}
                            onCitationClick={handleCitationClickInOverlay}
                            onExpand={handleSeeDetails}
                        />
                    </div>
                    <div className="px-2 py-1.5 flex items-center justify-end">
                        <button
                            onClick={handleSeeDetails}
                            className="flex items-center gap-1 text-xs text-[#292629]/40 hover:text-[#292629]/80 transition-colors"
                        >
                            <Expand className="h-3 w-3" />
                            See details
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
