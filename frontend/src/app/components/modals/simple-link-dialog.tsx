import { X, Link2, Check } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

interface SimpleLinkDialogProps {
    isOpen: boolean;
    onClose: () => void;
    shareUrl: string | null;
}

export function SimpleLinkDialog({
    isOpen,
    onClose,
    shareUrl,
}: SimpleLinkDialogProps) {
    const [linkCopied, setLinkCopied] = useState(false);

    if (!isOpen) return null;

    const handleCopyLink = async () => {
        if (!shareUrl) return;
        try {
            await navigator.clipboard.writeText(shareUrl);
            setLinkCopied(true);
            setTimeout(() => setLinkCopied(false), 2000);
        } catch (err) {}
    };

    return createPortal(
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-[#292629]/50 z-[199]"
                onClick={onClose}
            />

            {/* Dialog */}
            <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[200] w-full max-w-md px-4">
                <div className="relative bg-white rounded-2xl shadow-2xl p-6">
                    {/* Close Button */}
                    <button
                        onClick={onClose}
                        className="absolute right-4 top-4 text-[#292629]/40 hover:text-[#292629]/60 transition-colors"
                    >
                        <X className="h-5 w-5" />
                    </button>

                    {/* Header */}
                    <div className="flex items-center justify-between mb-6">
                        <h2 className="text-3xl font-light font-sans text-[#292629]">
                            Share Chat
                        </h2>
                    </div>

                    {/* Content */}
                    <div className="space-y-4">
                        {/* Link display */}
                        <div className="bg-[#F5F5F5] rounded-lg p-3 border border-[#C7C7B2]">
                            <p className="text-sm text-[#292629]/60 mb-2 font-medium">
                                Share Link
                            </p>
                            <p className="text-sm text-[#292629]/90 break-all font-mono">
                                {shareUrl}
                            </p>
                        </div>

                        {/* Copy button */}
                        <button
                            onClick={handleCopyLink}
                            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white py-2.5 px-4 rounded-lg transition-colors font-medium"
                        >
                            {linkCopied ? (
                                <>
                                    <Check className="h-5 w-5" />
                                    Copied!
                                </>
                            ) : (
                                <>
                                    <Link2 className="h-5 w-5" />
                                    Copy Link
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </>,
        document.body,
    );
}
