import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { logger } from "../lib/logger";
import { parseBody } from "../lib/validate";
import {
  buildContentDisposition,
  downloadFile,
  deleteFile,
  getSignedUrl,
  storageKey,
  uploadFile,
  versionStorageKey,
} from "../lib/storage";
import {
  extractTrackedChangeIds,
  resolveTrackedChange,
} from "../lib/docxTrackedChanges";
import { buildDownloadUrl } from "../lib/downloadTokens";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  loadActiveVersion,
} from "../lib/documentVersions";
import { ensureDocAccess } from "../lib/access";
import {
  cleanupTempFile,
  sanitizeFilename,
  singleFileUpload,
} from "../lib/upload";
import {
  enqueueConversionFromBuffer,
  enqueueConversionForVersion,
} from "../lib/pdfQueue";
import { extractStructureTree } from "../lib/structureTree";

const DownloadZipSchema = z.object({
  document_ids: z.array(z.string().uuid()).min(1),
});

export const documentsRouter = Router();
const ALLOWED_TYPES = new Set(["pdf", "docx", "doc"]);

// ---------------------------------------------------------------------------
// CLEAN-08: version-number uniqueness — retry-on-23505 helper
// ---------------------------------------------------------------------------

const UNIQUE_VIOLATION = "23505";

/**
 * Insert a new document_version row, retrying once if Postgres returns a
 * 23505 unique_violation (TOCTOU race where two concurrent uploads both
 * computed the same MAX+1).
 *
 * On first 23505: re-fetches MAX from DB and retries with MAX+1.
 * On any other error, or on a second 23505: surfaces the error unchanged.
 */
export async function insertVersionWithRetry(
  db: ReturnType<typeof createServerSupabase>,
  documentId: string,
  payload: Record<string, unknown>,
): Promise<{ data: { id: string; version_number: number } | null; error: unknown }> {
  const fetchMax = async (): Promise<number> => {
    const { data: maxRow } = await db
      .from("document_versions")
      .select("version_number")
      .eq("document_id", documentId)
      .in("source", ["upload", "user_upload", "assistant_edit"])
      .order("version_number", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    return ((maxRow?.version_number as number | null) ?? 1) + 1;
  };

  const firstNum = await fetchMax();
  let result = await db
    .from("document_versions")
    .insert({ ...payload, version_number: firstNum })
    .select("id, version_number")
    .single();

  if ((result.error as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
    // Race detected: re-fetch MAX and retry once
    const retryNum = await fetchMax();
    result = await db
      .from("document_versions")
      .insert({ ...payload, version_number: retryNum })
      .select("id, version_number")
      .single();
  }

  return result as { data: { id: string; version_number: number } | null; error: unknown };
}

// ---------------------------------------------------------------------------
// CLEAN-09 + CLEAN-34: edit-resolution compensating saga
// ---------------------------------------------------------------------------

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface EditResolutionSagaResult {
  ok: boolean;
  status: number;
  detail?: string;
}

/**
 * Apply edit-resolution bytes to storage and record DB status as a
 * compensating saga:
 *
 *   1. Download prior bytes (for rollback).
 *   2. Upload new bytes.
 *   3. Update DB status.
 *   4. If DB fails: re-upload prior bytes (compensating rollback).
 *
 * Returns `{ ok: true }` on success or `{ ok: false, status, detail }` on
 * any failure. Callers are responsible for returning the HTTP response.
 */
export async function applyEditResolutionSaga(deps: {
  latestPath: string;
  newBytes: ArrayBuffer;
  status: "accepted" | "rejected";
  editId: string;
  uploadFn: (key: string, body: ArrayBuffer, mime: string) => Promise<void>;
  downloadFn: (key: string) => Promise<ArrayBuffer | null>;
  dbUpdateFn: (
    status: "accepted" | "rejected",
    editId: string,
  ) => Promise<{ error: unknown }>;
}): Promise<EditResolutionSagaResult> {
  const { latestPath, newBytes, status, editId, uploadFn, downloadFn, dbUpdateFn } = deps;

  // Step 1: snapshot prior bytes for rollback
  const priorBytes = await downloadFn(latestPath);

  // Step 2: upload new bytes
  try {
    await uploadFn(latestPath, newBytes, DOCX_MIME);
  } catch (uploadErr) {
    logger.error({ err: uploadErr }, "[edit-resolution] storage upload failed");
    return { ok: false, status: 500, detail: "Storage write failed during edit resolution." };
  }

  // Step 3: update DB status
  const { error: statusErr } = await dbUpdateFn(status, editId);

  if (statusErr) {
    logger.error({ err: statusErr }, "[edit-resolution] DB status update failed after storage write — compensating rollback");
    // Step 4: compensating rollback — restore prior bytes
    if (priorBytes) {
      try {
        await uploadFn(latestPath, priorBytes, DOCX_MIME);
      } catch (rollbackErr) {
        logger.error({ err: rollbackErr }, "[edit-resolution] CRITICAL: compensating rollback failed — storage may be inconsistent");
      }
    }
    return { ok: false, status: 500, detail: "Status update failed during edit resolution." };
  }

  return { ok: true, status: 200 };
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
    .order("created_at", { ascending: false });
  if (error) return void res.status(500).json({ detail: error.message });
  const docs = (data ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docs);
  await attachActiveVersionPaths(db, docs);
  res.json(docs);
});

// POST /single-documents
documentsRouter.post(
  "/",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    await handleDocumentUpload(req, res, userId, null, db);
  },
);

