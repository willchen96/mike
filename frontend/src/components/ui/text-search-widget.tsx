import { Input } from "@/components/ui/input";
import { ArrowUp, ArrowDown, X } from "lucide-react";
import { useRef } from "react";

interface TextSearchWidgetProps {
    isOpen: boolean;
    onClose: () => void;
    searchQuery: string;
    onSearchChange: (query: string) => void;
    currentMatchIdx: number;
    matchCount: number;
    setCurrentMatchIdx: (idx: number | ((prev: number) => number)) => void;
    className?: string;
}

export function TextSearchWidget({
    isOpen,
    onClose,
    searchQuery,
    onSearchChange,
    currentMatchIdx,
    matchCount,
    setCurrentMatchIdx,
    className = "",
}: TextSearchWidgetProps) {
    const searchInputRef = useRef<HTMLInputElement>(null);

    const handleNext = () => {
        if (matchCount === 0) return;
        setCurrentMatchIdx((prev) => (prev + 1) % matchCount);
    };

    const handlePrev = () => {
        if (matchCount === 0) return;
        setCurrentMatchIdx((prev) => (prev - 1 + matchCount) % matchCount);
    };

    if (!isOpen) return null;

    return (
        <div
            className={`flex flex-col bg-white shadow-lg border border-[#C7C7B2] rounded-md overflow-hidden min-w-[300px] ${className}`}
        >
            <div className="flex items-center gap-1 p-1">
                <div className="flex-1 relative">
                    <Input
                        ref={searchInputRef}
                        autoFocus
                        placeholder="Find"
                        value={searchQuery}
                        onChange={(e) => onSearchChange(e.target.value)}
                        className="h-8 text-sm w-full pr-[80px] rounded-sm border-[#C7C7B2] bg-[#F5F5F5] focus-visible:ring-0 focus-visible:border-[#898344] placeholder:text-[#292629]/50"
                        onKeyDown={(e) => {
                            if (e.key === "Escape") {
                                onClose();
                                onSearchChange("");
                            } else if (e.key === "Enter") {
                                if (e.shiftKey) handlePrev();
                                else handleNext();
                            }
                        }}
                    />
                </div>
            </div>

            {/* Results count and navigation */}
            {searchQuery && (
                <div className="flex items-center justify-between px-2 pb-1 pt-0.5 text-xs text-[#292629]/50">
                    <span>
                        {matchCount > 0
                            ? `${currentMatchIdx + 1} of ${matchCount}`
                            : "No results"}
                    </span>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={handlePrev}
                            disabled={matchCount === 0}
                            className="p-1 hover:bg-[#F5F5F5] rounded disabled:opacity-50"
                        >
                            <ArrowUp className="h-4 w-4" />
                        </button>
                        <button
                            onClick={handleNext}
                            disabled={matchCount === 0}
                            className="p-1 hover:bg-[#F5F5F5] rounded disabled:opacity-50"
                        >
                            <ArrowDown className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
