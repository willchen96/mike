export type SourceDocumentType =
  "docx" | "pdf" | "spreadsheet" | "case" | "legislation" | "legal_research";

export type SourceDocumentMetadata = {
  label: string;
  value: string;
  format?: "date";
};

export type SourceDocumentAction = {
  type: "download" | "link";
  url: string;
  label: string;
  title?: string;
};

export type SourceDocumentQuote = {
  quote: string;
  verification?: {
    verified: boolean;
    source_excerpt?: string;
    start_char?: number;
    end_char?: number;
  };
  target: {
    page?: number | string;
    sheet?: string;
    cell?: string;
    subdocument_id?: string;
  };
};

export type SourceSubdocument = {
  document_id: string;
  title: string;
  type: "html";
  html?: string | null;
  text?: string | null;
};

export type SourceDocument = {
  document_id: string;
  title: string;
  type: SourceDocumentType;
  metadata: SourceDocumentMetadata[];
  actions?: SourceDocumentAction[];
  quotes: SourceDocumentQuote[];
  subdocuments?: SourceSubdocument[];
  version_id?: string | null;
  version_number?: number | null;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : null;
}

function quoteVerificationValue(value: unknown) {
  const verification = record(value);
  if (!verification || typeof verification.verified !== "boolean") {
    return undefined;
  }
  const sourceExcerpt = stringValue(verification.source_excerpt);
  const startChar = numberValue(verification.start_char);
  const endChar = numberValue(verification.end_char);
  return {
    verified: verification.verified,
    ...(sourceExcerpt ? { source_excerpt: sourceExcerpt } : {}),
    ...(startChar !== null ? { start_char: startChar } : {}),
    ...(endChar !== null ? { end_char: endChar } : {}),
  };
}

export function caseDocumentId(clusterId: number): string {
  return `case:${Math.floor(clusterId)}`;
}

export function caseClusterId(documentId: string): number | null {
  const match = /^case:(\d+)$/.exec(documentId);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function opinionTypeLabel(value: string | null): string {
  if (!value) return "Opinion";
  const type = value.replace(/^\d+/, "").replace(/_/g, " ").trim();
  const compact = type.toLowerCase().replace(/\s+/g, "");
  if (compact === "lead") return "Lead Opinion";
  if (
    compact === "concurrentinpart" ||
    compact === "concurrenceinpart" ||
    compact === "concurinpart"
  ) {
    return "Concurrence in part";
  }
  if (compact === "combined") return "Combined Opinion";
  return type.replace(/\b\w/g, (character) => character.toUpperCase());
}

function opinionRank(value: string | null): number {
  const type = value?.replace(/^\d+/, "").toLowerCase() ?? "";
  if (
    type.includes("lead") ||
    type.includes("majority") ||
    type.includes("unanimous") ||
    type.includes("plurality")
  ) {
    return 0;
  }
  if (type.includes("concurr")) return 1;
  if (type.includes("dissent")) return 2;
  if (type.includes("combined")) return 4;
  return 3;
}

function opinionTitle(opinion: UnknownRecord, index: number): string {
  const type = stringValue(opinion.type);
  const author = stringValue(opinion.author);
  const base = type ? opinionTypeLabel(type) : `Opinion ${index + 1}`;
  return author ? `${base} by ${author}` : base;
}

export function caseSubdocumentId(
  clusterId: number,
  opinionId: number | null,
  index = 0,
): string {
  return `${caseDocumentId(clusterId)}:opinion:${opinionId ?? index}`;
}

export function normalizeCaseDocument(args: {
  clusterId: number;
  caseName?: string | null;
  citation?: string | null;
  citations?: string[];
  dateFiled?: string | null;
  url?: string | null;
  pdfUrl?: string | null;
  quotes?: unknown[];
  opinions?: unknown[];
}): SourceDocument {
  const citation =
    stringValue(args.citation) ??
    args.citations
      ?.map(stringValue)
      .find((value): value is string => !!value) ??
    null;
  const caseName = stringValue(args.caseName);
  const title = [caseName, citation].filter(Boolean).join(", ") || "Case";
  const documentId = caseDocumentId(args.clusterId);
  const metadata: SourceDocumentMetadata[] = [];
  const dateFiled = stringValue(args.dateFiled);
  if (dateFiled)
    metadata.push({ label: "Date", value: dateFiled, format: "date" });

  const actions: SourceDocumentAction[] = [];
  const pdfUrl = stringValue(args.pdfUrl);
  if (pdfUrl) {
    actions.push({ type: "download", url: pdfUrl, label: "Download" });
  }
  const sourceUrl = stringValue(args.url);
  if (sourceUrl) {
    actions.push({
      type: "link",
      url: sourceUrl,
      label: "Link",
      title: "Link",
    });
  }

  const orderedOpinions = (args.opinions ?? [])
    .map((value, index) => ({ value: record(value), index }))
    .filter(
      (entry): entry is { value: UnknownRecord; index: number } =>
        !!entry.value,
    )
    .sort((left, right) => {
      const rank =
        opinionRank(stringValue(left.value.type)) -
        opinionRank(stringValue(right.value.type));
      return rank || left.index - right.index;
    });
  const subdocuments: SourceSubdocument[] = orderedOpinions.map(
    ({ value, index }) => {
      const opinionId =
        numberValue(value.opinionId) ??
        numberValue(value.opinion_id) ??
        numberValue(value.id);
      return {
        document_id: caseSubdocumentId(args.clusterId, opinionId, index),
        title: opinionTitle(value, index),
        type: "html",
        html: stringValue(value.html),
        text: stringValue(value.text),
      };
    },
  );

  const quotes: SourceDocumentQuote[] = (args.quotes ?? [])
    .map((value, index): SourceDocumentQuote | null => {
      const quote = record(value);
      const text = stringValue(quote?.quote);
      if (!quote || !text) return null;
      const opinionId =
        numberValue(quote.opinionId) ?? numberValue(quote.opinion_id);
      const verification = quoteVerificationValue(quote.verification);
      return {
        quote: text,
        ...(verification ? { verification } : {}),
        target: {
          ...(opinionId !== null
            ? {
                subdocument_id: caseSubdocumentId(
                  args.clusterId,
                  opinionId,
                  index,
                ),
              }
            : {}),
        },
      };
    })
    .filter((quote): quote is SourceDocumentQuote => !!quote);

  return {
    document_id: documentId,
    title,
    type: "case",
    metadata,
    ...(actions.length ? { actions } : {}),
    quotes,
    ...(subdocuments.length ? { subdocuments } : {}),
  };
}

export function sourceDocumentType(filename: string): SourceDocumentType {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension === "docx" || extension === "doc") return "docx";
  if (extension === "xlsx" || extension === "xlsm" || extension === "xls") {
    return "spreadsheet";
  }
  return "pdf";
}
