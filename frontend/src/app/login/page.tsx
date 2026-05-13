"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { SiteLogo } from "@/components/site-logo";
import { useAuth } from "@/contexts/AuthContext";
import { useTranslations } from "next-intl";
export default function LoginPage() {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const t = useTranslations("auth.login");

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/assistant");
        }
    }, [authLoading, isAuthenticated, router]);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        try {
            const { data, error } = await supabase.auth.signInWithPassword({
                email,
                password,
            });

            if (error) throw error;

            router.push("/assistant");
        } catch (error: any) {
            setError(error.message || t("erroPadrao"));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-dvh bg-white flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="md" className="md:text-4xl" asLink />
            </div>
            <div className="w-full max-w-md">
                {/* Login Form */}
                <div className="bg-white border border-gray-200 rounded-2xl p-8 mb-4">
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-left text-2xl font-serif">
                            {t("titulo")}
                        </h2>
                        <div className="bg-gray-100 p-1 rounded-md flex text-xs font-medium">
                            <span className="text-gray-600 px-3 py-1 bg-white rounded-sm shadow-sm">
                                {t("tabEntrar")}
                            </span>
                            <Link
                                href="/signup"
                                className="px-3 py-1 text-gray-500 hover:text-gray-900"
                            >
                                {t("tabCadastrar")}
                            </Link>
                        </div>
                    </div>
                    <form onSubmit={handleLogin} className="space-y-4">
                        <div>
                            <label
                                htmlFor="email"
                                className="block text-sm font-medium text-gray-700 mb-2"
                            >
                                {t("labelEmail")}
                            </label>
                            <Input
                                id="email"
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder={t("placeholderEmail")}
                                required
                                className="w-full"
                            />
                        </div>

                        <div>
                            <label
                                htmlFor="password"
                                className="block text-sm font-medium text-gray-700 mb-2"
                            >
                                {t("labelSenha")}
                            </label>
                            <Input
                                id="password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder={t("placeholderSenha")}
                                required
                                className="w-full"
                            />
                        </div>

                        {error && (
                            <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                                {error}
                            </div>
                        )}

                        <Button
                            type="submit"
                            disabled={loading}
                            className="w-full mt-5 bg-black hover:bg-gray-900 text-white"
                        >
                            {loading ? t("botaoEntrando") : t("botaoEntrar")}
                        </Button>
                    </form>
                </div>
                <p className="text-center text-xs text-gray-500 leading-relaxed px-2">
                    {t("avisoDemo")}
                </p>
            </div>
        </div>
    );
}
