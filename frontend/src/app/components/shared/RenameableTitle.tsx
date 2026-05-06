"use client";

import { useRef, useState } from "react";

interface Props {
    value: string;
    onCommit: (newValue: string) => void;
    suffix?: React.ReactNode;
}

export function RenameableTitle({ value, onCommit, suffix }: Props) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const caretPos = useRef<number | null>(null);
    const escaped = useRef(false);

    function startEditing(e: React.MouseEvent) {
        const doc = document as any;
        const caret = doc.caretPositionFromPoint?.(e.clientX, e.clientY);
        const range = !caret && doc.caretRangeFromPoint?.(e.clientX, e.clientY);
        caretPos.current = caret ? caret.offset : range ? range.startOffset : null;
        escaped.current = false;
        setDraft(value);
        setEditing(true);
    }

    function commit() {
        if (escaped.current) {
            escaped.current = false;
            return;
        }
        setEditing(false);
        onCommit(draft.trim());
    }

    if (editing) {
        return (
            <input
                ref={(el) => {
                    if (!el) return;
                    el.focus();
                    if (caretPos.current !== null) {
                        el.setSelectionRange(caretPos.current, caretPos.current);
                    }
                }}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                    if (e.key === "Escape") {
                        escaped.current = true;
                        setEditing(false);
                    }
                }}
                onBlur={commit}
                className="text-[#292629] bg-transparent outline-none min-w-0"
                style={{ width: `${draft.length + 1}ch` }}
            />
        );
    }

    return (
        <span
            className="text-[#292629] cursor-text hover:text-[#292629]/60 transition-colors"
            onClick={startEditing}
        >
            {value}
            {suffix}
        </span>
    );
}
