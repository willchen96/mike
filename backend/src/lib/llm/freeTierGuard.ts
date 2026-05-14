/**
 * Hard safety check: prevent customer documents from ever being sent to
 * free-tier LLM providers, which may log or train on inputs.
 *
 * The guard runs at every LLM dispatch entry point.  When the configured
 * model is on the free-tier list:
 *   - ALLOW_FREE_TIER_LLM must be "true" (defaults to off, so prod fails closed),
 *   - FREE_TIER_FIXTURE_ALLOWLIST must list the public-domain fixture
 *     filenames that are permitted, and
 *   - every document filename the caller passes must appear in that list.
 *
 * In production this should be set to ALLOW_FREE_TIER_LLM=false (or unset)
 * so any free-tier model usage is rejected outright.
 */

// Models whose underlying API is on a free-tier (no commercial data-usage
// guarantees). Add new IDs here as new Gemini/etc free-tier models ship.
const FREE_TIER_MODELS = new Set<string>([
  // Real Google model IDs (Gemini free tier on https://ai.google.dev)
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
  // Internal placeholder IDs from src/lib/llm/models.ts that route to
  // Gemini's flash family. Keep in sync with that file.
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
]);

export function isFreeTierModel(model: string): boolean {
  return FREE_TIER_MODELS.has(model);
}

export interface FreeTierGuardInput {
  model: string;
  /** Optional list of document filenames being processed by this call. */
  documentFilenames?: string[];
}

export function assertFreeTierAllowed(input: FreeTierGuardInput): void {
  if (!isFreeTierModel(input.model)) return;

  if (process.env.ALLOW_FREE_TIER_LLM !== "true") {
    throw new Error(
      `Refusing free-tier model "${input.model}": ALLOW_FREE_TIER_LLM is not enabled. ` +
        "Free-tier LLM providers may log or train on inputs and must not see customer data.",
    );
  }

  const allowlist = new Set(
    (process.env.FREE_TIER_FIXTURE_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (allowlist.size === 0) {
    throw new Error(
      "ALLOW_FREE_TIER_LLM=true requires FREE_TIER_FIXTURE_ALLOWLIST to list the " +
        "fixture filenames (comma-separated) that may be processed by free-tier providers.",
    );
  }

  const offenders = (input.documentFilenames ?? []).filter((f) => !allowlist.has(f));
  if (offenders.length > 0) {
    throw new Error(
      `Refusing to send non-fixture document(s) [${offenders.join(", ")}] to free-tier ` +
        `model "${input.model}". Allowlist: ${[...allowlist].join(", ")}.`,
    );
  }
}
