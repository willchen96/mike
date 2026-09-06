"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    ChevronDown,
    Eye,
    EyeOff,
    Loader2,
    Plus,
    RefreshCw,
} from "lucide-react";
import { FieldLabel } from "@/app/components/ui/form-field";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_PRESSED_CLASS,
} from "@/app/components/ui/liquid-surface";
import {
    SETTINGS_CONTROL_CLASS,
    SettingsTextInput,
} from "@/app/components/settings/SettingsTextInput";
import { Modal } from "@/app/components/modals/Modal";
import {
    ConnectorSetupNotice,
    NewMcpModal } from "@/app/components/settings/NewMcpModal";
import {
    MfaVerificationPopup,
    needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import {
    type GoogleDriveStatus,
    type McpConnectorSummary,
    MikeApiError,
    isConnectorSetupError,
    createMcpConnector,
    deleteMcpConnector,
    disconnectGoogleDrive,
    getGoogleDriveStatus,
    getMcpConnector,
    isMfaRequiredError,
    listMcpConnectors,
    refreshMcpConnectorTools,
    setMcpToolEnabled,
    startGoogleDriveOAuth,
    startMcpConnectorOAuth,
    updateMcpConnector,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import {
    settingsGlassIconButtonClassName,
    settingsGlassPrimaryButtonClassName,
} from "../settingsStyles";
import { SettingsSection } from "../SettingsSection";
import { SettingsToggle } from "../SettingsToggle";

type PendingMfaAction =
    | { type: "create" }
    | { type: "drive-connect" }
    | { type: "drive-disconnect" }
    | { type: "save"; connectorId: string }
    | { type: "clear-token"; connectorId: string }
    | { type: "delete"; connectorId: string }
    | { type: "refresh"; connectorId: string }
    | { type: "connector-enabled"; connectorId: string; enabled: boolean }
    | {
          type: "tool-enabled";
          connectorId: string;
          toolId: string;
          enabled: boolean;
      };

type AddDraft = {
    name: string;
    serverUrl: string;
    bearerToken: string;
    customHeaders: string;
};

type DetailDraft = AddDraft & {
    clearBearerToken: boolean;
};

type AddStep = "form" | "working" | "auth" | "success";

const emptyAddDraft: AddDraft = {
    name: "",
    serverUrl: "",
    bearerToken: "",
    customHeaders: "",
};

type McpOAuthPopupMessage = {
    type?: string;
    success?: boolean;
    connectorId?: string;
    detail?: string;
};

/**
 * Thrown to unwind the OAuth wait when the user cancels the flow or navigates
 * away (the component unmounts) rather than because authorization genuinely
 * failed. Callers use it to distinguish "abandoned on purpose" — which should
 * quietly reset the UI — from a real error worth surfacing to the user.
 */
class McpOAuthCancelledError extends Error {
    constructor(message = "OAuth authorization was cancelled.") {
        super(message);
        this.name = "McpOAuthCancelledError";
    }
}

function parseCustomHeaders(raw: string): Record<string, string> | undefined {
    const text = raw.trim();
    if (!text) return undefined;
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Custom headers must be a JSON object.");
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string") {
            throw new Error("Custom header values must be strings.");
        }
        headers[key] = value;
    }
    return headers;
}

function isGoogleMcpConnector(connector: McpConnectorSummary) {
    try {
        const hostname = new URL(connector.serverUrl).hostname.toLowerCase();
        return (
            hostname === "googleapis.com" ||
            hostname.endsWith(".googleapis.com")
        );
    } catch {
        return false;
    }
}

/**
 * Imperative surface the Google Drive card registers with its parent page.
 * The page's MFA machinery needs it: when a Drive action is interrupted by
 * an MFA challenge, the verification popup's "verified" callback must be able
 * to re-invoke the exact action that was interrupted, and those actions live
 * inside the card (they close over its local state).
 */
type GoogleDriveCardHandle = {
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
};

/**
 * First-party Google Drive card. Unlike MCP connectors there is no server
 * URL to enter and no per-tool management — one Connect click runs the
 * backend's own OAuth flow (GA Drive REST API, no Google preview program),
 * after which the assistant's google_drive_* tools activate automatically.
 *
 * Connect and Disconnect hit backend routes gated by requireMfaIfEnrolled,
 * so both run through the page's `runSensitiveAction` wrapper — the same
 * path every other sensitive action on this page takes — which pre-checks
 * MFA and turns the backend's 403 `mfa_verification_required` into the
 * verification popup instead of a dead-end error string.
 */
