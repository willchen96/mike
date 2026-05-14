import { readFile } from "fs/promises";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { parseBody } from "../lib/validate";
import { createServerSupabase, getUsersByEmails, getUserById } from "../lib/supabase";
import { logger } from "../lib/logger";
import { createClient } from "@supabase/supabase-js";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
} from "../lib/documentVersions";
import { downloadFile, uploadFile, storageKey } from "../lib/storage";
import { convertedPdfKey } from "../lib/convert";
import { checkProjectAccess } from "../lib/access";
import {
  cleanupTempFile,
  sanitizeFilename,
  singleFileUpload,
} from "../lib/upload";
import { enqueueConversionFromBuffer } from "../lib/pdfQueue";
import { extractStructureTree } from "../lib/structureTree";

const CreateProjectSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  cm_number: z.string().trim().optional(),
  shared_with: z.array(z.string().email()).optional(),
});

const UpdateProjectSchema = z.object({
  name: z.string().trim().min(1).optional(),
  cm_number: z.string().trim().nullable().optional(),
  shared_with: z.array(z.string().email()).optional(),
}).strict();

const CreateFolderSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  parent_folder_id: z.string().uuid().nullable().optional(),
});

const UpdateFolderSchema = z.object({
  name: z.string().trim().min(1).optional(),
  parent_folder_id: z.string().uuid().nullable().optional(),
}).strict();

const MoveDocumentToFolderSchema = z.object({
  folder_id: z.string().uuid().nullable(),
});

export const projectsRouter = Router();
const ALLOWED_TYPES = new Set(["pdf", "docx", "doc"]);

// GET /projects
projectsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const db = createServerSupabase();

  const { data: ownProjects, error: ownError } = await db
    .from("projects")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (ownError) return void res.status(500).json({ detail: ownError.message });

  const { data: sharedProjects, error: sharedError } = userEmail
    ? await db
        .from("projects")
        .select("*")
        .contains("shared_with", JSON.stringify([userEmail]))
        .neq("user_id", userId)
        .order("created_at", { ascending: false })
    : { data: [], error: null };
  if (sharedError)
    return void res.status(500).json({ detail: sharedError.message });

  const projects = [...(ownProjects ?? []), ...(sharedProjects ?? [])].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const result = await Promise.all(
    projects.map(async (p) => {
      const [docs, chats, reviews] = await Promise.all([
        db
          .from("documents")
          .select("id", { count: "exact", head: true })
          .eq("project_id", p.id),
        db
          .from("chats")
          .select("id", { count: "exact", head: true })
          .eq("project_id", p.id),
        db
          .from("tabular_reviews")
          .select("id", { count: "exact", head: true })
          .eq("project_id", p.id),
      ]);
      return {
        ...p,
        is_owner: p.user_id === userId,
        document_count: docs.count ?? 0,
        chat_count: chats.count ?? 0,
        review_count: reviews.count ?? 0,
      };
    }),
  );
  res.json(result);
});

// POST /projects
projectsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const body = parseBody(CreateProjectSchema, req, res);
  if (!body) return;
  const { name, cm_number, shared_with } = body;

  const db = createServerSupabase();
  const { data, error } = await db
    .from("projects")
    .insert({
      user_id: userId,
      name: name.trim(),
      cm_number: cm_number ?? null,
      shared_with: shared_with ?? [],
    })
    .select("*")
    .single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json({ ...data, documents: [] });
});

// GET /projects/:projectId
projectsRouter.get("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const { data: project, error } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (error || !project)
    return void res.status(404).json({ detail: "Project not found" });

  const canAccess =
    project.user_id === userId ||
    (userEmail &&
      Array.isArray(project.shared_with) &&
      project.shared_with.some(
        (e: string) => (e ?? "").toLowerCase() === (userEmail ?? "").toLowerCase(),
      ));
  if (!canAccess)
    return void res.status(404).json({ detail: "Project not found" });

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db.from("documents").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
    db.from("project_subfolders").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docsTyped);
  await attachActiveVersionPaths(db, docsTyped);
  res.json({
    ...project,
    is_owner: project.user_id === userId,
    documents: docsTyped,
    folders: folderData ?? [],
  });
});

