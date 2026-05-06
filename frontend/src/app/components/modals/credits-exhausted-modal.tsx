import { X } from "lucide-react";
import { createPortal } from "react-dom";

interface CreditsExhaustedModalProps {
    isOpen: boolean;
    onClose: () => void;
    resetDate: string;
}

export function CreditsExhaustedModal({
    isOpen,
    onClose,
    resetDate,
}: CreditsExhaustedModalProps) {
    if (!isOpen) return null;

    // Format the reset date
    const formatResetDate = (dateString: string) => {
        const date = new Date(dateString);
        return date.toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
        });
    };

    return createPortal(
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-[#292629]/50 z-[200]"
                onClick={onClose}
            />

            {/* Modal */}
            <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[201] w-full max-w-md px-4">
                <div className="relative bg-white rounded-2xl shadow-2xl p-6">
                    {/* Header */}
                    <div className="flex items-start justify-between mb-4">
                        <h2 className="text-3xl font-light font-sans text-[#292629]">
                            Message Limit Reached
                        </h2>
                    </div>

                    {/* Content */}
                    <div className="space-y-4">
                        <p className="text-[#292629]/60">
                            You've reached your monthly message limit of 100
                            messages.
                        </p>

                        <div className="bg-[#F5F5F5] border border-[#898344] rounded-lg p-4">
                            <p className="text-sm text-blue-900 font-medium mb-1">
                                Your credits will reset on:
                            </p>
                            <p className="text-lg font-semibold text-[#536049]">
                                {formatResetDate(resetDate)}
                            </p>
                        </div>

                        <p className="text-sm text-[#292629]/50">
                            Your message credits automatically reset on the
                            first day of each month.
                        </p>
                    </div>

                    {/* Actions */}
                    <div className="mt-6 flex gap-3">
                        <button
                            onClick={onClose}
                            className="flex-1 px-4 py-2.5 bg-[#F5F5F5] hover:bg-[#C7C7B2]/40 text-[#292629]/80 rounded-lg font-medium transition-colors"
                        >
                            Close
                        </button>
                    </div>
                </div>
            </div>
        </>,
        document.body,
    );
}
