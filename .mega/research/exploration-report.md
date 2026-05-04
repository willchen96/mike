# Mike — Exploration Report

Generated: 2026-05-04
Project root: /Users/isaacbang/Documents/ClaudeCode/GTMResearch/mike

---

## Project Overview

Mike is a full-stack AI legal assistant for lawyers and legal professionals. It lets users upload legal documents (PDF/DOCX), chat with an LLM that reads and cites those documents, generate or edit Word files with tracked changes, and run structured "tabular reviews" (extracting fields from document sets into a spreadsheet-like UI). The system supports multi-user collaboration via shared projects and directly-shared reviews.

**Architecture:**
- Backend: Node.js/Express (TypeScript, tsx dev server) at `backend/`
- Frontend: Next.js 16 / React 19 (TypeScript) deployed to Cloudflare via opennextjs at `frontend/`
- Database: Supabase (PostgreSQL) with RLS, JWT auth
- File storage: Cloudflare R2 (S3-compatible)
- LLM providers: Anthropic Claude (claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5) and Google Gemini (gemini-3.1-pro-preview, gemini-3-flash-preview, gemini-3.1-flash-lite-preview)
- No vector store / RAG — documents are loaded on-demand as plain text injected into the LLM context window

---

## Per-File Analysis

### backend/src/index.ts
- **Role:** Entry point
- **Node type:** Code
- **Purpose:** Bootstraps Express app; registers routers for chat, projects, projectChat, single-documents, tabular-review, workflows, user, download. Exposes `/health`. Reads PORT from env (default 3001). CORS gated to `FRONTEND_URL` env var.
- **LLM calls:** None
- **Data flow:** HTTP request → router dispatch → response
- **Optimizable elements:** CORS origin could be more granular; json body limit 50mb is generous (security surface)
- **Data loading:** No external data loading

---

### backend/src/middleware/auth.ts
- **Role:** Middleware / utility
- **Node type:** Code
- **Purpose:** `requireAuth` middleware — validates Bearer JWT using Supabase admin client (`auth.getUser`). Sets `res.locals.userId` and `res.locals.userEmail`. Instantiates a new Supabase admin client **per request** (security concern: exposes service role key usage on every call).
- **LLM calls:** None
- **Data flow:** Authorization header → Supabase JWT verification → userId/email injected into locals
- **Security issues:**
  - `res.locals.token` stores the raw JWT in response locals — this raw token propagates to all downstream handlers without expiry enforcement beyond Supabase's own check.
  - No rate limiting at middleware level.
  - No IP-based throttling.
- **Optimizable elements:** Client should be cached/reused rather than instantiated per request.

---

### backend/src/lib/llm/types.ts
- **Role:** Utility / type definitions
- **Node type:** Code
- **Purpose:** Defines shared types for the LLM provider abstraction: `Provider`, `OpenAIToolSchema`, `LlmMessage`, `NormalizedToolCall`, `NormalizedToolResult`, `StreamCallbacks`, `UserApiKeys`, `StreamChatParams`, `StreamChatResult`.
- **Key design note:** `enableThinking` flag on `StreamChatParams` controls whether reasoning/thinking is surfaced.
- **LLM calls:** None

---

### backend/src/lib/llm/models.ts
- **Role:** Utility / configuration
- **Node type:** Code
- **Purpose:** Defines canonical model IDs by tier and provider. Three tiers: main-chat (user picks), mid-tier (tabular review), low-tier (title generation, lightweight extraction). Defaults all to Gemini unless user has keys.
- **Models:**
  - Main: `claude-opus-4-7`, `claude-sonnet-4-6`, `gemini-3.1-pro-preview`, `gemini-3-flash-preview`
  - Mid: `claude-sonnet-4-6`, `gemini-3-flash-preview`
  - Low: `claude-haiku-4-5`, `gemini-3.1-flash-lite-preview`
  - Default main: `gemini-3-flash-preview`
  - Default tabular: `gemini-3-flash-preview`
  - Default title: `gemini-3.1-flash-lite-preview`
