import type { MikeWorkflow } from "../shared/types";

export const BUILT_IN_WORKFLOWS: MikeWorkflow[] = [
    {
        id: "builtin-cp-checklist",
        user_id: null,
        is_system: true,
        created_at: "",
        title: "Generate CP Checklist",
        type: "assistant",
        practice: "Contratos e Transações",
        prompt_md:
            "## Generate Conditions Precedent Checklist\n\n" +
            "Review the uploaded credit agreement or financing document and generate a comprehensive " +
            "Conditions Precedent (CP) checklist.\n\n" +
            "You MUST use the generate_docx tool to produce the checklist as a downloadable Word document. " +
            "You MUST pass landscape: true to the generate_docx tool — the document must be in landscape orientation. " +
            "Do not display the checklist inline — generate the .docx file and provide the download link.\n\n" +
            "Structure the document as follows:\n" +
            "- For each category of conditions (e.g. Corporate, Financial, Legal, Security), add a section with a heading\n" +
            "- Under each category heading, include a table with exactly these four columns in this order:\n" +
            "  1. Index — sequential number within the category (1, 2, 3…)\n" +
            "  2. Clause Number — the clause or schedule reference from the agreement\n" +
            "  3. Clause — a concise description of the condition precedent\n" +
            "  4. Status — leave blank (empty string) for the user to fill in\n\n" +
            "Use the table field in the section object (not content) for each category's rows.",
        columns_config: null,
    },
    {
        id: "builtin-coc-dd",
        user_id: null,
        is_system: true,
        created_at: "",
        title: "Change of Control Review",
        type: "tabular",
        practice: "Direito Societário",
        prompt_md:
            "## Change of Control Due Diligence Review\n\n" +
            "This workflow performs a change of control due diligence review across the selected documents.",
        columns_config: [
            {
                index: 0,
                name: "Parties",
                format: "bulleted_list",
                prompt: "Identify all parties to this agreement. For each party state their full legal name and their role (e.g. counterparty, licensor, lender, supplier).",
            },
            {
                index: 1,
                name: "Date",
                format: "date",
                prompt: "What is the date of this agreement? If a commencement date differs from the signing date, state both.",
            },
            {
                index: 2,
                name: "Term",
                format: "text",
                prompt: "What is the term or duration of this agreement? State the start and end dates or the length of the term.",
            },
            {
                index: 3,
                name: "Change of Control Clause",
                prompt: "Identify and summarize the change of control clause(s) in this document. Quote the exact triggering language and specify what constitutes a 'change of control'.",
            },
            {
                index: 4,
                name: "Consent Required",
                prompt: "Does a change of control require prior consent from any party? Identify who must consent, the notice period, and any conditions.",
            },
            {
                index: 5,
                name: "Termination Rights",
                prompt: "What termination rights arise upon a change of control? Who can terminate, and what are the notice requirements?",
            },
            {
                index: 6,
                name: "Put/Call Options",
                prompt: "Are there any put or call options triggered by a change of control? Summarize the terms, pricing, and exercise period.",
            },
            {
                index: 7,
                name: "Financial Implications",
                prompt: "What are the financial implications of a change of control? Include any fees, payments, accelerated obligations, or pricing adjustments.",
            },
        ],
    },
    {
        id: "builtin-credit-summary",
        user_id: null,
        is_system: true,
        created_at: "",
        title: "Credit Agreement Summary",
        type: "assistant",
        practice: "Direito Financeiro",
        prompt_md:
            "## Credit Agreement Summary\n\n" +
            "Review the uploaded credit agreement and produce a comprehensive legal summary covering the following topics. " +
            "For each section, identify the key provisions, quote the relevant clause or schedule references, and flag any unusual, onerous, or non-market terms.\n\n" +
            "1. **Lenders** — All lenders or members of the lender syndicate, including their full legal name and role (e.g. mandated lead arranger, original lender, agent bank)\n" +
            "2. **Borrowers** — All borrowers, including their full legal name and jurisdiction of incorporation\n" +
            "3. **Guarantors** — All guarantors, including their full legal name and the scope of their guarantee obligation\n" +
            "4. **Other Parties** — Any other material parties (e.g. facility agent, security agent, hedge counterparties, issuing bank) and their roles\n" +
            "5. **Date of Agreement** — Date of the credit agreement\n" +
            "6. **Facilities** — Each facility available (e.g. Revolving Credit Facility, Term Loan A, Term Loan B, Term Loan C), the facility type, tranche name, and any key structural features\n" +
            "7. **Amount** — Total committed amount across all facilities, the currency, and breakdown by tranche if applicable\n" +
            "8. **Purpose** — Stated purpose for which borrowings may be used and any restrictions on use of proceeds\n" +
            "9. **Interest** — Applicable reference rate (e.g. SOFR, EURIBOR, base rate), the margin, any margin ratchet mechanism, and how interest periods are structured\n" +
            "10. **Commitment Fee** — Commitment or utilisation fees, the applicable rate, how they are calculated, and the basis (e.g. undrawn commitment, average utilisation)\n" +
            "11. **Repayment Schedule** — Repayment profile for each facility, whether by scheduled instalments or bullet repayment, and the repayment dates and amounts\n" +
            "12. **Maturity** — Final maturity date for each facility\n" +
            "13. **Security** — Each class of security granted or required (e.g. share pledges, fixed and floating charges, real estate mortgages, account pledges) and the assets or entities over which security is taken\n" +
            "14. **Guarantees** — Guarantee obligations, the guarantors, the scope of the guarantee, and any limitations (e.g. up-stream guarantee limitations, guarantor coverage test)\n" +
            "15. **Financial Covenants** — Each financial covenant, the metric (e.g. leverage ratio, interest cover, cashflow cover), the applicable test, testing frequency, and any equity cure rights\n" +
            "16. **Events of Default** — Each event of default, noting any grace periods, materiality thresholds, or cross-default provisions\n" +
            "17. **Assignment** — Restrictions or permissions on assignment or transfer (e.g. white/blacklists, borrower consent for lender transfers; restrictions on borrower assignment)\n" +
            "18. **Change of Control** — What constitutes a change of control, what obligations it triggers (e.g. mandatory prepayment, cancellation, lender consent), and any cure period\n" +
            "19. **Prepayment Fee** — Any prepayment fees, make-whole premiums, or soft-call protections, the applicable fee, the period during which it applies, and any exceptions (e.g. prepayment from insurance proceeds or asset disposals)\n" +
            "20. **Governing Law** — Governing law of the agreement\n" +
            "21. **Dispute Resolution** — Whether disputes go to litigation or arbitration, the chosen forum or seat, and any submission to jurisdiction provisions\n\n" +
            "Deliver the summary inline in your chat response — do NOT call generate_docx. Only produce a downloadable Word document if the user explicitly asks for one.",
        columns_config: null,
    },

    // ─── Commercial Agreement ───────────────────────────────────────────────────
    {
        id: "builtin-commercial-agreement",
        user_id: null,
        is_system: true,
        created_at: "",
        title: "Commercial Agreement Review",
        type: "tabular",
        practice: "Contratos e Transações",
        prompt_md: null,
        columns_config: [
            {
                index: 0,
                name: "Parties",
                format: "bulleted_list",
                prompt: "Identify all parties to this agreement. For each party state their full legal name, jurisdiction of incorporation (if stated), and their role in the agreement (e.g. supplier, customer, licensor).",
            },
            {
                index: 1,
                name: "Scope of Work",
                format: "text",
                prompt: "Summarise the scope of work or services to be provided under this agreement. What are the key deliverables, obligations, or services? Identify any limitations or exclusions to the scope.",
            },
            {
                index: 2,
                name: "Amends Earlier Agreement",
                format: "yes_no",
                prompt: "Does this agreement amend, restate, supplement, or replace an earlier agreement? If yes, identify the earlier agreement by name and date.",
            },
            {
                index: 3,
                name: "Effective Date",
                format: "date",
                prompt: "What is the effective date or commencement date of this agreement? If no explicit date is stated, note when it is deemed to take effect.",
            },
            {
                index: 4,
                name: "Term",
                format: "text",
                prompt: "What is the duration or term of this agreement? State the initial term length and any conditions that affect the duration.",
            },
            {
                index: 5,
                name: "Renewal",
                format: "text",
                prompt: "What renewal provisions apply? Specify whether renewal is automatic or requires notice, the renewal period, and any conditions or notice periods required to prevent automatic renewal.",
            },
            {
                index: 6,
                name: "Pricing",
                format: "text",
                prompt: "What is the pricing structure under this agreement? Identify all fees, rates, charges, and payment terms including currency, payment schedule, and invoicing requirements.",
            },
            {
                index: 7,
                name: "Price Adjustments",
                format: "text",
                prompt: "Are there any price adjustment mechanisms in this agreement? Identify any indexation, CPI/RPI linkage, benchmarking, volume-based adjustments, or other mechanisms that allow prices to change over the term.",
            },
            {
                index: 8,
                name: "Penalties for Late Payment",
                format: "text",
                prompt: "What penalties or consequences apply for late payment? Include any interest rates on overdue amounts, suspension rights, or other remedies available to the payee.",
            },
            {
                index: 9,
                name: "Estimated Contract Value",
                format: "monetary_amount",
                prompt: "What is the total estimated or stated contract value? If no single figure is given, calculate or estimate based on stated rates and term. State the currency and any assumptions made.",
            },
            {
                index: 10,
                name: "Limitation of Liability",
                format: "text",
                prompt: "What limitations of liability apply? Identify any caps on liability (including how they are calculated), exclusions of consequential or indirect loss, and any carve-outs from the cap (e.g. fraud, death, IP infringement).",
            },
            {
                index: 11,
                name: "IP Ownership and Licensing",
                format: "text",
                prompt: "How is intellectual property ownership and licensing addressed? Identify who owns pre-existing IP, who owns newly created IP, and what licences are granted to each party. Note any restrictions on use.",
            },
            {
                index: 12,
                name: "Change of Control",
                format: "text",
                prompt: "Is there a change of control provision? If so, describe what constitutes a change of control, whether consent is required, and what rights (e.g. termination, assignment) are triggered.",
            },
            {
                index: 13,
                name: "Force Majeure",
                format: "text",
                prompt: "Summarise the force majeure clause. What events qualify, what obligations are suspended, how long must the event persist before termination is permitted, and what notice is required?",
            },
            {
                index: 14,
                name: "Termination Rights",
                format: "text",
                prompt: "What are the termination rights of each party? Identify termination for convenience (including notice period), termination for cause (including cure periods), and the consequences of termination (e.g. payment obligations, survival of terms).",
            },
            {
                index: 15,
                name: "Liquidated Damages",
                format: "text",
                prompt: "Are there any liquidated damages provisions? If so, identify what triggers them, the applicable rate or formula, any cap on aggregate liquidated damages, and whether they are the exclusive remedy.",
            },
            {
                index: 16,
                name: "Governing Law",
                format: "text",
                prompt: "What governing law applies to this agreement? State the jurisdiction and any specific legal system referenced.",
            },
            {
                index: 17,
                name: "Dispute Resolution",
                format: "text",
                prompt: "How are disputes resolved under this agreement? Identify whether disputes go to litigation or arbitration, the chosen forum or seat, any escalation or mediation steps required before formal proceedings, and the language of proceedings.",
            },
        ],
    },

    // ─── Credit Agreement ────────────────────────────────────────────────────────
    {
        id: "builtin-credit-agreement",
        user_id: null,
        is_system: true,
        created_at: "",
        title: "Credit Agreement Review",
        type: "tabular",
        practice: "Direito Financeiro",
        prompt_md: null,
        columns_config: [
            {
                index: 0,
                name: "Lenders",
                format: "bulleted_list",
                prompt: "Identify all lenders (or the lender syndicate) named in this agreement. For each, state their full legal name and role (e.g. mandated lead arranger, original lender, agent bank).",
            },
            {
                index: 1,
                name: "Borrowers",
                format: "bulleted_list",
                prompt: "Identify all borrowers named in this agreement, including their full legal name and jurisdiction of incorporation.",
            },
            {
                index: 2,
                name: "Guarantors",
                format: "bulleted_list",
                prompt: "Identify all guarantors named in this agreement, including their full legal name and the scope of their guarantee obligation.",
            },
            {
                index: 3,
                name: "Other Parties",
                format: "bulleted_list",
                prompt: "Identify any other material parties to this agreement (e.g. facility agent, security agent, hedge counterparties, issuing bank). State their name and role.",
            },
            {
                index: 4,
                name: "Date of Agreement",
                format: "date",
                prompt: "What is the date of this credit agreement?",
            },
            {
                index: 5,
                name: "Facility",
                format: "bulleted_list",
                prompt: "List each facility available under this agreement (e.g. Revolving Credit Facility, Term Loan A, Term Loan B, Term Loan C). For each, state the facility type, tranche name, and any key structural features.",
            },
            {
                index: 6,
                name: "Amount",
                format: "monetary_amount",
                prompt: "What is the total committed amount available under this agreement across all facilities? State the amount, currency, and breakdown by tranche if applicable.",
            },
            {
                index: 7,
                name: "Purpose",
                format: "text",
                prompt: "What is the stated purpose for which borrowings under this agreement may be used? Identify any restrictions on use of proceeds.",
            },
            {
                index: 8,
                name: "Interest",
                format: "text",
                prompt: "What interest rate applies to borrowings under this agreement? Identify the applicable rate (e.g. SOFR, EURIBOR, base rate), the margin, any margin ratchet mechanism, and how interest periods are structured.",
            },
            {
                index: 9,
                name: "Commitment Fee",
                format: "text",
                prompt: "Is there a commitment fee or utilisation fee? If so, state the applicable rate, how it is calculated, and on what basis (e.g. undrawn commitment, average utilisation).",
            },
            {
                index: 10,
                name: "Repayment Schedule",
                format: "text",
                prompt: "Summarise the repayment schedule for each facility. Identify whether repayment is by scheduled instalments or bullet repayment, and state the repayment dates and amounts where specified.",
            },
            {
                index: 11,
                name: "Maturity",
                format: "date",
                prompt: "What is the final maturity date of the facilities under this agreement? If different facilities have different maturities, state each.",
            },
            {
                index: 12,
                name: "Security",
                format: "bulleted_list",
                prompt: "What security is granted or required to be granted under this agreement? List each class of security (e.g. share pledges, fixed and floating charges, real estate mortgages, account pledges) and the assets or entities over which security is taken.",
            },
            {
                index: 13,
                name: "Guarantees",
                format: "bulleted_list",
                prompt: "What guarantee obligations are given under or in connection with this agreement? Identify the guarantors, the scope of the guarantee, and any limitations (e.g. up-stream guarantee limitations, guarantor coverage test).",
            },
            {
                index: 14,
                name: "Financial Covenants",
                format: "bulleted_list",
                prompt: "What financial covenants are included in this agreement? For each covenant identify the metric (e.g. leverage ratio, interest cover, cashflow cover), the applicable test, the testing frequency, and any equity cure rights.",
            },
            {
                index: 15,
                name: "Events of Default",
                format: "bulleted_list",
                prompt: "List the events of default under this agreement. For each, note any grace periods, materiality thresholds, or cross-default provisions.",
            },
            {
                index: 16,
                name: "Assignment",
                format: "text",
                prompt: "What restrictions or permissions apply to assignment or transfer of rights under this agreement? Identify restrictions on lender transfers (e.g. white/blacklists, borrower consent) and on borrower assignment.",
            },
            {
                index: 17,
                name: "Change of Control",
                format: "text",
                prompt: "Is there a change of control provision? If so, what constitutes a change of control, what obligations does it trigger (e.g. mandatory prepayment, cancellation, lender consent), and is there any cure period?",
            },
            {
                index: 18,
                name: "Prepayment Fee",
                format: "text",
                prompt: "Are there any prepayment fees, make-whole premiums, or soft-call protections? If so, state the applicable fee, the period during which it applies, and any exceptions (e.g. prepayment from insurance proceeds or asset disposal).",
            },
            {
                index: 19,
                name: "Governing Law",
                format: "text",
                prompt: "What governing law applies to this agreement? State the jurisdiction and any specific legal system referenced.",
            },
            {
                index: 20,
                name: "Dispute Resolution",
                format: "text",
                prompt: "How are disputes resolved under this agreement? Identify whether disputes go to litigation or arbitration, the chosen forum or seat, and any submission to jurisdiction provisions.",
            },
        ],
    },

    // ─── E-Discovery ─────────────────────────────────────────────────────────────
    {
        id: "builtin-ediscovery",
        user_id: null,
        is_system: true,
        created_at: "",
        title: "E-Discovery Review",
        type: "tabular",
        practice: "Contencioso",
        prompt_md: null,
        columns_config: [
            {
                index: 0,
                name: "Date",
                format: "date",
                prompt: "What is the date of this document? For emails or correspondence, use the date sent. For other documents, use the date of creation, signature, or the most prominent date shown.",
            },
            {
                index: 1,
                name: "Type of Document",
                format: "text",
                prompt: "What type of document is this? (e.g. email, memorandum, letter, contract, report, meeting minutes, text message, invoice, presentation). Be specific.",
            },
            {
                index: 2,
                name: "Sender",
                format: "text",
                prompt: "Who is the sender or author of this document? State their full name, title, and organisation where identifiable.",
            },
            {
                index: 3,
                name: "Recipient(s)",
                format: "bulleted_list",
                prompt: "Who are the recipients of this document? List all To, CC, and BCC recipients where identifiable. State their full name, title, and organisation for each. Note whether they appear in To, CC, or BCC fields.",
            },
            {
                index: 4,
                name: "Summary",
                format: "text",
                prompt: "Provide a concise factual summary of the content of this document in 2–4 sentences. Focus on the key subject matter, any decisions made, actions requested, or information conveyed. Do not include legal conclusions.",
            },
            {
                index: 5,
                name: "Persons Mentioned",
                format: "bulleted_list",
                prompt: "List all individuals mentioned in this document (other than the sender and recipients already identified). For each person, state their name and, if discernible, their role or organisation.",
            },
            {
                index: 6,
                name: "Privileged?",
                format: "yes_no",
                prompt: "Does this document appear to be legally privileged? Answer Yes if it appears to be a communication between a lawyer and client made for the dominant purpose of obtaining or giving legal advice, or created for the dominant purpose of litigation. Answer No otherwise. If uncertain, note the basis for uncertainty.",
            },
        ],
    },

    // ─── Supply Agreement ────────────────────────────────────────────────────────
    {
        id: "builtin-supply-agreement",
        user_id: null,
        is_system: true,
        created_at: "",
        title: "Supply Agreement Review",
        type: "tabular",
        practice: "Contratos e Transações",
        prompt_md: null,
        columns_config: [
            {
                index: 0,
                name: "Parties",
                format: "bulleted_list",
                prompt: "Identify all parties to this supply agreement. For each, state their full legal name, jurisdiction of incorporation (if stated), and their role (e.g. supplier, buyer, distributor).",
            },
            {
                index: 1,
                name: "Effective Date",
                format: "date",
                prompt: "What is the effective date or commencement date of this agreement? If no explicit date is stated, note the date it is deemed to take effect.",
            },
            {
                index: 2,
                name: "Products",
                format: "bulleted_list",
                prompt: "What products are to be supplied under this agreement? List each product or product category, including any relevant specifications, part numbers, or standards referenced.",
            },
            {
                index: 3,
                name: "Term",
                format: "text",
                prompt: "What is the initial term or duration of this agreement? State the start date (or reference to when it commences) and the end date or duration.",
            },
            {
                index: 4,
                name: "Renewal",
                format: "text",
                prompt: "What renewal provisions apply? Is renewal automatic or by agreement? State the renewal period, notice requirements to prevent renewal, and any conditions on renewal.",
            },
            {
                index: 5,
                name: "Delivery",
                format: "text",
                prompt: "What delivery obligations and terms apply? Identify the delivery terms (e.g. Incoterms), delivery lead times, delivery locations, risk of loss, and any consequences for late or failed delivery.",
            },
            {
                index: 6,
                name: "Quality",
                format: "text",
                prompt: "What quality standards or specifications apply to the products? Identify any applicable standards (e.g. ISO, regulatory requirements), inspection rights, acceptance procedures, and consequences of non-conformance.",
            },
            {
                index: 7,
                name: "Warranties",
                format: "text",
                prompt: "What warranties does the supplier give in relation to the products? State the warranty period, the scope of the warranty (e.g. free from defects, conformance to specifications), the remedy for breach (e.g. repair, replacement, refund), and any exclusions.",
            },
            {
                index: 8,
                name: "Liquidated Damages",
                format: "text",
                prompt: "Are there any liquidated damages provisions? If so, identify what triggers them (e.g. late delivery, failure to meet quality standards), the applicable rate or formula, any aggregate cap, and whether they are stated to be the exclusive remedy.",
            },
            {
                index: 9,
                name: "Limitation of Liability",
                format: "text",
                prompt: "What limitations of liability apply? Identify any caps on liability (and how they are calculated, e.g. contract value, fees paid), exclusions of consequential or indirect loss, and any carve-outs from the limitation (e.g. fraud, wilful misconduct, death or personal injury).",
            },
            {
                index: 10,
                name: "Force Majeure",
                format: "text",
                prompt: "Summarise the force majeure clause. What events qualify, what obligations are suspended, what notice must be given, how long must the event persist before either party may terminate, and what are the consequences of termination for force majeure?",
            },
            {
                index: 11,
                name: "Termination Rights",
                format: "text",
                prompt: "What are the termination rights of each party? Distinguish between termination for convenience (including notice period) and termination for cause (including cure periods and triggers). Note what happens on termination, including any outstanding purchase orders or payment obligations.",
            },
            {
                index: 12,
                name: "Governing Law",
                format: "text",
                prompt: "What governing law applies to this agreement? State the jurisdiction and any specific legal system referenced.",
            },
            {
                index: 13,
                name: "Dispute Resolution",
                format: "text",
                prompt: "How are disputes resolved under this agreement? Identify whether disputes go to litigation or arbitration, the chosen forum or seat, and any mandatory escalation steps (e.g. negotiation, mediation) before formal proceedings.",
            },
        ],
    },

    // ─── SPA ─────────────────────────────────────────────────────────────────────
    {
        id: "builtin-spa",
        user_id: null,
        is_system: true,
        created_at: "",
        title: "SPA Review",
        type: "tabular",
        practice: "Direito Societário",
        prompt_md: null,
        columns_config: [
            {
                index: 0,
                name: "Parties",
                format: "bulleted_list",
                prompt: "Identify all parties to this share purchase agreement. For each, state their full legal name, jurisdiction of incorporation (if stated), and their role (e.g. seller, buyer, target company, warrantor, guarantor).",
            },
            {
                index: 1,
                name: "Date",
                format: "date",
                prompt: "What is the date of this share purchase agreement?",
            },
            {
                index: 2,
                name: "Transaction",
                format: "text",
                prompt: "Summarise the transaction. What shares or interests are being acquired, in which target company or companies, and what is the nature of the transaction (e.g. 100% acquisition, majority stake, minority investment)?",
            },
            {
                index: 3,
                name: "Consideration",
                format: "monetary_amount",
                prompt: "What is the consideration payable under this agreement? State the total headline price, the currency, and the structure (e.g. cash, shares, loan notes, deferred consideration, earnout). If the price is subject to adjustment (e.g. locked box, completion accounts), describe the mechanism.",
            },
            {
                index: 4,
                name: "Key Conditions Precedent",
                format: "bulleted_list",
                prompt: "List the key conditions precedent (CPs) to completion. For each CP, state what must be satisfied or waived and by whom. Identify any long-stop date by which CPs must be satisfied.",
            },
            {
                index: 5,
                name: "Completion Date",
                format: "text",
                prompt: "When does completion occur? State how many business days after satisfaction or waiver of all CPs completion must occur, and/or any fixed outside date for completion. Note whether there is any obligation to complete by a specific date after signing.",
            },
            {
                index: 6,
                name: "Warranties",
                format: "text",
                prompt: "Summarise the warranty package. Who gives the warranties (e.g. seller, management, all sellers jointly and severally)? Are there business warranties and/or title warranties? Identify the scope of any warranty disclosure process and any limitations on warranty claims (e.g. time limits, minimum claim thresholds, aggregate cap).",
            },
            {
                index: 7,
                name: "Indemnities",
                format: "text",
                prompt: "Are there specific indemnities in this agreement? If so, list the key indemnities given, by whom, and for what potential liabilities (e.g. tax indemnity, environmental indemnity, litigation indemnity). Note any time limits or caps applicable to indemnity claims.",
            },
            {
                index: 8,
                name: "Limitation of Liability",
                format: "text",
                prompt: "What limitations on liability apply to warranty and indemnity claims? Identify the aggregate cap (and how it is calculated, e.g. as a percentage of consideration), any separate cap for fundamental warranties or indemnities, minimum claim thresholds (de minimis and basket/deductible), and time limits for bringing claims.",
            },
            {
                index: 9,
                name: "Covenants",
                format: "text",
                prompt: "What restrictive or other covenants are given by the seller or management? Include non-compete, non-solicitation, and non-dealing covenants, stating the scope (activities and geography) and duration of each.",
            },
            {
                index: 10,
                name: "Exclusivity",
                format: "text",
                prompt: "Is there an exclusivity or no-shop provision in this agreement? If so, state the period of exclusivity, what activities are restricted (e.g. soliciting competing offers, engaging with third parties), and any carve-outs or break fee arrangements.",
            },
            {
                index: 11,
                name: "Governing Law and Jurisdiction",
                format: "text",
                prompt: "What governing law applies to this agreement and what courts or arbitral tribunals have jurisdiction? State the chosen law, the forum for disputes, and whether jurisdiction is exclusive or non-exclusive.",
            },
            {
                index: 12,
                name: "Dispute Resolution",
                format: "text",
                prompt: "How are disputes to be resolved under this agreement? Identify whether disputes go to litigation or arbitration, the chosen seat or forum, the applicable rules (if arbitration), and any mandatory pre-dispute escalation steps.",
            },
        ],
    },

    // ─── NDA ─────────────────────────────────────────────────────────────────────
    {
        id: "builtin-nda",
        user_id: null,
        is_system: true,
        created_at: "",
        title: "NDA Review",
        type: "tabular",
        practice: "Contratos e Transações",
        prompt_md: null,
        columns_config: [
            {
                index: 0,
                name: "Direction",
                format: "tag",
                tags: ["Mutual", "Unilateral"],
                prompt: "Is this NDA mutual (both parties owe confidentiality obligations to each other) or unilateral (only one party owes confidentiality obligations)? Identify the direction and name the disclosing and receiving party or parties.",
            },
            {
                index: 1,
                name: "Definition of Confidential Information",
                format: "text",
                prompt: "How is 'Confidential Information' defined in this agreement? Is it broadly or narrowly drafted? Does it require information to be marked as confidential, or is all information shared in connection with the purpose automatically covered? Note any express inclusions or exclusions.",
            },
            {
                index: 2,
                name: "Obligations of Receiving Party",
                format: "bulleted_list",
                prompt: "What are the key obligations of the receiving party in respect of the confidential information? List each obligation (e.g. keep confidential, not disclose to third parties, use only for the permitted purpose, apply a specific standard of care, restrict access to need-to-know personnel).",
            },
            {
                index: 3,
                name: "Standard Carveouts Present?",
                format: "yes_no",
                prompt: "Does the agreement include the standard carveouts to confidentiality obligations? Answer Yes if the agreement excludes information that: (a) is or becomes publicly available without breach; (b) was already known to the receiving party; (c) is independently developed; and (d) is received from a third party without restriction. Note any carveouts that are missing or are drafted differently from the standard formulation.",
            },
            {
                index: 4,
                name: "Permitted Disclosures",
                format: "bulleted_list",
                prompt: "To whom may the receiving party disclose confidential information? List each category of permitted recipient (e.g. employees, professional advisers, affiliates, financing parties, regulatory authorities). Note whether onward disclosure requires the recipient to be bound by equivalent obligations.",
            },
            {
                index: 5,
                name: "Term and Duration",
                format: "text",
                prompt: "What is the term of this NDA and how long do the confidentiality obligations last? State the initial term of the agreement and the duration of the confidentiality obligations (noting whether they survive termination and for how long).",
            },
            {
                index: 6,
                name: "Return and Destruction",
                format: "text",
                prompt: "What obligations apply on expiry or termination regarding return or destruction of confidential information? Is there a choice between return and destruction? Must destruction be certified? Are there any retention exceptions (e.g. for regulatory purposes, IT backup systems)?",
            },
            {
                index: 7,
                name: "Remedies",
                format: "text",
                prompt: "What remedies are available for breach of the confidentiality obligations? Does the agreement acknowledge that damages may be inadequate and that injunctive relief or specific performance is available? Are there any agreed liquidated damages or indemnities for breach?",
            },
            {
                index: 8,
                name: "Governing Law and Jurisdiction",
                format: "text",
                prompt: "What governing law applies to this agreement and which courts have jurisdiction? State the chosen law, the forum, and whether jurisdiction is exclusive or non-exclusive.",
            },
        ],
    },

    // ─── Commercial Lease ─────────────────────────────────────────────────────────
    {
        id: "builtin-commercial-lease",
        user_id: null,
        is_system: true,
        created_at: "",
        title: "Commercial Lease Review",
        type: "tabular",
        practice: "Direito Imobiliário",
        prompt_md: null,
        columns_config: [
            {
                index: 0,
                name: "Landlord",
                format: "text",
                prompt: "Who is the landlord under this lease? State the full legal name, jurisdiction of incorporation or registration (if applicable), and any registered address or title number stated.",
            },
            {
                index: 1,
                name: "Tenant",
                format: "text",
                prompt: "Who is the tenant under this lease? State the full legal name, jurisdiction of incorporation or registration (if applicable), and any registered address stated.",
            },
            {
                index: 2,
                name: "Guarantor",
                format: "text",
                prompt: "Is there a guarantor under this lease? If so, state the guarantor's full legal name and the scope of the guarantee (e.g. full guarantee of the tenant's obligations, or limited to specific obligations). If there is no guarantor, state this explicitly.",
            },
            {
                index: 3,
                name: "Premises",
                format: "text",
                prompt: "Describe the premises demised under this lease. Include the address, floor(s), unit reference, net internal area (if stated), and any areas included or excluded from the demise (e.g. common parts, roof, structure, car parking).",
            },
            {
                index: 4,
                name: "Date of Lease",
                format: "date",
                prompt: "What is the date of this lease? If the lease is undated or if the term commencement date differs from the execution date, note both.",
            },
            {
                index: 5,
                name: "Term",
                format: "text",
                prompt: "What is the contractual term of this lease? State the length of the term and the term commencement and expiry dates.",
            },
            {
                index: 6,
                name: "Rent",
                format: "monetary_amount",
                prompt: "What is the initial annual rent payable under this lease? State the amount, the currency, the payment frequency (e.g. quarterly in advance), and the payment dates. Note any rent-free period or initial concessionary rent.",
            },
            {
                index: 7,
                name: "Rent Review",
                format: "text",
                prompt: "Are there rent review provisions? If so, state the review dates or frequency, the review mechanism (e.g. open market rent review, RPI/CPI indexation, fixed uplift), whether the review is upward-only, any assumptions and disregards applicable to an open market review, and the dispute resolution mechanism if the parties cannot agree the reviewed rent.",
            },
            {
                index: 8,
                name: "Service Charge",
                format: "text",
                prompt: "Is the tenant liable for a service charge? If so, describe what costs are included within the service charge, the tenant's apportionment or percentage share, any cap on the service charge, and how the service charge is administered and reconciled.",
            },
            {
                index: 9,
                name: "Insurance",
                format: "text",
                prompt: "What are the insurance obligations under this lease? State who insures (landlord or tenant), what risks must be insured, who bears the insurance premium cost, and the tenant's obligations in respect of the landlord's insurance (e.g. not to vitiate the policy, to pay the premium as additional rent).",
            },
            {
                index: 10,
                name: "Permitted Use",
                format: "text",
                prompt: "What is the permitted use of the premises under this lease? State the use class or specific use permitted and identify any restrictions on use. Note whether the landlord's consent is required to change use and on what basis consent may be withheld.",
            },
            {
                index: 11,
                name: "Repair & Maintenance",
                format: "text",
                prompt: "Who is responsible for repair and maintenance of the premises? Describe the extent of the tenant's repairing obligation (e.g. full repairing, internal repairing only, subject to a schedule of condition). State the landlord's repairing obligations, if any, in respect of the structure, exterior, or common parts.",
            },
            {
                index: 12,
                name: "Alterations",
                format: "text",
                prompt: "What alterations may the tenant make to the premises? Distinguish between structural and non-structural alterations. Is landlord consent required, and if so on what basis may it be withheld? Must the tenant reinstate alterations at the end of the term?",
            },
            {
                index: 13,
                name: "Assignment & Subletting",
                format: "text",
                prompt: "What rights does the tenant have to assign or sublet the premises? State whether assignment and subletting are permitted with landlord consent, on what grounds consent may be withheld, any conditions to be satisfied (e.g. an authorised guarantee agreement on assignment, rent at no less than the passing rent on subletting), and whether any dealings are prohibited outright.",
            },
            {
                index: 14,
                name: "Break Rights",
                format: "text",
                prompt: "Are there any break rights in this lease? If so, identify who holds the break right (landlord, tenant, or both), the break date(s), the notice period and form required to exercise the break, and any pre-conditions to effective exercise (e.g. no material breach, vacant possession, payment of all sums due).",
            },
            {
                index: 15,
                name: "Security of Tenure",
                format: "yes_no",
                prompt: "Does the tenant have statutory security of tenure (e.g. under the Landlord and Tenant Act 1954 in England and Wales, or equivalent legislation in another jurisdiction)? Answer Yes if the lease is contracted in or benefits from security of tenure. Answer No if the lease has been contracted out or if security of tenure does not apply. State the basis for your answer.",
            },
            {
                index: 16,
                name: "Dilapidations",
                format: "text",
                prompt: "What dilapidations obligations apply at the end of the term? Describe the tenant's yield-up obligations (e.g. to deliver the premises in repair, to reinstate alterations, to redecorate). Is there a schedule of condition limiting the tenant's liability? Note any dilapidations cap or other limitation on the landlord's claim.",
            },
            {
                index: 17,
                name: "Rent Deposit",
                format: "monetary_amount",
                prompt: "Is a rent deposit required? If so, state the amount, the period for which it is held, the conditions under which the landlord may draw on it, and the circumstances in which it is returned to the tenant.",
            },
            {
                index: 18,
                name: "Forfeiture & Termination",
                format: "text",
                prompt: "What are the landlord's forfeiture or termination rights? Identify the events that entitle the landlord to forfeit the lease (e.g. non-payment of rent after a grace period, material breach of covenant, insolvency) and any notice requirements before forfeiture can be exercised.",
            },
            {
                index: 19,
                name: "Governing Law",
                format: "text",
                prompt: "What governing law applies to this lease and which courts have jurisdiction over disputes?",
            },
        ],
    },

    // ─── Limited Partnership Agreement ───────────────────────────────────────────
    {
        id: "builtin-lpa",
        user_id: null,
        is_system: true,
        created_at: "",
        title: "Limited Partnership Agreement Review",
        type: "tabular",
        practice: "Private Equity",
        prompt_md: null,
        columns_config: [
            {
                index: 0,
                name: "General Partner",
                format: "text",
                prompt: "Identify the General Partner(s) of the fund. State the full legal name, jurisdiction of establishment, and any affiliated management entity (e.g. the fund manager or investment adviser) named in the agreement.",
            },
            {
                index: 1,
                name: "Fund Name & Jurisdiction",
                format: "text",
                prompt: "What is the full name of the fund and in which jurisdiction is the limited partnership established or registered?",
            },
            {
                index: 2,
                name: "Total Committed Capital",
                format: "monetary_amount",
                prompt: "What is the total committed capital of the fund? State the target size, any hard cap, the currency, and the closing date or dates if specified.",
            },
            {
                index: 3,
                name: "Capital Calls & Drawdowns",
                format: "text",
                prompt: "How and when may the GP call capital from LPs? State the notice period for capital calls, the mechanics for issuing a call notice, any limit on the frequency or size of calls, and whether undrawn commitments can be recalled after repayment.",
            },
            {
                index: 4,
                name: "Penalties for Failure to Fund",
                format: "text",
                prompt: "What are the consequences if an LP fails to fund a capital call? Describe any penalties (e.g. interest on the shortfall, dilution of interest, forced transfer at a discount, loss of voting or distribution rights, exclusion from future investments). Are there any cure periods before penalties apply?",
            },
            {
                index: 5,
                name: "Investment Scope & Restrictions",
                format: "text",
                prompt: "What is the fund's stated investment strategy, scope, and any restrictions? Include permitted sectors, geographies, investment stages, instrument types, and any concentration limits (e.g. maximum % of committed capital per single investment). Note how much discretion the GP has to deviate from the stated strategy.",
            },
            {
                index: 6,
                name: "Fund Term",
                format: "text",
                prompt: "What is the term of the fund? State the initial term (e.g. 10 years from final closing), any permitted extension periods (e.g. 2 × 1-year extensions), who has the right to approve extensions (GP alone or with LP/LPAC consent), and any early termination mechanics.",
            },
            {
                index: 7,
                name: "Management Fee",
                format: "text",
                prompt: "What management fee is payable to the GP or manager? State the fee rate, the basis on which it is calculated (e.g. committed capital during the investment period, then invested or net asset value thereafter), any step-downs over the fund life, and the payment frequency.",
            },
            {
                index: 8,
                name: "Carried Interest",
                format: "text",
                prompt: "What carried interest (carry) is payable to the GP? State the carry percentage, the structure (European/fund-level waterfall vs American/deal-by-deal), and identify each step of the distribution waterfall in sequence (e.g. return of capital, preferred return, GP catch-up, then profit split).",
            },
            {
                index: 9,
                name: "Preferred Return (Hurdle Rate)",
                format: "percentage",
                prompt: "Is there a preferred return or hurdle rate that LPs must receive before the GP earns carry? State the rate, whether it is compounded (and on what basis), and how it is calculated (e.g. on invested capital, on contributed capital). If there is no preferred return, state this explicitly.",
            },
            {
                index: 10,
                name: "GP Catch-Up",
                format: "text",
                prompt: "Is there a GP catch-up mechanism after the preferred return is met? If so, describe how it operates: what percentage of distributions go to the GP during the catch-up, and what economic result the catch-up is designed to achieve (e.g. the GP receives 20% of all profits to date).",
            },
            {
                index: 11,
                name: "Clawback",
                format: "text",
                prompt: "Is there a clawback obligation on the GP if it receives excess carry? State whether the clawback is calculated at fund level or individual partner level, when it is triggered, any cap or limit on the clawback obligation, and whether there is any escrow or security arrangement to support the GP's clawback obligation.",
            },
            {
                index: 12,
                name: "Fees & Expenses (Beyond Management Fee)",
                format: "bulleted_list",
                prompt: "What fees and expenses are charged to the fund or LPs beyond the management fee? List each category (e.g. transaction fees, monitoring fees, broken deal costs, formation expenses, legal fees, fund administration costs, organisational expenses). For each, state who bears the cost and whether any amounts are offset against the management fee.",
            },
            {
                index: 13,
                name: "Distributions",
                format: "text",
                prompt: "How and when are distributions made to LPs? Describe the timing of distributions (e.g. upon realisation of investments or at the GP's discretion), whether the GP can reinvest proceeds within the investment period, and whether distributions may be made in-kind (i.e. as securities rather than cash).",
            },
            {
                index: 14,
                name: "Key Person Clause",
                format: "text",
                prompt: "Is there a key person clause? Identify the designated key persons. What triggers the key person event (e.g. departure, incapacity, reduced time commitment below a threshold)? What are the consequences (e.g. suspension of the investment period)? Do LPs have any right to terminate or vote on continuation following a key person event?",
            },
            {
                index: 15,
                name: "Removal of the GP",
                format: "text",
                prompt: "Under what circumstances can the GP be removed? Distinguish between removal for cause (e.g. fraud, gross negligence, wilful misconduct — state the LP voting threshold required) and removal without cause (state the LP voting threshold and any associated consequences such as carried interest treatment on removal).",
            },
            {
                index: 16,
                name: "Advisory Committee (LPAC)",
                format: "text",
                prompt: "Is there an LP Advisory Committee (LPAC) or similar governance body? If so, describe its composition, how members are selected, its key powers and responsibilities (e.g. approving conflicts of interest, valuations, extensions, related-party transactions), and whether its approval is binding or merely advisory.",
            },
            {
                index: 17,
                name: "Transfer Restrictions",
                format: "text",
                prompt: "What restrictions apply to an LP transferring or assigning its interest in the fund? Is GP consent required? Are there any permitted transfer exceptions (e.g. to affiliates)? Are secondary market sales permitted and, if so, subject to what conditions or rights of first refusal?",
            },
            {
                index: 18,
                name: "Conflicts of Interest",
                format: "text",
                prompt: "How does the agreement address conflicts of interest? Describe the deal allocation policy across funds, any co-investment rights granted to LPs, restrictions on related-party transactions, and the role of the LPAC in reviewing or approving conflicts. Note any specific conflict scenarios expressly contemplated.",
            },
            {
                index: 19,
                name: "Governing Law",
                format: "text",
                prompt: "What governing law applies to this agreement and which courts or arbitral tribunals have jurisdiction over disputes?",
            },
        ],
    },

    // ─── Shareholder Agreement (Assistant) ───────────────────────────────────────
    {
        id: "builtin-sha-summary",
        user_id: null,
        is_system: true,
        created_at: "",
        title: "Shareholder Agreement Summary",
        type: "assistant",
        practice: "Direito Societário",
        prompt_md:
            "## Shareholder Agreement Summary\n\n" +
            "Review the uploaded shareholder agreement and produce a comprehensive legal summary covering the following topics. " +
            "For each section, identify the key provisions, quote the relevant clause references, and flag any unusual, onerous, or market-standard deviations.\n\n" +
            "1. **Parties & Shareholdings** — Full legal names, roles, share classes held, and percentage interests (on a fully diluted basis if stated)\n" +
            "2. **Share Classes & Rights** — For each class: voting rights, dividend rights, liquidation preference, conversion or redemption features\n" +
            "3. **Board Composition & Governance** — Board size, director appointment rights (and the shareholding thresholds required to maintain them), quorum, and casting vote\n" +
            "4. **Reserved Matters** — Decisions requiring a special majority, unanimity, or a specific shareholder's consent; note the threshold and whose consent is required for each\n" +
            "5. **Pre-emption on New Shares** — Who holds pre-emption rights, procedure, timeline, and any carve-outs (e.g. employee option schemes)\n" +
            "6. **Transfer Restrictions** — Lock-up periods, prohibited transfers, permitted transfers (e.g. to affiliates), and any board or shareholder approval requirements\n" +
            "7. **Right of First Refusal / Pre-emption on Transfer** — Trigger, procedure, pricing mechanics, and any exceptions\n" +
            "8. **Drag-Along Rights** — Who holds the right, threshold to trigger, conditions (e.g. minimum price, independent valuation), and minority protections\n" +
            "9. **Tag-Along Rights** — Who holds the right, triggering threshold, exercise procedure, and price terms\n" +
            "10. **Anti-Dilution Protections** — Type (full ratchet, weighted average), trigger events, calculation mechanics, and exceptions\n" +
            "11. **Dividend Policy** — Any obligation or target to pay dividends, preferential dividend rights, and restrictions on distributions\n" +
            "12. **Exit & Liquidity** — Agreed exit routes (trade sale, IPO, drag sale), timelines, and liquidation preferences on exit\n" +
            "13. **Deadlock** — Deadlock definition, escalation and resolution mechanisms (e.g. Russian roulette, put/call options), and consequences if unresolved\n" +
            "14. **Non-Compete & Non-Solicitation** — Who is bound, scope of activities and geography, duration, and carve-outs\n" +
            "15. **Governing Law & Dispute Resolution** — Applicable law, forum, arbitration or litigation, and any mandatory escalation steps\n\n" +
            "Generate the summary as a downloadable Word document.",
        columns_config: null,
    },

    // ─── Shareholder Agreement ────────────────────────────────────────────────────
    {
        id: "builtin-shareholder-agreement",
        user_id: null,
        is_system: true,
        created_at: "",
        title: "Shareholder Agreement Review",
        type: "tabular",
        practice: "Direito Societário",
        prompt_md: null,
        columns_config: [
            {
                index: 0,
                name: "Parties",
                format: "bulleted_list",
                prompt: "Identify all parties to this shareholder agreement. For each, state their full legal name, jurisdiction of incorporation or establishment (if stated), and their role (e.g. company, majority shareholder, minority shareholder, investor, founder, management shareholder).",
            },
            {
                index: 1,
                name: "Date",
                format: "date",
                prompt: "What is the date of this shareholder agreement?",
            },
            {
                index: 2,
                name: "Share Capital & Classes",
                format: "bulleted_list",
                prompt: "What classes of shares are in issue or contemplated by this agreement? For each class, describe the key rights attaching to it including voting rights, dividend rights, liquidation preference (if any), and any conversion or redemption features.",
            },
            {
                index: 3,
                name: "Shareholdings",
                format: "bulleted_list",
                prompt: "What are the shareholdings of each party as set out or contemplated in this agreement? For each shareholder, state the number of shares held, the class, and the percentage of total share capital (on a fully diluted basis if stated).",
            },
            {
                index: 4,
                name: "Board Composition",
                format: "text",
                prompt: "How is the board of directors constituted under this agreement? State the total number of directors, each shareholder's or class of shareholders' right to appoint or nominate directors (and the threshold shareholding required to maintain that right), and any provisions for a chairman or casting vote.",
            },
            {
                index: 5,
                name: "Reserved Matters",
                format: "bulleted_list",
                prompt: "What are the reserved matters or veto rights set out in this agreement? List each matter that requires shareholder or director approval beyond an ordinary majority (e.g. special majority, unanimity, or the consent of a specific shareholder). Identify the applicable threshold or whose consent is required for each.",
            },
            {
                index: 6,
                name: "Pre-emption on New Shares",
                format: "text",
                prompt: "What pre-emption rights apply on the issuance of new shares? Describe who holds pre-emption rights, the procedure for offering new shares to existing shareholders, the timeline for acceptance, and any carve-outs or exceptions (e.g. shares issued under an employee option scheme, permitted issuances).",
            },
            {
                index: 7,
                name: "Transfer Restrictions",
                format: "text",
                prompt: "What restrictions apply to the transfer of shares? Identify any lock-up periods (and their duration), which transfers are prohibited outright, and which transfers are permitted without consent (e.g. transfers to affiliates or family trusts). Note any board or shareholder approval requirements for transfers.",
            },
            {
                index: 8,
                name: "Right of First Refusal / Pre-emption on Transfer",
                format: "text",
                prompt: "Is there a right of first refusal or pre-emption right on a proposed transfer of shares? If so, describe who holds the right, the procedure for triggering and exercising it (including notice periods and pricing mechanics), and any exceptions.",
            },
            {
                index: 9,
                name: "Drag-Along Rights",
                format: "text",
                prompt: "Are there drag-along rights? If so, identify who holds the drag right (e.g. majority shareholders above a specified threshold), the threshold required to trigger a drag, the obligations imposed on dragged shareholders, any conditions on the drag (e.g. minimum price, independent valuation), and any protections for minority shareholders.",
            },
            {
                index: 10,
                name: "Tag-Along Rights",
                format: "text",
                prompt: "Are there tag-along rights? If so, identify who holds the tag right, the threshold transfer that triggers the tag, the procedure for exercising the tag (including notice periods), the price and terms on which the tagging shareholder may sell, and any exceptions.",
            },
            {
                index: 11,
                name: "Anti-Dilution Protections",
                format: "text",
                prompt: "Are there any anti-dilution protections for any class of shareholders? If so, describe the type of protection (e.g. full ratchet, weighted average, broad-based or narrow-based), the trigger events, how the adjusted price or entitlement is calculated, and any exceptions (e.g. permitted issuances excluded from the calculation).",
            },
            {
                index: 12,
                name: "Dividend Policy",
                format: "text",
                prompt: "What dividend provisions are set out in this agreement? Describe any obligation or policy to pay dividends (e.g. a minimum percentage of distributable profits), any preferential dividend rights attaching to a particular class of shares, and any restrictions on dividend payments (e.g. subject to available profits, board or shareholder approval, lender consent).",
            },
            {
                index: 13,
                name: "Exit & Liquidity Provisions",
                format: "text",
                prompt: "What exit or liquidity provisions are included? Describe any agreed exit mechanisms (e.g. trade sale, IPO, drag-along sale), any timelines or milestones by which an exit is targeted, any shareholder rights to initiate or compel an exit process after a specified period, and any preference on exit proceeds attaching to a particular class of shares.",
            },
            {
                index: 14,
                name: "Deadlock",
                format: "text",
                prompt: "How is deadlock addressed? Describe any deadlock resolution mechanisms (e.g. escalation to senior management, mediation, Russian roulette / shoot-out provisions, put/call options). For each mechanism, state the trigger conditions, the procedure, and the consequences if deadlock is not resolved.",
            },
            {
                index: 15,
                name: "Non-Compete & Non-Solicitation",
                format: "text",
                prompt: "Are any shareholders subject to non-compete or non-solicitation obligations? If so, identify which shareholders are bound, the scope of the restriction (activities and geography), and the duration (during the term of the agreement and/or for a period after a shareholder ceases to hold shares). Note any carve-outs.",
            },
            {
                index: 16,
                name: "Confidentiality",
                format: "text",
                prompt: "What confidentiality obligations are imposed on the shareholders? State the scope of confidential information covered, the permitted disclosures (e.g. to professional advisers, affiliates, lenders), and the duration of the obligation. Note whether the obligation survives termination of the agreement.",
            },
            {
                index: 17,
                name: "Warranties",
                format: "text",
                prompt: "What warranties are given by the shareholders under this agreement? Identify who gives warranties, the subject matter (e.g. title to shares, capacity, no encumbrances, no conflicts), any limitations on warranty claims (e.g. time limits, caps, knowledge qualifications), and any indemnities given alongside the warranties.",
            },
            {
                index: 18,
                name: "Governing Law",
                format: "text",
                prompt: "What governing law applies to this agreement? State the jurisdiction and any specific legal system referenced.",
            },
            {
                index: 19,
                name: "Dispute Resolution",
                format: "text",
                prompt: "How are disputes resolved under this agreement? Identify whether disputes go to litigation or arbitration, the chosen forum or seat, any mandatory escalation steps, and whether jurisdiction is exclusive.",
            },
        ],
    },

    // ─── Employment Agreement ─────────────────────────────────────────────────────
    {
        id: "builtin-employment-agreement",
        user_id: null,
        is_system: true,
        created_at: "",
        title: "Employment Agreement Review",
        type: "tabular",
        practice: "Direito do Trabalho",
        prompt_md: null,
        columns_config: [
            {
                index: 0,
                name: "Employer",
                format: "text",
                prompt: "Who is the employer under this agreement? State the full legal name and jurisdiction of incorporation or establishment.",
            },
            {
                index: 1,
                name: "Employee",
                format: "text",
                prompt: "Who is the employee under this agreement? State their full name and, if provided, their address or location.",
            },
            {
                index: 2,
                name: "Date",
                format: "date",
                prompt: "What is the date of this employment agreement? If a commencement date or start date differs from the signing date, state both.",
            },
            {
                index: 3,
                name: "Title",
                format: "text",
                prompt: "What is the employee's job title or position as stated in this agreement? If a reporting line is specified, include it.",
            },
            {
                index: 4,
                name: "Compensation",
                format: "text",
                prompt: "What is the employee's compensation under this agreement? State the base salary or wage, the currency, and the payment frequency (e.g. monthly, bi-weekly). Include any guaranteed bonus, commission, or other fixed remuneration elements.",
            },
            {
                index: 5,
                name: "Full Time / Part Time",
                format: "tag",
                tags: ["Full Time", "Part Time"],
                prompt: "Is this a full-time or part-time position? If part-time, state the number of days or hours per week where specified.",
            },
            {
                index: 6,
                name: "Independent Contractor?",
                format: "yes_no",
                prompt: "Does the agreement characterise the worker as an independent contractor rather than an employee? Answer Yes if the agreement uses contractor, consultant, or self-employed language. Note any provisions that address the nature of the relationship.",
            },
            {
                index: 7,
                name: "Benefits",
                format: "bulleted_list",
                prompt: "What benefits are the employee entitled to under this agreement? List each benefit (e.g. health insurance, pension/retirement contributions, life assurance, car allowance, share options, expense reimbursement). Note any eligibility conditions or limits.",
            },
            {
                index: 8,
                name: "Notice Period (Employer to Employee)",
                format: "text",
                prompt: "What notice must the employer give to terminate the employee's employment (other than for cause)? State the notice period and any provisions for payment in lieu of notice.",
            },
            {
                index: 9,
                name: "Notice Period (Employee to Employer)",
                format: "text",
                prompt: "What notice must the employee give to resign? State the notice period and any provisions for payment in lieu of notice or garden leave.",
            },
            {
                index: 10,
                name: "Overtime",
                format: "text",
                prompt: "What provisions apply to overtime? Is the employee eligible for overtime pay, and if so at what rate? Or does the agreement state that the salary is inclusive of any overtime? Note any opt-out of statutory working time limits.",
            },
            {
                index: 11,
                name: "Working Hours",
                format: "text",
                prompt: "What working hours are specified in this agreement? State the normal hours of work, any flexibility provisions, and whether the employee is expected to work additional hours as required.",
            },
            {
                index: 12,
                name: "Variation",
                format: "text",
                prompt: "What provisions govern variation of the terms of this agreement? Can the employer unilaterally vary terms, or is the employee's consent required? Note any specific terms that are stated to be variable without consent.",
            },
            {
                index: 13,
                name: "Intellectual Property Assignment",
                format: "text",
                prompt: "What intellectual property assignment provisions are included? Does the employee assign to the employer all IP created in the course of employment? Are there any carve-outs for pre-existing IP or inventions created outside working hours? Note any moral rights waiver.",
            },
            {
                index: 14,
                name: "Grounds for Termination",
                format: "bulleted_list",
                prompt: "What grounds for summary dismissal or termination for cause are set out in the agreement? List each ground (e.g. gross misconduct, breach of confidentiality, insolvency, criminal conviction). Note whether summary dismissal is without notice or payment in lieu.",
            },
            {
                index: 15,
                name: "Annual Leave Entitlement",
                format: "text",
                prompt: "What is the employee's annual leave entitlement? State the number of days (or weeks) per year, whether this is inclusive of or in addition to public holidays, and any provisions for accrual, carry-over, or payment of untaken leave on termination.",
            },
        ],
    },
];

export const BUILT_IN_IDS = new Set(BUILT_IN_WORKFLOWS.map((wf) => wf.id));
