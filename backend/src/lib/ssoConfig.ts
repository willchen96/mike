import { z } from "zod";

// Accept DNS domains only, never email addresses, URLs, wildcards or ports.
export const ssoDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );

export function ssoConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.SSO_ENABLED?.trim().toLowerCase() === "true";
  if (!enabled) {
    return {
      enabled: false,
      buttonLabel: "Single sign-on",
      defaultDomain: null,
      allowedDomains: null,
    };
  }
  const defaultDomain = env.SSO_DEFAULT_DOMAIN?.trim()
    ? ssoDomainSchema.parse(env.SSO_DEFAULT_DOMAIN)
    : null;
  const allowedDomains = env.SSO_ALLOWED_DOMAINS?.trim()
    ? env.SSO_ALLOWED_DOMAINS.split(",").map((domain) =>
        ssoDomainSchema.parse(domain),
      )
    : null;
  if (
    defaultDomain &&
    allowedDomains &&
    !allowedDomains.includes(defaultDomain)
  ) {
    throw new Error("SSO default domain must be allowed");
  }
  return {
    enabled,
    buttonLabel: env.SSO_BUTTON_LABEL?.trim() || "Single sign-on",
    defaultDomain,
    allowedDomains,
  };
}