// GET /projects/:projectId/people
// Resolve the owner + every shared member to {email, display_name}. Used
// by the People modal so the UI can show display names where available
// and tag the current user as "You".
projectsRouter.get("/:projectId/people", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const { data: project } = await db
    .from("projects")
    .select("id, user_id, shared_with")
    .eq("id", projectId)
    .single();
  if (!project)
    return void res.status(404).json({ detail: "Project not found" });

  const isOwner = project.user_id === userId;
  const sharedWith = (Array.isArray(project.shared_with)
    ? (project.shared_with as string[])
    : []
  ).map((e) => e.toLowerCase());
  const isShared =
    !!userEmail && sharedWith.includes(userEmail.toLowerCase());
  if (!isOwner && !isShared)
    return void res.status(404).json({ detail: "Project not found" });

  // Resolve shared-with emails to user records via RPC (CLEAN-15).
  // get_auth_user_by_email is SECURITY DEFINER and O(log N) — replaces the
  // listUsers({ perPage: 1000 }) walk that silently truncates above 1000.
  const [userByEmail, ownerRecord] = await Promise.all([
    getUsersByEmails(sharedWith),
    getUserById(project.user_id as string),
  ]);

  const memberUserIds: string[] = [];
  for (const email of sharedWith) {
    const u = userByEmail.get(email);
    if (u) memberUserIds.push(u.id);
  }

  const profileIds = [
    project.user_id as string,
    ...memberUserIds,
  ].filter((x, i, arr) => arr.indexOf(x) === i);

  const profileByUserId = new Map<
    string,
    { display_name: string | null; organisation: string | null }
  >();
  if (profileIds.length > 0) {
    const { data: profiles } = await db
      .from("user_profiles")
      .select("user_id, display_name, organisation")
      .in("user_id", profileIds);
    for (const p of profiles ?? []) {
      profileByUserId.set(p.user_id as string, {
        display_name: (p.display_name as string | null) ?? null,
        organisation: (p.organisation as string | null) ?? null,
      });
    }
  }

  const owner = {
    user_id: project.user_id,
    email: ownerRecord?.email ?? null,
    display_name:
      profileByUserId.get(project.user_id as string)?.display_name ?? null,
  };
  const members = sharedWith
    .filter((email) => userByEmail.has(email))
    .map((email) => {
      const u = userByEmail.get(email)!;
      const display_name = profileByUserId.get(u.id)?.display_name ?? null;
      return { email, display_name };
    });

  res.json({ owner, members });
});

// PATCH /projects/:projectId
projectsRouter.patch("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  const body = parseBody(UpdateProjectSchema, req, res);
  if (!body) return;
  const updates: Record<string, unknown> = {};
  if (body.name != null) updates.name = body.name;
  if (body.cm_number != null) updates.cm_number = body.cm_number;
  if (Array.isArray(body.shared_with)) {
    // Normalise: lowercase + dedupe + drop empties.
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const e of body.shared_with) {
      const norm = e.trim().toLowerCase();
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      cleaned.push(norm);
    }
    updates.shared_with = cleaned;
  }

  const db = createServerSupabase();
  const { data, error } = await db
    .from("projects")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error || !data)
    return void res.status(404).json({ detail: "Project not found" });

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db.from("documents").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
    db.from("project_subfolders").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  res.json({ ...data, documents: docsTyped, folders: folderData ?? [] });
});

// DELETE /projects/:projectId
projectsRouter.delete("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("projects")
    .delete()
    .eq("id", projectId)
    .eq("user_id", userId)
    .select("id");
  if (error) return void res.status(500).json({ detail: error.message });
  if (!data || data.length === 0)
    return void res.status(404).json({ detail: "Project not found" });
  res.status(204).send();
});

// GET /projects/:projectId/documents
projectsRouter.get("/:projectId/documents", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data: docs } = await db
    .from("documents")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  res.json(docsTyped);
});

// POST /projects/:projectId/documents/:documentId — assign or copy existing doc into project
projectsRouter.post(
  "/:projectId/documents/:documentId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, documentId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    // Adding-by-id pulls a doc into the project — only the doc's owner
    // is allowed to do that, so other people's standalone docs can't be
    // siphoned into a project the requester happens to share.
    const { data: doc } = await db
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .eq("user_id", userId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });

    // Already in this project — idempotent
    if (doc.project_id === projectId) return void res.json(doc);

    if (doc.project_id === null) {
      // Standalone → assign project_id
      const { data: updated, error } = await db
        .from("documents")
        .update({ project_id: projectId, updated_at: new Date().toISOString() })
        .eq("id", documentId)
        .select("*")
        .single();
      if (error || !updated)
        return void res.status(500).json({ detail: "Failed to update document" });
      return void res.json(updated);
    } else {
      // Belongs to another project → duplicate record AND copy the
      // underlying storage objects so each project's copy is fully
      // independent (edits/version bumps on one don't leak into the
      // other).
      const { data: copy, error } = await db
        .from("documents")
        .insert({
          project_id: projectId,
          user_id: userId,
          filename: doc.filename,
          file_type: doc.file_type,
          size_bytes: doc.size_bytes,
          page_count: doc.page_count,
          structure_tree: doc.structure_tree,
          status: doc.status,
        })
        .select("*")
        .single();
      if (error || !copy)
        return void res.status(500).json({ detail: "Failed to copy document" });

      let copyVersionRowId: string | null = null;
      if (doc.current_version_id) {
        const { data: srcV } = await db
          .from("document_versions")
          .select(
            "storage_path, pdf_storage_path, version_number, display_name, source",
          )
          .eq("id", doc.current_version_id)
          .single();
        if (srcV?.storage_path) {
          const srcBytes = await downloadFile(srcV.storage_path);
          if (!srcBytes) {
            return void res
              .status(500)
              .json({ detail: "Failed to read source document bytes" });
          }
          const newKey = storageKey(userId, copy.id as string, doc.filename);
          const contentType =
            doc.file_type === "pdf"
              ? "application/pdf"
              : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          await uploadFile(newKey, srcBytes, contentType);

          // PDFs share one object for source + display rendition. DOCX
          // store the converted PDF at a separate `converted-pdfs/` key —
          // copy that too if it exists so the copy renders without going
          // back through libreoffice.
          let newPdfPath: string | null = null;
          if (srcV.pdf_storage_path) {
            if (srcV.pdf_storage_path === srcV.storage_path) {
              newPdfPath = newKey;
            } else {
              const pdfBytes = await downloadFile(srcV.pdf_storage_path);
              if (pdfBytes) {
                const newPdfKey = convertedPdfKey(userId, copy.id as string);
                await uploadFile(newPdfKey, pdfBytes, "application/pdf");
                newPdfPath = newPdfKey;
              }
            }
          }

          const { data: newV } = await db
            .from("document_versions")
            .insert({
              document_id: copy.id,
              storage_path: newKey,
              pdf_storage_path: newPdfPath,
              source: (srcV.source as string | null) ?? "upload",
              version_number: srcV.version_number ?? 1,
              display_name: srcV.display_name ?? doc.filename,
            })
            .select("id")
            .single();
          copyVersionRowId = (newV?.id as string | null) ?? null;
          if (copyVersionRowId) {
            await db
              .from("documents")
              .update({ current_version_id: copyVersionRowId })
              .eq("id", copy.id);
          }
        }
      }
      return void res.status(201).json(copy);
    }
  },
);

