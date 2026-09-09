"use client";

import { createPortal } from "react-dom";
import { useEffect, useId, type ReactNode } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { cn } from "@/app/lib/utils";
import { LIQUID_GLASS_FLOAT_CLASS } from "@/shared/ui/LiquidGlassUI";

type ConfirmStatus = "idle" | "loading" | "complete";

interface ConfirmPopupProps {
  open: boolean;
  title?: ReactNode;
  message?: ReactNode;
  confirmLabel?: ReactNode;
  confirmVariant?: "default" | "danger";
  confirmStatus?: ConfirmStatus;
  cancelLabel?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  confirmDisabled?: boolean;
  className?: string;
}

export function ConfirmPopup({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  confirmVariant = "default",
  confirmStatus = "idle",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  confirmDisabled = false,
  className,
}: ConfirmPopupProps) {
  const titleId = useId();

  /**
   * Escape cancels.
   *
   * This popup asks a question and takes the keyboard's attention while it is
   * up, but it answered only to the mouse: there was no way to decline it
   * without finding and clicking Cancel, which is the one thing every other
   * dismissable surface in the app does with Escape. It is also announced as
   * a dialog now — a bare `div` gave screen readers a heading and two buttons
   * that appeared from nowhere, with nothing saying they belong together or
   * that an answer is being asked for.
   */
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;
  const confirmBusy = confirmStatus === "loading";
  const resolvedConfirmDisabled = confirmDisabled || confirmStatus !== "idle";
  const normalizedConfirmLabel =
    typeof confirmLabel === "string" ? confirmLabel : "Confirm";
  const isDangerAction = confirmVariant === "danger";
  const resolvedConfirmLabel =
    confirmStatus === "loading" ? (
      <span className="inline-flex h-full items-center gap-1.5">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        {progressiveLabel(normalizedConfirmLabel)}
      </span>
    ) : confirmStatus === "complete" ? (
      completedLabel(normalizedConfirmLabel)
    ) : isDangerAction ? (
      <span className="inline-flex h-full items-center gap-1.5">
        <Trash2 className="h-3 w-3 shrink-0" />
        {confirmLabel}
      </span>
    ) : (
      confirmLabel
    );

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[230] flex justify-center px-4">
      <div
        role="dialog"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : "Confirm action"}
        className={cn(
          `pointer-events-auto w-[min(92vw,520px)] rounded-2xl px-4 py-3 text-sm ${LIQUID_GLASS_FLOAT_CLASS} backdrop-blur-2xl`,
          className,
        )}
      >
        {title && (
          <div id={titleId} className="text-sm font-medium text-gray-950 mb-3">
            {title}
          </div>
        )}
        {message && (
          <div className={cn("text-xs text-gray-700", title && "mt-1")}>
            {message}
          </div>
        )}
        <div className="mt-3 flex items-center justify-end gap-2">
          <PillButton tone="white" size="sm" onClick={onCancel}>
            {cancelLabel}
          </PillButton>
          <PillButton
            tone={isDangerAction ? "danger" : "black"}
            size="sm"
            onClick={onConfirm}
            disabled={resolvedConfirmDisabled}
            aria-busy={confirmBusy}
          >
            {resolvedConfirmLabel}
          </PillButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function progressiveLabel(label: string) {
  const lower = label.toLowerCase();
  if (lower.endsWith("e")) return `${label.slice(0, -1)}ing...`;
  return `${label}ing...`;
}

function completedLabel(label: string) {
  const lower = label.toLowerCase();
  if (lower.endsWith("e")) return `${label}d`;
  return `${label}ed`;
}
