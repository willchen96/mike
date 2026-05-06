"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

interface TabDef {
    id: string;
    label: string;
    href: string;
}

const TABS: TabDef[] = [
    { id: "general", label: "General", href: "/account" },
    { id: "models", label: "Models & API Keys", href: "/account/models" },
];

export default function AccountLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const { isAuthenticated, authLoading } = useAuth();

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/");
        }
    }, [isAuthenticated, authLoading, router]);

    if (authLoading) {
        return (
            <div className="h-dvh bg-background flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-[#898344]" />
            </div>
        );
    }

    if (!isAuthenticated) {
        return null;
    }

    return (
        <div className="flex flex-col h-full md:overflow-y-auto px-6 py-6 md:py-10">
            <div className="max-w-5xl w-full mx-auto">
                <h1 className="text-4xl font-bold mb-8 font-sans">
                    Settings
                </h1>

                <div className="flex flex-col md:flex-row gap-6 md:gap-10">
                    <nav
                        aria-label="Settings"
                        className="md:w-56 shrink-0 flex md:flex-col gap-1 overflow-x-auto"
                    >
                        {TABS.map((tab) => {
                            const active = pathname === tab.href;
                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => router.push(tab.href)}
                                    className={`text-left whitespace-nowrap px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                                        active
                                            ? "bg-[#F5F5F5] text-[#292629]"
                                            : "text-[#292629]/50 hover:text-[#292629] hover:bg-[#F5F5F5]"
                                    }`}
                                >
                                    {tab.label}
                                </button>
                            );
                        })}
                    </nav>

                    <div className="flex-1 min-w-0">{children}</div>
                </div>
            </div>
        </div>
    );
}
