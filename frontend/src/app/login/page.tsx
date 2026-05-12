"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";

type Mode = "login" | "forgot";

export default function LoginPage() {
    const { isAuthenticated, authLoading } = useAuth();
    const router = useRouter();
    const [mode, setMode] = useState<Mode>("login");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [resetSent, setResetSent] = useState(false);

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/assistant");
        }
    }, [isAuthenticated, authLoading, router]);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
            setError("Email ou mot de passe incorrect.");
            setLoading(false);
        }
    };

    const handleForgotPassword = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        const redirectTo = `${window.location.origin}/auth/reset-password`;
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
        setLoading(false);
        if (error) {
            setError(error.message);
        } else {
            setResetSent(true);
        }
    };

    const handleOAuth = async (provider: "azure") => {
        const redirectTo = `${window.location.origin}/auth/callback`;
        await supabase.auth.signInWithOAuth({
            provider,
            options: {
                redirectTo,
                scopes: "email",
            },
        });
    };

    if (authLoading) {
        return (
            <div className="h-dvh flex items-center justify-center bg-[#292629]">
                <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            </div>
        );
    }

    return (
        <div className="h-dvh flex items-center justify-center bg-[#292629]">
            <div className="w-full max-w-sm px-6">
                {/* Logo */}
                <div className="mb-10 text-center">
                    <span className="text-white text-2xl tracking-widest uppercase">
                        <span className="font-light">CARBON</span>
                        <span className="font-bold">LEO</span>
                    </span>
                    <p className="text-white/40 text-sm mt-1 tracking-wide">Mike Legal</p>
                </div>

                {mode === "forgot" ? (
                    resetSent ? (
                        <div className="text-center space-y-4">
                            <p className="text-white/80 text-sm">
                                Check your inbox — we&apos;ve sent a reset link to{" "}
                                <strong>{email}</strong>.
                            </p>
                            <button
                                onClick={() => {
                                    setMode("login");
                                    setResetSent(false);
                                }}
                                className="text-white/40 text-xs underline hover:text-white/60 transition-colors"
                            >
                                Back to login
                            </button>
                        </div>
                    ) : (
                        <form onSubmit={handleForgotPassword} className="space-y-4">
                            <p className="text-white/50 text-sm mb-2">
                                Enter your email and we&apos;ll send you a reset link.
                            </p>
                            <div>
                                <label className="block text-xs text-white/50 mb-1.5 uppercase tracking-wider">
                                    Email
                                </label>
                                <input
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    required
                                    autoComplete="email"
                                    className="w-full h-10 rounded-md bg-white/8 border border-white/12 px-3 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#FEEA0F]/60 focus:ring-1 focus:ring-[#FEEA0F]/30 transition-colors"
                                    placeholder="vous@carbonleo.com"
                                />
                            </div>
                            {error && <p className="text-red-400 text-sm">{error}</p>}
                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full h-10 rounded-md bg-[#FEEA0F] text-[#292629] text-sm font-semibold hover:bg-[#FEEA0F]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {loading ? "Sending…" : "Send Reset Link"}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setMode("login");
                                    setError("");
                                }}
                                className="w-full text-center text-white/40 text-xs hover:text-white/60 transition-colors"
                            >
                                Back to login
                            </button>
                        </form>
                    )
                ) : (
                    <div className="space-y-5">
                        {/* SSO */}
                        <button
                            onClick={() => handleOAuth("azure")}
                            className="w-full h-10 flex items-center justify-center gap-2.5 rounded-md border border-white/12 bg-white/5 text-sm text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                        >
                            <svg className="w-4 h-4 shrink-0" viewBox="0 0 23 23" fill="none">
                                <path d="M1 1h10v10H1z" fill="#F35325" />
                                <path d="M12 1h10v10H12z" fill="#81BC06" />
                                <path d="M1 12h10v10H1z" fill="#05A6F0" />
                                <path d="M12 12h10v10H12z" fill="#FFBA08" />
                            </svg>
                            Sign in with Microsoft
                        </button>

                        {/* Divider */}
                        <div className="flex items-center gap-3">
                            <div className="flex-1 h-px bg-white/10" />
                            <span className="text-white/25 text-xs uppercase tracking-wider">or</span>
                            <div className="flex-1 h-px bg-white/10" />
                        </div>

                        {/* Email / Password */}
                        <form onSubmit={handleLogin} className="space-y-4">
                            <div>
                                <label className="block text-xs text-white/50 mb-1.5 uppercase tracking-wider">
                                    Email
                                </label>
                                <input
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    required
                                    autoComplete="email"
                                    className="w-full h-10 rounded-md bg-white/8 border border-white/12 px-3 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#FEEA0F]/60 focus:ring-1 focus:ring-[#FEEA0F]/30 transition-colors"
                                    placeholder="vous@carbonleo.com"
                                />
                            </div>

                            <div>
                                <div className="flex items-center justify-between mb-1.5">
                                    <label className="block text-xs text-white/50 uppercase tracking-wider">
                                        Mot de passe
                                    </label>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setMode("forgot");
                                            setError("");
                                        }}
                                        className="text-xs text-white/30 hover:text-white/60 transition-colors"
                                    >
                                        Forgot password?
                                    </button>
                                </div>
                                <input
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    required
                                    autoComplete="current-password"
                                    className="w-full h-10 rounded-md bg-white/8 border border-white/12 px-3 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#FEEA0F]/60 focus:ring-1 focus:ring-[#FEEA0F]/30 transition-colors"
                                    placeholder="••••••••"
                                />
                            </div>

                            {error && <p className="text-red-400 text-sm">{error}</p>}

                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full h-10 rounded-md bg-[#FEEA0F] text-[#292629] text-sm font-semibold hover:bg-[#FEEA0F]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-2"
                            >
                                {loading ? "Connexion…" : "Se connecter"}
                            </button>
                        </form>
                    </div>
                )}
            </div>
        </div>
    );
}
