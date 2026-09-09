"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { Modal } from "@/app/components/modals/Modal";
import { FieldLabel } from "@/app/components/ui/form-field";
import { SettingsTextInput } from "@/app/components/settings/SettingsTextInput";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
    MfaVerificationPopup,
    needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { deleteAccount, isMfaRequiredError } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { SettingsSection } from "./SettingsSection";

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};

interface EmailWarning {
    title: string;
    message: string;
}

export default function SettingsPage() {
    const router = useRouter();
    const { user, signOut, updateEmail } = useAuth();
    const { profile, updateDisplayName, updateOrganisation } =
        useUserProfile();
    const [displayName, setDisplayName] = useState("");
    const [isSavingName, setIsSavingName] = useState(false);
    const [saved, setSaved] = useState(false);
    const [nameError, setNameError] = useState<string | null>(null);
    const [organisation, setOrganisation] = useState("");
    const [isSavingOrg, setIsSavingOrg] = useState(false);
    const [orgSaved, setOrgSaved] = useState(false);
    const [orgError, setOrgError] = useState<string | null>(null);
    const [email, setEmail] = useState("");
    const [isSavingEmail, setIsSavingEmail] = useState(false);
    const [emailSaved, setEmailSaved] = useState(false);
    const [emailStatus, setEmailStatus] = useState<string | null>(null);
    const [emailWarning, setEmailWarning] = useState<EmailWarning | null>(null);
    const [emailMfaOpen, setEmailMfaOpen] = useState(false);
    const [googleEmailModalOpen, setGoogleEmailModalOpen] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [accountDeleteMfaOpen, setAccountDeleteMfaOpen] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const requiresPasswordForEmailChange =
        user?.createdWithGoogle === true && profile?.passwordSet !== true;

    // Each field syncs from the profile independently. A combined effect
    // (both setters, keyed on both values) wiped in-progress text from the
    // sibling input whenever one field's blur-autosave refreshed the
    // profile; per-field effects don't run then, because the sibling's own
    // profile value did not change. Deliberately NO focused-input guard
    // here: skipping the sync while focused let a profile that loads after
    // mount leave the focused input empty, and blurring it then saved ""
    // over the stored name.
    useEffect(() => {
        setDisplayName(profile?.displayName ?? "");
    }, [profile?.displayName]);

    useEffect(() => {
        setOrganisation(profile?.organisation ?? "");
    }, [profile?.organisation]);

    useEffect(() => {
        if (user?.email) {
            setEmail(user.pendingEmail || user.email);
        }
    }, [user?.email, user?.pendingEmail]);

    useEffect(() => {
        if (
            new URLSearchParams(window.location.search).get("emailChange") !==
                "processed" ||
            !user
        ) {
            return;
        }
        setEmailStatus(
            user.pendingEmail
                ? "One confirmation was accepted. Confirm the email change from both your current and new addresses to finish."
                : "Email updated.",
        );
        window.history.replaceState({}, "", "/settings");
    }, [user]);

    const handleDeleteAccount = async () => {
        devLog("[account/mfa] delete account requested");
        setIsDeleting(true);
        setDeleteError(null);
        try {
            if (await needsMfaVerification()) {
                setDeleteConfirm(false);
                setAccountDeleteMfaOpen(true);
                setIsDeleting(false);
                return;
            }
            await deleteAccount();
            await signOut();
            router.push("/");
        } catch (error) {
            setIsDeleting(false);
            devLog("[account/mfa] delete account failed", {
                isMfaRequired: isMfaRequiredError(error),
                error,
            });
            if (isMfaRequiredError(error)) {
                setDeleteConfirm(false);
                setAccountDeleteMfaOpen(true);
                return;
            }
            setDeleteConfirm(false);
            // Deletion can be refused for a reason only the user can act on —
            // a 409 naming the organization they are the last admin of, for
            // instance. That is an intentional 4xx detail, so it is shown
            // verbatim; the session is untouched because nothing was deleted.
            setDeleteError(
                userFacingApiError(
                    error,
                    "Failed to delete account. Please try again.",
                ),
            );
        }
    };

    const handleSaveEmail = async () => {
        if (requiresPasswordForEmailChange) {
            setGoogleEmailModalOpen(true);
            return;
        }
        const nextEmail = email.trim();
        if (!nextEmail || nextEmail === user?.email) return;

        devLog("[account/mfa] save email requested");
        setIsSavingEmail(true);
        setEmailStatus(null);
        setEmailWarning(null);
        try {
            if (await needsMfaVerification()) {
                setEmailMfaOpen(true);
                return;
            }

            const updatedUser = await updateEmail(nextEmail);
            const pendingEmail = updatedUser.pendingEmail;
            setEmail(pendingEmail || updatedUser.email);
            setEmailSaved(true);
            setEmailStatus(
                pendingEmail
                    ? `Confirmation sent to your current address and ${pendingEmail}. Confirm both messages to finish the change. Your current email remains ${updatedUser.email} until then.`
                    : "Email updated.",
            );
            setTimeout(() => setEmailSaved(false), 2000);
        } catch (error: unknown) {
            devLog("[account/mfa] save email failed", { error });
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to update email. Please try again.";

            if (isAlreadyRegisteredEmailError(message)) {
                setEmail(user?.pendingEmail || user?.email || "");
                setEmailWarning({
                    title: "Email already registered",
                    message: "An account with this email already exists.",
                });
                return;
            }

            if (isEmailRateLimitError(message)) {
                setEmail(user?.pendingEmail || user?.email || "");
                setEmailWarning({
                    title: "Email change unavailable",
                    message:
                        "You can’t change your email this often. Please wait before trying again.",
                });
                return;
            }

            setEmailStatus("Failed to update email. Please try again.");
        } finally {
            setIsSavingEmail(false);
        }
    };

    const handleSaveDisplayName = async () => {
        const nextName = displayName.trim();
        if (nextName === (profile?.displayName ?? "")) return;
        setIsSavingName(true);
        setNameError(null);
        const success = await updateDisplayName(nextName);
        setIsSavingName(false);

        if (success) {
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } else {
            setNameError("Unable to save your name.");
        }
    };

    const handleSaveOrganisation = async () => {
        const nextOrganisation = organisation.trim();
        if (nextOrganisation === (profile?.organisation ?? "")) return;
        setIsSavingOrg(true);
        setOrgError(null);
        const success = await updateOrganisation(nextOrganisation);
        setIsSavingOrg(false);

        if (success) {
            setOrgSaved(true);
            setTimeout(() => setOrgSaved(false), 2000);
        } else {
            setOrgError("Unable to save your organisation.");
        }
    };

    if (!user) return null;

    return (
        <div className="space-y-8">
            {/* Profile Settings */}
            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Profile
                </h2>
                <SettingsSection>
                    <div className="space-y-8 p-4">
                        <div>
                            <div className="flex items-start justify-between gap-3">
                                <FieldLabel>Display Name</FieldLabel>
                                <span
                                    className={`text-xs ${nameError ? "text-red-600" : "text-gray-400"}`}
                                    aria-live="polite"
                                >
                                    {isSavingName
                                        ? "Saving..."
                                        : nameError
                                          ? nameError
                                          : saved
                                            ? "Saved"
                                            : ""}
                                </span>
                            </div>
                            <div className="space-y-2">
                                <SettingsTextInput
                                    type="text"
                                    value={displayName}
                                    onChange={(e) => {
                                        setDisplayName(e.target.value);
                                        setNameError(null);
                                        setSaved(false);
                                    }}
                                    onBlur={() =>
                                        void handleSaveDisplayName()
                                    }
                                    placeholder="Enter your name"
                                />
                            </div>
                        </div>
                        <div>
                            <div className="flex items-start justify-between gap-3">
                                <FieldLabel>Organisation</FieldLabel>
                                <span
                                    className={`text-xs ${orgError ? "text-red-600" : "text-gray-400"}`}
                                    aria-live="polite"
                                >
                                    {isSavingOrg
                                        ? "Saving..."
                                        : orgError
                                          ? orgError
                                          : orgSaved
                                            ? "Saved"
                                            : ""}
                                </span>
                            </div>
                            <div className="space-y-2">
                                <SettingsTextInput
                                    type="text"
                                    value={organisation}
                                    onChange={(e) => {
                                        setOrganisation(e.target.value);
                                        setOrgError(null);
                                        setOrgSaved(false);
                                    }}
                                    onBlur={() =>
                                        void handleSaveOrganisation()
                                    }
                                    placeholder="Enter your organisation"
                                />
                            </div>
                        </div>
                    </div>
                </SettingsSection>
            </section>

            {/* Email */}
            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Email
                </h2>
                <SettingsSection>
                    <div className="space-y-2 p-4">
                        <SettingsTextInput
                            type="email"
                            value={email}
                            disabled={requiresPasswordForEmailChange}
                            onChange={(event) => {
                                setEmail(event.target.value);
                                setEmailStatus(null);
                                setEmailWarning(null);
                                setEmailSaved(false);
                            }}
                            placeholder="Enter your email"
                        />
                        {emailStatus ? (
                            <p className="text-xs text-gray-500">
                                {emailStatus}
                            </p>
                        ) : user.pendingEmail ? (
                            <p className="text-xs text-gray-500">
                                Pending confirmation: {user.pendingEmail}
                            </p>
                        ) : null}
                        {emailStatus && (
                            <p className="text-xs text-gray-400">
                                Current email: {user.email}
                            </p>
                        )}
                        <div className="flex justify-end">
                            <button
                                type="button"
                                onClick={handleSaveEmail}
                                disabled={
                                    isSavingEmail ||
                                    (!requiresPasswordForEmailChange &&
                                        (!email.trim() ||
                                            email.trim() === user.email ||
                                            email.trim() ===
                                                user.pendingEmail ||
                                            emailSaved))
                                }
                                className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                            >
                                {requiresPasswordForEmailChange
                                    ? "Update"
                                    : isSavingEmail
                                    ? "Saving..."
                                    : emailSaved
                                      ? "Saved"
                                      : "Save"}
                            </button>
                        </div>
                    </div>
                </SettingsSection>
            </section>

            {/* Plan */}
            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Usage Plan
                </h2>
                <SettingsSection>
                    <div className="p-4">
                        <p className="text-base font-medium text-gray-500 capitalize">
                            {profile?.tier || "Free"}
                        </p>
                    </div>
                </SettingsSection>
            </section>

            {/* Danger Zone */}
            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-red-600">
                    Danger Zone
                </h2>
                <SettingsSection>
                    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-700">
                                Delete account
                            </p>
                            <p className="text-sm text-gray-500">
                                Permanently delete your account and all
                                associated data. This action cannot be undone.
                            </p>
                        </div>
                        <PillButton
                            tone="danger"
                            size="sm"
                            onClick={() => setDeleteConfirm(true)}
                            disabled={isDeleting}
                            className="w-full shrink-0 sm:w-auto"
                        >
                            <Trash2 className="h-4 w-4 shrink-0" />
                            Delete account
                        </PillButton>
                    </div>
                </SettingsSection>
            </section>
            <ConfirmPopup
                open={deleteConfirm}
                title="Delete account?"
                message="This will permanently delete your account and all associated data. This action cannot be undone."
                confirmLabel="Delete"
                confirmVariant="danger"
                confirmStatus={isDeleting ? "loading" : "idle"}
                cancelLabel="Cancel"
                onCancel={() => {
                    if (isDeleting) return;
                    setDeleteConfirm(false);
                }}
                onConfirm={() => void handleDeleteAccount()}
            />
            <WarningPopup
                open={deleteError !== null}
                title="Account not deleted"
                message={deleteError}
                onClose={() => setDeleteError(null)}
            />
            <WarningPopup
                open={!!emailWarning}
                title={emailWarning?.title}
                message={emailWarning?.message}
                onClose={() => setEmailWarning(null)}
            />
            <Modal
                open={googleEmailModalOpen}
                onClose={() => setGoogleEmailModalOpen(false)}
                breadcrumbs={["Account", "Change email"]}
                size="sm"
                className="h-auto"
                primaryAction={{
                    label: "Go to Security",
                    onClick: () => {
                        setGoogleEmailModalOpen(false);
                        router.push("/settings/security");
                    },
                }}
            >
                <p className="pb-5 text-sm leading-relaxed text-gray-600">
                    Your account was created with Google. To change your email,
                    first add a password in Settings &gt; Security &gt; Password.
                </p>
            </Modal>
            <MfaVerificationPopup
                open={accountDeleteMfaOpen}
                onCancel={() => setAccountDeleteMfaOpen(false)}
                onVerified={() => {
                    devLog(
                        "[account/mfa] account delete verification callback",
                    );
                    setAccountDeleteMfaOpen(false);
                    void handleDeleteAccount();
                }}
                title="Two-factor verification required"
                message="Account deletion is sensitive. Enter a code from your authenticator app to continue."
            />
            <MfaVerificationPopup
                open={emailMfaOpen}
                onCancel={() => setEmailMfaOpen(false)}
                onVerified={() => {
                    devLog("[account/mfa] email verification callback");
                    setEmailMfaOpen(false);
                    void handleSaveEmail();
                }}
                title="Two-factor verification required"
                message="Email changes are sensitive. Enter a code from your authenticator app to continue."
            />
        </div>
    );
}

function isAlreadyRegisteredEmailError(message: string) {
    return message
        .toLowerCase()
        .includes("a user with this email address has already been registered");
}

function isEmailRateLimitError(message: string) {
    return /email.*rate limit|rate limit.*email/i.test(message);
}
