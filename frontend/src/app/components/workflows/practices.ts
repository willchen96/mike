// ─── Áreas de Prática ────────────────────────────────────────────────────────
//
// Este arquivo é o ponto central de configuração das áreas de prática
// disponíveis na plataforma. Para personalizar a lista de áreas de prática
// de uma instância específica:
//
//   1. Edite o array PRACTICE_OPTIONS abaixo.
//   2. Para adicionar uma nova área, inclua uma nova string no array.
//   3. Para remover uma área, delete a linha correspondente.
//   4. Para renomear uma área, altere o valor da string.
//      ATENÇÃO: se houver workflows existentes com o valor antigo, eles
//      deixarão de corresponder à nova lista. Atualize também os
//      builtinWorkflows.ts e os registros de banco de dados, se necessário.
//
// As opções aqui definidas aparecem automaticamente no dropdown
// "Área de Prática" do modal de criação/edição de workflows.
// ─────────────────────────────────────────────────────────────────────────────

export const PRACTICE_OPTIONS = [
    "Contratos e Transações",
    "Direito Societário",
    "Direito Financeiro",
    "Contencioso",
    "Direito Imobiliário",
    "Direito Tributário",
    "Direito do Trabalho",
    "Propriedade Intelectual",
    "Direito Concorrencial",
    "Direito Digital e Tecnologia",
    "Project Finance",
    "Venture Capital",
    "Private Equity",
    "Crédito Privado",
    "Mercado de Ações (ECM)",
    "Mercado de Dívida (DCM)",
    "Finanças Alavancadas",
    "Arbitragem",
    "Outros",
] as const;

export type Practice = (typeof PRACTICE_OPTIONS)[number];
