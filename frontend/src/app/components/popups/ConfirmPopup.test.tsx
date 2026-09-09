import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConfirmPopup } from "./ConfirmPopup";

describe("ConfirmPopup", () => {
  it("uses the configured danger variant for non-Delete labels", () => {
    render(
      <ConfirmPopup
        open
        title="Remove members?"
        confirmLabel="Remove"
        confirmVariant="danger"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Remove" })).toHaveClass(
      "bg-red-600/90",
    );
  });

  it("does not infer the button variant from its label", () => {
    render(
      <ConfirmPopup
        open
        title="Continue?"
        confirmLabel="Delete"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass(
      "bg-gray-950/88",
    );
  });

  it("announces itself as a dialog named by its title", () => {
    render(
      <ConfirmPopup
        open
        title="Remove members?"
        message="They lose access."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Remove members?" }),
    ).toBeInTheDocument();
  });

  it("still has a name when it asks without a title", () => {
    render(<ConfirmPopup open message="Sure?" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(
      screen.getByRole("dialog", { name: "Confirm action" }),
    ).toBeInTheDocument();
  });

  it("cancels on Escape", () => {
    // It took the keyboard's attention and answered only to the mouse.
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmPopup
        open
        title="Remove members?"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not answer Escape once closed", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConfirmPopup open title="Remove?" onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    rerender(
      <ConfirmPopup
        open={false}
        title="Remove?"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onCancel).not.toHaveBeenCalled();
  });
});
