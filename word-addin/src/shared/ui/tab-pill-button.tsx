"use client";

import * as React from "react";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@mike/liquid-glass-ui";
import { cn } from "../lib/utils";

type TabPillButtonProps = React.ComponentProps<"button"> & {
    active?: boolean;
};

/**
 * Duplicated from the web app's glass pill tab
 * (frontend/src/app/components/ui/tab-pill-button.tsx) so the pane's tab bar
 * looks exactly like the web's. The visuals come from the SAME shared
 * LiquidGlassUI constants and classes as the web (the add-in imports
 * LiquidGlassUI.css and lists LiquidGlassUI.ts as a Tailwind source), so
 * only the import paths may differ from the web file — keep the class
 * strings below byte-identical to the web's when either side changes.
 */
export function TabPillButton({
    active,
    type = "button",
    className,
    ...props
}: TabPillButtonProps) {
    const stateClass =
        active === true
            ? "border-white/80 bg-white text-gray-900"
            : active === false
              ? `${LIQUID_GLASS_HOVER_CLASS} text-gray-400 hover:text-gray-700`
              : `${LIQUID_GLASS_HOVER_CLASS} text-gray-700 hover:text-gray-900`;

    return (
        <button
            type={type}
            aria-pressed={active}
            className={cn(
                `inline-flex h-7 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-medium ${LIQUID_GLASS_SUBTLE_CLASS} backdrop-blur-xl transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-40 disabled:active:scale-100`,
                stateClass,
                className,
            )}
            {...props}
        />
    );
}
