/**
 * In-memory S3 mock for Phase 12 worker integration tests.
 *
 * Provides ListObjectsV2Command / DeleteObjectsCommand / PutObjectCommand
 * dispatch so the account-deletion worker can be tested without a live R2
 * bucket.
 *
 * Usage:
 *   const mock = createR2Mock();
 *   mock.put("documents/user1/doc1/source.docx", Buffer.from("test"));
 *   const client = mock.installAsAwsClient();
 *   // Pass client to worker under test via dependency injection
 */

import type {
  ListObjectsV2Command,
  DeleteObjectsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

export interface R2MockStore {
  /** Add or replace an object in the mock store. */
  put(key: string, body: Buffer): void;

  /**
   * List objects with a given prefix, mimicking S3 ListObjectsV2 pagination.
   *
   * @param prefix          Key prefix filter (e.g. "documents/user1/")
   * @param continuationToken  Resume token from a previous call
   * @param maxKeys         Maximum keys to return per page (default 1000)
   */
  list(
    prefix: string,
    continuationToken?: string,
    maxKeys?: number,
  ): { keys: string[]; nextToken?: string };

  /**
   * Delete multiple keys atomically.
   *
   * @returns deleted  Keys successfully deleted
   * @returns errors   Keys that could not be deleted (always empty in mock)
   */
  deleteMany(keys: string[]): { deleted: string[]; errors: string[] };

  /**
   * Returns an S3-client-shaped object whose `.send(cmd)` dispatches
   * ListObjectsV2Command / DeleteObjectsCommand / PutObjectCommand to the
   * in-memory store.  Pass this as the S3Client to the worker under test.
   */
  installAsAwsClient(): MockS3Client;
}

export interface MockS3Client {
  send(cmd: unknown): Promise<unknown>;
}

export function createR2Mock(): R2MockStore {
  const store = new Map<string, Buffer>();

  function put(key: string, body: Buffer): void {
    store.set(key, body);
  }

  function list(
    prefix: string,
    continuationToken?: string,
    maxKeys = 1000,
  ): { keys: string[]; nextToken?: string } {
    const allKeys = Array.from(store.keys())
      .filter((k) => k.startsWith(prefix))
      .sort();

    const startIndex = continuationToken
      ? allKeys.indexOf(continuationToken) + 1
      : 0;

    const page = allKeys.slice(startIndex, startIndex + maxKeys);
    const nextIndex = startIndex + maxKeys;
    const nextToken = nextIndex < allKeys.length ? allKeys[nextIndex - 1] : undefined;

    return { keys: page, nextToken };
  }

  function deleteMany(keys: string[]): { deleted: string[]; errors: string[] } {
    const deleted: string[] = [];
    for (const key of keys) {
      if (store.has(key)) {
        store.delete(key);
        deleted.push(key);
      }
    }
    return { deleted, errors: [] };
  }

  function installAsAwsClient(): MockS3Client {
    return {
      async send(cmd: unknown): Promise<unknown> {
        const name = (cmd as { constructor: { name: string } }).constructor.name;

        if (name === "ListObjectsV2Command") {
          const c = cmd as InstanceType<typeof ListObjectsV2Command>;
          const input = c.input as {
            Prefix?: string;
            ContinuationToken?: string;
            MaxKeys?: number;
          };
          const prefix = input.Prefix ?? "";
          const { keys, nextToken } = list(
            prefix,
            input.ContinuationToken,
            input.MaxKeys,
          );
          return {
            Contents: keys.map((k) => ({ Key: k })),
            NextContinuationToken: nextToken,
            IsTruncated: nextToken !== undefined,
          };
        }

        if (name === "DeleteObjectsCommand") {
          const c = cmd as InstanceType<typeof DeleteObjectsCommand>;
          const input = c.input as {
            Delete?: { Objects?: Array<{ Key?: string }> };
          };
          const keys = (input.Delete?.Objects ?? [])
            .map((o) => o.Key ?? "")
            .filter(Boolean);
          const { deleted, errors } = deleteMany(keys);
          return {
            Deleted: deleted.map((k) => ({ Key: k })),
            Errors: errors.map((k) => ({ Key: k, Code: "InternalError" })),
          };
        }

        if (name === "PutObjectCommand") {
          const c = cmd as InstanceType<typeof PutObjectCommand>;
          const input = c.input as { Key?: string; Body?: Buffer };
          const key = input.Key ?? "";
          put(key, input.Body ?? Buffer.alloc(0));
          return {};
        }

        throw new Error(`[r2Mock] unsupported command: ${name}`);
      },
    };
  }

  return { put, list, deleteMany, installAsAwsClient };
}
