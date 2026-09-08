import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import JSZip from "jszip";

// The title a user asks for is the only human-readable part of a generated
// document's name, and it travels through three surfaces that have to agree:
// the tool result the model reports, the persisted version row, and the signed
// download token the browser follows. These tests use the real storage-key
// helper and the real token signer, because a mocked key or a mocked download
// URL cannot show whether the title survived either of them.

const uploadFile = vi.fn(async () => {});

vi.mock("../../../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../storage")>()),
  uploadFile: (...a: unknown[]) => uploadFile(...a),
  downloadFile: vi.fn(async () => null),
}));

const docxToPdf = vi.fn(async () => Buffer.from("pdf-bytes"));
vi.mock("../../../convert", () => ({
  docxToPdf: (...a: unknown[]) => docxToPdf(...a),
  convertedPdfKey: (userId: string, docId: string) =>
    `converted-pdfs/${userId}/${docId}.pdf`,
}));

vi.mock("../../../queue/conversionQueue", () => ({
  enqueueConversion: vi.fn(async () => ({})),
}));

vi.mock("../../../supabase", () => ({
  createServerSupabase: vi.fn(),
}));

import { buildContentDisposition } from "../../../storage";
import { verifyDownload } from "../../../downloadTokens";
import {
  generateDocx,
  generateExcel,
  generatePpt,
  safeGeneratedFilename,
} from "../documentOps";

process.env.DOWNLOAD_SIGNING_SECRET = "test-secret-32-bytes-long-enough!!";

afterAll(() => {
  delete process.env.DOWNLOAD_SIGNING_SECRET;
});

type Insert = { table: string; payload: Record<string, unknown> };

