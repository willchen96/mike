"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload } from "lucide-react";
import {
    copyDocumentsToWorkflowAssets,
    createWorkflow,
    listOrgs,
    shareWorkflow,
    updateWorkflow,
    type Org,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type { Document, Workflow } from "../shared/types";
import { FileDirectory } from "../shared/FileDirectory";
import { PRACTICE_OPTIONS } from "./practices";
import { Modal } from "../modals/Modal";
import { ModalSegmentedToggle } from "../modals/ModalSegmentedToggle";
import { ModalSelect } from "../modals/ModalSelect";
import { FieldLabel, FormTextInput } from "../ui/form-field";
import { WorkflowSlashCommandUI } from "@/shared/ui/WorkflowSlashCommandUI";
import {
    ChatSkeuoIcon,
    TabularReviewSkeuoIcon,
} from "../shared/AppSidebarSkeuoIcons";
import {
    COUNTRY_OPTIONS,
    OTHER_JURISDICTION_OPTION,
} from "@/app/onboarding/options";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    CreateAccessStep,
    type PendingDirectGrant,
    type PendingOrgOverride,
} from "../modals/CreateAccessStep";

const DEFAULT_LANGUAGE = "English";
const DEFAULT_PRACTICE = "";
const DEFAULT_JURISDICTION = "";
const PERSONAL_WORKSPACE = "__personal__";
const LANGUAGE_OPTIONS = [
    "English",
    "Chinese",
    "Spanish",
    "French",
    "German",
    "Japanese",
    "Korean",
    "Portuguese",
    "Italian",
    "Dutch",
    "Arabic",
    "Hebrew",
    "Persian",
    "Urdu",
    "Hindi",
    "Bengali",
    "Tamil",
    "Telugu",
    "Indonesian",
    "Malay",
    "Filipino",
    "Vietnamese",
    "Thai",
    "Burmese",
    "Khmer",
    "Lao",
    "Russian",
    "Ukrainian",
    "Turkish",
    "Polish",
    "Czech",
    "Romanian",
    "Greek",
    "Danish",
    "Finnish",
    "Norwegian",
    "Swedish",
    "Afrikaans",
    "Swahili",
    "Other",
] as const;
const JURISDICTION_OPTIONS = [
    ...COUNTRY_OPTIONS,
    OTHER_JURISDICTION_OPTION,
] as const;
const US_STATE_OPTIONS = [
    "Alabama",
    "Alaska",
    "Arizona",
    "Arkansas",
    "California",
    "Colorado",
    "Connecticut",
    "Delaware",
    "Florida",
    "Georgia",
    "Hawaii",
    "Idaho",
    "Illinois",
    "Indiana",
    "Iowa",
    "Kansas",
    "Kentucky",
    "Louisiana",
    "Maine",
    "Maryland",
    "Massachusetts",
    "Michigan",
    "Minnesota",
    "Mississippi",
    "Missouri",
    "Montana",
    "Nebraska",
    "Nevada",
    "New Hampshire",
    "New Jersey",
    "New Mexico",
    "New York",
    "North Carolina",
    "North Dakota",
    "Ohio",
    "Oklahoma",
    "Oregon",
    "Pennsylvania",
    "Rhode Island",
    "South Carolina",
    "South Dakota",
    "Tennessee",
    "Texas",
    "Utah",
    "Vermont",
    "Virginia",
    "Washington",
    "West Virginia",
    "Wisconsin",
    "Wyoming",
    "District of Columbia",
] as const;
const CANADA_PROVINCE_OPTIONS = [
    "Alberta",
    "British Columbia",
    "Manitoba",
    "New Brunswick",
    "Newfoundland and Labrador",
    "Northwest Territories",
    "Nova Scotia",
    "Nunavut",
    "Ontario",
    "Prince Edward Island",
    "Quebec",
    "Saskatchewan",
    "Yukon",
] as const;

