"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Upload } from "lucide-react";
import { listDocumentVersions } from "@/app/lib/mikeApi";
import type { MikeDocument } from "./types";
import { useTranslations } from "next-intl";

interface Props {
    open: boolean;
    onClose: () => void;
    doc: MikeDocument | null;
    onSubmit: (file: File, displayName: string) => Promise<void>;
}

export function UploadNewVersionModal({ open, onClose, doc, onSubmit }: Props) {
    const [name, setName] = useState("");
    const [stagedFile, setStagedFile] = useState<File | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [currentVersion, setCurrentVersion] = useState<number | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const t = useTranslations("modals.novaVersao");

    useEffect(() => {
        if (!open || !doc) return;
        setName(doc.filename);
        setStagedFile(null);
        setSubmitting(false);
        setCurrentVersion(null);
        let cancelled = false;
        (async () => {
            try {
                const { current_version_id, versions } =
                    await listDocumentVersions(doc.id);
                const current = versions.find(
                    (v) => v.id === current_version_id,
                );
                const initial =
                    (current?.display_name && current.display_name.trim()) ||
                    doc.filename;
                if (!cancelled) {
                    setName(initial);
                    setCurrentVersion(current?.version_number ?? null);
                }
            } catch {
                /* keep fallback */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, doc]);

    if (!open || !doc) return null;

    const accept = doc.file_type === "pdf" ? ".pdf" : ".docx,.doc";

    function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0] ?? null;
        setStagedFile(file);
        if (fileInputRef.current) fileInputRef.current.value = "";
    }

    async function handleSubmit() {
        if (!stagedFile || submitting || !doc) return;
        const finalName = name.trim() || doc.filename;
        setSubmitting(true);
        try {
            await onSubmit(stagedFile, finalName);
            onClose();
        } finally {
            setSubmitting(false);
        }
    }

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/10 backdrop-blur-xs">
            <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4">
                    <div className="text-xs text-gray-400">
                        {t("cabecalho", { filename: doc.filename })}
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Name input */}
                <div className="px-5 pb-4">
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                        {t("labelNome")}
                    </label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t("placeholderNome")}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400"
                    />
                    <div className="mt-2 text-xs text-gray-500">
                        {t("versaoAtual")}{" "}
                        <span className="text-gray-700 font-medium">
                            {currentVersion ?? "—"}
                        </span>
                    </div>
                    {stagedFile && (
                        <div className="mt-2 text-xs text-gray-500 truncate">
                            {t("arquivoNovaVersao")}{" "}
                            <span className="text-gray-700">
                                {stagedFile.name}
                            </span>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-between gap-3">
                    <div>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept={accept}
                            className="hidden"
                            onChange={handleFilePick}
                        />
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={submitting}
                            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                        >
                            <Upload className="h-3.5 w-3.5" />
                            {stagedFile ? t("trocarArquivo") : t("enviarArquivo")}
                        </button>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onClose}
                            className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100"
                        >
                            {t("cancelar")}
                        </button>
                        <button
                            onClick={handleSubmit}
                            disabled={!stagedFile || submitting}
                            className="rounded-lg bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
                        >
                            {submitting ? t("salvando") : t("salvar")}
                        </button>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
}
