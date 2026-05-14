"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Eye, EyeOff, FolderMinus, Hash, History, Pencil, Trash2, Upload } from "lucide-react";

interface Props {
    onDelete?: () => void;
    onHide?: () => void;
    onUnhide?: () => void;
    onDownload?: () => void;
    onRemoveFromFolder?: () => void;
    onShowAllVersions?: () => void;
    onUploadNewVersion?: () => void;
    deleting?: boolean;
    onRename?: () => void;
    onUpdateCmNumber?: () => void;
}

export function RowActions({ onDelete, onHide, onUnhide, onDownload, onRemoveFromFolder, onShowAllVersions, onUploadNewVersion, deleting, onRename, onUpdateCmNumber }: Props) {
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

    function handleToggle(e: React.MouseEvent) {
        e.stopPropagation();
        if (!open && btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect();
            setCoords({
                top: rect.bottom + 4,
                right: window.innerWidth - rect.right,
            });
        }
        setOpen((o) => !o);
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
                    className="z-50 w-48 rounded-xl border border-gray-100 bg-white shadow-lg overflow-hidden"
                    onClick={(e) => e.stopPropagation()}
                >
                    {onRename && (
                        <button
                            onClick={() => { setOpen(false); onRename(); }}
                            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                            <Pencil className="h-3.5 w-3.5" />
                            Rename
                        </button>
                    )}
                    {onUpdateCmNumber && (
                        <button
                            onClick={() => { setOpen(false); onUpdateCmNumber(); }}
                            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                            <Hash className="h-3.5 w-3.5" />
                            Edit CM No.
                        </button>
                    )}
                    {onDownload && (
                        <button
                            onClick={() => { setOpen(false); onDownload(); }}
                            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                            <Download className="h-3.5 w-3.5" />
                            Download
                        </button>
                    )}
                    {onShowAllVersions && (
                        <button
                            onClick={() => { setOpen(false); onShowAllVersions(); }}
                            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                            <History className="h-3.5 w-3.5 shrink-0" />
                            Show all versions
                        </button>
                    )}
                    {onUploadNewVersion && (
                        <button
                            onClick={() => { setOpen(false); onUploadNewVersion(); }}
                            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                            <Upload className="h-3.5 w-3.5 shrink-0" />
                            Upload new version
                        </button>
                    )}
                    {onRemoveFromFolder && (
                        <button
                            onClick={() => { setOpen(false); onRemoveFromFolder(); }}
                            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                            <FolderMinus className="h-3.5 w-3.5 shrink-0" />
                            Remove from subfolder
                        </button>
                    )}
                    {onUnhide && (
                        <button
                            onClick={() => { setOpen(false); onUnhide(); }}
                            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                            <Eye className="h-3.5 w-3.5" />
                            Unhide
                        </button>
                    )}
                    {onHide && (
                        <button
                            onClick={() => { setOpen(false); onHide(); }}
                            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                            <EyeOff className="h-3.5 w-3.5" />
                            Hide
                        </button>
                    )}
                    {onDelete && (
                        <button
                            onClick={() => { setOpen(false); onDelete(); }}
                            disabled={deleting}
                            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete
                        </button>
                    )}
                </div>
            )}
        </>
    );
}
