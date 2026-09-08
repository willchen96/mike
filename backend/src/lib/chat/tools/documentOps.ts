import {
  downloadFile,
  extractedTextKey,
  generatedDocKey,
  uploadFile,
} from "../../storage";
import { convertedPdfKey, docxToPdf } from "../../convert";
import { enqueueConversion } from "../../queue/conversionQueue";
import { enqueueDbJob, enqueueStorageCleanup } from "../../dbq/enqueue";
import { createServerSupabase } from "../../supabase";
import { normalizeDisplayName } from "../../userLookup";
import {
  applyTrackedEdits,
  extractDocxBodyText,
  type EditInput,
} from "../../docxTrackedChanges";
import { buildDownloadUrl } from "../../downloadTokens";
import {
  contentSha256,
  loadActiveVersion,
} from "../../documentVersions";
import {
  type DocStore,
  type DocIndex,
  type EditAnnotation,
  STANDARD_FONT_DATA_URL,
  devLog,
} from "../types";
import {
  contentTypeForDocumentType,
  isPresentationDocumentType,
  isSpreadsheetDocumentType,
  isWordDocumentType,
  requiresLibreOfficeTextExtraction,
  shouldConvertToPdf,
} from "../../documentTypes";
import { extractPresentationText } from "../../officeText";
import { spreadsheetToLLMText } from "../../spreadsheet";


export function citationReminder(
  docLabel: string,
  filename: string,
  promptFilename: string,
): string {
  const isSpreadsheet = isSpreadsheetDocumentType(
    filename.split(".").pop() ?? "",
  );
  const shapeLine = isSpreadsheet
    ? `Use this citation object shape for this spreadsheet: {"ref": 1, "doc_id": "${docLabel}", "quotes": [{"sheet": "Sheet name", "cell": "B7", "quote": "plain cell value"}]}. Cite by "sheet" + "cell" (A1 address or range), not by page.`
    : `Use this citation object shape: {"ref": 1, "doc_id": "${docLabel}", "quotes": [{"page": 1, "quote": "exact verbatim text from the document"}]}. Include top-level "page" and "quote" too only if they match the first quote.`;
  return [
    `[Citation requirement for ${docLabel}]:`,
    `Document filename: ${promptFilename}`,
    `If your final answer makes any factual claim from this document, include inline [N] markers and append a final <CITATIONS> JSON block.`,
    `Every citation entry for this document MUST use "doc_id": "${docLabel}".`,
    shapeLine,
    `Do not use "marker" or "text" keys in the citation block; use "ref" and "quotes".`,
  ].join("\n");
}

export async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{
            numPages: number;
            getPage: (n: number) => Promise<{
              getTextContent: () => Promise<{
                items: { str?: string }[];
              }>;
            }>;
          }>;
        };
      }
    ).getDocument({
      data: new Uint8Array(buf),
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
    }).promise;
    const parts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      parts.push(
        `[Page ${i}]\n${textContent.items.map((it) => it.str ?? "").join(" ")}`,
      );
    }
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

/**
 * The text read_document derives for the legacy Office types (.doc/.ppt):
 * LibreOffice → PDF → pdfjs. Exported so the document.precompute_text job
 * produces byte-identical text to the inline read path — a cache that can
 * drift from what it caches is worse than no cache.
 */
export async function extractLegacyOfficeText(
  raw: ArrayBuffer,
): Promise<string> {
  const pdfBuf = await docxToPdf(Buffer.from(raw));
  return extractPdfText(
    pdfBuf.buffer.slice(
      pdfBuf.byteOffset,
      pdfBuf.byteOffset + pdfBuf.byteLength,
    ) as ArrayBuffer,
  );
}

