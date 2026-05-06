"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export function PreResponseWrapper({
    children,
    stepCount,
    shouldMinimize,
    isStreaming,
    compact = false,
}: {
    children: React.ReactNode;
    stepCount: number;
    shouldMinimize: boolean;
    isStreaming: boolean;
    /** Tighter typography + child gap for narrow side panels (e.g. TR chat). */
    compact?: boolean;
}) {
    const [userToggled, setUserToggled] = useState(false);
    const [isOpen, setIsOpen] = useState(!shouldMinimize);
    // Once content has streamed in (shouldMinimize=true even once), stay
    // minimized even if a later render briefly evaluates shouldMinimize=false.
    // Without this latch, the wrapper visibly pops open when isStreaming
    // flips off at the end of the response.
    const hasMinimizedRef = useRef(shouldMinimize);

    useEffect(() => {
        if (shouldMinimize) hasMinimizedRef.current = true;
        if (userToggled) return;
        setIsOpen(!shouldMinimize && !hasMinimizedRef.current);
    }, [shouldMinimize, userToggled]);

    const stepWord = `step${stepCount === 1 ? "" : "s"}`;
    const label = isStreaming
        ? "Working"
        : `Completed in ${stepCount} ${stepWord}`;

    const buttonTextClass = compact ? "text-xs" : "text-sm";
    const childrenGapClass = compact ? "gap-2.5" : "gap-4";

    return (
        <div className="border border-[#C7C7B2] rounded-lg px-3 py-2">
            <button
                type="button"
                onClick={() => {
                    setUserToggled(true);
                    setIsOpen((v) => !v);
                }}
                className={`w-full flex items-center justify-between font-sans text-[#292629]/50 hover:text-[#292629]/80 transition-colors ${buttonTextClass}`}
            >
                <span className="flex items-baseline min-w-0">
                    <span className="truncate">{label}</span>
                    {isStreaming && (
                        <span className="inline-flex ml-1 shrink-0 items-baseline">
                            <span className="w-0.5 h-0.5 rounded-full bg-[#C7C7B2] mr-0.5 animate-[bounce_1.4s_infinite_0s]" />
                            <span className="w-0.5 h-0.5 rounded-full bg-[#C7C7B2] mr-0.5 animate-[bounce_1.4s_infinite_0.2s]" />
                            <span className="w-0.5 h-0.5 rounded-full bg-[#C7C7B2] animate-[bounce_1.4s_infinite_0.4s]" />
                        </span>
                    )}
                </span>
                <ChevronDown
                    size={12}
                    className={`shrink-0 ml-2 transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
                />
            </button>
            {isOpen && (
                <div className={`mt-3 flex flex-col ${childrenGapClass}`}>
                    {children}
                </div>
            )}
        </div>
    );
}
