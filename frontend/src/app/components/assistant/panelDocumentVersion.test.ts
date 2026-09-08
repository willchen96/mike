import { describe, expect, it, vi } from "vitest";
import type { PanelDocument } from "../shared/types";
import { resolvePanelDocumentVersion } from "./panelDocumentVersion";

const document: PanelDocument = {
    document_id: "document-1",
    title: "agreement.docx",
    type: "docx",
    metadata: [],
    quotes: [],
    version_id: null,
    version_number: null,
};

describe("resolvePanelDocumentVersion", () => {
    it("keeps an inline source without loading project versions", async () => {
        const loadVersions = vi.fn();
        const source = {
            ...document,
            document_id: "mcp:connector:source:1",
            subdocuments: [
                {
                    document_id: "mcp:connector:source:1:text",
                    title: "Source",
                    type: "html" as const,
                    text: "Source text",
                },
            ],
        };

        await expect(
            resolvePanelDocumentVersion(source, loadVersions),
        ).resolves.toBe(source);
        expect(loadVersions).not.toHaveBeenCalled();
    });

    it("resolves an unversioned panel link to the current version", async () => {
        const loadVersions = vi.fn().mockResolvedValue({
            current_version_id: "version-3",
            versions: [
                {
                    id: "version-3",
                    version_number: 3,
                    source: "assistant_edit",
                    created_at: "2026-08-18T00:00:00Z",
                    filename: "agreement.docx",
                },
            ],
        });

        await expect(
            resolvePanelDocumentVersion(document, loadVersions),
        ).resolves.toMatchObject({
            version_id: "version-3",
            version_number: 3,
        });
    });

    it("resolves a known version number instead of substituting current", async () => {
        const loadVersions = vi.fn().mockResolvedValue({
            current_version_id: "version-3",
            versions: [
                {
                    id: "version-2",
                    version_number: 2,
                    source: "assistant_edit",
                    created_at: "2026-08-17T00:00:00Z",
                    filename: "agreement.docx",
                },
                {
                    id: "version-3",
                    version_number: 3,
                    source: "assistant_edit",
                    created_at: "2026-08-18T00:00:00Z",
                    filename: "agreement.docx",
                },
            ],
        });

        await expect(
            resolvePanelDocumentVersion(
                { ...document, version_number: 2 },
                loadVersions,
            ),
        ).resolves.toMatchObject({
            version_id: "version-2",
            version_number: 2,
        });
    });
});
