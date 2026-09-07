import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  clearRequestAuthCookies,
  createRequestSupabase,
  publicAuthUser,
} from "../lib/authSession";
import { consumeAuthHandoff, issueAuthHandoff } from "../lib/authHandoff";
import { requestOriginIsWordAddin } from "../lib/origins";
import { requireAuth } from "../middleware/auth";
import { requireTrustedOrigin } from "../middleware/trustedOrigin";
import { ssoConfiguration, ssoDomainSchema } from "../lib/ssoConfig";
import { sendInternalError } from "../lib/httpError";

export const authRouter = Router();

authRouter.use(requireTrustedOrigin);
authRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

const credentialsSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(4096),
});
const handoffRequestIdSchema = z
  .string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const exchangeSchema = z.object({
  code: z.string().trim().min(1).max(4096),
  handoffRequestId: handoffRequestIdSchema.optional(),
});
const handoffSchema = z.object({
  ticket: z
    .string()
    .trim()
    .min(32)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
  requestId: handoffRequestIdSchema,
});
const passwordSchema = z.object({
  password: z.string().min(8).max(4096),
  signOut: z.boolean().optional(),
});
const factorSchema = z.object({ factorId: z.string().uuid() });
const verificationSchema = factorSchema.extend({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
  challengeId: z.string().uuid().optional(),
});

function safeNext(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback;
  if (
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return fallback;
  }
  return value;
}

function requestOrigin(req: Request): string {
  return new URL(req.get("origin") as string).origin;
}

function callbackUrl(
  req: Request,
  next: unknown,
  fallback: string,
  path = "/auth/callback",
): string {
  const url = new URL(path, requestOrigin(req));
  url.searchParams.set("next", safeNext(next, fallback));
  return url.toString();
}

function authError(
  res: Response,
  error: unknown,
  fallback = "Authentication could not be completed.",
) {
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const suppliedStatus =
    typeof candidate?.status === "number" ? candidate.status : null;
  if (
    suppliedStatus === null ||
    suppliedStatus < 400 ||
    suppliedStatus >= 500
  ) {
    console.error(
      "[auth] unexpected server-side authentication failure",
      error,
    );
    res.status(500).json({
      code: null,
      detail: fallback,
    });
    return;
  }
  res.status(suppliedStatus).json({
    code: typeof candidate?.code === "string" ? candidate.code : null,
    detail:
      typeof candidate?.message === "string" && candidate.message
        ? candidate.message
        : fallback,
  });
}

function invalidBody(res: Response) {
  res.status(400).json({
    code: "invalid_request",
    detail: "The authentication request is invalid.",
  });
}

function cookieClient(req: Request, res: Response): SupabaseClient | null {
  const client = res.locals.authClient as SupabaseClient | undefined;
  if (!client || res.locals.authSource !== "cookie") {
    res.status(401).json({
      code: "cookie_session_required",
      detail: "A cookie-authenticated session is required.",
    });
    return null;
  }
  return client;
}

async function currentUser(
  client: SupabaseClient,
): Promise<{ user: User | null; error: unknown }> {
  const { data, error } = await client.auth.getUser();
  return { user: data.user, error };
}

authRouter.post("/login", async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res);

  try {
    const client = createRequestSupabase(req, res);
    const { data, error } = await client.auth.signInWithPassword(parsed.data);
    if (error || !data.user || !data.session) return authError(res, error);
    res.json({ user: publicAuthUser(data.user) });
  } catch (error) {
    authError(res, error);
  }
});

authRouter.post("/signup", async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res);

  try {
    const client = createRequestSupabase(req, res);
    const { data, error } = await client.auth.signUp({
      ...parsed.data,
      options: {
        emailRedirectTo: callbackUrl(
          req,
          req.body?.next,
          "/onboarding/profile",
        ),
      },
    });
    if (error || !data.user) return authError(res, error);
    res.status(201).json({
      user: publicAuthUser(data.user),
      requiresEmailConfirmation: !data.session,
    });
  } catch (error) {
    authError(res, error);
  }
});

// Public presentation settings only; provider administration remains in GoTrue.
authRouter.get("/config", (_req, res) => {
  try {
    const config = ssoConfiguration();
    res.json({
      ssoEnabled: config.enabled,
      ssoButtonLabel: config.buttonLabel,
      ssoDomainRequired: config.enabled && !config.defaultDomain,
    });
  } catch {
    // Do not pass configuration values or provider diagnostics to the logger.
    sendInternalError(res, new Error("Invalid SSO configuration"));
  }
});

