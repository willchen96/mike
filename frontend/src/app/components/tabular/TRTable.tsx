"use client";

import { forwardRef, useImperativeHandle, useRef } from "react";
import { Plus, Table2 } from "lucide-react";
import type { ColumnConfig, MikeDocument, TabularCell } from "../shared/types";
import { TabularCell as TabularCellComponent } from "./TabularCell";
import { TREditColumnMenu } from "./TREditColumnMenu";

const SKELETON_COLS = 4;
const SKELETON_ROWS = 5;

const COL_W = "w-[300px] shrink-0";
const CHECK_W = "w-8 shrink-0";

// Pixel widths matching the CSS constants above
const CHECK_W_PX = 32; // w-8 = 2rem = 32px
const DOC_COL_W_PX = 300;
const DATA_COL_W_PX = 300;
const STICKY_LEFT_PX = CHECK_W_PX + DOC_COL_W_PX; // 332px

export interface TRTableHandle {
    scrollToCell: (colIdx: number, rowIdx: number) => void;
}

interface Props {
    loading: boolean;
    columns: ColumnConfig[];
    documents: MikeDocument[];
    cells: TabularCell[];
    savingColumn: boolean;
    savingColumnsConfig: boolean;
    selectedDocIds: string[];
    highlightedCell?: { colIdx: number; rowIdx: number } | null;
    onSelectionChange: (ids: string[]) => void;
    onExpand: (cell: TabularCell) => void;
    onCitationClick: (cell: TabularCell, page: number, quote: string) => void;
    onUpdateColumn: (col: ColumnConfig) => void;
    onDeleteColumn: (colIndex: number) => void;
    onAddColumn: () => void;
    onAddDocuments: () => void;
}

