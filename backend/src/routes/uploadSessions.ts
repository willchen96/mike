import { randomUUID } from "node:crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";

import {
  can,
  checkProjectAccess,
  checkWorkflowAccess,
  creatorScopedAllowed,
  ensureDocAccess,
} from "../lib/access";
import { mapWithConcurrency } from "../lib/concurrency";
import { sendInternalError } from "../lib/httpError";
import { uploadSessionRateLimitConfiguration } from "../lib/runtimeConfig";
import {
  copyFile,
  deleteFile,
  getSignedUploadUrl,
  headFile,
  StorageOperationError,
  storageEnabled,
} from "../lib/storage";
import { createServerSupabase } from "../lib/supabase";
import {
  parseUploadSessionRequest,
  uploadSessionExpiresAt,
  UploadSessionValidationError,
  UPLOAD_URL_TTL_SECONDS,
  UPLOAD_VERIFICATION_LEASE_SECONDS,
  type ParsedUploadSessionRequest,
  type UploadSessionFile,
} from "../lib/uploadSessions";
import { requireAuth } from "../middleware/auth";

export const uploadSessionsRouter = Router();

const uploadRateLimits = uploadSessionRateLimitConfiguration();

const uploadSessionMutationLimiter = rateLimit({
  windowMs: uploadRateLimits.mutationWindowMinutes * 60 * 1000,
  max: uploadRateLimits.mutationMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => String(res.locals.userId),
  message: {
    code: "upload_session_control_rate_limit",
    detail: "Too many upload requests. Please try again later.",
  },
});

// Key by the authenticated user, not the caller-supplied session id, so random
// path segments cannot create unlimited limiter buckets. The client backs off
// status polling, while this independent ceiling protects the API from abuse.
const uploadSessionPollingLimiter = rateLimit({
  windowMs: uploadRateLimits.pollingWindowMinutes * 60 * 1000,
  max: uploadRateLimits.pollingMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => String(res.locals.userId),
  message: {
    code: "upload_session_poll_rate_limit",
    detail: "Upload status was checked too often. Please try again shortly.",
  },
});

const sessionIdSchema = z.string().uuid();
const fileCompletionRequestSchema = z
  .object({ failed: z.boolean().default(false) })
  .strict();

uploadSessionsRouter.param("sessionId", (_req, res, next, value) => {
  if (!sessionIdSchema.safeParse(value).success) {
    return void res.status(404).json({ detail: "Upload session not found" });
  }
  next();
});

uploadSessionsRouter.param("fileId", (_req, res, next, value) => {
  if (!sessionIdSchema.safeParse(value).success) {
    return void res.status(404).json({ detail: "Upload file not found" });
  }
  next();
});

type Db = ReturnType<typeof createServerSupabase>;
type AsyncRoute = (req: Request, res: Response) => Promise<unknown>;

