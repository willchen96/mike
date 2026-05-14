/**
 * Phase 7 (CLEAN-31 / CLEAN-36) — DOCX fixture generator.
 *
 * Idempotent: if a fixture file already exists, the generator skips it.
 * Run with: cd backend && npx tsx tests/docx-round-trip/fixtures/generate-fixtures.ts
 *
 * Synthetic content only — no PII, no real legal text.
 */
import {
    Document,
    Paragraph,
    TextRun,
    HeadingLevel,
    Packer,
    Table,
    TableRow,
    TableCell,
    WidthType,
} from "docx";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

const FIXTURE_DIR = __dirname;

const REGEN = process.env.HUGO_FIXTURES_REGEN === "1";

// ---------------------------------------------------------------------------
// Minimal DOCX ZIP skeleton for hand-crafted XML fixtures (Task 2)
// ---------------------------------------------------------------------------

const MINIMAL_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const MINIMAL_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const MINIMAL_DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

async function writeDocxFixture(name: string, doc: Document): Promise<void> {
    const outPath = path.join(FIXTURE_DIR, `${name}.docx`);
    if (existsSync(outPath) && !REGEN) {
        console.log(`[generate-fixtures] skip (exists): ${name}.docx`);
        return;
    }
    const buffer = await Packer.toBuffer(doc);
    writeFileSync(outPath, buffer);
    console.log(`[generate-fixtures] ${REGEN ? "regenerate (HUGO_FIXTURES_REGEN=1)" : "wrote"}: ${name}.docx`);
}

const xmlValidationParser = new XMLParser();

async function writeXmlFixture(name: string, docXml: string, useBackslashPaths = false): Promise<void> {
    const outPath = path.join(FIXTURE_DIR, `${name}.docx`);
    if (existsSync(outPath) && !REGEN) {
        console.log(`[generate-fixtures] skip (exists): ${name}.docx`);
        return;
    }
    // Validate XML before writing to catch syntax errors in hand-crafted strings early.
    try {
        xmlValidationParser.parse(docXml);
    } catch (e) {
        throw new Error(`[generate-fixtures] invalid XML in "${name}": ${e}`);
    }
    const zip = new JSZip();
    const docPath = useBackslashPaths ? "word\\document.xml" : "word/document.xml";
    const ctPath = "[Content_Types].xml";
    const relsPath = useBackslashPaths ? "_rels\\.rels" : "_rels/.rels";
    const docRelsPath = useBackslashPaths ? "word\\_rels\\document.xml.rels" : "word/_rels/document.xml.rels";
    zip.file(docPath, docXml);
    zip.file(ctPath, MINIMAL_CONTENT_TYPES);
    zip.file(relsPath, MINIMAL_RELS);
    zip.file(docRelsPath, MINIMAL_DOC_RELS);
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    writeFileSync(outPath, buffer);
    console.log(`[generate-fixtures] ${REGEN ? "regenerate (HUGO_FIXTURES_REGEN=1)" : "wrote"}: ${name}.docx (handcrafted${useBackslashPaths ? ", backslash paths" : ""})`);
}

// ---------------------------------------------------------------------------
// Wave 1 generators (07-01 seed fixtures)
// ---------------------------------------------------------------------------

async function generate01SimpleInsert(): Promise<void> {
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Paragraph({
                    children: [new TextRun({ text: "The quick brown fox jumps over the lazy dog." })],
                }),
            ],
        }],
    });
    await writeDocxFixture("01-simple-insert", doc);
}

async function generate02SimpleDelete(): Promise<void> {
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Paragraph({
                    children: [new TextRun({ text: "Please remove the bracketed phrase from this sentence." })],
                }),
            ],
        }],
    });
    await writeDocxFixture("02-simple-delete", doc);
}

async function generate04TableCell(): Promise<void> {
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Table({
                    width: { size: 100, type: WidthType.PERCENTAGE },
                    rows: [
                        new TableRow({
                            children: [
                                new TableCell({
                                    children: [new Paragraph({ children: [new TextRun({ text: "Header A" })] })],
                                }),
                                new TableCell({
                                    children: [new Paragraph({ children: [new TextRun({ text: "Header B" })] })],
                                }),
                            ],
                        }),
                        new TableRow({
                            children: [
                                new TableCell({
                                    children: [new Paragraph({ children: [new TextRun({ text: "The quick brown fox jumps over the lazy dog." })] })],
                                }),
                                new TableCell({
                                    children: [new Paragraph({ children: [new TextRun({ text: "Cell two contents." })] })],
                                }),
                            ],
                        }),
                    ],
                }),
            ],
        }],
    });
    await writeDocxFixture("04-table-cell", doc);
}