// DELETE /single-documents/:documentId
documentsRouter.delete("/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });

  // Storage now lives on document_versions — fan out and delete each
  // version's bytes (DOCX + PDF rendition) before dropping rows.
  const { data: versions } = await db
    .from("document_versions")
    .select("storage_path, pdf_storage_path")
    .eq("document_id", documentId);
  await Promise.all(
    (versions ?? []).flatMap((v) =>
      [v.storage_path, v.pdf_storage_path]
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .map((p) => deleteFile(p).catch(() => {})),
    ),
  );
  await db.from("documents").delete().eq("id", documentId);
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
    .select("id, filename, file_type, user_id, project_id")
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

  const fileType = (doc.file_type as string) ?? "";
  const isDocx = fileType === "docx" || fileType === "doc";

  // For DOCX, prefer the per-version PDF rendition if one exists.
  const servePath =
    isDocx && active.pdf_storage_path
      ? active.pdf_storage_path
      : active.storage_path;
  const raw = await downloadFile(servePath);
  if (!raw)
    return void res
      .status(404)
      .json({ detail: "Document not found in storage" });

  if (fileType === "pdf" || (isDocx && active.pdf_storage_path)) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", doc.filename as string),
    );
    res.send(Buffer.from(raw));
  } else {
    // Fallback: serve raw DOCX (mammoth will handle it client-side)
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", doc.filename as string),
    );
    res.send(Buffer.from(raw));
  }
});

// POST /single-documents/download-zip
documentsRouter.post("/download-zip", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const zipBody = parseBody(DownloadZipSchema, req, res);
  if (!zipBody) return;
  const { document_ids } = zipBody;

  const db = createServerSupabase();
  const { data: rawDocs, error } = await db
    .from("documents")
    .select("id, filename, file_type, current_version_id, user_id, project_id")
    .in("id", document_ids);

  if (error) return void res.status(500).json({ detail: error.message });
  // Filter to docs the user actually has access to (own + shared-project).
  const accessChecks = await Promise.all(
    (rawDocs ?? []).map(async (d) => ({
      doc: d,
      access: await ensureDocAccess(
        d as { user_id: string; project_id: string | null },
        userId,
        userEmail,
        db,
      ),
    })),
  );
  const accessibleDocs = accessChecks
    .filter((x) => x.access.ok)
    .map((x) => x.doc as { id: string; filename: string });

  // CLEAN-25: collect IDs the requester named that we DROPPED so the client
  // can surface a partial-response toast.  Only IDs from the original request
  // body can appear here — no third-party ID disclosure.
  const accessibleIdSet = new Set(accessibleDocs.map((d) => d.id));
  const skippedIds = document_ids.filter((id) => !accessibleIdSet.has(id));

  if (accessibleDocs.length === 0)
    return void res.status(404).json({ detail: "No documents found" });

  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  await Promise.all(
    accessibleDocs.map(async (doc) => {
      const active = await loadActiveVersion(doc.id, db);
      if (!active) return;
      const raw = await downloadFile(active.storage_path);
      if (!raw) return;
      zip.file(doc.filename, Buffer.from(raw));
    }),
  );

  const content = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="documents.zip"');
  if (skippedIds.length > 0) {
    res.setHeader("X-Docs-Skipped", skippedIds.join(","));
  }
  res.send(content);
});

