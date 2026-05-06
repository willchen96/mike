"use client";

import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { AlertTriangle, X } from "lucide-react";
import { providerLabel, type ModelProvider } from "@/app/lib/modelAvailability";

interface Props {
    open: boolean;
    onClose: () => void;
    provider: ModelProvider | null;
    /** Optional override for the body sentence. */
    message?: string;
}

export function ApiKeyMissingModal({ open, onClose, provider, message }: Props) {
    const router = useRouter();
    if (!open) return null;

    const providerName = provider ? providerLabel(provider) : "this provider";
    const body =
        message ??
        `You haven't added a ${providerName} API key yet. Add one in your account settings to use this model.`;

    const handleGoToAccount = () => {
        onClose();
        router.push("/account/models");
    };

    return createPortal(
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-[#292629]/10 backdrop-blur-xs"
            onClick={onClose}
        >
            <div
                className="w-full max-w-md rounded-2xl bg-white shadow-2xl flex flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-2">
                    <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-600" />
                        <h2 className="text-base font-medium text-[#292629]">
                            API key required
                        </h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-[#292629]/40 hover:bg-[#F5F5F5] hover:text-[#292629]/60"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="px-5 pb-2 pt-1">
                    <p className="text-sm text-[#292629]/60 leading-relaxed">
                        {body}
                    </p>
                </div>

                <div className="flex justify-end gap-2 px-5 pb-5 pt-3">
                    <button
                        onClick={onClose}
                        className="rounded-lg px-4 py-1.5 text-sm font-medium text-[#292629]/80 hover:bg-[#F5F5F5]"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleGoToAccount}
                        className="rounded-lg bg-[#292629] px-4 py-1.5 text-sm font-medium text-white hover:bg-[#292629]/90"
                    >
                        Go to account settings
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
