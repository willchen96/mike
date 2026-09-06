import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./markdown-editor";

const mocks = vi.hoisted(() => {
  const chain = {
    focus: vi.fn(),
    setTextSelection: vi.fn(),
    insertTable: vi.fn(),
    run: vi.fn(),
  };
  chain.focus.mockReturnValue(chain);
  chain.setTextSelection.mockReturnValue(chain);
  chain.insertTable.mockReturnValue(chain);
  chain.run.mockReturnValue(true);

  return {
    chain,
    useEditor: vi.fn(),
    editor: {
      isDestroyed: false,
      state: { selection: { from: 4, to: 9 } },
      storage: { markdown: { getMarkdown: (): string => "Prompt" } },
      commands: { setContent: vi.fn() },
      setEditable: vi.fn(),
      chain: vi.fn(() => chain),
      isActive: vi.fn(() => false),
    },
  };
});

mocks.useEditor.mockReturnValue(mocks.editor);

vi.mock("@tiptap/react", () => ({
  useEditor: mocks.useEditor,
  useEditorState: () => undefined,
  EditorContent: () => <div data-testid="editor-content" />,
}));

vi.mock("@tiptap/starter-kit", () => ({
  default: { configure: vi.fn(() => ({})) },
}));

vi.mock("@tiptap/extension-table", () => ({
  TableKit: { configure: vi.fn(() => ({})) },
}));

vi.mock("tiptap-markdown", () => ({
  Markdown: { configure: vi.fn(() => ({})) },
}));

describe("MarkdownEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chain.focus.mockReturnValue(mocks.chain);
    mocks.chain.setTextSelection.mockReturnValue(mocks.chain);
    mocks.chain.insertTable.mockReturnValue(mocks.chain);
    mocks.chain.run.mockReturnValue(true);
    mocks.editor.chain.mockReturnValue(mocks.chain);
    mocks.useEditor.mockReturnValue(mocks.editor);
    mocks.editor.storage.markdown.getMarkdown = () => "Prompt";
  });

  it("selects a grid size and inserts at the saved editor selection", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MarkdownEditor
        value="Prompt"
        onChange={vi.fn()}
        ariaLabel="Memory document"
        className="workflow-prompt-editor-surface"
      />,
    );

    expect(container.firstElementChild).toHaveClass(
      "workflow-prompt-editor-surface",
      "markdown-editor-surface",
      "rounded-2xl",
    );

    expect(
      screen.getByRole("toolbar", { name: "Markdown formatting" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Insert table" }));
    const gridCell = screen.getByRole("menuitem", {
      name: "Insert 3 by 4 table",
    });
    await user.hover(gridCell);
    expect(screen.getByText("3 x 4")).toBeVisible();

    await user.click(gridCell);

    expect(mocks.chain.setTextSelection).toHaveBeenCalledWith({
      from: 4,
      to: 9,
    });
    expect(mocks.chain.insertTable).toHaveBeenCalledWith({
      rows: 3,
      cols: 4,
      withHeaderRow: true,
    });
  });

  it("withholds the table control when tables are not allowed", () => {
    render(
      <MarkdownEditor
        value="Prompt"
        ariaLabel="Memory document"
        allowTables={false}
      />,
    );

    expect(
      screen.getByRole("toolbar", { name: "Markdown formatting" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Insert table" })).toBeNull();
    expect(screen.getByRole("button", { name: "Heading 1" })).toBeVisible();
  });

  it("names the rich and raw editors and gives raw mode a focus indicator", async () => {
    const user = userEvent.setup();
    render(<MarkdownEditor value="Prompt" ariaLabel="Memory document" />);

    expect(mocks.useEditor).toHaveBeenCalledWith(
      expect.objectContaining({
        editorProps: {
          attributes: expect.objectContaining({
            "aria-label": "Memory document",
            class: "tiptap markdown-editor-content",
          }),
        },
      }),
    );

    await user.click(
      screen.getByRole("button", { name: "Show raw Markdown" }),
    );
    expect(
      screen.getByRole("textbox", {
        name: "Memory document (raw Markdown)",
      }),
    ).toHaveClass("focus-visible:ring-2");
  });

  it("activates toolbar controls from the keyboard", async () => {
    const user = userEvent.setup();
    render(<MarkdownEditor value="Prompt" ariaLabel="Memory document" />);

    const rawToggle = screen.getByRole("button", {
      name: "Show raw Markdown",
    });
    rawToggle.focus();
    await user.keyboard("{Enter}");

    expect(
      screen.getByRole("textbox", {
        name: "Memory document (raw Markdown)",
      }),
    ).toBeVisible();
  });

  it("syncs external values in raw mode and updates editability", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <MarkdownEditor value="Prompt" ariaLabel="Memory document" />,
    );
    await user.click(
      screen.getByRole("button", { name: "Show raw Markdown" }),
    );

    rerender(
      <MarkdownEditor
        value="Latest value"
        ariaLabel="Memory document"
        readOnly
      />,
    );

    expect(mocks.editor.commands.setContent).toHaveBeenCalledWith(
      "Latest value",
      { emitUpdate: false },
    );
    expect(mocks.editor.setEditable).toHaveBeenLastCalledWith(false, false);
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", {
          name: "Memory document (raw Markdown)",
        }),
      ).toHaveValue("Latest value"),
    );
  });

  it("keeps lossy Markdown in raw mode instead of rewriting it", async () => {
    mocks.editor.storage.markdown.getMarkdown = () => "plain text";

    render(
      <MarkdownEditor
        value={"![diagram](diagram.png)\n\nplain text"}
        ariaLabel="Memory document"
      />,
    );

    expect(
      await screen.findByRole("textbox", {
        name: "Memory document (raw Markdown)",
      }),
    ).toHaveValue("![diagram](diagram.png)\n\nplain text");
    expect(
      screen.getByText("Raw view preserves this Markdown"),
    ).toBeVisible();
  });

  it("preserves Markdown hard breaks when the rich editor drops them", async () => {
    mocks.editor.storage.markdown.getMarkdown = () => "first line\nsecond line";

    render(
      <MarkdownEditor
        value={"first line  \nsecond line"}
        ariaLabel="Memory document"
      />,
    );

    expect(
      await screen.findByRole("textbox", {
        name: "Memory document (raw Markdown)",
      }),
    ).toHaveValue("first line  \nsecond line");
  });
});