// GET /single-documents/:documentId/url
// Optional ?version_id= selects a specific tracked-changes version.
// Otherwise falls back to documents.current_version_id, else the original upload.
documentsRouter.get("/:documentId/url", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, filename, user_id, project_id")
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

  const downloadFilename = resolveDownloadFilename(
    doc.filename as string,
    active.display_name,
    active.version_number,
  );
  const url = await getSignedUrl(
    active.storage_path,
    3600,
    downloadFilename,
  );
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
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, filename, user_id, project_id")
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
    return void res.status(404).json({ detail: "Document bytes not available" });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition(
      "inline",
      resolveDownloadFilename(
        doc.filename as string,
        active.display_name,
        active.version_number,
      ),
    ),
  );
  res.send(Buffer.from(raw));
});

// Compose a download-friendly filename that carries the edit version
// marker: "Purchase Agreement.docx" → "Purchase Agreement [Edited V2].docx".
// Preserves the original extension (fallback: .docx).
function versionedFilename(filename: string, version: number | null): string {
  if (!version || version < 1) return filename;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : ".docx";
  return `${stem} [Edited V${version}]${ext}`;
}

// Produce the filename a download should present to the user for a given
// (document, version) pair. Prefers the version's display_name (appending
// the original extension if the user didn't include one), falling back to
// the versionedFilename heuristic.
function resolveDownloadFilename(
  originalFilename: string,
  displayName: string | null | undefined,
  versionNumber: number | null,
): string {
  const dot = originalFilename.lastIndexOf(".");
  const origExt = dot > 0 ? originalFilename.slice(dot) : "";
  if (displayName && displayName.trim()) {
    const trimmed = displayName.trim();
    const trimmedDot = trimmed.lastIndexOf(".");
    const hasExt =
      trimmedDot > 0 &&
      trimmed
        .slice(trimmedDot)
        .toLowerCase()
        .match(/^\.[a-z0-9]{1,6}$/);
    if (hasExt) return trimmed;
    return origExt ? `${trimmed}${origExt}` : trimmed;
  }
  return versionedFilename(originalFilename, versionNumber);
}

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
    .select("id, current_version_id, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const { data: rows } = await db
    .from("document_versions")
    .select("id, version_number, source, created_at, display_name")
    .eq("document_id", documentId)
    .order("created_at", { ascending: true });

  res.json({
    current_version_id: doc.current_version_id,
    versions: rows ?? [],
  });
});