interface Props {
    open: boolean;
    /**
     * `createdWithoutHandoff` is true when the dialog is dismissed after a
     * workflow was created but never handed to `onCreated` (its access grants
     * or asset copies failed). The caller should refetch so the new row is
     * visible.
     */
    onClose: (createdWithoutHandoff?: boolean) => void;
    onCreated: (workflow: Workflow) => void;
    editWorkflow?: Workflow;
    readOnly?: boolean;
    onUpdated?: (workflow: Workflow) => void;
}
export function NewWorkflowModal({
    open,
    onClose,
    onCreated,
    editWorkflow,
    readOnly = false,
    onUpdated,
}: Props) {
    const [title, setTitle] = useState("");
    const [step, setStep] = useState<"details" | "access" | "assets">(
        "details",
    );
    const [type, setType] = useState<"assistant" | "tabular">("assistant");
    const [language, setLanguage] = useState(DEFAULT_LANGUAGE);
    const [customLanguage, setCustomLanguage] = useState("");
    const [practice, setPractice] = useState<string>(DEFAULT_PRACTICE);
    const [customPractice, setCustomPractice] = useState("");
    const [jurisdiction, setJurisdiction] = useState(DEFAULT_JURISDICTION);
    const [jurisdictionRegion, setJurisdictionRegion] = useState("");
    const [customJurisdiction, setCustomJurisdiction] = useState("");
    const [openDropdown, setOpenDropdown] = useState<
        "language" | "practice" | "jurisdiction" | "jurisdictionRegion" | null
    >(null);
    const [loading, setLoading] = useState(false);
    const [orgs, setOrgs] = useState<Org[]>([]);
    const [orgsError, setOrgsError] = useState("");
    const [orgId, setOrgId] = useState(PERSONAL_WORKSPACE);
    const [directGrants, setDirectGrants] = useState<PendingDirectGrant[]>([]);
    const [orgOverrides, setOrgOverrides] = useState<PendingOrgOverride[]>([]);
    const [selectedAssets, setSelectedAssets] = useState<Document[]>([]);
    const [error, setError] = useState("");
    const [importedSkillMd, setImportedSkillMd] = useState("");
    const [importedSkillName, setImportedSkillName] = useState<string | null>(
        null,
    );
    const [markdownImportError, setMarkdownImportError] = useState("");
    const customLanguageInputRef = useRef<HTMLInputElement>(null);
    const customInputRef = useRef<HTMLInputElement>(null);
    const customJurisdictionInputRef = useRef<HTMLInputElement>(null);
    const markdownInputRef = useRef<HTMLInputElement>(null);
    const createdWorkflowRef = useRef<Workflow | null>(null);
    const copiedAssetIdsRef = useRef<Set<string>>(new Set());
    const practiceEditedRef = useRef(false);
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const preferredPractice =
        profile?.practiceAreas.find((area) => area.trim())?.trim() ?? "";

    const isEditing = !!editWorkflow;
    const viewOnly = isEditing && readOnly;
    const isOtherLanguage = language === "Other";
    const isOtherPractice = practice === "Other";
    const isOtherJurisdiction = jurisdiction === "Other";
    const effectiveLanguage = isOtherLanguage
        ? customLanguage.trim()
        : language.trim();
    const effectivePractice = isOtherPractice
        ? customPractice.trim() || null
        : practice || null;
    const effectiveJurisdiction = isOtherJurisdiction
        ? customJurisdiction.trim()
        : jurisdictionRegion.trim() || jurisdiction;
    const languageOptions = (
        (LANGUAGE_OPTIONS as readonly string[]).includes(language)
            ? LANGUAGE_OPTIONS
            : [language, ...LANGUAGE_OPTIONS]
    ).filter(Boolean);
    const baseJurisdictionOptions = (
        JURISDICTION_OPTIONS as readonly string[]
    ).includes(jurisdiction)
        ? JURISDICTION_OPTIONS
        : [jurisdiction, ...JURISDICTION_OPTIONS];
    const jurisdictionOptions = baseJurisdictionOptions.filter(Boolean);
    const jurisdictionRegionOptions =
        jurisdiction === "United States"
            ? US_STATE_OPTIONS
            : jurisdiction === "Canada"
              ? CANADA_PROVINCE_OPTIONS
              : [];
    const effectiveJurisdictions = effectiveJurisdiction
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    const hasChanges = useMemo(() => {
        if (!editWorkflow) return true;

        const initialLanguage =
            editWorkflow.metadata.language ?? DEFAULT_LANGUAGE;
        const initialPractice = editWorkflow.metadata.practice?.trim() || null;
        const initialJurisdictions =
            editWorkflow.metadata.jurisdictions
                ?.map((item) => item.trim())
                .filter(Boolean) ?? [];

        return (
            title.trim() !== editWorkflow.metadata.title.trim() ||
            (effectiveLanguage.trim() || null) !==
                (initialLanguage.trim() || null) ||
            effectivePractice !== initialPractice ||
            JSON.stringify(effectiveJurisdictions) !==
                JSON.stringify(initialJurisdictions)
        );
    }, [
        editWorkflow,
        effectiveJurisdictions,
        effectiveLanguage,
        effectivePractice,
        title,
    ]);
    const formId = "workflow-modal-form";

    const resetForm = useCallback(() => {
        setTitle("");
        setType("assistant");
        setLanguage(DEFAULT_LANGUAGE);
        setCustomLanguage("");
        setPractice(DEFAULT_PRACTICE);
        setCustomPractice("");
        practiceEditedRef.current = false;
        setJurisdiction(DEFAULT_JURISDICTION);
        setJurisdictionRegion("");
        setCustomJurisdiction("");
        setOpenDropdown(null);
        setError("");
        setImportedSkillMd("");
        setImportedSkillName(null);
        setMarkdownImportError("");
        setOrgId(PERSONAL_WORKSPACE);
        setStep("details");
        setDirectGrants([]);
        setOrgOverrides([]);
        setSelectedAssets([]);
        createdWorkflowRef.current = null;
        copiedAssetIdsRef.current = new Set();
        if (markdownInputRef.current) {
            markdownInputRef.current.value = "";
        }
    }, []);

    useEffect(() => {
        if (open && editWorkflow) {
            setTitle(editWorkflow.metadata.title);
            setType(editWorkflow.metadata.type);
            const savedLanguage =
                editWorkflow.metadata.language ?? DEFAULT_LANGUAGE;
            const isKnownLanguage = (
                LANGUAGE_OPTIONS as readonly string[]
            ).includes(savedLanguage);
            if (!isKnownLanguage && savedLanguage) {
                setLanguage("Other");
                setCustomLanguage(savedLanguage);
            } else {
                setLanguage(savedLanguage);
                setCustomLanguage("");
            }
            const savedJurisdiction = editWorkflow.metadata.jurisdictions
                ?.length
                ? editWorkflow.metadata.jurisdictions.join(", ")
                : DEFAULT_JURISDICTION;
            const isKnownJurisdiction = (
                JURISDICTION_OPTIONS as readonly string[]
            ).includes(savedJurisdiction);
            const isUsState = (US_STATE_OPTIONS as readonly string[]).includes(
                savedJurisdiction,
            );
            const isCanadaProvince = (
                CANADA_PROVINCE_OPTIONS as readonly string[]
            ).includes(savedJurisdiction);
            if (!isKnownJurisdiction && savedJurisdiction) {
                if (isUsState) {
                    setJurisdiction("United States");
                    setJurisdictionRegion(savedJurisdiction);
                    setCustomJurisdiction("");
                } else if (isCanadaProvince) {
                    setJurisdiction("Canada");
                    setJurisdictionRegion(savedJurisdiction);
                    setCustomJurisdiction("");
                } else {
                    setJurisdiction("Other");
                    setJurisdictionRegion("");
                    setCustomJurisdiction(savedJurisdiction);
                }
            } else {
                setJurisdiction(savedJurisdiction);
                setJurisdictionRegion("");
                setCustomJurisdiction("");
            }
            const saved = editWorkflow.metadata.practice ?? DEFAULT_PRACTICE;
            const isKnown = (PRACTICE_OPTIONS as readonly string[]).includes(
                saved,
            );
            if (!isKnown && saved) {
                setPractice("Other");
                setCustomPractice(saved);
            } else {
                setPractice(saved);
                setCustomPractice("");
            }
            setOrgId(editWorkflow.org_id ?? PERSONAL_WORKSPACE);
            setError("");
        } else if (open) {
            resetForm();
        }
    }, [open, editWorkflow, resetForm]);

    useEffect(() => {
        if (!open) {
            practiceEditedRef.current = false;
            return;
        }
        if (editWorkflow || !preferredPractice || practiceEditedRef.current)
            return;
        if (
            (PRACTICE_OPTIONS as readonly string[]).includes(preferredPractice)
        ) {
            setPractice(preferredPractice);
            setCustomPractice("");
        } else {
            setPractice("Other");
            setCustomPractice(preferredPractice);
        }
    }, [editWorkflow, open, preferredPractice]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setOrgsError("");
        listOrgs()
            .then((rows) => {
                if (!cancelled) setOrgs(rows);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setOrgs([]);
                // Without this the selector silently offers only "No
                // organization" and the workflow lands in the personal
                // workspace by accident.
                setOrgsError(
                    userFacingApiError(
                        err,
                        "Could not load your organizations.",
                    ),
                );
            });
        return () => {
            cancelled = true;
        };
    }, [open]);

    useEffect(() => {
        if (isOtherLanguage) {
            customLanguageInputRef.current?.focus();
        }
    }, [isOtherLanguage]);

    useEffect(() => {
        if (isOtherPractice) {
            customInputRef.current?.focus();
        }
    }, [isOtherPractice]);

    useEffect(() => {
        if (isOtherJurisdiction) {
            customJurisdictionInputRef.current?.focus();
        }
    }, [isOtherJurisdiction]);

    if (!open) return null;

    async function saveWorkflow(applyAccess = true) {
        if (viewOnly || loading || !title.trim()) return;
        setLoading(true);
        setError("");
        try {
            if (isEditing && editWorkflow) {
                const updated = await updateWorkflow(editWorkflow.id, {
                    metadata: {
                        title: title.trim(),
                        language: effectiveLanguage || null,
                        practice: effectivePractice,
                        jurisdictions: effectiveJurisdictions.length
                            ? effectiveJurisdictions
                            : null,
                    },
                });
                onUpdated?.(updated);
            } else {
                const createPayload: Parameters<typeof createWorkflow>[0] = {
                    metadata: {
                        title: title.trim(),
                        type,
                        language: effectiveLanguage || null,
                        practice: effectivePractice,
                        jurisdictions: effectiveJurisdictions.length
                            ? effectiveJurisdictions
                            : null,
                    },
                };
                if (type === "assistant" && importedSkillMd) {
                    createPayload.skill_md = importedSkillMd;
                }
                if (orgId !== PERSONAL_WORKSPACE) {
                    createPayload.org_id = orgId;
                }
                const workflow =
                    createdWorkflowRef.current ??
                    (await createWorkflow(createPayload));
                createdWorkflowRef.current = workflow;
                const assignments = applyAccess
                    ? orgId === PERSONAL_WORKSPACE
                        ? directGrants
                        : orgOverrides
                    : [];
                const ownEmail = user?.email?.trim().toLowerCase();
                const recipients = assignments.filter(
                    (assignment) => !ownEmail || assignment.email !== ownEmail,
                );
                // Sequential, and one refusal must not take the whole submit
                // down with it: the workflow already exists, so a rejected
                // grant is reported against the addresses it applies to
                // instead of surfacing as "Failed to create workflow". The
                // share endpoint upserts, so retrying is safe.
                const grantFailures: { email: string; detail: string }[] = [];
                for (const assignment of recipients) {
                    try {
                        await shareWorkflow(workflow.id, {
                            emails: [assignment.email],
                            role: assignment.role,
                        });
                    } catch (err: unknown) {
                        grantFailures.push({
                            email: assignment.email,
                            detail: userFacingApiError(
                                err,
                                "the request failed",
                            ),
                        });
                    }
                }
                const pendingAssetIds = selectedAssets
                    .map((document) => document.id)
                    .filter((id) => !copiedAssetIdsRef.current.has(id));
                if (grantFailures.length > 0) {
                    // Stay open on THIS dialog: createdWorkflowRef holds the
                    // workflow, so pressing Create again retries only the
                    // grants against the same workflow.
                    setError(
                        `Workflow created, but access was not granted to ${grantFailures
                            .map((failure) => failure.email)
                            .join(", ")}: ${grantFailures[0]!.detail}${
                            pendingAssetIds.length > 0
                                ? ` The ${pendingAssetIds.length} selected ${
                                      pendingAssetIds.length === 1
                                          ? "file is"
                                          : "files are"
                                  } still pending and will be copied when you try again.`
                                : ""
                        }`,
                    );
                    return;
                }

                // The asset copy used to run BEFORE the grants and outside any
                // try of its own. A failed copy therefore threw out of the
                // whole submit and was reported as "Failed to create workflow"
                // — about a workflow that exists — and because nothing
                // recorded what had been copied, the retry sent every asset
                // again and duplicated the ones that had worked. It runs last
                // now, one asset at a time, and each id is recorded as it
                // lands, so a retry sends only what is still missing.
                if (type === "assistant" && pendingAssetIds.length > 0) {
                    let copyFailures = 0;
                    for (const id of pendingAssetIds) {
                        try {
                            await copyDocumentsToWorkflowAssets(workflow.id, [
                                id,
                            ]);
                            copiedAssetIdsRef.current.add(id);
                        } catch {
                            copyFailures += 1;
                        }
                    }
                    if (copyFailures > 0) {
                        setError(
                            `Workflow created, but ${copyFailures} ${
                                copyFailures === 1 ? "asset" : "assets"
                            } could not be copied. Press Create again to retry the ${
                                copyFailures === 1 ? "copy" : "copies"
                            }.`,
                        );
                        return;
                    }
                }
                onCreated({
                    ...workflow,
                    access_scope:
                        orgId !== PERSONAL_WORKSPACE
                            ? "organization"
                            : recipients.length > 0
                              ? "shared"
                              : "private",
                    organization_name:
                        orgs.find((org) => org.id === orgId)?.name ?? null,
                    ...(orgId === PERSONAL_WORKSPACE && recipients.length > 0
                        ? { direct_grant_count: recipients.length }
                        : {}),
                });
            }
            resetForm();
            onClose();
        } catch (err: unknown) {
            setError(
                userFacingApiError(
                    err,
                    `Failed to ${isEditing ? "update" : "create"} workflow`,
                ),
            );
        } finally {
            setLoading(false);
        }
    }

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (viewOnly || !title.trim()) return;

        if (!isEditing) {
            if (step === "details") {
                setStep("access");
            }
            return;
        }

        void saveWorkflow();
    }

    function handleClose() {
        // A create in flight owns the dialog: Escape, the backdrop and the
        // close button must not dismiss it out from under an in-progress
        // workflow creation.
        if (loading) return;
        // A workflow whose grants (or asset copies) failed was still created,
        // but it never reached onCreated, so the caller's list has no row for
        // it. Tell the caller to refetch instead of leaving it invisible
        // until a page reload.
        const createdWithoutHandoff = createdWorkflowRef.current !== null;
        resetForm();
        onClose(createdWithoutHandoff);
    }

    async function handleMarkdownImport(
        e: React.ChangeEvent<HTMLInputElement>,
    ) {
        const file = e.target.files?.[0];
        setMarkdownImportError("");
        if (!file) return;

        const normalizedName = file.name.toLowerCase();
        if (
            !normalizedName.endsWith(".md") &&
            !normalizedName.endsWith(".markdown")
        ) {
            setImportedSkillMd("");
            setImportedSkillName(null);
            setMarkdownImportError("Choose a .md or .markdown file.");
            e.target.value = "";
            return;
        }

        try {
            const text = await file.text();
            setImportedSkillMd(text);
            setImportedSkillName(file.name);
        } catch {
            setImportedSkillMd("");
            setImportedSkillName(null);
            setMarkdownImportError("Could not read that markdown file.");
            e.target.value = "";
        }
    }

    const jurisdictionField = (
        <div>
            <FieldLabel htmlFor="workflow-jurisdiction">
                Jurisdiction
            </FieldLabel>
            <ModalSelect
                id="workflow-jurisdiction"
                value={jurisdiction}
                options={jurisdictionOptions}
                placeholder="Select jurisdiction"
                disabled={viewOnly}
                open={openDropdown === "jurisdiction"}
                onOpenChange={(nextOpen) =>
                    setOpenDropdown((current) =>
                        nextOpen
                            ? "jurisdiction"
                            : current === "jurisdiction"
                              ? null
                              : current,
                    )
                }
                onChange={(value) => {
                    setJurisdiction(value);
                    setJurisdictionRegion("");
                    if (value !== "Other") {
                        setCustomJurisdiction("");
                    }
                    setOpenDropdown(null);
                }}
            />
            {jurisdictionRegionOptions.length > 0 && (
                <ModalSelect
                    id="workflow-jurisdiction-region"
                    className="mt-2"
                    value={jurisdictionRegion}
                    options={jurisdictionRegionOptions}
                    disabled={viewOnly}
                    placeholder={
                        jurisdiction === "United States"
                            ? "Select state..."
                            : "Select province..."
                    }
                    open={openDropdown === "jurisdictionRegion"}
                    onOpenChange={(nextOpen) =>
                        setOpenDropdown((current) =>
                            nextOpen
                                ? "jurisdictionRegion"
                                : current === "jurisdictionRegion"
                                  ? null
                                  : current,
                        )
                    }
                    onChange={(value) => {
                        setJurisdictionRegion(value);
                        setOpenDropdown(null);
                    }}
                />
            )}
            {isOtherJurisdiction && (
                <FormTextInput
                    ref={customJurisdictionInputRef}
                    type="text"
                    value={customJurisdiction}
                    disabled={viewOnly}
                    onChange={(e) => setCustomJurisdiction(e.target.value)}
                    placeholder="Enter jurisdiction…"
                    className="mt-2"
                />
            )}
        </div>
    );

    return (
        <Modal
            open={open}
            onClose={handleClose}
            breadcrumbs={[
                "Workflows",
                isEditing ? "View and Edit details" : "New workflow",
                ...(!isEditing
                    ? [
                          step === "details"
                              ? "Details"
                              : step === "assets"
                                ? "Add Assets"
                                : orgId === PERSONAL_WORKSPACE
                                  ? "Access"
                                  : "Organisational Access",
                      ]
                    : []),
            ]}
            primaryAction={
                viewOnly
                    ? undefined
                    : !isEditing && step === "details"
                      ? {
                            label: "Next",
                            type: "button",
                            onClick: () => setStep("access"),
                            disabled: !title.trim() || loading,
                        }
                      : !isEditing && step === "access" && type === "assistant"
                        ? {
                              label: "Next",
                              type: "button",
                              onClick: () => setStep("assets"),
                              disabled: loading,
                          }
                        : {
                              label: loading
                                  ? isEditing
                                      ? "Saving…"
                                      : "Creating…"
                                  : isEditing
                                    ? "Save"
                                    : "Create workflow",
                              type: isEditing ? "submit" : "button",
                              form: isEditing ? formId : undefined,
                              onClick: isEditing
                                  ? undefined
                                  : () => void saveWorkflow(true),
                              disabled:
                                  !title.trim() ||
                                  loading ||
                                  (isEditing && !hasChanges),
                          }
            }
            secondaryAction={
                !isEditing && step === "assets"
                    ? {
                          label: "Back",
                          type: "button",
                          onClick: () => setStep("access"),
                          disabled: loading,
                      }
                    : !isEditing && step === "access"
                      ? {
                            label: "Back",
                            type: "button",
                            onClick: () => setStep("details"),
                            disabled: loading,
                        }
                      : !isEditing && step === "details" && type === "assistant"
                        ? {
                              label: importedSkillName ?? "Upload markdown",
                              icon: <Upload className="h-3.5 w-3.5" />,
                              onClick: () => markdownInputRef.current?.click(),
                              disabled: loading,
                          }
                        : undefined
            }
            cancelAction={
                !isEditing && step === "access"
                    ? {
                          label: "Skip",
                          type: "button",
                          onClick: () => {
                              setDirectGrants([]);
                              setOrgOverrides([]);
                              if (type === "assistant") {
                                  setStep("assets");
                              } else {
                                  void saveWorkflow(false);
                              }
                          },
                          disabled: loading,
                      }
                    : undefined
            }
        >
            <form
                id={formId}
                onSubmit={handleSubmit}
                className="-mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-5"
            >
                {!isEditing && step === "access" ? (
                    <CreateAccessStep
                        orgId={orgId === PERSONAL_WORKSPACE ? null : orgId}
                        organizationName={
                            orgs.find((org) => org.id === orgId)?.name ?? null
                        }
                        currentUserEmail={user?.email ?? null}
                        currentUserId={user?.id ?? null}
                        directGrants={directGrants}
                        onDirectGrantsChange={setDirectGrants}
                        orgOverrides={orgOverrides}
                        onOrgOverridesChange={setOrgOverrides}
                        ownerLabel="Workflow owners"
                    />
                ) : !isEditing && step === "assets" ? (
                    <div className="flex min-h-0 flex-1 flex-col">
                        <FileDirectory
                            selectedDocuments={selectedAssets}
                            onChange={setSelectedAssets}
                            showTabs
                        />
                    </div>
                ) : (
                    <div className="space-y-6">
                        <div className="space-y-4">
                            <div>
                                <FieldLabel htmlFor="workflow-title">
                                    Title
                                </FieldLabel>
                                <FormTextInput
                                    id="workflow-title"
                                    type="text"
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                    placeholder="Add workflow name"
                                    variant="minimal"
                                    disabled={viewOnly}
                                    autoFocus={!viewOnly}
                                />
                                <WorkflowSlashCommandUI title={title} />
                            </div>

                            {!isEditing && (
                                <div className="grid gap-5 md:grid-cols-2">
                                    <div>
                                        <FieldLabel as="p">Type</FieldLabel>
                                        <ModalSegmentedToggle
                                            value={type}
                                            onChange={setType}
                                            options={[
                                                {
                                                    value: "assistant",
                                                    label: "Assistant",
                                                    icon: ChatSkeuoIcon,
                                                },
                                                {
                                                    value: "tabular",
                                                    label: "Tabular",
                                                    icon: TabularReviewSkeuoIcon,
                                                },
                                            ]}
                                        />
                                    </div>
                                    {jurisdictionField}
                                </div>
                            )}
                        </div>

                        <div className="grid gap-5 md:grid-cols-2">
                            <div>
                                <FieldLabel htmlFor="workflow-language">
                                    Language
                                </FieldLabel>
                                <ModalSelect
                                    id="workflow-language"
                                    value={language}
                                    options={languageOptions}
                                    disabled={viewOnly}
                                    open={openDropdown === "language"}
                                    onOpenChange={(nextOpen) =>
                                        setOpenDropdown((current) =>
                                            nextOpen
                                                ? "language"
                                                : current === "language"
                                                  ? null
                                                  : current,
                                        )
                                    }
                                    onChange={(value) => {
                                        setLanguage(value);
                                        if (value !== "Other") {
                                            setCustomLanguage("");
                                        }
                                        setOpenDropdown(null);
                                    }}
                                />
                                {isOtherLanguage && (
                                    <FormTextInput
                                        ref={customLanguageInputRef}
                                        type="text"
                                        value={customLanguage}
                                        disabled={viewOnly}
                                        onChange={(e) =>
                                            setCustomLanguage(e.target.value)
                                        }
                                        placeholder="Enter language…"
                                        className="mt-2"
                                    />
                                )}
                            </div>

                            <div>
                                <FieldLabel htmlFor="workflow-practice">
                                    Practice area
                                </FieldLabel>
                                <ModalSelect
                                    id="workflow-practice"
                                    value={practice}
                                    options={PRACTICE_OPTIONS}
                                    placeholder="Select practice area"
                                    disabled={viewOnly}
                                    open={openDropdown === "practice"}
                                    onOpenChange={(nextOpen) =>
                                        setOpenDropdown((current) =>
                                            nextOpen
                                                ? "practice"
                                                : current === "practice"
                                                  ? null
                                                  : current,
                                        )
                                    }
                                    onChange={(value) => {
                                        practiceEditedRef.current = true;
                                        setPractice(value);
                                        if (value !== "Other") {
                                            setCustomPractice("");
                                        }
                                        setOpenDropdown(null);
                                    }}
                                />
                                {isOtherPractice && (
                                    <FormTextInput
                                        ref={customInputRef}
                                        type="text"
                                        value={customPractice}
                                        disabled={viewOnly}
                                        onChange={(e) => {
                                            practiceEditedRef.current = true;
                                            setCustomPractice(e.target.value);
                                        }}
                                        placeholder="Enter practice area…"
                                        className="mt-2"
                                    />
                                )}
                            </div>
                        </div>

                        {isEditing && jurisdictionField}

                        <div>
                            <FieldLabel htmlFor="workflow-org">
                                {isEditing
                                    ? "Organisation"
                                    : "Share across Organisation"}
                            </FieldLabel>
                            <ModalSelect
                                id="workflow-org"
                                value={orgId}
                                onChange={(value) => {
                                    setOrgId(value);
                                    setDirectGrants([]);
                                    setOrgOverrides([]);
                                }}
                                disabled={isEditing || loading}
                                options={[
                                    {
                                        value: PERSONAL_WORKSPACE,
                                        label: "No organization",
                                    },
                                    ...orgs.map((org) => ({
                                        value: org.id,
                                        label: org.name,
                                    })),
                                ]}
                            />
                            {orgsError && (
                                <p className="mt-2 text-sm text-red-500">
                                    {orgsError}
                                </p>
                            )}
                        </div>
                    </div>
                )}
                {(error || markdownImportError) && (
                    <p className="mt-3 text-sm text-red-500">
                        {error || markdownImportError}
                    </p>
                )}
                <input
                    ref={markdownInputRef}
                    type="file"
                    className="hidden"
                    accept=".md,.markdown,text/markdown,text/x-markdown,text/plain"
                    onChange={handleMarkdownImport}
                />
            </form>
        </Modal>
    );
}
