"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useDirectoryData } from "../shared/useDirectoryData";
import { ProjectPicker } from "../shared/ProjectPicker";
import { useTranslations } from "next-intl";

interface Props {
    open: boolean;
    onClose: () => void;
}

export function SelectAssistantProjectModal({ open, onClose }: Props) {
    const t = useTranslations("assistant.selecionarProjetoModal");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const router = useRouter();
    const { saveChat } = useChatHistoryContext();
    const { loading, projects } = useDirectoryData(open);

    useEffect(() => {
        if (!open) return;
        setSelectedId(null);
    }, [open]);

    if (!open) return null;

    async function handleContinue() {
        if (!selectedId) return;
        setCreating(true);
        try {
            const chatId = await saveChat(selectedId);
            if (!chatId) return;
            onClose();
            router.push(`/projects/${selectedId}/assistant/chat/${chatId}`);
        } finally {
            setCreating(false);
        }
    }

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/10 backdrop-blur-xs">
            <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl flex flex-col h-[600px]">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4">
                    <div className="flex items-center gap-1.5 text-xs text-gray-400">
                        <span>{t("assistente")}</span>
                        <span>›</span>
                        <span>{t("iniciarConversa")}</span>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <ProjectPicker
                    projects={projects}
                    loading={loading}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                />

                {/* Footer */}
                <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-end gap-2">
                    <button
                        onClick={onClose}
                        className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100"
                    >
                        {t("cancelar")}
                    </button>
                    <button
                        onClick={handleContinue}
                        disabled={!selectedId || creating}
                        className="rounded-lg bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
                    >
                        {creating ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            t("continuar")
                        )}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
