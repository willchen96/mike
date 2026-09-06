import { describe, it, expect, vi } from "vitest";

// verifyCitations only reuses the pure normalizeWithMap matcher from
// documentOps, but importing documentOps pulls in its storage/supabase graph.
// Keep those module side-effects offline — this test injects source text
// directly and never touches storage, proving verification adds no egress
// (air-gap safe).
vi.mock("../supabase", () => ({ createServerSupabase: vi.fn() }));
vi.mock("../storage", () => ({ downloadFile: vi.fn() }));

import {
  locateQuote,
  verifyQuoteAgainstSource,
  verifyCaseCitationAnnotation,
  verifyDocumentCitationAnnotation,
  verifyCitations,
} from "./verifyCitations";

// Deterministic in-memory source text — no storage/model/network. Proves
// verification only reads bytes handed to it (air-gap safe).
const SOURCE = [
  "## Page 1",
  "The Tenant shall pay rent on the first day of each month.",
  "The Landlord may terminate this Lease upon written notice.",
].join("\n");

function fetcherFor(map: Record<string, string>) {
  return async (docId: string) => map[docId] ?? "";
}

function docAnnotation(quotes: { page: number | string; quote: string }[]) {
  return {
    type: "citation_data",
    kind: "document" as const,
    ref: 1,
    doc_id: "doc-1",
    document_id: "uuid-1",
    filename: "lease.pdf",
    page: quotes[0]?.page ?? 1,
    quote: quotes[0]?.quote ?? "",
    quotes,
  };
}

describe("locateQuote", () => {
  it("returns exact offsets for an exact substring match", () => {
    const quote = "pay rent on the first day";
    const loc = locateQuote(SOURCE, quote);
    expect(loc).not.toBeNull();
    expect(SOURCE.slice(loc!.start, loc!.end)).toBe(quote);
    expect(loc!.excerpt).toBe(quote);
  });

  it("returns null when the quote is absent", () => {
    expect(
      locateQuote(SOURCE, "the Tenant shall vacate immediately"),
    ).toBeNull();
  });
});