- **Optimizable elements:** Model selection logic; users can supply their own API keys stored encrypted (or plaintext?) in `user_profiles.claude_api_key` / `user_profiles.gemini_api_key` — these are stored in Supabase without any noted encryption-at-rest by the application.

---

### backend/src/lib/llm/tools.ts
- **Role:** Utility
- **Node type:** Code
- **Purpose:** Converts OpenAI-style tool schemas to Claude (`toClaudeTools`) and Gemini (`toGeminiTools`) formats. Includes schema normalization to handle edge cases (empty property sets, missing array items).
- **LLM calls:** None

---

### backend/src/lib/llm/claude.ts
- **Role:** Node / LLM adapter
- **Node type:** LLM
- **Purpose:** `streamClaude` — runs a multi-turn agentic loop (up to `maxIter=10` iterations) using `anthropic.messages.stream`. Calls `runTools` callback after each `tool_use` stop. Supports extended thinking (`enableThinking: true` sends `thinking.type: "adaptive"` and `output_config: { effort: "high" }`). `completeClaudeText` — single-shot non-streaming completion (max 512 tokens default).
- **Security issue:** Raw stream events are logged to `claude-raw-stream.log` via `fs.appendFile` on every event — this log will accumulate **all document text, tool call arguments, and legal content** in plaintext on disk with no rotation or cleanup.
- **LLM calls:**
  - Model: user-selected from `CLAUDE_MAIN_MODELS`
  - max_tokens: 16384
  - Temperature: omitted when `enableThinking=true` (required by API)
  - Tools: passed as full OpenAI-style schema
- **Optimizable elements:** Log file exposure, MAX_TOKENS hardcoded, per-request client instantiation.

---

### backend/src/lib/llm/gemini.ts
- **Role:** Node / LLM adapter
- **Node type:** LLM
- **Purpose:** `streamGemini` — same multi-turn agentic loop for Google Gemini. Handles Gemini's `thoughtSignature` echo requirement. `thinkingBudget: 0` when thinking disabled (avoids token waste). `completeGeminiText` — single-shot non-streaming.
- **Security issue:** Stream chunks logged to console via `console.log` (includes full document text passed to Gemini, tool args, etc.)
- **LLM calls:**
  - Model: user-selected from `GEMINI_MAIN_MODELS`
  - thinkingConfig driven by `enableThinking` flag
- **Optimizable elements:** Console.log of raw chunks in production.

---

### backend/src/lib/llm/index.ts
- **Role:** Node / LLM router
- **Node type:** Code
- **Purpose:** `streamChatWithTools` dispatches to Claude or Gemini based on model prefix. `completeText` does the same for one-shot calls. Single export point for all LLM usage.
- **LLM calls:** Delegates to claude.ts / gemini.ts

---

### backend/src/lib/chatTools.ts
- **Role:** Core agentic node — the largest and most critical file (~2,617 lines)
- **Node type:** Agentic (multi-turn tool-use loop, coordinates all tool execution)
- **Purpose:** Contains: system prompt definition, all tool schemas, document context building, message formatting, the main `runLLMStream` streaming orchestrator, tool dispatch (`runToolCalls`), citation parsing, document generation (`generateDocx`), document editing (`runEditDocument`), and PDF/DOCX text extraction utilities.
- **LLM calls:**
  - System prompt: `SYSTEM_PROMPT` constant (see security section — ~1,500 chars of legal assistant instructions including citation format, docx generation rules, workflow rules)
  - Agentic loop via `streamChatWithTools` in `runLLMStream` with `enableThinking: true` always on for the interactive chat surface
  - Up to 10 tool iterations per turn

