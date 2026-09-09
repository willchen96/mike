import { Router } from "express";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { sendInternalError } from "../lib/httpError";
import {
  buildContentDisposition,
  createFileReadStream,
  downloadFile,
  deleteFile,
  extractedTextKey,
  getSignedUrl,
  headFile,
  uploadFile,
  versionStorageKey,
} from "../lib/storage";
import { docxToPdf } from "../lib/convert";
import { enqueueConversion } from "../lib/queue/conversionQueue";
import { enqueueStorageCleanup } from "../lib/dbq/enqueue";
import {
  extractTrackedChangeIds,
  resolveTrackedChange,
} from "../lib/docxTrackedChanges";
import { buildDownloadUrl } from "../lib/downloadTokens";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  contentSha256,
  downloadFilenameForVersion,
  loadActiveVersion,
} from "../lib/documentVersions";
import { can } from "../lib/permissions";
import {
    checkProjectAccess,
    creatorScopedAllowed,
    ensureDocAccess,
} from "../lib/access";
import { mapWithConcurrency } from "../lib/concurrency";
import {
  contentTypeForDocumentType,
  shouldConvertToPdf,
} from "../lib/documentTypes";
import { uniqueArchiveFilename, zipExportLimitDetail } from "../lib/zipExport";
import {
  loadDocumentDisplay,
  sendDocumentDisplay,
} from "../lib/documentDisplay";

export const documentsRouter = Router();

/**
 * "Not found" is for rows the caller cannot see at all. A Viewer who can open
 * a document but not change it gets a refusal that names the reason, so the
 * UI stops telling people their document disappeared.
 */
const DOCUMENT_EDIT_FORBIDDEN =
  "You do not have permission to edit content in this project.";

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

export function collectFolderDescendantIds(
  roots: Array<{ id: unknown }>,
  allFolders: Array<{ id: unknown; parent_folder_id: unknown }>,
) {
  const selected = new Set(roots.map((folder) => String(folder.id)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of allFolders) {
      const id = String(folder.id);
      const parentId = folder.parent_folder_id
        ? String(folder.parent_folder_id)
        : null;
      if (!parentId || !selected.has(parentId) || selected.has(id)) continue;
      selected.add(id);
      changed = true;
    }
  }
  return [...selected];
}

async function deleteDocumentAndVersionFiles(
  db: ReturnType<typeof createServerSupabase>,
  documentId: string,
) {
  // Storage lives on document_versions — collect every version's bytes
  // (source + PDF rendition), drop the document row, then hand the object
  // deletes to the durable storage.cleanup job. Previously each delete was
  // fire-and-forget (`.catch(() => {})`): one storage hiccup silently leaked
  // the files forever. Rows first, files second — if the row delete fails
  // nothing has been touched and the document stays intact; if the process
  // dies after it, the queued job still removes the files.
  const { data: versions } = await db
    .from("document_versions")
    .select("id, storage_path, pdf_storage_path")
    .eq("document_id", documentId);
  const keys = (versions ?? []).flatMap((v) =>
    // The extracted-text cache is keyed by version id and sits outside the
    // per-user prefixes, so this is the only place that can reach it.
    // Deleting an object that was never written is a no-op, hence no gate.
    [
      v.storage_path,
      v.pdf_storage_path,
      typeof v.id === "string" && v.id ? extractedTextKey(v.id) : null,
    ].filter((p): p is string => typeof p === "string" && p.length > 0),
  );
  const result = await db.from("documents").delete().eq("id", documentId);
  if (!result.error) await enqueueStorageCleanup(db, keys);
  return result;
}

// GET /single-documents
documentsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("documents")
    .select("*")
    .eq("user_id", userId)
    .is("project_id", null)
    .or("library_kind.eq.file,library_kind.is.null")
    .order("created_at", { ascending: false });
  if (error) return void sendInternalError(res, error);
  const docs = (data ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docs);
  await attachActiveVersionPaths(db, docs);
  res.json(docs);
});

// GET /single-documents/:documentId
// One document, same shape as a list entry. Exists so the client can poll a
// single document's status while a deferred conversion runs, instead of
// refetching the whole collection.
documentsRouter.get("/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const { data: doc } = await db
    .from("documents")
    .select("*")
    .eq("id", documentId)
    .single();
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const docs = [doc] as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docs);
  await attachActiveVersionPaths(db, docs);
  res.json(docs[0]);
});