describe("verifyQuoteAgainstSource", () => {
  it("exact match → verified with correct offsets into the source", () => {
    const quote = "The Landlord may terminate this Lease";
    const v = verifyQuoteAgainstSource(SOURCE, quote);
    expect(v.verified).toBe(true);
    expect(v.needs_correction).toBe(false);
    expect(v.source_excerpt).toBe(quote);
    expect(SOURCE.slice(v.start_char, v.end_char)).toBe(quote);
  });

  it("whitespace + case drift → verified with the exact source excerpt", () => {
    const drifted = "the  landlord   MAY terminate this lease";
    const v = verifyQuoteAgainstSource(SOURCE, drifted);
    expect(v.verified).toBe(true);
    expect(v.needs_correction).toBe(true);
    expect(v.source_excerpt).toBe("The Landlord may terminate this Lease");
    expect(SOURCE.slice(v.start_char, v.end_char)).toBe(v.source_excerpt);
  });

  it("punctuation drift → verified with corrected excerpt and offsets", () => {
    // Model inserted a stray comma the source does not contain.
    const drifted = "pay rent, on the first day";
    const v = verifyQuoteAgainstSource(SOURCE, drifted);
    expect(v.verified).toBe(true);
    expect(v.needs_correction).toBe(true);
    expect(v.source_excerpt).toBe("pay rent on the first day");
    expect(SOURCE.slice(v.start_char, v.end_char)).toBe(v.source_excerpt);
  });

  it("fabricated quote → unverified with no offsets", () => {
    const v = verifyQuoteAgainstSource(SOURCE, "The Tenant waives all rights.");
    expect(v.verified).toBe(false);
    expect(v.start_char).toBeUndefined();
    expect(v.end_char).toBeUndefined();
    expect(v.source_excerpt).toBeUndefined();
  });

  it("empty / unreadable source → unverified", () => {
    expect(verifyQuoteAgainstSource("", "anything").verified).toBe(false);
    expect(
      verifyQuoteAgainstSource("Document could not be read.", "anything")
        .verified,
    ).toBe(false);
  });

  it("cross-page [[PAGE_BREAK]] quote → each segment verified independently", () => {
    const src = "the first day of each month. The Landlord may terminate";
    const quote =
      "the first day of each month[[PAGE_BREAK]]The Landlord may terminate";
    const v = verifyQuoteAgainstSource(src, quote);
    expect(v.verified).toBe(true);
    expect(v.source_excerpt).toContain("[[PAGE_BREAK]]");
  });

  it("cross-page quote with a missing segment → unverified", () => {
    const quote = "the first day of each month[[PAGE_BREAK]]never appears here";
    const v = verifyQuoteAgainstSource(SOURCE, quote);
    expect(v.verified).toBe(false);
  });

  it.each(["...", "…"])(
    "ellipsis-separated quote using %s verifies each excerpt independently",
    (ellipsis) => {
      const quote = `The Tenant shall pay rent${ellipsis}The Landlord may terminate this Lease`;
      const v = verifyQuoteAgainstSource(SOURCE, quote);
      expect(v.verified).toBe(true);
      expect(v.source_excerpt).toBe(
        "The Tenant shall pay rent ... The Landlord may terminate this Lease",
      );
    },
  );

  it("ellipsis-separated quote with a missing excerpt → unverified", () => {
    const quote =
      "The Tenant shall pay rent...the Tenant may sublet without consent";
    const v = verifyQuoteAgainstSource(SOURCE, quote);
    expect(v.verified).toBe(false);
  });

  // ── Adversarial ellipsis abuse ─────────────────────────────────────────
  // These tests ATTACK the matcher instead of confirming it: each quote is
  // built from real source words, so a matcher that merely finds every
  // fragment somewhere would happily verify all of them. The original
  // implementation did exactly that (each segment located independently),
  // so every rejection case below verified as true before this fix.

  it("rejects an ellipsis that swallows a negator and inverts meaning", () => {
    const src =
      "Under clause 9, the landlord is not permitted to terminate this lease during the fixed term.";
    // Reads as "the landlord IS permitted to terminate" — the omitted word
    // is "not". A verified badge here endorses the opposite of the source.
    const v = verifyQuoteAgainstSource(
      src,
      "the landlord is ... permitted to terminate",
    );
    expect(v.verified).toBe(false);
  });

  it("rejects an ellipsis that swallows a negating contraction", () => {
    const src = "The guarantor isn't liable for the tenant's costs.";
    const v = verifyQuoteAgainstSource(
      src,
      "The guarantor ... liable for the tenant's costs",
    );
    expect(v.verified).toBe(false);
  });

  it("rejects an ellipsis that swallows an exception carve-out", () => {
    const src =
      "The deposit shall be returned in full except where the tenant is in breach.";
    const v = verifyQuoteAgainstSource(
      src,
      "The deposit shall be returned in full ... the tenant is in breach",
    );
    expect(v.verified).toBe(false);
  });

  it("rejects fragments stitched together in reverse document order", () => {
    const src =
      "The alpha clause applies to assignments. The beta clause applies to subletting.";
    const v = verifyQuoteAgainstSource(
      src,
      "beta clause applies to subletting ... alpha clause applies to assignments",
    );
    expect(v.verified).toBe(false);
  });

  it("rejects fragments quilted from distant parts of the document", () => {
    const filler = "Unrelated boilerplate filler sentence follows here. ".repeat(
      15,
    ); // ~795 chars — far beyond any plausible single omission
    const src = `The tenant shall maintain the garden. ${filler}The landlord shall insure the building.`;
    const v = verifyQuoteAgainstSource(
      src,
      "The tenant shall maintain the garden ... The landlord shall insure the building",
    );
    expect(v.verified).toBe(false);
  });

  it("rejects a leading ellipsis that truncates away a same-clause negator", () => {
    const src =
      "Under clause 9, the landlord is not permitted to terminate this lease.";
    const v = verifyQuoteAgainstSource(
      src,
      "... permitted to terminate this lease",
    );
    expect(v.verified).toBe(false);
  });

  it("rejects a trailing ellipsis that truncates before a same-clause carve-out", () => {
    const src =
      "The tenant may assign this lease unless the landlord objects in writing.";
    const v = verifyQuoteAgainstSource(src, "The tenant may assign this lease ...");
    expect(v.verified).toBe(false);
  });

  it("rejects a repeated fragment the source only contains once", () => {
    const src = "Rent is payable monthly by standing order.";
    const v = verifyQuoteAgainstSource(src, "standing order ... standing order");
    expect(v.verified).toBe(false);
  });

  // ── Guards against over-blocking: legitimate abbreviations still pass ──

  it("verifies an in-order abbreviation with a benign short omission", () => {
    const src =
      "The tenant shall, at reasonable times, permit the landlord to inspect the premises.";
    const v = verifyQuoteAgainstSource(
      src,
      "The tenant shall ... permit the landlord to inspect",
    );
    expect(v.verified).toBe(true);
    expect(v.needs_correction).toBe(false);
    expect(v.source_excerpt).toBe(
      "The tenant shall ... permit the landlord to inspect",
    );
  });

  it("verifies a leading ellipsis whose negator sits in the previous sentence", () => {
    const src =
      "No pets are allowed on the premises. The tenant shall keep the garden tidy.";
    // "No" belongs to the prior sentence — beyond the clause boundary, it
    // does not bind the quoted fragment and must not veto it.
    const v = verifyQuoteAgainstSource(
      src,
      "... The tenant shall keep the garden tidy",
    );
    expect(v.verified).toBe(true);
  });

  it("backtracks to a later occurrence when the first strands the chain", () => {
    const filler = "Unrelated boilerplate filler sentence follows here. ".repeat(
      15,
    );
    // "Rent is payable monthly" appears twice; only anchoring on the SECOND
    // occurrence keeps the omission within bounds.
    const src = `Rent is payable monthly. ${filler}Rent is payable monthly in advance by standing order.`;
    const v = verifyQuoteAgainstSource(
      src,
      "Rent is payable monthly ... standing order",
    );
    expect(v.verified).toBe(true);
    expect(v.source_excerpt).toBe("Rent is payable monthly ... standing order");
  });

  it("supports ellipsis omissions inside a cross-page quote", () => {
    const quote =
      "The Tenant shall pay...first day of each month[[PAGE_BREAK]]The Landlord may terminate...written notice";
    const v = verifyQuoteAgainstSource(SOURCE, quote);
    expect(v.verified).toBe(true);
    expect(v.source_excerpt).toContain("[[PAGE_BREAK]]");
  });
});