**Tools defined:**
| Tool name | Description |
|---|---|
| `read_document` | Read full text of a document by slug |
| `find_in_document` | Ctrl+F search with context window |
| `generate_docx` | Generate a Word document from structured sections |
| `edit_document` | Propose tracked-change edits to a DOCX |
| `list_documents` | List available documents (project extra) |
| `fetch_documents` | Bulk read multiple documents |
| `replicate_document` | Copy a document (project extra, up to 20 copies) |
| `list_workflows` | List available workflows |
| `read_workflow` | Load a workflow's full prompt |
| `read_table_cells` | Read tabular review cell data |

**Security concerns in chatTools.ts:**
- `buildDocContext` fetches all documents the user has access to and exposes them all as `doc-N` labels — cross-user isolation is enforced via `.eq("user_id", userId)` query but only for standalone documents; project documents rely on `checkProjectAccess` upstream in the route handler.
- `resolveDocLabel` falls back to matching by filename, which could be confused if two documents share the same filename.
- Document text is passed raw as LLM context (up to 120,000 characters for tabular extraction); no sanitization of document content before injecting into prompts.
- `docIndex` is passed by reference and mutated during tool execution — in-place mutation of shared state could cause issues if concurrent requests share memory (they don't in Node.js single-threaded model, but worth noting).
- Generated `.docx` files are stored to Cloudflare R2 with predictable key pattern: `generated/{userId}/{docId}/generated.docx` — no randomness beyond the UUID which is `crypto.randomUUID()` (fine).

**Data flow:** User message + doc attachments → `buildDocContext` (builds docStore+docIndex from Supabase) → `buildMessages` (injects SYSTEM_PROMPT + doc availability list) → `enrichWithPriorEvents` (appends prior tool activity summary to last assistant message) → `runLLMStream` (streaming agentic loop) → `runToolCalls` (dispatches each tool, returns results to LLM) → `extractAnnotations` (citation parsing) → Supabase insert (assistant message)

---

### backend/src/lib/storage.ts
- **Role:** Utility / data layer
- **Node type:** Code
- **Purpose:** R2 storage adapter (upload, download, delete, signed URLs). Key helpers for path construction. `storageEnabled` flag prevents crashes when R2 env vars absent.
- **Security issues:**
  - A new `S3Client` is instantiated on every call to `getClient()` — no connection pooling.
  - `downloadFilename` override in `getSignedUrl` goes through `sanitizeDispositionFilename` but uses a broad regex; non-ASCII filenames could produce unexpected Content-Disposition headers.
  - No file size validation before upload.

---

### backend/src/lib/supabase.ts
- **Role:** Utility / data layer
- **Node type:** Code
- **Purpose:** Creates a Supabase admin client using `SUPABASE_URL` + `SUPABASE_SECRET_KEY` (service role). No session persistence. Used throughout backend.
- **Security issue:** Service role key is used everywhere — this key bypasses Supabase Row Level Security. If any backend route has a logic bug, the service role key means there is no RLS safety net.

---

### backend/src/lib/userSettings.ts
- **Role:** Utility
- **Node type:** Code
- **Purpose:** Reads `user_profiles` table for `tabular_model`, `claude_api_key`, `gemini_api_key`. `resolveTitleModel` picks cheapest available model. API keys are returned as-is from the database (plaintext strings).
- **Security issue:** User-supplied API keys (`claude_api_key`, `gemini_api_key`) are stored as plaintext text columns in Supabase and retrieved by the backend service without any application-layer decryption. If the database is compromised, all user API keys are exposed.

---

### backend/src/lib/access.ts
- **Role:** Utility / authorization
- **Node type:** Code
- **Purpose:** Project and document access helpers — `checkProjectAccess`, `ensureDocAccess`, `ensureReviewAccess`, `listAccessibleProjectIds`. Owner OR shared-project-member access model using `shared_with` JSONB columns.
- **Security note:** Email comparison is lowercased on both sides (good). Access checks are always done per-request (no caching — correct for security, but potentially expensive for large `shared_with` arrays).

---

### backend/src/lib/builtinWorkflows.ts
- **Role:** Configuration / data
- **Node type:** Code
- **Purpose:** Defines 3 built-in legal workflow templates: "Generate CP Checklist", "Credit Agreement Summary", "Shareholder Agreement Summary". Each is a long `prompt_md` string that the LLM follows when the workflow is loaded. These are injected verbatim as tool results.
- **Optimizable elements:** Workflow prompts could be externalized to a DB table or files for easier iteration without redeployment.

---

### backend/src/lib/documentVersions.ts
- **Role:** Utility / data layer
- **Node type:** Code
- **Purpose:** Manages document version history. `loadActiveVersion` resolves the current active file path. `attachActiveVersionPaths` and `attachLatestVersionNumbers` batch-enrich document lists from Supabase.
- **LLM calls:** None

---

### backend/src/lib/docxTrackedChanges.ts
- **Role:** Utility / document processing
- **Node type:** Code
- **Purpose:** DOCX tracked-changes engine — parses DOCX XML, applies find/replace edits as Word revision markup (ins/del), extracts body text for LLM reading. Uses `fast-xml-parser` and `jszip`. `applyTrackedEdits` is the main entry point.
- **Security issue:** Parses untrusted DOCX XML from user uploads using `fast-xml-parser`. The parser is configured without explicit entity expansion limits — XXE-style attacks are less relevant for a JS parser but large entity expansion could cause DoS.

---

### backend/src/lib/convert.ts
- **Role:** Utility / document processing
- **Node type:** Code
- **Purpose:** DOCX-to-PDF conversion via LibreOffice (`libreoffice-convert`), DOCX ZIP path normalization for cross-platform compatibility.
- **Security issue:** `libreoffice-convert` runs LibreOffice as a subprocess to convert untrusted user-uploaded DOCX files. LibreOffice document conversion is a known attack surface (macro execution, path traversal in embedded content). No sandbox or resource limit is applied.

---

### backend/src/lib/downloadTokens.ts
- **Role:** Utility
- **Node type:** Code
- **Purpose:** Generates internal download URLs for documents (used instead of pre-signed R2 URLs for server-proxied downloads). URLs are constructed as `/download/{encoded_key}`.
- **Security issue:** If `encoded_key` can be manipulated, an attacker might be able to request arbitrary R2 objects. Actual download route should validate the key against user ownership.

---

### backend/src/lib/upload.ts
- **Role:** Utility
- **Node type:** Code
- **Purpose:** Configures `multer` for in-memory file upload. Exposes `singleFileUpload` middleware.
- **Security concern:** Multer stores files in memory with no explicit size limit beyond Express's 50MB JSON body limit. A malicious user could upload a very large file and exhaust server memory.

---

### backend/src/routes/chat.ts
- **Role:** Entry point / route handler
- **Node type:** Agentic (delegates to `runLLMStream`)
- **Purpose:** CRUD for chats and messages. Main chat endpoint `POST /chat` orchestrates the full LLM pipeline: auth check, doc context build, message enrichment, streaming SSE response, annotation extraction, DB persistence. Also `POST /chat/:chatId/generate-title` uses low-tier LLM for title generation.
- **Security issues:**
  - Chat access check: ownership OR project membership — correct.
  - `hydrateEditStatuses` loads ALL chat messages and iterates over raw JSON content — no schema validation on message content from DB.
  - The `model` param from the request body is passed to `resolveModel` which validates against `ALL_MODELS` set — injection prevented.
  - Title generation prompt includes up to 500 chars of raw user message content with no sanitization — prompt injection risk.

---

### backend/src/routes/documents.ts
- **Role:** Entry point / route handler
- **Node type:** Code
- **Purpose:** CRUD for single documents (not project-scoped). Upload, download, delete, accept/reject tracked changes, rename, version management. Calls LibreOffice conversion on upload for DOCX→PDF.
- **Security issues:**
  - File type validation: checks `file.mimetype` from multer (client-supplied, not reliable) AND checks extension — better, but still client-controlled.
  - `ALLOWED_TYPES = new Set(["pdf", "docx", "doc"])` — `.doc` legacy format is accepted and converted via LibreOffice (expands attack surface).
  - No maximum file size limit enforced in upload route.
  - `resolveTrackedChange` endpoint (`PATCH /:documentId/edits/:editId/resolve`) modifies tracked changes based on action string from request body — `action` is validated to be "accept" or "reject" (good).

---

### backend/src/routes/tabular.ts
- **Role:** Entry point / route handler (largest route file)
- **Node type:** Agentic (delegates to `runLLMStream` for tabular chat; also runs batch LLM extraction)
- **Purpose:** Full tabular review CRUD + two LLM pipelines:
  1. `POST /:reviewId/generate` — batch extraction: for each document × column, calls `queryGeminiAllColumns` (streaming JSON-per-line), parses results, stores to `tabular_cells`.
  2. `POST /:reviewId/chat` — interactive chat over tabular data with `read_table_cells` tool.
  Also: `POST /prompt` uses low-tier LLM to auto-generate column extraction prompts.
- **LLM calls in tabular extraction:**
  - System: `EXTRACTION_SYSTEM` (legal analyst, JSON output)
  - User: `Document: {filename}\n\n{documentText.slice(0, 120_000)}\n\n---\nInstruction: {fullPrompt}{suffix}`
  - Model: user's `tabular_model` (default `gemini-3-flash-preview`)
  - max_tokens: 2048 (single cell), streaming for multi-column
- **Security issues:**
  - `document_ids` array in request body is not validated for ownership before insertion into `tabular_cells` — the access check for the review is done, but the document IDs within the review's cells could reference documents not owned by the user if an attacker crafts the request. The subsequent `db.from("documents").select(...).in("id", docIds)` doesn't filter by user_id, only by id presence.
  - `parseCellContent` receives `cell.content` directly from DB — raw JSON parse with no schema enforcement.
  - `any` casts in tabular chat: `c: any` and `cells ?? []).map((c: any)` — type safety holes.
  - Access to `db.auth.admin.listUsers({ perPage: 1000 })` in the `/people` endpoint fetches all users from Supabase auth — this is potentially expensive and leaks minimal user data (email, id) but is restricted to owners.

---

### backend/src/routes/projectChat.ts
- **Role:** Entry point / route handler
- **Node type:** Agentic (delegates to `runLLMStream`)
- **Purpose:** Project-scoped chat — loads all project documents into doc context (not just user-attached files), adds `PROJECT_EXTRA_TOOLS` (list_documents, fetch_documents, replicate_document). Otherwise mirrors `chat.ts`.
- **Security note:** Loads ALL documents in a project for any project member — correct behavior, but means a collaborator can trigger reads on all project documents.

---

### backend/src/routes/workflows.ts
- **Role:** Entry point / route handler
- **Node type:** Code
- **Purpose:** CRUD for user-defined workflows. Also returns built-in workflows. Sharing via `workflow_shares` table.
- **LLM calls:** None directly (workflow prompts are templates authored by users/admins)
- **Security issue:** Workflow `prompt_md` is user-authored text that gets injected verbatim into the LLM system prompt when `read_workflow` tool is called. A malicious workflow author could craft prompt injection payloads.

---

### backend/src/routes/projects.ts
- **Role:** Entry point / route handler
- **Node type:** Code
- **Purpose:** CRUD for projects, document management within projects (upload, CRUD), subfolder management, sharing (add/remove members by email), people listing.
- **Security issues:**
  - `POST /projects/:projectId/documents` — uploads files to project. File type check same as documents.ts.
  - Subfolder creation: `parent_folder_id` is accepted from request body and inserted without verifying the parent folder belongs to the same project — potential cross-project folder injection.
  - `GET /:projectId/people` calls `db.auth.admin.listUsers({ perPage: 1000 })` to resolve emails to display names — full user list fetch per request.

---

### backend/src/routes/user.ts
- **Role:** Entry point / route handler
- **Node type:** Code
- **Purpose:** User profile CRUD, API key management (set claude/gemini keys), model preferences, invite by email (via Resend). Also handles `POST /users/invite` sending invitation emails.
- **Security issues:**
  - `PATCH /user/api-keys` stores API keys from request body directly to `user_profiles.claude_api_key` / `user_profiles.gemini_api_key` as plaintext. No encryption at application layer.
  - Invite email sends with user's own display_name interpolated directly into email body — XSS potential if email client renders HTML (depends on Resend template format).

---

### backend/src/routes/downloads.ts
- **Role:** Entry point / route handler
- **Node type:** Code
- **Purpose:** Proxies R2 file downloads. Decodes the storage key from URL path and streams bytes from R2 with correct Content-Disposition headers.
- **Security issue:** The `key` from the URL path is used directly to call `downloadFile(key)` from R2 — if the encoded key is not validated against user ownership, an authenticated user could potentially download any file from the R2 bucket by crafting the download URL. This is a significant path traversal / IDOR risk depending on how `buildDownloadUrl` constructs and how `downloads.ts` validates the key.

---

### frontend/src/app/lib/mikeApi.ts
- **Role:** Utility / API client
- **Node type:** Code
- **Purpose:** All frontend API calls to the Express backend. Attaches Supabase JWT via Authorization header. Handles SSE streaming for chat and tabular generation.
- **Security note:** Auth token is fetched from Supabase client on each API call — correct pattern.

---

### frontend/src/contexts/AuthContext.tsx
- **Role:** Utility / auth context
- **Node type:** Code
- **Purpose:** Wraps Supabase auth state, provides `user` and `session` to the app. Handles sign-in, sign-up, sign-out.

---

### frontend/src/app/components/assistant/ (multiple files)
- **Role:** UI
- **Node type:** Code
- **Purpose:** Chat UI components — `ChatView`, `ChatInput`, `AssistantMessage`, `UserMessage`, `EditCard`, `AssistantSidePanel`, `ModelToggle`, etc.
- **Security note:** `AssistantMessage` renders LLM output — uses `react-markdown` which should prevent XSS, but `rehype-raw` is included in dependencies which allows raw HTML in markdown rendering. If `rehype-raw` is enabled in the markdown renderer, LLM-generated HTML could execute in the user's browser.

---

### frontend/src/app/components/tabular/ (multiple files)
- **Role:** UI
- **Node type:** Code
- **Purpose:** Tabular review table, cell rendering, citation utils, column format/preset definitions, Excel export, prompt generator (client-side helper).
- **Notable:** `prompt-generator.ts` generates column extraction prompts client-side — used as fallback or preview before the backend LLM prompt endpoint is called.

---

### frontend/src/app/components/workflows/ (multiple files)
- **Role:** UI
- **Node type:** Code
- **Purpose:** Workflow list, creation modal, sharing modal, column view/edit for tabular workflows, built-in workflow definitions (client-side copy of `builtinWorkflows.ts`).

---

### frontend/src/lib/fileConverter.ts
- **Role:** Utility
- **Node type:** Code
- **Purpose:** Client-side DOCX→HTML conversion using mammoth.js for preview rendering.

---

## Data Files

- `backend/migrations/000_one_shot_schema.sql` — full Supabase schema (PostgreSQL). Not a training dataset; it is the DB schema definition.
- No `.jsonl`, `.csv`, or training/evaluation data files present anywhere in the project.

---

## Security Surface Summary (for MEGA hardening)

### Critical
1. **Plaintext API key storage** — `user_profiles.claude_api_key` and `user_profiles.gemini_api_key` are stored and retrieved as plaintext strings. Compromise of the Supabase database exposes all user LLM API keys.
2. **Download route IDOR** — `GET /download/:encodedKey` proxies R2 downloads by decoding a key from the URL. If the key is not validated against the requesting user's ownership, any authenticated user can download any R2 object by crafting the URL.
3. **LibreOffice subprocess on untrusted DOCX** — `libreoffice-convert` runs LibreOffice to convert user-uploaded files. LibreOffice is a known exploitation target. No sandboxing applied.
4. **Service role key used everywhere** — the Supabase admin client (`SUPABASE_SECRET_KEY`) bypasses RLS on every backend operation. A logic bug in any route handler can leak or mutate any user's data.

### High
5. **Raw stream log file** — `claude-raw-stream.log` accumulates all LLM stream events including full document text and legal content. No rotation, no cleanup, no access control on the log file.
6. **User API keys injected into LLM calls without validation** — user-supplied Claude/Gemini API keys from DB are passed directly to API clients. A malformed key could cause authentication errors, but more importantly the keys are never validated for format or re-encrypted.
7. **Prompt injection via workflow prompts** — user-authored `prompt_md` in workflows is injected verbatim as a tool result into the LLM context. A shared workflow can contain adversarial instructions targeting other users who run it.
8. **console.log of full Gemini stream chunks** — every Gemini response chunk (including document text passed as context) is logged to stdout/console in production via `console.log("[gemini stream chunk]", JSON.stringify(chunk, null, 2))`.
9. **rehype-raw in frontend markdown renderer** — if enabled, LLM-generated HTML passes through raw to the browser DOM. Risk of stored XSS via crafted LLM responses.

### Medium
10. **No file size limit on uploads** — multer is configured in-memory with no explicit `limits.fileSize`. A large upload exhausts server RAM.
11. **No rate limiting** — no middleware enforces per-user or per-IP rate limits on LLM calls or document uploads.
12. **Supabase admin client instantiated per-request** in `auth.ts` — connection overhead; also exposes service key in every middleware invocation.
13. **`listUsers` called per people-page request** — fetches up to 1,000 Supabase auth users per `/people` or `/tabular-review/:id/people` request, leaking minimal user metadata and creating potential for enumeration.
14. **Cross-project subfolder injection** — `parent_folder_id` in subfolder creation is not validated to belong to the target project.
15. **Title generation prompt injection** — raw first 500 chars of user message injected into title-generation LLM call with no sanitization.
16. **Document content injected into tabular extraction without sanitization** — up to 120,000 chars of raw document text passed to LLM. A maliciously crafted document could attempt prompt injection.
17. **`any` casts in tabular.ts** — bypass TypeScript type safety for cell content processing, masking potential schema violations from DB.

---

## Project-Level Notes

- **Existing code to optimize:** Yes — substantial (full-stack TypeScript application with agentic LLM pipeline, document processing, and tabular review extraction)
- **PRD/specification document:** None found
- **Training/evaluation data:** None — no `.jsonl`, `.csv`, or similar datasets
- **Uses RAG/vector stores:** No — documents are read on-demand and injected as plain text into the LLM context window per turn
- **Calls external tools:** Yes — the LLM calls tool functions (`read_document`, `find_in_document`, `generate_docx`, `edit_document`, `list_documents`, `fetch_documents`, `replicate_document`, `list_workflows`, `read_workflow`, `read_table_cells`), all executed server-side
- **Is multi-turn:** Yes — full conversational memory stored in Supabase, enriched with prior tool-activity summaries each turn; agentic loop supports up to 10 tool iterations per response
- **Primary languages:** TypeScript (backend and frontend)
- **LLM providers:** Anthropic Claude (claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5) and Google Gemini (gemini-3.1-pro, gemini-3-flash, gemini-3.1-flash-lite)
- **Database:** Supabase (PostgreSQL), RLS enabled but bypassed by service role in backend
- **File storage:** Cloudflare R2
- **Auth:** Supabase JWT
- **Deployment:** Cloudflare (frontend via opennextjs), backend likely Railway (nixpacks.toml present)
