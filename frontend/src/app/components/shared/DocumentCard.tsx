"use client";

import { FileText, File, X, AlertCircle, Loader2 } from "lucide-react";
import type { MikeDocument } from "./types";

interface Props {
  document: MikeDocument;
  onRemove?: (id: string) => void;
  onClick?: (doc: MikeDocument) => void;
  selected?: boolean;
}

function FileIcon({ fileType }: { fileType: string | null }) {
  if (fileType === "pdf") {
    return <FileText className="h-4 w-4 text-red-600 shrink-0" />;
  }
  if (fileType === "docx" || fileType === "doc") {
    return <File className="h-4 w-4 text-[#898344] shrink-0" />;
  }
  return <File className="h-4 w-4 text-[#292629]/50 shrink-0" />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentCard({ document, onRemove, onClick, selected }: Props) {
  const isError = document.status === "error";
  const isProcessing = document.status === "pending" || document.status === "processing";

  return (
    <div
      onClick={() => onClick?.(document)}
      className={[
        "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors",
        onClick ? "cursor-pointer" : "",
        selected
          ? "border-[#898344] bg-[#F5F5F5]"
          : isError
          ? "border-red-200 bg-red-50"
          : "border-[#C7C7B2] bg-white hover:border-[#C7C7B2]",
      ].join(" ")}
    >
      {isProcessing ? (
        <Loader2 className="h-4 w-4 animate-spin text-[#292629]/40 shrink-0" />
      ) : isError ? (
        <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
      ) : (
        <FileIcon fileType={document.file_type} />
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-[#292629]/90" title={document.filename}>
          {document.filename}
        </p>
        <p className="text-xs text-[#292629]/40">
          {isProcessing
            ? "Processing…"
            : isError
            ? "Upload failed"
            : [
                document.size_bytes != null ? formatBytes(document.size_bytes) : null,
                document.page_count ? `${document.page_count}p` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
        </p>
      </div>

      {onRemove && !isProcessing && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(document.id);
          }}
          className="shrink-0 rounded p-0.5 text-[#292629]/40 hover:bg-[#F5F5F5] hover:text-[#292629]/60"
          aria-label="Remove document"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
