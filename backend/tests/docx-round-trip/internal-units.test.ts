/**
 * Phase 7 (CLEAN-36) — _internal unit tests for docxTrackedChanges.
 *
 * Pure functions; no fixtures, no mocks.
 */
import { describe, it, expect } from "vitest";
import { _internal } from "../../src/lib/docxTrackedChanges";

const { flattenParagraph, collapseDiff, indexAll } = _internal;

describe("_internal.indexAll", () => {
    it("finds all non-overlapping occurrences", () => {
        expect(indexAll("abc abc abc", "abc")).toEqual([0, 4, 8]);
    });
    it("returns empty array when needle is not found", () => {
        expect(indexAll("hello world", "xyz")).toEqual([]);
    });
    it("handles single occurrence", () => {
        expect(indexAll("hello world", "world")).toEqual([6]);
    });
    it("returns empty array when needle is empty string", () => {
        expect(indexAll("hello world", "")).toEqual([]);
    });
});

describe("_internal.collapseDiff", () => {
    it("returns deleted and inserted spans for a substitution", () => {
        // Actual signature: { deleted, inserted, leadingEq, trailingEq }
        const result = collapseDiff("old text", "new text");
        expect(result.deleted).toBe("old");
        expect(result.inserted).toBe("new");
        // " text" (5 chars) is the common suffix — leadingEq must be 0, trailingEq must be 5.
        expect(result.leadingEq).toBe(0);
        expect(result.trailingEq).toBe(5);
    });
    it("returns only inserted span for a pure insertion", () => {
        const result = collapseDiff("", "added");
        expect(result.deleted).toBe("");
        expect(result.inserted).toBe("added");
    });
    it("returns only deleted span for a pure deletion", () => {
        const result = collapseDiff("removed", "");
        expect(result.deleted).toBe("removed");
        expect(result.inserted).toBe("");
    });
    it("returns empty spans for identical input", () => {
        const result = collapseDiff("same", "same");
        expect(result.deleted).toBe("");
        expect(result.inserted).toBe("");
    });
});

describe("_internal.flattenParagraph", () => {
    it("is exported and callable", () => {
        expect(typeof flattenParagraph).toBe("function");
    });

    it("returns an object with paraText for an empty children array", () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = flattenParagraph([] as any);
        expect(result.paraText).toBe("");
        expect(result.runs).toHaveLength(0);
        expect(result.charRun.length).toBe(0);
    });

    // flattenParagraph takes XNode[] (paragraph children in fast-xml-parser
    // preserveOrder: true format). Each element is a Record<string, unknown>
    // where the key is the element name (e.g. "w:r") and the value is an
    // array of children. Attributes live under the ":@" key.
    //
    // A minimal w:r node: { "w:r": [ { "w:t": [ { "#text": "hello" } ] } ] }
    //
    // flattenParagraph collects text from w:t nodes inside w:r and w:ins
    // wrappers, building a flat paraText string and per-char mappings.

    it("returns paraText joining text from a single w:r > w:t child", () => {
        const textNode = { "#text": "hello world" };
        const wtEl = { "w:t": [textNode] };
        const wrEl = { "w:r": [wtEl] };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = flattenParagraph([wrEl] as any);
        expect(result.paraText).toBe("hello world");
    });

    it("concatenates text across multiple w:r children in order", () => {
        const mkRun = (text: string) => ({
            "w:r": [{ "w:t": [{ "#text": text }] }],
        });
        const para = [mkRun("foo"), mkRun("bar"), mkRun("baz")];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = flattenParagraph(para as any);
        expect(result.paraText).toBe("foobarbaz");
    });

    it("includes text inside w:ins (accepted-view semantics)", () => {
        const wrEl = { "w:r": [{ "w:t": [{ "#text": "inserted" }] }] };
        const winsEl = { "w:ins": [wrEl] };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = flattenParagraph([winsEl] as any);
        expect(result.paraText).toBe("inserted");
    });

    it("skips text inside w:del (accepted-view semantics)", () => {
        const wdelEl = {
            "w:del": [{ "w:r": [{ "w:delText": [{ "#text": "deleted" }] }] }],
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = flattenParagraph([wdelEl] as any);
        expect(result.paraText).toBe("");
    });

    it("runs array length equals number of w:r elements encountered", () => {
        const mkRun = (text: string) => ({
            "w:r": [{ "w:t": [{ "#text": text }] }],
        });
        const para = [mkRun("a"), mkRun("b"), mkRun("c")];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = flattenParagraph(para as any);
        expect(result.runs).toHaveLength(3);
    });

    it("charRun array length equals paraText length", () => {
        const mkRun = (text: string) => ({
            "w:r": [{ "w:t": [{ "#text": text }] }],
        });
        const para = [mkRun("hello"), mkRun(" "), mkRun("world")];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = flattenParagraph(para as any);
        expect(result.paraText).toBe("hello world");
        expect(result.charRun.length).toBe(result.paraText.length);
    });
});
