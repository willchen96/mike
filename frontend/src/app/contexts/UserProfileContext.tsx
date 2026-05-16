"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
    useCallback,
} from "react";
import { supabase } from "@/app/lib/supabase";
import { useAuth } from "@/app/contexts/AuthContext";
import { getApiKeyStatus, setApiKey } from "@/app/lib/mikeApi";

interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    tabularModel: string;
    hasClaudeKey: boolean;
    hasGeminiKey: boolean;
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
            // Explicit column list (CLEAN-05): the plaintext api-key columns were
            // dropped by migration 0007; SELECT * would now fail on those columns
            // if PostgREST is strict. Explicit selection is defense-in-depth.
            const { data, error } = await supabase
                .from("user_profiles")
                .select("display_name, organisation, tabular_model")
                .eq("user_id", userId)
                .single();

            // Fetch api-key presence via backend (booleans only — browser never
            // sees plaintext or ciphertext per CONTEXT.md).
            let hasClaudeKey = false;
            let hasGeminiKey = false;
            try {
                const status = await getApiKeyStatus();
                hasClaudeKey = status.has_claude;
                hasGeminiKey = status.has_gemini;
            } catch (err) {
                console.warn("[UserProfile] getApiKeyStatus failed; defaulting to false", err);
            }

            if (error) {
                // Set fallback profile data if profile doesn't exist
                setProfile({
                    displayName: null,
                    organisation: null,
                    tabularModel: "gemini-3-flash-preview",
                    hasClaudeKey,
                    hasGeminiKey,
                });
                return;
            }

            // Use fetched data to update profile state
            if (data) {
                // 1. Update local state immediately
                setProfile({
                    displayName: data.display_name as string | null,
                    organisation: (data.organisation as string | null) ?? null,
                    tabularModel:
                        (data.tabular_model as string) || "gemini-3-flash-preview",
                    hasClaudeKey,
                    hasGeminiKey,
                });
            }
        } catch (e) {
            // Set fallback profile data on exception
            setProfile({
                displayName: null,
                organisation: null,
                tabularModel: "gemini-3-flash-preview",
                hasClaudeKey: false,
                hasGeminiKey: false,
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
                const { error } = await supabase
                    .from("user_profiles")
                    .update({
                        display_name: displayName,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("user_id", user.id);

                if (error) {
                    throw error;
                }

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
                const { error } = await supabase
                    .from("user_profiles")
                    .update({
                        organisation,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("user_id", user.id);
                if (error) throw error;
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
            const dbField = field === "tabularModel" ? "tabular_model" : "";
            if (!dbField) return false;
            try {
                const { error } = await supabase
                    .from("user_profiles")
                    .update({
                        [dbField]: value,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("user_id", user.id);
                if (error) throw error;
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
            const normalized = value?.trim() ? value.trim() : null;
            const stateField =
                provider === "claude" ? "hasClaudeKey" : "hasGeminiKey";
            try {
                await setApiKey(provider, normalized);
                setProfile((prev) =>
                    prev
                        ? { ...prev, [stateField]: normalized !== null }
                        : null,
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