type UploadSessionRow = {
  id: string;
  user_id: string;
  user_email: string | null;
  purpose: string;
  destination: Record<string, unknown>;
  expected_file_count: number;
  expected_total_bytes: number;
  status: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

type UploadSessionFileRow = UploadSessionFile & {
  session_id: string;
  observed_size_bytes: number | null;
  etag: string | null;
  status: string;
  error_code: string | null;
  result: unknown;
  created_at: string;
  updated_at: string;
};

function asyncRoute(handler: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

function publicFile(file: UploadSessionFileRow | UploadSessionFile) {
  return {
    id: file.id,
    resource_id: file.resource_id,
    client_id: file.client_id,
    filename: file.filename,
    target_folder_id: file.target_folder_id,
    file_type: file.file_type,
    content_type: file.content_type,
    expected_size_bytes: file.expected_size_bytes,
    observed_size_bytes:
      "observed_size_bytes" in file ? file.observed_size_bytes : null,
    status: "status" in file ? file.status : "pending_upload",
    error_code: "error_code" in file ? file.error_code : null,
    result: "result" in file ? file.result : null,
  };
}

export async function validateDestinationAccess(
  manifest: ParsedUploadSessionRequest,
  userId: string,
  userEmail: string | undefined,
  db: Db,
  res: Response,
): Promise<boolean> {
  const destination = manifest.destination as Record<string, unknown>;

  if (manifest.purpose === "document_create") {
    if (destination.scope === "standalone") return true;
    if (destination.scope === "workflow") {
      const workflowId = destination.workflow_id as string;
      const { data: workflow, error } = await db
        .from("workflows")
        .select("id, user_id, type")
        .eq("id", workflowId)
        .maybeSingle();
      if (error) {
        sendInternalError(res, error);
        return false;
      }
      if (!workflow || workflow.type !== "assistant") {
        res.status(404).json({ detail: "Workflow not found or not editable" });
        return false;
      }
      const workflowAccess = await checkWorkflowAccess(
        workflowId,
        userId,
        userEmail,
        db,
      );
      if (
        workflowAccess.ok &&
        can(workflowAccess.projectRole, "content.edit")
      )
        return true;
      res.status(404).json({ detail: "Workflow not found or not editable" });
      return false;
    }
    if (destination.scope === "project") {
      const projectId = destination.project_id as string;
      const access = await checkProjectAccess(projectId, userId, userEmail, db);
      // Uploading into a project is content work: a viewer can open the
      // project but must not be able to open an upload session into it. That
      // viewer is refused, not told the project vanished.
      if (!access.ok) {
        res.status(404).json({ detail: "Project not found" });
        return false;
      }
      if (!can(access.projectRole, "content.edit")) {
        res.status(403).json({
          detail: "You do not have permission to write in this project.",
        });
        return false;
      }
      const folderIds = Array.from(
        new Set(
          [
            destination.folder_id as string | null | undefined,
            ...manifest.files.map((file) => file.target_folder_id),
          ].filter((value): value is string => !!value),
        ),
      );
      if (folderIds.length) {
        const { data, error } = await db
          .from("project_subfolders")
          .select("id")
          .eq("project_id", projectId)
          .in("id", folderIds);
        if (error) {
          sendInternalError(res, error);
          return false;
        }
        if ((data ?? []).length !== folderIds.length) {
          res.status(404).json({ detail: "Folder not found" });
          return false;
        }
      }
      return true;
    }

    const folderIds = Array.from(
      new Set(
        [
          destination.folder_id as string | null | undefined,
          ...manifest.files.map((file) => file.target_folder_id),
        ].filter((value): value is string => !!value),
      ),
    );
    if (!folderIds.length) return true;
    const { data, error } = await db
      .from("library_folders")
      .select("id")
      .eq("user_id", userId)
      .eq("library_kind", destination.library_kind as string)
      .in("id", folderIds);
    if (error) {
      sendInternalError(res, error);
      return false;
    }
    if ((data ?? []).length !== folderIds.length) {
      res.status(404).json({ detail: "Folder not found" });
      return false;
    }
    return true;
  }

  if (
    manifest.purpose === "document_version_create" ||
    manifest.purpose === "document_version_replace"
  ) {
    const documentId = destination.document_id as string;
    const { data: document, error } = await db
      .from("documents")
      .select("id, user_id, project_id, org_id, workflow_id")
      .eq("id", documentId)
      .maybeSingle();
    if (error) {
      sendInternalError(res, error);
      return false;
    }
    if (!document) {
      res.status(404).json({ detail: "Document not found" });
      return false;
    }
    const access = await ensureDocAccess(document, userId, userEmail, db);
    const canEditContent =
      access.ok && can(access.projectRole, "content.edit");
    // Replacing a version is creator-scoped (with the admin heir once the
    // creator's account is gone); workflow assets stay editable at the
    // workflow share's edit tier.
    const canReplace =
      access.ok &&
      (creatorScopedAllowed(access, document.user_id) ||
        (Boolean(document.workflow_id) && canEditContent));
    // Split, the way the project branch above already splits: no verdict at
    // all is a 404, and a caller who can open the document but not write to
    // it is refused by name. Collapsing both into 404 told every Viewer
    // their document had disappeared the moment they tried to upload.
    if (!access.ok) {
      res.status(404).json({ detail: "Document not found" });
      return false;
    }
    if (!canEditContent) {
      res.status(403).json({
        detail: "You do not have permission to edit content in this project.",
      });
      return false;
    }
    if (manifest.purpose === "document_version_replace" && !canReplace) {
      res.status(403).json({
        detail: "You do not have permission to replace this version.",
      });
      return false;
    }
    if (manifest.purpose === "document_version_create") return true;

    const { data: version, error: versionError } = await db
      .from("document_versions")
      .select("id, file_type, deleted_at")
      .eq("id", destination.version_id as string)
      .eq("document_id", documentId)
      .maybeSingle();
    if (versionError) {
      sendInternalError(res, versionError);
      return false;
    }
    if (!version || version.deleted_at) {
      res.status(404).json({ detail: "Version not found" });
      return false;
    }
    if (
      version.file_type &&
      version.file_type !== manifest.files[0].file_type
    ) {
      res.status(400).json({
        detail: `Uploaded file type (${manifest.files[0].file_type}) does not match version type (${version.file_type}).`,
      });
      return false;
    }
    return true;
  }

  const workflowId = destination.workflow_id as string;
  const { data: workflow, error } = await db
    .from("workflows")
    .select("id, user_id, type")
    .eq("id", workflowId)
    .maybeSingle();
  if (error) {
    sendInternalError(res, error);
    return false;
  }
  if (!workflow) {
    res.status(404).json({ detail: "Workflow not found or not editable" });
    return false;
  }

  const workflowAccess = await checkWorkflowAccess(
    workflowId,
    userId,
    userEmail,
    db,
  );
  const canEdit =
    workflowAccess.ok && can(workflowAccess.projectRole, "content.edit");
  if (!canEdit) {
    res.status(404).json({ detail: "Workflow not found or not editable" });
    return false;
  }
  if (workflow.type === "tabular") {
    res.status(400).json({
      detail: "Assets are only supported for assistant workflows",
    });
    return false;
  }

  // Compatibility validation for in-flight sessions created by the previous
  // release. New clients use document_version_create.
  if (manifest.purpose === "workflow_reference_replace") {
    const { data: asset, error: assetError } = await db
      .from("documents")
      .select("id")
      .eq("id", destination.reference_id as string)
      .eq("workflow_id", workflowId)
      .maybeSingle();
    if (assetError) {
      sendInternalError(res, assetError);
      return false;
    }
    if (!asset) {
      res.status(404).json({ detail: "Asset not found" });
      return false;
    }
  }
  return true;
}

async function loadOwnedSession(
  db: Db,
  sessionId: string,
  userId: string,
): Promise<UploadSessionRow | null> {
  const { data, error } = await db
    .from("upload_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as UploadSessionRow | null) ?? null;
}

async function loadSessionFiles(
  db: Db,
  sessionId: string,
): Promise<UploadSessionFileRow[]> {
  const { data, error } = await db
    .from("upload_session_files")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as UploadSessionFileRow[];
}

function signedUrlTtl(expiresAt: string): number {
  const remainingSeconds = Math.floor(
    (new Date(expiresAt).getTime() - Date.now()) / 1000,
  );
  return Math.max(1, Math.min(UPLOAD_URL_TTL_SECONDS, remainingSeconds));
}

async function signPendingFiles(
  files: Array<UploadSessionFileRow | UploadSessionFile>,
  expiresAt: string,
) {
  const ttl = signedUrlTtl(expiresAt);
  return await Promise.all(
    files.map(async (file) => {
      const url = await getSignedUploadUrl(
        file.staging_storage_path,
        file.content_type,
        file.expected_size_bytes,
        ttl,
      );
      if (!url) throw new Error("Failed to create signed upload URL");
      return {
        ...publicFile(file),
        upload: {
          method: "PUT" as const,
          url,
          // Content-Length is part of the signature but is deliberately absent
          // here: browsers set it from the body and refuse a manual override,
          // so a wrong-size body fails signature validation at the store.
          headers: { "Content-Type": file.content_type },
          expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
        },
      };
    }),
  );
}

async function verifyAndSealSessionFiles(
  db: Db,
  session: UploadSessionRow,
  files: UploadSessionFileRow[],
): Promise<boolean[]> {
  // Every result write is conditioned on the file still being the 'verifying'
  // claim this call made. Losing that claim — a reset or a stolen lease — must
  // never overwrite the newer state, so it is reported as "not sealed" rather
  // than as an error.
  const writeSealResult = async (
    file: UploadSessionFileRow,
    payload: Record<string, unknown>,
  ): Promise<boolean> => {
    const { data, error } = await db
      .from("upload_session_files")
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq("id", file.id)
      .eq("session_id", session.id)
      .eq("status", "verifying")
      .select("id")
      .maybeSingle();
    if (error) throw error;
    return !!data;
  };

  return await mapWithConcurrency(files, 5, async (file) => {
    const sealed = await headFile(file.sealed_storage_path);
    if (sealed?.size === file.expected_size_bytes) {
      return await writeSealResult(file, {
        status: "uploaded",
        observed_size_bytes: sealed.size,
        etag: sealed.etag,
        error_code: null,
      });
    }

    const staged = await headFile(file.staging_storage_path);
    if (!staged) {
      await writeSealResult(file, { status: "pending_upload" });
      return false;
    }
    if (
      staged.size !== file.expected_size_bytes ||
      (staged.contentType && staged.contentType !== file.content_type)
    ) {
      const errorCode =
        staged.size !== file.expected_size_bytes
          ? "size_mismatch"
          : "content_type_mismatch";
      await deleteFile(file.staging_storage_path).catch(() => {});
      await writeSealResult(file, {
        status: "error",
        observed_size_bytes: staged.size,
        etag: staged.etag,
        error_code: errorCode,
      });
      return false;
    }

    await copyFile(file.staging_storage_path, file.sealed_storage_path);
    const copied = await headFile(file.sealed_storage_path);
    if (!copied || copied.size !== file.expected_size_bytes) {
      throw new Error("Failed to verify sealed upload object");
    }
    await deleteFile(file.staging_storage_path);
    return await writeSealResult(file, {
      status: "uploaded",
      observed_size_bytes: copied.size,
      etag: copied.etag,
      error_code: null,
    });
  });
}

function verificationLeaseCutoff(): string {
  return new Date(
    Date.now() - UPLOAD_VERIFICATION_LEASE_SECONDS * 1000,
  ).toISOString();
}

async function refreshSessionStatus(db: Db, sessionId: string): Promise<void> {
  const { error } = await db.rpc("refresh_upload_session_status", {
    target_session_id: sessionId,
  });
  if (error) throw error;
}

/**
 * Slide the session deadline forward as files land. A large batch on a slow
 * uplink can outlive the initial 30-minute TTL; the RPC applies its own
 * absolute cap from session creation, so this cannot extend a session forever.
 * A failure here must never fail an upload that already succeeded.
 */
async function extendSessionExpiry(db: Db, sessionId: string): Promise<void> {
  const { error } = await db.rpc("extend_upload_session_expiry", {
    target_session_id: sessionId,
  });
  if (error) {
    console.error("[upload-sessions] extending the session expiry failed", {
      sessionId,
      error,
    });
  }
}

async function queueFileProcessing(
  db: Db,
  sessionId: string,
  userId: string,
  fileId: string,
): Promise<string> {
  const { data, error } = await db.rpc("queue_upload_session_file_processing", {
    target_session_id: sessionId,
    target_user_id: userId,
    target_file_id: fileId,
  });
  if (error) throw error;
  if (typeof data !== "string" || !data) {
    throw new Error("Upload processing job was not created");
  }
  return data;
}

type FileCompletionResult = "resolved" | "incomplete" | "in_progress";

async function completeSessionFile(
  db: Db,
  session: UploadSessionRow,
  file: UploadSessionFileRow,
  userId: string,
  failed: boolean,
): Promise<FileCompletionResult> {
  if (failed) {
    if (file.status === "verifying") {
      const { data: recovered, error } = await db
        .from("upload_session_files")
        .update({
          status: "pending_upload",
          updated_at: new Date().toISOString(),
        })
        .eq("id", file.id)
        .eq("session_id", session.id)
        .eq("status", "verifying")
        .lte("updated_at", verificationLeaseCutoff())
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!recovered) return "in_progress";
    }
    if (file.status === "pending_upload" || file.status === "verifying") {
      await Promise.all([
        deleteFile(file.staging_storage_path).catch(() => {}),
        deleteFile(file.sealed_storage_path).catch(() => {}),
      ]);
      const { error } = await db
        .from("upload_session_files")
        .update({
          status: "error",
          error_code: "direct_upload_failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", file.id)
        .eq("session_id", session.id)
        .in("status", ["pending_upload", "verifying"]);
      if (error) throw error;
    }
    await refreshSessionStatus(db, session.id);
    return "resolved";
  }

  if (file.status === "uploaded") {
    await queueFileProcessing(db, session.id, userId, file.id);
    await extendSessionExpiry(db, session.id);
    await refreshSessionStatus(db, session.id);
    return "resolved";
  }
  if (["processing", "completed", "error"].includes(file.status)) {
    await refreshSessionStatus(db, session.id);
    return "resolved";
  }
  if (file.status === "verifying") {
    const { data: recovered, error } = await db
      .from("upload_session_files")
      .update({
        status: "pending_upload",
        updated_at: new Date().toISOString(),
      })
      .eq("id", file.id)
      .eq("session_id", session.id)
      .eq("status", "verifying")
      .lte("updated_at", verificationLeaseCutoff())
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!recovered) return "in_progress";
  }

  const { data: claimed, error: claimError } = await db
    .from("upload_session_files")
    .update({ status: "verifying", updated_at: new Date().toISOString() })
    .eq("id", file.id)
    .eq("session_id", session.id)
    .eq("status", "pending_upload")
    .select("*")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return "in_progress";

  const [verified] = await verifyAndSealSessionFiles(db, session, [
    claimed as UploadSessionFileRow,
  ]);
  if (!verified) {
    await refreshSessionStatus(db, session.id);
    const currentFiles = await loadSessionFiles(db, session.id);
    const current = currentFiles.find((candidate) => candidate.id === file.id);
    return current?.status === "error" ? "resolved" : "incomplete";
  }
  await queueFileProcessing(db, session.id, userId, file.id);
  await extendSessionExpiry(db, session.id);
  await refreshSessionStatus(db, session.id);
  return "resolved";
}

uploadSessionsRouter.post(
  "/",
  requireAuth,
  uploadSessionMutationLimiter,
  asyncRoute(async (req, res) => {
    if (!storageEnabled) {
      return void res.status(503).json({ detail: "Storage is not configured" });
    }

    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const sessionId = randomUUID();
    let manifest: ParsedUploadSessionRequest;
    try {
      manifest = parseUploadSessionRequest(req.body, userId, sessionId);
    } catch (error) {
      if (error instanceof UploadSessionValidationError) {
        return void res
          .status(error.status)
          .json({ code: error.code, detail: error.message });
      }
      throw error;
    }

    const db = createServerSupabase();
    if (
      !(await validateDestinationAccess(manifest, userId, userEmail, db, res))
    ) {
      return;
    }

    const expiresAt = uploadSessionExpiresAt();
    const { error } = await db.rpc("create_upload_session", {
      target_session_id: sessionId,
      target_user_id: userId,
      target_purpose: manifest.purpose,
      target_destination: manifest.destination,
      target_expires_at: expiresAt,
      target_files: manifest.files,
      target_hourly_session_limit: uploadRateLimits.sessionCreationMaxPerHour,
    });
    if (error) {
      if (error.message?.includes("upload_session_rate_limit_exceeded")) {
        return void res.status(429).json({
          code: "upload_session_rate_limit_exceeded",
          detail: "Too many upload sessions. Please try again later.",
        });
      }
      if (error.message?.includes("upload_target_busy")) {
        return void res.status(409).json({
          code: "upload_target_busy",
          detail: "Another upload is already updating this item.",
        });
      }
      if (
        error.message?.includes("upload_file_count_limit_exceeded") ||
        error.message?.includes("upload_total_size_limit_exceeded") ||
        error.message?.includes("invalid_upload_manifest")
      ) {
        return void res.status(400).json({ detail: "Invalid upload manifest" });
      }
      return void sendInternalError(res, error);
    }

    try {
      const files = await signPendingFiles(manifest.files, expiresAt);
      res.status(201).json({
        session: {
          id: sessionId,
          purpose: manifest.purpose,
          destination: manifest.destination,
          expected_file_count: manifest.files.length,
          expected_total_bytes: manifest.expected_total_bytes,
          status: "pending_upload",
          expires_at: expiresAt,
        },
        files,
      });
    } catch (error) {
      await db
        .from("upload_sessions")
        .update({
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", sessionId)
        .eq("user_id", userId);
      return void sendInternalError(res, error, 503);
    }
  }),
);

uploadSessionsRouter.get(
  "/:sessionId",
  requireAuth,
  uploadSessionPollingLimiter,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const session = await loadOwnedSession(db, req.params.sessionId, userId);
    if (!session) {
      return void res.status(404).json({ detail: "Upload session not found" });
    }
    const files = await loadSessionFiles(db, session.id);
    res.json({ session, files: files.map(publicFile) });
  }),
);

uploadSessionsRouter.post(
  "/:sessionId/urls",
  requireAuth,
  uploadSessionMutationLimiter,
  asyncRoute(async (req, res) => {
    if (!storageEnabled) {
      return void res.status(503).json({ detail: "Storage is not configured" });
    }
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const session = await loadOwnedSession(db, req.params.sessionId, userId);
    if (!session) {
      return void res.status(404).json({ detail: "Upload session not found" });
    }
    if (session.status !== "pending_upload") {
      return void res.status(409).json({
        detail: "Upload URLs can only be refreshed for a pending session",
      });
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      await db
        .from("upload_sessions")
        .update({ status: "expired", updated_at: new Date().toISOString() })
        .eq("id", session.id)
        .eq("status", "pending_upload");
      return void res.status(410).json({ detail: "Upload session expired" });
    }

    const files = await loadSessionFiles(db, session.id);
    const pendingFiles = files.filter((file) =>
      ["pending_upload", "verifying"].includes(file.status),
    );
    if (pendingFiles.some((file) => file.status === "pending_upload")) {
      const { error } = await db
        .from("upload_session_files")
        .update({
          status: "pending_upload",
          error_code: null,
          updated_at: new Date().toISOString(),
        })
        .eq("session_id", session.id)
        .eq("status", "pending_upload");
      if (error) return void sendInternalError(res, error);
    }
    if (pendingFiles.some((file) => file.status === "verifying")) {
      // Only reclaim a verification lease that has already expired. A fresh
      // one means another request is still sealing that file.
      const { error } = await db
        .from("upload_session_files")
        .update({
          status: "pending_upload",
          error_code: null,
          updated_at: new Date().toISOString(),
        })
        .eq("session_id", session.id)
        .eq("status", "verifying")
        .lte("updated_at", verificationLeaseCutoff());
      if (error) return void sendInternalError(res, error);
    }
    res.json({
      files: await signPendingFiles(pendingFiles, session.expires_at),
    });
  }),
);

uploadSessionsRouter.post(
  "/:sessionId/files/:fileId/complete",
  requireAuth,
  uploadSessionMutationLimiter,
  asyncRoute(async (req, res) => {
    if (!storageEnabled) {
      return void res.status(503).json({ detail: "Storage is not configured" });
    }
    const parsed = fileCompletionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return void res
        .status(400)
        .json({ detail: "Invalid completion request" });
    }
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const session = await loadOwnedSession(db, req.params.sessionId, userId);
    if (!session) {
      return void res.status(404).json({ detail: "Upload session not found" });
    }
    if (["cancelled", "expired"].includes(session.status)) {
      return void res
        .status(409)
        .json({ detail: "Upload session is not active" });
    }
    if (
      session.status === "pending_upload" &&
      new Date(session.expires_at).getTime() <= Date.now()
    ) {
      await db
        .from("upload_sessions")
        .update({ status: "expired", updated_at: new Date().toISOString() })
        .eq("id", session.id)
        .eq("status", "pending_upload");
      return void res.status(410).json({ detail: "Upload session expired" });
    }
    const files = await loadSessionFiles(db, session.id);
    const file = files.find((candidate) => candidate.id === req.params.fileId);
    if (!file) {
      return void res.status(404).json({ detail: "Upload file not found" });
    }

    try {
      const result = await completeSessionFile(
        db,
        session,
        file,
        userId,
        parsed.data.failed,
      );
      const updated = await loadOwnedSession(db, session.id, userId);
      const currentFiles = await loadSessionFiles(db, session.id);
      if (result === "incomplete") {
        return void res.status(409).json({
          code: "upload_incomplete",
          detail: "The uploaded file is not available yet.",
          session: updated,
          files: currentFiles.map(publicFile),
        });
      }
      res.status(result === "in_progress" ? 202 : 200).json({
        session: updated,
        files: currentFiles.map(publicFile),
      });
    } catch (error) {
      if (error instanceof StorageOperationError) {
        return void sendInternalError(res, error, 503);
      }
      throw error;
    }
  }),
);

uploadSessionsRouter.delete(
  "/:sessionId",
  requireAuth,
  uploadSessionMutationLimiter,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const session = await loadOwnedSession(db, req.params.sessionId, userId);
    if (!session) {
      return void res.status(404).json({ detail: "Upload session not found" });
    }
    const staleVerification =
      session.status === "verifying" &&
      new Date(session.updated_at).getTime() <=
        Date.now() - UPLOAD_VERIFICATION_LEASE_SECONDS * 1000;
    if (session.status !== "pending_upload" && !staleVerification) {
      return void res
        .status(409)
        .json({ detail: "Upload session cannot be cancelled" });
    }
    const files = await loadSessionFiles(db, session.id);
    if (
      files.some((file) =>
        ["uploaded", "processing", "completed"].includes(file.status),
      )
    ) {
      return void res.status(409).json({
        detail: "Files already being processed cannot be cancelled",
      });
    }
    const now = new Date().toISOString();
    let cancellationQuery = db
      .from("upload_sessions")
      .update({ status: "cancelled", cancelled_at: now, updated_at: now })
      .eq("id", session.id)
      .eq("user_id", userId)
      .eq("status", staleVerification ? "verifying" : "pending_upload");
    if (staleVerification) {
      cancellationQuery = cancellationQuery.lte(
        "updated_at",
        verificationLeaseCutoff(),
      );
    }
    const { data: cancelled, error } = await cancellationQuery
      .select("id")
      .maybeSingle();
    if (error) return void sendInternalError(res, error);
    if (!cancelled) {
      return void res.status(409).json({
        detail:
          "Upload session is already being completed and cannot be cancelled",
      });
    }

    await mapWithConcurrency(files, 5, async (file) => {
      await Promise.all([
        deleteFile(file.staging_storage_path).catch(() => {}),
        deleteFile(file.sealed_storage_path).catch(() => {}),
      ]);
    });
    const { error: cleanupError } = await db
      .from("upload_sessions")
      .update({ cleaned_at: new Date().toISOString() })
      .eq("id", session.id)
      .eq("status", "cancelled");
    if (cleanupError) return void sendInternalError(res, cleanupError);
    res.status(204).end();
  }),
);
