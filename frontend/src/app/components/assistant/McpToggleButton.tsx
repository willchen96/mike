"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Plug, Plus } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    listMcpServers,
    updateMcpServer,
    type McpServer,
} from "@/app/lib/mikeApi";

/**
 * Sit next to "Documents" / "Workflows" in the chat input. Opens a popover
 * where the user toggles each of their configured MCP servers on/off. The
 * toggle flips `enabled` on the row, which the chat backend honors at the
 * start of the next request.
 */
export function McpToggleButton() {
    const [servers, setServers] = useState<McpServer[] | null>(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState<Record<string, boolean>>({});

    const reload = useCallback(async () => {
        try {
            const list = await listMcpServers();
            setServers(list);
        } catch {
            setServers([]);
        }
    }, []);

    // Refresh when the menu opens so toggles always reflect current state
    // (the user may have edited servers in the settings page).
    useEffect(() => {
        if (open) reload();
        else if (servers === null) reload();
    }, [open, reload, servers]);

    const handleToggle = async (server: McpServer) => {
        setBusy((s) => ({ ...s, [server.id]: true }));
        // Optimistic flip.
        setServers((prev) =>
            prev
                ? prev.map((s) =>
                      s.id === server.id ? { ...s, enabled: !s.enabled } : s,
                  )
                : prev,
        );
        try {
            await updateMcpServer(server.id, { enabled: !server.enabled });
        } catch {
            // Revert on error.
            await reload();
        } finally {
            setBusy((s) => ({ ...s, [server.id]: false }));
        }
    };

    // Hide the button entirely when the user has no servers configured —
    // surface only emerges when there's something to toggle.
    if (servers !== null && servers.length === 0) return null;

    const enabledCount = servers?.filter((s) => s.enabled).length ?? 0;
    const totalCount = servers?.length ?? 0;

    return (
        <DropdownMenu onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label="Manage connectors for this chat"
                    title={
                        servers === null
                            ? "Loading connectors"
                            : `${enabledCount} of ${totalCount} connectors enabled`
                    }
                    className={`flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm transition-colors ${
                        enabledCount > 0
                            ? "text-blue-600 hover:bg-blue-50"
                            : "text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                    } ${open ? "bg-gray-100" : ""}`}
                >
                    <Plug className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">
                        Connectors
                        {enabledCount > 0 && totalCount > 0 && (
                            <span className="ml-1 text-xs text-blue-600 font-medium">
                                {enabledCount}
                            </span>
                        )}
                    </span>
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72 p-1">
                <DropdownMenuLabel className="text-xs text-gray-500 font-normal">
                    Connectors
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {servers?.map((s) => (
                    <McpRow
                        key={s.id}
                        server={s}
                        busy={busy[s.id] === true}
                        onToggle={() => handleToggle(s)}
                    />
                ))}
                <DropdownMenuSeparator />
                <a
                    href="/account/mcp"
                    className="flex items-center gap-2 px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-50 rounded-sm"
                >
                    <Plus className="h-3.5 w-3.5" />
                    Manage connectors
                </a>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function McpRow({
    server,
    busy,
    onToggle,
}: {
    server: McpServer;
    busy: boolean;
    onToggle: () => void;
}) {
    const safeName =
        server.name.trim().length > 0 ? server.name.trim() : "Untitled";
    return (
        <button
            type="button"
            onClick={onToggle}
            disabled={busy}
            className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-sm hover:bg-gray-50 rounded-sm disabled:opacity-50"
        >
            <span className="flex items-center gap-2 min-w-0">
                <Plug className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                <span className="truncate">{safeName}</span>
                {server.last_error && (
                    <AlertCircle
                        className="h-3 w-3 text-red-500 shrink-0"
                        aria-label={`Error: ${server.last_error}`}
                    />
                )}
            </span>
            <ToggleSwitch on={server.enabled} />
        </button>
    );
}

function ToggleSwitch({ on }: { on: boolean }) {
    return (
        <span
            className={`shrink-0 inline-flex items-center w-7 h-4 rounded-full transition-colors ${
                on ? "bg-blue-600" : "bg-gray-300"
            }`}
        >
            <span
                className={`inline-block w-3 h-3 rounded-full bg-white transition-transform ${
                    on ? "translate-x-3.5" : "translate-x-0.5"
                }`}
            />
        </span>
    );
}