async function generate05BulletList(): Promise<void> {
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: "First bullet item content." })] }),
                new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: "The quick brown fox jumps over the lazy dog." })] }),
                new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: "Third bullet item content." })] }),
            ],
        }],
    });
    await writeDocxFixture("05-bullet-list", doc);
}

async function generate06Heading(): Promise<void> {
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Paragraph({
                    heading: HeadingLevel.HEADING_1,
                    children: [new TextRun({ text: "The quick brown fox jumps over the lazy dog." })],
                }),
                new Paragraph({
                    children: [new TextRun({ text: "Body paragraph after the heading." })],
                }),
            ],
        }],
    });
    await writeDocxFixture("06-heading", doc);
}

// ---------------------------------------------------------------------------
// Wave 2 Task 1 generators — standard docx-library fixtures (11 new)
// ---------------------------------------------------------------------------

async function generate03Replace(): Promise<void> {
    // Single paragraph. Test will replace "fast brown fox" → "agile red wolf".
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Paragraph({
                    children: [new TextRun({ text: "The fast brown fox runs quickly across the green field." })],
                }),
            ],
        }],
    });
    await writeDocxFixture("03-replace", doc);
}

async function generate07MultiParagraph(): Promise<void> {
    // Two paragraphs. Test will edit both in a single applyTrackedEdits call.
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Paragraph({
                    children: [new TextRun({ text: "Paragraph one contains the quick brown fox." })],
                }),
                new Paragraph({
                    children: [new TextRun({ text: "Paragraph two contains the lazy dog." })],
                }),
            ],
        }],
    });
    await writeDocxFixture("07-multi-paragraph", doc);
}

async function generate11MixedRanges(): Promise<void> {
    // Single paragraph long enough that docx splits across multiple w:r runs.
    // A bold TextRun inserted mid-phrase forces a run boundary inside the target word.
    // Layout: "The quick " + bold("brown") + " fox jumps."
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Paragraph({
                    children: [
                        new TextRun({ text: "The quick " }),
                        new TextRun({ text: "brown", bold: true }),
                        new TextRun({ text: " fox jumps." }),
                    ],
                }),
            ],
        }],
    });
    await writeDocxFixture("11-mixed-ranges", doc);
}

async function generate12UnicodeText(): Promise<void> {
    // Dutch sample with Unicode characters (ë, ï, ö, ij).
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Paragraph({
                    children: [new TextRun({ text: "De vlijtige ijsbeer zwemt naar de overkant; coördinatie is moeilijk." })],
                }),
            ],
        }],
    });
    await writeDocxFixture("12-unicode-text", doc);
}

async function generate13SmartQuotes(): Promise<void> {
    // Use Unicode smart quotes (U+201C / U+201D) in the document text.
    // Tests will stress the normalization layer by using straight quotes in `find`.
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Paragraph({
                    children: [new TextRun({ text: "He said “Hello world” and left." })],
                }),
            ],
        }],
    });
    await writeDocxFixture("13-smart-quotes", doc);
}

async function generate14NonbreakingSpace(): Promise<void> {
    // Phrase with NBSP (U+00A0) between "section" and "4.2".
    // Tests can try to match with a regular space in `find`.
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Paragraph({
                    children: [new TextRun({ text: "section 4.2 governs the applicable rules." })],
                }),
            ],
        }],
    });
    await writeDocxFixture("14-nonbreaking-space", doc);
}

async function generate15CrossRunWord(): Promise<void> {
    // Force a single "word" across two TextRuns by inserting a formatting boundary
    // mid-word: TextRun("bro") + TextRun("wn", bold) in the same paragraph.
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Paragraph({
                    children: [
                        new TextRun({ text: "The quick " }),
                        new TextRun({ text: "bro" }),
                        new TextRun({ text: "wn", bold: true }),
                        new TextRun({ text: " fox jumps over the lazy dog." }),
                    ],
                }),
            ],
        }],
    });
    await writeDocxFixture("15-cross-run-word", doc);
}