function GoogleDriveCard({
    runSensitiveAction,
    handleRef,
}: {
    runSensitiveAction: (
        action: PendingMfaAction,
        fn: () => Promise<void>,
    ) => Promise<void>;
    handleRef: { current: GoogleDriveCardHandle | null };
}) {
    const [status, setStatus] = useState<GoogleDriveStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        let cancelled = false;
        getGoogleDriveStatus()
            .then((s) => {
                if (!cancelled) setStatus(s);
            })
            .catch(() => {
                if (!cancelled)
                    setStatus({ connected: false, scope: null, configured: false });
            });
        return () => {
            cancelled = true;
            abortRef.current?.abort();
        };
    }, []);

    const connect = async () => {
        setBusy(true);
        setError(null);
        // Open the popup synchronously with the click so browsers don't block
        // it, then navigate it once the backend hands us the URL.
        const popup = window.open(
            "about:blank",
            "mike_google_drive_oauth",
            "popup,width=560,height=720,menubar=no,toolbar=no,location=no,status=no",
        );
        try {
            await runSensitiveAction({ type: "drive-connect" }, async () => {
                try {
                    const { authorizationUrl } = await startGoogleDriveOAuth();
                    if (!popup) {
                        window.location.assign(authorizationUrl);
                        return;
                    }
                    popup.location.href = authorizationUrl;

                    // Google's consent page severs window.opener (COOP), so
                    // poll our own status endpoint as the source of truth —
                    // same approach as the MCP connector flow.
                    const abortController = new AbortController();
                    abortRef.current?.abort();
                    abortRef.current = abortController;
                    await new Promise<void>((resolve, reject) => {
                        let settled = false;
                        const started = Date.now();
                        let pollTimer = 0;
                        const finish = (action: () => void) => {
                            if (settled) return;
                            settled = true;
                            window.clearTimeout(timeout);
                            window.clearTimeout(pollTimer);
                            abortController.signal.removeEventListener(
                                "abort",
                                onAbort,
                            );
                            action();
                        };
                        const timeout = window.setTimeout(
                            () =>
                                finish(() =>
                                    reject(
                                        new Error(
                                            "Google authorization timed out.",
                                        ),
                                    ),
                                ),
                            5 * 60 * 1000,
                        );
                        const runPoll = () => {
                            void getGoogleDriveStatus()
                                .then((s) => {
                                    if (settled) return;
                                    if (s.connected) {
                                        setStatus(s);
                                        finish(resolve);
                                        return;
                                    }
                                    schedule();
                                })
                                .catch(() => {
                                    if (!settled) schedule();
                                });
                        };
                        const schedule = () => {
                            const delay =
                                Date.now() - started < 60_000 ? 1500 : 5000;
                            pollTimer = window.setTimeout(runPoll, delay);
                        };
                        const onAbort = () =>
                            finish(() =>
                                reject(new Error("Authorization cancelled.")),
                            );
                        abortController.signal.addEventListener(
                            "abort",
                            onAbort,
                        );
                        schedule();
                    });
                } catch (e) {
                    // An MFA challenge is not a failure of this card: rethrow
                    // so runSensitiveAction opens the verification popup and,
                    // once the user verifies, re-invokes connect() through the
                    // registered handle.
                    if (isMfaRequiredError(e)) throw e;
                    setError(
                        e instanceof Error
                            ? e.message
                            : "Failed to connect Google Drive.",
                    );
                }
            });
        } finally {
            // Close the OAuth window on every exit path — success, failure,
            // timeout, user cancel, and the MFA detour (where the flow never
            // even starts). Same discipline as connectConnectorOAuth below:
            // anything short of a finally leaks a blank popup on early exits.
            try {
                popup?.close();
            } catch {
                // COOP may block closing a severed popup; it self-closes anyway.
            }
            setBusy(false);
        }
    };

    const disconnect = async () => {
        setBusy(true);
        setError(null);
        try {
            await runSensitiveAction({ type: "drive-disconnect" }, async () => {
                try {
                    await disconnectGoogleDrive();
                    setStatus((s) =>
                        s ? { ...s, connected: false, scope: null } : s,
                    );
                } catch (e) {
                    // Same contract as connect(): hand MFA challenges back to
                    // the page's machinery, keep genuine failures local.
                    if (isMfaRequiredError(e)) throw e;
                    setError(
                        e instanceof Error
                            ? e.message
                            : "Failed to disconnect Google Drive.",
                    );
                }
            });
        } finally {
            setBusy(false);
        }
    };

    // Register the actions with the parent so its MFA-verified callback can
    // re-run the interrupted one. Re-registered every render (no dependency
    // array) so the handle never closes over stale state.
    useEffect(() => {
        handleRef.current = { connect, disconnect };
        return () => {
            handleRef.current = null;
        };
    });

    return (
        <SettingsSection>
            <div className="flex items-center justify-between gap-3 px-4 py-5">
                <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">
                        Google Drive
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">
                        {status?.connected
                            ? "Connected — the assistant can search and read your Drive files (read-only)."
                            : "Let the assistant search and read your Google Drive files (read-only)."}
                    </p>
                </div>
                {status === null ? (
                    <span className="text-xs text-gray-400">Loading…</span>
                ) : status.connected ? (
                    <button
                        type="button"
                        onClick={() => void disconnect()}
                        disabled={busy}
                        className="text-sm text-gray-500 transition-colors hover:text-gray-800 disabled:opacity-50"
                    >
                        {busy ? "Disconnecting…" : "Disconnect"}
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={() => void connect()}
                        disabled={
                            busy ||
                            !status.configured ||
                            status.schemaReady === false
                        }
                        className={`inline-flex h-9 items-center gap-1.5 text-sm ${settingsGlassPrimaryButtonClassName}`}
                    >
                        {busy ? "Waiting for Google…" : "Connect"}
                    </button>
                )}
            </div>
            {status !== null && !status.connected && status.schemaReady === false && (
                <p className="px-4 pb-4 text-xs text-gray-500">
                    Not available on this server yet: the database is missing
                    the Google Drive migration
                    (backend/migrations/20260906_01_google_drive_integration.sql).
                    The administrator needs to apply it and restart.
                </p>
            )}
            {status !== null &&
                !status.connected &&
                status.schemaReady !== false &&
                !status.configured && (
                    <div className="px-4 pb-4 text-xs text-gray-500">
                        <p>
                            Not available on this server: the administrator
                            needs to configure a Google OAuth client (see
                            &ldquo;Google Drive Integration&rdquo; in the
                            README).
                        </p>
                        {status.redirectUri && (
                            <p className="mt-1">
                                Authorized redirect URI to register:{" "}
                                <code className="break-all text-gray-700">
                                    {status.redirectUri}
                                </code>
                            </p>
                        )}
                    </div>
                )}
            {busy && !status?.connected && (
                <button
                    type="button"
                    onClick={() => abortRef.current?.abort()}
                    className="mx-4 mb-4 text-xs text-gray-400 underline-offset-2 hover:underline"
                >
                    Cancel
                </button>
            )}
            {error && (
                <p className="px-4 pb-4 whitespace-pre-wrap text-xs text-red-600">
                    {error}
                </p>
            )}
        </SettingsSection>
    );
}

