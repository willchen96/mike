import "@testing-library/jest-dom/vitest";
import { Blob as NodeBlob } from "node:buffer";

// Vitest's jsdom environment always overrides `globalThis.Blob` with jsdom's
// own Blob implementation, which never implemented `.text()`/`.arrayBuffer()`/
// `.stream()` (it only has `slice`, `size`, `type`). On Node 24 (unlike
// Node 22), the built-in `Response.prototype.blob()` resolves its `Blob`
// constructor dynamically from `globalThis` at call time, so blobs returned
// from a real `Response` end up jsdom-shaped and missing those methods.
// Restoring the real Node `Blob` here (independent of the global, via
// `node:buffer`) keeps `response.blob()` usable the same way on every
// supported Node version. See #361.
globalThis.Blob = NodeBlob as unknown as typeof Blob;
