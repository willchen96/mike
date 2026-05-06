"use client";

import { File, FileText, Library } from "lucide-react";

interface Props {
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
}

export function UserMessage({ content, files, workflow }: Props) {
    const hasFiles = files && files.length > 0;

    return (
        <div className="w-full flex justify-end">
            <div className="max-w-[80%] bg-[#F5F5F5] rounded-xl px-4 py-3">
                <p className="text-sm text-[#292629] whitespace-pre-wrap">{content}</p>
                {(workflow || hasFiles) && (
                    <div className="flex flex-wrap justify-end gap-1.5 mt-3">
                        {workflow && (
                            <div className="inline-flex items-center gap-1 pl-2 pr-2.5 py-0.5 rounded-full text-xs bg-blue-600 text-white shadow border border-[#898344]">
                                <Library className="h-2.5 w-2.5 shrink-0" />
                                <span className="max-w-[140px] truncate">{workflow.title}</span>
                            </div>
                        )}
                        {hasFiles && files.map((f, i) => {
                            const ext = f.filename.split(".").pop()?.toLowerCase();
                            const isPdf = ext === "pdf";
                            return (
                                <div
                                    key={i}
                                    className="inline-flex items-center gap-1 pl-2 pr-2.5 py-0.5 rounded-full text-xs text-white shadow border border-black bg-[#292629]"
                                >
                                    {isPdf
                                        ? <FileText className="h-2.5 w-2.5 shrink-0 text-red-400" />
                                        : <File className="h-2.5 w-2.5 shrink-0 text-blue-400" />
                                    }
                                    <span className="max-w-[140px] truncate">{f.filename}</span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
