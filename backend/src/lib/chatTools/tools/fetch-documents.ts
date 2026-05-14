/**
 * fetch_documents tool runner.
 *
 * Reads multiple documents in a single tool call by dispatching to
 * runReadDocument for each requested doc id. Returns a concatenated
 * text block with per-document separators.
 */

import { createServerSupabase } from "../../supabase";
import type { DocStore, DocIndex } from "../types";
import { runReadDocument } from "./read-document";

export async function runFetchDocuments(args: {
    docIds: string[];
    docStore: DocStore;
    write: (s: string) => void;
    docIndex?: DocIndex;
    db?: ReturnType<typeof createServerSupabase>;
}): Promise<{ content: string; docsRead: { filename: string; document_id?: string }[] }> {
    const { docIds, docStore, write, docIndex, db } = args;
    const parts: string[] = [];
    const docsRead: { filename: string; document_id?: string }[] = [];

    for (const docId of docIds) {
        const content = await runReadDocument({ docLabel: docId, docStore, write, docIndex, db });
        const filename = docStore.get(docId)?.filename ?? docId;
        parts.push(`--- ${filename} (${docId}) ---\n${content}`);
        if (docStore.get(docId)) {
            const documentId = docIndex?.[docId]?.document_id;
            docsRead.push({ filename, document_id: documentId });
        }
    }

    return { content: parts.join("\n\n"), docsRead };
}
