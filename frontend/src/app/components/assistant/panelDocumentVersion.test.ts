import { describe, expect, it, vi } from "vitest";
import type { PanelDocument } from "../shared/types";
import { MikeApiError } from "@/app/lib/mikeApi";
import { resolvePanelDocumentVersionResult } from "./panelDocumentVersion";

const document: PanelDocument = {
    document_id: "document-1",
    title: "agreement.docx",
    type: "docx",
    metadata: [],
    quotes: [],
    version_id: null,
    version_number: null,
};

describe("resolvePanelDocumentVersionResult version selection", () => {
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
            resolvePanelDocumentVersionResult(document, loadVersions),
        ).resolves.toMatchObject({
            status: "resolved",
            document: { version_id: "version-3", version_number: 3 },
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
            resolvePanelDocumentVersionResult(
                { ...document, version_number: 2 },
                loadVersions,
            ),
        ).resolves.toMatchObject({
            status: "resolved",
            document: { version_id: "version-2", version_number: 2 },
        });
    });
});

describe("resolvePanelDocumentVersionResult", () => {
    // A chat can be shared without its documents. For a shared STANDALONE
    // chat the recipient holds no grant on the single-documents behind it, so
    // GET /single-documents/:id/versions answers 403/404 — and folding that
    // into the same `null` as "no versions came back" is what turned citation
    // pills into dead controls. The two answers have to be distinguishable
    // here, because only one of them is worth telling the reader about.
    it("reports a 404 from the versions endpoint as denied", async () => {
        const loadVersions = vi
            .fn()
            .mockRejectedValue(
                new MikeApiError({ message: "Not found", status: 404 }),
            );

        await expect(
            resolvePanelDocumentVersionResult(document, loadVersions),
        ).resolves.toEqual({ status: "denied" });
    });

    it("reports a 403 from the versions endpoint as denied", async () => {
        const loadVersions = vi
            .fn()
            .mockRejectedValue(
                new MikeApiError({ message: "Forbidden", status: 403 }),
            );

        await expect(
            resolvePanelDocumentVersionResult(document, loadVersions),
        ).resolves.toEqual({ status: "denied" });
    });

    it("does not call a transport failure a refusal", async () => {
        // A 500 or a dropped connection says nothing about the caller's
        // access; claiming "not shared with you" there would be a lie.
        const loadVersions = vi.fn().mockRejectedValue(new Error("network"));

        await expect(
            resolvePanelDocumentVersionResult(document, loadVersions),
        ).resolves.toEqual({ status: "unavailable" });
    });

    it("does not call a 500 a refusal either", async () => {
        const loadVersions = vi
            .fn()
            .mockRejectedValue(
                new MikeApiError({ message: "Server error", status: 500 }),
            );

        await expect(
            resolvePanelDocumentVersionResult(document, loadVersions),
        ).resolves.toEqual({ status: "unavailable" });
    });

    it("reports an empty version list as unavailable, not denied", async () => {
        const loadVersions = vi
            .fn()
            .mockResolvedValue({ current_version_id: null, versions: [] });

        await expect(
            resolvePanelDocumentVersionResult(document, loadVersions),
        ).resolves.toEqual({ status: "unavailable" });
    });

    it("resolves without a request when the version is already known", async () => {
        const loadVersions = vi.fn();

        await expect(
            resolvePanelDocumentVersionResult(
                { ...document, version_id: "version-9" },
                loadVersions,
            ),
        ).resolves.toMatchObject({ status: "resolved" });
        expect(loadVersions).not.toHaveBeenCalled();
    });

});