async function generate16MultiEditSamePara(): Promise<void> {
    // Single paragraph with two non-overlapping target phrases.
    // Test will edit "quick" and "lazy" in one applyTrackedEdits call.
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Paragraph({
                    children: [new TextRun({ text: "The quick brown fox jumps over the lazy dog by the river." })],
                }),
            ],
        }],
    });
    await writeDocxFixture("16-multi-edit-same-para", doc);
}

async function generate17OverlappingEditError(): Promise<void> {
    // Same content as fixture 16 — but the test will pass two OVERLAPPING edits
    // and assert errors[last].reason matches /overlap/i.
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Paragraph({
                    children: [new TextRun({ text: "The quick brown fox jumps over the lazy dog by the river." })],
                }),
            ],
        }],
    });
    await writeDocxFixture("17-overlapping-edit-error", doc);
}

async function generate18PureInsertion(): Promise<void> {
    // Paragraph for a test using find="" with context_before/context_after
    // to insert "fast " between "quick " and "brown".
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Paragraph({
                    children: [new TextRun({ text: "The quick brown fox jumps." })],
                }),
            ],
        }],
    });
    await writeDocxFixture("18-pure-insertion", doc);
}

async function generate19PureDeletion(): Promise<void> {
    // Paragraph for a test using replace="" to delete "(parenthetical aside) ".
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Paragraph({
                    children: [new TextRun({ text: "The quick (parenthetical aside) brown fox jumps." })],
                }),
            ],
        }],
    });
    await writeDocxFixture("19-pure-deletion", doc);
}

// ---------------------------------------------------------------------------
// Wave 2 Task 2 generators — hand-crafted XML fixtures (4 new)
// ---------------------------------------------------------------------------

async function generate08NestedSdt(): Promise<void> {
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:sdt>
      <w:sdtContent>
        <w:p>
          <w:r><w:t xml:space="preserve">The quick brown fox inside a structured document tag.</w:t></w:r>
        </w:p>
      </w:sdtContent>
    </w:sdt>
  </w:body>
</w:document>`;
    await writeXmlFixture("08-nested-sdt", docXml);
}

async function generate09PreexistingIns(): Promise<void> {
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:t xml:space="preserve">before </w:t></w:r>
      <w:ins w:id="1" w:author="OtherAuthor" w:date="2025-01-01T00:00:00Z">
        <w:r><w:t xml:space="preserve">inserted </w:t></w:r>
      </w:ins>
      <w:r><w:t xml:space="preserve">after</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`;
    await writeXmlFixture("09-preexisting-ins", docXml);
}

async function generate10PreexistingDel(): Promise<void> {
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:t xml:space="preserve">before </w:t></w:r>
      <w:del w:id="2" w:author="OtherAuthor" w:date="2025-01-01T00:00:00Z">
        <w:r><w:delText xml:space="preserve">removed </w:delText></w:r>
      </w:del>
      <w:r><w:t xml:space="preserve">after</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`;
    await writeXmlFixture("10-preexisting-del", docXml);
}

async function generate20WindowsBackslashPaths(): Promise<void> {
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t xml:space="preserve">The quick brown fox jumps over the lazy dog.</w:t></w:r></w:p>
  </w:body>
</w:document>`;
    await writeXmlFixture("20-windows-backslash-paths", docXml, /* useBackslashPaths */ true);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    // Wave 1 seed fixtures
    await generate01SimpleInsert();
    await generate02SimpleDelete();
    await generate03Replace();
    await generate04TableCell();
    await generate05BulletList();
    await generate06Heading();
    await generate07MultiParagraph();
    // Wave 2 Task 2 hand-crafted XML fixtures
    await generate08NestedSdt();
    await generate09PreexistingIns();
    await generate10PreexistingDel();
    // Wave 2 Task 1 standard docx-library fixtures
    await generate11MixedRanges();
    await generate12UnicodeText();
    await generate13SmartQuotes();
    await generate14NonbreakingSpace();
    await generate15CrossRunWord();
    await generate16MultiEditSamePara();
    await generate17OverlappingEditError();
    await generate18PureInsertion();
    await generate19PureDeletion();
    // Wave 2 Task 2 — backslash path fixture
    await generate20WindowsBackslashPaths();
    console.log("[generate-fixtures] done");
}

main().catch((err) => {
    console.error("[generate-fixtures] failed:", err);
    process.exit(1);
});