const ssoRequestSchema = z.object({
  provider: z.literal("sso"),
  domain: ssoDomainSchema.optional(),
});

async function startSso(req: Request, res: Response) {
  try {
    const config = ssoConfiguration();
    if (!config.enabled) {
      return res
        .status(403)
        .json({
          code: "sso_disabled",
          detail: "Single sign-on is not enabled.",
        });
    }
    const parsed = ssoRequestSchema.safeParse(req.body);
    if (!parsed.success) return invalidBody(res);
    const domain = parsed.data.domain ?? config.defaultDomain;
    if (!domain) {
      return res
        .status(400)
        .json({
          code: "sso_domain_required",
          detail: "Enter your organization's domain.",
        });
    }
    if (config.allowedDomains && !config.allowedDomains.includes(domain)) {
      return res
        .status(400)
        .json({
          code: "sso_domain_not_allowed",
          detail: "Single sign-on is not available for this domain.",
        });
    }
    const client = createRequestSupabase(req, res);
    const { data, error } = await client.auth.signInWithSSO({
      domain,
      options: {
        redirectTo: callbackUrl(req, req.body?.next, "/onboarding/profile"),
        skipBrowserRedirect: true,
      },
    });
    if (error) {
      if (error.status && error.status >= 400 && error.status < 500) {
        return res
          .status(400)
          .json({
            code: "sso_unavailable",
            detail: "Unable to start single sign-on for this domain.",
          });
      }
      throw new Error("SSO provider request failed");
    }
    if (!data?.url) throw new Error("Missing SSO redirect");
    return res.json({ url: data.url });
  } catch {
    return sendInternalError(
      res,
      new Error("SSO sign-in could not be started"),
    );
  }
}

authRouter.post("/oauth", async (req, res) => {
  if (req.body?.provider === "sso") return startSso(req, res);
  if (req.body?.provider !== "google") return invalidBody(res);
  try {
    const client = createRequestSupabase(req, res);
    const { data, error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: callbackUrl(
          req,
          req.body?.next,
          "/onboarding/profile",
          req.body?.callbackPath === "/oauth-dialog.html"
            ? "/oauth-dialog.html"
            : "/auth/callback",
        ),
        skipBrowserRedirect: true,
      },
    });
    if (error || !data.url) return authError(res, error);
    res.json({ url: data.url });
  } catch (error) {
    authError(res, error);
  }
});

authRouter.post("/exchange", async (req, res) => {
  const parsed = exchangeSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res);
  try {
    const client = createRequestSupabase(req, res);
    const { data, error } = await client.auth.exchangeCodeForSession(
      parsed.data.code,
    );
    if (error || !data.user || !data.session) return authError(res, error);
    if (parsed.data.handoffRequestId) {
      if (!requestOriginIsWordAddin(req.get("origin"))) {
        res.status(403).json({
          code: "word_handoff_origin_required",
          detail: "The authentication handoff origin is not allowed.",
        });
        return;
      }
      const handoffTicket = await issueAuthHandoff({
        userId: data.user.id,
        requestId: parsed.data.handoffRequestId,
        origin: requestOrigin(req),
        session: data.session,
      });
      res.json({ handoffTicket });
      return;
    }
    res.json({ user: publicAuthUser(data.user) });
  } catch (error) {
    authError(res, error);
  }
});

authRouter.post("/handoff", async (req, res) => {
  const parsed = handoffSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res);
  if (!requestOriginIsWordAddin(req.get("origin"))) {
    res.status(403).json({
      code: "word_handoff_origin_required",
      detail: "The authentication handoff origin is not allowed.",
    });
    return;
  }

  try {
    const handoff = await consumeAuthHandoff({
      ticket: parsed.data.ticket,
      requestId: parsed.data.requestId,
      origin: requestOrigin(req),
    });
    if (!handoff) {
      res.status(400).json({
        code: "invalid_auth_handoff",
        detail: "This authentication handoff is invalid or has expired.",
      });
      return;
    }

    const client = createRequestSupabase(req, res);
    const { data, error } = await client.auth.setSession({
      access_token: handoff.accessToken,
      refresh_token: handoff.refreshToken,
    });
    if (
      error ||
      !data.user ||
      !data.session ||
      data.user.id !== handoff.userId
    ) {
      clearRequestAuthCookies(req, res);
      return authError(
        res,
        error,
        "Authentication handoff could not be completed.",
      );
    }
    res.json({ user: publicAuthUser(data.user) });
  } catch (error) {
    authError(res, error, "Authentication handoff could not be completed.");
  }
});

