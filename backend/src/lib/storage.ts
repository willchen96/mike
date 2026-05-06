/**
 * Supabase Storage utilities for Mike document management.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 * Optional:
 *   SUPABASE_STORAGE_BUCKET (default: "legal")
 */

import { createClient } from "@supabase/supabase-js";

const BUCKET = (process.env.SUPABASE_STORAGE_BUCKET || "legal").trim() || "legal";

function getClient() {
  const supabaseUrl = (process.env.SUPABASE_URL || "").trim();
  const serviceKey = (process.env.SUPABASE_SECRET_KEY || "").trim();
  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      "Supabase storage is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY.",
    );
  }
  return createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
}

export const storageEnabled = Boolean(
  (process.env.SUPABASE_URL || "").trim() &&
    (process.env.SUPABASE_SECRET_KEY || "").trim(),
);

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function uploadFile(
  key: string,
  content: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const supabase = getClient();
  const { error } = await supabase.storage.from(BUCKET).upload(key, Buffer.from(content), {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export async function downloadFile(key: string): Promise<ArrayBuffer | null> {
  if (!storageEnabled) return null;
  const supabase = getClient();
  const { data, error } = await supabase.storage.from(BUCKET).download(key);
  if (error || !data) return null;
  return data.arrayBuffer();
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteFile(key: string): Promise<void> {
  if (!storageEnabled) return;
  const supabase = getClient();
  const { error } = await supabase.storage.from(BUCKET).remove([key]);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Signed URL (temporary direct access)
// ---------------------------------------------------------------------------

export async function getSignedUrl(
  key: string,
  expiresIn = 3600,
  downloadFilename?: string,
): Promise<string | null> {
  if (!storageEnabled) return null;
  const supabase = getClient();
  const normalizedName = downloadFilename
    ? normalizeDownloadFilename(downloadFilename)
    : undefined;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(key, expiresIn, normalizedName ? { download: normalizedName } : undefined);

  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

export function normalizeDownloadFilename(name: string): string {
  const trimmed = name.trim();
  const base = trimmed || "download";
  return base.replace(/[\x00-\x1F\x7F]/g, "_").replace(/[\\/]/g, "_");
}

export function sanitizeDispositionFilename(name: string): string {
  return normalizeDownloadFilename(name).replace(/["\\]/g, "_");
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

function storageExtension(filename: string, fallback: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return fallback;
  const ext = filename.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : fallback;
}
