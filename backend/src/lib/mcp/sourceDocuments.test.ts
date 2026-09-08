import { describe, expect, it } from "vitest";
import { extractLegalDataHunterSource } from "./sourceDocuments";

const context = {
    connectorId: "connector-1",
    serverUrl: "https://legaldatahunter.com/mcp",
    toolName: "get_document",
    arguments: { source: "legifrance", source_id: "JORFTEXT0001" },
};

const result = {
    structuredContent: {
        source: "legifrance",
        source_id: "JORFTEXT0001",
        data_type: "legislation",
        title: "Code civil, article 1103",
        text: "Exact source text",
        text_truncated: false,
        url:
            "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006436298",
    },
};

describe("Legal Data Hunter source documents", () => {
    it("turns a complete get_document response into a panel document", () => {
        const source = extractLegalDataHunterSource(result, context);

        expect(source).toMatchObject({
            text: "Exact source text",
            document: {
                document_id: "mcp:connector-1:legifrance:JORFTEXT0001",
                title: "Code civil, article 1103",
                type: "legislation",
                actions: [{ label: "Official source" }],
                subdocuments: [{ text: "Exact source text" }],
            },
        });
    });

    it.each([
        ["case_law", "case"],
        ["legislation", "legislation"],
        ["doctrine", "legal_research"],
    ])("maps %s to %s", (dataType, type) => {
        expect(
            extractLegalDataHunterSource(
                {
                    structuredContent: {
                        ...result.structuredContent,
                        data_type: dataType,
                    },
                },
                context,
            )?.document.type,
        ).toBe(type);
    });

    it("rejects previews, noncanonical endpoints, and mismatched responses", () => {
        expect(
            extractLegalDataHunterSource(result, {
                ...context,
                toolName: "search",
            }),
        ).toBeNull();
        expect(
            extractLegalDataHunterSource(result, {
                ...context,
                serverUrl: "https://legaldatahunter.com/mcp?variant=other",
            }),
        ).toBeNull();
        expect(
            extractLegalDataHunterSource(result, {
                ...context,
                arguments: { source: "other", source_id: "JORFTEXT0001" },
            }),
        ).toBeNull();
    });
});