// POST /projects/:projectId/documents
projectsRouter.post(
  "/:projectId/documents",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    await handleDocumentUpload(req, res, userId, projectId, db);
  },
);

// GET /projects/:projectId/chats — every assistant chat under this project
// (any author with project access). Used by the project page's chat tab so
// it doesn't have to filter the global GET /chat list — and so collaborators
// see each other's chats inside the project even though those don't appear
// in the global list.
projectsRouter.get("/:projectId/chats", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data, error } = await db
    .from("chats")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) return void res.status(500).json({ detail: error.message });
  res.json(data ?? []);
});

// ── Folder routes ─────────────────────────────────────────────────────────────

// POST /projects/:projectId/folders
projectsRouter.post("/:projectId/folders", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const folderBody = parseBody(CreateFolderSchema, req, res);
  if (!folderBody) return;
  const { name, parent_folder_id } = folderBody;

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  // Verify parent folder belongs to this project
  if (parent_folder_id) {
    const { data: parent } = await db.from("project_subfolders").select("id").eq("id", parent_folder_id).eq("project_id", projectId).single();
    if (!parent) return void res.status(404).json({ detail: "Parent folder not found" });
  }

  const { data, error } = await db.from("project_subfolders").insert({
    project_id: projectId,
    user_id: userId,
    name: name.trim(),
    parent_folder_id: parent_folder_id ?? null,
  }).select("*").single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json(data);
});

// PATCH /projects/:projectId/folders/:folderId
projectsRouter.patch("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  const body = parseBody(UpdateFolderSchema, req, res);
  if (!body) return;

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name != null) updates.name = body.name.trim();
  if ("parent_folder_id" in body) {
    // Cycle check: walk up the tree from the proposed parent to ensure folderId is not an ancestor
    if (body.parent_folder_id) {
      let cur: string | null = body.parent_folder_id;
      while (cur) {
        if (cur === folderId) return void res.status(400).json({ detail: "Cannot move a folder into itself or a descendant" });
        const { data: p }: { data: { parent_folder_id: string | null } | null } =
          await db.from("project_subfolders").select("parent_folder_id").eq("id", cur).single();
        cur = p?.parent_folder_id ?? null;
      }
    }
    updates.parent_folder_id = body.parent_folder_id ?? null;
  }

  const { data, error } = await db.from("project_subfolders")
    .update(updates)
    .eq("id", folderId).eq("project_id", projectId)
    .select("*").single();
  if (error || !data) return void res.status(404).json({ detail: "Folder not found" });
  res.json(data);
});

// DELETE /projects/:projectId/folders/:folderId
projectsRouter.delete("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  // Move direct documents to root before cascade-deleting subfolders
  await db.from("documents").update({ folder_id: null }).eq("folder_id", folderId);

  const { error } = await db.from("project_subfolders")
    .delete().eq("id", folderId).eq("project_id", projectId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// PATCH /projects/:projectId/documents/:documentId/folder — move doc to a folder
projectsRouter.patch("/:projectId/documents/:documentId/folder", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;
  const moveBody = parseBody(MoveDocumentToFolderSchema, req, res);
  if (!moveBody) return;
  const { folder_id } = moveBody;

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const { data, error } = await db.from("documents")
    .update({ folder_id: folder_id ?? null, updated_at: new Date().toISOString() })
    .eq("id", documentId).eq("project_id", projectId)
    .select("*").single();
  if (error || !data) return void res.status(404).json({ detail: "Document not found" });
  res.json(data);
});

export async function handleDocumentUpload(
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

    // Storage paths live on document_versions — create the V1 row and
    // point documents.current_version_id at it.
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
