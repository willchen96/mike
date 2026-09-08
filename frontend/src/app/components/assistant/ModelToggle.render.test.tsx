import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModelToggle, underlyingProviderGroup } from "./ModelToggle";
import type { ApiKeyState } from "@/app/lib/mikeApi";

vi.mock("@/app/hooks/useOllamaModels", () => ({
    useOllamaModels: () => [],
}));

function keys(configured: Partial<Record<keyof ApiKeyState, boolean>>) {
    const providers = [
        "claude",
        "gemini",
        "openai",
        "openrouter",
        "vercel",
        "opencode-go",
        "courtlistener",
    ] as const;
    return Object.fromEntries(
        providers.map((provider) => [
            provider,
            {
                configured: configured[provider] ?? false,
                source: configured[provider] ? "user" : null,
            },
        ]),
    ) as unknown as ApiKeyState;
}

describe("ModelToggle responsive trigger", () => {
    it("offers every supported reasoning level through a discrete slider", async () => {
        const user = userEvent.setup();
        const onReasoningChange = vi.fn();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
                reasoningLevel="high"
                onReasoningChange={onReasoningChange}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));
        const reasoning = screen.getByRole("slider", {
            name: "Reasoning level",
        });
        expect(reasoning).toHaveAttribute("min", "0");
        expect(reasoning).toHaveAttribute("max", "4");
        expect(reasoning).toHaveValue("3");
        expect(reasoning).toHaveAttribute("aria-valuetext", "High");

        fireEvent.change(reasoning, { target: { value: "4" } });

        expect(onReasoningChange).toHaveBeenLastCalledWith("xhigh");
        expect(
            screen.getByRole("slider", { name: "Reasoning level" }),
        ).toBeInTheDocument();
    });

    it("offers Max for GPT-5.6 without offering Minimal", async () => {
        const onReasoningChange = vi.fn();
        render(
            <ModelToggle
                value="gpt-5.6-terra"
                onChange={vi.fn()}
                apiKeys={keys({ openai: true })}
                reasoningLevel="low"
                onReasoningChange={onReasoningChange}
            />,
        );

        await userEvent.click(
            screen.getByRole("button", { name: "Choose model" }),
        );
        const reasoning = screen.getByRole("slider", {
            name: "Reasoning level",
        });
        expect(reasoning).toHaveAttribute("max", "5");
        expect(reasoning).toHaveValue("1");
        expect(screen.queryByText("Minimal")).not.toBeInTheDocument();

        fireEvent.change(reasoning, { target: { value: "5" } });
        expect(onReasoningChange).toHaveBeenLastCalledWith("max");
    });

    it("uses the provider-supported GPT-5.5 levels", async () => {
        const onReasoningChange = vi.fn();
        render(
            <ModelToggle
                value="gpt-5.5"
                onChange={vi.fn()}
                apiKeys={keys({ openai: true })}
                reasoningLevel="low"
                onReasoningChange={onReasoningChange}
            />,
        );

        await userEvent.click(
            screen.getByRole("button", { name: "Choose model" }),
        );
        const reasoning = screen.getByRole("slider", {
            name: "Reasoning level",
        });
        expect(reasoning).toHaveAttribute("max", "4");
        expect(reasoning).toHaveValue("1");
        expect(screen.queryByText("Minimal")).not.toBeInTheDocument();
    });

    it("reaches and changes reasoning with Radix keyboard navigation", async () => {
        const user = userEvent.setup();
        const onReasoningChange = vi.fn();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
                reasoningLevel="high"
                onReasoningChange={onReasoningChange}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));
        await user.keyboard("{End}");

        const reasoning = screen.getByRole("slider", {
            name: "Reasoning level",
        });
        expect(reasoning).toHaveFocus();

        await user.keyboard("{ArrowRight}");
        expect(onReasoningChange).toHaveBeenLastCalledWith("xhigh");
    });

    it("uses the Settings2 icon in a compact chat input", () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                compact
            />,
        );

        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger).toHaveClass("w-8", "rounded-lg");
        expect(trigger).not.toHaveClass("rounded-full");
        expect(trigger).not.toHaveTextContent("No API Key");
        expect(trigger.querySelector("svg")).toBeInTheDocument();
    });

    it("allows a wider model label in the regular trigger", () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
            />,
        );

        expect(screen.getByText("Gemini 3 Flash")).toHaveClass("max-w-[200px]");
    });

    it("does not add an inset shadow to the selected model row", async () => {
        const user = userEvent.setup();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));

        const selectedRow = screen
            .getAllByText("Gemini 3 Flash")
            .find((element) => element.closest('[role="menuitem"]'))
            ?.closest('[role="menuitem"]');
        expect(selectedRow).toHaveClass("theme-dropdown-item", "text-gray-900");
        expect(selectedRow).toHaveClass("rounded-md");
        expect(selectedRow).not.toHaveClass("rounded-xl");
        expect(selectedRow).toHaveAttribute("data-selected", "true");
        expect(selectedRow?.className).not.toContain("shadow-[inset_");
    });
});