// POST /single-documents/:documentId/versions
// Upload a brand-new version of an existing document. The uploaded file
// becomes the new current_version_id. display_name defaults to the
// uploaded filename; client may override via the `display_name` form field.
documentsRouter.post(
  "/:documentId/versions",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const db = createServerSupabase();

    const file = req.file;
    if (!file)
      return void res.status(400).json({ detail: "file is required" });

    const { data: doc } = await db
      .from("documents")
      .select("id, filename, file_type, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc) {
      await cleanupTempFile(file.path);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok) {
      await cleanupTempFile(file.path);
      return void res.status(404).json({ detail: "Document not found" });
    }

    // Reject if the uploaded file's extension doesn't match the document's
    // declared type — otherwise every downstream viewer/extractor breaks.
    const safeVersionFilename = sanitizeFilename(file.originalname);
    const suffix = safeVersionFilename.includes(".")
      ? safeVersionFilename.split(".").pop()!.toLowerCase()
      : "";
    if (doc.file_type && suffix && doc.file_type !== suffix) {
      await cleanupTempFile(file.path);
      return void res.status(400).json({
        detail: `Uploaded file type (${suffix}) does not match document type (${doc.file_type}).`,
      });
    }

    // Peg the new version into a predictable /versions/:id path under the
    // existing document folder so ops can spot the history in storage.
    const versionSlug = randomUUID().replace(/-/g, "");
    const key = versionStorageKey(
      userId,
      documentId,
      versionSlug,
      safeVersionFilename,
    );
    const contentType =
      suffix === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    let versionContent: Buffer;
    try {
      versionContent = await readFile(file.path);
    } catch (e) {
      logger.error({ err: e }, "[versions/upload] could not read temp file");
      await cleanupTempFile(file.path);
      return void res
        .status(500)
        .json({ detail: "Failed to read uploaded file." });
    }

    try {
      await uploadFile(
        key,
        versionContent.buffer.slice(
          versionContent.byteOffset,
          versionContent.byteOffset + versionContent.byteLength,
        ) as ArrayBuffer,
        contentType,
      );
    } catch (e) {
      logger.error({ err: e }, "[versions/upload] storage write failed");
      await cleanupTempFile(file.path);
      return void res
        .status(500)
        .json({ detail: "Failed to upload new version." });
    }

    // Enqueue DOCX→PDF conversion in background so /display can show
    // PDF rendition without blocking the request. Failures are non-fatal
    // and will set pdf_conversion_status to 'failed'.
    let pdfStoragePath: string | null = null;
    if (suffix === "pdf") {
      // For PDF uploads, the uploaded bytes are themselves the PDF rendition.
      pdfStoragePath = key;
    }

    // Per-document sequential version_number — the upload is V1 and
    // user_upload + assistant_edit count forward from there.
    // insertVersionWithRetry handles 23505 unique_violation races (CLEAN-08).
    const defaultDisplayName =
      typeof req.body?.display_name === "string" &&
      req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : safeVersionFilename;

    const { data: versionRow, error: verErr } = await insertVersionWithRetry(db, documentId, {
      document_id: documentId,
      storage_path: key,
      pdf_storage_path: pdfStoragePath,
      source: "user_upload",
      display_name: defaultDisplayName,
    });
    if (verErr || !versionRow) {
      logger.error({ err: verErr }, "[versions/upload] insert failed");
      await cleanupTempFile(file.path);
      return void res
        .status(500)
        .json({ detail: "Failed to record new version." });
    }
    // Re-fetch the full version row so we have all fields (insertVersionWithRetry
    // returns only id + version_number from the select).
    const { data: fullVersionRow } = await db
      .from("document_versions")
      .select("id, version_number, source, created_at, display_name, storage_path")
      .eq("id", versionRow.id)
      .single();

    // Enqueue background DOCX→PDF conversion for the new version.
    if (suffix === "docx" || suffix === "doc") {
      void enqueueConversionForVersion(
        documentId,
        { id: versionRow.id as string, storage_path: key },
        db,
      );
    }

    // Also propagate the user-provided display_name to the parent document's
    // filename so the document's display name stays in sync across the UI.
    // Preserve a sensible extension: if the display_name has none, append
    // the uploaded file's extension (fallback: the existing doc's extension).
    const documentsUpdate: Record<string, unknown> = {
      current_version_id: versionRow.id,
    };
    const providedDisplayName =
      typeof req.body?.display_name === "string" &&
      req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : null;
    if (providedDisplayName) {
      const hasExt = /\.[a-z0-9]{1,6}$/i.test(providedDisplayName);
      const existingExt = (doc.filename as string | null)?.match(
        /\.[a-z0-9]{1,6}$/i,
      )?.[0];
      const uploadedExt = suffix ? `.${suffix}` : "";
      const ext = hasExt ? "" : uploadedExt || existingExt || "";
      documentsUpdate.filename = `${providedDisplayName}${ext}`;
    }
    await db
      .from("documents")
      .update(documentsUpdate)
      .eq("id", documentId);

    await cleanupTempFile(file.path);
    // Use fullVersionRow (all fields) for response, falling back to versionRow if re-fetch failed.
    // Exclude internal storage_path from the API response.
    const responseRow = fullVersionRow ?? versionRow;
    const { storage_path: _sp, ...versionRowPublic } = responseRow as typeof responseRow & { storage_path?: string };
    res.status(201).json(versionRowPublic);
  },
);

