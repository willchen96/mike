import type { ColumnFormat } from "../shared/types";

export interface ColumnPreset {
    name: string;
    matches: RegExp;
    prompt: string;
    format: ColumnFormat;
    tags?: string[];
}

export const PROMPT_PRESETS: ColumnPreset[] = [
    {
        name: "Partes",
        matches: /\bpart(y|ies|es)\b/i,
        format: "bulleted_list",
        prompt: 'List all parties to this agreement. For each party, state their full legal name, entity type, and defined role, e.g.:\n• ABC Corp, a Delaware corporation ("Company")\n• John Smith ("Shareholder")\nOne party per bullet. No additional commentary.',
    },
    {
        name: "Lei Aplicável",
        matches: /\bgoverning law\b|\bjurisdiction\b|\blei aplic[aá]vel\b/i,
        format: "text",
        prompt: 'State only the governing law of this agreement using the short-form jurisdiction name, e.g. "New York Law", "English Law", "Indian Law", "PRC Law". No other text.',
    },
    {
        name: "Data de Vigência",
        matches: /\beffective date\b|\bdata de vig[eê]ncia\b/i,
        format: "date",
        prompt: 'State only the effective date of this agreement in DD Mon YYYY format, e.g. "2 Jan 2026". If not explicitly stated, write "Not specified".',
    },
    {
        name: "Prazo",
        matches: /\bterm\b|\bduration\b|\bprazo\b/i,
        format: "text",
        prompt: 'State only the duration or term of this agreement in a concise form, e.g. "3 years", "24 months", "perpetual". No other text.',
    },
    {
        name: "Extinção ou Resilição",
        matches: /\bterminat(e|ion|ing)\b|\bextin[cç][aã]o\b|\bresilição\b/i,
        format: "text",
        prompt: "Extract the termination provisions. State who may terminate, the trigger events, required notice period, any cure period, and the key consequences of termination. Be concise.",
    },
    {
        name: "Alteração de Controle Societário",
        matches: /\bchange of control\b|\baltera[cç][aã]o de controle\b/i,
        format: "text",
        prompt: "Identify any change of control provisions. Summarize the trigger events, consequences, consent requirements, and any related termination or acceleration rights. Be concise.",
    },
    {
        name: "Confidencialidade",
        matches: /\bconfidential(ity)?\b|\bnon-?disclosure\b|\bconfidencialidade\b/i,
        format: "text",
        prompt: "Summarize the confidentiality obligations: scope of confidential information, permitted disclosures, use restrictions, duration, and key carve-outs or exceptions.",
    },
    {
        name: "Cessão",
        matches: /\bassign(ment|ability)?\b|\bcess[aã]o\b/i,
        format: "yes_no",
        prompt: "Is assignment of this agreement permitted without the other party's consent?",
    },
    {
        name: "Pagamento e Honorários",
        matches: /\bpayment\b|\bfees?\b|\bpagamento\b|\bhonorários\b/i,
        format: "text",
        prompt: 'State the key payment obligations concisely: amount, timing, and currency, e.g. "USD 10,000 payable within 30 days of invoice". Note any late payment consequences.',
    },
    {
        name: "Aditamento",
        matches: /\bamendment\b|\bvariation\b|\baditamento\b/i,
        format: "text",
        prompt: "Summarize the amendment provisions: how amendments may be made, who must consent, and any formality requirements such as writing or signature.",
    },
    {
        name: "Indenização e Isenção de Responsabilidade",
        matches: /\bindemni(ty|ties|fication)\b|\bindeniza[cç][aã]o\b/i,
        format: "text",
        prompt: "Summarize the indemnity provisions: who indemnifies whom, the scope of indemnified losses, any liability caps or exclusions, and key claims procedures.",
    },
    {
        name: "Garantias e Declarações",
        matches: /\bwarrant(y|ies|ing)\b|\brepresentations?\b|\bgarantias\b/i,
        format: "text",
        prompt: "Identify and describe key representations and warranties provided by any party, including the scope of such assurances and any specific time periods or conditions applicable to them. In particular highlight any non-standard warranties.",
    },
    {
        name: "Força Maior",
        matches: /\bforce majeure\b|\bfor[cç]a maior\b/i,
        format: "yes_no",
        prompt: "Does this agreement contain a force majeure clause?",
    },
];

export function getPresetConfig(
    title: string,
): Pick<ColumnPreset, "prompt" | "format" | "tags"> | null {
    const trimmed = title.trim();
    if (!trimmed) return null;
    const preset = PROMPT_PRESETS.find(({ matches }) => matches.test(trimmed));
    if (!preset) return null;
    return { prompt: preset.prompt, format: preset.format, tags: preset.tags };
}

export function getPresetPrompt(title: string): string | null {
    return getPresetConfig(title)?.prompt ?? null;
}
