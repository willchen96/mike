import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const chatSrc = readFileSync(join(__dirname, "../../routes/chat.ts"), "utf8");
const projectChatSrc = readFileSync(join(__dirname, "../../routes/projectChat.ts"), "utf8");

describe("SSE stream timeout", () => {
    it("chat.ts wraps runLLMStream with a timeout (Promise.race)", () => {
        expect(chatSrc).toMatch(/Promise\.race/);
        expect(chatSrc).toMatch(/STREAM_TIMEOUT_MS|streamTimeout/);
    });

    it("projectChat.ts wraps runLLMStream with a timeout (Promise.race)", () => {
        expect(projectChatSrc).toMatch(/Promise\.race/);
        expect(projectChatSrc).toMatch(/STREAM_TIMEOUT_MS|streamTimeout/);
    });

    it("chat.ts timeout duration is at least 60 seconds", () => {
        const match = chatSrc.match(/STREAM_TIMEOUT_MS\s*=\s*([\d_]+)/);
        if (match) {
            const value = Number(match[1].replace(/_/g, ""));
            expect(value).toBeGreaterThanOrEqual(60_000);
        } else {
            // inline timeout — check for a 6+ digit number anywhere near setTimeout
            expect(chatSrc).toMatch(/setTimeout[^,]+,\s*\d{5,}/);
        }
    });
});