export const TRTable = forwardRef<TRTableHandle, Props>(function TRTable(
    {
        loading,
        columns,
        documents,
        cells,
        savingColumn,
        savingColumnsConfig,
        selectedDocIds,
        highlightedCell,
        onSelectionChange,
        onExpand,
        onCitationClick,
        onUpdateColumn,
        onDeleteColumn,
        onAddColumn,
        onAddDocuments,
    },
    ref,
) {
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const sortedColumns = [...columns].sort((a, b) => a.index - b.index);
    const totalContentWidth =
        CHECK_W_PX + DOC_COL_W_PX + sortedColumns.length * DATA_COL_W_PX + 32;

    useImperativeHandle(ref, () => ({
        scrollToCell(colIdx: number, rowIdx: number) {
            const container = scrollContainerRef.current;
            if (!container) return;

            // Vertical: find actual row via DOM (handles variable row heights)
            const allRows = container.querySelectorAll<HTMLElement>(
                ":scope > div.flex.min-w-full",
            );
            const targetRow = allRows[rowIdx];
            if (targetRow) {
                container.scrollTo({
                    top: Math.max(0, targetRow.offsetTop - 40),
                    behavior: "smooth",
                });
            }

            // Horizontal: fixed column widths — center the target column in view
            const targetScrollLeft =
                STICKY_LEFT_PX +
                colIdx * DATA_COL_W_PX -
                container.clientWidth / 2 +
                DATA_COL_W_PX / 2;
            container.scrollLeft = Math.max(0, targetScrollLeft);
        },
    }));

    function getCell(docId: string, colIdx: number) {
        return cells.find(
            (c) => c.document_id === docId && c.column_index === colIdx,
        );
    }

    const allSelected =
        documents.length > 0 &&
        documents.every((d) => selectedDocIds.includes(d.id));
    const someSelected =
        !allSelected && documents.some((d) => selectedDocIds.includes(d.id));

    function toggleAll() {
        if (allSelected) {
            onSelectionChange([]);
        } else {
            onSelectionChange(documents.map((d) => d.id));
        }
    }

    function toggleDoc(id: string) {
        if (selectedDocIds.includes(id)) {
            onSelectionChange(selectedDocIds.filter((x) => x !== id));
        } else {
            onSelectionChange([...selectedDocIds, id]);
        }
    }

    if (loading) {
        return (
            <div className="flex-1 overflow-hidden">
                {/* Header */}
                <div className="flex border-b border-[#C7C7B2]">
                    <div
                        className={`${CHECK_W} border-r border-[#C7C7B2] p-2`}
                    />
                    <div
                        className={`${COL_W} border-r border-[#C7C7B2] p-2 text-xs font-medium text-[#292629]/50`}
                    >
                        Document
                    </div>
                    {Array.from({ length: SKELETON_COLS }).map((_, i) => (
                        <div
                            key={i}
                            className={`${COL_W} border-r border-[#C7C7B2] p-2`}
                        >
                            <div className="h-4 w-28 rounded bg-[#F5F5F5] animate-pulse" />
                        </div>
                    ))}
                    <div className="flex-1" />
                </div>
                {/* Rows */}
                {Array.from({ length: SKELETON_ROWS }).map((_, row) => (
                    <div
                        key={row}
                        className={`flex border-b border-[#C7C7B2]/30 ${row % 2 === 0 ? "bg-white" : "bg-[#F5F5F5]/50"}`}
                    >
                        <div className={`${CHECK_W} p-2`} />
                        <div className={`${COL_W} p-2`}>
                            <div className="h-4 w-32 rounded bg-[#F5F5F5] animate-pulse" />
                        </div>
                        {Array.from({ length: SKELETON_COLS }).map((_, col) => (
                            <div key={col} className={`${COL_W} p-2`}>
                                <div className="h-4 rounded bg-[#F5F5F5] animate-pulse" />
                            </div>
                        ))}
                        <div className="flex-1" />
                    </div>
                ))}
            </div>
        );
    }

    if (columns.length === 0 && documents.length === 0) {
        return (
            <div className="flex flex-1 flex-col overflow-hidden">
                <div className="flex items-center border-b border-[#C7C7B2]">
                    <div className={`${CHECK_W} border-r border-[#C7C7B2]`} />
                    <div
                        className={`${COL_W} border-r border-[#C7C7B2] p-2 text-xs font-medium text-[#292629]/50 select-none`}
                    >
                        Document
                    </div>
                    <div className="flex-1" />
                </div>
                <div className="flex flex-1 flex-col items-start justify-center w-full max-w-xs mx-auto">
                    <Table2 className="h-8 w-8 text-[#292629]/30 mb-4" />
                    <p className="text-3xl font-bold font-sans text-[#292629]">
                        Tabular Review
                    </p>
                    <p className="mt-1 text-xs text-[#292629]/40 text-left">
                        Add columns and documents to get started.
                    </p>
                    <div className="mt-4 flex items-center gap-2">
                        <button
                            onClick={onAddColumn}
                            className="inline-flex items-center gap-1 rounded-full bg-[#292629] px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-[#292629]/90 shadow-md"
                        >
                            + Add Columns
                        </button>
                        <button
                            onClick={onAddDocuments}
                            className="inline-flex items-center gap-1.5 rounded-full border border-[#C7C7B2] bg-white px-3 py-1 text-xs font-medium text-[#292629]/60 hover:bg-[#F5F5F5] transition-colors shadow-sm"
                        >
                            <Plus className="h-3.5 w-3.5" />
                            Add Documents
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-auto" ref={scrollContainerRef}>
            {/* Header */}
            <div
                className="sticky top-0 z-20 flex bg-white h-8"
                style={{ minWidth: totalContentWidth }}
            >
                <div
                    className={`sticky left-0 z-30 ${CHECK_W} bg-white border-b border-r border-[#C7C7B2] flex justify-center items-center select-none`}
                >
                    <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => {
                            if (el) el.indeterminate = someSelected;
                        }}
                        onChange={toggleAll}
                        className="h-2.5 w-2.5 rounded border-[#C7C7B2] cursor-pointer accent-black"
                    />
                </div>
                <div
                    className={`sticky left-8 z-30 ${COL_W} bg-white border-b border-r border-[#C7C7B2] p-2 text-left text-xs font-medium text-[#292629]/50 select-none`}
                >
                    Document
                </div>
                {columns.map((col) => (
                    <div
                        key={col.index}
                        className={`${COL_W} border-b border-r border-[#C7C7B2] p-2 text-left text-xs font-medium text-[#292629]/50 select-none`}
                    >
                        <div className="flex items-center justify-between gap-3">
                            <span className="truncate">{col.name}</span>
                            <TREditColumnMenu
                                column={col}
                                disabled={savingColumn || savingColumnsConfig}
                                onSave={onUpdateColumn}
                                onDelete={onDeleteColumn}
                            />
                        </div>
                    </div>
                ))}
                <div className="flex-1 border-b border-[#C7C7B2] flex items-center justify-start p-2 min-w-8">
                    <button
                        onClick={onAddColumn}
                        disabled={savingColumn || savingColumnsConfig}
                        className="flex items-center justify-center text-[#292629]/40 hover:text-[#292629]/80 transition-colors disabled:text-[#C7C7B2]"
                    >
                        <Plus className="h-4 w-4" />
                    </button>
                </div>
            </div>

            {/* Rows */}
            {documents.map((doc, docIdx) => {
                const rowBg = selectedDocIds.includes(doc.id)
                    ? "bg-[#F5F5F5]"
                    : docIdx % 2 === 0
                      ? "bg-white"
                      : "bg-[#F5F5F5]";
                return (
                    <div
                        key={doc.id}
                        className={`flex ${rowBg}`}
                        style={{ minWidth: totalContentWidth }}
                    >
                        <div
                            className={`sticky left-0 z-[60] ${CHECK_W} border-b border-r border-[#C7C7B2] p-2 flex items-center justify-center ${rowBg}`}
                        >
                            <input
                                type="checkbox"
                                checked={selectedDocIds.includes(doc.id)}
                                onChange={() => toggleDoc(doc.id)}
                                className="h-2.5 w-2.5 shrink-0 rounded border-[#C7C7B2] cursor-pointer accent-black"
                            />
                        </div>
                        <div
                            className={`sticky left-8 z-[60] ${COL_W} border-b border-r border-[#C7C7B2] p-2 text-xs text-[#292629]/90 flex items-center ${rowBg}`}
                        >
                            <span className="line-clamp-1" title={doc.filename}>
                                {doc.filename}
                            </span>
                        </div>
                        {columns.map((col) => {
                            const cell = getCell(doc.id, col.index);
                            const colPos = sortedColumns.findIndex(
                                (c) => c.index === col.index,
                            );
                            const isHighlighted =
                                highlightedCell?.colIdx === colPos &&
                                highlightedCell?.rowIdx === docIdx;
                            return (
                                <div
                                    key={col.index}
                                    className={`${COL_W} border-b border-r border-[#C7C7B2] transition-colors ${isHighlighted ? "bg-blue-200" : ""}`}
                                >
                                    {cell && (
                                        <TabularCellComponent
                                            cell={cell}
                                            column={col}
                                            onExpand={() => onExpand(cell)}
                                            onCitationClick={(page, quote) =>
                                                onCitationClick(
                                                    cell,
                                                    page,
                                                    quote,
                                                )
                                            }
                                        />
                                    )}
                                </div>
                            );
                        })}
                        <div className="flex-1 border-b border-[#C7C7B2] min-h-8 min-w-8" />
                    </div>
                );
            })}
        </div>
    );
});