export async function generateDocx(
  title: string,
  sections: unknown[],
  userId: string,
  db: ReturnType<typeof createServerSupabase>,
  options?: {
    landscape?: boolean;
    numberSections?: boolean;
    projectId?: string | null;
  },
) {
  try {
    const {
      Document,
      Paragraph,
      HeadingLevel,
      Packer,
      Table,
      TableRow,
      TableCell,
      WidthType,
      BorderStyle,
      TextRun,
      AlignmentType,
      LevelFormat,
      LevelSuffix,
      PageOrientation,
      PageBreak,
    } = await import("docx");

    const FONT = "Times New Roman";
    const SIZE = 22; // 11pt in half-points

    type DocChild = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
    const children: DocChild[] = [];
    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        spacing: { after: 200 },
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: title.toUpperCase(),
            color: "000000",
            font: FONT,
            size: SIZE,
            bold: true,
          }),
        ],
      }),
    );

    const cellBorder = {
      top: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
      left: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
      right: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
    };

    const headingLevels = [
      HeadingLevel.HEADING_1,
      HeadingLevel.HEADING_2,
      HeadingLevel.HEADING_3,
      HeadingLevel.HEADING_4,
    ];
    // `=== true` is intentional: missing, null, or malformed values must
    // produce an unnumbered document.
    const numberSections = options?.numberSections === true;
    const LEGAL_NUMBERING_REF = "legal-clause-numbering";
    const legalNumbering = (level: number) => ({
      reference: LEGAL_NUMBERING_REF,
      level: Math.max(0, Math.min(level, 4)),
    });
    const legalNumberingLevels = [
      {
        level: 0,
        format: LevelFormat.DECIMAL,
        text: "%1.",
        alignment: AlignmentType.START,
        suffix: LevelSuffix.TAB,
        isLegalNumberingStyle: true,
        style: {
          paragraph: { indent: { left: 720, hanging: 720 } },
          run: {
            bold: true,
            color: "000000",
            font: FONT,
            size: SIZE,
          },
        },
      },
      {
        level: 1,
        format: LevelFormat.DECIMAL,
        text: "%1.%2",
        alignment: AlignmentType.START,
        suffix: LevelSuffix.TAB,
        isLegalNumberingStyle: true,
        style: {
          paragraph: { indent: { left: 720, hanging: 720 } },
          run: { color: "000000", font: FONT, size: SIZE },
        },
      },
      {
        level: 2,
        format: LevelFormat.LOWER_LETTER,
        text: "(%3)",
        alignment: AlignmentType.START,
        suffix: LevelSuffix.TAB,
        style: {
          paragraph: { indent: { left: 1440, hanging: 720 } },
          run: { color: "000000", font: FONT, size: SIZE },
        },
      },
      {
        level: 3,
        format: LevelFormat.LOWER_ROMAN,
        text: "(%4)",
        alignment: AlignmentType.START,
        suffix: LevelSuffix.TAB,
        style: {
          paragraph: { indent: { left: 1440, hanging: 720 } },
          run: { color: "000000", font: FONT, size: SIZE },
        },
      },
      {
        level: 4,
        format: LevelFormat.UPPER_LETTER,
        text: "(%5)",
        alignment: AlignmentType.START,
        suffix: LevelSuffix.TAB,
        style: {
          paragraph: { indent: { left: 2520, hanging: 720 } },
          run: { color: "000000", font: FONT, size: SIZE },
        },
      },
    ];
    const normalizeTable = (
      table: unknown,
    ): { headers: string[]; rows: string[][] } | null => {
      if (!table || typeof table !== "object") return null;
      const raw = table as { headers?: unknown; rows?: unknown };
      const headers = Array.isArray(raw.headers)
        ? raw.headers
            .map((header) => (typeof header === "string" ? header.trim() : ""))
            .filter(Boolean)
        : [];
      if (headers.length === 0) return null;

      const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
      const rows = rawRows
        .filter((row): row is unknown[] => Array.isArray(row))
        .map((row) =>
          headers.map((_, i) => (typeof row[i] === "string" ? row[i] : "")),
        );

      return { headers, rows };
    };
    const stripManualNumbering = (
      value: string,
    ): { text: string; levelFromPrefix: number | null } => {
      const match = value.trim().match(/^(\d+(?:\.\d+)*)(?:[.)])?\s+(.+)$/);
      if (!match) return { text: value.trim(), levelFromPrefix: null };
      return {
        text: match[2].trim(),
        levelFromPrefix: match[1].split(".").length - 1,
      };
    };
    const parseManualListMarker = (
      value: string,
    ): { text: string; levelOffset: number | null } => {
      const trimmed = value.trim();
      const match = trimmed.match(/^(\(([a-z]+)\)|([a-z]+)[.)])\s+(.+)$/i);
      if (!match) return { text: trimmed, levelOffset: null };
      const marker = (match[2] ?? match[3] ?? "").toLowerCase();
      const isRoman =
        marker === "i" ||
        (marker.length > 1 &&
          /^(?:m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))$/i.test(
            marker,
          ));
      return { text: match[4].trim(), levelOffset: isRoman ? 3 : 2 };
    };
    const normalizeHeadingText = (value: string) =>
      value
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .trim()
        .toLowerCase();

    const isTitleLikeFirstHeading = (heading: string, sectionIndex: number) => {
      if (sectionIndex !== 0) return false;
      const normalized = normalizeHeadingText(heading);
      const titleNormalized = normalizeHeadingText(title);
      if (!normalized || !titleNormalized) return false;
      if (normalized === titleNormalized) return true;
      return (
        titleNormalized.includes(normalized) &&
        /\b(agreement|contract|deed|terms|policy|notice|nda|disclosure)\b/.test(
          normalized,
        )
      );
    };

    const isUnnumberedHeading = (heading: string, sectionIndex: number) => {
      const normalized = normalizeHeadingText(heading);
      if (!normalized) return true;
      if (normalized === "signatures" || normalized === "signature") {
        return true;
      }
      if (isTitleLikeFirstHeading(heading, sectionIndex)) {
        return true;
      }
      if (
        sectionIndex === 0 &&
        /^(agreement|contract|mutual non disclosure agreement|non disclosure agreement|employment agreement|service level agreement)$/.test(
          normalized,
        )
      ) {
        return true;
      }
      return false;
    };
    const isSignatureLine = (value: string) =>
      /^(?:by|name|title|date):\s*/i.test(value.trim());
    const looksLikeSignatureBlock = (value: string) => {
      const lines = value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0) return false;
      const signatureLineCount = lines.filter(isSignatureLine).length;
      return signatureLineCount >= 2;
    };
    let currentClauseLevel: number | null = null;

    for (const [sectionIndex, section] of (
      sections as {
        heading?: string;
        content?: string;
        level?: number;
        pageBreak?: boolean;
        table?: { headers: string[]; rows: string[][] };
      }[]
    ).entries()) {
      if (section.pageBreak) {
        children.push(new Paragraph({ children: [new PageBreak()] }));
      }
      if (section.heading) {
        const stripped = numberSections
          ? stripManualNumbering(section.heading)
          : { text: section.heading.trim(), levelFromPrefix: null };
        const isUnnumbered = isUnnumberedHeading(stripped.text, sectionIndex);
        const skipHeading = isTitleLikeFirstHeading(
          stripped.text,
          sectionIndex,
        );
        const requestedLevel = Number.isInteger(section.level)
          ? Number(section.level)
          : 1;
        const idx = Math.max(
          0,
          Math.min(stripped.levelFromPrefix ?? requestedLevel - 1, 3),
        );
        currentClauseLevel =
          !numberSections || isUnnumbered || skipHeading ? null : idx;
        const headingText =
          idx === 0 && !isUnnumbered
            ? stripped.text.toUpperCase()
            : stripped.text;
        if (!skipHeading) {
          children.push(
            new Paragraph({
              heading: headingLevels[idx],
              numbering:
                numberSections && !isUnnumbered
                  ? legalNumbering(idx)
                  : undefined,
              spacing: { after: 160 },
              children: [
                new TextRun({
                  text: headingText,
                  color: "000000",
                  font: FONT,
                  size: SIZE,
                  bold: true,
                }),
              ],
            }),
          );
        }
      }
      const normalizedTable = normalizeTable(section.table);
      if (normalizedTable) {
        const { headers, rows } = normalizedTable;
        const tableRows: InstanceType<typeof TableRow>[] = [];
        // Header row
        tableRows.push(
          new TableRow({
            tableHeader: true,
            children: headers.map(
              (h) =>
                new TableCell({
                  borders: cellBorder,
                  shading: { fill: "F2F2F2" },
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: h,
                          bold: true,
                          font: FONT,
                          size: SIZE,
                        }),
                      ],
                      alignment: AlignmentType.LEFT,
                    }),
                  ],
                }),
            ),
          }),
        );
        // Data rows — normalize each row to exactly colCount cells.
        // LLMs occasionally emit malformed rows (extra fragments from
        // stray delimiters, or short rows); padding/truncating here
        // keeps the rendered table aligned to the headers.
        for (const normalized of rows) {
          tableRows.push(
            new TableRow({
              children: normalized.map(
                (cell) =>
                  new TableCell({
                    borders: cellBorder,
                    children: [
                      new Paragraph({
                        children: [
                          new TextRun({
                            text: cell,
                            font: FONT,
                            size: SIZE,
                          }),
                        ],
                      }),
                    ],
                  }),
              ),
            }),
          );
        }
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: tableRows,
          }),
        );
        children.push(new Paragraph({ text: "" }));
      }
      if (section.content) {
        const contentIsSignatureBlock =
          section.heading &&
          normalizeHeadingText(section.heading).includes("signature")
            ? true
            : looksLikeSignatureBlock(section.content);
        for (const line of section.content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const bulletMatch = trimmed.match(/^[-•*]\s+(.+)/);
          const rawText = bulletMatch ? bulletMatch[1].trim() : trimmed;
          const manualList = parseManualListMarker(rawText);
          const numeric = stripManualNumbering(rawText);
          const inferredLevel =
            currentClauseLevel === null || contentIsSignatureBlock
              ? undefined
              : bulletMatch
                ? undefined
                : manualList.levelOffset !== null
                  ? currentClauseLevel + manualList.levelOffset
                  : numeric.levelFromPrefix !== null
                    ? numeric.levelFromPrefix
                    : undefined;
          // Strip typed list markers only when Word numbering will replace
          // them. This preserves intentional text such as "1. Final notice"
          // in an otherwise unnumbered letter or signature block.
          const text = bulletMatch
            ? rawText
            : inferredLevel === undefined
              ? rawText
              : manualList.levelOffset !== null
                ? manualList.text
                : numeric.text;
          children.push(
            new Paragraph({
              numbering:
                inferredLevel === undefined
                  ? undefined
                  : legalNumbering(inferredLevel),
              bullet: bulletMatch ? { level: 0 } : undefined,
              spacing: { after: 120 },
              children: [
                new TextRun({
                  text,
                  font: FONT,
                  size: SIZE,
                }),
              ],
            }),
          );
        }
      }
    }

    const pageSetup = options?.landscape
      ? { page: { size: { orientation: PageOrientation.LANDSCAPE } } }
      : {};

    const doc = new Document({
      numbering: numberSections
        ? {
            config: [
              {
                reference: LEGAL_NUMBERING_REF,
                levels: legalNumberingLevels,
              },
            ],
          }
        : undefined,
      sections: [{ properties: pageSetup, children }],
    });
    const buf = await Packer.toBuffer(doc);
    const zip = await import("jszip");
    const packageZip = await zip.default.loadAsync(buf);
    for (const requiredPath of [
      "[Content_Types].xml",
      "word/document.xml",
      "word/_rels/document.xml.rels",
    ]) {
      if (!packageZip.file(requiredPath)) {
        return {
          error: `Generated DOCX is missing required package part: ${requiredPath}`,
        };
      }
    }
    const docId = crypto.randomUUID().replace(/-/g, "");
    const safeTitle =
      title
        .replace(/[^a-zA-Z0-9 -]/g, "")
        .trim()
        .slice(0, 64) || "document";
    const filename = `${safeTitle}.docx`;
    const key = generatedDocKey(userId, docId, filename);

    await uploadFile(
      key,
      buf.buffer as ArrayBuffer,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const downloadUrl = buildDownloadUrl(key, filename);

    // Persist to DB so generated docs are first-class documents:
    // openable in the DocPanel and editable via edit_document. In
    // project chats we attach to the project so it appears in the
    // sidebar; in the general chat we leave project_id null and it
    // stays a standalone document.
    const { data: docRow, error: docErr } = await db
      .from("documents")
      .insert({
        project_id: options?.projectId ?? null,
        user_id: userId,
        status: "ready",
      })
      .select("id")
      .single();
    if (docErr || !docRow) {
      return {
        error: `Failed to record generated document: ${docErr?.message ?? "unknown"}`,
      };
    }
    const documentId = docRow.id as string;

    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: documentId,
        storage_path: key,
        source: "generated",
        version_number: 1,
        filename: filename,
        file_type: "docx",
        size_bytes: buf.byteLength,
        page_count: null,
        content_sha256: contentSha256(buf),
      })
      .select("id")
      .single();
    if (verErr || !versionRow) {
      return {
        error: `Failed to record generated document version: ${verErr?.message ?? "unknown"}`,
      };
    }
    const versionId = versionRow.id as string;

    await db
      .from("documents")
      .update({
        current_version_id: versionId,
      })
      .eq("id", documentId);

    return {
      filename,
      download_url: downloadUrl,
      document_id: documentId,
      version_id: versionId,
      version_number: 1,
      storage_path: key,
      message: `Document '${filename}' has been generated successfully.`,
    };
  } catch (e) {
    return { error: String(e) };
  }
}