export default function ConnectorsPage() {
    const [connectors, setConnectors] = useState<McpConnectorSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pendingMfaAction, setPendingMfaAction] =
        useState<PendingMfaAction | null>(null);
    const [addOpen, setAddOpen] = useState(false);
    const [addDraft, setAddDraft] = useState<AddDraft>(emptyAddDraft);
    const [addStep, setAddStep] = useState<AddStep>("form");
    const [addResult, setAddResult] = useState<McpConnectorSummary | null>(
        null,
    );
    const [addError, setAddError] = useState<string | null>(null);
    const [addAuthMessage, setAddAuthMessage] = useState<string | null>(null);
    const [showAddToken, setShowAddToken] = useState(false);
    const [showAddAdvanced, setShowAddAdvanced] = useState(false);
    const [selectedConnectorId, setSelectedConnectorId] = useState<
        string | null
    >(null);
    const [selectedConnectorDetails, setSelectedConnectorDetails] =
        useState<McpConnectorSummary | null>(null);
    const [detailDraft, setDetailDraft] = useState<DetailDraft>({
        ...emptyAddDraft,
        clearBearerToken: false,
    });
    const [detailError, setDetailError] = useState<string | null>(null);
    // Setup steps from a Refresh on an unconfigured provider, shown inside
    // the details modal (a page-level banner would sit behind it).
    const [detailSetupNotice, setDetailSetupNotice] = useState<string | null>(
        null,
    );
    const [loadingConnectorId, setLoadingConnectorId] = useState<string | null>(
        null,
    );
    const [clearedBearerTokenConnectorId, setClearedBearerTokenConnectorId] =
        useState<string | null>(null);
    const [showDetailToken, setShowDetailToken] = useState(false);
    const [showDetailAdvanced, setShowDetailAdvanced] = useState(false);
    // Which connector currently has a reconnect OAuth wait in flight (the
    // details modal's Refresh flow). Drives the Cancel affordance next to the
    // Refresh button, mirroring the escape hatch the add modal already has.
    const [reconnectingConnectorId, setReconnectingConnectorId] = useState<
        string | null
    >(null);

    const selectedConnector = selectedConnectorDetails;

    const loadConnectors = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setConnectors(await listMcpConnectors());
        } catch (err) {
            setError(
                userFacingApiError(err, "Failed to load connectors."),
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadConnectors();
    }, [loadConnectors]);

    // The Google Drive card registers its connect/disconnect here so
    // handleMfaVerified can re-run whichever one an MFA challenge interrupted.
    const googleDriveHandleRef = useRef<GoogleDriveCardHandle | null>(null);

    // Holds the AbortController for an in-flight OAuth completion wait. A single
    // flow can run at a time, so a ref (not state) is the right home: it is
    // read/written imperatively and must never trigger a re-render.
    const oauthAbortRef = useRef<AbortController | null>(null);

    // If the user navigates away (or this page unmounts for any reason) while an
    // OAuth popup wait is running, abort it. Without this the poll's setTimeout
    // chain keeps firing authenticated GETs for up to five minutes and calls
    // setState on an unmounted component. The empty dependency array makes the
    // returned function a true unmount cleanup.
    useEffect(() => {
        return () => {
            oauthAbortRef.current?.abort();
            oauthAbortRef.current = null;
        };
    }, []);

    useEffect(() => {
        if (!selectedConnector) return;
        setDetailDraft({
            name: selectedConnector.name,
            serverUrl: selectedConnector.serverUrl,
            bearerToken: "",
            customHeaders: "",
            clearBearerToken: false,
        });
        setDetailError(null);
        // detailSetupNotice is deliberately NOT reset here: the Add flow sets
        // it in the same batch that selects the new connector, and this
        // effect runs right after that render. It is cleared on open/close
        // and before every sensitive action instead.
        setClearedBearerTokenConnectorId(null);
        setShowDetailToken(false);
        setShowDetailAdvanced(false);
    }, [
        selectedConnector?.id,
        selectedConnector?.name,
        selectedConnector?.serverUrl,
    ]);

    const replaceConnector = (
        connector: McpConnectorSummary,
        options: { preserveToolsOnEmpty?: boolean } = {},
    ) => {
        const mergeConnector = (current: McpConnectorSummary) => {
            if (
                options.preserveToolsOnEmpty &&
                connector.tools.length === 0 &&
                current.tools.length > 0
            ) {
                return { ...connector, tools: current.tools };
            }
            return connector;
        };
        setConnectors((prev) => {
            const exists = prev.some((item) => item.id === connector.id);
            if (!exists) return [connector, ...prev];
            return prev.map((item) =>
                item.id === connector.id ? mergeConnector(item) : item,
            );
        });
        setSelectedConnectorDetails((current) =>
            current?.id === connector.id ? mergeConnector(current) : current,
        );
    };

    const openConnectorDetails = async (connectorId: string) => {
        setSelectedConnectorId(connectorId);
        setSelectedConnectorDetails((current) =>
            current?.id === connectorId
                ? current
                : connectors.find((connector) => connector.id === connectorId) ??
                  null,
        );
        setDetailError(null);
        setDetailSetupNotice(null);
        setLoadingConnectorId(connectorId);
        try {
            const fresh = await getMcpConnector(connectorId);
            replaceConnector(fresh);
            // A connector created moments ago (the Add flow's setup-required
            // handover) is not in this closure's `connectors`, so the seed
            // above found nothing and replaceConnector only merges into an
            // existing selection. Adopt the fetched record unless the user
            // has since opened a different connector.
            setSelectedConnectorDetails((current) =>
                current && current.id !== connectorId ? current : fresh,
            );
        } catch (err) {
            setDetailError(
                userFacingApiError(
                    err,
                    "Failed to load connector details.",
                ),
            );
        } finally {
            setLoadingConnectorId((current) =>
                current === connectorId ? null : current,
            );
        }
    };

    const runSensitiveAction = async (
        action: PendingMfaAction,
        fn: () => Promise<void>,
    ) => {
        setError(null);
        setDetailError(null);
        setDetailSetupNotice(null);
        try {
            if (await needsMfaVerification()) {
                setPendingMfaAction(action);
                return;
            }
            await fn();
        } catch (err) {
            if (isMfaRequiredError(err)) {
                setPendingMfaAction(action);
                return;
            }
            if (
                isConnectorSetupError(err) &&
                action.type === "refresh" &&
                selectedConnectorId === action.connectorId
            ) {
                // Refresh from the details modal on a Slack/Google connector
                // whose OAuth client is not configured on this server: show
                // the operator steps where the user is looking.
                setDetailSetupNotice(err.message);
                return;
            }
            const message = userFacingApiError(err, "Action failed.");
            if (action.type === "create") setAddError(message);
            else if (action.type === "save") setDetailError(message);
            else setError(message);
        }
    };

    const closeAddModal = () => {
        // "working" is a brief synchronous create with nothing to cancel, so we
        // still block closing there. "auth" used to be blocked too, which trapped
        // the user for the full five-minute timeout whenever the popup closed
        // without a detectable result (COOP severs `popup.closed`, so we cannot
        // know). Closing during "auth" now aborts the pending OAuth wait via the
        // ref, giving the user a reliable escape hatch.
        if (addStep === "working") return;
        if (addStep === "auth") {
            oauthAbortRef.current?.abort();
            oauthAbortRef.current = null;
        }
        setAddOpen(false);
        setAddDraft(emptyAddDraft);
        setAddStep("form");
        setAddResult(null);
        setAddError(null);
        setAddAuthMessage(null);
        setShowAddToken(false);
        setShowAddAdvanced(false);
    };

    const connectConnectorOAuth = async (
        connectorId: string,
    ): Promise<McpConnectorSummary | null> => {
        const popup = window.open(
            "about:blank",
            "mike_mcp_oauth",
            "popup,width=560,height=720,menubar=no,toolbar=no,location=no,status=no",
        );
        let started: Awaited<ReturnType<typeof startMcpConnectorOAuth>>;
        try {
            started = await startMcpConnectorOAuth(connectorId);
        } catch (err) {
            // The popup is opened *before* the start call so browsers treat it
            // as user-initiated. When the start call fails — typically the 400
            // "connector_setup_required" answer for a Slack/Google client the
            // deployment has not configured yet — nothing will ever navigate
            // that window, so close it instead of stranding an about:blank
            // popup next to the setup notice (seen live on 2026-09-06).
            popup?.close();
            throw err;
        }
        const { authorizationUrl, alreadyAuthorized, callbackOrigin } = started;
        if (alreadyAuthorized) {
            popup?.close();
            const refreshed = await refreshMcpConnectorTools(connectorId);
            replaceConnector(refreshed);
            return refreshed;
        }
        if (!authorizationUrl) {
            popup?.close();
            throw new Error("OAuth authorization URL was not returned.");
        }
        const expectedCallbackOrigin = new URL(callbackOrigin).origin;
        if (!popup) {
            window.location.assign(authorizationUrl);
            return null;
        }
        popup.location.href = authorizationUrl;

        // A single OAuth wait runs at a time. Register its AbortController so the
        // Cancel affordance and the unmount cleanup can tear it down; abort any
        // stray previous flow first.
        const abortController = new AbortController();
        oauthAbortRef.current?.abort();
        oauthAbortRef.current = abortController;
        const { signal } = abortController;

        // Wait for authorization to complete. Strict identity providers (Google
        // among them) serve their consent page with
        // `Cross-Origin-Opener-Policy: same-origin`, which severs `window.opener`
        // and makes `popup.closed` unreadable from here. That breaks both the
        // callback's `postMessage` and any `popup.closed` polling, and a blocked
        // `popup.closed` read can even report a false "closed". So we treat the
        // backend's `oauthConnected` flag as the source of truth and poll for it,
        // while still honouring a `postMessage` on the chance it gets through.
        try {
            await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (action: () => void) => {
                if (settled) return;
                settled = true;
                cleanup();
                action();
            };
            const timeout = window.setTimeout(
                () =>
                    finish(() =>
                        reject(new Error("OAuth authorization timed out.")),
                    ),
                5 * 60 * 1000,
            );
            // Self-rescheduling poll rather than a fixed setInterval. Two reasons:
            // (1) we back the cadence off from 1.5s to 5s after the first minute
            // — the happy path resolves in seconds, so a user slowly reading a
            // consent screen shouldn't generate ~200 authenticated GETs over the
            // five-minute window; (2) chaining the next poll only after the
            // previous read settles guarantees we never stack requests on a slow
            // connection.
            const pollStarted = Date.now();
            let pollTimer = 0;
            const scheduleNextPoll = () => {
                const elapsed = Date.now() - pollStarted;
                const delay = elapsed < 60_000 ? 1500 : 5000;
                pollTimer = window.setTimeout(runPoll, delay);
            };
            const runPoll = () => {
                void getMcpConnector(connectorId)
                    .then((connector) => {
                        if (settled) return;
                        if (connector.oauthConnected) {
                            finish(resolve);
                            return;
                        }
                        scheduleNextPoll();
                    })
                    .catch(() => {
                        // Transient read errors shouldn't abort the wait.
                        if (!settled) scheduleNextPoll();
                    });
            };
            const onAbort = () =>
                finish(() => reject(new McpOAuthCancelledError()));
            const cleanup = () => {
                window.clearTimeout(timeout);
                window.clearTimeout(pollTimer);
                signal.removeEventListener("abort", onAbort);
                window.removeEventListener("message", onMessage);
            };
            const onMessage = (event: MessageEvent<McpOAuthPopupMessage>) => {
                if (event.origin !== expectedCallbackOrigin) return;
                if (event.data?.type !== "mcp_oauth_result") return;
                if (
                    event.data.connectorId &&
                    event.data.connectorId !== connectorId
                ) {
                    return;
                }
                const sourceWindow = event.source as Window | null;
                sourceWindow?.postMessage(
                    { type: "mcp_oauth_result_ack" },
                    event.origin,
                );
                if (event.data.success) {
                    finish(resolve);
                    return;
                }
                finish(() =>
                    reject(
                        new Error(
                            event.data.detail || "OAuth authorization failed.",
                        ),
                    ),
                );
            };
            window.addEventListener("message", onMessage);
            signal.addEventListener("abort", onAbort);
            // Everything (cleanup, onMessage, onAbort) is now defined, so it is
            // safe to both start polling and honour an abort that may already
            // have fired before we finished wiring up.
            scheduleNextPoll();
            if (signal.aborted) onAbort();
            });
        } finally {
            if (oauthAbortRef.current === abortController) {
                oauthAbortRef.current = null;
            }
            try {
                popup.close();
            } catch {
                // COOP may block closing a severed popup; it self-closes anyway.
            }
        }

        const refreshed = await refreshMcpConnectorTools(connectorId);
        replaceConnector(refreshed);
        return refreshed;
    };

    const handleCreate = async () => {
        await runSensitiveAction({ type: "create" }, async () => {
            setBusyKey("create");
            setAddStep("working");
            setAddError(null);
            setAddAuthMessage(null);
            // Kept outside the try so the setup-required branch below can
            // hand the already-created connector to the details modal.
            let createdConnector: McpConnectorSummary | null = null;
            try {
                const headers = parseCustomHeaders(addDraft.customHeaders);
                const connector = await createMcpConnector({
                    name: addDraft.name,
                    serverUrl: addDraft.serverUrl,
                    bearerToken: addDraft.bearerToken.trim() || null,
                    ...(headers ? { headers } : {}),
                });
                createdConnector = connector;
                let refreshed: McpConnectorSummary;
                try {
                    refreshed = await refreshMcpConnectorTools(connector.id);
                } catch (err) {
                    if (
                        err instanceof MikeApiError &&
                        err.code === "oauth_required"
                    ) {
                        replaceConnector(connector);
                        setAddAuthMessage(
                            "Complete authorization in the popup to finish connecting this MCP server.",
                        );
                        setAddStep("auth");
                        const authorized = await connectConnectorOAuth(
                            connector.id,
                        );
                        if (authorized) {
                            setAddAuthMessage(null);
                            setAddResult(authorized);
                            setAddStep("success");
                        }
                        return;
                    }
                    throw err;
                }
                replaceConnector(refreshed);
                if (isGoogleMcpConnector(refreshed) && !refreshed.oauthConnected) {
                    setAddAuthMessage(
                        "Authorize Google in the popup to finish connecting this MCP server.",
                    );
                    setAddStep("auth");
                    const authorized = await connectConnectorOAuth(refreshed.id);
                    if (authorized) {
                        setAddAuthMessage(null);
                        setAddResult(authorized);
                        setAddStep("success");
                    }
                    return;
                }
                setAddResult(refreshed);
                setAddStep("success");
            } catch (err) {
                // A user-initiated cancel (or navigation away) is not a failure:
                // closeAddModal has already reset the modal, so surfacing an
                // error would be noise. Just release the busy lock via `finally`.
                if (err instanceof McpOAuthCancelledError) {
                    return;
                }
                setAddStep("form");
                setAddAuthMessage(null);
                if (isConnectorSetupError(err) && createdConnector) {
                    // The connector row exists; only the OAuth start was
                    // refused because this deployment lacks the provider's
                    // OAuth client. Leaving the Add form open would invite a
                    // second Connect click — and a duplicate connector — so
                    // hand over to the new connector's details modal and show
                    // the operator steps there. Refresh re-runs the flow
                    // once the operator has configured the backend.
                    const message = err.message;
                    closeAddModal();
                    await openConnectorDetails(createdConnector.id);
                    setDetailSetupNotice(message);
                    return;
                }
                setAddError(
                    userFacingApiError(err, "Failed to add connector."),
                );
            } finally {
                setBusyKey(null);
            }
        });
    };

    const handleSaveSelectedConnector = async () => {
        if (!selectedConnector) return;
        await runSensitiveAction(
            { type: "save", connectorId: selectedConnector.id },
            async () => {
                setBusyKey(`save:${selectedConnector.id}`);
                setDetailError(null);
        setDetailSetupNotice(null);
                try {
                    const headers = parseCustomHeaders(
                        detailDraft.customHeaders,
                    );
                    const saved = await updateMcpConnector(selectedConnector.id, {
                        name: detailDraft.name,
                        serverUrl: detailDraft.serverUrl,
                        ...(detailDraft.bearerToken.trim()
                            ? { bearerToken: detailDraft.bearerToken.trim() }
                            : {}),
                        ...(headers ? { headers } : {}),
                    });
                    const shouldRefreshTools =
                        saved.serverUrl !== selectedConnector.serverUrl ||
                        !!detailDraft.bearerToken.trim() ||
                        !!headers;
                    const refreshed = shouldRefreshTools
                            ? await refreshMcpConnectorTools(saved.id)
                            : saved;
                    replaceConnector(refreshed, {
                        preserveToolsOnEmpty: !shouldRefreshTools,
                    });
                    setDetailDraft({
                        name: refreshed.name,
                        serverUrl: refreshed.serverUrl,
                        bearerToken: "",
                        customHeaders: "",
                        clearBearerToken: false,
                    });
                } finally {
                    setBusyKey(null);
                }
            },
        );
    };

    const handleClearBearerToken = async (connectorId: string) => {
        await runSensitiveAction(
            { type: "clear-token", connectorId },
            async () => {
                setBusyKey(`clear-token:${connectorId}`);
                setDetailError(null);
        setDetailSetupNotice(null);
                setClearedBearerTokenConnectorId(null);
                try {
                    const saved = await updateMcpConnector(connectorId, {
                        bearerToken: null,
                    });
                    replaceConnector(saved, { preserveToolsOnEmpty: true });
                    setDetailDraft((prev) => ({
                        ...prev,
                        bearerToken: "",
                        clearBearerToken: false,
                    }));
                    setClearedBearerTokenConnectorId(connectorId);
                } finally {
                    setBusyKey(null);
                }
            },
        );
    };

    // Aborts a reconnect's in-flight OAuth wait. Same mechanism closeAddModal
    // uses for the add flow: rejecting the wait with McpOAuthCancelledError,
    // which handleRefresh treats as "abandoned on purpose", not a failure.
    const cancelReconnectOAuth = () => {
        oauthAbortRef.current?.abort();
        oauthAbortRef.current = null;
    };

    const handleRefresh = async (connectorId: string) => {
        await runSensitiveAction({ type: "refresh", connectorId }, async () => {
            setBusyKey(`refresh:${connectorId}`);
            try {
                try {
                    replaceConnector(await refreshMcpConnectorTools(connectorId));
                } catch (err) {
                    if (
                        err instanceof MikeApiError &&
                            err.code === "oauth_required"
                    ) {
                        // COOP-strict providers make the consent popup's fate
                        // unobservable, so without an explicit escape hatch a
                        // closed popup would leave the Refresh button stuck
                        // busy for the full five-minute timeout. Surface the
                        // Cancel affordance while the wait runs, and treat a
                        // user-initiated cancel as a quiet reset rather than
                        // an error.
                        setReconnectingConnectorId(connectorId);
                        try {
                            await connectConnectorOAuth(connectorId);
                        } catch (oauthErr) {
                            if (oauthErr instanceof McpOAuthCancelledError) {
                                return;
                            }
                            throw oauthErr;
                        } finally {
                            setReconnectingConnectorId((current) =>
                                current === connectorId ? null : current,
                            );
                        }
                        return;
                    }
                    throw err;
                }
            } finally {
                setBusyKey(null);
            }
        });
    };

    const handleConnectorEnabled = async (
        connectorId: string,
        enabled: boolean,
    ) => {
        await runSensitiveAction(
            { type: "connector-enabled", connectorId, enabled },
            async () => {
                setBusyKey(`connector:${connectorId}`);
                try {
                    replaceConnector(
                        await updateMcpConnector(connectorId, { enabled }),
                        { preserveToolsOnEmpty: true },
                    );
                } finally {
                    setBusyKey(null);
                }
            },
        );
    };

    const handleToolEnabled = async (
        connectorId: string,
        toolId: string,
        enabled: boolean,
    ) => {
        await runSensitiveAction(
            { type: "tool-enabled", connectorId, toolId, enabled },
            async () => {
                setBusyKey(`tool:${toolId}`);
                try {
                    replaceConnector(
                        await setMcpToolEnabled(connectorId, toolId, enabled),
                    );
                } finally {
                    setBusyKey(null);
                }
            },
        );
    };

    const handleDelete = async (connectorId: string) => {
        await runSensitiveAction({ type: "delete", connectorId }, async () => {
            setBusyKey(`delete:${connectorId}`);
            try {
                await deleteMcpConnector(connectorId);
                setConnectors((prev) =>
                    prev.filter((item) => item.id !== connectorId),
                );
                if (selectedConnectorId === connectorId) {
                    setSelectedConnectorId(null);
                    setSelectedConnectorDetails(null);
                }
            } finally {
                setBusyKey(null);
            }
        });
    };

    const handleMfaVerified = async () => {
        const action = pendingMfaAction;
        setPendingMfaAction(null);
        if (!action) return;
        if (action.type === "create") await handleCreate();
        if (action.type === "drive-connect") {
            await googleDriveHandleRef.current?.connect();
        }
        if (action.type === "drive-disconnect") {
            await googleDriveHandleRef.current?.disconnect();
        }
        if (action.type === "save") await handleSaveSelectedConnector();
        if (action.type === "clear-token") {
            await handleClearBearerToken(action.connectorId);
        }
        if (action.type === "refresh") await handleRefresh(action.connectorId);
        if (action.type === "delete") await handleDelete(action.connectorId);
        if (action.type === "connector-enabled") {
            await handleConnectorEnabled(action.connectorId, action.enabled);
        }
        if (action.type === "tool-enabled") {
            await handleToolEnabled(
                action.connectorId,
                action.toolId,
                action.enabled,
            );
        }
    };

    return (
        <div>
            <div className="mb-4">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="font-serif text-2xl font-medium text-gray-900">
                        Connectors
                    </h2>
                    <div className="flex shrink-0 items-center rounded-full border border-white/70 bg-app-surface p-0.5 shadow-[0_8px_24px_rgba(15,23,42,0.06)] backdrop-blur-2xl">
                        <button
                            type="button"
                            onClick={() => setAddOpen(true)}
                            className={`flex h-6 items-center justify-center gap-1 rounded-full px-2.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-900 ${LIQUID_GLASS_HOVER_CLASS} ${LIQUID_GLASS_PRESSED_CLASS}`}
                        >
                            <Plus className="h-3.5 w-3.5" />
                            Add
                        </button>
                    </div>
                </div>
            </div>

            {error && (
                <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                </div>
            )}

            <div className="mb-3">
                <GoogleDriveCard
                    runSensitiveAction={runSensitiveAction}
                    handleRef={googleDriveHandleRef}
                />
            </div>

            <div className="space-y-3">
                {!loading &&
                    (connectors.length === 0 ? (
                        <SettingsSection>
                            <p className="p-4 text-sm text-gray-500">
                                No connectors yet.
                            </p>
                        </SettingsSection>
                    ) : (
                        connectors.map((connector) => (
                            <ConnectorRow
                                key={connector.id}
                                connector={connector}
                                busyKey={busyKey}
                                onOpen={() =>
                                    void openConnectorDetails(connector.id)
                                }
                                onConnectorEnabled={handleConnectorEnabled}
                            />
                        ))
                    ))}
            </div>

            <NewMcpModal
                open={addOpen}
                draft={addDraft}
                step={addStep}
                result={addResult}
                error={addError}
                authMessage={addAuthMessage}
                showToken={showAddToken}
                showAdvanced={showAddAdvanced}
                onDraftChange={setAddDraft}
                onShowTokenChange={setShowAddToken}
                onShowAdvancedChange={setShowAddAdvanced}
                onClose={closeAddModal}
                onSubmit={handleCreate}
                onOpenConnector={(connectorId) => {
                    void openConnectorDetails(connectorId);
                    closeAddModal();
                }}
            />

            <McpConnectorDetailsModal
                connector={selectedConnector}
                draft={detailDraft}
                error={detailError}
                setupNotice={detailSetupNotice}
                busyKey={busyKey}
                toolsLoading={loadingConnectorId === selectedConnectorId}
                clearTokenStatus={
                    selectedConnectorId &&
                    busyKey === `clear-token:${selectedConnectorId}`
                        ? "clearing"
                        : selectedConnectorId === clearedBearerTokenConnectorId
                          ? "cleared"
                          : "idle"
                }
                showToken={showDetailToken}
                showAdvanced={showDetailAdvanced}
                onDraftChange={setDetailDraft}
                onShowTokenChange={setShowDetailToken}
                onShowAdvancedChange={setShowDetailAdvanced}
                onClose={() => {
                    setSelectedConnectorId(null);
                    setSelectedConnectorDetails(null);
                }}
                onSave={handleSaveSelectedConnector}
                onClearBearerToken={handleClearBearerToken}
                onRefresh={handleRefresh}
                reconnectingOAuth={
                    !!selectedConnectorId &&
                    reconnectingConnectorId === selectedConnectorId
                }
                onCancelReconnectOAuth={cancelReconnectOAuth}
                onDelete={handleDelete}
                onConnectorEnabled={handleConnectorEnabled}
                onToolEnabled={handleToolEnabled}
            />

            <MfaVerificationPopup
                open={!!pendingMfaAction}
                onCancel={() => setPendingMfaAction(null)}
                onVerified={() => void handleMfaVerified()}
            />
        </div>
    );
}

