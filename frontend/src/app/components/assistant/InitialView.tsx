"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { AppLogo } from "@/components/chat/app-logo";
import { ChatInput } from "./ChatInput";
import { SelectAssistantProjectModal } from "./SelectAssistantProjectModal";
import type { MikeMessage } from "../shared/types";
import { useTranslations } from "next-intl";

interface InitialViewProps {
    onSubmit: (message: MikeMessage) => void;
}

const ICON_SIZE = 35;
const GAP = 16; // gap-4 = 1rem = 16px

export function InitialView({ onSubmit }: InitialViewProps) {
    const t = useTranslations("assistant");
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const [loaded, setLoaded] = useState(false);
    const [projectModalOpen, setProjectModalOpen] = useState(false);
    const [iconOffset, setIconOffset] = useState(0);
    const [textOffset, setTextOffset] = useState(0);
    const textRef = useRef<HTMLHeadingElement>(null);

    const username =
        profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";

    useLayoutEffect(() => {
        if (!profile || !textRef.current) return;
        const h1Width = textRef.current.offsetWidth;
        setIconOffset((h1Width + GAP) / 2);
        setTextOffset((ICON_SIZE + GAP) / 2);
    }, [profile]);

    useEffect(() => {
        if (!iconOffset) return;
        const t = setTimeout(() => setLoaded(true), 100);
        return () => clearTimeout(t);
    }, [iconOffset]);

    return (
        <div className="flex flex-col h-full w-full px-6">
            <div className="flex-1 flex flex-col items-center justify-center">
                <div className="flex-col items-center w-full max-w-4xl relative px-0 xl:px-8">
                    <div className="mb-10 relative flex items-center justify-center">
                        <div
                            className="absolute h-[35px]"
                            style={{
                                left: "50%",
                                transform: loaded
                                    ? `translateX(calc(-50% - ${iconOffset}px))`
                                    : "translateX(-50%)",
                                transition:
                                    "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                            }}
                        >
                            <AppLogo size={ICON_SIZE} />
                        </div>
                        <h1
                            ref={textRef}
                            className="absolute text-4xl font-serif font-light text-gray-900 whitespace-nowrap"
                            style={{
                                left: "50%",
                                transform: loaded
                                    ? `translateX(calc(-50% + ${textOffset}px))`
                                    : "translateX(-50%)",
                                opacity: loaded ? 1 : 0,
                                transition:
                                    "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 800ms ease-in-out 300ms",
                            }}
                        >
                            {t("initialView.saudacao", { username })}
                        </h1>
                    </div>

                    <ChatInput
                        onSubmit={onSubmit}
                        onCancel={() => {}}
                        isLoading={false}
                        onProjectsClick={() => setProjectModalOpen(true)}
                    />

                    <div className="text-center">
                        <p className="text-xs py-3 mb-3 text-gray-500">
                            {t("avisoIA")}
                        </p>
                    </div>
                </div>
            </div>

            <SelectAssistantProjectModal
                open={projectModalOpen}
                onClose={() => setProjectModalOpen(false)}
            />
        </div>
    );
}
