"use client";

import { useState } from "react";
import { AlertCircle, Check, ChevronDown } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { MODELS } from "@/app/components/assistant/ModelToggle";
import {
    isModelAvailable,
    modelGroupToProvider,
} from "@/app/lib/modelAvailability";

function TabularModelDropdown({
    value,
    onChange,
    apiKeys,
}: {
    value: string;
    onChange: (id: string) => void;
    apiKeys: { claudeApiKey: string | null; geminiApiKey: string | null };
}) {
    const [isOpen, setIsOpen] = useState(false);
    const selected = MODELS.find((m) => m.id === value);
    const selectedAvailable = isModelAvailable(value, apiKeys);
    const groups: ("Anthropic" | "Google")[] = ["Anthropic", "Google"];

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="w-full h-9 rounded-md border border-[#C7C7B2] bg-white px-3 text-sm shadow-sm flex items-center justify-between gap-2 hover:bg-[#F5F5F5] focus:outline-none focus:ring-2 focus:ring-black/10"
                >
                    <span className="flex items-center gap-2 min-w-0">
                        {!selectedAvailable && (
                            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                        )}
                        <span className="truncate text-[#292629]">
                            {selected?.label ?? "Select a model"}
                        </span>
                    </span>
                    <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 text-[#292629]/50 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                className="z-50"
                style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
                align="start"
            >
                {groups.map((group, gi) => {
                    const items = MODELS.filter((m) => m.group === group);
                    if (items.length === 0) return null;
                    return (
                        <div key={group}>
                            {gi > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-[#292629]/40">
                                {group}
                            </DropdownMenuLabel>
                            {items.map((m) => {
                                const provider = modelGroupToProvider(m.group);
                                const available = isModelAvailable(m.id, apiKeys);
                                return (
                                    <DropdownMenuItem
                                        key={m.id}
                                        className="cursor-pointer"
                                        onSelect={() => onChange(m.id)}
                                        title={
                                            !available
                                                ? `${provider === "claude" ? "Claude" : "Gemini"} models are not available`
                                                : undefined
                                        }
                                    >
                                        <span className={`flex-1 ${available ? "" : "text-[#292629]/40"}`}>
                                            {m.label}
                                        </span>
                                        {!available && (
                                            <AlertCircle className="h-3.5 w-3.5 text-red-500 ml-1" />
                                        )}
                                        {m.id === value && available && (
                                            <Check className="h-3.5 w-3.5 text-[#292629]/60 ml-1" />
                                        )}
                                    </DropdownMenuItem>
                                );
                            })}
                        </div>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export default function ModelsPage() {
    const { profile, updateModelPreference } = useUserProfile();

    if (!profile) return null;

    const apiKeys = {
        claudeApiKey: profile.claudeApiKey,
        geminiApiKey: profile.geminiApiKey,
    };

    return (
        <div className="space-y-8">
            <section className="space-y-4">
                <div>
                    <h2 className="text-base font-semibold text-[#292629]">
                        Model Preferences
                    </h2>
                    <p className="text-sm text-[#292629]/50 mt-0.5">
                        Choose which AI model is used for tabular reviews.
                    </p>
                </div>

                <div className="space-y-1.5">
                    <label className="text-sm text-[#292629]/60">
                        Tabular review model
                    </label>
                    <div className="max-w-sm">
                        <TabularModelDropdown
                            value={profile.tabularModel}
                            onChange={(id) => updateModelPreference("tabularModel", id)}
                            apiKeys={apiKeys}
                        />
                    </div>
                </div>
            </section>
        </div>
    );
}