function ConnectorRow({
    connector,
    busyKey,
    onOpen,
    onConnectorEnabled,
}: {
    connector: McpConnectorSummary;
    busyKey: string | null;
    onOpen: () => void;
    onConnectorEnabled: (
        connectorId: string,
        enabled: boolean,
    ) => Promise<void>;
}) {
    const toolCount = connector.toolCount ?? connector.tools.length;

    return (
        <SettingsSection>
            <div
                className="cursor-pointer rounded-xl px-4 py-3 transition-colors hover:bg-white/70"
                role="button"
                tabIndex={0}
                onClick={onOpen}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpen();
                    }
                }}
            >
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-3">
                    <div className="min-w-0 text-left">
                        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-gray-700">
                            <span className="truncate">{connector.name}</span>
                            <span className="h-1 w-1 rounded-full bg-gray-300" />
                            <span className="shrink-0 text-xs font-medium text-gray-500">
                                {toolCount}{" "}
                                {toolCount === 1 ? "tool" : "tools"}
                            </span>
                        </h3>
                    </div>
                    <div
                        className="shrink-0 justify-self-end"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <SettingsToggle
                            checked={connector.enabled}
                            disabled={busyKey === `connector:${connector.id}`}
                            loading={busyKey === `connector:${connector.id}`}
                            label={connector.enabled ? "Enabled" : "Disabled"}
                            onChange={(enabled) =>
                                void onConnectorEnabled(connector.id, enabled)
                            }
                        />
                    </div>
                    <p className="min-w-0 truncate text-xs text-gray-500">
                        {connector.serverUrl}
                    </p>
                    <button
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation();
                            onOpen();
                        }}
                        className="shrink-0 justify-self-end text-xs font-medium text-gray-500 transition-colors hover:text-gray-950"
                    >
                        Details
                    </button>
                </div>
            </div>
        </SettingsSection>
    );
}

