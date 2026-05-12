import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { DEFAULT_TABULAR_MODEL, resolveModel } from "../lib/llm";
import {
  type ApiKeyStatus,
  getUserApiKeyStatus,
  hasEnvApiKey,
  normalizeApiKeyProvider,
  saveUserApiKey,
} from "../lib/userApiKeys";

export const userRouter = Router();

const MONTHLY_CREDIT_LIMIT = 999999;

const DEFAULT_TABULAR_MAX_PAGES = 250;

type UserProfileRow = {
  display_name: string | null;
  organisation: string | null;
  message_credits_used: number;
  credits_reset_date: string;
  tier: string;
  tabular_model: string;
  tabular_max_pages: number;
};

type OAuthProfileMetadata = {
  displayName?: string | null;
  organisation?: string | null;
};

function serializeProfile(
  row: UserProfileRow,
  apiKeyStatus?: ApiKeyStatus,
) {
  const creditsUsed = row.message_credits_used ?? 0;
  return {
    displayName: row.display_name,
    organisation: row.organisation,
    messageCreditsUsed: creditsUsed,
    creditsResetDate: row.credits_reset_date,
    creditsRemaining: Math.max(MONTHLY_CREDIT_LIMIT - creditsUsed, 0),
    tier: row.tier || "Free",
    tabularModel: resolveModel(row.tabular_model, DEFAULT_TABULAR_MODEL),
    tabularMaxPages: row.tabular_max_pages ?? DEFAULT_TABULAR_MAX_PAGES,
    ...(apiKeyStatus ? { apiKeyStatus } : {}),
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function profileMetadataFromOAuth(
  metadata: unknown,
  email: string,
): OAuthProfileMetadata {
  const raw =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const displayName = firstString(
    raw.full_name,
    raw.name,
    raw.display_name,
    raw.user_name,
  );
  const organisation = firstString(
    raw.organization,
    raw.organisation,
    raw.company,
    email.endsWith("@kairosvista.com") ? "KairosVista" : null,
  );
  return { displayName, organisation };
}

function validateProfilePayload(body: unknown):
  | {
      ok: true;
      update: {
        display_name?: string | null;
        organisation?: string | null;
        tabular_model?: string;
        updated_at: string;
      };
    }
  | { ok: false; detail: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, detail: "Expected a JSON object" };
  }

  const raw = body as Record<string, unknown>;
  const allowedFields = new Set([
    "displayName",
    "organisation",
    "tabularModel",
    "tabularMaxPages",
  ]);
  const invalidField = Object.keys(raw).find((key) => !allowedFields.has(key));
  if (invalidField) {
    return { ok: false, detail: `Unsupported profile field: ${invalidField}` };
  }

  const update: {
    display_name?: string | null;
    organisation?: string | null;
    tabular_model?: string;
    tabular_max_pages?: number;
    updated_at: string;
  } = { updated_at: new Date().toISOString() };

  if ("displayName" in raw) {
    if (raw.displayName !== null && typeof raw.displayName !== "string") {
      return { ok: false, detail: "displayName must be a string or null" };
    }
    update.display_name = raw.displayName?.trim() || null;
  }

  if ("organisation" in raw) {
    if (raw.organisation !== null && typeof raw.organisation !== "string") {
      return { ok: false, detail: "organisation must be a string or null" };
    }
    update.organisation = raw.organisation?.trim() || null;
  }

  if ("tabularModel" in raw) {
    if (typeof raw.tabularModel !== "string") {
      return { ok: false, detail: "tabularModel must be a string" };
    }
    const resolved = resolveModel(raw.tabularModel, "");
    if (!resolved) {
      return { ok: false, detail: "Unsupported tabularModel" };
    }
    update.tabular_model = resolved;
  }

  if ("tabularMaxPages" in raw) {
    const v = Number(raw.tabularMaxPages);
    if (!Number.isInteger(v) || v < 10 || v > 2000) {
      return { ok: false, detail: "tabularMaxPages must be an integer between 10 and 2000" };
    }
    update.tabular_max_pages = v;
  }

  return { ok: true, update };
}

async function ensureProfileRow(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
  defaults: OAuthProfileMetadata = {},
) {
  const { error } = await db
    .from("user_profiles")
    .upsert(
      {
        user_id: userId,
        ...(defaults.displayName && { display_name: defaults.displayName }),
        ...(defaults.organisation && { organisation: defaults.organisation }),
      },
      { onConflict: "user_id", ignoreDuplicates: true },
    );
  return error;
}

