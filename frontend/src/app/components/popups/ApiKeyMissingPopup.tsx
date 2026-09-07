"use client";

import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { providerLabel, type ModelProvider } from "@/app/lib/modelAvailability";
import { WarningPopup } from "../popups/WarningPopup";

interface Props {
    open: boolean;
    onClose: () => void;
    provider: ModelProvider | null;
    /** Optional override for the body sentence. */
    message?: string;
    gatewayLabel?: string;
}

export function ApiKeyMissingPopup({ open, onClose, provider, message, gatewayLabel }: Props) {
    const router = useRouter();
    if (!open) return null;

    const providerName = provider ? providerLabel(provider, gatewayLabel) : "this provider";
    const body =
        message ??
        (provider === "gateway"
            ? `${providerName} model is unavailable. Select a configured model or contact your deployment administrator.`
            : `You haven't added a ${providerName} API key yet. Add one in Settings to use this model.`);

    const handleGoToSettings = () => {
        onClose();
        router.push(provider === "gateway" ? "/settings/models" : "/settings/byok");
    };

    return (
        <WarningPopup
            open={open}
            onClose={onClose}
            title={provider === "gateway" ? "Model unavailable" : "API key required"}
            message={body}
            icon={
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
            }
            primaryAction={{
                label: "Go to settings",
                onClick: handleGoToSettings,
            }}
        />
    );
}
