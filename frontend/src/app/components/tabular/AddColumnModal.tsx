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
import { useTranslations } from "next-intl";

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
    const t = useTranslations("tabular.addColumnModal");
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
        <div className="fixed inset-0 z-[101] flex items-center justify-center bg-black/20 backdrop-blur-xs">
            <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl flex flex-col h-[600px]">
                {/* Header */}
                <div className="flex items-center justify-between px-6 pt-5 pb-2">
                    <div className="flex items-center gap-1.5 text-xs text-gray-400">
                        <span>{t("revisaoTabular")}</span>
                        <span>›</span>
                        <span>{isEditing ? t("editarColuna") : t("novaColuna")}</span>
                    </div>
                    <button
                        onClick={handleClose}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
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
                                className="rounded-xl border border-gray-200 p-4"
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
                                            placeholder={t("placeholderNome")}
                                            className="flex-1 text-2xl font-serif text-gray-800 placeholder-gray-400 focus:outline-none bg-transparent"
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
                                            title={t("modelos")}
                                            className="mt-1.5 rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
                                        >
                                            <ChevronDown
                                                className={`h-4 w-4 transition-transform ${presetsOpenIndex === index ? "rotate-180" : ""}`}
                                            />
                                        </button>
                                        {presetsOpenIndex === index && (
                                            <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-xl border border-gray-100 bg-white shadow-lg overflow-y-auto max-h-64">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        updateColumn(index, { ...EMPTY_DRAFT });
                                                        setPresetsOpenIndex(null);
                                                    }}
                                                    className="w-full px-3 py-2 text-left text-sm text-gray-400 hover:bg-gray-50 transition-colors border-b border-gray-100"
                                                >
                                                    {t("semModelo")}
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
                                                            className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition-colors"
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
                                            className="mt-1.5 rounded-lg p-1.5 text-gray-300 transition-colors hover:bg-gray-100 hover:text-gray-500"
                                        >
                                            <X className="h-4 w-4" />
                                        </button>
                                    )}
                                </div>

                                {/* Format */}
                                <div className="mt-4">
                                    <label className="text-sm font-medium text-gray-500">
                                        {t("formato")}
                                    </label>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <button className="mt-1 flex items-center justify-between rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-700 hover:border-gray-400 focus:outline-none">
                                                <span className="flex items-center gap-2">
                                                    {(() => {
                                                        const Icon = formatIcon(
                                                            column.format,
                                                        );
                                                        return (
                                                            <Icon className="h-3.5 w-3.5 text-gray-400" />
                                                        );
                                                    })()}
                                                    {formatLabel(column.format)}
                                                </span>
                                                <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
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
                                                        <o.icon className="h-3.5 w-3.5 text-gray-400" />
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
                                        <label className="text-sm font-medium text-gray-500">
                                            {t("etiquetas")}
                                        </label>
                                        <div className="mt-1 flex flex-wrap gap-1.5 rounded-md border border-gray-200 px-2 py-1.5 focus-within:border-gray-400">
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
                                                        className="text-gray-400 hover:text-gray-600"
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
                                                placeholder={t("adicionarEtiqueta")}
                                                className="min-w-[80px] flex-1 bg-transparent text-sm text-gray-700 placeholder-gray-400 focus:outline-none"
                                            />
                                        </div>
                                        <p className="mt-1 text-xs text-gray-400">
                                            {t("instrucaoEtiqueta")}
                                        </p>
                                    </div>
                                )}

                                {/* Prompt */}
                                <div className="mt-4 flex items-center justify-between">
                                    <label className="text-sm font-medium text-gray-500">
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
                                        className="inline-flex items-center gap-1.5 text-sm text-gray-500 transition-colors hover:text-gray-900 disabled:text-gray-300"
                                    >
                                        {generatingIndices.includes(index) ? (
                                            <span className="h-4 w-4 rounded-full border-2 border-gray-300 border-t-gray-600 animate-spin block" />
                                        ) : (
                                            <Plus className="h-4 w-4" />
                                        )}
                                        {t("gerarPrompt")}
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
                                    placeholder={t("placeholderPrompt")}
                                    className="mt-2 w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-gray-400 focus:outline-none bg-transparent resize-none leading-relaxed"
                                />
                            </div>
                        ))}

                        {!isEditing && (
                            <button
                                type="button"
                                onClick={addAnotherColumn}
                                className="inline-flex items-center gap-1.5 text-sm text-gray-500 transition-colors hover:text-gray-900"
                            >
                                <Plus className="h-4 w-4" />
                                {t("adicionarOutraColuna")}
                            </button>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4">
                        <div>
                            {isEditing && onDelete && (
                                <button
                                    type="button"
                                    onClick={onDelete}
                                    className="rounded-lg px-4 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors"
                                >
                                    {t("excluir")}
                                </button>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={handleClose}
                                className="rounded-lg px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
                            >
                                {t("cancelar")}
                            </button>
                            <button
                                type="submit"
                                disabled={columns.some(
                                    (col) => !col.name.trim() || !col.prompt.trim(),
                                )}
                                className="rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40 transition-colors"
                            >
                                {isEditing ? t("salvarAlteracoes") : t("adicionarColunas")}
                            </button>
                        </div>
                    </div>
                </form>
            </div>
        </div>,
        document.body,
    );
}