function McpConnectorDetailsModal({
    connector,
    draft,
    error,
    setupNotice,
    busyKey,
    toolsLoading,
    clearTokenStatus,
    showToken,
    showAdvanced,
    onDraftChange,
    onShowTokenChange,
    onShowAdvancedChange,
    onClose,
    onSave,
    onClearBearerToken,
    onRefresh,
    reconnectingOAuth,
    onCancelReconnectOAuth,
    onDelete,
    onConnectorEnabled,
    onToolEnabled,
}: {
    connector: McpConnectorSummary | null;
    draft: DetailDraft;
    error: string | null;
    setupNotice: string | null;
    busyKey: string | null;
    toolsLoading: boolean;
    clearTokenStatus: "idle" | "clearing" | "cleared";
    showToken: boolean;
    showAdvanced: boolean;
    onDraftChange: (draft: DetailDraft) => void;
    onShowTokenChange: (show: boolean) => void;
    onShowAdvancedChange: (show: boolean) => void;
    onClose: () => void;
    onSave: () => Promise<void>;
    onClearBearerToken: (connectorId: string) => Promise<void>;
    onRefresh: (connectorId: string) => Promise<void>;
    reconnectingOAuth: boolean;
    onCancelReconnectOAuth: () => void;
    onDelete: (connectorId: string) => Promise<void>;
    onConnectorEnabled: (
        connectorId: string,
        enabled: boolean,
    ) => Promise<void>;
    onToolEnabled: (
        connectorId: string,
        toolId: string,
        enabled: boolean,
    ) => Promise<void>;
}) {
    const hasChanges =
        !!connector &&
        (draft.name.trim() !== connector.name ||
            draft.serverUrl.trim() !== connector.serverUrl ||
            draft.bearerToken.trim().length > 0 ||
            draft.customHeaders.trim().length > 0);
    const isSaving = !!connector && busyKey === `save:${connector.id}`;

    return (
        <Modal
            open={!!connector}
            onClose={onClose}
            breadcrumbs={["Connectors", connector?.name ?? "MCP connector"]}
            headerAction={
                connector ? (
                    <SettingsToggle
                        checked={connector.enabled}
                        disabled={busyKey === `connector:${connector.id}`}
                        loading={busyKey === `connector:${connector.id}`}
                        label={connector.enabled ? "Enabled" : "Disabled"}
                        onChange={(enabled) =>
                            void onConnectorEnabled(connector.id, enabled)
                        }
                    />
                ) : null
            }
            size="md"
            secondaryAction={
                connector
                    ? {
                          label: "Delete connector",
                          variant: "danger",
                          onClick: () => void onDelete(connector.id),
                          disabled: busyKey === `delete:${connector.id}`,
                      }
                    : undefined
            }
            primaryAction={{
                label: isSaving ? "Saving..." : "Save",
                icon: isSaving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                ) : undefined,
                onClick: () => void onSave(),
                disabled:
                    !connector ||
                    !hasChanges ||
                    isSaving ||
                    !draft.name.trim() ||
                    !draft.serverUrl.trim(),
            }}
            cancelAction={{ label: "Close", onClick: onClose }}
            footerStatus={
                error ? (
                    <span className="text-sm text-red-600">{error}</span>
                ) : null
            }
        >
            {connector && (
                <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pb-4">
                    {setupNotice && <ConnectorSetupNotice text={setupNotice} />}
                    <ConnectorForm
                        draft={draft}
                        showToken={showToken}
                        showAdvanced={showAdvanced}
                        tokenPlaceholder={
                            connector.hasAuthConfig
                                ? "Saved token encrypted"
                                : "Bearer token"
                        }
                        tokenAction={
                            connector.hasAuthConfig ||
                            clearTokenStatus === "cleared"
                                ? {
                                      label:
                                          clearTokenStatus === "cleared"
                                              ? "Cleared"
                                              : "Clear",
                                      loading:
                                          clearTokenStatus === "clearing",
                                      cleared:
                                          clearTokenStatus === "cleared",
                                      onClick: () =>
                                          void onClearBearerToken(connector.id),
                                  }
                                : undefined
                        }
                        onDraftChange={(next) =>
                            onDraftChange({
                                ...draft,
                                name: next.name,
                                serverUrl: next.serverUrl,
                                bearerToken: next.bearerToken,
                                customHeaders: next.customHeaders,
                            })
                        }
                        onShowTokenChange={onShowTokenChange}
                        onShowAdvancedChange={onShowAdvancedChange}
                    />
                    <div className="flex min-h-0 flex-1 flex-col">
                        <div className="mb-2 flex items-center justify-between">
                            <h3 className="text-xs font-medium text-gray-500">
                                {toolsLoading
                                    ? connector.toolCount
                                    : connector.tools.length}{" "}
                                {(toolsLoading
                                    ? connector.toolCount
                                    : connector.tools.length) === 1
                                    ? "Tool"
                                    : "Tools"}
                            </h3>
                            <div className="flex items-center gap-3">
                                {reconnectingOAuth && (
                                    <button
                                        type="button"
                                        onClick={onCancelReconnectOAuth}
                                        className="text-xs font-medium text-gray-500 transition-colors hover:text-gray-900"
                                    >
                                        Cancel
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => void onRefresh(connector.id)}
                                    disabled={
                                        busyKey === `refresh:${connector.id}`
                                    }
                                    className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition-colors hover:text-gray-900 disabled:cursor-not-allowed disabled:text-gray-300"
                                >
                                    {busyKey === `refresh:${connector.id}` ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <RefreshCw className="h-3.5 w-3.5" />
                                    )}
                                    Refresh
                                </button>
                            </div>
                        </div>
                        {toolsLoading ? (
                            <ToolListSkeleton count={connector.toolCount} fill />
                        ) : (
                            <ScrollableToolList
                                connector={connector}
                                busyKey={busyKey}
                                onToolEnabled={onToolEnabled}
                                fill
                            />
                        )}
                    </div>
                </div>
            )}
        </Modal>
    );
}

