import { describe, it, expect } from "vitest";
import { explainPlan, planContainsNodeType, planUsesIndex } from "./helpers/explain";

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

/** Pull the top-level Total Cost out of a plan node (best-effort; soft tripwire). */
function planTotalCost(plan: unknown): number | null {
  if (!plan || typeof plan !== "object") return null;
  const obj = plan as Record<string, unknown>;
  const root = obj["Plan"] ?? obj;
  if (root && typeof root === "object") {
    const cost = (root as Record<string, unknown>)["Total Cost"];
    if (typeof cost === "number") return cost;
  }
  return null;
}

(hasDatabaseUrl ? describe : describe.skip)(
  "RLS — GIN index pushdown smoke (SC3)",
  () => {
    it("anon-key SELECT against projects.shared_with uses a GIN index, not Seq Scan", async () => {
      const plan = await explainPlan(`
        SELECT id FROM public.projects
        WHERE shared_with @> jsonb_build_array('test-recipient@test.invalid')
      `);
      expect(planContainsNodeType(plan[0], "Seq Scan")).toBe(false);
      // Either jsonb_ops or jsonb_path_ops index is acceptable — planner picks.
      const usesEither =
        planUsesIndex(plan[0], "projects_shared_with_idx") ||
        planUsesIndex(plan[0], "projects_shared_with_pathops_idx");
      expect(usesEither).toBe(true);

      // Soft perf tripwire (RESEARCH §10 Q4 RESOLVED): warn only, no expect.
      const cost = planTotalCost(plan[0]);
      if (cost !== null && cost > 100) {
        // eslint-disable-next-line no-console
        console.warn(`[explain.test] projects.shared_with @> total cost ${cost} > 100 — investigate (deferred to Phase 13).`);
      }
    });

    it("tabular_reviews.shared_with @> uses a GIN index", async () => {
      const plan = await explainPlan(`
        SELECT id FROM public.tabular_reviews
        WHERE shared_with @> jsonb_build_array('test-recipient@test.invalid')
      `);
      expect(planContainsNodeType(plan[0], "Seq Scan")).toBe(false);
      const usesEither =
        planUsesIndex(plan[0], "tabular_reviews_shared_with_idx") ||
        planUsesIndex(plan[0], "tabular_reviews_shared_with_pathops_idx");
      expect(usesEither).toBe(true);

      const cost = planTotalCost(plan[0]);
      if (cost !== null && cost > 100) {
        // eslint-disable-next-line no-console
        console.warn(`[explain.test] tabular_reviews.shared_with @> total cost ${cost} > 100 — investigate (deferred to Phase 13).`);
      }
    });
  },
);
