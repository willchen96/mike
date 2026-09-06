import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../dbq/types";
import {
  assertStorageConfigured,
  deleteFile,
  downloadFileStrict,
  uploadFile,
} from "../storage";

export const MEMORY_MAX_BYTES = 16 * 1024;
export const MEMORY_VERSION_RETENTION = 50;

export type MemoryScope = "user" | "project";
export type MemoryStatus = "idle" | "scheduled" | "processing" | "failed";
export type MemorySource = "manual" | "curator" | "restore";
export type MemorySurface = "chat" | "word" | "tabular";

export type MemoryCurrent = {
  enabled: boolean;
  content: string;
  version: number;
  hash: string | null;
  updated_at: string | null;
  updated_by: string | null;
  source: MemorySource | "wipe" | "settings" | null;
  status: MemoryStatus;
};

export type MemoryVersion = {
  id: string;
  version: number;
  hash: string;
  size_bytes: number;
  created_at: string;
  updated_by: string | null;
  source: MemorySource;
  change_summary: string | null;
  model: string | null;
  source_surface: MemorySurface | null;
  source_chat_id: string | null;
  source_turn_id: string | null;
};

export type MemoryFileRow = {
  id: string;
  scope: MemoryScope;
  user_id: string | null;
  project_id: string | null;
  enabled: boolean;
  epoch: number | string;
  version: number | string;
  learning_cutoff_at: string;
  current_version_id: string | null;
  status: MemoryStatus;
  last_error_code: string | null;
  last_source: MemorySource | "wipe" | "settings" | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

type MemoryVersionRow = {
  id: string;
  memory_file_id: string;
  version: number | string;
  storage_path: string;
  size_bytes: number;
  content_sha256: string;
  source: MemorySource;
  change_summary: string | null;
  updated_by: string | null;
  model: string | null;
  source_surface: MemorySurface | null;
  source_chat_id: string | null;
  source_turn_id: string | null;
  source_job_id: string | null;
  created_at: string;
};

export class MemoryValidationError extends Error {}
export class MemoryVersionConflictError extends Error {}
export class MemoryDisabledError extends Error {}
export class MemoryJobSupersededError extends Error {}
export class MemoryEpochSupersededError extends Error {}
export class MemoryConversationNotQuietError extends Error {}

function numberValue(value: number | string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeMemoryMarkdown(value: unknown): string {
  if (typeof value !== "string") {
    throw new MemoryValidationError("content must be a string");
  }
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      if (/^[ \t]*$/.test(line)) return "";
      const trailing = line.match(/[ \t]+$/)?.[0];
      if (!trailing) return line;
      const hardBreak = trailing.replace(/\t/g, "").length >= 2;
      return `${line.slice(0, -trailing.length)}${hardBreak ? "  " : ""}`;
    })
    .join("\n");
  if (/\0|[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(normalized)) {
    throw new MemoryValidationError("content contains unsupported characters");
  }
  if (
    /<\s*\/?\s*(?:script|iframe|object|embed|form|input|button|svg|math|style|link|meta|base)\b/i.test(
      normalized,
    ) ||
    /<[^>]+\bon[a-z]+\s*=/i.test(normalized) ||
    /<[^>]+\b(?:href|src|xlink:href)\s*=\s*["']?\s*(?:javascript\s*:|data\s*:\s*text\/html)/i.test(
      normalized,
    )
  ) {
    throw new MemoryValidationError("content contains executable HTML");
  }
  if (Buffer.byteLength(normalized, "utf8") > MEMORY_MAX_BYTES) {
    throw new MemoryValidationError(
      `content must be ${MEMORY_MAX_BYTES} bytes or fewer`,
    );
  }
  return normalized;
}

function memoryHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function memoryStoragePath(file: MemoryFileRow, versionId: string): string {
  if (file.scope === "user" && file.user_id) {
    return `memories/users/${file.user_id}/versions/${versionId}/memory.md`;
  }
  if (file.scope === "project" && file.project_id) {
    return `memories/projects/${file.project_id}/versions/${versionId}/memory.md`;
  }
  throw new Error("Invalid memory file scope");
}

function toArrayBuffer(content: string): ArrayBuffer {
  const buffer = Buffer.from(content, "utf8");
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

async function cleanupUploadCandidate(
  db: Db,
  candidateId: string,
  storagePath: string,
): Promise<void> {
  const { data: claimed, error: claimError } = await db
    .from("memory_object_candidates")
    .update({ status: "cleaning" })
    .eq("id", candidateId)
    .in("status", ["uploading", "abandoned"])
    .select("id")
    .maybeSingle();
  if (claimError || !claimed) return;
  try {
    // deleteFile intentionally no-ops in storage-optional deployments. A
    // memory candidate is different: removing its final durable pointer after
    // such a no-op would orphan private bytes if configuration disappeared
    // between upload and compare-and-swap promotion.
    assertStorageConfigured();
    await deleteFile(storagePath);
  } catch {
    // begin_memory_file_upload registered this path and a delayed cleanup job
    // atomically before upload. Leave both in place if inline deletion fails.
    return;
  }
  // Once the object is gone, the durable candidate pointer is no longer
  // needed. Its already-enqueued cleanup job will harmlessly no-op later.
  await db.from("memory_object_candidates").delete().eq("id", candidateId);
}

async function versionRow(
  db: Db,
  id: string | null,
): Promise<MemoryVersionRow | null> {
  if (!id) return null;
  const { data, error } = await db
    .from("memory_file_versions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error("Failed to load memory version");
  return (data as MemoryVersionRow | null) ?? null;
}

async function verifiedVersionContent(row: MemoryVersionRow): Promise<string> {
  const bytes = await downloadFileStrict(row.storage_path);
  if (!bytes) throw new Error("Memory object is missing");
  const content = Buffer.from(bytes).toString("utf8");
  if (memoryHash(content) !== row.content_sha256) {
    throw new Error("Memory object checksum mismatch");
  }
  return content;
}

export async function ensureMemoryFile(
  db: Db,
  scope: MemoryScope,
  ownerId: string,
  defaultEnabled = true,
): Promise<MemoryFileRow> {
  const ownerColumn = scope === "user" ? "user_id" : "project_id";
  const { data: existing, error: readError } = await db
    .from("memory_files")
    .select("*")
    .eq("scope", scope)
    .eq(ownerColumn, ownerId)
    .maybeSingle();
  if (readError) throw new Error("Failed to load memory settings");
  if (existing) return existing as MemoryFileRow;

  const { data, error } = await db
    .from("memory_files")
    .upsert(
      {
        scope,
        [ownerColumn]: ownerId,
        enabled: defaultEnabled,
      },
      { onConflict: ownerColumn, ignoreDuplicates: true },
    )
    .select("*")
    .maybeSingle();
  if (error) throw new Error("Failed to create memory settings");
  if (data) return data as MemoryFileRow;

  const { data: raced, error: racedError } = await db
    .from("memory_files")
    .select("*")
    .eq("scope", scope)
    .eq(ownerColumn, ownerId)
    .single();
  if (racedError || !raced) throw new Error("Failed to create memory settings");
  return raced as MemoryFileRow;
}

export async function readMemoryContent(
  db: Db,
  file: MemoryFileRow,
): Promise<{ content: string; version: MemoryVersionRow | null }> {
  if (!file.current_version_id) return { content: "", version: null };
  const version = await versionRow(db, file.current_version_id);
  if (!version) throw new Error("Memory head version is missing");
  const content = await verifiedVersionContent(version);
  return { content, version };
}

export async function getMemoryCurrent(
  db: Db,
  scope: MemoryScope,
  ownerId: string,
  defaultEnabled = true,
): Promise<{ current: MemoryCurrent; file: MemoryFileRow }> {
  const file = await ensureMemoryFile(db, scope, ownerId, defaultEnabled);
  const { content, version } = await readMemoryContent(db, file);
  return {
    file,
    current: {
      enabled: file.enabled,
      content,
      // file.version is a monotonic CAS token. A destructive wipe removes all
      // objects/history but advances this token so a draft loaded before the
      // wipe cannot recreate erased content after disable/re-enable.
      version: version ? numberValue(version.version) : numberValue(file.version),
      hash: version?.content_sha256 ?? null,
      updated_at: version?.created_at ?? file.updated_at ?? null,
      updated_by: version?.updated_by ?? file.updated_by ?? null,
      source: version?.source ?? file.last_source ?? null,
      status: file.status,
    },
  };
}

function isVersionConflict(error: unknown): boolean {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
  return message.includes("memory_version_conflict");
}

function isEpochConflict(error: unknown): boolean {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
  return message.includes("memory_epoch_conflict");
}

function isDisabled(error: unknown): boolean {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
  return message.includes("memory_disabled");
}

function isSuperseded(error: unknown): boolean {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
  return message.includes("memory_job_superseded");
}

function isConversationNotQuiet(error: unknown): boolean {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
  return message.includes("memory_conversation_not_quiet");
}

export async function writeMemoryFile(args: {
  db: Db;
  file: MemoryFileRow;
  content: string;
  expectedVersion: number;
  source: MemorySource;
  changeSummary?: string | null;
  updatedBy: string | null;
  model?: string | null;
  sourceSurface?: MemorySurface | null;
  sourceChatId?: string | null;
  sourceTurnId?: string | null;
  sourceJobId?: string | null;
  consolidationStateId?: string | null;
  consolidationGeneration?: number | null;
  conversationGeneration?: number | null;
  sourceEpoch?: number | null;
  expectedEpoch?: number | null;
}): Promise<{ current: MemoryCurrent; applied: boolean }> {
  // Candidate cleanup is part of the persistence protocol, not optional
  // background polish. With the durable worker explicitly disabled, refuse
  // new uploads so a crash cannot create an object that will never be
  // reclaimed.
  if (process.env.DB_JOBS_ENABLED === "false") {
    throw new Error("Memory persistence is unavailable");
  }
  const content = normalizeMemoryMarkdown(args.content);
  const changeSummary = args.changeSummary?.trim() || null;
  if (changeSummary && changeSummary.length > 500) {
    throw new MemoryValidationError(
      "Memory change summary must be at most 500 characters",
    );
  }
  const expectedVersion = numberValue(args.expectedVersion);
  const fresh = await ensureMemoryFile(
    args.db,
    args.file.scope,
    (args.file.user_id ?? args.file.project_id) as string,
    true,
  );
  if (!fresh.enabled) throw new MemoryDisabledError("Memory is disabled");
  const expectedEpoch =
    args.expectedEpoch == null
      ? numberValue(fresh.epoch)
      : numberValue(args.expectedEpoch);
  if (numberValue(fresh.epoch) !== expectedEpoch) {
    throw new MemoryEpochSupersededError("Memory scope was reset");
  }
  if (numberValue(fresh.version) !== expectedVersion) {
    throw new MemoryVersionConflictError("Memory version changed");
  }
  const previous = await readMemoryContent(args.db, fresh);
  const hash = memoryHash(content);
  if (previous.version?.content_sha256 === hash) {
    return {
      applied: false,
      current: (await getMemoryCurrent(
        args.db,
        fresh.scope,
        (fresh.user_id ?? fresh.project_id) as string,
      )).current,
    };
  }

  const versionId = randomUUID();
  const candidateId = randomUUID();
  const storagePath = memoryStoragePath(fresh, versionId);
  const { error: beginError } = await args.db.rpc("begin_memory_file_upload", {
    p_memory_file_id: fresh.id,
    p_expected_version: expectedVersion,
    p_expected_epoch: expectedEpoch,
    p_candidate_id: candidateId,
    p_storage_path: storagePath,
  });
  if (beginError) {
    if (isEpochConflict(beginError)) {
      if (args.expectedEpoch != null) {
        throw new MemoryEpochSupersededError("Memory scope was reset");
      }
      throw new MemoryVersionConflictError("Memory version changed");
    }
    if (isVersionConflict(beginError)) {
      throw new MemoryVersionConflictError("Memory version changed");
    }
    if (isDisabled(beginError)) {
      throw new MemoryDisabledError("Memory is disabled");
    }
    throw new Error("Failed to prepare memory upload");
  }
  try {
    await uploadFile(
      storagePath,
      toArrayBuffer(content),
      "text/markdown; charset=utf-8",
    );
  } catch {
    // The candidate row and its delayed cleanup job deliberately remain. A
    // failed or ambiguously completed object PUT can therefore never become
    // an untracked object.
    throw new Error("Failed to upload memory");
  }
  const { data, error } = await args.db.rpc("advance_memory_file", {
    p_memory_file_id: fresh.id,
    p_expected_version: expectedVersion,
    p_expected_epoch: expectedEpoch,
    p_version_id: versionId,
    p_candidate_id: candidateId,
    p_storage_path: storagePath,
    p_size_bytes: Buffer.byteLength(content, "utf8"),
    p_content_sha256: hash,
    p_source: args.source,
    p_change_summary: changeSummary,
    p_updated_by: args.updatedBy,
    p_model: args.model ?? null,
    p_source_surface: args.sourceSurface ?? null,
    p_source_chat_id: args.sourceChatId ?? null,
    p_source_turn_id: args.sourceTurnId ?? null,
    p_source_job_id: args.sourceJobId ?? null,
    p_consolidation_state_id: args.consolidationStateId ?? null,
    p_consolidation_generation: args.consolidationGeneration ?? null,
    p_conversation_generation: args.conversationGeneration ?? null,
    p_source_epoch: args.sourceEpoch ?? null,
  });
  if (error) {
    await cleanupUploadCandidate(args.db, candidateId, storagePath);
    if (isConversationNotQuiet(error)) {
      throw new MemoryConversationNotQuietError(
        "Memory conversation is not quiet",
      );
    }
    if (isEpochConflict(error)) {
      if (args.expectedEpoch != null) {
        throw new MemoryEpochSupersededError("Memory scope was reset");
      }
      throw new MemoryVersionConflictError("Memory version changed");
    }
    if (isVersionConflict(error)) {
      throw new MemoryVersionConflictError("Memory version changed");
    }
    if (isDisabled(error)) throw new MemoryDisabledError("Memory is disabled");
    if (isSuperseded(error)) {
      throw new MemoryJobSupersededError("Memory curator job was superseded");
    }
    throw new Error("Failed to save memory");
  }

  const result = Array.isArray(data) ? data[0] : data;
  if (result?.applied === false) {
    await cleanupUploadCandidate(args.db, candidateId, storagePath);
    return {
      applied: false,
      current: (await getMemoryCurrent(
        args.db,
        fresh.scope,
        (fresh.user_id ?? fresh.project_id) as string,
      )).current,
    };
  }

  return {
    applied: true,
    current: (await getMemoryCurrent(
      args.db,
      fresh.scope,
      (fresh.user_id ?? fresh.project_id) as string,
    )).current,
  };
}

export async function listMemoryVersions(
  db: Db,
  fileId: string,
): Promise<MemoryVersion[]> {
  const { data, error } = await db
    .from("memory_file_versions")
    .select(
      "id, version, content_sha256, size_bytes, created_at, updated_by, source, change_summary, model, source_surface, source_chat_id, source_turn_id",
    )
    .eq("memory_file_id", fileId)
    .order("version", { ascending: false })
    .limit(MEMORY_VERSION_RETENTION);
  if (error) throw new Error("Failed to load memory versions");
  return ((data ?? []) as MemoryVersionRow[]).map((row) => ({
    id: row.id,
    version: numberValue(row.version),
    hash: row.content_sha256,
    size_bytes: row.size_bytes,
    created_at: row.created_at,
    updated_by: row.updated_by,
    source: row.source,
    change_summary: row.change_summary,
    model: row.model,
    source_surface: row.source_surface,
    source_chat_id: row.source_chat_id,
    source_turn_id: row.source_turn_id,
  }));
}

export async function restoreMemoryVersion(args: {
  db: Db;
  file: MemoryFileRow;
  versionId: string;
  expectedVersion: number;
  updatedBy: string;
}): Promise<MemoryCurrent> {
  const { data, error } = await args.db
    .from("memory_file_versions")
    .select("*")
    .eq("id", args.versionId)
    .eq("memory_file_id", args.file.id)
    .maybeSingle();
  if (error) throw new Error("Failed to load memory version");
  if (!data) throw new MemoryValidationError("Memory version not found");
  const row = data as MemoryVersionRow;
  const content = await verifiedVersionContent(row);
  return (
    await writeMemoryFile({
      db: args.db,
      file: args.file,
      content,
      expectedVersion: args.expectedVersion,
      source: "restore",
      changeSummary: `Restored memory version ${numberValue(row.version)}`,
      updatedBy: args.updatedBy,
      sourceSurface: row.source_surface,
      sourceChatId: row.source_chat_id,
      sourceTurnId: row.source_turn_id,
    })
  ).current;
}

export async function wipeMemoryFile(args: {
  db: Db;
  file: MemoryFileRow;
  /** null preserves the enabled value resolved under the RPC's row lock. */
  enabled: boolean | null;
  updatedBy: string | null;
  source?: "wipe" | "settings";
}): Promise<MemoryCurrent> {
  const queueDisabled = process.env.DB_JOBS_ENABLED === "false";
  // Interactive wipe/disable cannot truthfully acknowledge cross-store
  // erasure without the durable cleanup runner. Container/account deletion has
  // a separate synchronous owner-prefix cleanup path.
  if (queueDisabled) throw new Error("Memory persistence is unavailable");
  const { data, error } = await args.db.rpc("wipe_memory_file", {
    p_memory_file_id: args.file.id,
    p_enabled: args.enabled,
    p_updated_by: args.updatedBy,
    p_source: args.source ?? "wipe",
    p_require_no_candidates: queueDisabled,
  });
  if (error) throw new Error("Failed to wipe memory");
  const result = Array.isArray(data) ? data[0] : data;
  try {
    const returnedPaths: string[] = Array.isArray(result?.storage_paths)
      ? result.storage_paths.filter(
          (path: unknown): path is string => typeof path === "string" && !!path,
        )
      : [];
    await Promise.all(
      [...new Set(returnedPaths)].map((path) => deleteFile(path)),
    );
  } catch {
    // The RPC already committed durable storage.cleanup pointers. Ordinarily
    // the queue retries them indefinitely; in the explicit disabled topology
    // there is no worker, so do not acknowledge physical erasure on failure.
    if (queueDisabled) {
      throw new Error("Failed to erase memory objects");
    }
  }
  return {
    enabled:
      typeof result?.effective_enabled === "boolean"
        ? result.effective_enabled
        : (args.enabled ?? args.file.enabled),
    content: "",
    version:
      result?.new_version == null
        ? numberValue(args.file.version) + 1
        : numberValue(result.new_version),
    hash: null,
    updated_at:
      typeof result?.mutation_at === "string"
        ? result.mutation_at
        : new Date().toISOString(),
    updated_by:
      typeof result?.mutation_by === "string"
        ? result.mutation_by
        : args.updatedBy,
    source: args.source ?? "wipe",
    status: "idle",
  };
}

export async function enableMemoryFile(
  db: Db,
  file: MemoryFileRow,
  updatedBy: string,
): Promise<MemoryCurrent> {
  if (file.enabled) {
    return (
      await getMemoryCurrent(
        db,
        file.scope,
        (file.user_id ?? file.project_id) as string,
      )
    ).current;
  }
  const { data, error } = await db.rpc("enable_memory_file", {
    p_memory_file_id: file.id,
    p_updated_by: updatedBy,
  });
  if (error) throw new Error("Failed to enable memory");
  const result = Array.isArray(data) ? data[0] : data;
  return {
    enabled: true,
    content: "",
    version: numberValue(result?.new_version ?? file.version),
    hash: null,
    updated_at:
      typeof result?.mutation_at === "string" ? result.mutation_at : file.updated_at,
    updated_by:
      typeof result?.mutation_by === "string" ? result.mutation_by : updatedBy,
    source: "settings",
    status: "idle",
  };
}

export async function memoryVersionContent(
  db: Db,
  fileId: string,
  versionId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("memory_file_versions")
    .select("*")
    .eq("id", versionId)
    .eq("memory_file_id", fileId)
    .maybeSingle();
  if (error) throw new Error("Failed to load memory version");
  if (!data) return null;
  return verifiedVersionContent(data as MemoryVersionRow);
}
