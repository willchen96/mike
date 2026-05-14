import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.sql(`
        -- CLEAN-28: server-side aggregation for tabular review document counts.
        -- EXPLAIN confirms idx_tabular_cells_review (review_id, document_id, column_index)
        -- covers the (review_id, document_id) prefix — no new index needed.
        CREATE OR REPLACE FUNCTION public.select_review_doc_counts(review_ids uuid[])
        RETURNS TABLE (review_id uuid, doc_count bigint)
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = ''
        AS $$
            SELECT review_id, count(DISTINCT document_id) AS doc_count
            FROM public.tabular_cells
            WHERE review_id = ANY(review_ids)
            GROUP BY review_id;
        $$;

        REVOKE ALL ON FUNCTION public.select_review_doc_counts(uuid[]) FROM public, anon, authenticated;
        GRANT EXECUTE ON FUNCTION public.select_review_doc_counts(uuid[]) TO service_role;
    `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.sql(`
        DROP FUNCTION IF EXISTS public.select_review_doc_counts(uuid[]);
    `);
}
