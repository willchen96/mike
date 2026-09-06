import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MikeApiError,
  getProjectMemory,
  listProjectMemoryVersions,
  restoreProjectMemoryVersion,
  setProjectMemoryEnabled,
  updateProjectMemory,
  wipeProjectMemory,
} from "@/app/lib/mikeApi";
import { ProjectMemoryModal } from "./ProjectMemoryModal";

vi.mock("@/app/components/ui/markdown-editor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    readOnly,
    ariaLabel,
  }: {
    value: string;
    onChange?: (value: string) => void;
    readOnly?: boolean;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  downloadProjectMemoryMarkdown: vi.fn(),
  getProjectMemory: vi.fn(),
  listProjectMemoryVersions: vi.fn(),
  restoreProjectMemoryVersion: vi.fn(),
  setProjectMemoryEnabled: vi.fn(),
  updateProjectMemory: vi.fn(),
  wipeProjectMemory: vi.fn(),
}));

const CURRENT = {
  enabled: true,
  content: "# Matter facts",
  version: 2,
  hash: "hash-2",
  updated_at: "2026-09-05T01:00:00Z",
  updated_by: "Alex",
  source: "curator" as const,
  status: "idle" as const,
};

const OLD_VERSION = {
  id: "version-1",
  version: 1,
  hash: "hash-1",
  size_bytes: 24,
  created_at: "2026-09-04T01:00:00Z",
  updated_by: "Alex",
  source: "manual" as const,
  model: null,
  source_surface: null,
  source_chat_id: null,
  source_turn_id: null,
  change_summary: null,
};

function renderModal(
  props: Partial<React.ComponentProps<typeof ProjectMemoryModal>> = {},
) {
  const onClose = vi.fn();
  const onMemoryEnabledChange = vi.fn();
  const result = render(
    <ProjectMemoryModal
      open
      onClose={onClose}
      projectId="project-1"
      projectName="Matter"
      canEdit={false}
      canManage={false}
      onMemoryEnabledChange={onMemoryEnabledChange}
      {...props}
    />,
  );
  return { ...result, onClose, onMemoryEnabledChange };
}

