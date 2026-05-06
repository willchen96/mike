"use client";

import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";

interface Props {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
}

export function HeaderSearchBtn({ value, onChange, placeholder = "Search…" }: Props) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
                onChange("");
            }
        }
        if (open) document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [open, onChange]);

    return (
        <div ref={ref} className="relative flex items-center">
            {open ? (
                <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-2 bg-white border border-[#C7C7B2] rounded-lg px-3 py-1.5 shadow-sm z-10 w-72">
                    <Search className="h-3.5 w-3.5 text-[#292629]/40 shrink-0" />
                    <input
                        autoFocus
                        type="text"
                        placeholder={placeholder}
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        className="flex-1 text-sm text-[#292629]/80 placeholder:text-[#292629]/40 outline-none bg-transparent"
                    />
                    <button
                        onClick={() => { setOpen(false); onChange(""); }}
                        className="text-[#292629]/40 hover:text-[#292629]/60"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            ) : (
                <button
                    onClick={() => setOpen(true)}
                    className="flex items-center justify-center p-1.5 text-[#292629]/50 hover:text-[#292629] transition-colors"
                >
                    <Search className="h-4 w-4" />
                </button>
            )}
        </div>
    );
}
