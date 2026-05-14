"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Menu } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { ChatHistoryProvider } from "@/app/contexts/ChatHistoryContext";
import { SidebarContext } from "@/app/contexts/SidebarContext";
import { AppSidebar } from "@/app/components/shared/AppSidebar";

export default function MikeLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { isAuthenticated, authLoading } = useAuth();
    const router = useRouter();

    const [isSidebarOpenDesktop, setIsSidebarOpenDesktop] = useState(() => {
        if (typeof window !== "undefined") {
            const saved = localStorage.getItem("sidebarOpen");
            return saved !== null ? saved === "true" : true;
        }
        return true;
    });

    const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
        if (typeof window !== "undefined" && window.innerWidth < 768) {
            return false;
        }
        return true;
    });

    useEffect(() => {
        if (typeof window !== "undefined" && window.innerWidth >= 768) {
            localStorage.setItem("sidebarOpen", isSidebarOpen.toString());
        }
    }, [isSidebarOpenDesktop]);

    useEffect(() => {
        if (typeof window === "undefined") return;
        const handleResize = () => {
            const isSmall = window.innerWidth < 768;
            if (isSmall && isSidebarOpen) setIsSidebarOpen(false);
            else if (!isSmall && !isSidebarOpen)
                setIsSidebarOpen(isSidebarOpenDesktop);
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, [isSidebarOpen, isSidebarOpenDesktop]);

    const handleSidebarToggle = () => {
        if (window.innerWidth >= 768) {
            setIsSidebarOpenDesktop(!isSidebarOpenDesktop);
            setIsSidebarOpen(!isSidebarOpenDesktop);
        } else {
            setIsSidebarOpen(!isSidebarOpen);
        }
    };

    useEffect(() => {
        if (authLoading || isAuthenticated) return;

        // Defer the redirect so that an explicit `router.push` from a
        // sign-out handler (account/page.tsx::handleLogout pushes "/")
        // or a sign-in handler (login/page.tsx::handleLogin pushes
        // "/assistant") has time to navigate away from this layout
        // before we race it to /login.
        //
        // Without this, there's a tight window after signInWithPassword
        // resolves where AuthContext's onAuthStateChange listener hasn't
        // propagated yet — isAuthenticated is still false on the next
        // render, this effect fires, and we get bounced back to /login
        // even though the user is now authenticated.  Same story in
        // reverse for sign-out: isAuthenticated flips to false before
        // handleLogout's router.push("/") starts, and we land on /login
        // instead of the marketing root.
        //
        // 100 ms is plenty for Next.js to commit a route transition.
        // If the component unmounts (user navigated away) or auth state
        // changes again (session refreshed) during the window, the
        // cleanup clears the timer and the redirect never fires.
        const timeoutId = setTimeout(() => {
            router.push("/login");
        }, 100);

        return () => clearTimeout(timeoutId);
    }, [authLoading, isAuthenticated, router]);

    if (authLoading) {
        return (
            <div className="flex h-screen items-center justify-center">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-700" />
            </div>
        );
    }

    if (!isAuthenticated) return null;

    return (
        <ChatHistoryProvider>
            <SidebarContext.Provider
                value={{ setSidebarOpen: (open) => { setIsSidebarOpen(open); setIsSidebarOpenDesktop(open); } }}
            >
                <div className="h-dvh bg-white flex flex-col">
                    <div className="flex-1 flex overflow-hidden">
                        <AppSidebar
                            isOpen={isSidebarOpen}
                            onToggle={handleSidebarToggle}
                        />
                        <div className="flex-1 flex flex-col h-dvh md:overflow-hidden relative w-full">
                            {/* Mobile header */}
                            <div className="flex md:hidden items-center gap-3 px-4 py-3 border-b border-gray-100 shrink-0">
                                <button
                                    onClick={handleSidebarToggle}
                                    className="flex items-center justify-center w-8 h-8 rounded hover:bg-gray-100 text-gray-500 transition-colors"
                                >
                                    <Menu className="h-5 w-5" />
                                </button>
                            </div>
                            <main className="flex-1 overflow-y-auto md:overflow-hidden w-full h-full">
                                {children}
                            </main>
                        </div>
                    </div>
                </div>
            </SidebarContext.Provider>
        </ChatHistoryProvider>
    );
}