// DELETE /single-documents/:documentId
// Scoped by the same rule as DELETE .../versions/:versionId, not by
// `user_id = me`: that older scope meant an org admin could not remove a
// colleague's document from a matter the firm owns, and — once account
// deletion started blanking documents.user_id instead of destroying org
// content — that NOBODY could remove a departed colleague's document.
documentsRouter.delete("/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const { data: doc } = await db
    .from("documents")
    .select("id, user_id, project_id, org_id, workflow_id")
    .eq("id", documentId)
    .single();
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });
  if (
    !creatorScopedAllowed(access, doc.user_id) &&
    !(doc.workflow_id && can(access.projectRole, "content.edit"))
  )
    return void res.status(403).json({
      detail: "You do not have permission to delete this document.",
    });

  await deleteDocumentAndVersionFiles(db, documentId);
  res.status(204).send();
});

// GET /single-documents/:documentId/display
// Optional ?version_id= renders a historical version. Defaults to the
// document's current_version_id.
documentsRouter.get("/:documentId/display", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { documentId } = req.params;
  const versionIdParam =
    typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc } = await db
    .from("documents")
    .select("id, user_id, project_id, org_id, workflow_id")
    .eq("id", documentId)
    .single();
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const displayFilename = downloadFilenameForVersion(
    active.filename,
    active.version_number,
    active.source === "assistant_edit",
  );

  try {
    const display = await loadDocumentDisplay({
      filename: displayFilename,
      fileType: active.file_type,
      storagePath: active.storage_path,
      pdfStoragePath: active.pdf_storage_path,
    });
    if (!display) {
      return void res
        .status(404)
        .json({ detail: "Document not found in storage" });
    }
    sendDocumentDisplay(res, display);
  } catch (error) {
    return void sendInternalError(res, error);
  }
});

