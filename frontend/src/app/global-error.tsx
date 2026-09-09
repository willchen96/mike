"use client";

import { useEffect } from "react";
import { PillButton } from "@/app/components/ui/pill-button";
import { reportError } from "@/app/lib/errorReporting";

export default function GlobalError({
    error,
}: {
    error: Error & { digest?: string };
}) {
    useEffect(() => {
        // The root layout itself failed: nothing else can report this one.
        reportError(error, {
            level: "fatal",
            tags: { component: "global-error-boundary", digest: error.digest },
        });
        console.error("Global error:", error);
    }, [error]);

    return (
        <html lang="en">
            <head>
                <title>Something went wrong – Mike</title>
                <style>{`
                    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=EB+Garamond:wght@400;500&display=swap');
                    
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    
                    body {
                        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
                        background-color: #ffffff;
                        color: #111;
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }

                    .error-container {
                        text-align: center;
                        max-width: 480px;
                        padding: 2rem;
                    }

                    .error-title {
                        font-family: 'EB Garamond', Georgia, serif;
                        font-size: 1.75rem;
                        font-weight: 400;
                        color: #111;
                        margin-bottom: 0.75rem;
                    }

                    .error-message {
                        font-size: 0.9375rem;
                        color: #6b7280;
                        line-height: 1.6;
                        margin-bottom: 2rem;
                    }

                    .btn-back { font-family: 'Inter', sans-serif; }
                `}</style>
            </head>
            <body>
                <div className="error-container">
                    <h1 className="error-title">Something went wrong</h1>
                    <p className="error-message">
                        We encountered an unexpected error. This has been logged
                        and our team will look into it.
                    </p>
                    <PillButton
                        tone="blue"
                        size="normal"
                        className="btn-back"
                        onClick={() => window.history.back()}
                    >
                        Back
                    </PillButton>
                </div>
            </body>
        </html>
    );
}
