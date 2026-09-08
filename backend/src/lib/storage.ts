/**
 * Object storage facade for Mike document management.
 *
 * The transport lives behind the StorageAdapter interface
 * (./storage/adapter.ts); the default is the S3-protocol adapter
 * (./storage/s3.ts — Cloudflare R2, RustFS, MinIO). This module owns the
 * policy every backend shares: not-configured degradation (reads return
 * null/empty, writes throw), error logging, Content-Disposition building,
 * and the storage-key layout.
 *
 * Deployments on a different object store implement StorageAdapter in one
 * file and call setStorageAdapter() at boot; no call sites change.
 */

import { Readable } from "node:stream";
import type { StorageAdapter } from "./storage/adapter";
import { createS3StorageAdapter } from "./storage/s3";

export type { StorageAdapter, StoredObjectMetadata } from "./storage/adapter";
import type { StoredObjectMetadata } from "./storage/adapter";

let adapter: StorageAdapter = createS3StorageAdapter();

export let storageEnabled = adapter.enabled;

/** Replace the storage backend. Call before the first request is served. */
export function setStorageAdapter(next: StorageAdapter): void {
  adapter = next;
  storageEnabled = next.enabled;
}

export class StorageOperationError extends Error {
  constructor(operation: string, options?: { cause?: unknown }) {
    super(`Object storage ${operation} failed`, options);
    this.name = "StorageOperationError";
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function uploadFile(
  key: string,
  content: ArrayBuffer,
  contentType: string,
): Promise<void> {
  if (!adapter.enabled) throw new Error(adapter.configurationHint);
  await adapter.uploadFile(key, content, contentType);
}

export async function uploadFileFromPath(
  key: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  if (!adapter.enabled) throw new Error(adapter.configurationHint);
  try {
    await adapter.uploadFileFromPath(key, filePath, contentType);
  } catch (error) {
    throw new StorageOperationError("upload", { cause: error });
  }
}

/**
 * Presign a single direct browser `PUT`. The declared content type and byte
 * count are part of the signature, so the URL cannot be replayed with a
 * different body: the browser sets `Content-Length` from the body itself, and
 * any other size fails signature validation at the store.
 */
export async function getSignedUploadUrl(
  key: string,
  contentType: string,
  expectedSizeBytes: number,
  expiresIn = 900,
): Promise<string | null> {
  if (!adapter.enabled) return null;
  try {
    return await adapter.getSignedUploadUrl(
      key,
      contentType,
      expectedSizeBytes,
      expiresIn,
    );
  } catch (error) {
    console.error("[storage] getSignedUploadUrl failed", { key, error });
    return null;
  }
}

export async function headFile(
  key: string,
): Promise<StoredObjectMetadata | null> {
  if (!adapter.enabled) return null;
  try {
    return await adapter.headFile(key);
  } catch (error) {
    console.error("[storage] headFile failed", { key, error });
    throw new StorageOperationError("HEAD", { cause: error });
  }
}

export async function copyFile(
  sourceKey: string,
  targetKey: string,
): Promise<void> {
  if (!adapter.enabled) throw new Error(adapter.configurationHint);
  try {
    await adapter.copyFile(sourceKey, targetKey);
  } catch (error) {
    throw new StorageOperationError("copy", { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export async function downloadFile(key: string): Promise<ArrayBuffer | null> {
  if (!adapter.enabled) return null;
  try {
    return await adapter.downloadFile(key);
  } catch (error) {
    console.error("[storage] downloadFile failed", {
      key,
      error: error,
    });
    return null;
  }
}

/**
 * Lazily stream an object from storage. The GET starts only when a consumer
 * reads from the returned stream, allowing archive writers to apply
 * backpressure without buffering whole files or opening every object
 * concurrently.
 */
export function createFileReadStream(key: string): Readable {
  return Readable.from(
    (async function* () {
      if (!adapter.enabled) throw new Error(adapter.configurationHint);
      try {
        yield* adapter.downloadFileStream(key);
      } catch (error) {
        console.error("[storage] createFileReadStream failed", { key, error });
        if (error instanceof StorageOperationError) throw error;
        throw new StorageOperationError("download", { cause: error });
      }
    })(),
  );
}

export async function listFiles(prefix: string): Promise<string[]> {
  if (!adapter.enabled) return [];
  return adapter.listFiles(prefix);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteFile(key: string): Promise<void> {
  if (!adapter.enabled) return;
  await adapter.deleteFile(key);
}

// ---------------------------------------------------------------------------
// Signed URL (pre-signed for temporary direct access)
// ---------------------------------------------------------------------------

export async function getSignedUrl(
  key: string,
  expiresIn = 3600,
  downloadFilename?: string,
): Promise<string | null> {
  if (!adapter.enabled) return null;
  try {
    // Override the response Content-Disposition so the browser uses this
    // filename on download, instead of the last path segment of the storage
    // key (which includes the document UUID). The `download` attribute on <a>
    // is ignored for cross-origin URLs, so we have to set it server-side.
    const responseContentDisposition = downloadFilename
      ? buildContentDisposition("attachment", downloadFilename)
      : undefined;
    return await adapter.getSignedUrl(
      key,
      expiresIn,
      responseContentDisposition,
    );
  } catch (error) {
    console.error("[storage] getSignedUrl failed", {
      key,
      error: error,
    });
    return null;
  }
}

export function normalizeDownloadFilename(name: string): string {
  const trimmed = name.trim();
  const base = trimmed || "download";
  return base.replace(/[\x00-\x1F\x7F]/g, "_").replace(/[\\/]/g, "_");
}

export function sanitizeDispositionFilename(name: string): string {
  return normalizeDownloadFilename(name)
    .replace(/["\\]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_");
}

export function encodeRFC5987(str: string): string {
  return encodeURIComponent(str).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function buildContentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const normalized = normalizeDownloadFilename(filename);
  return `${kind}; filename="${sanitizeDispositionFilename(normalized)}"; filename*=UTF-8''${encodeRFC5987(normalized)}`;
}

// ---------------------------------------------------------------------------
// Storage key helpers
// ---------------------------------------------------------------------------

export function storageKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/source${storageExtension(filename, ".bin")}`;
}

export function pdfStorageKey(
  userId: string,
  docId: string,
  stem: string,
): string {
  return `documents/${userId}/${docId}/${stem}.pdf`;
}

export function generatedDocKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `generated/${userId}/${docId}/generated${storageExtension(filename, ".docx")}`;
}

export function versionStorageKey(
  userId: string,
  docId: string,
  versionSlug: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/versions/${versionSlug}${storageExtension(filename, ".bin")}`;
}

/**
 * Cache slot for a document version's extracted plain text (see the
 * document.precompute_text job). Keyed by version id alone: versions are
 * immutable apart from two in-place rewrite sites, both of which invalidate
 * this key, so the version id fully identifies the bytes the text came from.
 */
export function extractedTextKey(versionId: string): string {
  return `extracted-text/${versionId}.txt`;
}

function storageExtension(filename: string, fallback: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return fallback;
  const ext = filename.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : fallback;
}
