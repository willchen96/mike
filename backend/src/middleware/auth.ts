import { Request, Response, NextFunction } from "express";
import { createServerSupabase } from "../lib/supabase";
import { syncProfileEmail } from "../lib/userLookup";
import { sendInternalError } from "../lib/httpError";
import { createRequestSupabase } from "../lib/authSession";
import { requestOriginIsTrusted } from "../lib/origins";
import { setCurrentUser } from "../lib/observability/sentry";

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

function summarizeMfaFactors(
  factors: Array<{
    factor_type?: string;
    status?: string;
  }> | null | undefined,
) {
  return (factors ?? []).map((factor) => ({
    type: factor.factor_type ?? "unknown",
    status: factor.status ?? "unknown",
  }));
}

function isLoginMfaBootstrapRoute(req: Request) {
  const path = req.originalUrl.split("?")[0];
  if (path === "/auth/session" || path.startsWith("/auth/mfa/")) {
    return true;
  }
  return (
    (req.method === "GET" || req.method === "POST") &&
    (path === "/user/profile" || path === "/users/profile")
  );
}

async function enforceLoginMfaIfEnabled(
  req: Request,
  res: Response,
  admin: ReturnType<typeof createServerSupabase>,
  token: string,
) {
  if (isLoginMfaBootstrapRoute(req)) return true;

  const { data, error } = await admin
    .from("user_profiles")
    .select("mfa_on_login")
    .eq("user_id", res.locals.userId)
    .maybeSingle();

  if (error) {
    devLog("[auth/mfa] login preference lookup failed", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      error: error.message,
      code: error.code,
    });
    if (error.code === "42703") return true;
    sendInternalError(res, error);
    return false;
  }

  const profile = data as { mfa_on_login?: boolean } | null;
  if (profile?.mfa_on_login !== true) return true;

  const { data: assurance, error: assuranceError } =
    await admin.auth.mfa.getAuthenticatorAssuranceLevel(token);

  if (assuranceError) {
    devLog("[auth/mfa] login assurance lookup failed", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      error: assuranceError.message,
    });
    console.error(
      "[auth/mfa] login assurance lookup failed",
      assuranceError,
    );
    res.status(401).json({
      code: "authentication_failed",
      detail: "Unable to verify authentication. Please sign in again.",
    });
    return false;
  }

  if (assurance.nextLevel === "aal2" && assurance.currentLevel !== "aal2") {
    devLog("[auth/mfa] login verification required", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
    });
    res.status(403).json({
      code: "mfa_verification_required",
      detail: "MFA verification required",
    });
    return false;
  }

  return true;
}

function getAdminClient(res: Response) {
  try {
    return createServerSupabase();
  } catch {
    res.status(500).json({ detail: "Server auth is not configured" });
    return null;
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization ?? "";
  const admin = getAdminClient(res);
  if (!admin) return;

  let token = "";
  let user: Awaited<ReturnType<typeof admin.auth.getUser>>["data"]["user"] =
    null;

  if (auth.startsWith("Bearer ")) {
    // Temporary compatibility path for older Word add-ins, load tests, and
    // API clients. Updated browser clients authenticate with HttpOnly cookies.
    token = auth.slice(7).trim();
    const result = await admin.auth.getUser(token);
    user = result.data.user;
  } else {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !requestOriginIsTrusted(req.get("origin"))
    ) {
      res.status(403).json({
        code: "untrusted_origin",
        detail: "The request origin is not allowed.",
      });
      return;
    }

    try {
      const authClient = createRequestSupabase(req, res);
      const result = await authClient.auth.getUser();
      user = result.data.user;
      if (user) {
        const sessionResult = await authClient.auth.getSession();
        token = sessionResult.data.session?.access_token ?? "";
        res.locals.authClient = authClient;
        res.locals.authSource = "cookie";
      }
    } catch (error) {
      console.error("[auth] cookie session initialization failed", error);
      res.status(500).json({ detail: "Server auth is not configured" });
      return;
    }
  }

  if (!user || !token) {
    res.status(401).json({ detail: "Invalid or expired session" });
    return;
  }

  res.locals.userId = user.id;
  res.locals.userEmail = user.email?.toLowerCase() ?? "";
  res.locals.token = token;
  // Id only — enough for "how many users are affected", never the email.
  setCurrentUser(user.id);
  const syncError = await syncProfileEmail(
    admin,
    user.id,
    user.email,
  );
  if (syncError) {
    devLog("[auth/profile-email] sync failed", {
      method: req.method,
      path: req.originalUrl,
      userId: user.id,
      error: syncError.message,
    });
  }
  if (!(await enforceLoginMfaIfEnabled(req, res, admin, token))) {
    return;
  }
  next();
}

export async function requireMfaIfEnrolled(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = typeof res.locals.token === "string" ? res.locals.token : "";
  if (!token) {
    devLog("[auth/mfa] missing auth session", {
      method: req.method,
      path: req.originalUrl,
    });
    res.status(401).json({ detail: "Missing auth session" });
    return;
  }

  const admin = getAdminClient(res);
  if (!admin) return;
  const { data, error } =
    await admin.auth.mfa.getAuthenticatorAssuranceLevel(token);

  if (error) {
    devLog("[auth/mfa] assurance lookup failed", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      error: error.message,
    });
    console.error("[auth/mfa] assurance lookup failed", error);
    res.status(401).json({
      code: "authentication_failed",
      detail: "Unable to verify authentication. Please sign in again.",
    });
    return;
  }

  devLog("[auth/mfa] assurance level", {
    method: req.method,
    path: req.originalUrl,
    userId: res.locals.userId,
    currentLevel: data.currentLevel,
    nextLevel: data.nextLevel,
    required: data.nextLevel === "aal2" && data.currentLevel !== "aal2",
  });

  if (isDev) {
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    devLog("[auth/mfa] user factors", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      factorCount: userData.user?.factors?.length ?? 0,
      factors: summarizeMfaFactors(userData.user?.factors),
      error: userError?.message ?? null,
    });
  }

  if (data.nextLevel === "aal2" && data.currentLevel !== "aal2") {
    devLog("[auth/mfa] verification required", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
    });
    res.status(403).json({
      code: "mfa_verification_required",
      detail: "MFA verification required",
    });
    return;
  }

  next();
}
