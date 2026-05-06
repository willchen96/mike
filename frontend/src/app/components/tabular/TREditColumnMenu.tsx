"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Loader2, MoreHorizontal, Plus, Trash2, X } from "lucide-react";
import type { ColumnConfig, ColumnFormat } from "../shared/types";
import { generateTabularColumnPrompt } from "@/app/lib/mikeApi";
import { FORMAT_OPTIONS, formatLabel, formatIcon } from "./columnFormat";
import { TAG_COLORS } from "./pillUtils";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface TREditColumnMenuProps {
    column: ColumnConfig;
    disabled?: boolean;
    onSave: (column: ColumnConfig) => void | Promise<void>;
    onDelete: (columnIndex: number) => void | Promise<void>;
}

export function TREditColumnMenu({
    column,
    disabled,
    onSave,
    onDelete,
}: TREditColumnMenuProps) {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState(column.name);
    const [prompt, setPrompt] = useState(column.prompt);
    const [format, setFormat] = useState<ColumnFormat>(column.format ?? "text");
    const [tags, setTags] = useState<string[]>(column.tags ?? []);
    const [tagInput, setTagInput] = useState("");
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [generating, setGenerating] = useState(false);

    useEffect(() => {
        if (!open) {
            setName(column.name);
            setPrompt(column.prompt);
            setFormat(column.format ?? "text");
            setTags(column.tags ?? []);
            setTagInput("");
        }
    }, [column.name, column.prompt, column.format, column.tags, open]);

    function commitTag() {
        const tag = tagInput.trim();
        if (!tag) {
            setTagInput("");
            return;
        }
        setTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
        setTagInput("");
    }

    function handleTagKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commitTag();
        } else if (
            e.key === "Backspace" &&
            tagInput === "" &&
            tags.length > 0
        ) {
            setTags((prev) => prev.slice(0, -1));
        }
    }

    async function handleSave() {
        setSaving(true);
        try {
            await onSave({
                ...column,
                name: name.trim(),
                prompt: prompt.trim(),
                format,
                tags: format === "tag" ? tags : undefined,
            });
            setOpen(false);
        } finally {
            setSaving(false);
        }
    }
    console.log(tags);

    async function handleDelete() {
        setDeleting(true);
        try {
            await onDelete(column.index);
            setOpen(false);
        } finally {
            setDeleting(false);
        }
    }

    async function handleAutoGenerate() {
        if (!name.trim()) return;
        setGenerating(true);
        try {
            const { prompt } = await generateTabularColumnPrompt(name.trim(), {
                format,
                tags: format === "tag" ? tags : undefined,
            });
            setPrompt(prompt);
        } finally {
            setGenerating(false);
        }
    }

    return (
        <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    if (disabled) return;
                    setOpen((v) => !v);
                }}
                disabled={disabled}
                className={`flex h-4 w-4 items-center justify-center rounded transition-colors ${
                    disabled
                        ? "text-[#292629]/30 cursor-default"
                        : "text-[#292629]/40 hover:bg-[#F5F5F5] hover:text-[#292629]/60"
                }`}
            >
                <MoreHorizontal className="h-4 w-4" />
            </button>

            {open && (
                <div
                    className="absolute right-0 top-full z-20 mt-1.5 w-72 rounded-xl border border-[#C7C7B2]/50 bg-white p-3 shadow-lg"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="flex items-center justify-between mb-3">
                        <p className="text-sm font-medium text-[#292629]/90">
                            Edit Column
                        </p>
                        <button
                            type="button"
                            onClick={() => setOpen(false)}
                            className="rounded p-0.5 text-[#292629]/40 hover:bg-[#F5F5F5] hover:text-[#292629]/60 transition-colors"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                    <label className="text-xs font-medium text-[#292629]/90">
                        Label
                    </label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="mt-1 w-full rounded-md border border-[#C7C7B2] px-2 py-1 text-[#292629]/90 text-xs font-normal focus:border-[#C7C7B2] focus:outline-none"
                    />

                    {/* Format */}
                    <div className="mt-3">
                        <label className="text-xs font-medium text-[#292629]/90">
                            Format
                        </label>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button className="mt-1 flex w-full items-center justify-between rounded-md border border-[#C7C7B2] bg-white px-2 py-1 text-xs text-[#292629]/80 hover:border-[#C7C7B2] focus:outline-none">
                                    <span className="flex items-center gap-1.5">
                                        {(() => {
                                            const Icon = formatIcon(format);
                                            return (
                                                <Icon className="h-3 w-3 text-[#292629]/40" />
                                            );
                                        })()}
                                        {formatLabel(format)}
                                    </span>
                                    <ChevronDown className="h-3 w-3 text-[#292629]/40" />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                                align="start"
                                style={{
                                    width: "var(--radix-dropdown-menu-trigger-width)",
                                }}
                            >
                                <DropdownMenuRadioGroup
                                    value={format}
                                    onValueChange={(v) => {
                                        setFormat(v as ColumnFormat);
                                        setTags([]);
                                        setTagInput("");
                                    }}
                                >
                                    {FORMAT_OPTIONS.map((o) => (
                                        <DropdownMenuRadioItem
                                            key={o.value}
                                            value={o.value}
                                            className="text-xs"
                                        >
                                            <o.icon className="h-3 w-3 text-[#292629]/40" />
                                            {o.label}
                                        </DropdownMenuRadioItem>
                                    ))}
                                </DropdownMenuRadioGroup>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>

                    {/* Tag input */}
                    {format === "tag" && (
                        <div className="mt-2">
                            <div className="flex flex-wrap gap-1 rounded-md border border-[#C7C7B2] px-2 py-1 focus-within:border-[#C7C7B2] min-h-[28px]">
                                {tags.map((tag, tagIdx) => (
                                    <span
                                        key={tag}
                                        className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] ${TAG_COLORS[tagIdx % TAG_COLORS.length]}`}
                                    >
                                        {tag}
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setTags((prev) =>
                                                    prev.filter(
                                                        (t) => t !== tag,
                                                    ),
                                                )
                                            }
                                            className="text-[#292629]/40 hover:text-[#292629]/60"
                                        >
                                            <X className="h-2 w-2" />
                                        </button>
                                    </span>
                                ))}
                                <input
                                    type="text"
                                    value={tagInput}
                                    onChange={(e) =>
                                        setTagInput(e.target.value)
                                    }
                                    onKeyDown={handleTagKeyDown}
                                    onBlur={commitTag}
                                    placeholder={
                                        tags.length === 0 ? "Add tags…" : ""
                                    }
                                    className="min-w-[60px] flex-1 bg-transparent text-xs text-[#292629]/80 placeholder-[#C7C7B2] focus:outline-none"
                                />
                            </div>
                        </div>
                    )}

                    {/* Prompt */}
                    <div className="mt-3">
                        <div className="flex items-center justify-between">
                            <label className="text-xs font-medium text-[#292629]/90">
                                Prompt
                            </label>
                            <button
                                type="button"
                                onClick={handleAutoGenerate}
                                disabled={!name.trim() || generating}
                                className="inline-flex items-center gap-1 text-xs text-[#292629]/60 transition-colors hover:text-[#292629]/80 disabled:text-[#292629]/30"
                            >
                                {generating ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                    <Plus className="h-3 w-3" />
                                )}
                                Auto-generate
                            </button>
                        </div>
                        <textarea
                            rows={6}
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            className="mt-2 w-full rounded-lg border border-[#C7C7B2] bg-white px-3 py-2 text-xs font-normal text-[#292629]/90 placeholder-[#C7C7B2] focus:border-[#C7C7B2] focus:outline-none resize-none leading-relaxed"
                        />
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-2">
                        <button
                            type="button"
                            onClick={handleDelete}
                            disabled={deleting || saving}
                            className="inline-flex items-center gap-1.5 text-xs text-red-500 transition-colors hover:text-red-600 disabled:text-red-300"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete
                        </button>
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={
                                saving ||
                                deleting ||
                                generating ||
                                !name.trim() ||
                                !prompt.trim()
                            }
                            className="rounded-full bg-[#292629] px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-[#292629]/90 disabled:opacity-40"
                        >
                            {saving ? "Saving…" : "Save"}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
