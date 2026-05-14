/**
 * Baseline migration marker.
 *
 * The schema has already been applied via backend/migrations/000_one_shot_schema.sql.
 * This file's only purpose is to give node-pg-migrate a tracked starting point;
 * up/down are intentionally no-ops. Future schema changes ship as new
 * timestamped migration files in this directory.
 */
import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

export const up = (_pgm: MigrationBuilder): void => {
    // No-op: baseline tracks the post-one-shot schema state.
};

export const down = (_pgm: MigrationBuilder): void => {
    // No-op: baseline cannot be rolled back.
};
