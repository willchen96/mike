/**
 * Configuração de marca da aplicação.
 *
 * Para personalizar por instância, defina as variáveis no .env.local:
 *
 *   NEXT_PUBLIC_APP_NAME=Minha Empresa
 *   NEXT_PUBLIC_LOGO_URL=/logo.png          ← arquivo em /public, ou URL absoluta
 *
 * Se NEXT_PUBLIC_LOGO_URL não for definida, o ícone padrão (SVG animado) é usado.
 */

export const BRAND = {
    /** Nome da aplicação exibido na sidebar e nas telas iniciais. */
    name: process.env.NEXT_PUBLIC_APP_NAME ?? "Sistema",

    /**
     * URL do logotipo personalizado.
     * Aceita caminhos relativos ao /public (ex: "/logo.png") ou URLs absolutas.
     * Quando null, o componente AppLogo renderiza o ícone SVG padrão.
     */
    logoUrl: process.env.NEXT_PUBLIC_LOGO_URL ?? null,
};