describe("ModelToggle availability states", () => {
    it("renders a neutral disabled trigger while keys are loading", () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeysLoading
            />,
        );

        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger).toBeDisabled();
        // The load-time flash: never claim "No API Key" before we know.
        expect(trigger).not.toHaveTextContent("No API Key");
        expect(trigger).toHaveTextContent("Gemini 3 Flash");
    });

    it("fails open when key state is unknown after a failed load", () => {
        render(
            <ModelToggle value="gemini-3-flash-preview" onChange={vi.fn()} />,
        );

        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger).toBeEnabled();
        expect(trigger).not.toHaveTextContent("No API Key");
        expect(trigger).toHaveTextContent("Gemini 3 Flash");
    });

    it("shows No Models and invokes the API-key warning when no providers are configured", async () => {
        const user = userEvent.setup();
        const onNoModelsClick = vi.fn();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({})}
                onNoModelsClick={onNoModelsClick}
            />,
        );

        const trigger = screen.getByRole("button", {
            name: "No models available",
        });
        expect(trigger).toBeEnabled();
        expect(trigger).toHaveTextContent("No Models");
        expect(trigger.querySelector("svg")).not.toBeInTheDocument();
        await user.click(trigger);
        expect(onNoModelsClick).toHaveBeenCalledWith("api-keys");
    });

    it("invokes the router warning when a configured router has no saved models", async () => {
        const user = userEvent.setup();
        const onNoModelsClick = vi.fn();
        render(
            <ModelToggle
                value=""
                onChange={vi.fn()}
                apiKeys={keys({ openrouter: true })}
                openRouterModels={[]}
                onNoModelsClick={onNoModelsClick}
            />,
        );

        await user.click(
            screen.getByRole("button", { name: "No models available" }),
        );
        expect(onNoModelsClick).toHaveBeenCalledWith("router-models");
    });

    it("filters to configured providers when keys are loaded", () => {
        render(
            <ModelToggle
                value="claude-fable-5"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
            />,
        );

        // Claude has no key: the stored selection is not offered, so the
        // trigger falls back to the picker prompt.
        expect(
            screen.getByRole("button", { name: "Choose model" }),
        ).toHaveTextContent("Select model");
    });
});

describe("ModelToggle provider grouping", () => {
    it("maps router catalog IDs to their underlying model providers", () => {
        expect(
            underlyingProviderGroup("anthropic/claude-fable-5", "openrouter"),
        ).toBe("Anthropic");
        expect(underlyingProviderGroup("kimi-k3", "opencode-go")).toBe(
            "Moonshot AI",
        );
    });

    it("offers the user's saved OpenCode Go models once the key is configured", async () => {
        const user = userEvent.setup();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true, "opencode-go": true })}
                openCodeGoModels={["glm-5"]}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));
        await user.click(await screen.findByText("Zhipu AI"));

        expect(await screen.findByText("Glm 5")).toBeInTheDocument();
        expect(screen.queryByText("OpenCode Go")).not.toBeInTheDocument();
    });

    it("hides the group when the OpenCode Go key is missing", async () => {
        const user = userEvent.setup();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
                openCodeGoModels={["glm-5"]}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));

        expect(screen.queryByText("OpenCode Go")).not.toBeInTheDocument();
    });

    it("shows route labels only when the same provider model has duplicates", async () => {
        const user = userEvent.setup();
        render(
            <ModelToggle
                value="claude-fable-5"
                onChange={vi.fn()}
                apiKeys={keys({ claude: true, openrouter: true })}
                openRouterModels={["anthropic/claude-fable-5"]}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));

        expect(screen.getByText("Direct")).toBeInTheDocument();
        expect(screen.getByText("OpenRouter")).toBeInTheDocument();
    });
});


describe("deployment gateway models", () => {
    it("shows configured names and group/source without router selections or reasoning", async () => {
        const apiKeys = keys({});
        apiKeys.gateway = { provider: "gateway", label: "Legal models", available: true, defaultModel: "gateway/legal-chat", models: [
            { id: "gateway/legal-chat", label: "Legal chat", group: "Legal models", source: "Legal models", provider: "gateway", available: true },
            { id: "gateway/offline", label: "Unavailable model", group: "Legal models", source: "Legal models", provider: "gateway", available: false },
        ] };
        const onChange = vi.fn();
        render(<ModelToggle value="gateway/legal-chat" onChange={onChange} apiKeys={apiKeys} reasoningLevel="high" onReasoningChange={vi.fn()} />);
        await userEvent.click(screen.getByRole("button", { name: "Choose model" }));
        expect(screen.getAllByText("Legal models").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Legal chat").length).toBeGreaterThan(0);
        expect(screen.queryByText("Unavailable model")).not.toBeInTheDocument();
        expect(screen.queryByRole("slider")).not.toBeInTheDocument();
        expect(screen.queryByText("Gemini 3.7 Flash")).not.toBeInTheDocument();
    });
});
