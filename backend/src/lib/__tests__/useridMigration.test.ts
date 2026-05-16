import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const migrationSrc = readFileSync(
    join(__dirname, "../../../migrations/20260513_userid_text_to_uuid.sql"),
    "utf8",
);

const TABLES_REQUIRING_UUID = [
    "projects",
    "project_subfolders",
    "documents",
    "chats",
    "tabular_reviews",
    "tabular_review_chats",
    "workflows",
    "hidden_workflows",
    "workflow_shares",
];

describe("user_id uuid migration", () => {
    it("is wrapped in a transaction", () => {
        expect(migrationSrc).toMatch(/^BEGIN;/m);
        expect(migrationSrc).toMatch(/^COMMIT;/m);
    });

    it("migrates every affected table", () => {
        for (const table of TABLES_REQUIRING_UUID) {
            expect(migrationSrc).toContain(`public.${table}`);
        }
    });

    it("uses USING clause to cast existing text values", () => {
        const castCount = (migrationSrc.match(/USING user_id::uuid|USING shared_by_user_id::uuid/g) ?? []).length;
        expect(castCount).toBeGreaterThanOrEqual(TABLES_REQUIRING_UUID.length);
    });

    it("adds FK constraint referencing auth.users", () => {
        expect(migrationSrc).toMatch(/REFERENCES auth\.users\(id\)/);
        const fkCount = (migrationSrc.match(/REFERENCES auth\.users/g) ?? []).length;
        expect(fkCount).toBeGreaterThanOrEqual(TABLES_REQUIRING_UUID.length);
    });

    it("includes ON DELETE CASCADE or SET NULL for all FK constraints", () => {
        const cascadeCount = (migrationSrc.match(/ON DELETE CASCADE|ON DELETE SET NULL/g) ?? []).length;
        expect(cascadeCount).toBeGreaterThanOrEqual(TABLES_REQUIRING_UUID.length);
    });

    it("workflows uses ON DELETE SET NULL to preserve shared workflows", () => {
        // The workflows ALTER TABLE section starts after the section comment
        const sectionStart = migrationSrc.indexOf("ALTER TABLE public.workflows");
        const sectionEnd = migrationSrc.indexOf("public.hidden_workflows", sectionStart);
        const workflowsSection = migrationSrc.slice(sectionStart, sectionEnd);
        expect(workflowsSection).toMatch(/ON DELETE SET NULL/);
    });

    it("rollback script exists", async () => {
        const { existsSync } = await import("fs");
        expect(
            existsSync(join(__dirname, "../../../migrations/20260513_userid_text_to_uuid.rollback.sql")),
        ).toBe(true);
    });
});
