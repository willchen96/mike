"use client";

import { Check, ChevronDown, Eye, EyeOff, Loader2 } from "lucide-react";
import { FieldLabel } from "@/app/components/ui/form-field";
import {
    SETTINGS_CONTROL_CLASS,
    SettingsTextInput,
} from "@/app/components/settings/SettingsTextInput";
import { Modal } from "@/app/components/modals/Modal";
import type { McpConnectorSummary } from "@/app/lib/mikeApi";
import {
    settingsGlassIconButtonClassName,
} from "@/app/(pages)/settings/settingsStyles";

export type NewMcpDraft = {
    name: string;
    serverUrl: string;
    bearerToken: string;
    customHeaders: string;
};

export type NewMcpStep = "form" | "working" | "auth" | "success";

/**
 * Known hosted MCP servers, offered as one-click prefills. Only the fields
 * change — the create flow is identical to a hand-typed server, so presets
 * stay purely presentational. Google Drive is intentionally absent: it ships
 * as a first-party integration (its own card on the Connectors page), not as
 * an MCP connector.
 */
const CONNECTOR_PRESETS: ReadonlyArray<{
    name: string;
    serverUrl: string;
}> = [{ name: "Slack", serverUrl: "https://mcp.slack.com/mcp" }];

interface NewMcpModalProps {
    open: boolean;
    draft: NewMcpDraft;
    step: NewMcpStep;
    result: McpConnectorSummary | null;
    error: string | null;
    authMessage: string | null;
    showToken: boolean;
    showAdvanced: boolean;
    onDraftChange: (draft: NewMcpDraft) => void;
    onShowTokenChange: (show: boolean) => void;
    onShowAdvancedChange: (show: boolean) => void;
    onClose: () => void;
    onSubmit: () => Promise<void>;
    onOpenConnector: (connectorId: string) => void;
}

export function NewMcpModal({
    open,
    draft,
    step,
    result,
    error,
    authMessage,
    showToken,
    showAdvanced,
    onDraftChange,
    onShowTokenChange,
    onShowAdvancedChange,
    onClose,
    onSubmit,
    onOpenConnector,
}: NewMcpModalProps) {
    const canSubmit =
        draft.name.trim().length > 0 &&
        draft.serverUrl.trim().length > 0 &&
        step !== "working" &&
        step !== "auth";

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={[
                "Connectors",
                step === "success"
                    ? "Connector added"
                    : step === "auth"
                      ? "Authenticate connector"
                      : "New MCP connector",
            ]}
            size="lg"
            primaryAction={
                step === "success" && result
                    ? {
                          label: "View connector",
                          onClick: () => onOpenConnector(result.id),
                      }
                    : {
                          label:
                              step === "working"
                                  ? "Connecting..."
                                  : step === "auth"
                                    ? "Authorizing..."
                                    : "Connect",
                          icon:
                              step === "working" || step === "auth" ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                              ) : undefined,
                          onClick: () => void onSubmit(),
                          disabled: !canSubmit,
                      }
            }
            cancelAction={
                // "working" is a brief synchronous create with nothing to
                // interrupt, so it stays uncancellable. "auth" now offers a
                // Cancel button: COOP can sever the popup so the flow may never
                // report a result on its own, and the user needs a reliable
                // escape hatch instead of waiting out the five-minute timeout.
                step === "working"
                    ? false
                    : {
                          label: step === "success" ? "Done" : "Cancel",
                          onClick: onClose,
                      }
            }
            footerStatus={
                error ? (
                    <div className="rounded-xl border border-white/70 bg-white/75 px-3 py-2 text-sm text-red-600 shadow-[0_12px_32px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.75)] backdrop-blur-xl">
                        {error}
                    </div>
                ) : null
            }
        >
            {step === "success" && result ? (
                <NewMcpSuccess connector={result} />
            ) : step === "auth" ? (
                <NewMcpAuth
                    message={
                        authMessage ??
                        "Complete authorization in the popup to finish connecting this MCP server."
                    }
                />
            ) : (
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4">
                    <p className="text-sm text-gray-500">
                        The assistant will have access to this MCP server and
                        its enabled tools.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                        {CONNECTOR_PRESETS.map((preset) => (
                            <button
                                key={preset.serverUrl}
                                type="button"
                                onClick={() =>
                                    onDraftChange({
                                        ...draft,
                                        name: preset.name,
                                        serverUrl: preset.serverUrl,
                                    })
                                }
                                disabled={step === "working"}
                                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-white/70 bg-white/75 px-3 text-xs font-medium text-gray-600 shadow-[0_3px_9px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-xl transition-colors hover:text-gray-900"
                            >
                                {preset.name}{" "}
                                <span className="font-normal text-gray-400">
                                    {new URL(preset.serverUrl).hostname}
                                </span>
                            </button>
                        ))}
                    </div>
                    <NewMcpForm
                        draft={draft}
                        showToken={showToken}
                        showAdvanced={showAdvanced}
                        disabled={step === "working"}
                        onDraftChange={onDraftChange}
                        onShowTokenChange={onShowTokenChange}
                        onShowAdvancedChange={onShowAdvancedChange}
                    />
                </div>
            )}
        </Modal>
    );
}

