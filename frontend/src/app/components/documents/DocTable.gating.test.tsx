import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { can, type Capability, type ProjectRole } from "@/app/lib/permissions";
import { DocTable } from "./DocTable";

// What this file pins: the empty state's Upload is the last Upload in the
// table that stayed live for a viewer. Every other entry point had been
// gated, so the one affordance a project with no documents actually shows was
// also the only one that looked available to somebody who cannot use it.

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));

const operations = {
    uploadDocuments: vi.fn(),
    refreshCollection: vi.fn(async () => {}),
    createFolder: vi.fn(),
    resolveFolderPath: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(async () => {}),
    moveFolder: vi.fn(),
    moveDocument: vi.fn(),
    renameDocument: vi.fn(),
};

function renderAs(role: ProjectRole) {
    return render(
        <DocTable
            scopeKey="project:p1"
            documents={[]}
            setDocuments={vi.fn()}
            folders={[]}
            setFolders={vi.fn()}
            loading={false}
            search=""
            operations={operations as never}
            emptyStateTitle="Documents"
            canDo={(capability: Capability) => can(role, capability)}
        />,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    }));
});

describe("DocTable empty-state upload", () => {
    it("refuses a viewer at the button", () => {
        renderAs("viewer");

        const upload = screen.getByRole("button", { name: "Upload" });
        expect(upload).toBeDisabled();
        expect(upload).toHaveAttribute("aria-disabled", "true");
    });

    it("leaves it live for an editor", () => {
        renderAs("editor");

        const upload = screen.getByRole("button", { name: "Upload" });
        expect(upload).toBeEnabled();
        expect(upload).not.toHaveAttribute("aria-disabled");
    });
});
