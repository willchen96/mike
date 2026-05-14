import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns("documents", {
    pdf_conversion_status: {
      type: "text",
      notNull: true,
      default: "ok",
      check: "pdf_conversion_status IN ('pending', 'ok', 'failed')",
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns("documents", ["pdf_conversion_status"]);
}
