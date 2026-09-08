import type { PanelDocument } from "../shared/types";
import {
    listDocumentVersions,
    type DocumentVersion,
} from "@/app/lib/mikeApi";

type VersionList = {
    current_version_id: string | null;
    versions: DocumentVersion[];
};

export async function resolvePanelDocumentVersion(
    document: PanelDocument,
    loadVersions: (documentId: string) => Promise<VersionList> =
        listDocumentVersions,
): Promise<PanelDocument | null> {
    if (
        document.type === "case" ||
        document.version_id ||
        document.subdocuments?.length
    ) {
        return document;
    }

    try {
        const result = await loadVersions(document.document_id);
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
        if (!version) return null;
        return {
            ...document,
            version_id: version.id,
            version_number: version.version_number,
        };
    } catch {
        return null;
    }
}