function ConnectorForm({
    draft,
    showToken,
    showAdvanced,
    showTokenNote = false,
    tokenPlaceholder,
    tokenAction,
    disabled = false,
    onDraftChange,
    onShowTokenChange,
    onShowAdvancedChange,
}: {
    draft: AddDraft;
    showToken: boolean;
    showAdvanced: boolean;
    showTokenNote?: boolean;
    tokenPlaceholder: string;
    tokenAction?: {
        label: string;
        active?: boolean;
        loading?: boolean;
        cleared?: boolean;
        onClick: () => void;
    };
    disabled?: boolean;
    onDraftChange: (draft: AddDraft) => void;
    onShowTokenChange: (show: boolean) => void;
    onShowAdvancedChange: (show: boolean) => void;
}) {
    return (
        <div className="grid gap-3 pt-1">
            <div className="grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center">
                <FieldLabel htmlFor="connector-config-label">Label</FieldLabel>
                <SettingsTextInput
                    id="connector-config-label"
                    value={draft.name}
                    onChange={(event) =>
                        onDraftChange({ ...draft, name: event.target.value })
                    }
                    placeholder="Connector label"
                    className="h-8"
                    disabled={disabled}
                />
            </div>
            <div className="grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center">
                <FieldLabel htmlFor="connector-config-url">
                    URL endpoint
                </FieldLabel>
                <SettingsTextInput
                    id="connector-config-url"
                    value={draft.serverUrl}
                    onChange={(event) =>
                        onDraftChange({
                            ...draft,
                            serverUrl: event.target.value,
                        })
                    }
                    placeholder="https://mcp.example.com/mcp"
                    className="h-8"
                    disabled={disabled}
                />
            </div>
            <div className="grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-start">
                <FieldLabel htmlFor="connector-config-token">
                    Bearer token
                </FieldLabel>
                <div className="min-w-0">
                    <div className="relative">
                        <SettingsTextInput
                            id="connector-config-token"
                            value={draft.bearerToken}
                            onChange={(event) =>
                                onDraftChange({
                                    ...draft,
                                    bearerToken: event.target.value,
                                })
                            }
                            type={showToken ? "text" : "password"}
                            placeholder={tokenPlaceholder}
                            className={`h-8 ${
                                tokenAction
                                    ? draft.bearerToken
                                        ? "pr-[6.5rem]"
                                        : "pr-16"
                                    : "pr-10"
                            }`}
                            autoComplete="off"
                            spellCheck={false}
                            disabled={disabled}
                        />
                        {draft.bearerToken && (
                            <button
                                type="button"
                                className={`absolute inset-y-1 ${
                                    tokenAction ? "right-[3.75rem]" : "right-1.5"
                                } flex items-center ${settingsGlassIconButtonClassName}`}
                                onClick={() => onShowTokenChange(!showToken)}
                                aria-label={
                                    showToken ? "Hide token" : "Show token"
                                }
                                disabled={disabled}
                            >
                                {showToken ? (
                                    <EyeOff className="h-4 w-4" />
                                ) : (
                                    <Eye className="h-4 w-4" />
                                )}
                            </button>
                        )}
                        {tokenAction && (
                            <button
                                type="button"
                                onClick={tokenAction.onClick}
                                disabled={
                                    disabled ||
                                    tokenAction.loading ||
                                    tokenAction.cleared
                                }
                                className={`absolute inset-y-1 right-1.5 px-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:text-gray-300 ${
                                    tokenAction.active || tokenAction.cleared
                                        ? "text-red-600 hover:text-red-700"
                                        : "text-gray-500 hover:text-gray-900"
                                }`}
                            >
                                <span className="inline-flex items-center gap-1">
                                    {tokenAction.label}
                                    {tokenAction.loading && (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                    )}
                                </span>
                            </button>
                        )}
                    </div>
                    {showTokenNote && (
                        <p className="mt-1 text-right text-xs text-gray-500">
                            Tokens are stored encrypted.
                        </p>
                    )}
                </div>
            </div>
            <div className="grid gap-2">
                <button
                    type="button"
                    onClick={() => onShowAdvancedChange(!showAdvanced)}
                    className="inline-flex items-center gap-1 justify-self-start text-xs font-medium text-gray-500 transition-colors hover:text-gray-900"
                    disabled={disabled}
                >
                    Advanced
                    <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform ${
                            showAdvanced ? "" : "-rotate-90"
                        }`}
                    />
                </button>
                {showAdvanced && (
                    <div className="grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-start">
                        <FieldLabel htmlFor="connector-config-headers">
                            Custom headers
                        </FieldLabel>
                        <div className="min-w-0">
                            <textarea
                                id="connector-config-headers"
                                value={draft.customHeaders}
                                onChange={(event) =>
                                    onDraftChange({
                                        ...draft,
                                        customHeaders: event.target.value,
                                    })
                                }
                                placeholder='{"X-API-Key":"secret"}'
                                className={`min-h-20 resize-y py-2 ${SETTINGS_CONTROL_CLASS}`}
                                autoComplete="off"
                                spellCheck={false}
                                disabled={disabled}
                            />
                            <p className="mt-1 text-right text-xs text-gray-500">
                                Secrets are stored encrypted.
                            </p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function ToolListSkeleton({
    count,
    fill = false,
}: {
    count: number;
    fill?: boolean;
}) {
    const rowCount = Math.min(Math.max(count || 3, 3), 8);
    return (
        <div
            className={`overflow-hidden rounded-lg border border-gray-100 bg-white/60 ${
                fill ? "min-h-0 flex-1" : "max-h-72"
            }`}
        >
            <div>
                {Array.from({ length: rowCount }).map((_, index) => (
                    <div key={index} className="px-3 py-2">
                        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
                            <div className="h-5 w-5" />
                            <div className="h-3.5 w-full max-w-[220px] animate-pulse rounded bg-gray-100" />
                            <div className="h-4 w-7 animate-pulse rounded-full bg-gray-100" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function ScrollableToolList({
    connector,
    busyKey,
    onToolEnabled,
    fill = false,
}: {
    connector: McpConnectorSummary;
    busyKey?: string | null;
    onToolEnabled?: (
        connectorId: string,
        toolId: string,
        enabled: boolean,
    ) => Promise<void>;
    fill?: boolean;
}) {
    const [expandedToolId, setExpandedToolId] = useState<string | null>(null);

    if (connector.tools.length === 0) {
        return (
            <div
                className={`rounded-lg bg-gray-50 px-3 py-3 text-sm text-gray-500 ${
                    fill ? "min-h-0 flex-1" : ""
                }`}
            >
                No tools discovered yet.
            </div>
        );
    }

    return (
        <div
            className={`overflow-y-auto rounded-lg border border-gray-100 bg-white/60 ${
                fill ? "min-h-0 flex-1" : "max-h-72"
            }`}
        >
            <div>
                {connector.tools.map((tool) => {
                    const disabled =
                        !onToolEnabled ||
                        busyKey === `tool:${tool.id}` ||
                        tool.requiresConfirmation;
                    const isExpanded = expandedToolId === tool.id;
                    const toolLabel = tool.title || tool.toolName;
                    return (
                        <div key={tool.id} className="px-3 py-2">
                            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() =>
                                        setExpandedToolId(
                                            isExpanded ? null : tool.id,
                                        )
                                    }
                                    className="inline-flex h-5 w-5 items-center justify-center text-gray-400 transition-colors hover:text-gray-800"
                                    aria-label={`${
                                        isExpanded ? "Collapse" : "Expand"
                                    } ${toolLabel}`}
                                >
                                    <ChevronDown
                                        className={`h-3.5 w-3.5 transition-transform ${
                                            isExpanded ? "" : "-rotate-90"
                                        }`}
                                    />
                                </button>
                                <p className="min-w-0 truncate text-sm font-medium text-gray-700">
                                    {toolLabel}
                                </p>
                                {onToolEnabled ? (
                                    <SettingsToggle
                                        checked={tool.enabled}
                                        disabled={disabled}
                                        loading={busyKey === `tool:${tool.id}`}
                                        onChange={(enabled) =>
                                            void onToolEnabled(
                                                connector.id,
                                                tool.id,
                                                enabled,
                                            )
                                        }
                                    />
                                ) : (
                                    <span
                                        className={`text-xs font-medium ${
                                            tool.enabled
                                                ? "text-green-600"
                                                : "text-gray-500"
                                        }`}
                                    >
                                        {tool.enabled ? "Enabled" : "Disabled"}
                                    </span>
                                )}
                            </div>
                            {isExpanded && (
                                <div className="ml-7 mt-2 min-w-0">
                                    {tool.requiresConfirmation && (
                                        <p className="text-xs font-medium text-amber-700">
                                            Confirmation required
                                        </p>
                                    )}
                                    {tool.description && (
                                        <p className="mt-1 text-xs text-gray-500">
                                            {tool.description}
                                        </p>
                                    )}
                                    <p className="mt-1 break-all font-mono text-[11px] text-gray-400">
                                        {tool.openaiToolName}
                                    </p>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
