/**
 * Phase 8 (CLEAN-30) golden-log SSE fixture test.
 *
 * Verifies runLLMStream emits a byte-identical SSE event sequence before
 * and after the chatTools.ts split. Fixture-driven; no live LLM.
 *
 * Scenarios (one fixture per scenario):
 *   1. Plain content streaming
 *   2. Reasoning streaming
 *   3. Tool call (read_document)
 *   4. Citations marker stripping
 *   5. doc_edited event with annotations
 *
 * Pitfall 1 mitigation per .planning/research/PITFALLS.md.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, writeFileSync } from "fs";
import path from "path";

// Mock streamChatWithTools BEFORE importing runLLMStream so the mock is in place
// when chatTools.ts is first evaluated.
vi.mock("../../src/lib/llm", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../src/lib/llm")>();
    return { ...original, streamChatWithTools: vi.fn() };
});

import { streamChatWithTools } from "../../src/lib/llm";
import { runLLMStream } from "../../src/lib/chatTools";
import type { StreamChatParams } from "../../src/lib/llm";

const mockStream = streamChatWithTools as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Types for fixture file shape
// ---------------------------------------------------------------------------

type ProviderChunk =
    | { type: "content_delta"; text: string }
    | { type: "reasoning_delta"; text: string }
    | { type: "reasoning_block_end" }
    | { type: "tool_call_start"; id: string; name: string; input: Record<string, unknown> };

type Fixture = {
    scenario: string;
    providerChunks: ProviderChunk[];
    expectedSseSequence: string | "RECORD";
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWriteCapture(): { write: (s: string) => void; events: string[] } {
    const events: string[] = [];
    return { write: (s: string) => { events.push(s); }, events };
}

/**
 * Build a mock implementation for streamChatWithTools that replays the given
 * providerChunks by calling the params' callbacks. Does NOT call params.runTools
 * — tool calls are captured at the tool_call_start callback level only, without
 * executing the actual tool dispatch (which would require a live DB).
 */
function buildMockImplementation(chunks: ProviderChunk[]) {
    return async (params: StreamChatParams): Promise<{ fullText: string }> => {
        let fullText = "";
        for (const chunk of chunks) {
            if (chunk.type === "content_delta") {
                fullText += chunk.text;
                params.callbacks?.onContentDelta?.(chunk.text);
            } else if (chunk.type === "reasoning_delta") {
                params.callbacks?.onReasoningDelta?.(chunk.text);
            } else if (chunk.type === "reasoning_block_end") {
                params.callbacks?.onReasoningBlockEnd?.();
            } else if (chunk.type === "tool_call_start") {
                params.callbacks?.onToolCallStart?.({
                    id: chunk.id,
                    name: chunk.name,
                    input: chunk.input,
                });
            }
        }
        return { fullText };
    };
}

// ---------------------------------------------------------------------------
// Minimal runLLMStream params (no live DB or LLM needed)
// ---------------------------------------------------------------------------

function makeMinimalParams(write: (s: string) => void) {
    return {
        apiMessages: [
            { role: "user", content: "Test message" },
        ],
        docStore: new Map<string, { storage_path: string; file_type: string; filename: string }>(),
        docIndex: {},
        userId: "test-user-id",
        // db is only used inside runToolCalls, which is never invoked because
        // our mockStream does not call params.runTools.
        db: {} as ReturnType<typeof import("../../src/lib/supabase").createServerSupabase>,
        write,
    };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const SCENARIOS = [
    "plain-content",
    "reasoning",
    "tool-call-read-document",
    "citations-strip",
    // NOTE: this fixture only validates that `tool_call_start` is emitted
    // for an `edit_document` call. Because `buildMockImplementation` never
    // invokes `params.runTools`, the actual `doc_edited_start` /
    // `doc_edited` SSE events emitted by `runToolCalls` in
    // `tool-runner.ts` are NOT exercised here. A separate unit test for
    // `runToolCalls` is needed to cover that path.
    "tool-call-start-edit-document",
] as const;

describe("golden-log SSE", () => {
    beforeEach(() => {
        mockStream.mockReset();
    });

    for (const name of SCENARIOS) {
        it(`emits byte-identical SSE for ${name}`, async () => {
            const fixturePath = path.join(__dirname, "fixtures", `${name}.json`);
            const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

            mockStream.mockImplementation(buildMockImplementation(fixture.providerChunks));

            const cap = makeWriteCapture();
            await runLLMStream(makeMinimalParams(cap.write));

            const actual = cap.events.join("");

            if (fixture.expectedSseSequence === "RECORD") {
                console.log(`[golden-log] Recording fixture for scenario: ${name}`);
                fixture.expectedSseSequence = actual;
                writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n");
                throw new Error(
                    `[golden-log] Recorded fixture ${name}.json — re-run tests to verify`,
                );
            }

            expect(actual).toBe(fixture.expectedSseSequence);
        });
    }
});
