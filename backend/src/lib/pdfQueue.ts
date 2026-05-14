import { docxToPdf, convertedPdfKey } from "./convert";
import { uploadFile, downloadFile } from "./storage";
import { createServerSupabase } from "./supabase";
import { logger } from "./logger";

let _queue: import("p-queue").default | null = null;

async function getQueue(): Promise<import("p-queue").default> {
  if (!_queue) {
    const { default: PQueue } = await import("p-queue");
    _queue = new PQueue({ concurrency: 1 });
  }
  return _queue;
}

export async function enqueueConversionFromBuffer(params: {
  documentId: string;
  versionId: string;
  userId: string;
  docxBuffer: Buffer;
}): Promise<void> {
  const queue = await getQueue();
  void queue.add(async () => {
    const db = createServerSupabase();
    try {
      const { documentId, versionId, userId, docxBuffer } = params;
      const pdfBuf = await docxToPdf(docxBuffer);
      const pdfKey = convertedPdfKey(userId, documentId);
      const ab = pdfBuf.buffer.slice(
        pdfBuf.byteOffset,
        pdfBuf.byteOffset + pdfBuf.byteLength,
      ) as ArrayBuffer;
      await uploadFile(pdfKey, ab, "application/pdf");
      await db
        .from("document_versions")
        .update({ pdf_storage_path: pdfKey })
        .eq("id", versionId);
      await db
        .from("documents")
        .update({ pdf_conversion_status: "ok" })
        .eq("id", documentId);
    } catch (err) {
      logger.error({ err, documentId: params.documentId }, "[pdfQueue] conversion failed");
      await db
        .from("documents")
        .update({ pdf_conversion_status: "failed" })
        .eq("id", params.documentId);
    }
  });
}

export async function enqueueConversionForVersion(
  documentId: string,
  version: { id: string; storage_path: string },
  db: ReturnType<typeof createServerSupabase>,
): Promise<void> {
  const queue = await getQueue();
  void queue.add(async () => {
    try {
      const raw = await downloadFile(version.storage_path);
      if (!raw) throw new Error("Source DOCX not found in R2");
      const docxBuf = Buffer.from(raw);
      const pdfBuf = await docxToPdf(docxBuf);
      const pdfKey = `${version.storage_path.replace(/\.[^.]+$/, "")}_rendered.pdf`;
      const ab = pdfBuf.buffer.slice(
        pdfBuf.byteOffset,
        pdfBuf.byteOffset + pdfBuf.byteLength,
      ) as ArrayBuffer;
      await uploadFile(pdfKey, ab, "application/pdf");
      await db
        .from("document_versions")
        .update({ pdf_storage_path: pdfKey })
        .eq("id", version.id);
      await db
        .from("documents")
        .update({ pdf_conversion_status: "ok" })
        .eq("id", documentId);
    } catch (err) {
      logger.error({ err, documentId }, "[pdfQueue] retry failed");
      await db
        .from("documents")
        .update({ pdf_conversion_status: "failed" })
        .eq("id", documentId);
    }
  });
}

export async function resetStuckPendingConversions(): Promise<void> {
  try {
    const db = createServerSupabase();
    const { data, error } = await db
      .from("documents")
      .update({ pdf_conversion_status: "failed" })
      .eq("pdf_conversion_status", "pending")
      .select("id");
    if (error) {
      logger.error({ err: error }, "[pdfQueue] resetStuckPendingConversions failed");
      return;
    }
    const count = data?.length ?? 0;
    if (count > 0) {
      logger.info({ count }, "[pdfQueue] startup fixup: reset stuck pending rows to failed");
    }
  } catch (err) {
    logger.error({ err }, "[pdfQueue] resetStuckPendingConversions threw");
  }
}
