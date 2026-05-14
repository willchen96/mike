/** CLEAN-50 — GET /models returns full model catalog from backend source of truth. */
import { describe, it, expect } from "vitest";
import {
    CLAUDE_MAIN_MODELS,
    GEMINI_MAIN_MODELS,
    CLAUDE_MID_MODELS,
    GEMINI_MID_MODELS,
    CLAUDE_LOW_MODELS,
    GEMINI_LOW_MODELS,
    DEFAULT_MAIN_MODEL,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
} from "../../src/lib/llm/models";

const allMainIds = [...CLAUDE_MAIN_MODELS, ...GEMINI_MAIN_MODELS];
const allMidIds = [...CLAUDE_MID_MODELS, ...GEMINI_MID_MODELS];
const allLowIds = [...CLAUDE_LOW_MODELS, ...GEMINI_LOW_MODELS];

describe("GET /models — models catalog (CLEAN-50)", () => {
    it("main tier contains all 4 IDs", () => {
        expect(allMainIds).toHaveLength(4);
    });

    it("defaults.main is gemini-3-flash-preview", () => {
        expect(DEFAULT_MAIN_MODEL).toBe("gemini-3-flash-preview");
    });

    it("defaults.title is gemini-3.1-flash-lite-preview", () => {
        expect(DEFAULT_TITLE_MODEL).toBe("gemini-3.1-flash-lite-preview");
    });

    it("defaults.tabular is gemini-3-flash-preview", () => {
        expect(DEFAULT_TABULAR_MODEL).toBe("gemini-3-flash-preview");
    });

    it("mid and low tiers are non-empty", () => {
        expect(allMidIds.length).toBeGreaterThan(0);
        expect(allLowIds.length).toBeGreaterThan(0);
    });

    it("all model IDs start with claude or gemini", () => {
        for (const id of [...allMainIds, ...allMidIds, ...allLowIds]) {
            expect(id.startsWith("claude") || id.startsWith("gemini")).toBe(true);
        }
    });
});
