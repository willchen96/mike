import { describe, expect, it, vi } from "vitest";

type FakeItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
};

// Positioned pdfjs text items: transform [a, b, c, d, x, y], y grows upward.
function item(str: string, x: number, y: number, hasEOL = false): FakeItem {
  return {
    str,
    transform: [1, 0, 0, 12, x, y],
    width: str.length * 6,
    height: 12,
    hasEOL,
  };
}

function fakePdf(pages: FakeItem[][]) {
  return {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: (n: number) =>
          Promise.resolve({
            getTextContent: () => Promise.resolve({ items: pages[n - 1] }),
          }),
      }),
    }),
  };
}

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: (opts: unknown) =>
    (globalThis as { __fakePdf?: ReturnType<typeof fakePdf> }).__fakePdf!.getDocument(),
}));

import { extractPdfText } from "./documentOps";

function withPdf(pages: FakeItem[][]) {
  (globalThis as { __fakePdf?: ReturnType<typeof fakePdf> }).__fakePdf =
    fakePdf(pages);
}

describe("extractPdfText layout reconstruction", () => {
  it("rebuilds lines from positions instead of joining every item", async () => {
    // Two lines on page 1: a title and an indented body line that pdfjs split
    // into kerning fragments with no real word gap between them.
    withPdf([
      [
        item("MASTER TERMS", 72, 700, true),
        item("1.1", 108, 686),
        item("Affiliate", 132, 686),
        item(" means", 186, 686),
        item(" any entity", 222, 686, true),
      ],
    ]);

    const text = await extractPdfText(new ArrayBuffer(8));
    expect(text).toBe(
      "[Page 1]\nMASTER TERMS\n      1.1 Affiliate means any entity",
    );
  });

  it("inserts a blank line for paragraph-scale vertical gaps", async () => {
    withPdf([
      [item("First paragraph.", 72, 700, true), item("Second paragraph.", 72, 640, true)],
    ]);

    const text = await extractPdfText(new ArrayBuffer(8));
    expect(text).toContain("First paragraph.\n\nSecond paragraph.");
  });

  it("preserves obvious column gaps (signature blocks)", async () => {
    // Wide x-gap between two items on the same visual line.
    withPdf([
      [item("CLIENT", 72, 700), item("SAAS PROVIDER", 400, 700, true)],
    ]);

    const text = await extractPdfText(new ArrayBuffer(8));
    expect(text).toMatch(/CLIENT\s{4,}SAAS PROVIDER/);
  });

  it("keeps page markers and orders pages", async () => {
    withPdf([[item("page one", 72, 700, true)], [item("page two", 72, 700, true)]]);

    const text = await extractPdfText(new ArrayBuffer(8));
    expect(text).toBe("[Page 1]\npage one\n\n[Page 2]\npage two");
  });

  it("returns an empty string when pdfjs cannot read the buffer", async () => {
    (globalThis as { __fakePdf?: unknown }).__fakePdf = {
      getDocument: () => ({ promise: Promise.reject(new Error("bad pdf")) }),
    };

    await expect(extractPdfText(new ArrayBuffer(8))).resolves.toBe("");
  });
});
