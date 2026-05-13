"use client";

import { useState, useEffect } from "react";
import { Send, CheckCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useTranslations } from "next-intl";

type FeedbackType = "bug" | "feature" | "question" | "other";

export default function SupportPage() {
    const t = useTranslations("pages.suporte");
    const router = useRouter();
    const { user, isAuthenticated, authLoading } = useAuth();

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/");
        }
    }, [authLoading, isAuthenticated, router]);
    const [feedbackType, setFeedbackType] = useState<FeedbackType>("question");
    const [subject, setSubject] = useState("");
    const [message, setMessage] = useState("");
    const [link, setLink] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isSubmitted, setIsSubmitted] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const feedbackTypes: {
        value: FeedbackType;
        label: string;
        description: string;
    }[] = [
        {
            value: "bug",
            label: t("tipoBug"),
            description: t("tipoBugDesc"),
        },
        {
            value: "feature",
            label: t("tipoFeature"),
            description: t("tipoFeatureDesc"),
        },
        {
            value: "question",
            label: t("tipoDuvida"),
            description: t("tipoDuvidaDesc"),
        },
        {
            value: "other",
            label: t("tipoOutro"),
            description: t("tipoOutroDesc"),
        },
    ];

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setIsSubmitting(true);

        try {
            const response = await fetch("/api/support", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    type: feedbackType,
                    subject,
                    message,
                    email: user?.email,
                    link,
                }),
            });

            if (!response.ok) {
                throw new Error("Failed to submit feedback");
            }

            setIsSubmitted(true);
        } catch (err) {
            console.error("Error submitting feedback:", err);
            setError("Failed to submit your feedback. Please try again.");
        } finally {
            setIsSubmitting(false);
        }
    };

    if (isSubmitted) {
        return (
            <div className="h-full flex items-center justify-center p-4">
                <div className="max-w-md w-full bg-white rounded-xl text-center">
                    <div className="flex justify-center mb-4">
                        <div className="h-16 w-16 bg-green-100 rounded-full flex items-center justify-center">
                            <CheckCircle className="h-8 w-8 text-green-600" />
                        </div>
                    </div>
                    <h2 className="text-2xl font-semibold text-gray-900 mb-2">
                        {t("obrigado")}
                    </h2>
                    <p className="text-gray-600 mb-6">
                        {t("contatoEmBreve")}
                    </p>
                    <button
                        onClick={() => router.push("/")}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium text-sm"
                    >
                        {t("voltarInicio")}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full flex flex-col px-6 h-full">
            <div className="w-full max-w-4xl m-auto flex flex-col h-full">
                {/* Fixed Header Section */}
                <div className="flex-shrink-0 pt-6 md:pt-10 pb-0">
                    <div className="mb-5">
                        <h1 className="text-4xl font-medium font-eb-garamond text-gray-900 mb-3">
                            {t("titulo")}
                        </h1>
                    </div>
                </div>

                {/* Form Container */}
                <div className="flex-1 overflow-y-auto pb-6">
                    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                        <form onSubmit={handleSubmit} className="space-y-6">
                            {/* Feedback Type Selection */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-3">
                                    {t("comoAjudar")}
                                </label>
                                <div className="grid grid-cols-2 gap-3">
                                    {feedbackTypes.map((type) => (
                                        <button
                                            key={type.value}
                                            type="button"
                                            onClick={() =>
                                                setFeedbackType(type.value)
                                            }
                                            className={`p-4 rounded-lg border-2 text-left transition-all ${
                                                feedbackType === type.value
                                                    ? "border-blue-600 bg-blue-50"
                                                    : "border-gray-200 hover:border-gray-300"
                                            }`}
                                        >
                                            <div
                                                className={`font-medium ${
                                                    feedbackType === type.value
                                                        ? "text-blue-700"
                                                        : "text-gray-900"
                                                }`}
                                            >
                                                {type.label}
                                            </div>
                                            <div className="text-xs text-gray-500 mt-1">
                                                {type.description}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Link (for bugs) */}
                            {feedbackType === "bug" && (
                                <div>
                                    <label
                                        htmlFor="link"
                                        className="block text-sm font-medium text-gray-700 mb-2"
                                    >
                                        {t("linkProblema")}
                                    </label>
                                    <input
                                        type="url"
                                        id="link"
                                        value={link}
                                        onChange={(e) =>
                                            setLink(e.target.value)
                                        }
                                        placeholder="https://mikeoss.com/..."
                                        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                                    />
                                    <p className="text-xs text-gray-500 mt-1">
                                        {t("dicaBug")}
                                    </p>
                                </div>
                            )}

                            {/* Subject */}
                            <div>
                                <label
                                    htmlFor="subject"
                                    className="block text-sm font-medium text-gray-700 mb-2"
                                >
                                    {t("assunto")}
                                </label>
                                <input
                                    type="text"
                                    id="subject"
                                    value={subject}
                                    onChange={(e) => setSubject(e.target.value)}
                                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                                    required
                                />
                            </div>

                            {/* Message */}
                            <div>
                                <label
                                    htmlFor="message"
                                    className="block text-sm font-medium text-gray-700 mb-2"
                                >
                                    {t("mensagem")}
                                </label>
                                <textarea
                                    id="message"
                                    value={message}
                                    onChange={(e) => setMessage(e.target.value)}
                                    placeholder={t("placeholderMensagem")}
                                    rows={5}
                                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all resize-none"
                                    required
                                />
                            </div>

                            {/* Email Display (if logged in) */}
                            {user?.email && (
                                <div className="text-sm text-gray-500">
                                    {t("responderPara")}{" "}
                                    <span className="font-medium">
                                        {user.email}
                                    </span>
                                </div>
                            )}

                            {/* Error Message */}
                            {error && (
                                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                                    {error}
                                </div>
                            )}

                            {/* Submit Button */}
                            <button
                                type="submit"
                                disabled={
                                    isSubmitting ||
                                    !subject.trim() ||
                                    !message.trim()
                                }
                                className="w-full py-3 px-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium flex items-center justify-center gap-2"
                            >
                                {isSubmitting ? (
                                    <>
                                        <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                        <span>{t("enviando")}</span>
                                    </>
                                ) : (
                                    <>
                                        <Send className="h-4 w-4" />
                                        <span>{t("enviar")}</span>
                                    </>
                                )}
                            </button>
                        </form>
                    </div>
                </div>
            </div>
        </div>
    );
}
