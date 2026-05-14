import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import {
    CLAUDE_MAIN_MODELS,
    GEMINI_MAIN_MODELS,
    CLAUDE_MID_MODELS,
    GEMINI_MID_MODELS,
    CLAUDE_LOW_MODELS,
    GEMINI_LOW_MODELS,
    DEFAULT_MAIN_MODEL,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    providerForModel,
} from "../lib/llm/models";

export const modelsRouter = Router();

function toEntry(id: string, group: string) {
    return { id, provider: providerForModel(id), label: id, group };
}

// CLEAN-50: single source of truth — return full model catalog grouped by tier.
// Auth-gated: model IDs are internal implementation details.
modelsRouter.get("/", requireAuth, (_req, res) => {
    res.json({
        main: [
            ...CLAUDE_MAIN_MODELS.map((id) => toEntry(id, "Anthropic")),
            ...GEMINI_MAIN_MODELS.map((id) => toEntry(id, "Google")),
        ],
        mid: [
            ...CLAUDE_MID_MODELS.map((id) => toEntry(id, "Anthropic")),
            ...GEMINI_MID_MODELS.map((id) => toEntry(id, "Google")),
        ],
        low: [
            ...CLAUDE_LOW_MODELS.map((id) => toEntry(id, "Anthropic")),
            ...GEMINI_LOW_MODELS.map((id) => toEntry(id, "Google")),
        ],
        defaults: {
            main: DEFAULT_MAIN_MODEL,
            title: DEFAULT_TITLE_MODEL,
            tabular: DEFAULT_TABULAR_MODEL,
        },
    });
});
