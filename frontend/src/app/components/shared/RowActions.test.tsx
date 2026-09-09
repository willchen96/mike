import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RowActionMenuItems } from "./RowActions";

// The folder context menu offered "New subfolder" to every reader, and the
// handler behind it opened the name field with no gate of its own — so a
// viewer typed a folder name before the server's refusal arrived. It is shown
// disabled instead, the way Delete already was.
describe("RowActionMenuItems New subfolder", () => {
    it("is disabled and inert when the caller cannot organize folders", () => {
        const onNewSubfolder = vi.fn();
        render(
            <RowActionMenuItems
                onClose={vi.fn()}
                onNewSubfolder={onNewSubfolder}
                newSubfolderDisabled
            />,
        );

        const item = screen.getByRole("button", { name: "New subfolder" });
        expect(item).toBeDisabled();
        expect(item).toHaveAttribute("aria-disabled", "true");

        fireEvent.click(item);
        expect(onNewSubfolder).not.toHaveBeenCalled();
    });

    it("stays live for an editor", () => {
        const onNewSubfolder = vi.fn();
        const onClose = vi.fn();
        render(
            <RowActionMenuItems
                onClose={onClose}
                onNewSubfolder={onNewSubfolder}
            />,
        );

        const item = screen.getByRole("button", { name: "New subfolder" });
        expect(item).toBeEnabled();
        expect(item).not.toHaveAttribute("aria-disabled");

        fireEvent.click(item);
        expect(onNewSubfolder).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
