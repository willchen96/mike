/**
 * generate_docx tool runner.
 *
 * Generates a new DOCX from LLM-provided title + sections, uploads it to R2,
 * persists a documents + document_versions row, and returns a result shape
 * including the download URL and DB ids. The `docx` import is lazy so the
 * SDK isn't pulled at process start.
 */

import { randomUUID } from "crypto";
import {
    generatedDocKey,
    uploadFile,
} from "../../storage";
import { createServerSupabase } from "../../supabase";
import { buildDownloadUrl } from "../../downloadTokens";
import { logger } from "../../logger";

export async function runGenerateDocx(args: {
    title: string;
    sections: unknown[];
    userId: string;
    db: ReturnType<typeof createServerSupabase>;
    options?: { landscape?: boolean; projectId?: string | null };
}): Promise<
    | { filename: string; download_url: string; document_id: string; version_id: string; version_number: number; storage_path: string; message: string }
    | { error: string }
> {
    const { title, sections, userId, db, options } = args;
    try {
        const {
            Document, Paragraph, HeadingLevel, Packer,
            Table, TableRow, TableCell, WidthType, BorderStyle,
            TextRun, AlignmentType, PageOrientation, PageBreak,
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
                children: [new TextRun({ text: title.toUpperCase(), color: "000000", font: FONT, size: SIZE, bold: true })],
            }),
        );

        const cellBorder = {
            top:    { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
            left:   { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
            right:  { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
        };

        const headingLevels = [
            HeadingLevel.HEADING_1,
            HeadingLevel.HEADING_2,
            HeadingLevel.HEADING_3,
            HeadingLevel.HEADING_4,
        ];
        const counters = [0, 0, 0, 0];

        for (const section of sections as {
            heading?: string;
            content?: string;
            level?: number;
            pageBreak?: boolean;
            table?: { headers: string[]; rows: string[][] };
        }[]) {
            if (section.pageBreak) {
                children.push(
                    new Paragraph({ children: [new PageBreak()] }),
                );
            }
            if (section.heading) {
                const idx = Math.min((section.level ?? 1) - 1, 3);
                counters[idx]++;
                for (let i = idx + 1; i < 4; i++) counters[i] = 0;
                const prefix = counters.slice(0, idx + 1).join(".");
                const headingText = `${prefix}. ${idx === 0 ? section.heading.toUpperCase() : section.heading}`;
                children.push(
                    new Paragraph({
                        heading: headingLevels[idx],
                        spacing: { after: 160 },
                        children: [new TextRun({ text: headingText, color: "000000", font: FONT, size: SIZE, bold: true })],
                    }),
                );
            }
            if (section.table) {
                const { headers, rows } = section.table;
                const colCount = headers.length;
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
                                            children: [new TextRun({ text: h, bold: true, font: FONT, size: SIZE })],
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
                for (const rawRow of rows) {
                    const row = Array.isArray(rawRow) ? rawRow : [];
                    const normalized: string[] = [];
                    for (let i = 0; i < colCount; i++) {
                        normalized.push(
                            typeof row[i] === "string" ? row[i] : "",
                        );
                    }
                    if (row.length !== colCount) {
                        logger.warn({ rowLength: row.length, colCount }, "[generate_docx] row length != headers; normalized");
                    }
                    tableRows.push(
                        new TableRow({
                            children: normalized.map(
                                (cell) =>
                                    new TableCell({
                                        borders: cellBorder,
                                        children: [
                                            new Paragraph({
                                                children: [new TextRun({ text: cell, font: FONT, size: SIZE })],
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
                for (const line of section.content.split("\n")) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    const bulletMatch = trimmed.match(/^[-•*]\s+(.+)/);
                    if (bulletMatch) {
                        children.push(
                            new Paragraph({
                                bullet: { level: 0 },
                                spacing: { after: 120 },
                                children: [new TextRun({ text: bulletMatch[1], font: FONT, size: SIZE })],
                            }),
                        );
                    } else {
                        children.push(
                            new Paragraph({
                                spacing: { after: 120 },
                                children: [new TextRun({ text: trimmed, font: FONT, size: SIZE })],
                            }),
                        );
                    }
                }
            }
        }

        const pageSetup = options?.landscape
            ? { page: { size: { orientation: PageOrientation.LANDSCAPE } } }
            : {};

        const doc = new Document({ sections: [{ properties: pageSetup, children }] });
        const buf = await Packer.toBuffer(doc);
        const docId = randomUUID().replace(/-/g, "");
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
                filename,
                file_type: "docx",
                size_bytes: buf.byteLength,
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
                display_name: filename,
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
