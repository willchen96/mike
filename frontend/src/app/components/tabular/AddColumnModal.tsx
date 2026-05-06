"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Plus, X } from "lucide-react";
import type { ColumnConfig, ColumnFormat } from "../shared/types";
import { generateTabularColumnPrompt } from "@/app/lib/mikeApi";
import { FORMAT_OPTIONS, formatLabel, formatIcon } from "./columnFormat";
import { TAG_COLORS } from "./pillUtils";
import { getPresetConfig, PROMPT_PRESETS } from "./columnPresets";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ColumnDraft {
    name: string;
    prompt: string;
    format: ColumnFormat;
    tags: string[];
    tagInput: string;
}

const EMPTY_DRAFT: ColumnDraft = {
    name: "",
    prompt: "",
    format: "text",
    tags: [],
    tagInput: "",
};

interface Props {
    open: boolean;
    existingCount: number;
    onClose: () => void;
    onAdd: (cols: ColumnConfig[]) => void;
    editingColumn?: ColumnConfig;
    onSave?: (col: ColumnConfig) => void;
    onDelete?: () => void;
}

export function AddColumnModal({ open, existingCount, onClose, onAdd, editingColumn, onSave, onDelete }: Props) {
    const isEditing = !!editingColumn;
    const [columns, setColumns] = useState<ColumnDraft[]>([{ ...EMPTY_DRAFT }]);
    const [generatingIndices, setGeneratingIndices] = useState<number[]>([]);
    const [presetsOpenIndex, setPresetsOpenIndex] = useState<number | null>(
        null,
    );
    const presetsRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        if (editingColumn) {
            setColumns([{
                name: editingColumn.name,
                prompt: editingColumn.prompt,
                format: editingColumn.format ?? "text",
                tags: editingColumn.tags ?? [],
                tagInput: "",
            }]);
        } else {
            setColumns([{ ...EMPTY_DRAFT }]);
        }
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (presetsOpenIndex === null) return;
        function handleClickOutside(e: MouseEvent) {
            if (
                presetsRef.current &&
                !presetsRef.current.contains(e.target as Node)
            ) {
                setPresetsOpenIndex(null);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, [presetsOpenIndex]);

    if (!open) return null;

    function resetForm() {
        setColumns([{ ...EMPTY_DRAFT }]);
        setGeneratingIndices([]);
    }

    function handleClose() {
        resetForm();
        onClose();
    }

    function updateColumn(index: number, patch: Partial<ColumnDraft>) {
        setColumns((prev) =>
            prev.map((col, i) => (i === index ? { ...col, ...patch } : col)),
        );
    }

    function addAnotherColumn() {
        setColumns((prev) => [...prev, { ...EMPTY_DRAFT }]);
    }

    function removeColumn(index: number) {
        setColumns((prev) =>
            prev.length === 1
                ? [{ ...EMPTY_DRAFT }]
                : prev.filter((_, i) => i !== index),
        );
    }

    function commitTag(index: number) {
        setColumns((prev) => {
            const col = prev[index]!;
            const tag = col.tagInput.trim();
            if (!tag || col.tags.includes(tag)) {
                return prev.map((c, i) =>
                    i === index ? { ...c, tagInput: "" } : c,
                );
            }
            return prev.map((c, i) =>
                i === index
                    ? { ...c, tags: [...c.tags, tag], tagInput: "" }
                    : c,
            );
        });
    }

    function handleTagKeyDown(
        e: React.KeyboardEvent<HTMLInputElement>,
        index: number,
    ) {
        if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commitTag(index);
        } else if (
            e.key === "Backspace" &&
            columns[index]!.tagInput === "" &&
            columns[index]!.tags.length > 0
        ) {
            updateColumn(index, {
                tags: columns[index]!.tags.slice(0, -1),
            });
        }
    }

    async function autoGeneratePrompt(index: number) {
        const title = columns[index]?.name?.trim() ?? "";
        if (!title) return;
        setGeneratingIndices((prev) => [...prev, index]);
        try {
            const col = columns[index]!;
            const { prompt } = await generateTabularColumnPrompt(title, {
                format: col.format,
                tags: col.format === "tag" ? col.tags : undefined,
            });
            updateColumn(index, { prompt });
        } finally {
            setGeneratingIndices((prev) => prev.filter((v) => v !== index));
        }
    }

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (columns.some((col) => !col.name.trim() || !col.prompt.trim()))
            return;
        if (isEditing && onSave && editingColumn) {
            const col = columns[0]!;
            onSave({
                index: editingColumn.index,
                name: col.name.trim(),
                prompt: col.prompt.trim(),
                format: col.format,
                tags: col.format === "tag" ? col.tags : undefined,
            });
        } else {
            onAdd(
                columns.map((col, i) => ({
                    index: existingCount + i,
                    name: col.name.trim(),
                    prompt: col.prompt.trim(),
                    format: col.format,
                    tags: col.format === "tag" ? col.tags : undefined,
                })),
            );
        }
        resetForm();
        onClose();
    }

    return createPortal(
        <div className="fixed inset-0 z-[101] flex items-center justify-center bg-[#292629]/20 backdrop-blur-xs">
            <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl flex flex-col h-[600px]">
                {/* Header */}
                <div className="flex items-center justify-between px-6 pt-5 pb-2">
                    <div className="flex items-center gap-1.5 text-xs text-[#292629]/40">
                        <span>Tabular Review</span>
                        <span>›</span>
                        <span>{isEditing ? "Edit column" : "New column"}</span>
                    </div>
                    <button
                        onClick={handleClose}
                        className="rounded-lg p-1.5 text-[#292629]/40 hover:bg-[#F5F5F5] hover:text-[#292629]/60 transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <form
                    onSubmit={handleSubmit}
                    className="flex flex-col min-h-0 flex-1"
                >
                    {/* Body */}
                    <div className="px-6 pt-3 pb-5 space-y-5 overflow-y-auto flex-1">
                        {columns.map((column, index) => (
                            <div
                                key={index}
                                className="rounded-xl border border-[#C7C7B2] p-4"
                            >
                                {/* Name row */}
                                <div className="flex items-start gap-2">
                                    {/* Input + preset dropdown anchored to this wrapper */}
                                    <div
                                        className="relative flex flex-1 items-start"
                                        ref={
                                            presetsOpenIndex === index
                                                ? presetsRef
                                                : null
                                        }
                                    >
                                        <input
                                            type="text"
                                            value={column.name}
                                            onChange={(e) => {
                                                const name = e.target.value;
                                                const preset =
                                                    getPresetConfig(name);
                                                updateColumn(index, {
                                                    name,
                                                    ...(preset
                                                        ? {
                                                              prompt: preset.prompt,
                                                              format: preset.format,
                                                              tags:
                                                                  preset.tags ??
                                                                  [],
                                                              tagInput: "",
                                                          }
                                                        : {}),
                                                });
                                            }}
                                            placeholder="Column name"
                                            className="flex-1 text-2xl font-sans text-[#292629]/90 placeholder-[#C7C7B2] focus:outline-none bg-transparent"
                                            autoFocus={index === 0}
                                        />
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setPresetsOpenIndex(
                                                    presetsOpenIndex === index
                                                        ? null
                                                        : index,
                                                )
                                            }
                                            title="Column presets"
                                            className="mt-1.5 rounded-lg p-1.5 text-[#292629]/50 transition-colors hover:bg-[#F5F5F5] hover:text-[#292629]/80"
                                        >
                                            <ChevronDown
                                                className={`h-4 w-4 transition-transform ${presetsOpenIndex === index ? "rotate-180" : ""}`}
                                            />
                                        </button>
                                        {presetsOpenIndex === index && (
                                            <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-xl border border-[#C7C7B2]/50 bg-white shadow-lg overflow-y-auto max-h-64">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        updateColumn(index, { ...EMPTY_DRAFT });
                                                        setPresetsOpenIndex(null);
                                                    }}
                                                    className="w-full px-3 py-2 text-left text-sm text-[#292629]/40 hover:bg-[#F5F5F5] transition-colors border-b border-[#C7C7B2]/50"
                                                >
                                                    No Preset
                                                </button>
                                                {PROMPT_PRESETS.map(
                                                    (preset) => (
                                                        <button
                                                            key={preset.name}
                                                            type="button"
                                                            onClick={() => {
                                                                updateColumn(
                                                                    index,
                                                                    {
                                                                        name: preset.name,
                                                                        prompt: preset.prompt,
                                                                        format: preset.format,
                                                                        tags:
                                                                            preset.tags ??
                                                                            [],
                                                                        tagInput:
                                                                            "",
                                                                    },
                                                                );
                                                                setPresetsOpenIndex(
                                                                    null,
                                                                );
                                                            }}
                                                            className="w-full px-3 py-2 text-left text-sm text-[#292629]/80 hover:bg-[#F5F5F5] transition-colors"
                                                        >
                                                            {preset.name}
                                                        </button>
                                                    ),
                                                )}
                                            </div>
                                        )}
                                    </div>
                                    {columns.length > 1 && (
                                        <button
                                            type="button"
                                            onClick={() => removeColumn(index)}
                                            className="mt-1.5 rounded-lg p-1.5 text-[#292629]/30 transition-colors hover:bg-[#F5F5F5] hover:text-[#292629]/50"
                                        >
                                            <X className="h-4 w-4" />
                                        </button>
                                    )}
                                </div>

                                {/* Format */}
                                <div className="mt-4">
                                    <label className="text-sm font-medium text-[#292629]/50">
                                        Format
                                    </label>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <button className="mt-1 flex items-center justify-between rounded-md border border-[#C7C7B2] bg-white px-2 py-1.5 text-sm text-[#292629]/80 hover:border-[#C7C7B2] focus:outline-none">
                                                <span className="flex items-center gap-2">
                                                    {(() => {
                                                        const Icon = formatIcon(
                                                            column.format,
                                                        );
                                                        return (
                                                            <Icon className="h-3.5 w-3.5 text-[#292629]/40" />
                                                        );
                                                    })()}
                                                    {formatLabel(column.format)}
                                                </span>
                                                <ChevronDown className="h-3.5 w-3.5 text-[#292629]/40" />
                                            </button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent
                                            align="start"
                                            className="z-[200]"
                                        >
                                            <DropdownMenuRadioGroup
                                                value={column.format}
                                                onValueChange={(v) =>
                                                    updateColumn(index, {
                                                        format: v as ColumnFormat,
                                                        tags: [],
                                                        tagInput: "",
                                                    })
                                                }
                                            >
                                                {FORMAT_OPTIONS.map((o) => (
                                                    <DropdownMenuRadioItem
                                                        key={o.value}
                                                        value={o.value}
                                                    >
                                                        <o.icon className="h-3.5 w-3.5 text-[#292629]/40" />
                                                        {o.label}
                                                    </DropdownMenuRadioItem>
                                                ))}
                                            </DropdownMenuRadioGroup>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </div>

                                {/* Tag input */}
                                {column.format === "tag" && (
                                    <div className="mt-3">
                                        <label className="text-sm font-medium text-[#292629]/50">
                                            Tags
                                        </label>
                                        <div className="mt-1 flex flex-wrap gap-1.5 rounded-md border border-[#C7C7B2] px-2 py-1.5 focus-within:border-[#C7C7B2]">
                                            {column.tags.map((tag, tagIdx) => (
                                                <span
                                                    key={tag}
                                                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${TAG_COLORS[tagIdx % TAG_COLORS.length]}`}
                                                >
                                                    {tag}
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            updateColumn(
                                                                index,
                                                                {
                                                                    tags: column.tags.filter(
                                                                        (t) =>
                                                                            t !==
                                                                            tag,
                                                                    ),
                                                                },
                                                            )
                                                        }
                                                        className="text-[#292629]/40 hover:text-[#292629]/60"
                                                    >
                                                        <X className="h-2.5 w-2.5" />
                                                    </button>
                                                </span>
                                            ))}
                                            <input
                                                type="text"
                                                value={column.tagInput}
                                                onChange={(e) =>
                                                    updateColumn(index, {
                                                        tagInput:
                                                            e.target.value,
                                                    })
                                                }
                                                onKeyDown={(e) =>
                                                    handleTagKeyDown(e, index)
                                                }
                                                onBlur={() => commitTag(index)}
                                                placeholder="Add tag…"
                                                className="min-w-[80px] flex-1 bg-transparent text-sm text-[#292629]/80 placeholder-[#C7C7B2] focus:outline-none"
                                            />
                                        </div>
                                        <p className="mt-1 text-xs text-[#292629]/40">
                                            Press Enter or comma to add a tag.
                                        </p>
                                    </div>
                                )}

                                {/* Prompt */}
                                <div className="mt-4 flex items-center justify-between">
                                    <label className="text-sm font-medium text-[#292629]/50">
                                        Prompt
                                    </label>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            autoGeneratePrompt(index)
                                        }
                                        disabled={
                                            !column.name.trim() ||
                                            generatingIndices.includes(index)
                                        }
                                        className="inline-flex items-center gap-1.5 text-sm text-[#292629]/50 transition-colors hover:text-[#292629] disabled:text-[#292629]/30"
                                    >
                                        {generatingIndices.includes(index) ? (
                                            <span className="h-4 w-4 rounded-full border-2 border-[#C7C7B2] border-t-[#292629] animate-spin block" />
                                        ) : (
                                            <Plus className="h-4 w-4" />
                                        )}
                                        Auto-Generate Prompt
                                    </button>
                                </div>
                                <textarea
                                    rows={6}
                                    value={column.prompt}
                                    onChange={(e) =>
                                        updateColumn(index, {
                                            prompt: e.target.value,
                                        })
                                    }
                                    placeholder="Write the analysis prompt — describe what Mike should extract from each document for this column…"
                                    className="mt-2 w-full rounded-md border border-[#C7C7B2] px-3 py-2 text-sm text-[#292629]/80 placeholder-[#C7C7B2] focus:border-[#C7C7B2] focus:outline-none bg-transparent resize-none leading-relaxed"
                                />
                            </div>
                        ))}

                        {!isEditing && (
                            <button
                                type="button"
                                onClick={addAnotherColumn}
                                className="inline-flex items-center gap-1.5 text-sm text-[#292629]/50 transition-colors hover:text-[#292629]"
                            >
                                <Plus className="h-4 w-4" />
                                Add another column
                            </button>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between border-t border-[#C7C7B2]/50 px-6 py-4">
                        <div>
                            {isEditing && onDelete && (
                                <button
                                    type="button"
                                    onClick={onDelete}
                                    className="rounded-lg px-4 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors"
                                >
                                    Delete
                                </button>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={handleClose}
                                className="rounded-lg px-4 py-2 text-sm text-[#292629]/50 hover:bg-[#F5F5F5] transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={columns.some(
                                    (col) => !col.name.trim() || !col.prompt.trim(),
                                )}
                                className="rounded-lg bg-[#292629] px-5 py-2 text-sm font-medium text-white hover:bg-[#292629]/90 disabled:opacity-40 transition-colors"
                            >
                                {isEditing ? "Save changes" : "Add columns"}
                            </button>
                        </div>
                    </div>
                </form>
            </div>
        </div>,
        document.body,
    );
}