// POST /single-documents/download-zip
// Synchronous zip, kept for small selections (instant download, no polling).
// Large selections go through the durable "documents-zip" export job instead.
documentsRouter.post("/download-zip", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { document_ids, folder_ids } = req.body as {
    document_ids?: string[];
    folder_ids?: string[];
  };
  const documentIds = Array.isArray(document_ids)
    ? [...new Set(document_ids.filter((id) => typeof id === "string"))]
    : [];
  const folderIds = Array.isArray(folder_ids)
    ? [...new Set(folder_ids.filter((id) => typeof id === "string"))]
    : [];

  if (documentIds.length === 0 && folderIds.length === 0)
    return void res
      .status(400)
      .json({ detail: "document_ids or folder_ids is required" });
  const requestedCountLimit = zipExportLimitDetail(documentIds.length, 0);
  if (requestedCountLimit) {
    return void res.status(413).json({ detail: requestedCountLimit });
  }
  const db = createServerSupabase();
  type DownloadDocumentRow = {
    id: string;
    current_version_id?: string | null;
    user_id: string;
    project_id: string | null;
    storage_path?: string | null;
    filename?: string | null;
    source?: string | null;
    active_version_number?: number | null;
  };
  const rawDocsById = new Map<string, DownloadDocumentRow>();

  if (documentIds.length > 0) {
    const { data, error } = await db
      .from("documents")
      .select("id, current_version_id, user_id, project_id, org_id, workflow_id")
      .in("id", documentIds);
    if (error) return void sendInternalError(res, error);
    for (const doc of data ?? [])
      rawDocsById.set(doc.id as string, doc as DownloadDocumentRow);
  }

  if (folderIds.length > 0) {
    const [projectRootsResult, libraryRootsResult] = await Promise.all([
      db
        .from("project_subfolders")
        .select("id, project_id, parent_folder_id")
        .in("id", folderIds),
      db
        .from("library_folders")
        .select("id, user_id, library_kind, parent_folder_id")
        .in("id", folderIds)
        .eq("user_id", userId),
    ]);
    if (projectRootsResult.error)
      return void sendInternalError(res, projectRootsResult.error);
    if (libraryRootsResult.error)
      return void sendInternalError(res, libraryRootsResult.error);

    const projectRoots = projectRootsResult.data ?? [];
    const projectIds = [
      ...new Set(projectRoots.map((folder) => folder.project_id as string)),
    ];
    const accessibleProjectIds = (
      await Promise.all(
        projectIds.map(async (projectId) => ({
          projectId,
          access: await checkProjectAccess(projectId, userId, userEmail, db),
        })),
      )
    )
      .filter((result) => result.access.ok)
      .map((result) => result.projectId);

    const accessibleProjectRoots = projectRoots.filter((folder) =>
      accessibleProjectIds.includes(folder.project_id as string),
    );
    const libraryRoots = libraryRootsResult.data ?? [];
    const libraryKinds = [
      ...new Set(libraryRoots.map((folder) => folder.library_kind as string)),
    ];

    const [projectFoldersResult, libraryFoldersResult] = await Promise.all([
      accessibleProjectIds.length > 0
        ? db
            .from("project_subfolders")
            .select("id, project_id, parent_folder_id")
            .in("project_id", accessibleProjectIds)
        : Promise.resolve({ data: [], error: null }),
      libraryKinds.length > 0
        ? db
            .from("library_folders")
            .select("id, user_id, library_kind, parent_folder_id")
            .eq("user_id", userId)
            .in("library_kind", libraryKinds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (projectFoldersResult.error)
      return void sendInternalError(res, projectFoldersResult.error);
    if (libraryFoldersResult.error)
      return void sendInternalError(res, libraryFoldersResult.error);

    const projectFolderIds = collectFolderDescendantIds(
      accessibleProjectRoots,
      projectFoldersResult.data ?? [],
    );
    const libraryFolderIds = collectFolderDescendantIds(
      libraryRoots,
      libraryFoldersResult.data ?? [],
    );

    const folderDocumentResults = await Promise.all([
      projectFolderIds.length > 0
        ? db
            .from("documents")
            .select("id, current_version_id, user_id, project_id, workflow_id")
            .in("folder_id", projectFolderIds)
        : Promise.resolve({ data: [], error: null }),
      libraryFolderIds.length > 0
        ? db
            .from("documents")
            .select("id, current_version_id, user_id, project_id, workflow_id")
            .in("library_folder_id", libraryFolderIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    for (const result of folderDocumentResults) {
      if (result.error) return void sendInternalError(res, result.error);
      for (const doc of result.data ?? [])
        rawDocsById.set(doc.id as string, doc as DownloadDocumentRow);
    }
  }

  const resolvedCountLimit = zipExportLimitDetail(rawDocsById.size, 0);
  if (resolvedCountLimit) {
    return void res.status(413).json({ detail: resolvedCountLimit });
  }

  // Filter to docs the user actually has access to (own + shared-project).
  const accessChecks = await Promise.all(
    [...rawDocsById.values()].map(async (d) => ({
      doc: d,
      access: await ensureDocAccess(
        d as { user_id: string; project_id: string | null },
        userId,
        userEmail,
        db,
      ),
    })),
  );
  const docs = accessChecks.filter((x) => x.access.ok).map((x) => x.doc);
  if (!docs || docs.length === 0)
    return void res.status(404).json({ detail: "No documents found" });

  await attachActiveVersionPaths(db, docs);
  const activeDocs = docs.filter(
    (
      doc,
    ): doc is DownloadDocumentRow & {
      storage_path: string;
    } => typeof doc.storage_path === "string" && doc.storage_path.length > 0,
  );
  if (activeDocs.length === 0)
    return void res.status(404).json({ detail: "No files available" });

  let exportEntries: Array<{
    doc: (typeof activeDocs)[number];
    size: number;
  }>;
  try {
    exportEntries = (
      await mapWithConcurrency(activeDocs, 5, async (doc) => ({
        doc,
        metadata: await headFile(doc.storage_path),
      }))
    )
      .filter(
        (
          entry,
        ): entry is {
          doc: (typeof activeDocs)[number];
          metadata: NonNullable<Awaited<ReturnType<typeof headFile>>>;
        } => entry.metadata != null,
      )
      .map(({ doc, metadata }) => ({ doc, size: metadata.size }));
  } catch (error) {
    return void sendInternalError(res, error);
  }
  if (exportEntries.length === 0)
    return void res.status(404).json({ detail: "No files available" });

  const sizeLimit = zipExportLimitDetail(
    exportEntries.length,
    exportEntries.reduce((total, entry) => total + entry.size, 0),
  );
  if (sizeLimit) {
    return void res.status(413).json({ detail: sizeLimit });
  }

  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const usedNames = new Set<string>();
  const fileStreams = exportEntries.map(({ doc }) => {
    const stream = createFileReadStream(doc.storage_path);
    zip.file(
      uniqueArchiveFilename(
        downloadFilenameForVersion(
          doc.filename,
          doc.active_version_number ?? null,
          doc.source === "assistant_edit",
        ),
        usedNames,
      ),
      stream,
      { compression: "STORE" },
    );
    return stream;
  });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="documents.zip"');
  const archiveStream = zip.generateNodeStream({
    type: "nodebuffer",
    streamFiles: true,
    compression: "STORE",
  }) as Readable;
  try {
    await pipeline(archiveStream, res);
  } catch (error) {
    for (const stream of fileStreams) stream.destroy();
    if (!res.headersSent && !res.destroyed) {
      return void sendInternalError(res, error);
    }
  }
});

// GET /single-documents/:documentId/url
// Optional ?version_id= selects a specific tracked-changes version.
// Otherwise falls back to documents.current_version_id, else the original upload.
documentsRouter.get("/:documentId/url", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam =
    typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, user_id, project_id, org_id, workflow_id")
    .eq("id", documentId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const downloadFilename = downloadFilenameForVersion(
    active.filename,
    active.version_number,
    active.source === "assistant_edit",
  );
  const url = await getSignedUrl(active.storage_path, 3600, downloadFilename);
  if (!url)
    return void res.status(503).json({ detail: "Storage not configured" });

  res.json({
    url,
    document_id: documentId,
    filename: downloadFilename,
    version_id: active.id,
    // Lets the frontend decide between DocView (PDF.js) and DocxView
    // (docx-preview) without a follow-up round-trip.
    has_pdf_rendition: !!active.pdf_storage_path,
  });
});

// GET /single-documents/:documentId/docx
// Streams the raw .docx bytes for the given document, optionally at a
// specific tracked-changes version. Unlike /url, this bypasses R2 (avoids
// the browser CORS problem on signed URLs) so the frontend docx-preview
// viewer can load tracked-change documents directly.
documentsRouter.get("/:documentId/docx", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam =
    typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, user_id, project_id, org_id, workflow_id")
    .eq("id", documentId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const raw = await downloadFile(active.storage_path);
  if (!raw)
    return void res
      .status(404)
      .json({ detail: "Document bytes not available" });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition(
      "inline",
      downloadFilenameForVersion(
        active.filename,
        active.version_number,
        active.source === "assistant_edit",
      ),
    ),
  );
  res.send(Buffer.from(raw));
});

// GET /single-documents/:documentId/versions
// Returns every version row for the document in document order, with
// the human-friendly version number when present.
documentsRouter.get("/:documentId/versions", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const { data: doc } = await db
    .from("documents")
    .select("id, current_version_id, user_id, project_id, org_id, workflow_id")
    .eq("id", documentId)
    .single();
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const { data: rows } = await db
    .from("document_versions")
    .select(
      "id, version_number, source, created_at, filename, file_type, size_bytes, page_count, deleted_at, deleted_by",
    )
    .eq("document_id", documentId)
    .order("created_at", { ascending: true });

  res.json({
    current_version_id: doc.current_version_id,
    versions: rows ?? [],
  });
});

// POST /single-documents/:documentId/versions/from-document
// Create a new version of documentId from another existing document's active
// bytes. This keeps signed storage URLs out of the browser fetch path.
documentsRouter.post(
  "/:documentId/versions/from-document",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const sourceDocumentId =
      typeof req.body?.source_document_id === "string"
        ? req.body.source_document_id
        : "";
    const db = createServerSupabase();

    if (!sourceDocumentId) {
      return void res
        .status(400)
        .json({ detail: "source_document_id is required" });
    }
    if (sourceDocumentId === documentId) {
      return void res
        .status(400)
        .json({ detail: "Source and target documents must be different." });
    }

    const { data: targetDoc } = await db
      .from("documents")
      .select("id, user_id, project_id, org_id, workflow_id")
      .eq("id", documentId)
      .single();
    if (!targetDoc)
      return void res.status(404).json({ detail: "Document not found" });
    const targetAccess = await ensureDocAccess(targetDoc, userId, userEmail, db);
    if (!targetAccess.ok || !can(targetAccess.projectRole, "content.edit"))
      return void res.status(404).json({ detail: "Document not found" });

    const { data: sourceDoc } = await db
      .from("documents")
      .select("id, user_id, project_id, org_id, workflow_id")
      .eq("id", sourceDocumentId)
      .single();
    if (!sourceDoc)
      return void res.status(404).json({ detail: "Source document not found" });
    const sourceAccess = await ensureDocAccess(
      sourceDoc,
      userId,
      userEmail,
      db,
    );
    if (!sourceAccess.ok)
      return void res.status(404).json({ detail: "Source document not found" });
    const willDeleteSource =
      (sourceDoc.project_id &&
        targetDoc.project_id &&
        sourceDoc.project_id === targetDoc.project_id) ||
      (!sourceDoc.project_id &&
        !targetDoc.project_id &&
        sourceDoc.user_id === userId &&
        targetDoc.user_id === userId);
    if (
      willDeleteSource &&
      !creatorScopedAllowed(sourceAccess, sourceDoc.user_id)
    ) {
      return void res.status(403).json({
        detail: "Only the source document's creator can move it into a version.",
      });
    }

    const active = await loadActiveVersion(sourceDocumentId, db);
    if (!active)
      return void res
        .status(404)
        .json({ detail: "Source document has no active version." });
    const sourceType = active.file_type ?? "";

    const bytes = await downloadFile(active.storage_path);
    if (!bytes)
      return void res
        .status(404)
        .json({ detail: "Source document bytes not available." });

    const filename =
      typeof req.body?.filename === "string" && req.body.filename.trim()
        ? req.body.filename.trim().slice(0, 200)
        : active.filename?.trim() || "Untitled document";
    const suffix =
      sourceType ||
      (filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "");
    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    const key = versionStorageKey(userId, documentId, versionSlug, filename);
    const contentType = contentTypeForDocumentType(suffix);

    try {
      await uploadFile(key, bytes, contentType);
    } catch (e) {
      console.error("[versions/copy] storage write failed", e);
      return void res
        .status(500)
        .json({ detail: "Failed to create new version." });
    }

    let pdfStoragePath: string | null = null;
    let deferConversion = false;
    if (suffix === "pdf") {
      pdfStoragePath = key;
    } else if (active.pdf_storage_path) {
      if (active.pdf_storage_path === active.storage_path) {
        pdfStoragePath = key;
      } else {
        const pdfBytes = await downloadFile(active.pdf_storage_path);
        if (pdfBytes) {
          const pdfKey = `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`;
          await uploadFile(pdfKey, pdfBytes, "application/pdf");
          pdfStoragePath = pdfKey;
        }
      }
    } else if (shouldConvertToPdf(suffix)) {
      // Only reached when the source has no rendition to copy — this is the
      // one branch of the copy flow that pays for LibreOffice, so it's the
      // branch the conversion queue takes over when the flag is on.
      if (process.env.ASYNC_DOCUMENT_CONVERSION === "true") {
        deferConversion = true;
      } else {
        try {
          const pdfBuf = await docxToPdf(Buffer.from(bytes));
          const pdfKey = `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`;
          await uploadFile(
            pdfKey,
            pdfBuf.buffer.slice(
              pdfBuf.byteOffset,
              pdfBuf.byteOffset + pdfBuf.byteLength,
            ) as ArrayBuffer,
            "application/pdf",
          );
          pdfStoragePath = pdfKey;
        } catch (err) {
          console.error(
            "[versions/copy] Office→PDF conversion failed",
            { filename },
            err,
          );
        }
      }
    }

    const { data: maxRow } = await db
      .from("document_versions")
      .select("version_number")
      .eq("document_id", documentId)
      .in("source", ["upload", "user_upload", "assistant_edit"])
      .order("version_number", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const nextVersionNumber =
      ((maxRow?.version_number as number | null) ?? 1) + 1;

    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: documentId,
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        source: "user_upload",
        version_number: nextVersionNumber,
        filename: filename,
        file_type: sourceType || null,
        size_bytes: active.size_bytes ?? bytes.byteLength,
        page_count: active.page_count,
        content_sha256: contentSha256(bytes),
      })
      .select("id, version_number, source, created_at, filename")
      .single();
    if (verErr || !versionRow) {
      console.error("[versions/copy] insert failed", verErr);
      return void res
        .status(500)
        .json({ detail: "Failed to record new version." });
    }

    const { error: updateDocErr } = await db
      .from("documents")
      .update({
        current_version_id: versionRow.id,
      })
      .eq("id", documentId);
    if (updateDocErr) {
      console.error(
        "[versions/copy] current version update failed",
        updateDocErr,
      );
      return void res
        .status(500)
        .json({ detail: "Failed to update document current version." });
    }

    if (deferConversion) {
      await enqueueConversion({
        documentId,
        versionId: versionRow.id as string,
        userId,
        storagePath: key,
        fileType: suffix,
        pdfKey: `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`,
        finalizeDocumentStatus: false,
      });
    }

    if (willDeleteSource) {
      const { error: deleteErr } = await deleteDocumentAndVersionFiles(
        db,
        sourceDocumentId,
      );
      if (deleteErr) {
        console.error(
          "[versions/copy] source document delete failed",
          deleteErr,
        );
        return void res
          .status(500)
          .json({ detail: "Failed to delete source document." });
      }
    }

    res.status(201).json(versionRow);
  },
);

// PATCH /single-documents/:documentId/versions/:versionId
// Rename a version's filename. Pass `{ "filename": "…" }`.
documentsRouter.patch(
  "/:documentId/versions/:versionId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, versionId } = req.params;
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id, org_id, workflow_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    // A document a Viewer can open has not disappeared — say so, instead of
    // reporting the read-only tier as a missing row.
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });
    if (!can(access.projectRole, "content.edit"))
      return void res.status(403).json({ detail: DOCUMENT_EDIT_FORBIDDEN });

    const raw = req.body?.filename;
    const filename =
      typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : null;

    const { data: updated, error } = await db
      .from("document_versions")
      .update({ filename })
      .eq("id", versionId)
      .eq("document_id", documentId)
      .is("deleted_at", null)
      .select(
        "id, version_number, source, created_at, filename, file_type, size_bytes, page_count",
      )
      .single();
    if (error || !updated) {
      return void res.status(404).json({ detail: "Version not found" });
    }
    res.json(updated);
  },
);