export function safeGeneratedFilename(title: string, extension: string) {
  const rawTitle = typeof title === "string" ? title : "document";
  const safeTitle =
    rawTitle
      .replace(/[^a-zA-Z0-9 -]/g, "")
      .trim()
      .slice(0, 64) || "document";
  return `${safeTitle}.${extension}`;
}

function xmlEscape(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function excelColumnName(index: number) {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const mod = (n - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    n = Math.floor((n - mod) / 26);
  }
  return name;
}

function normalizeSheetName(value: unknown, fallback: string) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return raw.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31) || fallback;
}

function normalizeRows(rows: unknown, colCount: number) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) =>
      Array.from({ length: colCount }, (_, i) =>
        row[i] == null ? "" : String(row[i]),
      ),
    );
}

async function buildXlsxWorkbook(title: string, sheetsInput: unknown[]) {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const sheets = sheetsInput.length ? sheetsInput : [{ name: title, columns: [], rows: [] }];

  const normalizedSheets = sheets.map((sheet, index) => {
    const raw = (sheet && typeof sheet === "object" ? sheet : {}) as {
      name?: unknown;
      columns?: unknown;
      rows?: unknown;
    };
    const columns = Array.isArray(raw.columns)
      ? raw.columns.map((col) => String(col ?? "")).filter((col) => col.trim())
      : [];
    const fallbackColumns = columns.length ? columns : ["Value"];
    return {
      name: normalizeSheetName(raw.name, `Sheet ${index + 1}`),
      columns: fallbackColumns,
      rows: normalizeRows(raw.rows, fallbackColumns.length),
    };
  });

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${normalizedSheets
  .map(
    (_, i) =>
      `  <Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  )
  .join("\n")}
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
  );
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(title)}</dc:title>
  <dc:creator>Mike</dc:creator>
  <cp:lastModifiedBy>Mike</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`,
  );
  zip.file(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Mike</Application>
</Properties>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
${normalizedSheets
  .map(
    (sheet, i) =>
      `    <sheet name="${xmlEscape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
  )
  .join("\n")}
  </sheets>
</workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${normalizedSheets
  .map(
    (_, i) =>
      `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  )
  .join("\n")}
</Relationships>`,
  );

  for (const [sheetIndex, sheet] of normalizedSheets.entries()) {
    const allRows = [sheet.columns, ...sheet.rows];
    const rowXml = allRows
      .map((row, rowIndex) => {
        const rowNumber = rowIndex + 1;
        const cellXml = row
          .map((value, colIndex) => {
            const ref = `${excelColumnName(colIndex)}${rowNumber}`;
            return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
          })
          .join("");
        return `<row r="${rowNumber}">${cellXml}</row>`;
      })
      .join("");
    const lastRef = `${excelColumnName(Math.max(sheet.columns.length - 1, 0))}${Math.max(allRows.length, 1)}`;
    zip.file(
      `xl/worksheets/sheet${sheetIndex + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastRef}"/>
  <sheetData>${rowXml}</sheetData>
</worksheet>`,
    );
  }

  return zip.generateAsync({ type: "nodebuffer" });
}

function pptTextParagraphs(lines: string[], opts: { title?: boolean } = {}) {
  return lines
    .map((line, index) => {
      const escaped = xmlEscape(line);
      const titleAttrs = opts.title ? ' sz="3200" b="1"' : ' sz="2000"';
      const bullet = !opts.title && index >= 0
        ? '<a:pPr marL="342900" indent="-171450"><a:buChar char="&#8226;"/></a:pPr>'
        : "";
      return `<a:p>${bullet}<a:r><a:rPr lang="en-US"${titleAttrs}/><a:t>${escaped}</a:t></a:r></a:p>`;
    })
    .join("");
}

function pptShape(id: number, name: string, x: number, y: number, cx: number, cy: number, body: string) {
  return `<p:sp>
  <p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
  <p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${body}</p:txBody>
</p:sp>`;
}

async function buildPptxPresentation(title: string, slidesInput: unknown[]) {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const rawSlides = slidesInput.length
    ? slidesInput
    : [{ title, bullets: ["Generated by Mike"] }];
  const slides = rawSlides.map((slide, index) => {
    const raw = (slide && typeof slide === "object" ? slide : {}) as {
      title?: unknown;
      bullets?: unknown;
    };
    return {
      title:
        typeof raw.title === "string" && raw.title.trim()
          ? raw.title.trim()
          : index === 0
            ? title
            : `Slide ${index + 1}`,
      bullets: Array.isArray(raw.bullets)
        ? raw.bullets.map((bullet) => String(bullet ?? "")).filter(Boolean)
        : [],
    };
  });

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${slides
  .map(
    (_, i) =>
      `  <Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  )
  .join("\n")}
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
  );
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(title)}</dc:title>
  <dc:creator>Mike</dc:creator>
  <cp:lastModifiedBy>Mike</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`,
  );
  zip.file(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Mike</Application>
  <PresentationFormat>On-screen Show (16:9)</PresentationFormat>
  <Slides>${slides.length}</Slides>
</Properties>`,
  );
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${slides.length + 1}"/></p:sldMasterIdLst>
  <p:sldIdLst>
