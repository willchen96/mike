"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type MemoryAutosaveStatus = "idle" | "saving" | "saved";

type SavedMetadata = {
  submittedValue: string;
  isLatest: boolean;
};

type MemoryAutosaveOptions<Result> = {
  value: string;
  persistedValue: string;
  enabled: boolean;
  save: (value: string) => Promise<Result>;
  getPersistedValue: (result: Result) => string;
  onSaved: (result: Result, metadata: SavedMetadata) => void;
  onError: (cause: unknown) => void | Promise<void>;
  delay?: number;
  savedDuration?: number;
  flushOnUnmount?: boolean;
};

/**
 * Debounces and serializes versioned Markdown writes.
 *
 * Memory updates use compare-and-swap versions, so overlapping requests can
 * conflict with each other. The queue reads the latest draft only when its
 * turn starts, which coalesces rapid edits and lets each caller read the
 * version returned by the previous save.
 */
export function useMemoryAutosave<Result>({
  value,
  persistedValue,
  enabled,
  save,
  getPersistedValue,
  onSaved,
  onError,
  delay = 800,
  savedDuration = 2000,
  flushOnUnmount = enabled,
}: MemoryAutosaveOptions<Result>) {
  const [status, setStatus] = useState<MemoryAutosaveStatus>("idle");
  const [inFlight, setInFlight] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const valueRef = useRef(value);
  const persistedValueRef = useRef(persistedValue);
  const enabledRef = useRef(enabled);
  const flushOnUnmountRef = useRef(flushOnUnmount);
  const saveRef = useRef(save);
  const getPersistedValueRef = useRef(getPersistedValue);
  const onSavedRef = useRef(onSaved);
  const onErrorRef = useRef(onError);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const failedValueRef = useRef<string | null>(null);
  const activeSaveRef = useRef(false);
  const cancellationGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  valueRef.current = value;
  persistedValueRef.current = persistedValue;
  enabledRef.current = enabled;
  flushOnUnmountRef.current = flushOnUnmount;
  saveRef.current = save;
  getPersistedValueRef.current = getPersistedValue;
  onSavedRef.current = onSaved;
  onErrorRef.current = onError;

  const clearDebounce = useCallback(() => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const clearSavedTimer = useCallback(() => {
    if (!savedTimerRef.current) return;
    clearTimeout(savedTimerRef.current);
    savedTimerRef.current = null;
  }, []);

  const runLatestSave = useCallback((force = false): Promise<boolean> => {
    clearDebounce();
    const cancellationGeneration = cancellationGenerationRef.current;

    const operation = saveChainRef.current.then(async () => {
      if (cancellationGeneration !== cancellationGenerationRef.current) {
        if (mountedRef.current && !activeSaveRef.current) setStatus("idle");
        return false;
      }
      const submittedValue = valueRef.current;
      if (!force && !enabledRef.current) return false;
      if (submittedValue === persistedValueRef.current) return true;
      if (!force && failedValueRef.current === submittedValue) return false;

      activeSaveRef.current = true;
      if (mountedRef.current) {
        clearSavedTimer();
        setInFlight(true);
        setStatus("saving");
      }

      try {
        const result = await saveRef.current(submittedValue);
        const nextPersistedValue = getPersistedValueRef.current(result);
        const isLatest = valueRef.current === submittedValue;
        persistedValueRef.current = nextPersistedValue;
        failedValueRef.current = null;

        if (mountedRef.current) {
          onSavedRef.current(result, { submittedValue, isLatest });
          if (isLatest) {
            setStatus("saved");
            savedTimerRef.current = setTimeout(() => {
              if (mountedRef.current) setStatus("idle");
              savedTimerRef.current = null;
            }, savedDuration);
          } else {
            setStatus("saving");
          }
        }
        return true;
      } catch (cause) {
        failedValueRef.current = submittedValue;
        if (mountedRef.current) {
          setStatus("idle");
          try {
            await onErrorRef.current(cause);
          } catch {
            // Error presentation must not break the serialized save chain.
          }
        }
        return false;
      } finally {
        activeSaveRef.current = false;
        if (mountedRef.current) setInFlight(false);
      }
    });

    saveChainRef.current = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }, [clearDebounce, clearSavedTimer, savedDuration]);

  useEffect(() => {
    clearDebounce();
    if (failedValueRef.current !== null && value !== failedValueRef.current) {
      failedValueRef.current = null;
    }
    if (!enabled) {
      clearSavedTimer();
      if (!activeSaveRef.current) setStatus("idle");
      return;
    }
    if (value === persistedValue) {
      failedValueRef.current = null;
      if (!activeSaveRef.current && status === "saving") setStatus("idle");
      return;
    }
    if (failedValueRef.current === value) {
      if (!activeSaveRef.current && status === "saving") setStatus("idle");
      return;
    }

    clearSavedTimer();
    setStatus("saving");
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void runLatestSave();
    }, delay);

    return clearDebounce;
  }, [
    clearDebounce,
    clearSavedTimer,
    delay,
    enabled,
    persistedValue,
    retryVersion,
    runLatestSave,
    status,
    value,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      const shouldFlush =
        flushOnUnmountRef.current &&
        valueRef.current !== persistedValueRef.current;
      clearDebounce();
      clearSavedTimer();
      mountedRef.current = false;
      // Best effort for client-side navigation. The request is serialized
      // behind any active write but intentionally does not update unmounted UI.
      if (shouldFlush) void runLatestSave(true);
    };
  }, [clearDebounce, clearSavedTimer, runLatestSave]);

  const retry = useCallback(() => {
    failedValueRef.current = null;
    setRetryVersion((current) => current + 1);
  }, []);

  const cancelPending = useCallback(() => {
    cancellationGenerationRef.current += 1;
    clearDebounce();
    clearSavedTimer();
    if (!activeSaveRef.current) setStatus("idle");
  }, [clearDebounce, clearSavedTimer]);

  return {
    status,
    inFlight,
    flush: runLatestSave,
    retry,
    cancelPending,
  };
}
