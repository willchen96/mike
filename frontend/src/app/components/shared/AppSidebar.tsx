"use client";

import { useState, useEffect } from "react";
import {
    PanelLeft,
    MessageSquare,
    FolderOpen,
    Table2,
    Library,
    User,
    ChevronsUpDown,
    ChevronDown,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { SidebarChatItem } from "@/app/components/shared/SidebarChatItem";
import { listProjects } from "@/app/lib/mikeApi";

const NAV_ITEMS = [
    { href: "/assistant", label: "Assistant", icon: MessageSquare },
    { href: "/projects", label: "Projects", icon: FolderOpen },
    { href: "/tabular-reviews", label: "Tabular Review", icon: Table2 },
    { href: "/workflows", label: "Workflows", icon: Library },
];

interface AppSidebarProps {
    isOpen: boolean;
    onToggle: () => void;
}

export function AppSidebar({ isOpen, onToggle }: AppSidebarProps) {
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const { chats, currentChatId, setCurrentChatId } = useChatHistoryContext();
    const router = useRouter();
    const pathname = usePathname();
    const [shouldAnimate, setShouldAnimate] = useState(false);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [historyCollapsed, setHistoryCollapsed] = useState(false);
    const [projectNames, setProjectNames] = useState<Record<string, string>>(
        {},
    );

    useEffect(() => {
        if (!user) return;
        listProjects()
            .then((projects) => {
                const map: Record<string, string> = {};
                for (const p of projects) map[p.id] = p.name;
                setProjectNames(map);
            })
            .catch(() => {});
    }, [user]);

    useEffect(() => {
        if (!isOpen) setShouldAnimate(true);
    }, [isOpen]);

    useEffect(() => {
        const handleClickOutside = () => setIsDropdownOpen(false);
        if (isDropdownOpen) {
            document.addEventListener("click", handleClickOutside);
            return () =>
                document.removeEventListener("click", handleClickOutside);
        }
    }, [isDropdownOpen]);

    useEffect(() => {
        if (pathname.startsWith("/assistant/chat/")) {
            const chatId = pathname.split("/").pop() ?? null;
            setCurrentChatId(chatId);
            return;
        }

        const projectChatMatch = pathname.match(
            /^\/projects\/[^/]+\/assistant\/chat\/([^/]+)/,
        );
        if (projectChatMatch) {
            setCurrentChatId(projectChatMatch[1]);
            return;
        }

        if (pathname === "/assistant") {
            setCurrentChatId(null);
        }
    }, [pathname, setCurrentChatId]);

    const getUserInitials = (email: string) => {
        if (profile?.displayName)
            return profile.displayName.charAt(0).toUpperCase();
        return email.charAt(0).toUpperCase();
    };

    const getDisplayName = () => {
        if (!profile) return "";
        return profile.displayName || user?.email?.split("@")[0] || "";
    };

    const getUserTier = () => {
        if (!profile) return "";
        return profile.tier || "Free";
    };

    if (!user) return null;

    return (
        <div
            className={`${
                isOpen
                    ? "w-64 h-dvh bg-sidebar border-r"
                    : "w-14 md:h-dvh md:bg-sidebar md:border-r h-auto bg-transparent"
            } border-sidebar-border flex flex-col transition-all duration-300 absolute md:relative z-99 overflow-visible`}
        >
            {/* Toggle + Logo */}
            {isOpen ? (
                <div className={`px-6 pt-8 pb-6 flex items-start justify-between ${shouldAnimate ? "sidebar-fade-in" : ""}`}>
                    <Link
                        href="/assistant"
                        className="flex flex-col gap-0.5 hover:opacity-75 transition-opacity"
                    >
                        <h1 className="text-xl font-bold text-[#292629] tracking-tight leading-none">
                            Mike Legal
                        </h1>
                        <p className="text-[10px] font-semibold text-[#292629]/40 tracking-widest uppercase mt-0.5">
                            AI Platform
                        </p>
                    </Link>
                    <button
                        onClick={onToggle}
                        className="h-8 w-8 flex items-center justify-center hover:bg-[#F5F5F5] rounded-md transition-colors mt-0.5"
                        title="Close sidebar"
                    >
                        <PanelLeft className="h-4 w-4 text-[#292629]/50" />
                    </button>
                </div>
            ) : (
                <div className="py-3 px-2 flex md:flex hidden">
                    <button
                        onClick={onToggle}
                        className="h-9 w-9 flex items-center justify-center hover:bg-[#F5F5F5] rounded-md transition-colors"
                        title="Open sidebar"
                    >
                        <PanelLeft className="h-4 w-4 text-[#292629]/50" />
                    </button>
                </div>
            )}

            {/* Nav items */}
            {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
                const isActive =
                    pathname === href || pathname.startsWith(href + "/");
                return (
                    <div key={href} className="py-0">
                        <button
                            onClick={() => router.push(href)}
                            title={!isOpen ? label : ""}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm tracking-tight transition-colors duration-150 text-left select-none border-r-4 ${
                                isActive
                                    ? "bg-[#F5F5F5] text-[#EC6529] font-bold border-[#EC6529]"
                                    : "text-[#292629]/60 font-medium border-transparent hover:text-[#292629] hover:bg-[#F5F5F5]"
                            } ${!isOpen ? "hidden md:flex" : "flex"}`}
                        >
                            <Icon
                                className={`h-[18px] w-[18px] flex-shrink-0 ${
                                    isActive ? "text-[#EC6529]" : "text-[#292629]/60"
                                }`}
                            />
                            {isOpen && (
                                <span className={shouldAnimate ? "sidebar-fade-in-2" : ""}>
                                    {label}
                                </span>
                            )}
                        </button>
                    </div>
                );
            })}

            {/* Assistant History */}
            {isOpen && pathname.startsWith("/assistant") && (
                <div className="mt-4 flex-1 min-h-0 flex flex-col">
                    <button
                        onClick={() => setHistoryCollapsed((v) => !v)}
                        className={`mb-2 px-5 flex items-center justify-between text-xs font-semibold text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors ${
                            shouldAnimate ? "sidebar-fade-in" : ""
                        }`}
                    >
                        <span>Assistant History</span>
                        <ChevronDown
                            className={`h-3.5 w-3.5 transition-transform ${historyCollapsed ? "-rotate-90" : ""}`}
                        />
                    </button>
                    <div
                        className={`overflow-y-auto flex-1 ${historyCollapsed ? "hidden" : ""}`}
                    >
                        {!chats ? (
                            <div className="space-y-1 px-2.5">
                                {[40, 60, 50, 70, 45].map((w, i) => (
                                    <div
                                        key={i}
                                        className="h-9 flex items-center px-3 rounded-md"
                                    >
                                        <div
                                            className="h-3 bg-[#F5F5F5] rounded animate-pulse"
                                            style={{ width: `${w}%` }}
                                        />
                                    </div>
                                ))}
                            </div>
                        ) : chats.length === 0 ? (
                            <div
                                className={`text-xs text-[#292629]/50 py-2 px-5 ${
                                    shouldAnimate ? "sidebar-fade-in-2" : ""
                                }`}
                            >
                                No chats yet
                            </div>
                        ) : (
                            <div
                                className={`space-y-1 px-2.5 ${
                                    shouldAnimate ? "sidebar-fade-in-2" : ""
                                }`}
                            >
                                {chats.map((chat) => (
                                    <SidebarChatItem
                                        key={chat.id}
                                        chat={chat}
                                        isActive={currentChatId === chat.id}
                                        projectName={
                                            chat.project_id
                                                ? projectNames[chat.project_id]
                                                : undefined
                                        }
                                        onSelect={() => {
                                            setCurrentChatId(chat.id);
                                            router.push(
                                                chat.project_id
                                                    ? `/projects/${chat.project_id}/assistant/chat/${chat.id}`
                                                    : `/assistant/chat/${chat.id}`,
                                            );
                                        }}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* User Profile */}
            <div className="mt-auto">
                {user && (
                    <div className="relative">
                        <button
                            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                            className={`flex items-center gap-3 w-full px-4 py-3 rounded-xl mx-3 mb-3 transition-colors ${
                                !isOpen ? "hidden md:flex" : ""
                            } ${
                                pathname === "/account" || isDropdownOpen
                                    ? "bg-[#F5F5F5]"
                                    : "bg-[#F5F5F5] hover:bg-[#F5F5F5]"
                            }`}
                            style={{ width: isOpen ? "calc(100% - 1.5rem)" : undefined }}
                            title={!isOpen ? user.email : undefined}
                        >
                            <div className="h-7 w-7 flex-shrink-0 rounded-full bg-[#292629] flex items-center justify-center text-white text-xs font-bold">
                                {getUserInitials(user.email)}
                            </div>
                            {isOpen && (
                                <div
                                    className={`text-left flex-1 min-w-0 flex items-center justify-between gap-2 ${
                                        shouldAnimate ? "sidebar-fade-in-2" : ""
                                    }`}
                                >
                                    <div className="flex flex-col min-w-0">
                                        <div className="text-xs font-bold text-[#292629] leading-none truncate">
                                            {getDisplayName()}
                                        </div>
                                        <div className="text-[10px] text-[#292629]/50 leading-none mt-0.5">
                                            {getUserTier()}
                                        </div>
                                    </div>
                                    <ChevronsUpDown className="h-3.5 w-3.5 flex-shrink-0 text-[#292629]/40" />
                                </div>
                            )}
                        </button>

                        {isDropdownOpen && (
                            <div className="absolute bottom-full left-0 m-1 bg-white rounded-xl shadow-lg border border-[#C0C8B8] p-1 z-50 w-62 whitespace-nowrap">
                                <button
                                    onClick={() => {
                                        router.push("/account");
                                        setIsDropdownOpen(false);
                                    }}
                                    className="w-full px-4 py-2 text-left text-sm text-[#292629] hover:bg-[#F5F5F5] flex items-center gap-2 rounded-lg transition-colors"
                                >
                                    <User className="h-4 w-4" />
                                    Account Settings
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
