"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
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
    const t = useTranslations("workflows.compartilharModal");
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
        <div className="fixed inset-0 z-[101] flex items-center justify-center bg-black/20 backdrop-blur-xs">
            <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl flex flex-col h-[600px]">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                    <div className="flex items-center gap-1.5 text-xs text-gray-400">
                        <span>Workflows</span>
                        <span>›</span>
                        <span className="truncate max-w-[220px]">
                            {workflowName}
                        </span>
                        <span>›</span>
                        <span>{t("pessoas")}</span>
                    </div>
                    <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="px-5 py-4 flex flex-col gap-4 flex-1 overflow-y-auto">
                    <EmailPillInput
                        emails={pendingEmails}
                        onChange={setPendingEmails}
                        placeholder={t("placeholderEmail")}
                        autoFocus
                    />

                    {/* Permission toggle */}
                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-medium text-gray-700">{t("permitirEdicao")}</span>
                        <button
                            type="button"
                            onClick={() => setAllowEdit((v) => !v)}
                            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ${allowEdit ? "bg-gray-900" : "bg-gray-200"}`}
                        >
                            <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${allowEdit ? "translate-x-4" : "translate-x-0"}`} />
                        </button>
                    </div>

                    {/* Existing access */}
                    <div>
                        <p className="text-xs font-medium text-gray-700 mb-2">{t("pessoasComAcesso")}</p>
                        {loading ? (
                            <div className="space-y-2">
                                {[1, 2].map((i) => (
                                    <div key={i} className="flex items-center justify-between">
                                        <div className="h-3 w-40 rounded bg-gray-100 animate-pulse" />
                                        <div className="h-3 w-16 rounded bg-gray-100 animate-pulse" />
                                    </div>
                                ))}
                            </div>
                        ) : existingShares.length === 0 ? (
                            <p className="text-sm text-gray-400">{t("nenhuma")}</p>
                        ) : (
                            <div className="space-y-1">
                                {existingShares.map((share) => (
                                    <div key={share.id} className="flex items-center justify-between py-1">
                                        <span className="text-sm text-gray-700 truncate">{share.shared_with_email}</span>
                                        <div className="flex items-center gap-3 shrink-0">
                                            <span className="text-xs text-gray-400">{share.allow_edit ? t("podeEditar") : t("somenteLetura")}</span>
                                            <button
                                                onClick={() => handleRemoveShare(share.id)}
                                                className="text-gray-300 hover:text-red-500 transition-colors"
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
                <div className="border-t border-gray-100 px-5 py-3 flex justify-end gap-2 mt-auto shrink-0">
                    <button
                        onClick={onClose}
                        className="rounded-lg px-5 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
                    >
                        {t("cancelar")}
                    </button>
                    <button
                        onClick={handleConfirm}
                        disabled={saving || pendingEmails.length === 0}
                        className="rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40 transition-colors"
                    >
                        {saving ? t("compartilhando") : t("compartilhar")}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
