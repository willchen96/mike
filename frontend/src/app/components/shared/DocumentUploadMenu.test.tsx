import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocumentUploadMenu } from "./DocumentUploadMenu";

describe("DocumentUploadMenu", () => {
    it("offers saved, file, and folder sources", async () => {
        const user = userEvent.setup();
        const onSavedFiles = vi.fn();
        const onUploadFiles = vi.fn();
        const onUploadFolder = vi.fn();
        render(
            <DocumentUploadMenu
                onSavedFiles={onSavedFiles}
                onUploadFiles={onUploadFiles}
                onUploadFolder={onUploadFolder}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Upload" }));
        expect(screen.getAllByRole("menuitem")).toHaveLength(3);
        await user.click(screen.getByRole("menuitem", { name: "Saved files" }));
        expect(onSavedFiles).toHaveBeenCalledOnce();

        await user.click(screen.getByRole("button", { name: "Upload" }));
        await user.click(screen.getByRole("menuitem", { name: "Upload files" }));
        expect(onUploadFiles).toHaveBeenCalledOnce();

        await user.click(screen.getByRole("button", { name: "Upload" }));
        await user.click(
            screen.getByRole("menuitem", { name: "Upload folder" }),
        );
        expect(onUploadFolder).toHaveBeenCalledOnce();
    });

    it("omits saved files when the caller does not support them", async () => {
        const user = userEvent.setup();
        render(
            <DocumentUploadMenu
                onUploadFiles={vi.fn()}
                onUploadFolder={vi.fn()}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Upload" }));
        expect(screen.queryByRole("menuitem", { name: "Saved files" })).toBeNull();
        expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    });

    it("omits folder upload when the caller does not support it", async () => {
        const user = userEvent.setup();
        render(
            <DocumentUploadMenu
                onSavedFiles={vi.fn()}
                onUploadFiles={vi.fn()}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Upload" }));
        expect(
            screen.queryByRole("menuitem", { name: "Upload folder" }),
        ).toBeNull();
        expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    });

    it("offers no way in when every source is withheld", () => {
        // A null action is "you may not do this here". Folder upload has to
        // answer that the same way files and saved documents do; while it
        // stayed live for a viewer the menu still opened, the native folder
        // picker appeared, and the refusal arrived only once the upload
        // session was under way.
        render(
            <DocumentUploadMenu
                onSavedFiles={null}
                onUploadFiles={null}
                onUploadFolder={null}
            />,
        );

        expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
    });

    it("disables upload while its collection is loading", () => {
        render(
            <DocumentUploadMenu
                onUploadFiles={vi.fn()}
                onUploadFolder={vi.fn()}
                disabled
            />,
        );

        expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
    });
});