describe("ProjectMemoryModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectMemory).mockResolvedValue(CURRENT);
    vi.mocked(listProjectMemoryVersions).mockResolvedValue([
      { ...OLD_VERSION, id: "version-2", version: 2 },
      OLD_VERSION,
    ]);
    vi.mocked(updateProjectMemory).mockImplementation(
      async (_projectId, content) => ({
        ...CURRENT,
        content,
        version: 3,
        hash: "hash-3",
      }),
    );
  });

  it("does not read memory until the dialog is opened", async () => {
    const { rerender, onClose } = renderModal({ open: false });

    expect(getProjectMemory).not.toHaveBeenCalled();

    rerender(
      <ProjectMemoryModal
        open
        onClose={onClose}
        projectId="project-1"
        projectName="Matter"
        canEdit={false}
        canManage={false}
      />,
    );

    await screen.findByRole("textbox", { name: "Project memory" });
    expect(getProjectMemory).toHaveBeenCalledWith(
      "project-1",
      expect.anything(),
    );
  });

  it("lets viewers read memory without edit or restore controls", async () => {
    renderModal();

    const editor = await screen.findByRole("textbox", {
      name: "Project memory",
    });
    expect(
      screen.getByText(/Last updated .* · Version 2 · Automatic update/),
    ).toBeVisible();
    expect(editor).toHaveValue("# Matter facts");
    expect(editor).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Download project memory.md" }),
    ).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Memory" })).toHaveClass(
      "max-w-2xl",
      "h-[min(600px,calc(100vh-2rem))]",
    );
    expect(screen.getByRole("dialog", { name: "Memory" })).not.toHaveClass(
      "max-w-4xl",
    );
  });

  it("autosaves an editor's draft against the loaded version", async () => {
    vi.mocked(updateProjectMemory).mockResolvedValue({
      ...CURRENT,
      content: "# Updated",
      version: 3,
    });
    const user = userEvent.setup();
    renderModal({ canEdit: true });

    const editor = await screen.findByRole("textbox", {
      name: "Project memory",
    });
    await user.clear(editor);
    await user.type(editor, "# Updated");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(updateProjectMemory).not.toHaveBeenCalled();
    expect(screen.getByText("Saving…")).toBeVisible();

    await waitFor(
      () =>
        expect(updateProjectMemory).toHaveBeenCalledWith(
          "project-1",
          "# Updated",
          2,
        ),
      { timeout: 2000 },
    );
    expect(await screen.findByText("Saved")).toBeVisible();
  });

  it("adopts server-normalized Markdown without repeatedly saving it", async () => {
    vi.mocked(updateProjectMemory).mockResolvedValue({
      ...CURRENT,
      content: "# Normalized",
      version: 3,
      hash: "hash-3",
    });
    renderModal({ canEdit: true });

    const editor = await screen.findByRole("textbox", {
      name: "Project memory",
    });
    await screen.findByText("Version 2 · Current");

    vi.useFakeTimers();
    try {
      fireEvent.change(editor, { target: { value: "# Normalized " } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      expect(updateProjectMemory).toHaveBeenCalledOnce();
      expect(editor).toHaveValue("# Normalized");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(updateProjectMemory).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes an unsaved draft before closing", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal({ canEdit: true });

    const editor = await screen.findByRole("textbox", {
      name: "Project memory",
    });
    fireEvent.change(editor, {
      target: { value: "# Matter facts and more" },
    });
    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(
      () =>
        expect(updateProjectMemory).toHaveBeenCalledWith(
          "project-1",
          "# Matter facts and more",
          2,
        ),
      { timeout: 2000 },
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByText("Discard unsaved memory edits?")).toBeNull();
  });

  it("closes without confirmation when nothing is unsaved", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal({ canEdit: true });

    await screen.findByRole("textbox", { name: "Project memory" });
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText("Discard unsaved memory edits?")).toBeNull();
  });

  it("offers an explicit discard path when autosave fails during close", async () => {
    vi.mocked(updateProjectMemory).mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    const { onClose } = renderModal({ canEdit: true });

    const editor = await screen.findByRole("textbox", {
      name: "Project memory",
    });
    fireEvent.change(editor, {
      target: { value: "# Matter facts unsaved" },
    });
    expect(
      await screen.findByText(
        "Project memory could not be saved. Your draft has been kept.",
        {},
        { timeout: 3000 },
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Close without saving?")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Close without saving" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps current memory available when only history fails", async () => {
    vi.mocked(listProjectMemoryVersions).mockRejectedValue(
      new Error("history unavailable"),
    );

    renderModal();

    expect(
      await screen.findByRole("textbox", { name: "Project memory" }),
    ).toHaveValue("# Matter facts");
    expect(
      await screen.findByText("Version history could not be refreshed."),
    ).toBeVisible();
    expect(screen.queryByText("Project memory could not be loaded")).toBeNull();
  });

  it("ignores an older history response after autosave refreshes it", async () => {
    let resolveInitialHistory!: (value: (typeof OLD_VERSION)[]) => void;
    vi.mocked(listProjectMemoryVersions)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveInitialHistory = resolve;
        }),
      )
      .mockResolvedValueOnce([{ ...OLD_VERSION, id: "version-3", version: 3 }]);
    renderModal({ canEdit: true });

    const editor = await screen.findByRole("textbox", {
      name: "Project memory",
    });
    await waitFor(() =>
      expect(listProjectMemoryVersions).toHaveBeenCalledTimes(1),
    );
    fireEvent.change(editor, {
      target: { value: "# Matter facts updated" },
    });
    expect(
      await screen.findByText("Version 3 · Current", {}, { timeout: 3000 }),
    ).toBeVisible();

    await act(async () => {
      resolveInitialHistory([OLD_VERSION]);
      await Promise.resolve();
    });

    expect(screen.getByText("Version 3 · Current")).toBeVisible();
    expect(screen.queryByText("Version 1")).toBeNull();
  });

  it("preserves an editor's stale draft across a version conflict", async () => {
    const latest = {
      ...CURRENT,
      content: "# Automatic update",
      version: 3,
      hash: "hash-3",
    };
    vi.mocked(getProjectMemory)
      .mockResolvedValueOnce(CURRENT)
      .mockResolvedValueOnce(latest);
    vi.mocked(updateProjectMemory)
      .mockRejectedValueOnce(
        new MikeApiError({
          status: 409,
          code: "memory_version_conflict",
          message: "Memory changed",
        }),
      )
      .mockResolvedValueOnce({
        ...CURRENT,
        content: "# My draft",
        version: 4,
        hash: "hash-4",
      });
    const user = userEvent.setup();
    renderModal({ canEdit: true, canManage: true });

    const editor = await screen.findByRole("textbox", {
      name: "Project memory",
    });
    await user.clear(editor);
    await user.type(editor, "# My draft");

    expect(
      await screen.findByText(
        "Project memory changed while you were editing",
        {},
        { timeout: 2000 },
      ),
    ).toBeVisible();
    expect(editor).toHaveValue("# My draft");

    await user.click(screen.getByRole("button", { name: "Keep my draft" }));

    await waitFor(
      () =>
        expect(updateProjectMemory).toHaveBeenLastCalledWith(
          "project-1",
          "# My draft",
          3,
        ),
      { timeout: 2000 },
    );
  });

  it("restores an older version against the current version", async () => {
    vi.mocked(restoreProjectMemoryVersion).mockResolvedValue({
      ...CURRENT,
      content: "# Earlier",
      version: 3,
      hash: "hash-3",
    });
    const user = userEvent.setup();
    renderModal({ canEdit: true, canManage: true });

    await screen.findByRole("textbox", { name: "Project memory" });
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(screen.getByText("Restore version 1?")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Delete project memory" }),
    ).toBeDisabled();

    const restoreButtons = screen.getAllByRole("button", {
      name: "Restore",
    });
    await user.click(restoreButtons.at(-1)!);

    await waitFor(() =>
      expect(restoreProjectMemoryVersion).toHaveBeenCalledWith(
        "project-1",
        "version-1",
        2,
      ),
    );
  });

  it("only enables disabled memory for a project owner", async () => {
    const off = {
      ...CURRENT,
      enabled: false,
      content: "",
      version: 0,
      hash: null,
      updated_at: null,
      updated_by: null,
    };
    vi.mocked(getProjectMemory).mockResolvedValue(off);
    vi.mocked(setProjectMemoryEnabled).mockResolvedValue({
      ...off,
      enabled: true,
    });
    const user = userEvent.setup();
    const { onMemoryEnabledChange } = renderModal({
      canEdit: true,
      canManage: true,
    });

    await user.click(await screen.findByRole("button", { name: "Enable" }));

    await waitFor(() =>
      expect(setProjectMemoryEnabled).toHaveBeenCalledWith("project-1", true),
    );
    expect(await screen.findByText("Project memory enabled")).toBeVisible();
    expect(onMemoryEnabledChange).toHaveBeenLastCalledWith(true);
  });

  it("hides the enable action from members who cannot manage access", async () => {
    vi.mocked(getProjectMemory).mockResolvedValue({
      ...CURRENT,
      enabled: false,
      content: "",
      version: 0,
      hash: null,
      updated_at: null,
      updated_by: null,
    });

    renderModal({ canEdit: true });

    expect(await screen.findByText("Project memory is off")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Enable" })).toBeNull();
  });

  it("requires confirmation before an owner deletes memory history", async () => {
    vi.mocked(wipeProjectMemory).mockResolvedValue({
      ...CURRENT,
      content: "",
      // Wipes clear the head while preserving a monotonic CAS token.
      version: 3,
      hash: null,
      updated_at: null,
      updated_by: null,
    });
    const user = userEvent.setup();
    renderModal({ canEdit: true, canManage: true });

    await user.click(
      await screen.findByRole("button", { name: "Delete project memory" }),
    );
    expect(wipeProjectMemory).not.toHaveBeenCalled();
    expect(screen.getByText("Delete project memory?")).toBeVisible();
    for (const restore of screen.getAllByRole("button", { name: "Restore" })) {
      expect(restore).toBeDisabled();
    }

    await user.click(screen.getAllByRole("button", { name: /Delete/ }).at(-1)!);
    await waitFor(() =>
      expect(wipeProjectMemory).toHaveBeenCalledWith("project-1"),
    );
    expect(
      await screen.findByText("Project memory and version history deleted"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Delete project memory" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Download project memory.md" }),
    ).toBeDisabled();
    expect(screen.queryByText("Version 3")).toBeNull();
  });

  it("lets an owner delete a pending first memory update", async () => {
    vi.mocked(getProjectMemory).mockResolvedValue({
      ...CURRENT,
      content: "",
      version: 0,
      hash: null,
      updated_at: null,
      updated_by: null,
      status: "scheduled",
    });

    renderModal({ canEdit: true, canManage: true });

    expect(
      await screen.findByRole("button", {
        name: "Delete project memory",
      }),
    ).toBeVisible();
  });

  it("polls until a scheduled project-memory update is visible", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getProjectMemory)
        .mockResolvedValueOnce({ ...CURRENT, status: "scheduled" })
        .mockResolvedValueOnce({
          ...CURRENT,
          content: "# Curated matter facts",
          version: 3,
          hash: "hash-3",
          status: "idle",
        });

      renderModal();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText(/Memory review scheduled/)).toBeVisible();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      expect(
        screen.getByRole("textbox", { name: "Project memory" }),
      ).toHaveValue("# Curated matter facts");
      expect(listProjectMemoryVersions).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
