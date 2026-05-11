"use client";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { createWorkflow } from "@/app/lib/mikeApi";
import {
    WorkflowFileError,
    readWorkflowFile,
} from "@/app/lib/workflowFile";
import type { MikeWorkflow } from "../shared/types";

interface Props {
    onUploaded: (workflow: MikeWorkflow) => void;
}

export function UploadWorkflowButton({ onUploaded }: Props) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function handleClick() {
        setError(null);
        inputRef.current?.click();
    }

    async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = ""; // allow re-upload of the same file
        if (!file) return;
        setBusy(true);
        setError(null);
        try {
            const envelope = await readWorkflowFile(file);
            const created = await createWorkflow({
                title: envelope.title,
                type: envelope.type,
                practice: envelope.practice,
                prompt_md: envelope.prompt_md ?? undefined,
                columns_config: envelope.columns_config ?? undefined,
            });
            onUploaded(created);
        } catch (err) {
            const message =
                err instanceof WorkflowFileError
                    ? err.message
                    : err instanceof Error && err.message
                      ? err.message
                      : "Failed to upload workflow.";
            setError(message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="relative flex items-center">
            <input
                ref={inputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleChange}
            />
            <button
                onClick={handleClick}
                disabled={busy}
                aria-label="Upload workflow"
                title="Upload workflow"
                className="flex items-center justify-center p-1.5 text-gray-500 hover:text-gray-900 transition-colors disabled:opacity-40"
            >
                <Upload className="h-4 w-4" />
            </button>
            {error && (
                <span
                    className="ml-2 max-w-[280px] truncate text-xs text-red-500"
                    title={error}
                >
                    {error}
                </span>
            )}
        </div>
    );
}
