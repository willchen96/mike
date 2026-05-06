"use client";

import { useState } from "react";
import { Folder, Search, X } from "lucide-react";
import type { MikeProject } from "./types";

interface Props {
    projects: MikeProject[];
    loading: boolean;
    selectedId: string | null;
    onSelect: (id: string | null) => void;
}

export function ProjectPicker({ projects, loading, selectedId, onSelect }: Props) {
    const [search, setSearch] = useState("");
    const q = search.toLowerCase().trim();
    const filtered = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;

    return (
        <>
            <div className="px-4 pt-1 pb-2">
                <div className="flex items-center gap-2 rounded-lg border border-[#C7C7B2] bg-[#F5F5F5] px-3 py-2">
                    <Search className="h-3.5 w-3.5 text-[#292629]/40 shrink-0" />
                    <input
                        type="text"
                        placeholder="Search projects…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="flex-1 bg-transparent text-sm text-[#292629]/80 placeholder:text-[#292629]/40 outline-none"
                        autoFocus
                    />
                    {search && (
                        <button onClick={() => setSearch("")} className="text-[#292629]/40 hover:text-[#292629]/60">
                            <X className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
            </div>
            <div className="flex-1 overflow-y-auto px-4 pb-2">
                {loading ? (
                    <div className="rounded-sm border border-[#C7C7B2]/50 overflow-hidden">
                        <div className="flex items-center px-2 py-2">
                            <div className="h-3 w-14 rounded bg-[#C7C7B2]/40 animate-pulse" />
                        </div>
                        {[65, 45, 80, 55, 70].map((w, i) => (
                            <div key={i} className="flex items-center gap-2 px-2 py-2">
                                <div className="h-3.5 w-3.5 rounded-full border border-[#C7C7B2] shrink-0" />
                                <div className="h-3.5 w-3.5 rounded bg-[#C7C7B2]/40 animate-pulse shrink-0" />
                                <div className="h-3 rounded bg-[#C7C7B2]/40 animate-pulse" style={{ width: `${w}%` }} />
                            </div>
                        ))}
                    </div>
                ) : filtered.length === 0 ? (
                    <p className="text-center text-sm text-[#292629]/40 py-8">
                        {q ? "No matches found" : "No projects yet"}
                    </p>
                ) : (
                    <div className="rounded-sm border border-[#C7C7B2]/50 overflow-hidden">
                        <div className="flex items-center justify-between px-2 py-2">
                            <p className="text-xs font-medium text-[#292629]/40">Projects</p>
                        </div>
                        <div className="space-y-px">
                            {filtered.map((project) => {
                                const isSelected = selectedId === project.id;
                                return (
                                    <button
                                        key={project.id}
                                        onClick={() => onSelect(isSelected ? null : project.id)}
                                        className={`w-full flex items-center gap-2 px-2 py-2 text-xs transition-colors text-left ${isSelected ? "bg-[#F5F5F5]" : "hover:bg-[#F5F5F5]"}`}
                                    >
                                        <span className={`shrink-0 h-3.5 w-3.5 rounded-full border flex items-center justify-center ${isSelected ? "bg-[#292629] border-[#292629]" : "border-[#C7C7B2]"}`}>
                                            {isSelected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                                        </span>
                                        <Folder className="h-3.5 w-3.5 shrink-0 text-[#292629]/40" />
                                        <span className={`flex-1 truncate ${isSelected ? "text-[#292629] font-medium" : "text-[#292629]/80"}`}>
                                            {project.name}
                                            {project.cm_number && (
                                                <span className="ml-1 font-normal text-[#292629]/40">(#{project.cm_number})</span>
                                            )}
                                        </span>
                                        <span className="shrink-0 text-[#292629]/40">{project.document_count ?? 0}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}
