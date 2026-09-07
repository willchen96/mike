"use client";

import { useEffect, useId, useState } from "react";
import { Building2, Loader2 } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { Input } from "@/app/components/ui/input";
import { FieldLabel } from "@/app/components/ui/form-field";
import { authInputClassName } from "./authStyles";
import {
    getAuthConfiguration,
    startSso,
    type AuthConfiguration,
} from "@/app/lib/authApi";
import { knownErrorCodeMessage } from "@/app/lib/userFacingError";

interface SsoAuthButtonProps {
    onError: (message: string) => void;
    disabled?: boolean;
    onLoadingChange?: (loading: boolean) => void;
}

export function SsoAuthButton({
    onError,
    disabled = false,
    onLoadingChange,
}: SsoAuthButtonProps) {
    const domainId = useId();
    const [config, setConfig] = useState<AuthConfiguration | null>(null);
    const [domain, setDomain] = useState("");
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void getAuthConfiguration()
            .then((value) => {
                if (!cancelled) setConfig(value);
            })
            .catch(() => {
                // Optional sign-in method: leave existing login available on failure.
            });
        return () => {
            cancelled = true;
        };
    }, []);

    if (!config?.ssoEnabled) return null;

    const handleSso = async () => {
        setLoading(true);
        onLoadingChange?.(true);
        onError("");
        try {
            const { url } = await startSso(
                "/onboarding/profile",
                config.ssoDomainRequired ? domain.trim() : undefined,
            );
            window.location.assign(url);
        } catch (error) {
            onError(
                knownErrorCodeMessage(
                    error,
                    {
                        invalid_request: "Enter a domain such as example.com.",
                        sso_domain_required:
                            "Enter your organization's domain.",
                        sso_domain_not_allowed:
                            "Single sign-on is not available for this domain.",
                        sso_disabled: "Single sign-on is not enabled.",
                        sso_unavailable:
                            "Unable to start single sign-on for this domain.",
                    },
                    "Unable to start single sign-on. Please try again.",
                ),
            );
            setLoading(false);
            onLoadingChange?.(false);
        }
    };

    return (
        <div className="space-y-3">
            {config.ssoDomainRequired && (
                <div>
                    <FieldLabel htmlFor={domainId}>
                        Organization domain
                    </FieldLabel>
                    <Input
                        id={domainId}
                        type="text"
                        placeholder="example.com"
                        autoCapitalize="none"
                        spellCheck={false}
                        value={domain}
                        onChange={(event) => setDomain(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                if (domain.trim() && !disabled && !loading)
                                    void handleSso();
                            }
                        }}
                        disabled={disabled || loading}
                        className={authInputClassName}
                    />
                </div>
            )}
            <PillButton
                type="button"
                tone="white"
                size="normal"
                className="w-full"
                disabled={
                    disabled ||
                    loading ||
                    (config.ssoDomainRequired && !domain.trim())
                }
                aria-busy={loading}
                onClick={() => void handleSso()}
            >
                {loading ? (
                    <Loader2
                        aria-hidden="true"
                        className="h-4 w-4 animate-spin"
                    />
                ) : (
                    <Building2 aria-hidden="true" className="h-4 w-4" />
                )}
                {loading ? "Continuing…" : config.ssoButtonLabel}
            </PillButton>
        </div>
    );
}
