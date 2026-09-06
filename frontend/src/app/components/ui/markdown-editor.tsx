"use client";

import { useEditor, EditorContent, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "tiptap-markdown";
import { useEffect, useRef, useState } from "react";
import {
  Bold,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Table2,
} from "lucide-react";
import { Button } from "@/app/components/ui/button";
import {
  TABLE_SURFACE_CLASS,
} from "@/app/components/ui/liquid-surface";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
  LiquidDropdownContent,
  LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import { cn } from "@/app/lib/utils";

export interface MarkdownEditorProps {
  value: string;
  onChange?: (markdown: string) => void;
  readOnly?: boolean;
  ariaLabel?: string;
  className?: string;
  /**
   * Offer the insert-table control. Tables already present in the Markdown
   * still render and round-trip when this is off; only authoring a new one
   * is withheld, which is what the memory editors want.
   */
  allowTables?: boolean;
}

function comparableMarkdown(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const trailing = line.match(/[ \t]+$/)?.[0];
      if (!trailing) return line;
      const content = line.slice(0, -trailing.length);
      // Two trailing spaces are meaningful Markdown (a hard line break).
      // Canonicalize longer runs but never erase that semantic distinction.
      return trailing.endsWith("  ") ? `${content}  ` : content;
    })
    .join("\n")
    .replace(/\n+$/, "");
}

function markdownRoundTrips(source: string, serialized: string) {
  return comparableMarkdown(source) === comparableMarkdown(serialized);
}

const TABLE_PICKER_MAX_ROWS = 8;
const TABLE_PICKER_MAX_COLS = 8;
const INACTIVE_FORMATTING = {
  heading1: false,
  heading2: false,
  heading3: false,
  bold: false,
  italic: false,
  bulletList: false,
  orderedList: false,
};

