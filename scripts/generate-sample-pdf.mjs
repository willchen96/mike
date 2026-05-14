// Generates e2e/fixtures/sample.pdf — a small multi-page PDF used by the e2e
// suite as test content for upload, chat, and tabular review scenarios.
//
// The text is original prose written for this repository and is therefore
// safe to commit and redistribute under the same license as the project.
// Re-run with:   npm run fixtures:generate

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "e2e", "fixtures", "sample.pdf");

const PAGES = [
  {
    title: "Sample Document for End-to-End Tests",
    body: [
      "This document exists for the sole purpose of exercising the upload,",
      "extraction, and question-answering paths of the application during",
      "automated end-to-end tests. The content is intentionally plain and",
      "uncontroversial: no proprietary, copyrighted, or sensitive material",
      "appears anywhere in these pages.",
      "",
      "The document is split across four short pages. Each page covers one",
      "small topic so that downstream tests can verify both citation",
      "behaviour (a chat answer should reference a specific page) and",
      "extraction behaviour (a tabular review should be able to pull",
      "distinct facts from distinct pages).",
    ],
  },
  {
    title: "Page Two — Geography of Test Data",
    body: [
      "When test fixtures are designed well, they are boring on purpose.",
      "A predictable fixture lets a failing assertion point at a real bug",
      "rather than at a quirk in the input. This page contains exactly",
      "one concrete fact that downstream tests may rely on: the document",
      "is four pages long.",
      "",
      "Four pages is enough to demonstrate multi-page citation rendering",
      "without bloating the repository or slowing down CI. A reader who",
      "wanted a count of pages would simply count: one, two, three, four.",
    ],
  },
  {
    title: "Page Three — Topics Covered",
    body: [
      "Topic one. The first topic of this document is the purpose of",
      "end-to-end tests, which is to verify that a user-visible workflow",
      "behaves as expected when the system is assembled from real parts.",
      "",
      "Topic two. The second topic is the difference between unit tests,",
      "integration tests, and end-to-end tests. Unit tests isolate a",
      "single function. Integration tests cover a small group of modules",
      "working together. End-to-end tests drive the whole system through",
      "its outermost interface, which for this product is a web browser.",
      "",
      "Topic three. The third topic is fixtures: small, deterministic",
      "inputs that make tests reproducible from one run to the next.",
    ],
  },
  {
    title: "Page Four — Closing Notes",
    body: [
      "This is the final page of the sample document. If a tabular",
      "review asks for the number of pages in this document, the",
      "correct answer is four.",
      "",
      "If a chat asks what this document is about, a reasonable answer",
      "names end-to-end testing, fixtures, or both, and cites the page",
      "from which that information was drawn.",
      "",
      "Thank you for reading the test fixture all the way to the end.",
    ],
  },
];

const doc = await PDFDocument.create();
doc.setTitle("Sample Document for End-to-End Tests");
doc.setAuthor("GordonOSS test suite");
doc.setSubject("End-to-end test fixture");
doc.setCreator("scripts/generate-sample-pdf.mjs");

const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 72;
const LINE_H = 16;
const TITLE_SIZE = 18;
const BODY_SIZE = 12;

for (const [idx, { title, body }] of PAGES.entries()) {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  page.drawText(title, {
    x: MARGIN,
    y,
    size: TITLE_SIZE,
    font: bold,
    color: rgb(0, 0, 0),
  });
  y -= TITLE_SIZE + 12;

  for (const line of body) {
    page.drawText(line, {
      x: MARGIN,
      y,
      size: BODY_SIZE,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
    y -= LINE_H;
  }

  // Page number footer
  page.drawText(`Page ${idx + 1} of ${PAGES.length}`, {
    x: MARGIN,
    y: MARGIN / 2,
    size: 9,
    font,
    color: rgb(0.5, 0.5, 0.5),
  });
}

const bytes = await doc.save();
await writeFile(OUT, bytes);
console.log(`Wrote ${OUT} (${bytes.byteLength} bytes, ${PAGES.length} pages)`);
