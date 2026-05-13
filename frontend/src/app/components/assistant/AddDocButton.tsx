"use client";

import { useRef, useState } from "react";
import { PlusIcon, Upload, LayoutGridIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { uploadStandaloneDocument } from "@/app/lib/mikeApi";
import type { MikeDocument } from "../shared/types";

interface Props {
    onSelectDoc: (doc: MikeDocument) => void;
    onBrowseAll: () => void;
    selectedDocIds?: string[];
}

export function AddDocButton({ onSelectDoc, onBrowseAll, selectedDocIds = [] }: Props) {
    const t = useTranslations("shared.addDocButton");
    const [isOpen, setIsOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        setUploading(true);
        try {
            const uploaded = await Promise.all(
                files.map((f) => uploadStandaloneDocument(f)),
            );
            uploaded.forEach((doc) => onSelectDoc(doc));
        } catch (err) {
            console.error("Upload failed:", err);
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    return (
        <>
            <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.doc"
                multiple
                className="hidden"
                onChange={handleUpload}
            />
            <DropdownMenu onOpenChange={setIsOpen}>
                <DropdownMenuTrigger asChild>
                    <button
                        className={`flex items-center gap-1 px-2 h-8 rounded-lg text-sm transition-colors cursor-pointer ${
                            selectedDocIds.length > 0
                                ? "text-black hover:bg-gray-100"
                                : "text-gray-400 hover:text-gray-700 hover:bg-gray-100"
                        } ${isOpen ? "bg-gray-100" : ""}`}
                        title={t("adicionarDocumentos")}
                        aria-label={t("adicionarDocumentos")}
                    >
                        {selectedDocIds.length > 0 ? (
                            <span className="font-medium tabular-nums">{selectedDocIds.length}</span>
                        ) : (
                            <PlusIcon
                                className={`h-4 w-4 shrink-0 transition-transform duration-300 ${isOpen ? "rotate-[135deg]" : ""}`}
                            />
                        )}
                        <span className="hidden sm:inline">
                            {selectedDocIds.length === 1
                                ? t("documento")
                                : t("documentos")}
                        </span>
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    className="w-44 z-50"
                    side="bottom"
                    align="start"
                >
                    <DropdownMenuItem
                        className="cursor-pointer"
                        disabled={uploading}
                        onSelect={(e) => {
                            e.preventDefault();
                            fileInputRef.current?.click();
                        }}
                    >
                        {uploading ? (
                            <Loader2Icon className="h-4 w-4 mr-2 animate-spin text-gray-400" />
                        ) : (
                            <Upload className="h-4 w-4 mr-2 text-gray-500" />
                        )}
                        <span className="text-sm">
                            {uploading ? t("enviando") : t("enviarArquivos")}
                        </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        className="cursor-pointer"
                        onClick={onBrowseAll}
                    >
                        <LayoutGridIcon className="h-4 w-4 mr-2 text-gray-500" />
                        <span className="text-sm">{t("explorarTodos")}</span>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </>
    );
}
