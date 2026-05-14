/**
 * CLEAN-12 — Wave 0 smoke test: explicit randomUUID import.
 *
 * Verifies that documents.ts and split chat tool modules carry an explicit
 * `import { randomUUID } from "crypto"` so they work in plain Node 18+
 * without relying on Bun's global `crypto`.
 *
 * This test was authored BEFORE the source fix (RED baseline).
 * After Task 2 lands it will be GREEN.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "../../src");

describe("CLEAN-12: explicit randomUUID import", () => {
    it("documents.ts has import { randomUUID } from \"crypto\"", async () => {
        const contents = await readFile(
            path.join(ROOT, "routes/documents.ts"),
            "utf8",
        );
        expect(contents).toContain('import { randomUUID } from "crypto"');
    });

    it("chatTools.ts has import { randomUUID } from \"crypto\"", async () => {
        const contents = await Promise.all([
            readFile(path.join(ROOT, "lib/chatTools/tools/generate-docx.ts"), "utf8"),
            readFile(path.join(ROOT, "lib/chatTools/tools/edit-document.ts"), "utf8"),
        ]);
        for (const content of contents) {
            expect(content).toContain('import { randomUUID } from "crypto"');
        }
    });

    it("neither file references crypto.randomUUID( (must use named import)", async () => {
        const [docsContents, generateDocxContents, editDocumentContents] = await Promise.all([
            readFile(path.join(ROOT, "routes/documents.ts"), "utf8"),
            readFile(path.join(ROOT, "lib/chatTools/tools/generate-docx.ts"), "utf8"),
            readFile(path.join(ROOT, "lib/chatTools/tools/edit-document.ts"), "utf8"),
        ]);
        expect(docsContents).not.toMatch(/crypto\.randomUUID\(/);
        expect(generateDocxContents).not.toMatch(/crypto\.randomUUID\(/);
        expect(editDocumentContents).not.toMatch(/crypto\.randomUUID\(/);
    });
});