authRouter.post("/password-reset", async (req, res) => {
  const email = z.string().trim().email().max(320).safeParse(req.body?.email);
  if (email.success) {
    try {
      const client = createRequestSupabase(req, res);
      await client.auth.resetPasswordForEmail(email.data, {
        redirectTo: callbackUrl(req, "/reset-password", "/reset-password"),
      });
    } catch {
      // Deliberately indistinguishable to prevent account enumeration.
    }
  }
  res.status(204).end();
});

authRouter.get("/session", requireAuth, async (_req, res) => {
  const client = cookieClient(_req, res);
  if (!client) return;
  const { user, error } = await currentUser(client);
  if (error || !user) return authError(res, error);
  res.json({ user: publicAuthUser(user) });
});

authRouter.post("/logout", async (req, res) => {
  try {
    const client = createRequestSupabase(req, res);
    await client.auth.signOut({
      scope: req.body?.scope === "global" ? "global" : "local",
    });
  } catch (error) {
    // Local cookie removal must not depend on the upstream revocation request.
    console.error("[auth/logout] upstream sign-out failed", error);
  } finally {
    clearRequestAuthCookies(req, res);
  }
  res.status(204).end();
});

authRouter.patch("/email", requireAuth, async (req, res) => {
  const email = z.string().trim().email().max(320).safeParse(req.body?.email);
  if (!email.success) return invalidBody(res);
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await client.auth.updateUser(
    { email: email.data },
    {
      emailRedirectTo: callbackUrl(
        req,
        req.body?.next,
        "/settings?emailChange=processed",
      ),
    },
  );
  if (error || !data.user) return authError(res, error);
  res.json({ user: publicAuthUser(data.user) });
});

authRouter.patch("/password", requireAuth, async (req, res) => {
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res);
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await client.auth.updateUser({
    password: parsed.data.password,
  });
  if (error || !data.user) return authError(res, error);
  if (parsed.data.signOut) {
    await client.auth.signOut({ scope: "global" });
    clearRequestAuthCookies(req, res);
  }
  res.json({ user: publicAuthUser(data.user) });
});

authRouter.get("/mfa/factors", requireAuth, async (req, res) => {
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await client.auth.mfa.listFactors();
  if (error) return authError(res, error);
  res.json(data);
});

authRouter.get("/mfa/assurance", requireAuth, async (req, res) => {
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } =
    await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) return authError(res, error);
  res.json(data);
});

authRouter.post("/mfa/enroll", requireAuth, async (req, res) => {
  const friendlyName = z
    .string()
    .trim()
    .min(1)
    .max(100)
    .safeParse(req.body?.friendlyName);
  if (!friendlyName.success) return invalidBody(res);
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await client.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: friendlyName.data,
  });
  if (error) return authError(res, error);
  res.status(201).json(data);
});

authRouter.post("/mfa/challenge", requireAuth, async (req, res) => {
  const parsed = factorSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res);
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await client.auth.mfa.challenge(parsed.data);
  if (error) return authError(res, error);
  res.json(data);
});

authRouter.post("/mfa/verify", requireAuth, async (req, res) => {
  const parsed = verificationSchema.safeParse(req.body);
  if (!parsed.success || !parsed.data.challengeId) return invalidBody(res);
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await client.auth.mfa.verify({
    factorId: parsed.data.factorId,
    challengeId: parsed.data.challengeId,
    code: parsed.data.code,
  });
  if (error) return authError(res, error);
  res.json({ user: publicAuthUser(data.user) });
});

authRouter.post("/mfa/challenge-and-verify", requireAuth, async (req, res) => {
  const parsed = verificationSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res);
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await client.auth.mfa.challengeAndVerify({
    factorId: parsed.data.factorId,
    code: parsed.data.code,
  });
  if (error) return authError(res, error);
  res.json({ user: publicAuthUser(data.user) });
});

authRouter.delete("/mfa/factors/:factorId", requireAuth, async (req, res) => {
  const parsed = factorSchema.safeParse({ factorId: req.params.factorId });
  if (!parsed.success) return invalidBody(res);
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await client.auth.mfa.unenroll(parsed.data);
  if (error) return authError(res, error);
  res.json(data);
});
