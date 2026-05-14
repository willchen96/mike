"use client";

import { AuthProvider } from "@/app/contexts/AuthContext";
import { ManifestsProvider } from "@/app/contexts/ManifestsContext";
import { UserProfileProvider } from "@/app/contexts/UserProfileContext";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <AuthProvider>
            <ManifestsProvider>
                <UserProfileProvider>
                    {children}
                </UserProfileProvider>
            </ManifestsProvider>
        </AuthProvider>
    );
}
