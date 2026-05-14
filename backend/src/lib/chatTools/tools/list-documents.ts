/**
 * list_documents tool runner.
 *
 * Returns the current turn's available document labels, filenames, and
 * file types as a JSON array. No SSE events emitted.
 */

import type { DocStore } from "../types";

export function runListDocuments(args: {
    docStore: DocStore;
}): string {
    const { docStore } = args;
    const list = Array.from(docStore.entries()).map(
        ([doc_id, info]) => ({
            doc_id,
            filename: info.filename,
            file_type: info.file_type,
        }),
    );
    return JSON.stringify(list);
}