// DELETE /single-documents/:documentId/versions/:versionId
// Delete one version. The last remaining version cannot be deleted; if the
// deleted version is current, the newest remaining version becomes current.
documentsRouter.delete(
  "/:documentId/versions/:versionId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, versionId } = req.params;
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id, org_id, workflow_id, current_version_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    // Same split as the whole-document DELETE above: a caller with no verdict
    // is told the row does not exist, and a caller who can open the document
    // but not delete this version is REFUSED by name. Collapsing both into
    // 404 told a Viewer their version had vanished.
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });
    if (
      !creatorScopedAllowed(access, doc.user_id) &&
      !(doc.workflow_id && can(access.projectRole, "content.edit"))
    )
      return void res.status(403).json({
        detail: "You do not have permission to delete this version.",
      });

    const { data: versions, error: versionsErr } = await db
      .from("document_versions")
      .select(
        "id, storage_path, pdf_storage_path, version_number, created_at, deleted_at",
      )
      .eq("document_id", documentId)
      .is("deleted_at", null);
    if (versionsErr) {
      return void sendInternalError(res, versionsErr);
    }

    const rows = (versions ?? []) as {
      id: string;
      storage_path: string | null;
      pdf_storage_path: string | null;
      version_number: number | null;
      created_at: string | null;
      deleted_at?: string | null;
    }[];
    const target = rows.find((row) => row.id === versionId);
    if (!target)
      return void res.status(404).json({ detail: "Version not found" });
    if (rows.length <= 1) {
      return void res
        .status(400)
        .json({ detail: "Cannot delete the only document version." });
    }

    const remaining = rows
      .filter((row) => row.id !== versionId)
      .sort((a, b) => {
        const versionDelta =
          (b.version_number ?? -1) - (a.version_number ?? -1);
        if (versionDelta !== 0) return versionDelta;
        return (
          new Date(b.created_at ?? 0).getTime() -
          new Date(a.created_at ?? 0).getTime()
        );
      });
    const nextCurrentVersionId =
      doc.current_version_id === versionId
        ? (remaining[0]?.id ?? null)
        : doc.current_version_id;
    const deletedAt = new Date().toISOString();

    if (doc.current_version_id === versionId) {
      const { error: updateErr } = await db
        .from("documents")
        .update({
          current_version_id: nextCurrentVersionId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", documentId);
      if (updateErr) {
        return void sendInternalError(res, updateErr);
      }
    }

    const { error: deleteErr } = await db
      .from("document_versions")
      .update({
        storage_path: null,
        pdf_storage_path: null,
        deleted_at: deletedAt,
        deleted_by: userId,
      })
      .eq("id", versionId)
      .eq("document_id", documentId)
      .is("deleted_at", null);
    if (deleteErr) {
      return void sendInternalError(res, deleteErr);
    }

    await Promise.all(
      [target.storage_path, target.pdf_storage_path]
        .filter((path): path is string => !!path)
        .map((path) => deleteFile(path).catch(() => {})),
    );

    res.json({
      deleted_version_id: versionId,
      current_version_id: nextCurrentVersionId,
      deleted_at: deletedAt,
    });
  },
);

