"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signup } from "@/app/lib/authApi";
import { Input } from "@/app/components/ui/input";
import { PillButton } from "@/app/components/ui/pill-button";
import Link from "next/link";
import { SiteLogo } from "@/app/components/site-logo";
import { useAuth } from "@/app/contexts/AuthContext";
import { cn } from "@/app/lib/utils";
import {
    authGlassCardClassName,
    authInputClassName,
} from "@/app/components/auth/authStyles";
import { knownErrorCodeMessage } from "@/app/lib/userFacingError";

const SIGNUP_ERROR_MESSAGES = {
    user_already_exists: "An account with this email already exists.",
    email_exists: "An account with this email already exists.",
    over_email_send_rate_limit:
        "Too many signup emails were requested. Please wait and try again.",
    weak_password: "Choose a stronger password and try again.",
} as const;
import {
    MIN_PASSWORD_LENGTH,
    minimumPasswordMessage,
} from "@/app/components/auth/passwordPolicy";
import { AuthDivider } from "@/app/components/auth/AuthDivider";
import { SsoAuthButton } from "@/app/components/auth/SsoAuthButton";
import { GoogleAuthButton } from "@/app/components/auth/GoogleAuthButton";
import { FieldLabel } from "@/app/components/ui/form-field";

function SignupContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { isAuthenticated, authLoading, refreshSession } = useAuth();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);
    const isAccountCreatedPreview =
        process.env.NODE_ENV !== "production" &&
        searchParams.get("preview") === "account-created";

    useEffect(() => {
        if (isAccountCreatedPreview) return;
        if (!authLoading && isAuthenticated && !success) {
            router.replace("/onboarding/profile");
        }
    }, [
        authLoading,
        isAccountCreatedPreview,
        isAuthenticated,
        router,
        success,
    ]);

    const handleSignup = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        // Validate passwords match
        if (password !== confirmPassword) {
            setError("Passwords do not match");
            setLoading(false);
            return;
        }

        // Validate password length
        if (password.length < MIN_PASSWORD_LENGTH) {
            setError(minimumPasswordMessage);
            setLoading(false);
            return;
        }

        try {
            const trimmedEmail = email.trim();
            const result = await signup(
                trimmedEmail,
                password,
                "/onboarding/profile",
            );

            if (!result.requiresEmailConfirmation) {
                await refreshSession();
                setSuccess(true);
                setTimeout(() => {
                    router.push("/onboarding/profile");
                }, 2000);
            } else {
                router.push("/signup/check-email");
            }
        } catch (error: unknown) {
            setError(
                knownErrorCodeMessage(
                    error,
                    SIGNUP_ERROR_MESSAGES,
                    "Unable to create your account right now. Please try again.",
                ),
            );
        } finally {
            setLoading(false);
        }
    };

    // Success View
    if (success || isAccountCreatedPreview) {
        return (
            <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-10">
                <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                    <SiteLogo size="lg" asLink />
                </div>
                <div className="w-full max-w-md">
                    <div className={authGlassCardClassName}>
                        <h1 className="font-serif text-2xl font-medium text-gray-950">
                            Account created!
                        </h1>
                        <p className="mt-3 text-sm leading-relaxed text-gray-600">
                            Redirecting you to finish setting up your account...
                        </p>
                        <PillButton
                            asChild
                            tone="black"
                            size="normal"
                            className="mt-6"
                        >
                            <Link href="/onboarding/profile">Continue</Link>
                        </PillButton>
                    </div>
                </div>
            </div>
        );
    }

    // Default Signup Form View
    return (
        <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-24">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className={cn(authGlassCardClassName, "mb-4")}>
                    <h2 className="mb-6 text-left text-2xl font-medium font-serif text-gray-950">
                        Sign Up
                    </h2>

                    <form onSubmit={handleSignup} className="space-y-4">
                        <div>
                            <FieldLabel htmlFor="email">
                                Email
                            </FieldLabel>
                            <Input
                                id="email"
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>

                        <div>
                            <FieldLabel htmlFor="password">
                                Password
                            </FieldLabel>
                            <Input
                                id="password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder={`Min. ${MIN_PASSWORD_LENGTH} Characters`}
                                required
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>

                        <div>
                            <FieldLabel htmlFor="confirmPassword">
                                Confirm Password
                            </FieldLabel>
                            <Input
                                id="confirmPassword"
                                type="password"
                                value={confirmPassword}
                                onChange={(e) =>
                                    setConfirmPassword(e.target.value)
                                }
                                required
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>

                        {error && (
                            <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                                {error}
                            </div>
                        )}

                        <div className="space-y-3 pt-2">
                            <div className="text-center text-xs text-gray-500">
                                By signing up, you agree to our{" "}
                                <Link
                                    href="https://mikeoss.com/terms"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 hover:underline"
                                >
                                    Terms of Use
                                </Link>{" "}
                                and{" "}
                                <Link
                                    href="https://mikeoss.com/privacy"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 hover:underline"
                                >
                                    Privacy Policy
                                </Link>
                            </div>
                            <PillButton
                                type="submit"
                                tone="black"
                                size="normal"
                                disabled={loading}
                                className="w-full"
                            >
                                {loading ? "Creating account..." : "Sign up"}
                            </PillButton>
                            <AuthDivider />
                            <GoogleAuthButton
                                onError={setError}
                                disabled={loading}
                                onLoadingChange={setLoading}
                            />
                            <SsoAuthButton
                                onError={setError}
                                disabled={loading}
                                onLoadingChange={setLoading}
                            />
                        </div>
                    </form>
                </div>
                <div className="text-center text-sm text-gray-500">
                    Have an account?{" "}
                    <Link
                        href="/login"
                        className="font-medium transition-colors hover:text-gray-950"
                    >
                        Log in
                    </Link>
                </div>
            </div>
        </div>
    );
}

export default function SignupPage() {
    return (
        <Suspense fallback={null}>
            <SignupContent />
        </Suspense>
    );
}
