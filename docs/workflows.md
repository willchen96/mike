# Workflow packs

## Purpose

A workflow/prompt pack is a file-based way to describe a Mike workflow, its prompt content, and any tabular review columns that guide structured legal review.

This is a proposed declarative format. It does not imply runtime loading, database import, or automatic registration unless and until a workflow importer is added.

The goal is to make workflows easier to review, version, localize, export, import, and contribute without editing TypeScript or opaque runtime data.

## Workflow definition format

Workflow definitions are stored as YAML files that follow the JSON Schema in `schemas/workflow.schema.json`.

Each workflow file maps to the current workflow model fields:

- `id`: stable workflow/prompt pack identifier.
- `title`: human-readable workflow name.
- `type`: workflow mode, either `assistant` or `tabular`.
- `practice`: optional practice area grouping.
- `jurisdiction`: optional jurisdiction metadata for country, state, region, or court-specific packs.
- `language`: optional language metadata for localized packs.
- `version`: optional workflow/prompt pack version.
- `is_system`: optional marker for built-in workflows.
- `prompt_md`: Markdown prompt content used by the workflow.
- `columns_config`: tabular review column definitions, or `null` for assistant workflows.

The workflow pack `id` is a stable file-level identifier. It is not required to
be the same shape as the database primary key. For example, a file can use a
readable id such as `nda-review` even if the current database stores workflow
records with UUID primary keys.

A future importer may map the pack `id` to the database in the simplest safe
way for the storage model, such as by using it directly when supported or by
deriving a deterministic UUID from it.

## Required fields

Every workflow definition must include:

- `id`
- `title`
- `type`
- `prompt_md`

For `tabular` workflows, `columns_config` must be an array with at least one column.

Each tabular column must include:

- `name`
- `format`
- `prompt`

## Optional fields

The optional metadata fields are intended to support workflow organization and future workflow/prompt pack distribution:

- `practice`
- `jurisdiction`
- `language`
- `version`
- `is_system`

These fields are descriptive in this documentation-only proposal. They do not currently create runtime behavior by themselves.

## Assistant workflow example

```yaml
id: generate-document-summary
title: Generate document summary
type: assistant
practice: general
jurisdiction: generic
language: en
version: "0.1.0"
is_system: true
prompt_md: |
  Summarize the uploaded legal document using only the provided document.

  Cite relevant passages where possible. If a point is uncertain, incomplete,
  or not supported by the document, flag that uncertainty clearly.
columns_config: null
```

## Tabular review workflow example

```yaml
id: nda-review
title: NDA Review
type: tabular
practice: commercial
jurisdiction: generic
language: en
version: "0.1.0"
is_system: true
prompt_md: |
  Review the uploaded NDA using only the provided document. Extract the requested
  information into the configured columns. Flag missing, ambiguous, or high-risk
  provisions clearly.
columns_config:
  - name: Parties
    format: text
    prompt: Identify the parties to the NDA and their roles.
  - name: Confidentiality obligations
    format: text
    prompt: Summarize the main confidentiality obligations and any notable carve-outs.
  - name: Term and survival
    format: text
    prompt: Identify the agreement term and any survival period for confidentiality obligations.
  - name: Risk level
    format: select
    prompt: Assign a low, medium, or high risk level and briefly explain the reason.
```

## Suggested repository layout

Workflow files should live under `workflow-packs/`.

Example layout:

```txt
workflow-packs/
  examples/
    simple-assistant.workflow.yaml
    simple-tabular-review.workflow.yaml
  en/
    us/
      commercial/
        nda-review.workflow.yaml
  fr/
    fr/
      commercial/
        nda-review.workflow.yaml
schemas/
  workflow.schema.json
docs/
  workflows.md
```

Suggested workflow file naming convention:

```txt
<short-descriptive-id>.workflow.yaml
```

Use lowercase kebab-case ids and filenames. Keep the file name aligned with the workflow `id` when practical.

## Future import behavior

A future importer could:

- Validate workflow files against `schemas/workflow.schema.json`.
- Read workflow/prompt packs from `workflow-packs/`.
- Import or update workflows by stable pack `id`.
- Derive database UUIDs from pack ids when the database requires UUID primary keys.
- Preserve prompt Markdown and `columns_config` as reviewable file content.
- Use `jurisdiction`, `language`, `practice`, and `version` to select localized or jurisdiction-specific workflow packs.
- Distinguish built-in workflows from contributed workflows through `is_system` or future pack metadata.

Importer behavior should be explicit, reversible where possible, and safe to run repeatedly.

## Non-goals

This documentation-only proposal does not:

- Change runtime behavior.
- Add a workflow importer.
- Modify database migrations.
- Move existing built-in workflows.
- Refactor workflow execution.
- Add French legal workflow packs.
- Copy prompts from the online app or bundled frontend.
