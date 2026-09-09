"use client";

import Link from "next/link";
import { useEffect } from "react";
import { PillButton } from "@/app/components/ui/pill-button";
import { reportError } from "@/app/lib/errorReporting";

export default function Error({
    error,
}: {
    error: Error & { digest?: string };
}) {
    useEffect(() => {
        // A render error that escaped every component boundary. The digest
        // is what Next prints for server-side render errors, so keep it.
        reportError(error, {
            tags: { component: "route-error-boundary", digest: error.digest },
        });
        console.error("App error:", error);
    }, [error]);

    return (
        <div className="min-h-screen bg-white flex items-center justify-center px-4">
            <div className="text-center max-w-md">
                <h1 className="text-3xl font-eb-garamond font-light text-gray-900 mb-3">
                    Something went wrong
                </h1>
                <p className="text-[0.9375rem] text-gray-500 leading-relaxed mb-8">
                    We encountered an unexpected error. This has been logged and
                    our team will look into it.
                </p>

                <PillButton asChild tone="black" size="normal">
                    <Link href="/">Home</Link>
                </PillButton>
            </div>
        </div>
    );
}
