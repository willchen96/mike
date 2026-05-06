"use client";

import { createPortal } from "react-dom";
import { X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ColumnConfig } from "../shared/types";
import { formatIcon, formatLabel } from "../tabular/columnFormat";

interface Props {
    col: ColumnConfig;
    onClose: () => void;
}

export function WFColumnViewModal({ col, onClose }: Props) {
    const FormatIcon = formatIcon(col.format ?? "text");
    return createPortal(
        <div className="fixed inset-0 z-[101] flex items-center justify-center bg-[#292629]/20 backdrop-blur-xs">
            <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl flex flex-col h-[600px]">
                <div className="flex items-center justify-between px-6 pt-5 pb-2">
                    <div className="flex items-center gap-1.5 text-xs text-[#292629]/40">
                        <span>Workflows</span>
                        <span>›</span>
                        <span className="truncate max-w-[200px] text-[#292629]/60">{col.name}</span>
                    </div>
                    <button onClick={onClose} className="rounded-lg p-1.5 text-[#292629]/40 hover:bg-[#F5F5F5] hover:text-[#292629]/60">
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <div className="px-6 pt-3 pb-5 flex flex-col gap-4 overflow-y-auto flex-1">
                    <div>
                        <p className="text-sm font-medium text-[#292629]/50 mb-2">Column Title</p>
                        <p className="text-sm text-[#292629]/90">{col.name}</p>
                    </div>
                    <div>
                        <p className="text-sm font-medium text-[#292629]/50 mb-2">Format</p>
                        <span className="inline-flex items-center gap-1.5 text-sm text-[#292629]/80">
                            <FormatIcon className="h-3.5 w-3.5 text-[#292629]/40" />
                            {formatLabel(col.format ?? "text")}
                        </span>
                    </div>
                    {col.tags && col.tags.length > 0 && (
                        <div>
                            <p className="text-sm font-medium text-[#292629]/50 mb-2.5">Tags</p>
                            <div className="flex flex-wrap gap-1.5">
                                {col.tags.map((tag) => (
                                    <span key={tag} className="inline-block rounded-full bg-[#F5F5F5] px-2 py-0.5 text-xs text-[#292629]/60">{tag}</span>
                                ))}
                            </div>
                        </div>
                    )}
                    <div>
                        <p className="text-sm font-medium text-[#292629]/50 mb-2">Prompt</p>
                        <div className="text-base text-[#292629]/80 leading-relaxed font-sans prose prose-base max-w-none">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{col.prompt || "_No prompt defined._"}</ReactMarkdown>
                        </div>
                    </div>
                </div>
                <div className="border-t border-[#C7C7B2]/50 px-6 py-4 flex justify-end shrink-0">
                    <button onClick={onClose} className="rounded-lg bg-[#292629] px-5 py-2 text-sm font-medium text-white hover:bg-[#292629]/90">
                        Close
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