describe("verifyDocumentCitationAnnotation", () => {
  const fetcher = fetcherFor({ "doc-1": SOURCE });

  it("marks a verified quote and attaches per-quote offsets", async () => {
    const ann = (await verifyDocumentCitationAnnotation(
      docAnnotation([{ page: 1, quote: "The Tenant shall pay rent" }]),
      fetcher,
    )) as Record<string, unknown>;
    expect(ann.verified).toBe(true);
    const quotes = ann.quotes as { verification: { verified: boolean } }[];
    expect(quotes[0].verification.verified).toBe(true);
  });

  it("corrects a drifted quote by swapping in the exact source excerpt", async () => {
    const ann = (await verifyDocumentCitationAnnotation(
      docAnnotation([{ page: 1, quote: "the  TENANT shall pay rent" }]),
      fetcher,
    )) as Record<string, unknown>;
    expect(ann.verified).toBe(true);
    const quotes = ann.quotes as {
      quote: string;
      verification: { verified: boolean; source_excerpt: string };
    }[];
    expect(quotes[0].verification.verified).toBe(true);
    expect(quotes[0].verification).not.toHaveProperty("needs_correction");
    // The displayed quote is swapped to the true source text.
    expect(quotes[0].quote).toBe("The Tenant shall pay rent");
    // Legacy top-level quote mirror is updated too.
    expect(ann.quote).toBe("The Tenant shall pay rent");
  });

  it("marks a fabricated quote unverified and preserves the model text", async () => {
    const ann = (await verifyDocumentCitationAnnotation(
      docAnnotation([{ page: 1, quote: "The Tenant may sublet freely." }]),
      fetcher,
    )) as Record<string, unknown>;
    expect(ann.verified).toBe(false);
    const quotes = ann.quotes as { quote: string }[];
    expect(quotes[0].quote).toBe("The Tenant may sublet freely.");
  });

  it("aggregates to unverified when any quote is unverified", async () => {
    const ann = (await verifyDocumentCitationAnnotation(
      docAnnotation([
        { page: 1, quote: "The Tenant shall pay rent" },
        { page: 1, quote: "Nonexistent clause here." },
      ]),
      fetcher,
    )) as Record<string, unknown>;
    expect(ann.verified).toBe(false);
  });

  it("updates verification and corrected text on normalized document quotes", async () => {
    const annotation = {
      ...docAnnotation([
        { page: 1, quote: "the TENANT shall pay rent" },
        { page: 2, quote: "Nonexistent clause here." },
      ]),
      document: {
        document_id: "doc-1",
        title: "lease.docx",
        type: "docx",
        metadata: [],
        quotes: [
          { quote: "the TENANT shall pay rent", target: { page: 1 } },
          { quote: "Nonexistent clause here.", target: { page: 2 } },
        ],
      },
    };

    const verified = (await verifyDocumentCitationAnnotation(
      annotation,
      fetcher,
    )) as Record<string, unknown>;
    const document = verified.document as {
      quotes: { quote: string; verification: { verified: boolean } }[];
    };

    expect(document.quotes).toMatchObject([
      {
        quote: "The Tenant shall pay rent",
        verification: { verified: true },
      },
      {
        quote: "Nonexistent clause here.",
        verification: { verified: false },
      },
    ]);
  });

  it("unreadable source → all quotes unverified", async () => {
    const ann = (await verifyDocumentCitationAnnotation(
      docAnnotation([{ page: 1, quote: "The Tenant shall pay rent" }]),
      fetcherFor({ "doc-1": "Document could not be read." }),
    )) as Record<string, unknown>;
    expect(ann.verified).toBe(false);
  });

  it("leaves case-law annotations untouched (no CourtListener regression)", async () => {
    const caseAnn = {
      type: "citation_data",
      kind: "case",
      ref: 2,
      cluster_id: 42,
      case_name: "Roe v. Doe",
      quotes: [
        { opinionId: null, type: null, author: null, quote: "held that…" },
      ],
    };
    const out = await verifyDocumentCitationAnnotation(caseAnn, fetcher);
    expect(out).toBe(caseAnn);
    expect(out as Record<string, unknown>).not.toHaveProperty("verified");
  });
});

