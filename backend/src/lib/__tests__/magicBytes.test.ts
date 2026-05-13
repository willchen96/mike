import { describe, it, expect } from "vitest";
import { validateMagicBytes } from "../magicBytes.js";

describe("validateMagicBytes", () => {
    it("accepts a valid PDF buffer", () => {
        const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // %PDF-1
        expect(validateMagicBytes(buf, "pdf")).toBe(true);
    });

    it("accepts a valid DOCX (ZIP) buffer", () => {
        const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
        expect(validateMagicBytes(buf, "docx")).toBe(true);
    });

    it("accepts a valid DOC (OLE2) buffer", () => {
        const buf = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x00]);
        expect(validateMagicBytes(buf, "doc")).toBe(true);
    });

    it("rejects HTML disguised as PDF", () => {
        const buf = Buffer.from("<html><script>alert(1)</script></html>");
        expect(validateMagicBytes(buf, "pdf")).toBe(false);
    });

    it("rejects empty buffer", () => {
        expect(validateMagicBytes(Buffer.alloc(0), "pdf")).toBe(false);
    });

    it("rejects buffer shorter than magic bytes", () => {
        expect(validateMagicBytes(Buffer.from([0x25, 0x50]), "pdf")).toBe(false);
    });

    it("returns false for unknown extension", () => {
        const buf = Buffer.from([0x25, 0x50, 0x44, 0x46]);
        expect(validateMagicBytes(buf, "xyz")).toBe(false);
    });
});