// PATCH /single-documents/:documentId/versions/:versionId
// Rename a version's display_name. Pass `{ "display_name": "…" }`; an empty
// or missing value clears the override so the UI falls back to V{n}.
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
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const raw = req.body?.display_name;
    const displayName =
      typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : null;

    const { data: updated, error } = await db
      .from("document_versions")
      .update({ display_name: displayName })
      .eq("id", versionId)
      .eq("document_id", documentId)
      .select("id, version_number, source, created_at, display_name")
      .single();
    if (error || !updated) {
      return void res.status(404).json({ detail: "Version not found" });
    }
    res.json(updated);
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
      .select("id, user_id, project_id")
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

  logger.info({ userId, documentId, editId, mode }, "[edit-resolution] incoming");

  const { data: edit, error: editErr } = await db
    .from("document_edits")
    .select("id, document_id, change_id, del_w_id, ins_w_id, status")
    .eq("id", editId)
    .eq("document_id", documentId)
    .single();
  logger.info({ edit, editErr }, "[edit-resolution] fetched edit row");
  if (!edit) {
    logger.info({ editId }, "[edit-resolution] edit not found, returning 404");
    return void res.status(404).json({ detail: "Edit not found" });
  }
  // Idempotent: if the edit is already resolved, return the current doc
  // state so stale UI (e.g. an old chat reloaded in a new session) can
  // reconcile without throwing.
  if (edit.status !== "pending") {
    logger.info({ editId, status: edit.status }, "[edit-resolution] edit already resolved");
    const { data: doc } = await db
      .from("documents")
      .select("current_version_id, filename, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc) {
      logger.info({ documentId }, "[edit-resolution] doc not found for resolved edit");
      return void res.status(404).json({ detail: "Document not found" });
    }
    const accessResolved = await ensureDocAccess(doc, userId, userEmail, db);
    if (!accessResolved.ok) {
      logger.info({ documentId, userId }, "[edit-resolution] doc access denied for resolved edit");
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
            (doc.filename as string) ?? "document.docx",
          )
        : null,
      remaining_pending: 0,
    };
    logger.info({ payload }, "[edit-resolution] returning already-resolved payload");
    return void res.status(200).json(payload);
  }

  const { data: doc, error: docErr } = await db
    .from("documents")
    .select("id, current_version_id, user_id, project_id")
    .eq("id", documentId)
    .single();
  logger.info({ doc, docErr }, "[edit-resolution] fetched doc");
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db);
  const latestPath = active?.storage_path ?? null;
  logger.info({ latestPath, currentVersionId: doc.current_version_id }, "[edit-resolution] resolved latestPath");
  if (!latestPath)
    return void res.status(404).json({ detail: "No file to edit" });

  const raw = await downloadFile(latestPath);
  logger.info({ byteLength: raw?.byteLength ?? 0 }, "[edit-resolution] downloaded bytes");
  if (!raw)
    return void res.status(404).json({ detail: "Document bytes not available" });

  const wIds = [edit.del_w_id, edit.ins_w_id].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const { bytes: resolvedBytes, found } = await resolveTrackedChange(
    Buffer.from(raw),
    wIds,
    mode,
  );
  logger.info({ mode, changeId: edit.change_id, wIds, found, resolvedByteLength: resolvedBytes?.byteLength ?? 0 }, "[edit-resolution] resolveTrackedChange result");
  if (!found) {
    logger.info({ changeId: edit.change_id }, "[edit-resolution] change_id not found in docx — updating status only");
    // Still update DB status so the UI reflects the decision — the change
    // may have been auto-consumed by a previous accept/reject pass.
    const { error: updErr } = await db
      .from("document_edits")
      .update({ status: mode === "accept" ? "accepted" : "rejected", resolved_at: new Date().toISOString() })
      .eq("id", editId);
    logger.info({ updErr }, "[edit-resolution] status-only update");
    const { data: filenameRow } = await db
      .from("documents")
      .select("filename")
      .eq("id", documentId)
      .single();
    const payload = {
      ok: true,
      version_id: doc.current_version_id,
      download_url: buildDownloadUrl(
        latestPath,
        (filenameRow?.filename as string) ?? "document.docx",
      ),
      remaining_pending: 0,
    };
    logger.info({ payload }, "[edit-resolution] returning not-found payload");
    return void res.status(200).json(payload);
  }

  // Overwrite bytes in place at the current version's storage path —
  // accept/reject mutates the existing version rather than spawning a
  // new row. This keeps document_versions lean (one row per assistant
  // edit, not one per accept/reject click) and avoids the N-versions-
  // per-doc churn as users resolve pending changes.
  //
  // CLEAN-09 + CLEAN-34: applyEditResolutionSaga sequences download-prior →
  // upload-new → DB-update with a compensating re-upload on DB failure so
  // storage and DB stay consistent.
  const ab = resolvedBytes.buffer.slice(
    resolvedBytes.byteOffset,
    resolvedBytes.byteOffset + resolvedBytes.byteLength,
  ) as ArrayBuffer;
  logger.info({ latestPath, byteLength: ab.byteLength }, "[edit-resolution] overwriting bytes in place via saga");

  const resolvedStatus = mode === "accept" ? "accepted" : "rejected";
  const sagaResult = await applyEditResolutionSaga({
    latestPath,
    newBytes: ab,
    status: resolvedStatus,
    editId,
    uploadFn: uploadFile,
    downloadFn: downloadFile,
    dbUpdateFn: async (status, editId) => {
      return db
        .from("document_edits")
        .update({
          status,
          resolved_at: new Date().toISOString(),
        })
        .eq("id", editId);
    },
  });

  logger.info({ editId, newStatus: resolvedStatus, ok: sagaResult.ok }, "[edit-resolution] saga result");

  if (!sagaResult.ok) {
    return void res.status(sagaResult.status).json({ detail: sagaResult.detail });
  }

  const { count: remainingPending } = await db
    .from("document_edits")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .eq("status", "pending");
  logger.info({ remainingPending }, "[edit-resolution] remaining pending count");

  const { data: filenameRow } = await db
    .from("documents")
    .select("filename")
    .eq("id", documentId)
    .single();
  const payload = {
    ok: true,
    version_id: doc.current_version_id,
    download_url: buildDownloadUrl(
      latestPath,
      (filenameRow?.filename as string) ?? "document.docx",
    ),
    remaining_pending: remainingPending ?? 0,
  };
  logger.info({ payload }, "[edit-resolution] returning success payload");
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

