"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
    deleteWorkflowShare,
    listWorkflowShares,
    shareWorkflow,
} from "@/app/lib/mikeApi";
import { EmailPillInput } from "../shared/EmailPillInput";

interface Share {
    id: string;
    shared_with_email: string;
    allow_edit: boolean;
    created_at: string;
}

interface Props {
    workflowId: string;
    workflowName: string;
    onClose: () => void;
}

export function ShareWorkflowModal({
    workflowId,
    workflowName,
    onClose,
}: Props) {
    const [pendingEmails, setPendingEmails] = useState<string[]>([]);
    const [allowEdit, setAllowEdit] = useState(false);
    const [existingShares, setExistingShares] = useState<Share[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        listWorkflowShares(workflowId)
            .then(setExistingShares)
            .catch(() => {})
            .finally(() => setLoading(false));
    }, [workflowId]);

    async function handleRemoveShare(shareId: string) {
        await deleteWorkflowShare(workflowId, shareId).catch(() => {});
        setExistingShares((prev) => prev.filter((s) => s.id !== shareId));
    }

    async function handleConfirm() {
        if (pendingEmails.length === 0) return;
        setSaving(true);
        try {
            await shareWorkflow(workflowId, { emails: pendingEmails, allow_edit: allowEdit });
            const updated = await listWorkflowShares(workflowId);
            setExistingShares(updated);
            setPendingEmails([]);
        } catch {
            // ignore
        } finally {
            setSaving(false);
        }
    }

    return createPortal(
        <div className="fixed inset-0 z-[101] flex items-center justify-center bg-[#292629]/20 backdrop-blur-xs">
            <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl flex flex-col h-[600px]">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-[#C7C7B2]/50">
                    <div className="flex items-center gap-1.5 text-xs text-[#292629]/40">
                        <span>Workflows</span>
                        <span>›</span>
                        <span className="truncate max-w-[220px]">
                            {workflowName}
                        </span>
                        <span>›</span>
                        <span>People</span>
                    </div>
                    <button onClick={onClose} className="rounded-lg p-1.5 text-[#292629]/40 hover:bg-[#F5F5F5] hover:text-[#292629]/60">
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="px-5 py-4 flex flex-col gap-4 flex-1 overflow-y-auto">
                    <EmailPillInput
                        emails={pendingEmails}
                        onChange={setPendingEmails}
                        placeholder="Add people by email…"
                        autoFocus
                    />

                    {/* Permission toggle */}
                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-medium text-[#292629]/80">Allow editing by share recipients</span>
                        <button
                            type="button"
                            onClick={() => setAllowEdit((v) => !v)}
                            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ${allowEdit ? "bg-[#292629]" : "bg-[#C7C7B2]/40"}`}
                        >
                            <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${allowEdit ? "translate-x-4" : "translate-x-0"}`} />
                        </button>
                    </div>

                    {/* Existing access */}
                    <div>
                        <p className="text-xs font-medium text-[#292629]/80 mb-2">People with access</p>
                        {loading ? (
                            <div className="space-y-2">
                                {[1, 2].map((i) => (
                                    <div key={i} className="flex items-center justify-between">
                                        <div className="h-3 w-40 rounded bg-[#F5F5F5] animate-pulse" />
                                        <div className="h-3 w-16 rounded bg-[#F5F5F5] animate-pulse" />
                                    </div>
                                ))}
                            </div>
                        ) : existingShares.length === 0 ? (
                            <p className="text-sm text-[#292629]/40">None</p>
                        ) : (
                            <div className="space-y-1">
                                {existingShares.map((share) => (
                                    <div key={share.id} className="flex items-center justify-between py-1">
                                        <span className="text-sm text-[#292629]/80 truncate">{share.shared_with_email}</span>
                                        <div className="flex items-center gap-3 shrink-0">
                                            <span className="text-xs text-[#292629]/40">{share.allow_edit ? "Can edit" : "Read-only"}</span>
                                            <button
                                                onClick={() => handleRemoveShare(share.id)}
                                                className="text-[#292629]/30 hover:text-red-500 transition-colors"
                                            >
                                                <X className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="border-t border-[#C7C7B2]/50 px-5 py-3 flex justify-end gap-2 mt-auto shrink-0">
                    <button
                        onClick={onClose}
                        className="rounded-lg px-5 py-2 text-sm font-medium text-[#292629]/60 hover:bg-[#F5F5F5] transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleConfirm}
                        disabled={saving || pendingEmails.length === 0}
                        className="rounded-lg bg-[#292629] px-5 py-2 text-sm font-medium text-white hover:bg-[#292629]/90 disabled:opacity-40 transition-colors"
                    >
                        {saving ? "Sharing…" : "Share"}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
