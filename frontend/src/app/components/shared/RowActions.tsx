"use client";

import { useEffect, useRef, useState } from "react";
import {
    Download,
    Eye,
    EyeOff,
    FolderMinus,
    FolderPlus,
    Hash,
    History,
    Pencil,
    Trash2,
    Upload,
} from "lucide-react";
import { useTranslations } from "next-intl";

const CLOSE_ROW_ACTIONS_EVENT = "mike:close-row-actions";

export function closeRowActionMenus() {
    document.dispatchEvent(new Event(CLOSE_ROW_ACTIONS_EVENT));
}

interface Props {
    onDelete?: () => void;
    onHide?: () => void;
    onUnhide?: () => void;
    onDownload?: () => void;
    onRemoveFromFolder?: () => void;
    onShowAllVersions?: () => void;
    onUploadNewVersion?: () => void;
    onNewSubfolder?: () => void;
    deleting?: boolean;
    onRename?: () => void;
    onUpdateCmNumber?: () => void;
    newSubfolderLabel?: string;
    renameLabel?: string;
    deleteLabel?: string;
}

export function RowActionMenuItems({
    onDelete,
    onHide,
    onUnhide,
    onDownload,
    onRemoveFromFolder,
    onShowAllVersions,
    onUploadNewVersion,
    onNewSubfolder,
    deleting,
    onRename,
    onUpdateCmNumber,
    newSubfolderLabel,
    renameLabel,
    deleteLabel,
    onClose,
}: Props & { onClose: () => void }) {
    const t = useTranslations("documents.acoes");
    const resolvedNewSubfolderLabel = newSubfolderLabel ?? t("novaSubpasta");
    const resolvedRenameLabel = renameLabel ?? t("renomear");
    const resolvedDeleteLabel = deleteLabel ?? t("excluir");
    return (
        <>
            {onNewSubfolder && (
                <button
                    onClick={() => { onClose(); onNewSubfolder(); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left text-gray-600 hover:bg-gray-50 transition-colors"
                >
                    <FolderPlus className="h-3.5 w-3.5 shrink-0" />
                    {resolvedNewSubfolderLabel}
                </button>
            )}
            {onRename && (
                <button
                    onClick={() => { onClose(); onRename(); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                >
                    <Pencil className="h-3.5 w-3.5" />
                    {resolvedRenameLabel}
                </button>
            )}
            {onUpdateCmNumber && (
                <button
                    onClick={() => { onClose(); onUpdateCmNumber(); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                >
                    <Hash className="h-3.5 w-3.5" />
                    {t("editarReferencia")}
                </button>
            )}
            {onDownload && (
                <button
                    onClick={() => { onClose(); onDownload(); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                >
                    <Download className="h-3.5 w-3.5" />
                    {t("baixar")}
                </button>
            )}
            {onShowAllVersions && (
                <button
                    onClick={() => { onClose(); onShowAllVersions(); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left text-gray-600 hover:bg-gray-50 transition-colors"
                >
                    <History className="h-3.5 w-3.5 shrink-0" />
                    {t("verTodasVersoes")}
                </button>
            )}
            {onUploadNewVersion && (
                <button
                    onClick={() => { onClose(); onUploadNewVersion(); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left text-gray-600 hover:bg-gray-50 transition-colors"
                >
                    <Upload className="h-3.5 w-3.5 shrink-0" />
                    {t("enviarNovaVersao")}
                </button>
            )}
            {onRemoveFromFolder && (
                <button
                    onClick={() => { onClose(); onRemoveFromFolder(); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left text-gray-600 hover:bg-gray-50 transition-colors"
                >
                    <FolderMinus className="h-3.5 w-3.5 shrink-0" />
                    {t("removerSubpasta")}
                </button>
            )}
            {onUnhide && (
                <button
                    onClick={() => { onClose(); onUnhide(); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                >
                    <Eye className="h-3.5 w-3.5" />
                    {t("mostrar")}
                </button>
            )}
            {onHide && (
                <button
                    onClick={() => { onClose(); onHide(); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                >
                    <EyeOff className="h-3.5 w-3.5" />
                    {t("ocultar")}
                </button>
            )}
            {onDelete && (
                <button
                    onClick={() => { onClose(); onDelete(); }}
                    disabled={deleting}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
                >
                    <Trash2 className="h-3.5 w-3.5" />
                    {resolvedDeleteLabel}
                </button>
            )}
        </>
    );
}

export function RowActions(props: Props) {
    const [open, setOpen] = useState(false);
    const [coords, setCoords] = useState({ top: 0, right: 0 });
    const btnRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) return;
        function handleClick() {
            setOpen(false);
        }
        document.addEventListener("click", handleClick);
        return () => document.removeEventListener("click", handleClick);
    }, [open]);

    useEffect(() => {
        function handleCloseRowActions() {
            setOpen(false);
        }
        document.addEventListener(CLOSE_ROW_ACTIONS_EVENT, handleCloseRowActions);
        return () =>
            document.removeEventListener(
                CLOSE_ROW_ACTIONS_EVENT,
                handleCloseRowActions,
            );
    }, []);

    function handleToggle(e: React.MouseEvent) {
        e.stopPropagation();
        if (open) {
            setOpen(false);
            return;
        }
        closeRowActionMenus();
        if (btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect();
            setCoords({
                top: rect.bottom + 4,
                right: window.innerWidth - rect.right,
            });
        }
        setOpen(true);
    }

    return (
        <>
            <button
                ref={btnRef}
                onClick={handleToggle}
                className="flex items-center justify-center w-6 h-6 rounded text-gray-700 hover:text-gray-900 hover:bg-gray-100 transition-colors leading-none"
            >
                <span className="tracking-widest text-xs">···</span>
            </button>

            {open && (
                <div
                    style={{ position: "fixed", top: coords.top, right: coords.right }}
                    className="z-[120] w-48 rounded-xl border border-gray-100 bg-white shadow-lg overflow-hidden"
                    onClick={(e) => e.stopPropagation()}
                >
                    <RowActionMenuItems
                        {...props}
                        onClose={() => setOpen(false)}
                    />
                </div>
            )}
        </>
    );
}
