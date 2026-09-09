import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { can, type Capability, type ProjectRole } from "@/app/lib/permissions";
import { ProjectDocumentsView } from "./ProjectDocumentsView";

// Everything below the toolbar is out of scope here: this file pins WHICH
// role sees the folder affordances, not what DocTable does with them. The
// table's props are recorded because the upload menu is assembled from the
// three action registrations handed to it.
const docTableProps = vi.hoisted(() => ({
    current: null as Record<string, unknown> | null,
}));

vi.mock("@/app/components/documents/DocTable", () => ({
    DocTable: (props: Record<string, unknown>) => {
        docTableProps.current = props;
        return <div data-testid="doc-table" />;
    },
}));
vi.mock("@/app/components/modals/AddDocumentsModal", () => ({
    AddDocumentsModal: () => null,
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/app/lib/mikeApi", () => ({
    createProjectFolder: vi.fn(),
    deleteProjectFolder: vi.fn(),
    getProject: vi.fn().mockResolvedValue({ id: "p1", documents: [] }),
    moveDocumentToFolder: vi.fn(),
    moveSubfolderToFolder: vi.fn(),
    renameProjectDocument: vi.fn(),
    renameProjectFolder: vi.fn(),
    resolveProjectFolderPath: vi.fn(),
    uploadProjectDocument: vi.fn(),
    getProjectDirectoryLevel: vi.fn(),
}));

const role = vi.hoisted(() => ({
    current: "editor" as ProjectRole | null,
}));

vi.mock("./ProjectWorkspace", () => ({
    ProjectSectionToolbar: ({ actions }: { actions?: ReactNode }) => (
        <div>{actions}</div>
    ),
    useProjectWorkspace: () => ({
        projectId: "p1",
        project: {
            id: "p1",
            name: "Matter",
            documents: [],
            folders: [],
        },
        setProject: vi.fn(),
        folders: [],
        setFolders: vi.fn(),
        projectLoading: false,
        search: "",
        prefetchProjectSections: vi.fn(),
        setOwnerOnlyAction: vi.fn(),
        setDocumentFolderBreadcrumbs: vi.fn(),
        setAddDocumentsHeaderAction: vi.fn(),
        setDocumentUploadHeaderAction: vi.fn(),
        accessRole: role.current,
        canDo: (capability: Capability) => can(role.current, capability),
    }),
}));

function renderAs(next: ProjectRole | null) {
    role.current = next;
    return render(<ProjectDocumentsView projectId="p1" />);
}

describe("ProjectDocumentsView folder affordances", () => {
    it("offers folder operations to members", () => {
        // Will's review: member is the normal collaborator and organizes
        // folders. This used to sit behind the removed manager tier, so a
        // member saw no Folder button at all.
        renderAs("editor");
        // Folder upload moved into the document table's upload menu on main;
        // the toolbar's remaining folder affordance is the create button.
        expect(screen.getByText("Folder")).toBeInTheDocument();
    });

    it("offers folder operations to admins", () => {
        renderAs("owner");
        expect(screen.getByText("Folder")).toBeInTheDocument();
    });

    it("withholds them from viewers", () => {
        renderAs("viewer");
        expect(screen.queryByText("Folder")).not.toBeInTheDocument();
    });

    it("wires no upload source at all for a viewer", () => {
        // All three entries of the Upload menu are the same content.edit
        // write. "Upload folder" used to stay live for a viewer, so the
        // native folder picker opened and the refusal only arrived once the
        // upload session was already under way.
        renderAs("viewer");
        expect(docTableProps.current?.onAddDocumentsActionChange).toBeUndefined();
        expect(docTableProps.current?.onUploadFilesActionChange).toBeUndefined();
        expect(
            docTableProps.current?.onUploadFolderActionChange,
        ).toBeUndefined();
    });

    it("wires every upload source for an editor", () => {
        renderAs("editor");
        expect(docTableProps.current?.onAddDocumentsActionChange).toBeDefined();
        expect(docTableProps.current?.onUploadFilesActionChange).toBeDefined();
        expect(docTableProps.current?.onUploadFolderActionChange).toBeDefined();
    });

    it("keeps them in place but disabled while the role is unknown", () => {
        // A null role is "the project row has not arrived", not "owner".
        // The buttons hold their slot so the toolbar does not reflow when the
        // answer lands, but they cannot be clicked before it does.
        renderAs(null);
        const folder = screen.getByText("Folder").closest("button");
        expect(folder).toBeDisabled();
    });
});
