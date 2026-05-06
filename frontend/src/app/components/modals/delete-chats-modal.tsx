"use client";

import { Button } from "@/components/ui/button";
import { X, Check } from "lucide-react";

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
    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-[#292629]/50 z-199"
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
                                <h2 className="text-3xl font-light font-sans text-[#292629] mb-2">
                                    All Chats Deleted
                                </h2>
                                <p className="text-[#292629]/60 text-sm">
                                    Your chat history has been successfully
                                    deleted.
                                </p>
                            </div>
                        </>
                    ) : (
                        <>
                            {/* Header */}
                            <div className="flex items-center justify-between mb-6">
                                <h2 className="text-4xl font-light font-sans text-red-700">
                                    Delete All Chats
                                </h2>
                            </div>

                            {/* Content */}
                            <div className="space-y-4">
                                <p className="text-[#292629]/60 text-sm leading-relaxed">
                                    Are you sure you want to delete all{" "}
                                    {chatCount} chat
                                    {chatCount !== 1 ? "s" : ""}? This action is
                                    permanent and cannot be undone.
                                </p>

                                <div className="space-y-3 pt-4">
                                    <Button
                                        onClick={onConfirm}
                                        disabled={isDeleting}
                                        variant="destructive"
                                        className="w-full bg-red-600 hover:bg-red-700 text-white"
                                    >
                                        {isDeleting
                                            ? "Deleting..."
                                            : "Delete All Chats"}
                                    </Button>
                                    <Button
                                        onClick={onClose}
                                        variant="outline"
                                        disabled={isDeleting}
                                        className="w-full border-[#C7C7B2] text-[#292629]/80 hover:bg-[#F5F5F5]"
                                    >
                                        Cancel
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