// POST /single-documents/:documentId/regenerate-pdf
// Re-enqueues the DOCX→PDF conversion for an existing document.
// Returns 202 immediately with pdf_conversion_status: "pending".
// Rejects non-DOCX/DOC with 400; rejects missing/unauthorized with 404.
documentsRouter.post(
  "/:documentId/regenerate-pdf",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select("id, file_type, user_id, project_id, current_version_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });

    const access = await ensureDocAccess(doc, userId, userEmail ?? "", db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const fileType = doc.file_type as string;
    if (fileType !== "docx" && fileType !== "doc") {
      return void res
        .status(400)
        .json({ detail: "PDF regeneration only applies to DOCX/DOC documents." });
    }

    await db
      .from("documents")
      .update({ pdf_conversion_status: "pending" })
      .eq("id", documentId);

    const active = await loadActiveVersion(documentId, db);
    if (active) {
      void enqueueConversionForVersion(documentId, active, db);
    }

    return void res.status(202).json({ pdf_conversion_status: "pending" });
  },
);

async function handleDocumentUpload(
  req: import("express").Request,
  res: import("express").Response,
  userId: string,
  projectId: string | null,
  db: ReturnType<typeof createServerSupabase>,
) {
  const file = req.file;
  if (!file) return void res.status(400).json({ detail: "file is required" });

  // sanitizeFilename must run before the storage key is constructed (CLEAN-26).
  const filename = sanitizeFilename(file.originalname);
  const suffix = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : "";
  if (!ALLOWED_TYPES.has(suffix)) {
    await cleanupTempFile(file.path);
    return void res.status(400).json({
      detail: `Unsupported file type: ${suffix}. Allowed: pdf, docx, doc`,
    });
  }

  // Read bytes from the temp file (diskStorage writes to path, not buffer).
  // This must happen before the temp file is cleaned up in the finally block.
  let content: Buffer;
  try {
    content = await readFile(file.path);
  } catch (readErr) {
    logger.error({ err: readErr }, "[upload] could not read temp file");
    await cleanupTempFile(file.path);
    return void res.status(500).json({ detail: "Failed to read uploaded file" });
  }

  const { data: doc, error: insertErr } = await db
    .from("documents")
    .insert({
      project_id: projectId,
      user_id: userId,
      filename,
      file_type: suffix,
      size_bytes: content.byteLength,
      status: "processing",
      pdf_conversion_status: "pending",
    })
    .select("*")
    .single();
  if (insertErr || !doc) {
    await cleanupTempFile(file.path);
    return void res
      .status(500)
      .json({ detail: "Failed to create document record" });
  }

  try {
    const docId = doc.id as string;
    const key = storageKey(userId, docId, filename);
    const contentType =
      suffix === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    await uploadFile(
      key,
      content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer,
      contentType,
    );

    const rawBuf = content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
    const tree = await extractStructureTree(rawBuf, suffix);
    const pageCount = suffix === "pdf" ? await countPdfPages(rawBuf) : null;

    // For PDF uploads the file is its own rendition; DOCX/DOC conversion is
    // enqueued in the background so the request can return immediately.
    let pdfStoragePath: string | null = null;
    if (suffix === "pdf") {
      pdfStoragePath = key;
    }

    // storage_path / pdf_storage_path live on document_versions now —
    // create the V1 "upload" row and point documents.current_version_id
    // at it.
    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: docId,
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        source: "upload",
        version_number: 1,
        display_name: filename,
      })
      .select("id")
      .single();
    if (verErr || !versionRow) {
      throw new Error(
        `Failed to record upload version: ${verErr?.message ?? "unknown"}`,
      );
    }

    // Enqueue background PDF conversion for DOCX/DOC uploads (CLEAN-20).
    // Pass the in-memory buffer so it survives temp-file cleanup below.
    if (suffix === "docx" || suffix === "doc") {
      void enqueueConversionFromBuffer({
        documentId: docId,
        versionId: versionRow.id,
        userId,
        docxBuffer: content,
      });
    }

    await db
      .from("documents")
      .update({
        current_version_id: versionRow.id,
        size_bytes: content.byteLength,
        page_count: pageCount,
        structure_tree: tree ?? null,
        status: "ready",
        updated_at: new Date().toISOString(),
      })
      .eq("id", docId);

    const { data: updated } = await db
      .from("documents")
      .select("*")
      .eq("id", docId)
      .single();
    // Surface storage paths to the caller for backward compatibility.
    const responseDoc = updated
      ? { ...updated, storage_path: key, pdf_storage_path: pdfStoragePath }
      : updated;
    return void res.status(201).json(responseDoc);
  } catch (e) {
    await db.from("documents").update({ status: "error" }).eq("id", doc.id);
    return void res
      .status(500)
      .json({ detail: `Document processing failed: ${String(e)}` });
  } finally {
    await cleanupTempFile(file.path);
  }
}

async function countPdfPages(buf: ArrayBuffer): Promise<number | null> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{ numPages: number }>;
        };
      }
    ).getDocument({ data: new Uint8Array(buf) }).promise;
    return pdf.numPages;
  } catch {
    return null;
  }
}

