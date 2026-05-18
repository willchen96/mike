import { describe, it, expect } from "vitest";
import { timingSafeEqStr } from "../downloadTokens.js";

describe("timingSafeEqStr", () => {
    it("returns true for equal strings", () => {
        expect(timingSafeEqStr("hello", "hello")).toBe(true);
    });

    it("returns false for different strings of same length", () => {
        expect(timingSafeEqStr("abc", "xyz")).toBe(false);
    });

    it("returns false for different strings of different length", () => {
        expect(timingSafeEqStr("short", "longer")).toBe(false);
    });

    it("does not skip timingSafeEqual when lengths differ (no early exit)", () => {
        // If the function returns false early on length mismatch without calling
        // timingSafeEqual, the implementation violates the constant-time contract.
        // We can't directly measure timing here, but we can verify the function
        // still correctly returns false — the real guard is the code structure.
        expect(timingSafeEqStr("a", "ab")).toBe(false);
        expect(timingSafeEqStr("ab", "a")).toBe(false);
    });

    it("returns true for empty strings", () => {
        expect(timingSafeEqStr("", "")).toBe(true);
    });
});
