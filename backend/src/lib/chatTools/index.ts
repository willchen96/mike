/**
 * Public façade for the chatTools module (Phase 8 / CLEAN-30 split).
 *
 * Single entry point routes import from. Node resolves
 * `import "../lib/chatTools"` to this file now that chatTools.ts is deleted.
 *
 * Locale routing for the system prompt will land here in M2 BILING-03.
 */

// NOTE: `buildSystemPrompt` and `buildDocsSection` are exported here as the
// canonical builders for the system prompt and AVAILABLE DOCUMENTS block,
// but the live hot path currently constructs the system message inline in
// `buildMessages` (doc-context.ts) to preserve byte-identical SSE behavior
// across the Phase 8 split. M2 BILING-03 will route the live path through
// `buildSystemPrompt` so locale switching has a single seam. Until then
// these exports are forward-facing API only and are not invoked at runtime.
// Do not assume that editing these is sufficient to change runtime output.
export {
    SYSTEM_PROMPT,
    IDENTITY,
    OUTPUT_FORMAT,
    TOOL_POLICY,
    BEHAVIOR,
    buildDocsSection,
    buildSystemPrompt,
} from "./system-prompts/en";

export {
    TOOLS,
    PROJECT_EXTRA_TOOLS,
    TABULAR_TOOLS,
    WORKFLOW_TOOLS,
} from "./tool-schemas";

export { runLLMStream } from "./stream";
export type { AssistantEvent } from "./stream";

export { runToolCalls } from "./tool-runner";

export {
    buildDocContext,
    buildProjectDocContext,
    buildMessages,
    enrichWithPriorEvents,
    resolveDoc,
    resolveDocLabel,
} from "./doc-context";

export { buildWorkflowStore } from "./workflow-store";

export { parseCitations, extractAnnotations, CITATIONS_OPEN_TAG } from "./citations";

export type {
    DocStore,
    WorkflowStore,
    DocIndex,
    TabularCellStore,
    ToolCall,
    ChatMessage,
    EditAnnotation,
    TurnEditState,
    DocEditedResult,
    DocCreatedResult,
    DocReplicatedResult,
} from "./types";