function AppToolbarButton({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`h-7 w-7 text-gray-600 hover:bg-white hover:text-gray-900 ${
        active ? "bg-gray-300 text-gray-950 hover:bg-gray-300" : ""
      }`}
      onMouseDown={(e) => {
        e.preventDefault(); // keep editor focus
      }}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function getEditorMarkdown(editor: NonNullable<ReturnType<typeof useEditor>>) {
  // tiptap-markdown adds .markdown to storage but isn't typed on Editor.storage
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (editor.storage as any).markdown.getMarkdown() as string;
}

export function MarkdownEditor({
  value,
  onChange,
  readOnly = false,
  ariaLabel = "Markdown editor",
  className,
  allowTables = true,
}: MarkdownEditorProps) {
  const lastEmittedRef = useRef(value);
  const rawTextareaRef = useRef<HTMLTextAreaElement>(null);
  const tableInsertionSelectionRef = useRef<{
    from: number;
    to: number;
  } | null>(null);
  const rawTableInsertionSelectionRef = useRef<{
    start: number;
    end: number;
  } | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [rawMarkdown, setRawMarkdown] = useState(value);
  const [rawModeRequired, setRawModeRequired] = useState(false);
  const [tablePickerOpen, setTablePickerOpen] = useState(false);
  const [tablePickerSize, setTablePickerSize] = useState<{
    rows: number;
    cols: number;
  } | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      TableKit.configure({
        table: {
          renderWrapper: true,
        },
      }),
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: value,
    editable: !readOnly,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      const md = getEditorMarkdown(editor);
      lastEmittedRef.current = md;
      setRawMarkdown(md);
      onChange?.(md);
    },
    editorProps: {
      attributes: {
        class: "tiptap markdown-editor-content",
        "aria-label": ariaLabel,
      },
    },
  });

  const activeFormatting =
    useEditorState({
      editor,
      selector: ({ editor }) => ({
        heading1: editor?.isActive("heading", { level: 1 }) ?? false,
        heading2: editor?.isActive("heading", { level: 2 }) ?? false,
        heading3: editor?.isActive("heading", { level: 3 }) ?? false,
        bold: editor?.isActive("bold") ?? false,
        italic: editor?.isActive("italic") ?? false,
        bulletList: editor?.isActive("bulletList") ?? false,
        orderedList: editor?.isActive("orderedList") ?? false,
      }),
    }) ?? INACTIVE_FORMATTING;

  // Sync external value (e.g. on load from API)
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const externalValueChanged = value !== lastEmittedRef.current;
    if (value !== lastEmittedRef.current) {
      lastEmittedRef.current = value;
      editor.commands.setContent(value, { emitUpdate: false });
    }
    // Tiptap may normalize or omit Markdown syntax it cannot represent. Keep
    // such documents in the canonical raw editor so merely viewing and
    // editing a memory file can never silently discard valid Markdown.
    const roundTrips = markdownRoundTrips(value, getEditorMarkdown(editor));
    const syncFrame = window.requestAnimationFrame(() => {
      if (externalValueChanged) setRawMarkdown(value);
      setRawModeRequired(!roundTrips);
      if (!roundTrips) setRawMode(true);
    });
    return () => window.cancelAnimationFrame(syncFrame);
  }, [editor, value]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  function handleRawToggle() {
    if (!editor || editor.isDestroyed) return;
    if (rawMode) {
      lastEmittedRef.current = rawMarkdown;
      editor.commands.setContent(rawMarkdown, { emitUpdate: false });
      const roundTrips = markdownRoundTrips(
        rawMarkdown,
        getEditorMarkdown(editor),
      );
      setRawModeRequired(!roundTrips);
      if (!roundTrips) return;
      setRawMode(false);
      return;
    }
    setRawMarkdown(getEditorMarkdown(editor));
    setRawMode(true);
  }

  function handleRawChange(next: string) {
    setRawMarkdown(next);
    lastEmittedRef.current = next;
    onChange?.(next);
  }

  function updateRawMarkdown(
    next: string,
    selectionStart: number,
    selectionEnd: number,
  ) {
    setRawMarkdown(next);
    lastEmittedRef.current = next;
    onChange?.(next);
    window.requestAnimationFrame(() => {
      rawTextareaRef.current?.focus();
      rawTextareaRef.current?.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  function transformRawSelection(
    transform: (
      selected: string,
      start: number,
      end: number,
    ) => {
      replacement: string;
      selectionStart: number;
      selectionEnd: number;
    },
  ) {
    const textarea = rawTextareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = rawMarkdown.slice(start, end);
    const result = transform(selected, start, end);
    const next =
      rawMarkdown.slice(0, start) + result.replacement + rawMarkdown.slice(end);
    updateRawMarkdown(next, result.selectionStart, result.selectionEnd);
  }

  function applyRawInline(marker: "*" | "**") {
    transformRawSelection((selected, start) => {
      const replacement = `${marker}${selected}${marker}`;
      const innerStart = start + marker.length;
      const innerEnd = innerStart + selected.length;
      return {
        replacement,
        selectionStart: selected ? innerStart : innerStart,
        selectionEnd: selected ? innerEnd : innerStart,
      };
    });
  }

  function transformRawLines(
    transformLine: (line: string, index: number) => string,
  ) {
    const textarea = rawTextareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const lineStart = rawMarkdown.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const lineEnd =
      end > start && rawMarkdown[end - 1] === "\n"
        ? end - 1
        : rawMarkdown.indexOf("\n", end);
    const resolvedLineEnd = lineEnd === -1 ? rawMarkdown.length : lineEnd;
    const block = rawMarkdown.slice(lineStart, resolvedLineEnd);
    let lineIndex = 0;
    const replacement = block
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        const next = transformLine(line, lineIndex);
        lineIndex += 1;
        return next;
      })
      .join("\n");
    const next =
      rawMarkdown.slice(0, lineStart) +
      replacement +
      rawMarkdown.slice(resolvedLineEnd);
    updateRawMarkdown(next, lineStart, lineStart + replacement.length);
  }

  function applyRawHeading(level: 1 | 2 | 3) {
    const prefix = `${"#".repeat(level)} `;
    transformRawLines((line) => prefix + line.replace(/^#{1,6}\s+/, ""));
  }

  function applyRawBulletList() {
    transformRawLines((line) =>
      line.replace(/^(\s*)(?:[-*+]|\d+\.)\s+/, "$1").replace(/^(\s*)/, "$1- "),
    );
  }

  function applyRawOrderedList() {
    transformRawLines((line, index) =>
      line
        .replace(/^(\s*)(?:[-*+]|\d+\.)\s+/, "$1")
        .replace(/^(\s*)/, `$1${index + 1}. `),
    );
  }

  function insertRawTable(rows: number, cols: number) {
    const textarea = rawTextareaRef.current;
    if (!textarea) return;
    const savedSelection = rawTableInsertionSelectionRef.current;
    const start = savedSelection?.start ?? textarea.selectionStart;
    const end = savedSelection?.end ?? textarea.selectionEnd;
    const before = rawMarkdown.slice(0, start);
    const after = rawMarkdown.slice(end);
    // Keep the table on its own line(s), whatever the caret sits on.
    const lead = before.length === 0 || before.endsWith("\n") ? "" : "\n";
    const trail = after.length === 0 || after.startsWith("\n") ? "" : "\n";
    const header =
      "| " +
      Array.from({ length: cols }, (_, index) => `Column ${index + 1}`).join(
        " | ",
      ) +
      " |";
    const separator =
      "| " + Array.from({ length: cols }, () => "---").join(" | ") + " |";
    const body = Array.from(
      { length: Math.max(0, rows - 1) },
      () => "| " + Array.from({ length: cols }, () => " ").join(" | ") + " |",
    );
    const table = [header, separator, ...body].join("\n") + "\n";
    const replacement = `${lead}${table}${trail}`;
    const caret = before.length + replacement.length;
    updateRawMarkdown(before + replacement + after, caret, caret);
  }

  function insertTable(rows: number, cols: number) {
    setTablePickerOpen(false);
    setTablePickerSize(null);

    if (rawMode) {
      insertRawTable(rows, cols);
      return;
    }

    if (!editor) return;
    const chain = editor.chain().focus();
    const savedSelection = tableInsertionSelectionRef.current;
    if (savedSelection) chain.setTextSelection(savedSelection);
    chain
      .insertTable({
        rows,
        cols,
        withHeaderRow: true,
      })
      .run();
  }

  function rememberTableInsertionSelection() {
    if (rawMode) {
      const textarea = rawTextareaRef.current;
      rawTableInsertionSelectionRef.current = textarea
        ? {
            start: textarea.selectionStart,
            end: textarea.selectionEnd,
          }
        : null;
      return;
    }
    if (!editor) return;
    tableInsertionSelectionRef.current = {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };
  }

  return (
    <div
      className={cn(
        "markdown-editor-surface flex h-full flex-col overflow-hidden",
        TABLE_SURFACE_CLASS,
        className,
      )}
    >
      {!readOnly && editor && (
        <div
          className="flex shrink-0 items-center gap-0.5 overflow-x-auto bg-app-surface px-2 py-1.5 backdrop-blur-xl"
          role="toolbar"
          aria-label="Markdown formatting"
        >
          <AppToolbarButton
            onClick={() =>
              rawMode
                ? applyRawHeading(1)
                : editor.chain().focus().toggleHeading({ level: 1 }).run()
            }
            active={!rawMode && activeFormatting.heading1}
            title="Heading 1"
          >
            <Heading1 className="h-4 w-4" />
          </AppToolbarButton>
          <AppToolbarButton
            onClick={() =>
              rawMode
                ? applyRawHeading(2)
                : editor.chain().focus().toggleHeading({ level: 2 }).run()
            }
            active={!rawMode && activeFormatting.heading2}
            title="Heading 2"
          >
            <Heading2 className="h-4 w-4" />
          </AppToolbarButton>
          <AppToolbarButton
            onClick={() =>
              rawMode
                ? applyRawHeading(3)
                : editor.chain().focus().toggleHeading({ level: 3 }).run()
            }
            active={!rawMode && activeFormatting.heading3}
            title="Heading 3"
          >
            <Heading3 className="h-4 w-4" />
          </AppToolbarButton>
          <div aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-gray-200" />
          <AppToolbarButton
            onClick={() =>
              rawMode
                ? applyRawInline("**")
                : editor.chain().focus().toggleBold().run()
            }
            active={!rawMode && activeFormatting.bold}
            title="Bold"
          >
            <Bold className="h-4 w-4" />
          </AppToolbarButton>
          <AppToolbarButton
            onClick={() =>
              rawMode
                ? applyRawInline("*")
                : editor.chain().focus().toggleItalic().run()
            }
            active={!rawMode && activeFormatting.italic}
            title="Italic"
          >
            <Italic className="h-4 w-4" />
          </AppToolbarButton>
          <div aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-gray-200" />
          <AppToolbarButton
            onClick={() =>
              rawMode
                ? applyRawBulletList()
                : editor.chain().focus().toggleBulletList().run()
            }
            active={!rawMode && activeFormatting.bulletList}
            title="Bullet list"
          >
            <List className="h-4 w-4" />
          </AppToolbarButton>
          <AppToolbarButton
            onClick={() =>
              rawMode
                ? applyRawOrderedList()
                : editor.chain().focus().toggleOrderedList().run()
            }
            active={!rawMode && activeFormatting.orderedList}
            title="Numbered list"
          >
            <ListOrdered className="h-4 w-4" />
          </AppToolbarButton>
          {allowTables ? (
            <>
              <div aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-gray-200" />
              <DropdownMenu
                open={tablePickerOpen}
                onOpenChange={(open) => {
                  setTablePickerOpen(open);
                  if (!open) setTablePickerSize(null);
                }}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="Insert table"
                    aria-label="Insert table"
                    aria-pressed={tablePickerOpen}
                    className={`h-7 w-7 text-gray-600 hover:bg-white hover:text-gray-900 ${
                      tablePickerOpen
                        ? "bg-gray-300 text-gray-950 hover:bg-gray-300"
                        : ""
                    }`}
                    onPointerDown={rememberTableInsertionSelection}
                  >
                    <Table2 className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <LiquidDropdownContent
                  align="start"
                  aria-label="Insert table"
                  className="z-[250] w-max p-2"
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  <div className="space-y-2">
                    <div
                      className="grid gap-1"
                      style={{
                        gridTemplateColumns: `repeat(${TABLE_PICKER_MAX_COLS}, 1rem)`,
                      }}
                    >
                      {Array.from(
                        { length: TABLE_PICKER_MAX_ROWS },
                        (_, rowIndex) =>
                          Array.from(
                            {
                              length: TABLE_PICKER_MAX_COLS,
                            },
                            (_, colIndex) => {
                              const rows = rowIndex + 1;
                              const cols = colIndex + 1;
                              const selected =
                                tablePickerSize !== null &&
                                rows <= tablePickerSize.rows &&
                                cols <= tablePickerSize.cols;

                              return (
                                <LiquidDropdownItem
                                  key={`${rows}-${cols}`}
                                  aria-label={`Insert ${rows} by ${cols} table`}
                                  selected={selected}
                                  onPointerMove={() =>
                                    setTablePickerSize({
                                      rows,
                                      cols,
                                    })
                                  }
                                  onFocus={() =>
                                    setTablePickerSize({
                                      rows,
                                      cols,
                                    })
                                  }
                                  onSelect={() => insertTable(rows, cols)}
                                  className={`h-4 w-4 min-w-0 rounded-[3px] border p-0 transition-colors ${
                                    selected
                                      ? "border-blue-600 bg-blue-600 focus:bg-blue-600"
                                      : "border-gray-200 bg-white hover:border-gray-400 focus:bg-white"
                                  }`}
                                />
                              );
                            },
                          ),
                      )}
                    </div>
                    <div className="text-center text-[11px] font-medium text-gray-500">
                      {tablePickerSize
                        ? `${tablePickerSize.rows} x ${tablePickerSize.cols}`
                        : "Select table size"}
                    </div>
                  </div>
                </LiquidDropdownContent>
              </DropdownMenu>
            </>
          ) : null}
          <div className="ml-auto" />
          {rawMode && rawModeRequired ? (
            <span className="whitespace-nowrap px-1 text-[11px] text-gray-500">
              Raw view preserves this Markdown
            </span>
          ) : null}
          <AppToolbarButton
            onClick={handleRawToggle}
            active={rawMode}
            title={rawMode ? "Show rich editor" : "Show raw Markdown"}
          >
            <Code2 className="h-4 w-4" />
          </AppToolbarButton>
        </div>
      )}
      {readOnly && (
        <div className="flex h-9 shrink-0 items-center justify-between bg-app-surface px-5 backdrop-blur-xl">
          <span className="text-xs font-medium text-gray-500">Read-only</span>
          {editor && (
            <AppToolbarButton
              onClick={handleRawToggle}
              active={rawMode}
              title={rawMode ? "Show rich editor" : "Show raw Markdown"}
            >
              <Code2 className="h-4 w-4" />
            </AppToolbarButton>
          )}
        </div>
      )}
      <div
        className={`flex-1 overflow-y-auto ${
          readOnly ? "border-t border-gray-100" : ""
        }`}
      >
        {rawMode ? (
          <textarea
            ref={rawTextareaRef}
            value={rawMarkdown}
            onChange={(event) => handleRawChange(event.target.value)}
            readOnly={readOnly}
            spellCheck={false}
            className="h-full min-h-full w-full resize-none bg-transparent px-5 py-4 font-mono text-xs leading-6 text-gray-800 outline-none placeholder:text-gray-400 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600/40 read-only:cursor-default"
            aria-label={`${ariaLabel} (raw Markdown)`}
          />
        ) : (
          <EditorContent editor={editor} />
        )}
      </div>
    </div>
  );
}
