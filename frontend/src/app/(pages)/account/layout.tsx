"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useTranslations } from "next-intl";

interface TabDef {
    id: string;
    label: string;
    href: string;
}

export default function AccountLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const t = useTranslations("pages.configLayout");
    const router = useRouter();
    const pathname = usePathname();
    const { isAuthenticated, authLoading } = useAuth();

    const TABS: TabDef[] = [
        { id: "general", label: t("tabGeral"), href: "/account" },
        { id: "models", label: t("tabModelos"), href: "/account/models" },
    ];

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
        <div className="flex h-full flex-col overflow-y-auto">
            <header className="mx-auto flex h-16 w-full max-w-5xl shrink-0 items-end px-6 pb-2 md:h-24 md:pb-4">
                <h1 className="text-4xl font-medium font-eb-garamond">
                    {t("titulo")}
                </h1>
            </header>

            <main className="mx-auto w-full max-w-5xl flex-1 px-6 pb-10 pt-4 md:pt-6">
                <div className="grid grid-cols-1 gap-y-6 md:grid-cols-[224px_minmax(0,1fr)] md:gap-x-10">
                    <nav
                        aria-label={t("titulo")}
                        className="z-10 -ml-3 min-w-0 self-start md:sticky md:top-4"
                    >
                        <div className="-m-1 min-w-0 p-1">
                            <div className="-m-1 min-w-0 overflow-x-auto overflow-y-hidden p-1">
                                <ul className="mb-0 flex gap-1 md:flex-col">
                                    {TABS.map((tab) => {
                                        const active =
                                            pathname === tab.href ||
                                            (tab.href !== "/account" &&
                                                pathname.startsWith(tab.href));
                                        return (
                                            <li key={tab.id}>
                                                <button
                                                    type="button"
                                                    aria-current={
                                                        active
                                                            ? "page"
                                                            : undefined
                                                    }
                                                    onClick={() =>
                                                        router.push(tab.href)
                                                    }
                                                    className={`flex h-9 w-full items-center rounded-lg px-3 text-left text-sm font-medium whitespace-nowrap transition-colors ${
                                                        active
                                                            ? "bg-gray-100 text-gray-900"
                                                            : "text-gray-500 hover:bg-gray-50 hover:text-gray-900"
                                                    }`}
                                                >
                                                    {tab.label}
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        </div>
                    </nav>

                    <div className="min-w-0 outline-none">{children}</div>
                </div>
            </main>
        </div>
    );
}
