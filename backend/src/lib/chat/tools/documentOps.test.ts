import { describe, expect, it, vi } from "vitest";

const getPageMock = vi.fn();

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: getPageMock,
    }),
  }),
}));

import { extractPdfText } from "./documentOps";

describe("extractPdfText", () => {
  it("includes filled AcroForm field values alongside page text", async () => {
    getPageMock.mockResolvedValue({
      getTextContent: () =>
        Promise.resolve({ items: [{ str: "Case No.:" }] }),
      getAnnotations: () =>
        Promise.resolve([
          { fieldName: "CaseNumber", fieldValue: "24CV-1234" },
          { fieldName: "EmptyField", fieldValue: "" },
          { fieldName: undefined, fieldValue: "ignored" },
        ]),
    });

    const text = await extractPdfText(new ArrayBuffer(0));

    expect(text).toContain("Case No.:");
    expect(text).toContain("[Page 1 form fields]");
    expect(text).toContain("CaseNumber: 24CV-1234");
    expect(text).not.toContain("EmptyField");
  });

  it("keeps page text when reading annotations fails", async () => {
    getPageMock.mockResolvedValue({
      getTextContent: () =>
        Promise.resolve({ items: [{ str: "Visible text" }] }),
      getAnnotations: () => Promise.reject(new Error("boom")),
    });

    const text = await extractPdfText(new ArrayBuffer(0));

    expect(text).toContain("Visible text");
    expect(text).not.toContain("form fields");
  });
});
