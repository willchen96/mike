/**
 * Shared zod schemas for LLM-output validation.
 *
 * These schemas validate JSON produced BY the LLM (tool call arguments,
 * citation blocks, tabular cell results). They are intentionally separate
 * from HTTP request body schemas (backend/src/lib/validate.ts).
 *
 * Used by parseLlmJson in citations.ts, tool-runner.ts, and tabular.ts.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Chat citations (<CITATIONS> block in assistant replies)
// ---------------------------------------------------------------------------

export const CitationSchema = z.object({
    ref: z.number().int(),
    doc_id: z.string().min(1),
    page: z.union([
        z.number().int(),
        z.string().regex(/^\d+\s*-\s*\d+$/),
    ]),
    quote: z.string().min(1),
});

export const CitationsArraySchema = z.array(CitationSchema);

// ---------------------------------------------------------------------------
// Tabular citations (<CITATIONS> block in tabular chat replies)
// ---------------------------------------------------------------------------

export const TabularCitationSchema = z.object({
    ref: z.number().int(),
    col_index: z.number().int().nonnegative(),
    row_index: z.number().int().nonnegative(),
    quote: z.string().min(1),
});

export const TabularCitationsArraySchema = z.array(TabularCitationSchema);

// ---------------------------------------------------------------------------
// Tabular cell results (per-cell and per-column LLM output)
// ---------------------------------------------------------------------------

export const TabularCellSchema = z
    .object({
        summary: z.string().optional(),
        value: z.string().optional(),
        flag: z.enum(["green", "grey", "yellow", "red"]).optional(),
        reasoning: z.string().optional(),
    })
    .refine(
        (d) => d.summary !== undefined || d.value !== undefined,
        { message: "Cell must have summary or value" },
    );

// TabularCellLineSchema: per-line output from queryGeminiAllColumns.
// Uses .and() because .refine() returns ZodEffects which has no .extend().
export const TabularCellLineSchema = TabularCellSchema.and(
    z.object({
        column_index: z.number().int().nonnegative(),
    }),
);

// ---------------------------------------------------------------------------
// Tool argument schemas (keyed by tool name)
// ---------------------------------------------------------------------------

export const ToolArgSchemas = {
    read_document: z.object({
        doc_id: z.string(),
    }),
    find_in_document: z.object({
        doc_id: z.string(),
        query: z.string(),
        max_results: z.number().int().optional(),
        context_chars: z.number().int().optional(),
    }),
    fetch_documents: z.object({
        doc_ids: z.array(z.string()),
    }),
    list_documents: z.object({}),
    list_workflows: z.object({}),
    read_workflow: z.object({
        workflow_id: z.string(),
    }),
    read_table_cells: z.object({
        col_indices: z.array(z.number().int()).optional(),
        row_indices: z.array(z.number().int()).optional(),
    }),
    replicate_document: z.object({
        doc_id: z.string(),
        count: z.number().int().min(1).max(20).optional(),
        new_filename: z.string().optional(),
    }),
    generate_docx: z.object({
        title: z.string(),
        landscape: z.boolean().optional(),
        sections: z.unknown(),
    }),
    edit_document: z.object({
        doc_id: z.string(),
        edits: z.array(
            z.object({
                find: z.string(),
                replace: z.string(),
                context_before: z.string(),
                context_after: z.string(),
                reason: z.string().optional(),
            }),
        ),
    }),
} as const;
