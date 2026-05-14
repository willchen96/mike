import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Tables in safe truncation order (FK dependents first).
// Update this list when new tables are added to the schema.
const APP_TABLES = [
  "chat_messages",
  "chats",
  "document_versions",
  "documents",
  "project_members",
  "projects",
  "tabular_reviews",
  "workflows",
  "user_api_keys",
  "user_settings",
  "download_tokens",
] as const;

type AppTable = (typeof APP_TABLES)[number];

let _client: SupabaseClient | null = null;

export function getTestDb(): SupabaseClient {
  if (!_client) {
    const url = process.env.TEST_SUPABASE_URL;
    const key = process.env.TEST_SUPABASE_SECRET_KEY;
    if (!url || !key) {
      throw new Error(
        "TEST_SUPABASE_URL and TEST_SUPABASE_SECRET_KEY must be set in .env.test"
      );
    }
    _client = createClient(url, key, { auth: { persistSession: false } });
  }
  return _client;
}

export async function truncateTable(table: AppTable): Promise<void> {
  const db = getTestDb();
  const { error } = await db.from(table).delete().not("id", "is", null);
  if (error) {
    // Warn rather than throw — table may not exist in test schema yet
    console.warn(`[testDb] could not truncate "${table}":`, error.message);
  }
}

export async function truncateAllTables(): Promise<void> {
  for (const table of APP_TABLES) {
    await truncateTable(table);
  }
}

/**
 * Call inside a describe block to wipe all app tables before each test and
 * once more after the suite finishes.
 */
export function useCleanDb(): void {
  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await truncateAllTables();
  });
}
