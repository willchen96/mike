# Scoped memory

Mike can maintain one private Markdown file named `memory.md` for a user and
one shared Markdown file for each project. Memory is optional, inspectable, and
editable. It is reference context for later conversations; it is not a source
of authorization, instructions, or citations.

## Scope and permissions

- App memory belongs to one user. Only that user can read, edit, restore,
  enable, disable, or wipe it.
- Project memory belongs to the project. Members with `project.view` can read
  it, members with `content.edit` can edit or restore it, and members with
  `access.manage` can enable, disable, or wipe it.
- Both scopes are on by default: a new account's app memory is enabled when
  the account is created, and a new project's shared memory is enabled unless
  its creator clears the toggle. Turning either off is destructive — see
  "Disable, wipe, and deletion".
- A project curator runs separately from the actor's app curator and never
  receives app memory. This prevents private app context from being copied into
  shared project memory.
- When facts conflict, the current conversation wins over project memory, and
  project memory wins over app memory.
- Project and otherwise shared responses may use the active actor's app memory
  for non-sensitive response preferences, but the live model is explicitly
  forbidden from exposing a detail found only in that private app memory to
  other people. Private-detail disclosure cases belong in the launch isolation
  evaluation.

The live model receives enabled memory in an earliest synthetic user message,
delimited as untrusted data. A system policy states that memory cannot grant
permissions, change policy, or trigger tools by itself.

## How memory is learned

Memory maintenance is deliberately outside the live response path. After a
terminal assistant response has been saved successfully, the backend schedules
durable curation for five minutes after the most recent completed turn. Each
new completed turn restarts that quiet window for every actor with unprocessed
work in the conversation. Superseded jobs exit before invoking a model.

The curator reloads the authoritative transcript, permissions, settings, and
current memory when it runs. It receives exactly one server-bound tool:

```ts
write_memory_file({ expectedVersion, markdown, changeSummary });
```

The model cannot select a user, project, or storage path. It may make no tool
call when the transcript contains nothing durable and useful. When it does
write, it supplies the complete replacement file, which lets it add, correct,
reorganize, deduplicate, or remove entries.

Good memory candidates include stable preferences, recurring facts,
terminology, goals, working conventions, constraints, and project decisions.
The curator is instructed not to retain credentials or other secrets,
short-lived tasks, unsupported sensitive inferences, or unendorsed material
copied from documents, web pages, or tool results.

Only attributed messages at or before the successfully completed terminal turn
are eligible. Error and cancelled turns, `ask_inputs` pauses, local-only Word
chats, title generation, extraction calls, and historical backfill are
excluded. App-memory learning uses only the actor's attributed input. Project
learning may use attributed input from project members.

## Persistence and concurrency

Canonical UTF-8 Markdown is stored as immutable private objects:

```text
memories/users/<userId>/versions/<versionId>/memory.md
memories/projects/<projectId>/versions/<versionId>/memory.md
```

Postgres stores settings, the current pointer and version, SHA-256, size,
provenance, job receipts, and scheduling fences. It does not store the
canonical Markdown body. Content is normalized to LF, raw executable HTML and
unsafe control characters are rejected, and a file may contain at most 16 KiB.
The latest 50 committed versions are retained.

Manual and curator writes use compare-and-swap. The backend registers an
immutable upload candidate and its cleanup job before uploading, then advances
the head only when the expected version and epoch still match. Hash-identical
output records no new version. A curator that loses a version race reloads and
regenerates rather than overwriting newer content.

## Disable, wipe, and deletion

Disabling memory is destructive. It fences queued and in-flight work, deletes
current and historical version metadata, schedules deletion of the exact
storage objects, and advances the learning cutoff. Re-enabling starts with a
blank file and learns only from later completed turns.

Wiping performs the same purge while preserving the enabled setting. Future
conversations may therefore recreate memory after a wipe. Account deletion
purges the user's app memory. Project deletion purges that project's shared
memory; deleting a contributor does not delete project memory.

Object deletion is attempted immediately and backed by durable cleanup jobs.
Committed memory objects should be physically deleted within two minutes of a
wipe or disable, with a p99 target of ten minutes. An uncommitted candidate has
a one-hour safety grace period and should be deleted within ten minutes after
that period. Cleanup jobs retry until the object is gone.

## Operations

The normal backend entry point must run the durable database-job worker.
Production deployments must leave `DB_JOBS_ENABLED` enabled; setting it to
`false` disables automatic curation and causes writes that need durable object
cleanup to be refused rather than acknowledged unsafely. Redis delivery is an
optional accelerator—the PostgreSQL outbox and poller remain authoritative.

Configuration:

- `MEMORY_INACTIVITY_SECONDS` controls the quiet window and defaults to `300`.
- `MEMORY_ACTIVE_LEASE_SECONDS` bounds crash recovery for an active response
  and defaults to `1800` (values are clamped to 60–14400 seconds).
- `MEMORY_CURATOR_MODEL` optionally overrides the curator model. Without an
  override, Mike resolves an available model for the actor and applies the
  normal lightweight title-model selection.

Operational logs contain sanitized identifiers and outcomes only. Queue
payloads contain IDs and cursors, not transcripts, credentials, or memory
content. Account exports include the applicable current memory and retained
revisions.

## Launch checklist

Before enabling memory in production, run the lowest-level automated and
integration suites plus an evaluation set of synthetic conversations. Treat
the following as launch gates, not assumed properties:

- retention precision is acceptable on durable and transient examples;
- credential, API-key, privileged-data, and unsupported-sensitive-inference
  cases produce no critical secret-storage failures;
- app context never appears in project-curator input or project memory;
- outsider, viewer, editor, and owner API permissions match the scope model;
- concurrent manual, curator, restore, disable, wipe, account-delete, and
  project-delete races do not lose updates or resurrect erased content;
- 95% of eligible jobs settle within two minutes after the quiet window and
  99% within ten minutes; and
- live-chat latency shows no material regression.

Use synthetic data for this evaluation and verify storage deletion directly as
described in [Safe local testing](safe-local-testing.md).
