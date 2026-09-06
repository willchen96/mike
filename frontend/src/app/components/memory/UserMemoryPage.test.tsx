import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MikeApiError,
  downloadUserMemoryMarkdown,
  getUserMemory,
  listUserMemoryVersions,
  restoreUserMemoryVersion,
  setUserMemoryEnabled,
  updateUserMemory,
  wipeUserMemory,
  type MemoryCurrent,
  type MemoryVersion,
} from "@/app/lib/mikeApi";
import { UserMemoryPage } from "./UserMemoryPage";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  downloadUserMemoryMarkdown: vi.fn(),
  getUserMemory: vi.fn(),
  listUserMemoryVersions: vi.fn(),
  restoreUserMemoryVersion: vi.fn(),
  setUserMemoryEnabled: vi.fn(),
  updateUserMemory: vi.fn(),
  wipeUserMemory: vi.fn(),
}));

vi.mock("@/app/components/ui/markdown-editor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    ariaLabel,
    readOnly,
  }: {
    value: string;
    onChange?: (value: string) => void;
    ariaLabel?: string;
    readOnly?: boolean;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

function current(overrides: Partial<MemoryCurrent> = {}): MemoryCurrent {
  return {
    enabled: true,
    content: "# Preferences",
    version: 2,
    hash: "hash-2",
    updated_at: "2026-09-05T10:00:00.000Z",
    updated_by: "user-1",
    source: "manual",
    status: "idle",
    ...overrides,
  };
}

function version(overrides: Partial<MemoryVersion> = {}): MemoryVersion {
  return {
    id: "version-2",
    version: 2,
    hash: "hash-2",
    size_bytes: 128,
    created_at: "2026-09-05T10:00:00.000Z",
    updated_by: "user-1",
    source: "manual",
    model: null,
    source_surface: null,
    source_chat_id: null,
    source_turn_id: null,
    change_summary: null,
    ...overrides,
  };
}

describe("UserMemoryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserMemory).mockResolvedValue(current());
    vi.mocked(listUserMemoryVersions).mockResolvedValue([
      version(),
      version({
        id: "version-1",
        version: 1,
        source: "curator",
        source_surface: "chat",
        change_summary: "Remembered a concise drafting preference",
      }),
    ]);
    vi.mocked(updateUserMemory).mockImplementation(async (content) =>
      current({ content, version: 3, hash: "hash-3" }),
    );
    vi.mocked(restoreUserMemoryVersion).mockResolvedValue(
      current({ content: "# Earlier", version: 3, hash: "hash-3" }),
    );
    vi.mocked(setUserMemoryEnabled).mockImplementation(async (enabled) =>
      current({
        enabled,
        content: "",
        version: 3,
        hash: null,
        updated_at: null,
        updated_by: null,
        source: "settings",
      }),
    );
    vi.mocked(wipeUserMemory).mockResolvedValue(
      current({
        content: "",
        version: 3,
        hash: null,
        updated_at: null,
        updated_by: null,
        source: "wipe",
      }),
    );
    vi.mocked(downloadUserMemoryMarkdown).mockResolvedValue({
      blob: new Blob(["# Preferences"]),
      filename: "memory.md",
    });
  });

  it("loads the current file independently and autosaves editor changes", async () => {
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    const toggle = screen.getByRole("switch", { name: "App-wide memory" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveClass("focus-visible:ring-2");
    expect(editor).toHaveValue("# Preferences");
    expect(
      screen.getByText(
        /may curate this private Markdown file after saved conversations/i,
      ),
    ).toBeVisible();
    expect(screen.getByText("Version 2 · Current")).toBeVisible();
    expect(
      screen.getByText(/Last updated .* · Version 2 · Manual edit/),
    ).toBeVisible();
    expect(
      screen.getByText("Remembered a concise drafting preference"),
    ).toBeVisible();

    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    await user.clear(editor);
    await user.type(editor, "# Saved");
    expect(updateUserMemory).not.toHaveBeenCalled();
    expect(screen.getByText("Saving…")).toBeVisible();

    await waitFor(
      () => expect(updateUserMemory).toHaveBeenCalledWith("# Saved", 2),
      { timeout: 2000 },
    );
    expect(await screen.findByText("Saved")).toBeVisible();
  });

  it("adopts server-normalized Markdown without repeatedly saving it", async () => {
    vi.mocked(updateUserMemory).mockResolvedValue(
      current({ content: "# Normalized", version: 3, hash: "hash-3" }),
    );
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    await screen.findByText("Version 2 · Current");

    vi.useFakeTimers();
    try {
      fireEvent.change(editor, { target: { value: "# Normalized " } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      expect(updateUserMemory).toHaveBeenCalledOnce();
      expect(editor).toHaveValue("# Normalized");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(updateUserMemory).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the editor available when only version history fails", async () => {
    vi.mocked(listUserMemoryVersions).mockRejectedValue(
      new Error("history unavailable"),
    );

    render(<UserMemoryPage />);

    expect(
      await screen.findByRole("textbox", { name: "App-wide memory" }),
    ).toHaveValue("# Preferences");
    expect(
      await screen.findByText("Version history could not be refreshed."),
    ).toBeVisible();
    expect(
      screen.queryByText("Memory could not be loaded"),
    ).not.toBeInTheDocument();
  });

  it("ignores an older history response after autosave refreshes it", async () => {
    let resolveInitialHistory!: (value: MemoryVersion[]) => void;
    vi.mocked(listUserMemoryVersions)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveInitialHistory = resolve;
        }),
      )
      .mockResolvedValueOnce([
        version({ id: "version-3", version: 3, hash: "hash-3" }),
      ]);
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    await waitFor(() => expect(listUserMemoryVersions).toHaveBeenCalledOnce());
    await user.clear(editor);
    await user.type(editor, "# Updated");

    expect(
      await screen.findByText("Version 3 · Current", {}, { timeout: 3000 }),
    ).toBeVisible();

    await act(async () => {
      resolveInitialHistory([version({ id: "version-1", version: 1 })]);
      await Promise.resolve();
    });

    expect(screen.getByText("Version 3 · Current")).toBeVisible();
    expect(screen.queryByText("Version 1")).toBeNull();
  });

  it("serializes saves without locking or overwriting newer editor input", async () => {
    let resolveSave!: (value: MemoryCurrent) => void;
    vi.mocked(updateUserMemory).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    await user.clear(editor);
    await user.type(editor, "# Pending");

    await waitFor(
      () => expect(updateUserMemory).toHaveBeenCalledWith("# Pending", 2),
      { timeout: 2000 },
    );
    expect(editor).not.toHaveAttribute("readonly");
    expect(
      screen.getByRole("switch", { name: "App-wide memory" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();

    await user.type(editor, " and newer");
    expect(editor).toHaveValue("# Pending and newer");

    await act(async () => {
      resolveSave(
        current({ content: "# Pending", version: 3, hash: "hash-3" }),
      );
    });
    expect(editor).toHaveValue("# Pending and newer");
    await waitFor(
      () =>
        expect(updateUserMemory).toHaveBeenLastCalledWith(
          "# Pending and newer",
          3,
        ),
      { timeout: 2000 },
    );
  });

  it("preserves a stale draft and requires an explicit conflict choice", async () => {
    const latest = current({
      content: "# Automatic update",
      version: 3,
      hash: "hash-3",
    });
    vi.mocked(getUserMemory)
      .mockResolvedValueOnce(current())
      .mockResolvedValueOnce(latest);
    vi.mocked(updateUserMemory)
      .mockRejectedValueOnce(
        new MikeApiError({
          status: 409,
          code: "memory_version_conflict",
          message: "Memory changed",
        }),
      )
      .mockResolvedValueOnce(
        current({ content: "# My draft", version: 4, hash: "hash-4" }),
      );
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    await user.clear(editor);
    await user.type(editor, "# My draft");

    expect(
      await screen.findByText(
        "Memory changed while you were editing",
        {},
        {
          timeout: 2000,
        },
      ),
    ).toBeVisible();
    expect(editor).toHaveValue("# My draft");

    await user.click(screen.getByRole("button", { name: "Keep my draft" }));

    await waitFor(
      () => expect(updateUserMemory).toHaveBeenLastCalledWith("# My draft", 3),
      { timeout: 2000 },
    );
  });

  it("keeps a failed autosave draft and lets the user retry it", async () => {
    vi.mocked(updateUserMemory).mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    await user.clear(editor);
    await user.type(editor, "# Still here");

    expect(
      await screen.findByText(
        "Memory could not be saved. Your draft has been kept.",
        {},
        { timeout: 2000 },
      ),
    ).toBeVisible();
    expect(editor).toHaveValue("# Still here");

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(
      () =>
        expect(updateUserMemory).toHaveBeenLastCalledWith("# Still here", 2),
      { timeout: 2000 },
    );
    expect(await screen.findByText("Saved")).toBeVisible();
  });

  it("flushes a pending autosave when the settings page unmounts", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    await user.clear(editor);
    await user.type(editor, "# Save on leave");
    expect(updateUserMemory).not.toHaveBeenCalled();

    unmount();

    await waitFor(() =>
      expect(updateUserMemory).toHaveBeenCalledWith("# Save on leave", 2),
    );
  });

  it("confirms a restore and sends the current version for concurrency", async () => {
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    await screen.findByRole("textbox", { name: "App-wide memory" });
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(screen.getByText("Restore version 1?")).toBeVisible();

    const restoreButtons = screen.getAllByRole("button", {
      name: "Restore",
    });
    await user.click(restoreButtons.at(-1)!);

    await waitFor(() =>
      expect(restoreUserMemoryVersion).toHaveBeenCalledWith("version-1", 2),
    );
    expect(await screen.findByText("Version 1 restored")).toBeVisible();
  });

  it("enables memory from the same settings page and reveals a blank editor", async () => {
    vi.mocked(getUserMemory).mockResolvedValue(
      current({
        enabled: false,
        content: "",
        version: 0,
        hash: null,
        updated_at: null,
        updated_by: null,
      }),
    );
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const toggle = await screen.findByRole("switch", {
      name: "App-wide memory",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(
      screen.queryByRole("textbox", { name: "App-wide memory" }),
    ).not.toBeInTheDocument();

    await user.click(toggle);

    await waitFor(() =>
      expect(setUserMemoryEnabled).toHaveBeenCalledWith(true),
    );
    expect(
      await screen.findByRole("textbox", { name: "App-wide memory" }),
    ).toHaveValue("");
  });

  it("confirms disable, warns about the draft, and clears editor history", async () => {
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    await user.clear(editor);
    await user.type(editor, "# Unsaved");
    await user.click(screen.getByRole("switch", { name: "App-wide memory" }));

    expect(setUserMemoryEnabled).not.toHaveBeenCalled();
    expect(
      screen.getByText("Turn off and delete app-wide memory?"),
    ).toBeVisible();
    expect(screen.getByText(/and your unsaved draft/i)).toBeVisible();
    expect(editor).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(updateUserMemory).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Disable" }));

    await waitFor(() =>
      expect(setUserMemoryEnabled).toHaveBeenCalledWith(false),
    );
    expect(
      screen.queryByRole("textbox", { name: "App-wide memory" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Version 2 · Current")).not.toBeInTheDocument();
  });

  it("deletes memory and history without disabling it", async () => {
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(wipeUserMemory).not.toHaveBeenCalled();
    expect(screen.getByText("Delete app-wide memory?")).toBeVisible();

    const deleteButtons = screen.getAllByRole("button", {
      name: "Delete",
    });
    await user.click(deleteButtons.at(-1)!);

    await waitFor(() => expect(wipeUserMemory).toHaveBeenCalledOnce());
    expect(editor).toHaveValue("");
    expect(
      screen.getByRole("switch", { name: "App-wide memory" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText("Version 2 · Current")).not.toBeInTheDocument();
  });

  it("treats a null head as empty even when its CAS version is positive", async () => {
    vi.mocked(getUserMemory).mockResolvedValue(
      current({
        content: "",
        version: 7,
        hash: null,
        updated_at: null,
        updated_by: null,
      }),
    );

    render(<UserMemoryPage />);

    await screen.findByRole("textbox", { name: "App-wide memory" });
    expect(
      screen.getByRole("button", { name: "Download memory.md" }),
    ).toBeDisabled();
    expect(screen.getByText("No saved memory yet")).toBeVisible();
    expect(screen.queryByText("Version 7")).not.toBeInTheDocument();
  });

  it("shows automatic-review status in the settings control", async () => {
    vi.mocked(getUserMemory).mockResolvedValue(
      current({ status: "scheduled" }),
    );

    render(<UserMemoryPage />);

    expect(await screen.findByText("On · review scheduled")).toBeVisible();
  });
});
