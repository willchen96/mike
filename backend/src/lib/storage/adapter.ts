/**
 * Transport interface for object-storage backends.
 *
 * The facade in ../storage.ts owns policy — the not-configured degradation
 * (reads return null/empty, writes throw), error logging, and wrapping
 * failures in StorageOperationError — so adapters only move bytes.
 * Implementations may assume their methods are called only while `enabled`
 * is true, and should let errors propagate to the facade.
 *
 * To ship Mike on a different object store (Azure Blob, GCS, local disk),
 * implement this type in one file and pass it to setStorageAdapter() from
 * ../storage.ts before the first request is served. No call site changes.
 */
export type StoredObjectMetadata = {
  size: number;
  etag: string | null;
  contentType: string | null;
};

export type StorageAdapter = {
  /** True when the backing service has all the configuration it needs. */
  readonly enabled: boolean;
  /**
   * Shown in the error thrown when a write is attempted while disabled.
   * Name the exact configuration the operator must set.
   */
  readonly configurationHint: string;
  uploadFile(
    key: string,
    content: ArrayBuffer,
    contentType: string,
  ): Promise<void>;
  /** Stream the file at `filePath` into the store without buffering it. */
  uploadFileFromPath(
    key: string,
    filePath: string,
    contentType: string,
  ): Promise<void>;
  downloadFile(key: string): Promise<ArrayBuffer | null>;
  /**
   * The object's bytes as chunks. The underlying GET must not start until
   * the returned iterable is first read, so archive writers can apply
   * backpressure without opening every object concurrently.
   */
  downloadFileStream(key: string): AsyncIterable<Uint8Array>;
  /** Object metadata, or null when the key does not exist. */
  headFile(key: string): Promise<StoredObjectMetadata | null>;
  copyFile(sourceKey: string, targetKey: string): Promise<void>;
  /** Every key under the prefix, following pagination to the end. */
  listFiles(prefix: string): Promise<string[]>;
  deleteFile(key: string): Promise<void>;
  /**
   * A URL a browser can fetch directly for `expiresIn` seconds.
   * `responseContentDisposition` is a complete Content-Disposition header
   * value the storage service must echo on its response (S3
   * response-content-disposition, Azure SAS rscd).
   */
  getSignedUrl(
    key: string,
    expiresIn: number,
    responseContentDisposition?: string,
  ): Promise<string | null>;
  /**
   * A URL a browser can `PUT` one body to for `expiresIn` seconds. The
   * declared content type and byte count must be bound into the grant so the
   * URL cannot be replayed with a different body.
   */
  getSignedUploadUrl(
    key: string,
    contentType: string,
    expectedSizeBytes: number,
    expiresIn: number,
  ): Promise<string | null>;
};
