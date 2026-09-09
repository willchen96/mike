import type { PanelDocument } from "../shared/types";
import {
    listDocumentVersions,
    MikeApiError,
    type DocumentVersion,
} from "@/app/lib/mikeApi";

type VersionList = {
    current_version_id: string | null;
    versions: DocumentVersion[];
};

/**
 * Why this has three answers instead of two.
 *
 * A chat can be shared without its documents: the recipient of a shared
 * STANDALONE chat holds no grant on the single-documents behind it, so
 * GET /single-documents/:id/versions answers 403/404 for them. Collapsing
 * that into the same `null` as "the version list came back empty" is what
 * made citation pills dead controls — the click resolved nothing and the
 * caller returned, with no tab, no error and nothing said.
 *
 * "denied" is that case and only that case; "unavailable" is every other
 * failure (network, 5xx, a document with no versions at all), which is not
 * something to tell the reader about their access.
 *
 * "denied" is a status, not a sentence. 404 is also what the chat's own OWNER
 * gets once the document they cited has been deleted, and only the caller
 * knows which of the two readers it is holding — so the caller decides the
 * wording from the role it already has, and this module stays out of it.
 */
export type PanelDocumentResolution =
    | { status: "resolved"; document: PanelDocument }
    | { status: "denied" }
    | { status: "unavailable" };

function isAccessRefusal(error: unknown): boolean {
    return (
        error instanceof MikeApiError &&
        (error.status === 403 || error.status === 404)
    );
}

export async function resolvePanelDocumentVersionResult(
    document: PanelDocument,
    loadVersions: (documentId: string) => Promise<VersionList> =
        listDocumentVersions,
): Promise<PanelDocumentResolution> {
    if (document.type === "case" || document.version_id)
        return { status: "resolved", document };

    let result: VersionList;
    try {
        result = await loadVersions(document.document_id);
    } catch (error) {
        return isAccessRefusal(error)
            ? { status: "denied" }
            : { status: "unavailable" };
    }

    const version =
        (document.version_number != null
            ? result.versions.find(
                  (candidate) =>
                      candidate.version_number === document.version_number,
              )
            : undefined) ??
        result.versions.find(
            (candidate) => candidate.id === result.current_version_id,
        );
    if (!version) return { status: "unavailable" };
    return {
        status: "resolved",
        document: {
            ...document,
            version_id: version.id,
            version_number: version.version_number,
        },
    };
}

// There used to be a `resolvePanelDocumentVersion` wrapper here that threw
// the reason away and returned `PanelDocument | null`. Its last caller was
// the download-card click, and "null" is precisely why that click did nothing
// visible when a document was missing. Every caller now has a reason to give,
// so the lossy wrapper is gone rather than left as the easier option.
