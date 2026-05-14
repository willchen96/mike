import type { RequestHandler } from "express";
import multer from "multer";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import { basename } from "path";

export const MAX_UPLOAD_SIZE_MB = 100;
export const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

const diskUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmpdir()),
    filename: (_req, _file, cb) => cb(null, randomUUID()),
  }),
  limits: {
    fileSize: MAX_UPLOAD_SIZE_BYTES,
    files: 1,
  },
});

export function singleFileUpload(fieldName: string): RequestHandler {
  return (req, res, next) => {
    diskUpload.single(fieldName)(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return void res.status(413).json({
            detail: `File too large. Maximum size is ${MAX_UPLOAD_SIZE_MB} MB.`,
          });
        }
        return void res.status(400).json({
          detail: `Upload failed: ${err.message}`,
        });
      }

      return next(err);
    });
  };
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => {});
}

export function sanitizeFilename(raw: string): string {
  // Step 1: basename strips any directory component (path traversal protection)
  // "../../etc/passwd" -> "passwd"; "foo/bar.docx" -> "bar.docx"
  let safe = basename(raw);
  // Step 2: strip characters dangerous in HTML or on filesystems
  // Keep: alphanumeric, space, hyphen, underscore, dot, parens, brackets
  safe = safe.replace(/[^a-zA-Z0-9 ._\-()[\]]/g, "_");
  // Step 3: trim leading dots (hidden files on Unix)
  safe = safe.replace(/^\.+/, "");
  return safe || "upload";
}
