"use client";

import React, {
    createContext,
    useContext,
    useState,
    ReactNode,
} from "react";
import { authClient } from "@/lib/auth-client";

interface User {
    id: string;
    email: string;
}

interface AuthContextType {
    user: User | null;
    isAuthenticated: boolean;
    authLoading: boolean;
    signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
    const { data, isPending } = authClient.useSession();
    const sessionUser = data?.user
        ? {
              id: data.user.id,
              email: data.user.email || "",
          }
        : null;
    const [signedOut, setSignedOut] = useState(false);
    const user = signedOut ? null : sessionUser;

    const signOut = async () => {
        await authClient.signOut();
        setSignedOut(true);
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                isAuthenticated: !!user,
                authLoading: isPending,
                signOut,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
