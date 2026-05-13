"use client";

import { Button } from "@/components/ui/button";
import { X, Check } from "lucide-react";
import { useTranslations } from "next-intl";

interface DeleteChatsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    chatCount: number;
    isDeleting: boolean;
    isSuccess?: boolean;
}

export function DeleteChatsModal({
    isOpen,
    onClose,
    onConfirm,
    chatCount,
    isDeleting,
    isSuccess = false,
}: DeleteChatsModalProps) {
    const t = useTranslations("modals.excluirConversas");
    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/50 z-199"
                onClick={isDeleting || isSuccess ? undefined : onClose}
            />

            {/* Modal */}
            <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-200 w-full max-w-md">
                <div className="bg-white rounded-2xl shadow-2xl p-8">
                    {isSuccess ? (
                        <>
                            {/* Success State */}
                            <div className="text-center">
                                <div className="mx-auto w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
                                    <Check className="h-8 w-8 text-green-600" />
                                </div>
                                <h2 className="text-3xl font-light font-eb-garamond text-gray-900 mb-2">
                                    {t("tituloSucesso")}
                                </h2>
                                <p className="text-gray-600 text-sm">
                                    {t("mensagemSucesso")}
                                </p>
                            </div>
                        </>
                    ) : (
                        <>
                            {/* Header */}
                            <div className="flex items-center justify-between mb-6">
                                <h2 className="text-4xl font-light font-eb-garamond text-red-700">
                                    {t("titulo")}
                                </h2>
                            </div>

                            {/* Content */}
                            <div className="space-y-4">
                                <p className="text-gray-600 text-sm leading-relaxed">
                                    {t("confirmacaoAntes")}{" "}
                                    {chatCount}{" "}
                                    {chatCount !== 1 ? t("confirmacaoConversas") : t("confirmacaoConversa")}
                                    {t("confirmacaoDepois")}
                                </p>

                                <div className="space-y-3 pt-4">
                                    <Button
                                        onClick={onConfirm}
                                        disabled={isDeleting}
                                        variant="destructive"
                                        className="w-full bg-red-600 hover:bg-red-700 text-white"
                                    >
                                        {isDeleting ? t("excluindo") : t("excluir")}
                                    </Button>
                                    <Button
                                        onClick={onClose}
                                        variant="outline"
                                        disabled={isDeleting}
                                        className="w-full border-gray-300 text-gray-700 hover:bg-gray-50"
                                    >
                                        {t("cancelar")}
                                    </Button>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </>
    );
}
