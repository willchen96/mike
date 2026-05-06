/**
 * Small "V3" badge for document rows/listings, rendered when the doc has
 * at least one assistant-edit version. Matches the chip in the side
 * panel's edit-tab header.
 */
export function VersionChip({ n }: { n: number | null | undefined }) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 1) return null;
    return (
        <span className="shrink-0 inline-flex items-center rounded-md border border-[#C7C7B2] bg-white px-1 py-0.5 text-[10px] font-medium text-[#292629]/50">
            V{n}
        </span>
    );
}
