"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Brain,
  Check,
  Download,
  History,
  Loader2,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useMemoryAutosave } from "@/app/components/memory/useMemoryAutosave";
import { Modal } from "@/app/components/modals/Modal";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { EmptyState } from "@/app/components/ui/empty-state";
import { GlassCard } from "@/app/components/ui/glass-card";
import { MarkdownEditor } from "@/app/components/ui/markdown-editor";
import { PillButton } from "@/app/components/ui/pill-button";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import {
  MikeApiError,
  downloadProjectMemoryMarkdown,
  getProjectMemory,
  listProjectMemoryVersions,
  restoreProjectMemoryVersion,
  setProjectMemoryEnabled,
  updateProjectMemory,
  wipeProjectMemory,
  type MemoryCurrent,
  type MemoryVersion,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

function formatDate(value: string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function versionSource(version: MemoryVersion) {
  if (version.source === "manual") return "Manual edit";
  if (version.source === "restore") return "Restored version";
  const surface =
    version.source_surface === "word"
      ? "Word"
      : version.source_surface === "tabular"
        ? "tabular review"
        : "chat";
  return `Automatic update after ${surface}`;
}

function currentStatus(memory: MemoryCurrent) {
  if (memory.status === "scheduled") return "Memory review scheduled";
  if (memory.status === "processing") return "Updating memory…";
  if (memory.status === "failed") {
    return "The latest automatic update failed. Existing memory is unchanged.";
  }
  if (!memory.updated_at) return "No saved memory yet";
  return `Last updated ${formatDate(memory.updated_at)}`;
}

function currentSource(source: MemoryCurrent["source"]) {
  if (source === "manual") return "Manual edit";
  if (source === "curator") return "Automatic update";
  if (source === "restore") return "Restored version";
  return null;
}

export function ProjectMemoryModal({
  open,
  onClose,
  projectId,
  projectName,
  projectLoading = false,
  canEdit,
  canManage,
  onMemoryEnabledChange,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string | null;
  projectLoading?: boolean;
  /** Caller holds `content.edit` on this project. */
  canEdit: boolean;
  /** Caller holds `access.manage` on this project. */
  canManage: boolean;
  /**
   * Report the file's enabled flag back to the workspace so the project row
   * and its details dialog agree with what this dialog just did.
   */
  onMemoryEnabledChange?: (enabled: boolean) => void;
}) {
  const [memory, setMemory] = useState<MemoryCurrent | null>(null);
  const [versions, setVersions] = useState<MemoryVersion[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [restoreCandidate, setRestoreCandidate] =
    useState<MemoryVersion | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [closing, setClosing] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [conflict, setConflict] = useState<MemoryCurrent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autosaveError, setAutosaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const memoryRef = useRef<MemoryCurrent | null>(null);
  const draftRef = useRef(draft);
  const historyRequestRef = useRef(0);
  memoryRef.current = memory;
  draftRef.current = draft;

  const syncCurrent = useCallback(
    (current: MemoryCurrent, syncDraft = true) => {
      memoryRef.current = current;
      setMemory(current);
      if (syncDraft) {
        draftRef.current = current.content;
        setDraft(current.content);
      }
      onMemoryEnabledChange?.(current.enabled);
    },
    [onMemoryEnabledChange],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(false);
      try {
        const current = await getProjectMemory(projectId, signal);
        if (signal?.aborted) return;
        syncCurrent(current);
        setConflict(null);
        setError(null);
        setAutosaveError(null);
      } catch {
        if (!signal?.aborted) {
          setLoadError(true);
          setLoading(false);
          setHistoryLoading(false);
        }
        return;
      } finally {
        if (!signal?.aborted) setLoading(false);
      }

      const historyRequest = ++historyRequestRef.current;
      setHistoryLoading(true);
      try {
        const history = await listProjectMemoryVersions(projectId, signal);
        if (signal?.aborted || historyRequest !== historyRequestRef.current) {
          return;
        }
        setVersions(history);
        setHistoryError(false);
      } catch {
        if (!signal?.aborted && historyRequest === historyRequestRef.current) {
          setHistoryError(true);
        }
      } finally {
        if (!signal?.aborted && historyRequest === historyRequestRef.current) {
          setHistoryLoading(false);
        }
      }
    },
    [projectId, syncCurrent],
  );

  const refreshVersions = useCallback(async () => {
    const historyRequest = ++historyRequestRef.current;
    try {
      const history = await listProjectMemoryVersions(projectId);
      if (historyRequest !== historyRequestRef.current) return;
      setVersions(history);
      setHistoryError(false);
    } catch {
      if (historyRequest === historyRequestRef.current) setHistoryError(true);
    } finally {
      if (historyRequest === historyRequestRef.current) {
        setHistoryLoading(false);
      }
    }
  }, [projectId]);

  // The file is fetched when the dialog opens, not when the project page
  // mounts: most visits to a project never ask for its memory. Closing drops
  // what was read so a later open shows its skeleton rather than a stale file.
  useEffect(() => {
    if (!open) {
      historyRequestRef.current += 1;
      setMemory(null);
      setVersions([]);
      draftRef.current = "";
      setDraft("");
      setLoading(true);
      setHistoryLoading(true);
      setConflict(null);
      setError(null);
      setAutosaveError(null);
      setSavedNotice(null);
      setClosing(false);
      setRestoreCandidate(null);
      setWipeConfirmOpen(false);
      setDiscardConfirmOpen(false);
      return;
    }
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, open]);

  const dirty = !!memory && draft !== memory.content;

  useEffect(() => {
    if (
      !open ||
      !memory?.enabled ||
      (memory.status !== "scheduled" && memory.status !== "processing") ||
      dirty ||
      conflict
    ) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void getProjectMemory(projectId, controller.signal)
        .then((current) => {
          if (controller.signal.aborted) return;
          const versionChanged = current.version !== memory.version;
          syncCurrent(current);
          if (versionChanged) void refreshVersions();
        })
        .catch(() => {
          // Keep the current file usable; the next poll or reopen can
          // recover a transient status-refresh failure.
        });
    }, 3000);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [conflict, dirty, memory, open, projectId, refreshVersions, syncCurrent]);

  async function resolveConflict(cause: unknown) {
    if (
      !(cause instanceof MikeApiError) ||
      cause.status !== 409 ||
      cause.code !== "memory_version_conflict"
    ) {
      return false;
    }
    try {
      const latest = await getProjectMemory(projectId);
      setConflict(latest);
      onMemoryEnabledChange?.(latest.enabled);
    } catch {
      setError(
        "Project memory changed while you were editing. Reopen memory before saving again.",
      );
    }
    return true;
  }

  const autosave = useMemoryAutosave({
    value: draft,
    persistedValue: memory?.content ?? "",
    enabled:
      open &&
      canEdit &&
      !!memory?.enabled &&
      !loading &&
      !loadError &&
      !enabling &&
      !restoring &&
      !wiping &&
      !wipeConfirmOpen &&
      !discardConfirmOpen &&
      !restoreCandidate &&
      !conflict,
    flushOnUnmount:
      open && canEdit && !!memory?.enabled && !restoring && !wiping,
    save: async (value) => {
      const current = memoryRef.current;
      if (!current) throw new Error("Project memory is unavailable");
      const saved = await updateProjectMemory(
        projectId,
        value,
        current.version,
      );
      memoryRef.current = saved;
      return saved;
    },
    getPersistedValue: (current) => current.content,
    onSaved: (current, { isLatest }) => {
      // Reconcile server-normalized Markdown only if no newer keystroke has
      // landed since this write began.
      syncCurrent(current, isLatest);
      setAutosaveError(null);
      void refreshVersions();
    },
    onError: async (cause) => {
      if (!(await resolveConflict(cause))) {
        setAutosaveError(
          userFacingApiError(
            cause,
            "Project memory could not be saved. Your draft has been kept.",
          ),
        );
      }
    },
  });

  async function restoreVersion() {
    if (
      !memory ||
      !restoreCandidate ||
      !canEdit ||
      restoring ||
      autosave.inFlight ||
      conflict ||
      wiping ||
      wipeConfirmOpen ||
      discardConfirmOpen ||
      closing
    ) {
      return;
    }
    setRestoring(true);
    setError(null);
    setAutosaveError(null);
    setSavedNotice(null);
    try {
      const current = await restoreProjectMemoryVersion(
        projectId,
        restoreCandidate.id,
        memory.version,
      );
      syncCurrent(current);
      setRestoreCandidate(null);
      setSavedNotice(`Version ${restoreCandidate.version} restored`);
      await refreshVersions();
    } catch (cause) {
      setRestoreCandidate(null);
      if (!(await resolveConflict(cause))) {
        setError(
          userFacingApiError(
            cause,
            "That project memory version could not be restored. Please try again.",
          ),
        );
      }
    } finally {
      setRestoring(false);
    }
  }

  async function enableMemory() {
    if (!canManage || enabling || closing) return;
    setEnabling(true);
    setError(null);
    setAutosaveError(null);
    try {
      const current = await setProjectMemoryEnabled(projectId, true);
      syncCurrent(current);
      setVersions([]);
      setSavedNotice("Project memory enabled");
    } catch (cause) {
      setError(
        userFacingApiError(
          cause,
          "Project memory could not be enabled. Please try again.",
        ),
      );
    } finally {
      setEnabling(false);
    }
  }

  async function wipeMemory() {
    if (
      !memory ||
      !canManage ||
      wiping ||
      restoring ||
      restoreCandidate ||
      autosave.inFlight ||
      discardConfirmOpen ||
      closing
    ) {
      return;
    }
    setWiping(true);
    setError(null);
    setAutosaveError(null);
    setSavedNotice(null);
    try {
      const current = await wipeProjectMemory(projectId);
      syncCurrent(current);
      historyRequestRef.current += 1;
      setVersions([]);
      setConflict(null);
      setWipeConfirmOpen(false);
      setSavedNotice("Project memory and version history deleted");
    } catch (cause) {
      setError(
        userFacingApiError(
          cause,
          "Project memory could not be deleted. Please try again.",
        ),
      );
    } finally {
      setWiping(false);
    }
  }

  async function downloadMemory() {
    if (!memory || memory.hash === null || downloading) return;
    setDownloading(true);
    setError(null);
    try {
      const { blob, filename } = await downloadProjectMemoryMarkdown(projectId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename ?? "memory.md";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(
        userFacingApiError(
          cause,
          "Project memory could not be downloaded. Please try again.",
        ),
      );
    } finally {
      setDownloading(false);
    }
  }

  function useLatestConflict() {
    if (!conflict) return;
    syncCurrent(conflict);
    setConflict(null);
    setError(null);
    setAutosaveError(null);
    autosave.cancelPending();
    void refreshVersions();
  }

  function keepDraftAfterConflict() {
    if (!conflict) return;
    syncCurrent(conflict, false);
    setConflict(null);
    setError(null);
    setAutosaveError(null);
    autosave.retry();
    void refreshVersions();
  }

  const modalInteractionLocked =
    autosave.inFlight ||
    enabling ||
    restoring ||
    wiping ||
    closing ||
    restoreCandidate !== null ||
    wipeConfirmOpen ||
    discardConfirmOpen;

  async function requestClose() {
    if (restoreCandidate && !restoring) {
      setRestoreCandidate(null);
      return;
    }
    if (wipeConfirmOpen && !wiping) {
      setWipeConfirmOpen(false);
      return;
    }
    if (discardConfirmOpen) {
      setDiscardConfirmOpen(false);
      return;
    }
    if (closing || restoring || wiping) return;
    const current = memoryRef.current;
    const hasDirtyDraft = !!current && draftRef.current !== current.content;
    const canSaveCurrent = canEdit && !!current?.enabled && !loadError;
    if (!hasDirtyDraft || !canSaveCurrent) {
      onClose();
      return;
    }

    if (autosaveError || conflict) {
      autosave.cancelPending();
      setDiscardConfirmOpen(true);
      return;
    }

    setClosing(true);
    const saved = await autosave.flush();
    if (saved) onClose();
    else {
      setClosing(false);
      autosave.cancelPending();
      setDiscardConfirmOpen(true);
    }
  }

  return (
    <Modal
      open={open}
      onClose={requestClose}
      breadcrumbs={["Projects", projectName ?? "Project", "Memory"]}
      headerAction={
        memory?.enabled ? (
          <div className="flex items-center gap-2">
            <TabPillButton
              onClick={() => void downloadMemory()}
              disabled={
                memory.hash === null || downloading || modalInteractionLocked
              }
              aria-label="Download project memory.md"
              title="Download project memory.md"
            >
              {downloading ? (
                <Loader2
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin"
                />
              ) : (
                <Download aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">
                {downloading ? "Downloading…" : "Download"}
              </span>
            </TabPillButton>
            {canManage && (memory.hash !== null || memory.status !== "idle") ? (
              <TabPillButton
                className="text-red-600 hover:text-red-700"
                onClick={() => {
                  autosave.cancelPending();
                  setWipeConfirmOpen(true);
                }}
                disabled={modalInteractionLocked}
                aria-label="Delete project memory"
                title="Delete project memory"
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Delete</span>
              </TabPillButton>
            ) : null}
          </div>
        ) : undefined
      }
      footerStatus={
        error ? (
          <span className="text-sm text-red-600" role="alert">
            {error}
          </span>
        ) : autosaveError ? (
          <span className="inline-flex items-center gap-2 text-sm">
            <span className="text-red-600" role="alert">
              {autosaveError}
            </span>
            <button
              type="button"
              className="font-medium text-gray-700 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
              onClick={() => {
                setAutosaveError(null);
                autosave.retry();
              }}
            >
              Retry
            </button>
          </span>
        ) : autosave.status !== "idle" ? (
          <span
            className="inline-flex items-center gap-1.5 text-sm text-gray-500"
            role="status"
            aria-live="polite"
          >
            {autosave.status === "saved" ? (
              <Check
                aria-hidden="true"
                className="h-3.5 w-3.5 text-green-600"
              />
            ) : null}
            {autosave.status === "saving" ? "Saving…" : "Saved"}
          </span>
        ) : savedNotice ? (
          <span className="text-sm text-gray-400" role="status">
            {savedNotice}
          </span>
        ) : null
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-3 pt-1">
        {loading || projectLoading ? (
          <ProjectMemorySkeleton />
        ) : loadError || !memory ? (
          <GlassCard>
            <EmptyState
              icon={<Brain />}
              title="Project memory could not be loaded"
              description="Try again to inspect this project's shared memory."
              tone="error"
              className="px-5 py-8"
              action={
                <PillButton tone="black" size="sm" onClick={() => void load()}>
                  Retry
                </PillButton>
              }
            />
          </GlassCard>
        ) : !memory.enabled ? (
          <GlassCard>
            <EmptyState
              icon={<Brain />}
              title="Project memory is off"
              description={
                canManage
                  ? "Enable it to start a new shared project memory.md for future conversations."
                  : "A project owner can enable memory for future project conversations."
              }
              className="px-5 py-8"
              action={
                canManage ? (
                  <PillButton
                    tone="black"
                    size="sm"
                    onClick={() => void enableMemory()}
                    disabled={enabling}
                    aria-busy={enabling}
                  >
                    {enabling ? "Enabling…" : "Enable"}
                  </PillButton>
                ) : undefined
              }
            />
          </GlassCard>
        ) : (
          <>
            <div className="space-y-1">
              <p className="text-sm text-gray-500">
                Mike may curate this private Markdown file after saved project
                conversations. It can influence future answers for anyone with
                access to this project.
              </p>
              <p
                className={
                  memory.status === "failed"
                    ? "text-xs text-red-600"
                    : "text-xs text-gray-400"
                }
                role={memory.status === "failed" ? "alert" : "status"}
              >
                {currentStatus(memory)}
                {memory.hash !== null ? ` · Version ${memory.version}` : ""}
                {memory.hash !== null && currentSource(memory.source)
                  ? ` · ${currentSource(memory.source)}`
                  : ""}
              </p>
            </div>

            {conflict ? (
              <div
                className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900"
                role="alert"
              >
                <p className="font-medium">
                  Project memory changed while you were editing
                </p>
                <p className="mt-1 text-xs text-amber-800">
                  Reload the latest version or keep your draft and let it save
                  against the new version.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <PillButton
                    tone="white"
                    size="sm"
                    onClick={useLatestConflict}
                  >
                    Reload latest
                  </PillButton>
                  <PillButton
                    tone="black"
                    size="sm"
                    onClick={keepDraftAfterConflict}
                  >
                    Keep my draft
                  </PillButton>
                </div>
              </div>
            ) : null}

            <div className="min-h-[18rem]">
              <MarkdownEditor
                value={draft}
                onChange={
                  canEdit
                    ? (value) => {
                        draftRef.current = value;
                        setDraft(value);
                        setAutosaveError(null);
                        setError(null);
                        setSavedNotice(null);
                      }
                    : undefined
                }
                readOnly={
                  !canEdit ||
                  enabling ||
                  restoring ||
                  wiping ||
                  closing ||
                  restoreCandidate !== null ||
                  wipeConfirmOpen ||
                  discardConfirmOpen
                }
                ariaLabel="Project memory"
                className="memory-editor-surface min-h-[18rem]"
                allowTables={false}
              />
            </div>

            <ProjectMemoryVersionHistory
              versions={versions}
              currentVersion={memory.version}
              canRestore={canEdit}
              loading={historyLoading}
              disabled={modalInteractionLocked || conflict !== null}
              error={historyError}
              onRetry={() => void refreshVersions()}
              onRestore={(version) => {
                autosave.cancelPending();
                setRestoreCandidate(version);
              }}
            />
          </>
        )}
      </div>

      <ConfirmPopup
        open={restoreCandidate !== null}
        title={
          restoreCandidate
            ? `Restore version ${restoreCandidate.version}?`
            : undefined
        }
        message={
          dirty
            ? "Restoring creates a new current version and discards your unsaved draft. Existing version history is retained."
            : "Restoring creates a new current version. Existing version history is retained."
        }
        confirmLabel="Restore"
        confirmStatus={restoring ? "loading" : "idle"}
        onConfirm={() => void restoreVersion()}
        onCancel={() => {
          if (!restoring) setRestoreCandidate(null);
        }}
      />

      <ConfirmPopup
        open={wipeConfirmOpen}
        title="Delete project memory?"
        message={`This permanently deletes memory.md and its complete version history${dirty ? ", including your unsaved edits" : ""}. Project memory stays on and can learn again from future conversations. This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        confirmStatus={wiping ? "loading" : "idle"}
        onConfirm={() => void wipeMemory()}
        onCancel={() => {
          if (!wiping) setWipeConfirmOpen(false);
        }}
      />

      <ConfirmPopup
        open={discardConfirmOpen}
        title="Close without saving?"
        message="The latest changes could not be saved to this project's memory.md. Closing now discards them."
        confirmLabel="Close without saving"
        confirmVariant="danger"
        onConfirm={() => {
          autosave.cancelPending();
          setDiscardConfirmOpen(false);
          onClose();
        }}
        onCancel={() => setDiscardConfirmOpen(false)}
      />
    </Modal>
  );
}

function ProjectMemoryVersionHistory({
  versions,
  currentVersion,
  canRestore,
  loading,
  disabled,
  error,
  onRetry,
  onRestore,
}: {
  versions: MemoryVersion[];
  currentVersion: number;
  canRestore: boolean;
  loading: boolean;
  disabled: boolean;
  error: boolean;
  onRetry: () => void;
  onRestore: (version: MemoryVersion) => void;
}) {
  return (
    <section className="space-y-2" aria-labelledby="project-memory-history">
      <div className="flex items-center gap-2">
        <History aria-hidden="true" className="h-4 w-4 text-gray-500" />
        <h2
          id="project-memory-history"
          className="font-serif text-lg font-medium text-gray-900"
        >
          Version history
        </h2>
      </div>
      <GlassCard>
        {loading ? (
          <div
            className="space-y-3 px-4 py-5"
            aria-label="Loading project memory version history"
          >
            <div className="h-4 w-36 animate-pulse rounded bg-gray-200" />
            <div className="h-3 w-64 max-w-full animate-pulse rounded bg-gray-100" />
          </div>
        ) : error ? (
          <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-red-600" role="alert">
              Version history could not be refreshed.
            </p>
            <PillButton tone="white" size="sm" onClick={onRetry}>
              Retry
            </PillButton>
          </div>
        ) : versions.length === 0 ? (
          <p className="px-4 py-5 text-sm text-gray-500">
            Saved versions will appear here.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {versions.map((version) => {
              const isCurrent = version.version === currentVersion;
              return (
                <li
                  key={version.id}
                  className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-700">
                      Version {version.version}
                      {isCurrent ? " · Current" : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {versionSource(version)} ·{" "}
                      {formatDate(version.created_at)} ·{" "}
                      {formatBytes(version.size_bytes)}
                    </p>
                    {version.change_summary ? (
                      <p className="mt-1 text-xs text-gray-600">
                        {version.change_summary}
                      </p>
                    ) : null}
                  </div>
                  {!isCurrent && canRestore ? (
                    <PillButton
                      tone="white"
                      size="sm"
                      disabled={disabled}
                      onClick={() => onRestore(version)}
                    >
                      <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                      Restore
                    </PillButton>
                  ) : (
                    <span className="text-xs text-gray-400">
                      {isCurrent ? "Current version" : ""}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </GlassCard>
    </section>
  );
}

function ProjectMemorySkeleton() {
  return (
    <div className="space-y-4" aria-label="Loading project memory">
      <div className="space-y-2">
        <div className="h-3 w-full max-w-xl animate-pulse rounded bg-gray-100" />
        <div className="h-3 w-40 animate-pulse rounded bg-gray-100" />
      </div>
      <div className="h-80 animate-pulse rounded-2xl bg-app-surface" />
    </div>
  );
}
