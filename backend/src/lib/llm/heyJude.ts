export function heyJudeEnabled(): boolean {
    return process.env.HEY_JUDE_ENABLED === "true";
}

export function heyJudeBaseUrl(): string {
    return (process.env.HEY_JUDE_BASE_URL || "http://localhost:4005").replace(
        /\/$/,
        "",
    );
}

export function heyJudeApiKey(): string {
    return process.env.HEY_JUDE_API_KEY || "sk-heyjude-dev";
}
