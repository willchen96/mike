import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMemoryAutosave } from "./useMemoryAutosave";

type Saved = { content: string };

function options(value: string, save: (value: string) => Promise<Saved>) {
  return {
    value,
    persistedValue: "saved",
    enabled: true,
    save,
    getPersistedValue: (result: Saved) => result.content,
    onSaved: vi.fn(),
    onError: vi.fn(),
  };
}

describe("useMemoryAutosave", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels the debounce and clears Saving when an edit is reverted", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (content: string) => ({ content }));
    const { result, rerender } = renderHook(
      ({ value }) => useMemoryAutosave(options(value, save)),
      { initialProps: { value: "saved" } },
    );

    rerender({ value: "draft" });
    expect(result.current.status).toBe("saving");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(799);
    });
    expect(save).not.toHaveBeenCalled();

    rerender({ value: "saved" });
    expect(result.current.status).toBe("idle");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("allows a failed value to be retried after the draft changes", async () => {
    vi.useFakeTimers();
    const save = vi
      .fn<(value: string) => Promise<Saved>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async (content) => ({ content }));
    const { rerender } = renderHook(
      ({ value }) => useMemoryAutosave(options(value, save)),
      { initialProps: { value: "saved" } },
    );

    rerender({ value: "retry me" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(save).toHaveBeenCalledTimes(1);

    rerender({ value: "different" });
    rerender({ value: "retry me" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("retry me");
  });

  it("cancels a debounced write that is already queued", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (value: Saved) => void;
    const save = vi
      .fn<(value: string) => Promise<Saved>>()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockImplementation(async (content) => ({ content }));
    const { result, rerender } = renderHook(
      ({ value }) => useMemoryAutosave(options(value, save)),
      { initialProps: { value: "saved" } },
    );

    rerender({ value: "first" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(save).toHaveBeenCalledTimes(1);

    rerender({ value: "must not save" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    act(() => result.current.cancelPending());
    await act(async () => {
      resolveFirst({ content: "first" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flushes a paused draft on unmount when the caller opts in", async () => {
    const save = vi.fn(async (content: string) => ({ content }));
    const { unmount } = renderHook(() =>
      useMemoryAutosave({
        ...options("draft", save),
        enabled: false,
        flushOnUnmount: true,
      }),
    );

    unmount();

    await vi.waitFor(() => expect(save).toHaveBeenCalledWith("draft"));
  });

  it("makes a final unmount attempt for a previously failed draft", async () => {
    vi.useFakeTimers();
    const save = vi
      .fn<(value: string) => Promise<Saved>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async (content) => ({ content }));
    const { unmount } = renderHook(() =>
      useMemoryAutosave({
        ...options("draft", save),
        flushOnUnmount: true,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(save).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("draft");
  });
});
