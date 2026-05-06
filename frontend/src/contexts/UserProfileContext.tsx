"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
    useCallback,
} from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { getUserProfile, updateUserProfile } from "@/app/lib/mikeApi";

interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    tabularModel: string;
    claudeApiKey: string | null;
    geminiApiKey: string | null;
}

interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    updateDisplayName: (name: string) => Promise<boolean>;
    updateOrganisation: (organisation: string) => Promise<boolean>;
    updateModelPreference: (
        field: "tabularModel",
        value: string,
    ) => Promise<boolean>;
    updateApiKey: (
        provider: "claude" | "gemini",
        value: string | null,
    ) => Promise<boolean>;
    reloadProfile: () => Promise<void>;
    incrementMessageCredits: () => Promise<boolean>;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);

export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated } = useAuth();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);

    const loadProfile = useCallback(async (userId: string) => {
        try {
            const data = await getUserProfile();

            // Define credit limit constant
            const MONTHLY_CREDIT_LIMIT = 999999; // temporarily unlimited

            // Calculate a default future reset date (30 days from now)
            const futureResetDate = new Date();
            futureResetDate.setDate(futureResetDate.getDate() + 30);
            const defaultResetDateStr = futureResetDate.toISOString();

            if (!data) {
                setProfile({
                    displayName: null,
                    organisation: null,
                    messageCreditsUsed: 0,
                    creditsResetDate: defaultResetDateStr,
                    creditsRemaining: MONTHLY_CREDIT_LIMIT,
                    tier: "Free",
                    tabularModel: "gemini-2.5-flash-lite",
                    claudeApiKey: null,
                    geminiApiKey: null,
                });
                return;
            }

            // Use fetched data to update profile state
            let creditsUsed = data.message_credits_used;
            let resetDate = data.credits_reset_date;
            let creditsRemaining = MONTHLY_CREDIT_LIMIT - creditsUsed;
            let shouldUpdateDb = false;

            // Check if credits have expired and need reset
            if (resetDate && new Date() > new Date(resetDate)) {
                // Calculate new reset date
                const newResetDate = new Date();
                newResetDate.setDate(newResetDate.getDate() + 30);
                resetDate = newResetDate.toISOString();
                creditsUsed = 0;
                creditsRemaining = MONTHLY_CREDIT_LIMIT;
                shouldUpdateDb = true;
            }

            // 1. Update local state immediately
            setProfile({
                displayName: data.display_name,
                organisation: data.organisation ?? null,
                messageCreditsUsed: creditsUsed,
                creditsResetDate: resetDate,
                creditsRemaining: creditsRemaining,
                tier: data.tier || "Free",
                tabularModel:
                    data.tabular_model || "gemini-2.5-flash-lite",
                claudeApiKey: data.claude_api_key ?? null,
                geminiApiKey: data.gemini_api_key ?? null,
            });

            // 2. Update database in background if needed
            if (shouldUpdateDb) {
                updateUserProfile({
                    message_credits_used: 0,
                    credits_reset_date: resetDate,
                }).catch((error) => {
                    console.error("Failed to auto-reset credits", error);
                });
            }
        } catch (e) {
            // Calculate a default future reset date for fallback
            const futureResetDate = new Date();
            futureResetDate.setDate(futureResetDate.getDate() + 30);

            // Set fallback profile data on exception
            setProfile({
                displayName: null,
                organisation: null,
                messageCreditsUsed: 0,
                creditsResetDate: futureResetDate.toISOString(),
                creditsRemaining: 999999, // temporarily unlimited
                tier: "Free",
                tabularModel: "gemini-2.5-flash-lite",
                claudeApiKey: null,
                geminiApiKey: null,
            });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated && user) {
            setLoading(true);
            loadProfile(user.id);
        } else {
            setProfile(null);
            setLoading(false);
        }
    }, [isAuthenticated, user, loadProfile]);

    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            if (!user) {
                return false;
            }

            try {
                await updateUserProfile({ display_name: displayName });

                setProfile((prev) => (prev ? { ...prev, displayName } : null));
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            if (!user) return false;
            try {
                await updateUserProfile({ organisation });
                setProfile((prev) =>
                    prev ? { ...prev, organisation } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateModelPreference = useCallback(
        async (
            field: "tabularModel",
            value: string,
        ): Promise<boolean> => {
            if (!user) return false;
            try {
                if (field !== "tabularModel") return false;
                await updateUserProfile({ tabular_model: value });
                setProfile((prev) =>
                    prev ? { ...prev, [field]: value } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateApiKey = useCallback(
        async (
            provider: "claude" | "gemini",
            value: string | null,
        ): Promise<boolean> => {
            if (!user) return false;
            const dbField =
                provider === "claude" ? "claude_api_key" : "gemini_api_key";
            const stateField =
                provider === "claude" ? "claudeApiKey" : "geminiApiKey";
            const normalized = value?.trim() ? value.trim() : null;
            try {
                if (dbField === "claude_api_key") {
                    await updateUserProfile({ claude_api_key: normalized });
                } else {
                    await updateUserProfile({ gemini_api_key: normalized });
                }
                setProfile((prev) =>
                    prev ? { ...prev, [stateField]: normalized } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const reloadProfile = useCallback(async () => {
        if (user) {
            await loadProfile(user.id);
        }
    }, [user, loadProfile]);

    const incrementMessageCredits = useCallback(async (): Promise<boolean> => {
        if (!user || !profile) {
            return false;
        }

        // Check if user has credits remaining
        if (profile.creditsRemaining <= 0) {
            return false;
        }

        try {
            const newCreditsUsed = profile.messageCreditsUsed + 1;

            await updateUserProfile({ message_credits_used: newCreditsUsed });

            // Update local state
            setProfile((prev) =>
                prev
                    ? {
                        ...prev,
                        messageCreditsUsed: newCreditsUsed,
                        creditsRemaining: 999999 - newCreditsUsed, // temporarily unlimited
                    }
                    : null,
            );

            return true;
        } catch (err) {
            return false;
        }
    }, [user, profile]);

    return (
        <UserProfileContext.Provider
            value={{
                profile,
                loading,
                updateDisplayName,
                updateOrganisation,
                updateModelPreference,
                updateApiKey,
                reloadProfile,
                incrementMessageCredits,
            }}
        >
            {children}
        </UserProfileContext.Provider>
    );
}

export function useUserProfile() {
    const context = useContext(UserProfileContext);
    if (context === undefined) {
        throw new Error(
            "useUserProfile must be used within a UserProfileProvider",
        );
    }
    return context;
}