// Chainable Supabase double: records inserts, returns fixed ids.
function makeDb() {
  const inserts: Insert[] = [];
  function from(table: string) {
    const b: Record<string, unknown> = {
      insert(payload: Record<string, unknown>) {
        inserts.push({ table, payload });
        return b;
      },
      update: () => b,
      select: () => b,
      eq: () => b,
      single: () =>
        Promise.resolve({
          data: { id: table === "documents" ? "doc-db-1" : "ver-db-1" },
          error: null,
        }),
      then: (onF: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(onF),
    };
    return b;
  }
  return { inserts, from };
}

const SECTIONS = [{ heading: "Clause 1", content: "Body." }];
const SHEETS = [{ name: "Sheet1", columns: ["Value"], rows: [["a"]] }];
const SLIDES = [{ title: "One", bullets: ["a"] }];

const JAPANESE_TITLE = "秘密保持契約書";

type Generated = {
  filename: string;
  download_url: string;
};

async function generate(extension: "docx" | "xlsx" | "pptx", title: string) {
  const db = makeDb();
  const result =
    extension === "docx"
      ? await generateDocx(title, SECTIONS, "user-1", db as never)
      : extension === "xlsx"
        ? await generateExcel(title, SHEETS, "user-1", db as never)
        : await generatePpt(title, SLIDES, "user-1", db as never);

  expect(result).not.toHaveProperty("error");
  const generated = result as Generated;
  const version = db.inserts.find((i) => i.table === "document_versions");
  const upload = uploadFile.mock.calls.find(
    (call) => typeof call[0] === "string" && call[0].endsWith(`.${extension}`),
  ) as unknown as [string, ArrayBuffer, string] | undefined;
  expect(upload).toBeDefined();

  return {
    filename: generated.filename,
    versionFilename: version?.payload.filename,
    versionStoragePath: version?.payload.storage_path,
    uploadedKey: upload![0],
    uploadedBytes: upload![1],
    tokenFilename: verifyDownload(
      generated.download_url.replace("/download/", ""),
    )?.filename,
  };
}

beforeEach(() => {
  uploadFile.mockClear();
  docxToPdf.mockClear();
});

describe("safeGeneratedFilename", () => {
  it.each([
    ["秘密保持契約書", "秘密保持契約書.docx"],
    ["資料使用協議", "資料使用協議.docx"],
    ["비밀유지계약서", "비밀유지계약서.docx"],
    ["Договор", "Договор.docx"],
    ["Σύμβαση", "Σύμβαση.docx"],
    ["عقد", "عقد.docx"],
    ["अनुबंध", "अनुबंध.docx"],
    ["Résumé", "Résumé.docx"],
    // Decomposed input composes to the same name as the precomposed one.
    ["Re\u0301sume\u0301", "Résumé.docx"],
    // Compatibility characters are kept as themselves rather than folded to
    // ASCII: the normalization is NFC, not NFKC.
    ["①", "①.docx"],
    ["１２３", "１２３.docx"],
  ])("keeps the letters and numbers of %s", (title, expected) => {
    expect(safeGeneratedFilename(title, "docx")).toBe(expected);
  });

  it.each([
    ["NDA 2026 - Draft", "NDA 2026 - Draft.docx"],
    ["---", "---.docx"],
    ["", "document.docx"],
    ['.../\\:*?"<>|', "document.docx"],
  ])("leaves the existing behaviour for %s unchanged", (title, expected) => {
    expect(safeGeneratedFilename(title, "docx")).toBe(expected);
  });

  it("drops separators, controls and other non-name characters", () => {
    // Slash, backslash, CR, LF, non-breaking space, minus sign, zero-width
    // joiner, right-to-left override.
    const title = "a/b\\c\r\nd\u00a0e\u2212f\u200dg\u202eh";
    expect(safeGeneratedFilename(title, "docx")).toBe("abcdefgh.docx");
  });

  it("uses the caller's extension, never one implied by the title", () => {
    expect(safeGeneratedFilename("report.exe", "docx")).toBe("reportexe.docx");
  });

  it("falls back when nothing readable survives", () => {
    // Combining marks with no base letter are not a name anyone can read.
    expect(safeGeneratedFilename("\u0301\u0301", "docx")).toBe("document.docx");
    expect(safeGeneratedFilename("   ", "docx")).toBe("document.docx");
    expect(safeGeneratedFilename(undefined as never, "docx")).toBe(
      "document.docx",
    );
  });

  it("bounds the stem on whole characters", () => {
    expect(safeGeneratedFilename("a".repeat(70), "docx")).toBe(
      `${"a".repeat(64)}.docx`,
    );

    // A supplementary-plane letter costs two UTF-16 units, so it does not fit
    // after 63 of them. Splitting it would leave an unpaired surrogate that
    // the download header's percent-encoding cannot represent.
    const straddling = safeGeneratedFilename(
      `${"a".repeat(63)}\u{20000}`,
      "docx",
    );
    expect(straddling).toBe(`${"a".repeat(63)}.docx`);
    expect(() => encodeURIComponent(straddling)).not.toThrow();

    // Combining marks belong to the letter they sit on.
    expect(
      safeGeneratedFilename(`${"a".repeat(63)}e\u0301\u0302`, "docx"),
    ).toBe(`${"a".repeat(63)}.docx`);

    // A single character longer than the whole budget leaves nothing. The
    // first mark composes onto the "a", so this is 70 UTF-16 units in one
    // cluster.
    expect(safeGeneratedFilename(`a${"\u0301".repeat(70)}`, "docx")).toBe(
      "document.docx",
    );
  });
});

describe("generated document naming", () => {
  it.each(["docx", "xlsx", "pptx"] as const)(
    "%s: one Unicode name reaches the result, the version row and the download token",
    async (extension) => {
      const out = await generate(extension, JAPANESE_TITLE);
      const expected = `${JAPANESE_TITLE}.${extension}`;

      expect(out.filename).toBe(expected);
      expect(out.versionFilename).toBe(expected);
      expect(out.tokenFilename).toBe(expected);
      expect(out.versionStoragePath).toBe(out.uploadedKey);
    },
  );

  it("does not put the title in the storage key", async () => {
    const ascii = await generate("docx", "Mutual NDA");
    const japanese = await generate("docx", JAPANESE_TITLE);
    const withoutDocId = (key: string) =>
      key.replace(/^generated\/user-1\/[0-9a-f]+\//, "generated/user-1/*/");

    expect(withoutDocId(ascii.uploadedKey)).toBe(
      "generated/user-1/*/generated.docx",
    );
    expect(withoutDocId(japanese.uploadedKey)).toBe(
      withoutDocId(ascii.uploadedKey),
    );
  });

  it("serves the Unicode name in the download header with an ASCII fallback", async () => {
    const out = await generate("docx", JAPANESE_TITLE);
    const header = buildContentDisposition("attachment", out.filename);

    const extended = header.match(/filename\*=UTF-8''([^;]+)$/);
    expect(extended).not.toBeNull();
    expect(decodeURIComponent(extended![1])).toBe(`${JAPANESE_TITLE}.docx`);

    const ascii = header.match(/filename="([^"]+)"/);
    expect(ascii).not.toBeNull();
    expect(ascii![1]).toMatch(/^[\x20-\x7e]+\.docx$/);
  });

  it.each(["docx", "xlsx", "pptx"] as const)(
    "%s: a Unicode name still produces a valid package",
    async (extension) => {
      const out = await generate(extension, JAPANESE_TITLE);
      const archive = await JSZip.loadAsync(out.uploadedBytes);
      expect(archive.file("[Content_Types].xml")).not.toBeNull();
    },
  );
});
