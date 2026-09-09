import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MikeApiError, listOrgs } from "@/app/lib/mikeApi";
import type { Project } from "@/app/components/shared/types";
import { ProjectDetailsModal } from "./ProjectDetailsModal";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    listOrgs: vi.fn(),
}));

vi.mock("./ProjectPracticeField", () => ({
    ProjectPracticeField: ({
        id,
        value,
        disabled,
    }: {
        id: string;
        value: string;
        disabled?: boolean;
    }) => (
        <button id={id} type="button" disabled={disabled}>
            {value || "None"}
        </button>
    ),
}));

const project = {
    id: "project-1",
    user_id: "user-1",
    org_id: "org-1",
    name: "Matter",
    cm_number: "CM-123",
    practice: "Litigation",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
} satisfies Project;

describe("ProjectDetailsModal", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(listOrgs).mockResolvedValue([
            { id: "org-1", name: "Elite Law LLP" } as never,
        ]);
    });

    it("shows the current organisation in project details", async () => {
        render(
            <ProjectDetailsModal
                open
                project={project}
                canEdit
                onClose={vi.fn()}
                onSave={vi.fn()}
            />,
        );

        const organisation = await screen.findByLabelText("Organisation");
        expect(organisation).toBeDisabled();
        expect(organisation).toHaveTextContent("Elite Law LLP");
    });

    it("names the organisation from the row when the org list fails", async () => {
        // The select falls back to its raw value when no option matches, so a
        // failed listOrgs used to show the organization's UUID.
        vi.mocked(listOrgs).mockRejectedValue(new Error("network"));
        render(
            <ProjectDetailsModal
                open
                project={{
                    ...project,
                    organization_name: "Elite Law LLP",
                }}
                canEdit
                onClose={vi.fn()}
                onSave={vi.fn()}
            />,
        );

        const organisation = await screen.findByLabelText("Organisation");
        expect(organisation).toHaveTextContent("Elite Law LLP");
        expect(organisation).not.toHaveTextContent("org-1");
    });

    it("reports what an intentional refusal said instead of a generic line", async () => {
        const user = userEvent.setup();
        render(
            <ProjectDetailsModal
                open
                project={project}
                canEdit
                onClose={vi.fn()}
                onSave={vi
                    .fn()
                    .mockRejectedValue(
                        new MikeApiError({
                            status: 409,
                            message: "A project with that CM number exists.",
                        }),
                    )}
            />,
        );

        await user.clear(screen.getByLabelText("Project name"));
        await user.type(screen.getByLabelText("Project name"), "Renamed");
        await user.click(screen.getByRole("button", { name: "Update" }));

        expect(
            await screen.findByText("A project with that CM number exists."),
        ).toBeInTheDocument();
    });
});
