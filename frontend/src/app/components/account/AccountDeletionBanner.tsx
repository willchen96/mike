"use client";

import { useState } from "react";
import { AlertTriangle, Eye, EyeOff } from "lucide-react";
import { supabase } from "@/app/lib/supabase";
import {
    restoreAccount,
    type AccountDeletedResponse,
} from "@/app/lib/mikeApi";

/**
 * CLEAN-44 — Soft-delete banner.
 *
 * Rendered when the backend's `requireAuth` gate returns 403 with a
 * `{ deleted: true, ... }` body. The matching body is parsed in
 * `mikeApi.apiRequest` and dispatched on `window` as the
 * `hugo:account-deleted` custom event, which `(pages)/layout.tsx` listens to.
 *
 * The restore token is issued at DELETE /user/account time and persisted by the
 * frontend in `localStorage.hugo_restore_token`. The banner reads it from there
 * so the user can self-serve restore without an email round-trip (per CONTEXT.md
 * D-05).
 */
export function AccountDeletionBanner({
    deletedState,
}: {
    deletedState: AccountDeletedResponse | null;
}) {
    const [revealToken, setRevealToken] = useState(false);
    const [restoring, setRestoring] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!deletedState) return null;

    const restoreToken =
        typeof window !== "undefined"
            ? localStorage.getItem("hugo_restore_token")
            : null;

    const handleRestore = async () => {
        if (!restoreToken) {
            setError("Restore token not found in this browser. Sign in from the original device or contact support.");
            return;
        }
        setRestoring(true);
        setError(null);
        try {
            await restoreAccount(restoreToken);
            // On 204: clear the token and reload so the next request returns 200.
            localStorage.removeItem("hugo_restore_token");
            window.location.reload();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Restore failed");
            setRestoring(false);
        }
    };

    const handleLogout = async () => {
        await supabase.auth.signOut();
        if (typeof window !== "undefined") {
            localStorage.removeItem("hugo_restore_token");
        }
    };

    return (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-3 text-sm text-amber-900">
            <div className="flex items-start gap-3 max-w-5xl mx-auto">
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" />
                <div className="flex-1 space-y-2">
                    <p className="font-medium">
                        Your account is scheduled for deletion on{" "}
                        {new Date(deletedState.scheduled_hard_delete_at).toLocaleDateString()}
                    </p>
                    <p className="text-amber-800">
                        Save your restore token now — losing it means permanent deletion.
                    </p>
                    {restoreToken && (
                        <div className="flex items-center gap-2">
                            <code className="bg-white border border-amber-300 rounded px-2 py-1 text-xs font-mono break-all">
                                {revealToken ? restoreToken : "•".repeat(Math.min(48, restoreToken.length))}
                            </code>
                            <button
                                type="button"
                                onClick={() => setRevealToken((r) => !r)}
                                className="text-amber-700 hover:text-amber-900"
                                aria-label={revealToken ? "Hide restore token" : "Reveal restore token"}
                            >
                                {revealToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                        </div>
                    )}
                    {error && <p className="text-red-700 text-xs">{error}</p>}
                    <div className="flex gap-2 pt-1">
                        <button
                            type="button"
                            onClick={handleRestore}
                            disabled={restoring || !restoreToken}
                            className="bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded"
                        >
                            {restoring ? "Restoring..." : "Restore now"}
                        </button>
                        <button
                            type="button"
                            onClick={handleLogout}
                            className="border border-amber-400 hover:bg-amber-100 text-amber-900 text-xs font-medium px-3 py-1.5 rounded"
                        >
                            I&rsquo;m sure, log out
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
