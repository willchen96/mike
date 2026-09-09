"use client";

import {
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { LIQUID_GLASS_MODAL_CLASS } from "./LiquidGlassUI";
import { X } from "lucide-react";
import { GlassIconButtonUI } from "./GlassIconButtonUI";

export type ModalUISize = "sm" | "md" | "lg" | "xl";

export interface ModalUIProps {
    open: boolean;
    onClose: () => void;
    children: ReactNode;
    breadcrumbs?: ReactNode[];
    headerAction?: ReactNode;
    size?: ModalUISize;
    className?: string;
    ariaLabel?: string;
    footerStatus?: ReactNode;
    primaryAction?: ReactNode;
    secondaryAction?: ReactNode;
    cancelAction?: ReactNode;
    keepMounted?: boolean;
}

const sizeClassName: Record<ModalUISize, string> = {
    sm: "max-w-md",
    md: "max-w-xl",
    lg: "max-w-2xl",
    xl: "max-w-4xl",
};

export function ModalUI({
    open,
    onClose,
    children,
    breadcrumbs,
    headerAction,
    size = "lg",
    className = "",
    ariaLabel,
    footerStatus,
    primaryAction,
    secondaryAction,
    cancelAction,
    keepMounted = false,
}: ModalUIProps) {
    const [hasMounted, setHasMounted] = useState(false);
    const dialogRef = useRef<HTMLElement>(null);
    const onCloseRef = useRef(onClose);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- portals cannot render during SSR
    useEffect(() => setHasMounted(true), []);

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        if (!open) return;
        const previouslyFocused = document.activeElement as HTMLElement | null;
        const dialog = dialogRef.current;
        const focusable = (): HTMLElement[] =>
            dialog
                ? Array.from(
                      dialog.querySelectorAll<HTMLElement>(
                          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
                      ),
                  ).filter((element) => !element.hasAttribute("hidden"))
                : [];

        window.requestAnimationFrame(() => {
            // React's `autoFocus` prop focuses the element on mount but never
            // writes an `autofocus` attribute, so the attribute probe below
            // never matched and this frame stole focus from the intended
            // field to the first focusable (the Close button). If something
            // inside the dialog already holds focus, leave it there.
            const active = document.activeElement as HTMLElement | null;
            if (dialog && active && active !== dialog && dialog.contains(active)) {
                return;
            }
            const target =
                focusable().find((element) =>
                    element.hasAttribute("autofocus"),
                ) ??
                focusable()[0] ??
                dialog;
            target?.focus();
        });

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onCloseRef.current();
                return;
            }
            if (event.key !== "Tab") return;

            const items = focusable();
            if (items.length === 0) {
                event.preventDefault();
                dialog?.focus();
                return;
            }

            const first = items[0]!;
            const last = items[items.length - 1]!;
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            previouslyFocused?.focus();
        };
    }, [open]);

    if (!open && (!keepMounted || !hasMounted)) return null;

    const hasHeader = Boolean(breadcrumbs?.length);
    const hasFooter = Boolean(
        footerStatus || primaryAction || secondaryAction || cancelAction,
    );

    return createPortal(
        <div
            className={`fixed inset-0 z-[200] flex items-center justify-center bg-white/10 px-4 py-4 backdrop-blur-[2px] ${open ? "" : "hidden"}`}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <section
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label={ariaLabel}
                aria-hidden={open ? undefined : true}
                tabIndex={-1}
                className={`flex w-full flex-col rounded-3xl ${LIQUID_GLASS_MODAL_CLASS} backdrop-blur-3xl ${sizeClassName[size]} ${className}`}
            >
                {hasHeader && (
                    <header className="flex items-center justify-between gap-3 p-4 pl-5">
                        <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs leading-none text-gray-400">
                                {breadcrumbs?.map((segment, index) => (
                                    <span
                                        key={index}
                                        className="flex items-center gap-1.5"
                                    >
                                        {index > 0 && <span>›</span>}
                                        <span
                                            className={`truncate ${index === breadcrumbs.length - 1 ? "text-gray-700" : ""}`}
                                        >
                                            {segment}
                                        </span>
                                    </span>
                                ))}
                            </div>
                            {headerAction}
                        </div>
                        <GlassIconButtonUI onClick={onClose} aria-label="Close">
                            <X className="h-3.5 w-3.5" />
                        </GlassIconButtonUI>
                    </header>
                )}

                <div className="flex min-h-0 flex-1 flex-col px-5">
                    {children}
                </div>

                {hasFooter && (
                    <footer
                        className={`flex items-center gap-3 border-t border-white/60 p-3 ${secondaryAction ? "justify-between" : "justify-end"}`}
                    >
                        {secondaryAction && (
                            <div className="flex min-w-0 items-center gap-2">
                                {secondaryAction}
                            </div>
                        )}
                        <div className="flex items-center gap-2">
                            {footerStatus}
                            {cancelAction}
                            {primaryAction}
                        </div>
                    </footer>
                )}
            </section>
        </div>,
        document.body,
    );
}