/**
 * Operator-side setup steps returned by the backend (code
 * `connector_setup_required`). Rendered as guidance, not as a failure of
 * anything the user typed. Lives here next to the Add modal but is shown in
 * the connector details modal, which is where the Add flow hands over when
 * a just-created connector turns out to need deployment-side setup.
 */
export function ConnectorSetupNotice({ text }: { text: string }) {
    return (
        <div
            role="status"
            className="rounded-xl border border-white/70 bg-white/75 px-3 py-2 text-xs text-gray-700 shadow-[0_3px_9px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-xl"
        >
            <p className="font-medium text-gray-900">
                This server needs a one-time setup by the administrator
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words">{text}</p>
        </div>
    );
}

function NewMcpForm({
    draft,
    showToken,
    showAdvanced,
    disabled,
    onDraftChange,
    onShowTokenChange,
    onShowAdvancedChange,
}: {
    draft: NewMcpDraft;
    showToken: boolean;
    showAdvanced: boolean;
    disabled: boolean;
    onDraftChange: (draft: NewMcpDraft) => void;
    onShowTokenChange: (show: boolean) => void;
    onShowAdvancedChange: (show: boolean) => void;
}) {
    return (
        <div className="grid gap-3 pt-1">
            <div className="grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center">
                <FieldLabel htmlFor="new-mcp-label">Label</FieldLabel>
                <SettingsTextInput
                    id="new-mcp-label"
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
                <FieldLabel htmlFor="new-mcp-url">URL endpoint</FieldLabel>
                <SettingsTextInput
                    id="new-mcp-url"
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
                <FieldLabel htmlFor="new-mcp-token">Bearer token</FieldLabel>
                <div className="min-w-0">
                    <div className="relative">
                        <SettingsTextInput
                            id="new-mcp-token"
                            value={draft.bearerToken}
                            onChange={(event) =>
                                onDraftChange({
                                    ...draft,
                                    bearerToken: event.target.value,
                                })
                            }
                            type={showToken ? "text" : "password"}
                            placeholder="Bearer token"
                            className="h-8 pr-10"
                            autoComplete="off"
                            spellCheck={false}
                            disabled={disabled}
                        />
                        {draft.bearerToken && (
                            <button
                                type="button"
                                className={`absolute inset-y-1 right-1.5 flex items-center ${settingsGlassIconButtonClassName}`}
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
                    </div>
                    <p className="mt-1 text-right text-xs text-gray-500">
                        Tokens are stored encrypted.
                    </p>
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
                        <FieldLabel htmlFor="new-mcp-headers">
                            Custom headers
                        </FieldLabel>
                        <div className="min-w-0">
                            <textarea
                                id="new-mcp-headers"
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

function NewMcpSuccess({ connector }: { connector: McpConnectorSummary }) {
    return (
        <div className="flex h-full min-h-0 flex-1 flex-col gap-4 pb-4">
            <div className="flex items-start gap-3 rounded-xl border border-green-100/80 bg-green-50/80 px-3 py-3 text-green-800 shadow-[0_3px_9px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_9px_rgba(255,255,255,0.05)] backdrop-blur-xl">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                <p className="min-w-0 truncate text-sm font-medium">
                    {connector.name} is connected.{" "}
                    <span className="font-normal text-green-700">
                        {connector.tools.length} tools discovered.
                    </span>
                </p>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-gray-100 bg-white/60">
                <div className="max-h-full overflow-y-auto divide-y divide-gray-100">
                    {connector.tools.map((tool) => (
                        <div
                            key={tool.openaiToolName}
                            className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2"
                        >
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-gray-700">
                                    {tool.title ?? tool.openaiToolName}
                                </p>
                                {tool.description && (
                                    <p className="truncate text-xs text-gray-500">
                                        {tool.description}
                                    </p>
                                )}
                            </div>
                            <span className="text-xs text-gray-400">
                                {tool.enabled ? "Enabled" : "Disabled"}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function NewMcpAuth({ message }: { message: string }) {
    return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 pb-4 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/70 bg-white/75 text-gray-700 shadow-[0_3px_9px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_9px_rgba(255,255,255,0.05)] backdrop-blur-xl">
                <Loader2 className="h-4 w-4 animate-spin" />
            </div>
            <div className="max-w-sm space-y-1">
                <h3 className="text-sm font-medium text-gray-700">
                    Authentication required
                </h3>
                <p className="text-sm text-gray-500">{message}</p>
            </div>
        </div>
    );
}