// GET /single-documents/:documentId/tracked-change-ids
// Returns the ordered list of { kind, w_id } for every w:ins / w:del in
// the current (or specified) version's document.xml. The frontend uses
// this to tag each rendered <ins>/<del> with data-w-id, since
// docx-preview drops the w:id attribute during parsing.
documentsRouter.get(
  "/:documentId/tracked-change-ids",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const versionIdParam =
      typeof req.query.version_id === "string" ? req.query.version_id : null;
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id, org_id, workflow_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active)
      return void res.status(404).json({ detail: "No file available" });

    const raw = await downloadFile(active.storage_path);
    if (!raw)
      return void res
        .status(404)
        .json({ detail: "Document bytes not available" });

    const ids = await extractTrackedChangeIds(Buffer.from(raw));
    res.json({ ids });
  },
);

// POST /single-documents/:documentId/edits/:editId/accept
// POST /single-documents/:documentId/edits/:editId/reject
async function handleEditResolution(
  req: import("express").Request,
  res: import("express").Response,
  mode: "accept" | "reject",
) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId, editId } = req.params;
  const db = createServerSupabase();

  devLog(`[edit-resolution] incoming ${mode}`, {
    userId,
    documentId,
    editId,
  });

  const { data: edit, error: editErr } = await db
    .from("document_edits")
    .select("id, document_id, change_id, del_w_id, ins_w_id, status")
    .eq("id", editId)
    .eq("document_id", documentId)
    .single();
  devLog(`[edit-resolution] fetched edit row`, { edit, editErr });
  if (!edit) {
    devLog(`[edit-resolution] edit not found, returning 404`);
    return void res.status(404).json({ detail: "Edit not found" });
  }
  // Idempotent: if the edit is already resolved, return the current doc
  // state so stale UI (e.g. an old chat reloaded in a new session) can
  // reconcile without throwing.
  if (edit.status !== "pending") {
    devLog(`[edit-resolution] edit already resolved`, {
      editId,
      status: edit.status,
    });
    const { data: doc } = await db
      .from("documents")
      .select("current_version_id, user_id, project_id, org_id, workflow_id")
      .eq("id", documentId)
      .single();
    if (!doc) {
      devLog(`[edit-resolution] doc not found for resolved edit`);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const accessResolved = await ensureDocAccess(doc, userId, userEmail, db);
    if (!accessResolved.ok) {
      devLog(`[edit-resolution] doc access denied for resolved edit`);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const activeForResolved = await loadActiveVersion(documentId, db);
    const payload = {
      ok: true,
      already_resolved: true,
      status: edit.status,
      version_id: doc.current_version_id ?? null,
      download_url: activeForResolved
        ? buildDownloadUrl(
            activeForResolved.storage_path,
            downloadFilenameForVersion(
              activeForResolved.filename,
              activeForResolved.version_number,
              activeForResolved.source === "assistant_edit",
            ),
          )
        : null,
      remaining_pending: 0,
    };
    devLog(`[edit-resolution] returning already-resolved payload`, payload);
    return void res.status(200).json(payload);
  }

  const { data: doc, error: docErr } = await db
    .from("documents")
    .select("id, current_version_id, user_id, project_id, org_id, workflow_id")
    .eq("id", documentId)
    .single();
  devLog(`[edit-resolution] fetched doc`, { doc, docErr });
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });
  if (!can(access.projectRole, "content.edit"))
    return void res.status(403).json({ detail: DOCUMENT_EDIT_FORBIDDEN });

  const active = await loadActiveVersion(documentId, db);
  const latestPath = active?.storage_path ?? null;
  devLog(`[edit-resolution] resolved latestPath`, {
    latestPath,
    current_version_id: doc.current_version_id,
  });
  if (!latestPath)
    return void res.status(404).json({ detail: "No file to edit" });

  const raw = await downloadFile(latestPath);
  devLog(`[edit-resolution] downloaded bytes`, {
    byteLength: raw?.byteLength ?? 0,
  });
  if (!raw)
    return void res
      .status(404)
      .json({ detail: "Document bytes not available" });

  const wIds = [edit.del_w_id, edit.ins_w_id].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const { bytes: resolvedBytes, found } = await resolveTrackedChange(
    Buffer.from(raw),
    wIds,
    mode,
  );
  devLog(`[edit-resolution] resolveTrackedChange result`, {
    mode,
    change_id: edit.change_id,
    wIds,
    found,
    resolvedByteLength: resolvedBytes?.byteLength ?? 0,
  });
  if (!found) {
    devLog(
      `[edit-resolution] change_id not found in docx — updating status only`,
    );
    // Still update DB status so the UI reflects the decision — the change
    // may have been auto-consumed by a previous accept/reject pass.
    const { error: updErr } = await db
      .from("document_edits")
      .update({
        status: mode === "accept" ? "accepted" : "rejected",
        resolved_at: new Date().toISOString(),
      })
      .eq("id", editId);
    devLog(`[edit-resolution] status-only update`, { updErr });
    const payload = {
      ok: true,
      version_id: doc.current_version_id,
      download_url: buildDownloadUrl(
        latestPath,
        downloadFilenameForVersion(
          active?.filename,
          active?.version_number ?? null,
          active?.source === "assistant_edit",
        ),
      ),
      remaining_pending: 0,
    };
    devLog(`[edit-resolution] returning not-found payload`, payload);
    return void res.status(200).json(payload);
  }

  // Overwrite bytes in place at the current version's storage path —
  // accept/reject mutates the existing version rather than spawning a
  // new row. This keeps document_versions lean (one row per assistant
  // edit, not one per accept/reject click) and avoids the N-versions-
  // per-doc churn as users resolve pending changes.
  const ab = resolvedBytes.buffer.slice(
    resolvedBytes.byteOffset,
    resolvedBytes.byteOffset + resolvedBytes.byteLength,
  ) as ArrayBuffer;

  // Clear the hash before the bytes change, and set it again after. The stored
  // object and the hash live in different systems, so they cannot be written
  // atomically; ordering it this way means a failure in between leaves the
  // version unhashed, which the manifest reports as unverifiable. The
  // alternative ordering can leave a hash attesting to content the version no
  // longer holds, which is the one thing the manifest must never do.
  await db
    .from("document_versions")
    .update({ content_sha256: null })
    .eq("id", doc.current_version_id);

  devLog(`[edit-resolution] overwriting bytes in place`, {
    latestPath,
    byteLength: ab.byteLength,
  });
  await uploadFile(
    latestPath,
    ab,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  // pdf_storage_path: null — the bytes just changed, so any PDF rendition
  // this version carried no longer matches them; a stale rendition would be
  // served by /display and copied onto replicas by replicate_document. In
  // practice assistant_edit versions never carry one (DOCX renders through
  // DocxView from the raw bytes), so this is an invariant write, not a
  // behavior change.
  await db
    .from("document_versions")
    .update({ content_sha256: contentSha256(ab), pdf_storage_path: null })
    .eq("id", doc.current_version_id);

  // The extracted-text cache is keyed on the version id and this is one of
  // only two sites that rewrite a version's bytes in place, so it is one of
  // only two sites where that key could go stale. Resolution always writes
  // DOCX, which is not a cached type, so this deletes nothing today — it is
  // here so the "versions are immutable" assumption the cache rests on stays
  // true by construction rather than by coincidence.
  await enqueueStorageCleanup(db, [
    extractedTextKey(doc.current_version_id as string),
  ]);

  const { error: statusErr } = await db
    .from("document_edits")
    .update({
      status: mode === "accept" ? "accepted" : "rejected",
      resolved_at: new Date().toISOString(),
    })
    .eq("id", editId);
  devLog(`[edit-resolution] updated document_edits status`, {
    editId,
    newStatus: mode === "accept" ? "accepted" : "rejected",
    statusErr,
  });
  const { count: remainingPending } = await db
    .from("document_edits")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .eq("status", "pending");
  devLog(`[edit-resolution] remaining pending count`, { remainingPending });

  const payload = {
    ok: true,
    version_id: doc.current_version_id,
    download_url: buildDownloadUrl(
      latestPath,
      downloadFilenameForVersion(
        active?.filename,
        active?.version_number ?? null,
        active?.source === "assistant_edit",
      ),
    ),
    remaining_pending: remainingPending ?? 0,
  };
  devLog(`[edit-resolution] returning success payload`, payload);
  res.json(payload);
}

documentsRouter.post(
  "/:documentId/edits/:editId/accept",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "accept"),
);

documentsRouter.post(
  "/:documentId/edits/:editId/reject",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "reject"),
);
