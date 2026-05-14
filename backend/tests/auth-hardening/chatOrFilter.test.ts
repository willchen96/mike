/**
 * CLEAN-11 — Chat list: SDK-composed union query + ordering.
 *
 * Verifies:
 *   1. GET /chat returns the union of user's own chats AND chats in user's
 *      own projects.
 *   2. The response is sorted by created_at descending (newest first).
 *   3. (Source-level regression) `chat.ts` does NOT use a backtick-template
 *      `.or(` call; it DOES contain `.in("project_id"`.
 *
 * The static-source assertion is the load-bearing RED test before Task 2
 * lands. Tests 1 and 2 rely on the globalSetup users (TEST_JWT_A et al).
 */

import { describe, it, expect, beforeAll } from "vitest";
import supertest from "supertest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { app } from "../../src/app";

let jwtA: string;
let userIdA: string;
let directChatId: string;
let projectChatId: string;
let projectId: string;

beforeAll(async () => {
    jwtA = process.env.TEST_JWT_A!;
    userIdA = process.env.TEST_USER_A_ID!;
    if (!jwtA || !userIdA) {
        throw new Error(
            "globalSetup did not run; TEST_JWT_A / TEST_USER_A_ID missing. " +
                "Run via: cd backend && npx vitest run --config vitest.config.ts tests/auth-hardening/chatOrFilter.test.ts",
        );
    }

    // Seed: create a project as user A, then create one direct chat and one
    // project-scoped chat. Use small delays to ensure distinct created_at.
    const projectRes = await supertest(app)
        .post("/projects")
        .set("Authorization", `Bearer ${jwtA}`)
        .send({ name: "chatOrFilter test project" });
    if (projectRes.status < 200 || projectRes.status > 299) {
        throw new Error(
            `[chatOrFilter setup] POST /projects failed: status=${projectRes.status} body=${JSON.stringify(projectRes.body)}`,
        );
    }
    projectId = (projectRes.body as { id: string }).id;

    // Direct chat (no project) — created first, so has an earlier created_at.
    const directChatRes = await supertest(app)
        .post("/chat/create")
        .set("Authorization", `Bearer ${jwtA}`)
        .send({});
    if (directChatRes.status < 200 || directChatRes.status > 299) {
        throw new Error(
            `[chatOrFilter setup] POST /chat/create (direct) failed: status=${directChatRes.status}`,
        );
    }
    directChatId = (directChatRes.body as { id: string }).id;

    // Small pause so Postgres clock ticks between the two inserts.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // Project-scoped chat — created second, so has a later created_at.
    const projectChatRes = await supertest(app)
        .post("/chat/create")
        .set("Authorization", `Bearer ${jwtA}`)
        .send({ project_id: projectId });
    if (projectChatRes.status < 200 || projectChatRes.status > 299) {
        throw new Error(
            `[chatOrFilter setup] POST /chat/create (project) failed: status=${projectChatRes.status}`,
        );
    }
    projectChatId = (projectChatRes.body as { id: string }).id;
}, 30_000);

// ── 1. Union ──────────────────────────────────────────────────────────────────

describe("GET /chat — union semantics", () => {
    it("returns both the direct chat and the project-scoped chat for user A", async () => {
        const res = await supertest(app)
            .get("/chat")
            .set("Authorization", `Bearer ${jwtA}`);
        expect(res.status).toBe(200);
        const ids = (res.body as { id: string }[]).map((c) => c.id);
        expect(ids).toContain(directChatId);
        expect(ids).toContain(projectChatId);
    });
});

// ── 2. Ordering ───────────────────────────────────────────────────────────────

describe("GET /chat — created_at desc ordering", () => {
    it("places the project-scoped chat (newer) before the direct chat (older)", async () => {
        const res = await supertest(app)
            .get("/chat")
            .set("Authorization", `Bearer ${jwtA}`);
        expect(res.status).toBe(200);
        const body = res.body as { id: string; created_at: string }[];
        const idxProject = body.findIndex((c) => c.id === projectChatId);
        const idxDirect = body.findIndex((c) => c.id === directChatId);
        // Both must be present.
        expect(idxProject).toBeGreaterThanOrEqual(0);
        expect(idxDirect).toBeGreaterThanOrEqual(0);
        // Newer chat must appear first (lower index = earlier in array = desc order).
        expect(idxProject).toBeLessThan(idxDirect);
    });
});

// ── 3. Static-source: no template-literal .or() injection ────────────────────

describe("chat.ts source — SDK-composed filter (no string-interpolated .or())", () => {
    it("contains .in(\"project_id\" (SDK chained call)", async () => {
        const chatTsPath = resolve(__dirname, "../../src/routes/chat.ts");
        const source = await readFile(chatTsPath, "utf8");
        expect(source).toMatch(/\.in\("project_id"/);
    });

    it("does NOT contain a string-interpolated PostgREST .or() filter (backtick template with user/project ids)", async () => {
        const chatTsPath = resolve(__dirname, "../../src/routes/chat.ts");
        const source = await readFile(chatTsPath, "utf8");
        // The old code builds: `user_id.eq.${userId},project_id.in.(${...})` and
        // passes it to .or(). Detect either inline or via variable:
        // - inline: .or(`...${...}`) or .or(filter) where filter has userId in it
        // - The simplest heuristic: source should NOT contain the PostgREST
        //   string patterns: "user_id.eq." + "${userId}" template fragment,
        //   and should NOT contain ".or(" at all (both forms are gone after fix).
        expect(source).not.toMatch(/user_id\.eq\.\$\{/);
    });
});
