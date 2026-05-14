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
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { MikeIcon } from "@/app/components/chat/mike-icon";
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

    if (!user) return null;

    return (
        <div
            className={`${
                isOpen
                    ? "w-64 h-dvh bg-gray-50 border-r"
                    : "w-14 md:h-dvh md:bg-gray-50 md:border-r h-auto bg-transparent"
            } border-gray-200 flex flex-col transition-all duration-300 absolute md:relative z-99 overflow-visible`}
        >
            {/* Toggle + Logo */}
            <div
                className={`mb-3 items-center justify-between px-2.5 py-2 ${
                    !isOpen ? "hidden md:flex" : "flex"
                }`}
            >
                {isOpen && (
                    <div className="px-2.5">
                        <Link
                            href="/assistant"
                            className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
                        >
                            <MikeIcon size={22} />
                            <span
                                className={`text-2xl font-light font-serif ${
                                    shouldAnimate ? "sidebar-fade-in" : ""
                                }`}
                            >
                                Mike
                            </span>
                        </Link>
                    </div>
                )}
                <button
                    onClick={onToggle}
                    className="h-9 w-9 p-2.5 items-center flex hover:bg-gray-100 rounded-md transition-colors"
                    title={isOpen ? "Close sidebar" : "Open sidebar"}
                >
                    <PanelLeft className="h-4 w-4" />
                </button>
            </div>

            {/* Nav items */}
            {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
                const isActive =
                    pathname === href || pathname.startsWith(href + "/");
                return (
                    <div key={href} className="py-1 px-2.5">
                        <button
                            onClick={() => router.push(href)}
                            title={!isOpen ? label : ""}
                            className={`w-full h-9 flex items-center gap-3 px-2.5 py-2 rounded-md transition-colors text-left ${
                                isActive
                                    ? "bg-gray-100 text-gray-900"
                                    : "hover:bg-gray-100 text-gray-700"
                            } ${!isOpen ? "hidden md:flex" : "flex"}`}
                        >
                            <Icon
                                className={`h-4 w-4 flex-shrink-0 ${
                                    isActive ? "text-gray-900" : "text-black"
                                }`}
                            />
                            {isOpen && (
                                <span
                                    className={`text-sm font-medium ${
                                        shouldAnimate ? "sidebar-fade-in-2" : ""
                                    }`}
                                >
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
                        className={`mb-2 px-5 flex items-center justify-between text-xs font-semibold text-gray-500 hover:text-gray-700 transition-colors ${
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
                                            className="h-3 bg-gray-200 rounded animate-pulse"
                                            style={{ width: `${w}%` }}
                                        />
                                    </div>
                                ))}
                            </div>
                        ) : chats.length === 0 ? (
                            <div
                                className={`text-xs text-gray-500 py-2 px-5 ${
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
                            className={`flex items-center transition-colors w-full px-3.5 py-4 border-t border-gray-200 ${
                                !isOpen ? "hidden md:flex" : ""
                            } ${
                                pathname === "/account" || isDropdownOpen
                                    ? "bg-gray-100"
                                    : "hover:bg-gray-100"
                            }`}
                            title={!isOpen ? user.email : undefined}
                        >
                            <div className="h-7 w-7 flex-shrink-0 rounded-full bg-gray-700 flex items-center justify-center text-white text-sm font-medium font-serif">
                                {getUserInitials(user.email)}
                            </div>
                            {isOpen && (
                                <div
                                    className={`text-left flex-1 min-w-0 pl-3 flex items-center justify-between gap-2 ${
                                        shouldAnimate ? "sidebar-fade-in-2" : ""
                                    }`}
                                >
                                <div className="flex flex-col gap-0.5 min-w-0">
                                    <div className="text-sm font-medium text-gray-900 leading-none">
                                        {getDisplayName()}
                                    </div>
                                </div>
                                    <ChevronsUpDown className="h-4 w-4 flex-shrink-0 text-gray-400" />
                                </div>
                            )}
                        </button>

                        {isDropdownOpen && (
                            <div className="absolute bottom-full left-0 m-1 bg-white rounded-lg shadow-lg border border-gray-200 p-1 z-50 w-62 whitespace-nowrap">
                                <button
                                    onClick={() => {
                                        router.push("/account");
                                        setIsDropdownOpen(false);
                                    }}
                                    className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2 rounded-md"
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
