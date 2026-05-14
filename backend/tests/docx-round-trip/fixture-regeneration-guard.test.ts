/**
 * Phase 7 (CLEAN-31) — Fixture regeneration guard.
 *
 * Asserts that every committed `.docx` fixture under fixtures/ is:
 *   (a) non-empty
 *   (b) parseable by extractDocxBodyText (returns a non-empty string)
 *   (c) deterministic in extraction — two consecutive extractions match
 *
 * Catches: silent fixture rot (file replaced with corrupted bytes) and
 * non-determinism in extractDocxBodyText. The CI workflow additionally
 * runs `git diff --exit-code` after the generator to detect drift in the
 * committed bytes themselves.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { extractDocxBodyText } from "../../src/lib/docxTrackedChanges";

const fixtureDir = path.join(__dirname, "fixtures");

function listFixtureNames(): string[] {
    return readdirSync(fixtureDir)
        .filter((f) => f.endsWith(".docx"))
        .sort();
}

describe("fixture regeneration guard", () => {
    it("exactly 20 .docx fixtures are committed", () => {
        const names = listFixtureNames();
        // Exact count — if you add a fixture, increment this and add a FIXTURES entry in round-trip.test.ts.
        expect(names.length).toBe(20);
    });

    it.each(listFixtureNames())("%s: non-empty + parseable + deterministic", async (name) => {
        const fpath = path.join(fixtureDir, name);
        const stat = statSync(fpath);
        expect(stat.size).toBeGreaterThan(0);

        const bytes = readFileSync(fpath);
        const text1 = await extractDocxBodyText(bytes);
        expect(typeof text1).toBe("string");
        expect(text1.length).toBeGreaterThan(0);

        const text2 = await extractDocxBodyText(bytes);
        expect(text2).toBe(text1);
    });
});
