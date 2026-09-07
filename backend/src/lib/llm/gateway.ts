import { UserFacingError } from "../userFacingError";

export function parseGatewayModels(
  value: string,
): { id: string; label: string }[] {
  const seen = new Set<string>();
  return value.split(",").map((entry) => {
    const parts = entry.trim().split("=");
    const id = parts[0]?.trim() ?? "";
    const label = parts.length === 1 ? id : parts[1]?.trim();
    if (
      !id ||
      /[\s,=]/.test(id) ||
      parts.length > 2 ||
      !label ||
      seen.has(id)
    ) {
      throw new Error(
        "GATEWAY_MODELS requires unique non-empty ids and optional display names; commas and equals signs are reserved.",
      );
    }
    seen.add(id);
    return { id, label };
  });
}

/** Read per call, normalize once, and never infer a public endpoint. */
export function gatewayConfig() {
  const baseURL = process.env.GATEWAY_BASE_URL?.trim().replace(/\/+$/, "");
  const catalog = process.env.GATEWAY_MODELS?.trim();
  if (
    !baseURL &&
    !catalog &&
    !process.env.GATEWAY_API_KEY?.trim() &&
    !process.env.GATEWAY_DEFAULT_MODEL?.trim() &&
    !process.env.GATEWAY_LABEL?.trim()
  )
    return null;
  if (!baseURL || !catalog)
    throw new Error("Gateway requires GATEWAY_BASE_URL and GATEWAY_MODELS.");
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error("GATEWAY_BASE_URL must be an HTTP(S) API base URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "GATEWAY_BASE_URL must be an HTTP(S) API base URL without credentials, query or fragment.",
    );
  }
  const models = parseGatewayModels(catalog);
  const defaultId = process.env.GATEWAY_DEFAULT_MODEL?.trim() || models[0]!.id;
  if (!models.some((model) => model.id === defaultId))
    throw new Error(
      "GATEWAY_DEFAULT_MODEL must name a configured raw model id.",
    );
  return {
    baseURL,
    models,
    defaultModel: `gateway/${defaultId}`,
    label: process.env.GATEWAY_LABEL?.trim() || "Gateway",
    apiKey: process.env.GATEWAY_API_KEY?.trim() || undefined,
  };
}

export function gatewayModelId(model: string): string {
  return model.replace(/^gateway\//, "");
}

export function isGatewayModelAvailable(model: string): boolean {
  return (
    model.startsWith("gateway/") &&
    !!gatewayConfig()?.models.some((item) => item.id === gatewayModelId(model))
  );
}

export function requireGatewayModel(model: string) {
  const config = gatewayConfig();
  if (
    !config ||
    !model.startsWith("gateway/") ||
    !config.models.some((item) => item.id === gatewayModelId(model))
  ) {
    throw new UserFacingError(
      `${config?.label ?? "Gateway"} model is not available. Select a configured model.`,
    );
  }
  return config;
}

/** Explicit safe projection: endpoint and credentials never enter API responses. */
export function gatewayCatalog() {
  const config = gatewayConfig();
  return {
    provider: "gateway" as const,
    label: config?.label ?? "Gateway",
    available: !!config,
    defaultModel: config?.defaultModel ?? null,
    models:
      config?.models.map((model) => ({
        id: `gateway/${model.id}`,
        label: model.label,
        group: config.label,
        source: config.label,
        provider: "gateway" as const,
        available: true,
      })) ?? [],
  };
}
