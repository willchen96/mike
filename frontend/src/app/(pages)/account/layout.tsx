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
    { id: "mcp", label: "Connectors", href: "/account/mcp" },
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
            <div className="h-dvh bg-white flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
            </div>
        );
    }

    if (!isAuthenticated) {
        return null;
    }

    return (
        <div className="flex flex-col h-full md:overflow-y-auto px-6 py-6 md:py-10">
            <div className="max-w-5xl w-full mx-auto">
                <h1 className="text-4xl font-medium mb-8 font-eb-garamond">
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
                                            ? "bg-gray-100 text-gray-900"
                                            : "text-gray-500 hover:text-gray-900 hover:bg-gray-50"
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