describe("verifyCaseCitationAnnotation", () => {
  const opinions = async () => [
    {
      opinion_id: 11,
      text: "The Court holds that the statutory requirement applies.",
    },
    {
      opinion_id: 12,
      text: "The dissent would reverse the judgment.",
    },
  ];

  it("verifies against the targeted opinion and updates the normalized document", async () => {
    const annotation = {
      type: "citation_data",
      kind: "case",
      ref: 2,
      cluster_id: 42,
      quotes: [
        {
          opinionId: 11,
          type: "lead",
          author: null,
          quote: "the COURT holds that the statutory requirement applies",
        },
      ],
      document: {
        document_id: "case:42",
        title: "Example v Example",
        type: "case",
        metadata: [],
        quotes: [
          {
            quote: "the COURT holds that the statutory requirement applies",
            target: { subdocument_id: "case:42:opinion:11" },
          },
        ],
      },
    };

    const verified = (await verifyCaseCitationAnnotation(
      annotation,
      opinions,
    )) as Record<string, unknown>;
    expect(verified.verified).toBe(true);
    const quotes = verified.quotes as {
      quote: string;
      verification: { verified: boolean };
    }[];
    expect(quotes[0].quote).toBe(
      "The Court holds that the statutory requirement applies",
    );
    expect(quotes[0].verification.verified).toBe(true);
    const document = verified.document as {
      quotes: { quote: string; verification: { verified: boolean } }[];
    };
    expect(document.quotes[0]).toMatchObject({
      quote: "The Court holds that the statutory requirement applies",
      verification: { verified: true },
    });
  });

  it("does not match a quote against a different opinion", async () => {
    const verified = (await verifyCaseCitationAnnotation(
      {
        type: "citation_data",
        kind: "case",
        ref: 2,
        cluster_id: 42,
        quotes: [
          {
            opinionId: 12,
            quote: "The Court holds that the statutory requirement applies.",
          },
        ],
      },
      opinions,
    )) as Record<string, unknown>;
    expect(verified.verified).toBe(false);
  });
});

describe("verifyCitations (batch)", () => {
  it("verifies documents and passes case citations through unchanged", async () => {
    const caseAnn = {
      type: "citation_data",
      kind: "case",
      ref: 2,
      cluster_id: 7,
    };
    const out = await verifyCitations(
      [
        docAnnotation([{ page: 1, quote: "The Tenant shall pay rent" }]),
        caseAnn,
      ],
      fetcherFor({ "doc-1": SOURCE }),
      async () => [],
    );
    expect((out[0] as Record<string, unknown>).verified).toBe(true);
    expect(out[1]).toBe(caseAnn);
  });

  it("verifies case citations when opinion text is available", async () => {
    const out = await verifyCitations(
      [
        {
          type: "citation_data",
          kind: "case",
          ref: 2,
          cluster_id: 7,
          quotes: [{ opinionId: 3, quote: "Binding case text" }],
        },
      ],
      fetcherFor({}),
      async () => [{ opinion_id: 3, text: "Binding case text" }],
    );
    expect(out[0]).toMatchObject({ verified: true });
  });
});
