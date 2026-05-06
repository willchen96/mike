import type { ColumnConfig } from "../shared/types";

export type PillSegment =
    | { type: "text"; content: string }
    | { type: "pill"; content: string };

/** Sequential colors assigned to tags by their position in the tags array. */
export const TAG_COLORS = [
    "bg-blue-100 text-[#536049]",
    "bg-violet-100 text-violet-700",
    "bg-pink-100 text-pink-700",
    "bg-orange-100 text-orange-700",
    "bg-teal-100 text-teal-700",
    "bg-amber-100 text-amber-700",
    "bg-indigo-100 text-indigo-700",
    "bg-rose-100 text-rose-700",
];

const CURRENCY_COLORS: Record<string, string> = {
    USD: "bg-green-100 text-green-700",
    EUR: "bg-blue-100 text-[#536049]",
    GBP: "bg-purple-100 text-purple-700",
    JPY: "bg-red-100 text-red-700",
    CHF: "bg-orange-100 text-orange-700",
    AUD: "bg-cyan-100 text-cyan-700",
    CAD: "bg-teal-100 text-teal-700",
    SGD: "bg-pink-100 text-pink-700",
    HKD: "bg-rose-100 text-rose-700",
    NZD: "bg-lime-100 text-lime-700",
    CNY: "bg-amber-100 text-amber-700",
};

export function getPillClass(content: string, column?: ColumnConfig): string {
    if (column?.format === "yes_no") {
        const lower = content.toLowerCase();
        if (lower === "yes") return "bg-green-100 text-green-700";
        if (lower === "no") return "bg-red-100 text-red-700";
        return "bg-[#F5F5F5] text-[#292629]/80";
    }
    if (column?.format === "currency") {
        return (
            CURRENCY_COLORS[content.toUpperCase()] ??
            "bg-slate-100 text-slate-700"
        );
    }
    if (column?.format === "tag" && column.tags?.length) {
        const idx = column.tags.findIndex(
            (t) => t.toLowerCase() === content.toLowerCase(),
        );
        if (idx >= 0) return TAG_COLORS[idx % TAG_COLORS.length]!;
    }
    return "bg-[#F5F5F5] text-[#292629]/80";
}

/** Split text on [[...]] pill markers, preserving surrounding text. */
export function parsePills(text: string): PillSegment[] {
    const segments: PillSegment[] = [];
    const regex = /\[\[([^\]]+)\]\]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
        }
        segments.push({ type: "pill", content: match[1] });
        lastIndex = regex.lastIndex;
    }
    if (lastIndex < text.length) {
        segments.push({ type: "text", content: text.slice(lastIndex) });
    }
    return segments;
}