async function backfillBlankProfileFields(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
  row: UserProfileRow,
  defaults: OAuthProfileMetadata,
): Promise<{ data: UserProfileRow; error: Error | null }> {
  const update: {
    display_name?: string;
    organisation?: string;
    updated_at: string;
  } = { updated_at: new Date().toISOString() };

  if (!row.display_name && defaults.displayName) {
    update.display_name = defaults.displayName;
  }
  if (!row.organisation && defaults.organisation) {
    update.organisation = defaults.organisation;
  }
  if (!update.display_name && !update.organisation) {
    return { data: row, error: null };
  }

  const { data, error } = await db
    .from("user_profiles")
    .update(update)
    .eq("user_id", userId)
    .select(
      "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model, tabular_max_pages",
    )
    .single();
  if (error) return { data: row, error };
  return { data: data as UserProfileRow, error: null };
}

async function loadProfile(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
  options: {
    repairMissing?: boolean;
    defaults?: OAuthProfileMetadata;
  } = {},
) {
  let { data, error } = await db
    .from("user_profiles")
    .select(
      "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model, tabular_max_pages",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return { data: null, error };
  if (!data) {
    if (!options.repairMissing) {
      return { data: null, error: new Error("Profile not found") };
    }

    const ensureError = await ensureProfileRow(db, userId, options.defaults);
    if (ensureError) return { data: null, error: ensureError };

    const created = await db
      .from("user_profiles")
      .select(
        "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model, tabular_max_pages",
      )
      .eq("user_id", userId)
      .single();
    if (created.error) return { data: null, error: created.error };
    data = created.data;
  }

  let row = data as UserProfileRow;
  const backfilled = await backfillBlankProfileFields(
    db,
    userId,
    row,
    options.defaults ?? {},
  );
  if (backfilled.error) return { data: null, error: backfilled.error };
  row = backfilled.data;

  if (row.credits_reset_date && new Date() > new Date(row.credits_reset_date)) {
    const creditsResetDate = new Date();
    creditsResetDate.setDate(creditsResetDate.getDate() + 30);
    const { data: resetData, error: resetError } = await db
      .from("user_profiles")
      .update({
        message_credits_used: 0,
        credits_reset_date: creditsResetDate.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .select(
        "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model, tabular_max_pages",
      )
      .single();

    if (resetError) return { data: null, error: resetError };
    row = resetData as UserProfileRow;
  }

  return { data: serializeProfile(row), error: null };
}

// POST /user/profile
userRouter.post("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const defaults = profileMetadataFromOAuth(
    res.locals.userMetadata,
    userEmail,
  );
  const db = createServerSupabase();
  const error = await ensureProfileRow(db, userId, defaults);
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ ok: true });
});

// GET /user/profile
userRouter.get("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const defaults = profileMetadataFromOAuth(
    res.locals.userMetadata,
    userEmail,
  );
  const db = createServerSupabase();
  const { data, error } = await loadProfile(db, userId, {
    repairMissing: true,
    defaults,
  });
  if (error) return void res.status(500).json({ detail: error.message });
  const apiKeyStatus = await getUserApiKeyStatus(userId, db);
  res.json({ ...data, apiKeyStatus });
});

// PATCH /user/profile
userRouter.patch("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const parsed = validateProfilePayload(req.body);
  if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

  const db = createServerSupabase();
  const ensureError = await ensureProfileRow(db, userId);
  if (ensureError)
    return void res.status(500).json({ detail: ensureError.message });

  const { error: updateError } = await db
    .from("user_profiles")
    .update(parsed.update)
    .eq("user_id", userId);
  if (updateError)
    return void res.status(500).json({ detail: updateError.message });

  const { data, error } = await loadProfile(db, userId);
  if (error) return void res.status(500).json({ detail: error.message });
  const apiKeyStatus = await getUserApiKeyStatus(userId, db);
  res.json({ ...data, apiKeyStatus });
});

// GET /user/api-keys
userRouter.get("/api-keys", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const status = await getUserApiKeyStatus(userId, db);
  res.json(status);
});

// PUT /user/api-keys/:provider
userRouter.put("/api-keys/:provider", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const provider = normalizeApiKeyProvider(req.params.provider);
  if (!provider)
    return void res.status(400).json({ detail: "Unsupported provider" });

  const apiKey =
    typeof req.body?.api_key === "string" ? req.body.api_key : null;
  const db = createServerSupabase();
  try {
    if (hasEnvApiKey(provider)) {
      return void res.status(409).json({
        detail:
          "This provider is configured by the server environment and cannot be changed from the browser.",
      });
    }
    await saveUserApiKey(userId, provider, apiKey, db);
    const status = await getUserApiKeyStatus(userId, db);
    res.json(status);
  } catch (err) {
    console.error("[user/api-keys] save failed", {
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ detail: "Failed to save API key" });
  }
});

// DELETE /user/account
userRouter.delete("/account", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});
