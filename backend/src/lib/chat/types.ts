import path from "path";
import type { SourceDocument } from "../sourceDocuments";

export const STANDARD_FONT_DATA_URL = (() => {
  try {
    const pkgPath = require.resolve("pdfjs-dist/package.json");
    return path.join(path.dirname(pkgPath), "standard_fonts") + path.sep;
  } catch {
    return undefined;
  }
})();

const isDev = process.env.NODE_ENV !== "production";
export const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type DocStore = Map<
  string,
  {
    storage_path: string;
    file_type: string;
    filename: string;
    /** Identifies source material that must be copied before it is edited. */
    source_kind?: "document" | "library_template" | "workflow_asset";
    /**
     * Request-scoped plain text that is already available in memory. Inline
     * documents still flow through read_document so their body only reaches
     * the model when it chooses to read them.
     */
    inline_text?: string;
    /** Complete request-scoped document for the shared source panel. */
    panel_document?: SourceDocument;
  }
>;

export type WorkflowStore = Map<
  string,
  {
    title: string;
    skill_md: string;
    listed?: boolean;
    assets?: {
      asset_id: string;
      filename: string;
      file_type: string;
      storage_path: string;
    }[];
  }
>;

export type DocIndex = Record<
  string,
  {
    document_id: string;
    filename: string;
    version_id?: string | null;
    version_number?: number | null;
  }
>;

export type TabularCellStore = {
  columns: { index: number; name: string }[];
  documents: { id: string; filename: string }[];
  /** key: `${colIndex}:${docId}` */
  cells: Map<
    string,
    { summary: string; flag?: string; reasoning?: string } | null
  >;
};

export type ToolCall = {
  id: string;
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: string;
  content: string | null;
  files?: {
    filename: string;
    document_id?: string;
    version_id?: string;
    version_number?: number;
  }[];
  workflow?: { id: string; title: string };
};

/**
 * Per-quote verification result. `start_char`/`end_char` index into the
 * EXTRACTED source text (not the raw file bytes) and are only present for
 * single-segment quotes that matched.
 */
export type QuoteVerification = {
  verified: boolean;
  start_char?: number;
  end_char?: number;
  source_excerpt?: string;
};

// ---------------------------------------------------------------------------
// Doc resolution helpers (used by citations + documentOps)
// ---------------------------------------------------------------------------

export function resolveDoc(rawId: string, docIndex: DocIndex) {
  return docIndex[rawId];
}

/**
 * Resolve whatever identifier the model passed (`doc-N` slug, filename, or
 * document UUID) back to a chat-local doc label.
 */
export function resolveDocLabel(
  rawId: string,
  docStore: DocStore,
  docIndex?: DocIndex,
): string | null {
  if (docStore.has(rawId)) return rawId;
  for (const [label, info] of docStore.entries()) {
    if (info.filename === rawId) return label;
  }
  if (docIndex) {
    for (const [label, info] of Object.entries(docIndex)) {
      if (info.document_id === rawId) return label;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Event / annotation types (shared between toolDispatcher and streaming)
// ---------------------------------------------------------------------------

export type AskInputOption = {
  value: string;
};

export const MAX_ASK_INPUT_TEXT_LENGTH = 5_000;

export type AskInputItem =
  | {
      id: string;
      kind: "choice";
      question: string;
      options: AskInputOption[];
      allow_other: boolean;
      other_label: string;
      response_prefix?: string;
    }
  | {
      id: string;
      kind: "text";
      question: string;
      response_prefix?: string;
    }
  | {
      id: string;
      kind: "documents";
      document_types: string[];
      response_prefix?: string;
    };

export type AskInputsEvent = {
  type: "ask_inputs";
  items: AskInputItem[];
};

export type AskInputResponseItem =
  | {
      id: string;
      kind: "choice";
      question: string;
      answer?: string;
      skipped?: boolean;
    }
  | {
      id: string;
      kind: "text";
      question: string;
      answer?: string;
      skipped?: boolean;
    }
  | {
      id: string;
      kind: "documents";
      filenames: string[];
      skipped?: boolean;
    };

export type AskInputsResponseRequest = {
  responses: AskInputResponseItem[];
};

export type EditAnnotation = {
  kind: "edit";
  edit_id: string;
  document_id: string;
  version_id: string;
  version_number?: number | null;
  change_id: string;
  del_w_id?: string;
  ins_w_id?: string;
  deleted_text: string;
  inserted_text: string;
  context_before: string;
  context_after: string;
  reason?: string;
  status: "pending" | "accepted" | "rejected";
};