${slides.map((_, i) => `    <p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("\n")}
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${slides
  .map(
    (_, i) =>
      `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
  )
  .join("\n")}
  <Relationship Id="rId${slides.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId${slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`,
  );
  zip.file(
    "ppt/slideMasters/slideMaster1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`,
  );
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
  );
  zip.file(
    "ppt/slideLayouts/slideLayout1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
  <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
</p:sldLayout>`,
  );
  zip.file(
    "ppt/theme/theme1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Mike">
  <a:themeElements>
    <a:clrScheme name="Office"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="059669"/></a:accent2><a:accent3><a:srgbClr val="D97706"/></a:accent3><a:accent4><a:srgbClr val="7C3AED"/></a:accent4><a:accent5><a:srgbClr val="DC2626"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>
    <a:fontScheme name="Office"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
  </a:themeElements>
</a:theme>`,
  );

  for (const [index, slide] of slides.entries()) {
    const bullets = slide.bullets.length ? slide.bullets : [""];
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${pptShape(2, "Title", 685800, 457200, 10820400, 914400, pptTextParagraphs([slide.title], { title: true }))}
      ${pptShape(3, "Content", 914400, 1600200, 10363200, 4343400, pptTextParagraphs(bullets))}
    </p:spTree>
  </p:cSld>
</p:sld>`,
    );
    zip.file(
      `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`,
    );
  }

  return zip.generateAsync({ type: "nodebuffer" });
}

async function persistGeneratedFile(params: {
  title: string;
  extension: "xlsx" | "pptx";
  buffer: Buffer;
  userId: string;
  db: ReturnType<typeof createServerSupabase>;
  projectId?: string | null;
}) {
  const { title, extension, buffer, userId, db, projectId } = params;
  const docId = crypto.randomUUID().replace(/-/g, "");
  const filename = safeGeneratedFilename(title, extension);
  const key = generatedDocKey(userId, docId, filename);
  await uploadFile(
    key,
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer,
    contentTypeForDocumentType(extension),
  );

  // PPTX is the only generated type that pays for LibreOffice here (XLSX is
  // never converted — spreadsheets are served raw). With the async flag on,
  // the rendition rides the conversion queue instead: the document is
  // inserted without one and a job fills it in with retries — closing the
  // sync path's silent failure mode where a LibreOffice hiccup left the doc
  // permanently rendition-less.
  let pdfStoragePath: string | null = null;
  const deferRenditionToQueue =
    shouldConvertToPdf(extension) &&
    process.env.ASYNC_DOCUMENT_CONVERSION === "true";
  if (shouldConvertToPdf(extension) && !deferRenditionToQueue) {
    try {
      const pdfBuf = await docxToPdf(buffer);
      const pdfKey = convertedPdfKey(userId, docId);
      await uploadFile(
        pdfKey,
        pdfBuf.buffer.slice(
          pdfBuf.byteOffset,
          pdfBuf.byteOffset + pdfBuf.byteLength,
        ) as ArrayBuffer,
        "application/pdf",
      );
      pdfStoragePath = pdfKey;
    } catch (err) {
      devLog(`[generate_${extension}] Office→PDF conversion failed:`, err);
    }
  }

  const downloadUrl = buildDownloadUrl(key, filename);
  const { data: docRow, error: docErr } = await db
    .from("documents")
    .insert({
      project_id: projectId ?? null,
      user_id: userId,
      status: "ready",
    })
    .select("id")
    .single();
  if (docErr || !docRow) {
    return {
      error: `Failed to record generated document: ${docErr?.message ?? "unknown"}`,
    };
  }
  const documentId = docRow.id as string;

  const { data: versionRow, error: verErr } = await db
    .from("document_versions")
    .insert({
      document_id: documentId,
      storage_path: key,
      pdf_storage_path: pdfStoragePath,
      source: "generated",
      version_number: 1,
      filename,
      file_type: extension,
      size_bytes: buffer.byteLength,
      page_count: null,
      content_sha256: contentSha256(buffer),
    })
    .select("id")
    .single();
  if (verErr || !versionRow) {
    return {
      error: `Failed to record generated document version: ${verErr?.message ?? "unknown"}`,
    };
  }
  const versionId = versionRow.id as string;

  await db
    .from("documents")
    .update({ current_version_id: versionId })
    .eq("id", documentId);

  if (deferRenditionToQueue) {
    // Deduped on convert:<versionId>, retried with backoff.
    // finalizeDocumentStatus: false — the document was inserted "ready" and
    // is downloadable from its raw bytes; a rendition failure must not flip
    // it to "error". Enqueue failure degrades to the sync path's
    // conversion-failure behavior: a usable document with no rendition.
    try {
      await enqueueConversion({
        documentId,
        versionId,
        userId,
        storagePath: key,
        fileType: extension,
        pdfKey: convertedPdfKey(userId, documentId),
        finalizeDocumentStatus: false,
      });
    } catch (err) {
      devLog(`[generate_${extension}] rendition enqueue failed:`, err);
    }
  }

  return {
    filename,
    download_url: downloadUrl,
    document_id: documentId,
    version_id: versionId,
    version_number: 1,
    storage_path: key,
    message: `Document '${filename}' has been generated successfully.`,
  };
}

export async function generateExcel(
  title: string,
  sheets: unknown[],
  userId: string,
  db: ReturnType<typeof createServerSupabase>,
  options?: { projectId?: string | null },
) {
  try {
    const normalizedTitle = typeof title === "string" ? title : "Workbook";
    const buffer = await buildXlsxWorkbook(
      normalizedTitle,
      Array.isArray(sheets) ? sheets : [],
    );
    return persistGeneratedFile({
      title: normalizedTitle,
      extension: "xlsx",
      buffer,
      userId,
      db,
      projectId: options?.projectId ?? null,
    });
  } catch (e) {
    return { error: String(e) };
  }
}

export async function generatePpt(
  title: string,
  slides: unknown[],
  userId: string,
  db: ReturnType<typeof createServerSupabase>,
  options?: { projectId?: string | null },
) {
  try {
    const normalizedTitle = typeof title === "string" ? title : "Presentation";
    const buffer = await buildPptxPresentation(
      normalizedTitle,
      Array.isArray(slides) ? slides : [],
    );
    return persistGeneratedFile({
      title: normalizedTitle,
      extension: "pptx",
      buffer,
      userId,
      db,
      projectId: options?.projectId ?? null,
    });
  } catch (e) {
    return { error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Document version helpers (DOCX tracked-change editing)
// ---------------------------------------------------------------------------

/**
 * Resolve the current .docx bytes for a document, preferring the active
 * tracked-changes version if one exists, else the original upload.
 */
export async function loadCurrentVersionBytes(
  documentId: string,
  db: ReturnType<typeof createServerSupabase>,
  versionId?: string | null,
): Promise<{ bytes: Buffer; storage_path: string } | null> {
  const active = await loadActiveVersion(documentId, db, versionId);
  if (!active) return null;
  const raw = await downloadFile(active.storage_path);
  if (!raw) return null;
  return { bytes: Buffer.from(raw), storage_path: active.storage_path };
}

/**
 * Ensure the document has a document_versions row for the current upload.
 * Called before writing the first 'assistant_edit' row so the history is
 * complete. Idempotent.
 */
export async function runEditDocument(params: {
  documentId: string;
  userId: string;
  edits: EditInput[];
  db: ReturnType<typeof createServerSupabase>;
  /**
   * If provided, append these edits to the existing turn-scoped version
   * (overwrites the file at storagePath and reuses the document_versions
   * row) instead of creating a new version. Used to collapse multiple
   * edit_document tool calls within a single assistant turn into one
   * version.
   */
  reuseVersion?: {
    versionId: string;
    versionNumber: number;
    storagePath: string;
  };
}): Promise<
  | {
      ok: true;
      version_id: string;
      version_number: number;
      storage_path: string;
      download_url: string;
      annotations: EditAnnotation[];
      errors: { index: number; reason: string }[];
    }
  | { ok: false; error: string }
> {
  const { documentId, userId, edits, db, reuseVersion } = params;

  const { data: doc } = await db
    .from("documents")
    .select("id")
    .eq("id", documentId)
    .single();
  if (!doc) return { ok: false, error: "Document not found." };

  const activeVersion = await loadActiveVersion(documentId, db);
  let versionFilename =
    activeVersion?.filename?.trim() || "Untitled document";

  const current = await loadCurrentVersionBytes(documentId, db);
  if (!current) return { ok: false, error: "Could not load document bytes." };

  // LOCAL PATCH (not upstream): attribute tracked changes to the acting user
  // instead of the literal string "Mike" — see mike-frontend-docker-patch
  // memory for the reapply convention this follows.
  const { data: authorProfile } = await db
    .from("user_profiles")
    .select("display_name, email")
    .eq("user_id", userId)
    .maybeSingle();
  const author =
    normalizeDisplayName(authorProfile?.display_name) ??
    (typeof authorProfile?.email === "string" ? authorProfile.email : null) ??
    "Mike";

  const {
    bytes: editedBytes,
    changes,
    errors,
  } = await applyTrackedEdits(current.bytes, edits, { author });

  if (changes.length === 0) {
    return {
      ok: false,
      error:
        errors[0]?.reason ??
        "No edits could be applied. Refine context_before/context_after and retry.",
    };
  }

  const ab = editedBytes.buffer.slice(
    editedBytes.byteOffset,
    editedBytes.byteOffset + editedBytes.byteLength,
  ) as ArrayBuffer;

  let versionRowId: string;
  let newPath: string;
  let nextVersionNumber: number;

  if (reuseVersion) {
    // Overwrite the existing turn version's file in place. The version
    // row, version_number, and current_version_id all already point here.
    newPath = reuseVersion.storagePath;
    versionRowId = reuseVersion.versionId;
    nextVersionNumber = reuseVersion.versionNumber;

    // Clear the hash before the bytes change; the update below sets it again.
    // Storage and Postgres cannot be written atomically, so a failure between
    // the two leaves the version unhashed and therefore unverifiable, rather
    // than hashed against content it no longer holds.
    await db
      .from("document_versions")
      .update({ content_sha256: null })
      .eq("id", versionRowId);

    await uploadFile(
      newPath,
      ab,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    await db
      .from("document_versions")
      .update({
        file_type: "docx",
        size_bytes: editedBytes.byteLength,
        page_count: null,
        content_sha256: contentSha256(editedBytes),
        // The bytes just changed in place — any rendition this version
        // carried no longer matches them (same invariant as accept/reject).
        pdf_storage_path: null,
      })
      .eq("id", versionRowId);
    // Same invariant for the extracted-text cache. In practice this rewrite
    // always produces DOCX, which is not a cached type, so this is a
    // no-op-shaped safety net rather than a live invalidation — but it is the
    // one place a cached key could ever go stale, so it must not be missing.
    await enqueueStorageCleanup(db, [extractedTextKey(versionRowId)]);
  } else {
    const versionId = crypto.randomUUID().replace(/-/g, "");
    newPath = `documents/${userId}/${documentId}/edits/${versionId}.docx`;
    await uploadFile(
      newPath,
      ab,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    // Per-document sequential number for the new assistant_edit
    // version. The counter spans upload + user_upload + assistant_edit
    // so the original upload is V1 and the first assistant edit is V2.
    const { data: maxRow } = await db
      .from("document_versions")
      .select("version_number")
      .eq("document_id", documentId)
      .in("source", ["upload", "user_upload", "assistant_edit"])
      .order("version_number", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    nextVersionNumber = ((maxRow?.version_number as number | null) ?? 1) + 1;

    // Inherit the filename from the most recent prior version so
    // user-applied renames carry forward through further edits. Malformed
    // legacy rows without a filename get a neutral placeholder, not the
    // parent document filename. We intentionally do NOT append "[Edited Vn]"
    // — the version number is surfaced separately as a tag in the UI.
    const { data: prevRow } = await db
      .from("document_versions")
      .select("filename, created_at")
      .eq("document_id", documentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const inheritedFilename =
      (prevRow?.filename as string | null)?.trim() || "Untitled document";
    versionFilename = inheritedFilename;

    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: documentId,
        storage_path: newPath,
        source: "assistant_edit",
        version_number: nextVersionNumber,
        filename: inheritedFilename,
        file_type: "docx",
        size_bytes: editedBytes.byteLength,
        page_count: null,
        content_sha256: contentSha256(editedBytes),
      })
      .select("id")
      .single();
    if (verErr || !versionRow) {
      return { ok: false, error: "Failed to record document version." };
    }
    versionRowId = versionRow.id as string;
  }

  // Insert one row per change
  const editRows = changes.map((c) => ({
    document_id: documentId,
    version_id: versionRowId,
    change_id: c.id,
    del_w_id: c.delId ?? null,
    ins_w_id: c.insId ?? null,
    deleted_text: c.deletedText,
    inserted_text: c.insertedText,
    context_before: c.contextBefore ?? "",
    context_after: c.contextAfter ?? "",
    status: "pending" as const,
  }));
  const { data: insertedEdits, error: editsErr } = await db
    .from("document_edits")
    .insert(editRows)
    .select(
      "id, change_id, del_w_id, ins_w_id, deleted_text, inserted_text, context_before, context_after",
    );

  if (editsErr || !insertedEdits) {
    return { ok: false, error: "Failed to record edits." };
  }

  await db
    .from("documents")
    .update({
      current_version_id: versionRowId,
    })
    .eq("id", documentId);

  const annotations: EditAnnotation[] = insertedEdits.map(
    (r: {
      id: string;
      change_id: string;
      deleted_text: string;
      inserted_text: string;
      context_before: string | null;
      context_after: string | null;
    }) => {
      const src = changes.find((c) => c.id === r.change_id);
      return {
        kind: "edit",
        edit_id: r.id,
        document_id: documentId,
        version_id: versionRowId,
        version_number: nextVersionNumber,
        change_id: r.change_id,
        del_w_id: src?.delId,
        ins_w_id: src?.insId,
        deleted_text: r.deleted_text ?? "",
        inserted_text: r.inserted_text ?? "",
        context_before: r.context_before ?? "",
        context_after: r.context_after ?? "",
        reason: src?.reason,
        status: "pending",
      };
    },
  );

  // Persistent, non-expiring permalink. The backend streams fresh bytes
  // on each request, so this URL stays valid as long as the file exists.
  const resolvedFilename = versionFilename.trim() || "Untitled document.docx";
  const permalink = buildDownloadUrl(newPath, resolvedFilename);

  return {
    ok: true,
    version_id: versionRowId,
    version_number: nextVersionNumber,
    storage_path: newPath,
    download_url: permalink,
    annotations,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export async function getTurnReadIdentity(params: {
  docLabel: string;
  docStore: DocStore;
  docIndex?: DocIndex;
  db?: ReturnType<typeof createServerSupabase>;
}): Promise<{
  key: string;
  docLabel: string;
  filename: string;
  documentId?: string;
  versionId?: string | null;
  versionNumber?: number | null;
  storagePath: string;
} | null> {
  const { docLabel, docStore, docIndex, db } = params;
  const docInfo = docStore.get(docLabel);
  if (!docInfo) return null;

  const documentId = docIndex?.[docLabel]?.document_id;
  if (documentId && db) {
    const active = await loadActiveVersion(documentId, db);
    if (active?.storage_path) {
      return {
        key: `${documentId}:${active.id}`,
        docLabel,
        filename: docInfo.filename,
        documentId,
        versionId: active.id,
        versionNumber: active.version_number,
        storagePath: active.storage_path,
      };
    }
  }

  return {
    key: `${documentId ?? docLabel}:${docInfo.storage_path}`,
    docLabel,
    filename: docInfo.filename,
    documentId,
    versionId: docIndex?.[docLabel]?.version_id ?? null,
    versionNumber: docIndex?.[docLabel]?.version_number ?? null,
    storagePath: docInfo.storage_path,
  };
}

export function duplicateReadDocumentResult(identity: {
  docLabel: string;
  documentId?: string;
  versionId?: string | null;
}) {
  return JSON.stringify({
    ok: true,
    already_read: true,
    doc_id: identity.docLabel,
    document_id: identity.documentId,
    version_id: identity.versionId ?? null,
    content:
      "This document/version was already read earlier in this response. The full text is not repeated to avoid unnecessary token use.",
    next_required_action:
      "Use the prior read_document/fetch_documents result, call find_in_document for targeted checks, or proceed to edit_document.",
  });
}

export function clearTurnReadsForDocument(
  turnReadState: TurnReadState | undefined,
  documentId: string,
) {
  if (!turnReadState) return;
  for (const [key, value] of turnReadState.entries()) {
    if (value.documentId === documentId) turnReadState.delete(key);
  }
}

export async function readDocumentContent(
  docLabel: string,
  docStore: DocStore,
  write: (s: string) => void,
  docIndex?: DocIndex,
  db?: ReturnType<typeof createServerSupabase>,
  opts?: {
    emitEvents?: boolean;
    readIdentity?: Awaited<ReturnType<typeof getTurnReadIdentity>>;
  },
): Promise<string> {
  const emitEvents = opts?.emitEvents ?? true;
  devLog(`[read_document] called with docLabel="${docLabel}"`);
  const docInfo = docStore.get(docLabel);
  if (!docInfo) {
    devLog(
      `[read_document] MISS — docLabel "${docLabel}" not in docStore. Known labels:`,
      Array.from(docStore.keys()),
    );
    return "Document not found.";
  }
  devLog(
    `[read_document] docInfo: filename="${docInfo.filename}", file_type="${docInfo.file_type}", storage_path="${docInfo.storage_path}"`,
  );

  const documentId = docIndex?.[docLabel]?.document_id;
  const readIdentity =
    opts?.readIdentity ??
    (emitEvents
      ? await getTurnReadIdentity({ docLabel, docStore, docIndex, db })
      : null);
  const versionId =
    readIdentity?.versionId ?? docIndex?.[docLabel]?.version_id ?? null;
  const versionNumber =
    readIdentity?.versionNumber ?? docIndex?.[docLabel]?.version_number ?? null;
  const emitDocRead = () => {
    if (!emitEvents) return;
    write(
      `data: ${JSON.stringify({
        type: "doc_read",
        filename: docInfo.filename,
        document_id: readIdentity?.documentId ?? documentId,
        version_id: versionId,
        version_number: versionNumber,
      })}\n\n`,
    );
  };
  if (emitEvents)
    write(
      `data: ${JSON.stringify({
        type: "doc_read_start",
        filename: docInfo.filename,
        document_id: readIdentity?.documentId ?? documentId,
        version_id: versionId,
        version_number: versionNumber,
      })}\n\n`,
    );
  try {
    // The Word add-in supplies the active document's plain-text snapshot with
    // the request. Keep it in the same document-tool pipeline as stored files:
    // availability metadata is visible up front, but the body is returned only
    // after the model explicitly calls read_document.
    if (docInfo.inline_text !== undefined) {
      devLog(
        `[read_document] using request-scoped inline text (chars=${docInfo.inline_text.length}) for filename="${docInfo.filename}"`,
      );
      emitDocRead();
      return docInfo.inline_text;
    }

    // Prefer the current tracked-changes version (if any) so read_document
    // reflects accepted/pending edits rather than the original upload.
    let raw: ArrayBuffer | null = null;
    let sourcePath = docInfo.storage_path;
    if (documentId && db) {
      const current = await loadCurrentVersionBytes(documentId, db, versionId);
      if (current) {
        raw = current.bytes.buffer.slice(
          current.bytes.byteOffset,
          current.bytes.byteOffset + current.bytes.byteLength,
        ) as ArrayBuffer;
        sourcePath = current.storage_path;
        devLog(
          `[read_document] using current version path="${sourcePath}" (bytes=${raw.byteLength})`,
        );
      } else {
        devLog(
          `[read_document] loadCurrentVersionBytes returned null for documentId="${documentId}", falling back to original storage_path`,
        );
      }
    }
    if (!raw) {
      raw = await downloadFile(docInfo.storage_path);
      if (raw) {
        devLog(
          `[read_document] fallback download from storage_path="${docInfo.storage_path}" (bytes=${raw.byteLength})`,
        );
      }
    }
    if (!raw) {
      devLog(
        `[read_document] FAILED to download any bytes for docLabel="${docLabel}" (tried path="${sourcePath}")`,
      );
      emitDocRead();
      return "Document could not be read.";
    }
    // Log the first 8 bytes so we can identify real file format regardless
    // of the declared file_type. Valid .docx starts with "PK\x03\x04"
    // (zip). Legacy .doc starts with "\xD0\xCF\x11\xE0" (OLE/CFB).
    // %PDF-1 is a PDF even if mislabeled. Truncated uploads show as all-zero.
    {
      const head = Buffer.from(raw).subarray(0, 8);
      const hex = head.toString("hex");
      const ascii = head.toString("binary").replace(/[^\x20-\x7e]/g, ".");
      devLog(
        `[read_document] magic bytes hex=${hex} ascii="${ascii}" for filename="${docInfo.filename}"`,
      );
    }
    let text: string;
    const fileType = docInfo.file_type?.toLowerCase?.() ?? "";
    if (fileType === "pdf") {
      text = await extractPdfText(raw);
      devLog(
        `[read_document] pdf extracted length=${text.length} for filename="${docInfo.filename}"`,
      );
    } else if (fileType === "docx") {
      // Use the same flattening as the edit_document matcher so the
      // LLM sees exactly the characters it can anchor against.
      text = await extractDocxBodyText(Buffer.from(raw));
      devLog(
        `[read_document] docx extractDocxBodyText length=${text.length} for filename="${docInfo.filename}"`,
      );
      if (!text) {
        devLog(
          `[read_document] docx accepted-view extractor returned empty, falling back to mammoth for filename="${docInfo.filename}"`,
        );
        const mammoth = await import("mammoth");
        const result = await mammoth.extractRawText({
          buffer: Buffer.from(raw),
        });
        text = result.value;
        devLog(
          `[read_document] docx mammoth fallback length=${text.length} for filename="${docInfo.filename}"`,
        );
      }
    } else if (isSpreadsheetDocumentType(fileType)) {
      // SheetJS reads .xlsx/.xlsm/.xls directly (no PDF detour), emitting a
      // cell-addressed markdown view with Excel-formatted values.
      text = spreadsheetToLLMText(Buffer.from(raw));
      devLog(
        `[read_document] spreadsheet extracted length=${text.length} for filename="${docInfo.filename}"`,
      );
    } else if (fileType === "pptx") {
      text = await extractPresentationText(Buffer.from(raw));
      devLog(
        `[read_document] presentation extracted length=${text.length} for filename="${docInfo.filename}"`,
      );
    } else if (
      isPresentationDocumentType(fileType) ||
      isWordDocumentType(fileType)
    ) {
      // This branch is the only one that shells out to LibreOffice — every
      // other type has an in-process reader above — so it is the only one
      // worth caching. The cached object is written by the
      // document.precompute_text job, keyed on the immutable version id.
      const cacheKey =
        versionId && requiresLibreOfficeTextExtraction(fileType)
          ? extractedTextKey(versionId)
          : null;
      const cached = cacheKey ? await downloadFile(cacheKey) : null;
      if (cached) {
        text = Buffer.from(cached).toString("utf8");
        devLog(
          `[read_document] legacy Office text served from cache key="${cacheKey}" length=${text.length} for filename="${docInfo.filename}"`,
        );
      } else {
        devLog(
          `[read_document] legacy Office file_type="${fileType}" for filename="${docInfo.filename}", converting to pdf for text extraction`,
        );
        text = await extractLegacyOfficeText(raw);
        devLog(
          `[read_document] legacy Office PDF extraction length=${text.length} for filename="${docInfo.filename}"`,
        );
        // Warm the cache for the next read of this version. Fire-and-forget
        // and deduped: several tool calls in one turn queue one job, and a
        // failure here must never affect the text we just produced.
        if (cacheKey && db) {
          void enqueueDbJob(db, {
            kind: "document.precompute_text",
            payload: { versionId, storagePath: sourcePath, fileType },
            dedupeKey: `precompute:${versionId}`,
            maxAttempts: 3,
          }).catch((err) =>
            devLog(`[read_document] precompute enqueue failed`, err),
          );
        }
      }
    } else {
      devLog(
        `[read_document] unknown file_type="${docInfo.file_type}" for filename="${docInfo.filename}", trying mammoth`,
      );
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(raw),
      });
      text = result.value;
      devLog(
        `[read_document] mammoth length=${text.length} for filename="${docInfo.filename}"`,
      );
    }
    devLog(
      `[read_document] DONE filename="${docInfo.filename}" finalTextLength=${text.length} firstChars=${JSON.stringify(text.slice(0, 120))}`,
    );
    emitDocRead();
    return text;
  } catch (err) {
    devLog(
      `[read_document] THREW for docLabel="${docLabel}" filename="${docInfo.filename}":`,
      err,
    );
    if (emitEvents)
      write(
        `data: ${JSON.stringify({
          type: "doc_read",
          filename: docInfo.filename,
          document_id: readIdentity?.documentId ?? documentId,
          version_id: versionId,
          version_number: versionNumber,
        })}\n\n`,
      );
    return "Document could not be read.";
  }
}

/** A character is "punctuation" for tolerant matching if it is not a letter,
 *  number, or whitespace. Dropped entirely (not replaced with a space) so
 *  "U.S." collapses to "us" and "plaintiff's" to "plaintiffs". */
function isPunctuation(ch: string): boolean {
  return !/[\p{L}\p{N}\s]/u.test(ch);
}

/**
 * Build a whitespace-collapsed, lowercased copy of `text`, plus a map from
 * each character index in the normalized form back to the corresponding
 * index in the original text. Used by `findInDocumentContent` (and server-side
 * citation verification) so matches are tolerant of case + whitespace variance
 * but can still return the exact original excerpt.
 *
 * With `stripPunctuation`, punctuation characters are removed from the
 * normalized form too, making matching tolerant of punctuation drift (e.g. a
 * model that adds a stray comma or drops a period). The index map still points
 * back at the surviving original characters so the recovered excerpt is exact.
 */
export function normalizeWithMap(
  text: string,
  opts: { stripPunctuation?: boolean } = {},
): { norm: string; origIdx: number[] } {
  const stripPunctuation = opts.stripPunctuation ?? false;
  const norm: string[] = [];
  const origIdx: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!prevSpace) {
        norm.push(" ");
        origIdx.push(i);
        prevSpace = true;
      }
    } else if (stripPunctuation && isPunctuation(ch)) {
      // Drop punctuation without disturbing the space-collapsing state so
      // "foo, bar" -> "foo bar" but "U.S." -> "us".
      continue;
    } else {
      norm.push(ch.toLowerCase());
      origIdx.push(i);
      prevSpace = false;
    }
  }
  return { norm: norm.join(""), origIdx };
}

function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

export type TextMatch = {
  index: number;
  excerpt: string;
  context: string;
};

export function findTextMatches(params: {
  text: string;
  query: string;
  maxResults: number;
  contextChars: number;
  startIndex?: number;
}): { hits: TextMatch[]; totalMatches: number } {
  const { text, query, maxResults, contextChars, startIndex = 0 } = params;
  const { norm, origIdx } = normalizeWithMap(text);
  const needle = normalizeQuery(query);
  const hits: TextMatch[] = [];
  let totalMatches = 0;
  if (!needle) return { hits, totalMatches };

  let from = 0;
  while (from <= norm.length - needle.length) {
    const pos = norm.indexOf(needle, from);
    if (pos < 0) break;
    const endNormPos = pos + needle.length;
    const origStart = origIdx[pos] ?? 0;
    const origEnd =
      endNormPos - 1 < origIdx.length
        ? origIdx[endNormPos - 1] + 1
        : text.length;
    if (hits.length < maxResults) {
      const ctxStart = Math.max(0, origStart - contextChars);
      const ctxEnd = Math.min(text.length, origEnd + contextChars);
      hits.push({
        index: startIndex + hits.length,
        excerpt: text.slice(origStart, origEnd),
        context:
          (ctxStart > 0 ? "…" : "") +
          text.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim() +
          (ctxEnd < text.length ? "…" : ""),
      });
    }
    totalMatches++;
    from = pos + Math.max(1, needle.length);
  }

  return { hits, totalMatches };
}

/**
 * Ctrl+F helper. Returns a JSON-serializable result with up to `maxResults`
 * hits, each containing the original-text excerpt plus surrounding context.
 */
export async function findInDocumentContent(params: {
  docLabel: string;
  query: string;
  maxResults?: number;
  contextChars?: number;
  docStore: DocStore;
  write: (s: string) => void;
  docIndex?: DocIndex;
  db?: ReturnType<typeof createServerSupabase>;
  readIdentity?: Awaited<ReturnType<typeof getTurnReadIdentity>>;
}): Promise<string> {
  const {
    docLabel,
    query,
    maxResults = 20,
    contextChars = 80,
    docStore,
    write,
    docIndex,
    db,
  } = params;

  if (!query || !query.trim()) {
    return JSON.stringify({ ok: false, error: "Empty query." });
  }

  const docInfo = docStore.get(docLabel);
  if (!docInfo) {
    return JSON.stringify({
      ok: false,
      error: `Document '${docLabel}' not found.`,
    });
  }
  const documentId = docIndex?.[docLabel]?.document_id;
  const readIdentity =
    params.readIdentity ??
    (await getTurnReadIdentity({ docLabel, docStore, docIndex, db }));
  const versionId =
    readIdentity?.versionId ?? docIndex?.[docLabel]?.version_id ?? null;
  const versionNumber =
    readIdentity?.versionNumber ?? docIndex?.[docLabel]?.version_number ?? null;

  // Announce the search to the UI, then reuse readDocumentContent for its
  // fallbacks — but suppress its own doc_read events so the user only sees
  // the doc_find block (not a competing doc_read block for the same op).
  write(
    `data: ${JSON.stringify({
      type: "doc_find_start",
      filename: docInfo.filename,
      document_id: readIdentity?.documentId ?? documentId,
      version_id: versionId,
      version_number: versionNumber,
      query,
    })}\n\n`,
  );

  const text = await readDocumentContent(
    docLabel,
    docStore,
    write,
    docIndex,
    db,
    { emitEvents: false, readIdentity },
  );
  if (!text || text === "Document could not be read.") {
    write(
      `data: ${JSON.stringify({
        type: "doc_find",
        filename: docInfo.filename,
        document_id: readIdentity?.documentId ?? documentId,
        version_id: versionId,
        version_number: versionNumber,
        query,
        total_matches: 0,
      })}\n\n`,
    );
    return JSON.stringify({
      ok: false,
      filename: docInfo.filename,
      error: "Document could not be read.",
    });
  }

  const needle = normalizeQuery(query);
  if (!needle) {
    return JSON.stringify({
      ok: false,
      error: "Empty query after normalization.",
    });
  }

  const { hits, totalMatches } = findTextMatches({
    text,
    query,
    maxResults,
    contextChars,
  });

  write(
    `data: ${JSON.stringify({
      type: "doc_find",
      filename: docInfo.filename,
      document_id: readIdentity?.documentId ?? documentId,
      version_id: versionId,
      version_number: versionNumber,
      query,
      total_matches: totalMatches,
    })}\n\n`,
  );

  return JSON.stringify({
    ok: true,
    filename: docInfo.filename,
    query,
    total_matches: totalMatches,
    returned: hits.length,
    truncated: totalMatches > hits.length,
    hits,
  });
}

export type DocEditedResult = {
  filename: string;
  document_id: string;
  version_id: string;
  version_number: number | null;
  download_url: string;
  annotations: EditAnnotation[];
};

export type TurnEditState = Map<
  string,
  { versionId: string; versionNumber: number; storagePath: string }
>;

export type TurnReadState = Map<
  string,
  {
    docLabel: string;
    filename: string;
    documentId?: string;
    versionId?: string | null;
    versionNumber?: number | null;
    storagePath: string;
  }
>;

export type DocCreatedResult = {
  filename: string;
  download_url: string;
  document_id?: string;
  version_id?: string;
  version_number?: number | null;
};

export type DocReplicatedResult = {
  /** Filename of the source document being copied. */
  filename: string;
  /** How many copies were produced in this single tool call. */
  count: number;
  /** One entry per new copy. */
  copies: {
    new_filename: string;
    document_id: string;
    version_id: string;
  }[];
};
