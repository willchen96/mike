/// <reference types="office-js" />
import {
  GOOGLE_OAUTH_MESSAGE_TYPE,
  type GoogleOAuthDialogMessage,
} from "../taskpane/auth/oauthProtocol";
import { initAddinErrorReporting } from "../taskpane/lib/errorReporting";

initAddinErrorReporting("oauth-dialog");

const API_BASE = (process.env.REACT_APP_API_BASE_URL || "/api").replace(
  /\/+$/,
  "",
);
const REQUEST_STORAGE_KEY = "mike-word-google-oauth-request";

function setStatus(message: string): void {
  const element = document.getElementById("status");
  if (element) element.textContent = message;
}

function send(message: GoogleOAuthDialogMessage): boolean {
  // No legacy (option-less) retry on failure: dropping targetOrigin would
  // weaken the receiver's origin check (session.ts skips it when the host
  // omits event.origin), and every host this add-in supports has the
  // DialogOrigin 1.1 set. A visible failure beats a weaker handoff.
  try {
    Office.context.ui.messageParent(JSON.stringify(message), {
      targetOrigin: window.location.origin,
    });
    return true;
  } catch {
    setStatus(
      "Could not notify Word that sign-in completed. Close this window and try again.",
    );
    return false;
  }
}

function sendError(requestId: string, message: string): void {
  setStatus(message);
  send({
    type: GOOGLE_OAUTH_MESSAGE_TYPE,
    requestId,
    status: "error",
    message,
  });
}

function clearTemporaryAuthStorage(): void {
  // Sweep up PKCE/session keys left by older browser-Supabase builds.
  for (const storage of [window.sessionStorage, window.localStorage]) {
    storage.removeItem("mike-word-google-oauth");
    storage.removeItem("mike-word-google-oauth-code-verifier");
  }
  window.sessionStorage.removeItem(REQUEST_STORAGE_KEY);
}

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as {
    detail?: unknown;
  };
  return typeof body.detail === "string" && body.detail
    ? body.detail
    : `Google sign-in failed (HTTP ${response.status}).`;
}

async function runGoogleOAuth(): Promise<void> {
  const currentUrl = new URL(window.location.href);
  const requestedId = currentUrl.searchParams.get("requestId");
  if (requestedId) {
    window.sessionStorage.setItem(REQUEST_STORAGE_KEY, requestedId);
  }
  const requestId =
    requestedId ?? window.sessionStorage.getItem(REQUEST_STORAGE_KEY) ?? "";
  if (!requestId) {
    setStatus(
      "This sign-in request is invalid. Close this window and try again.",
    );
    return;
  }

  const providerError =
    currentUrl.searchParams.get("error_description") ??
    currentUrl.searchParams.get("error");
  if (providerError) {
    clearTemporaryAuthStorage();
    sendError(requestId, providerError);
    return;
  }

  const code = currentUrl.searchParams.get("code");
  if (code) {
    setStatus("Completing sign-in…");
    const response = await fetch(`${API_BASE}/auth/exchange`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, handoffRequestId: requestId }),
    });
    if (!response.ok) {
      const message = await responseError(response);
      clearTemporaryAuthStorage();
      sendError(requestId, message);
      return;
    }

    const data = (await response.json()) as { handoffTicket?: unknown };
    if (
      typeof data.handoffTicket !== "string" ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(data.handoffTicket)
    ) {
      clearTemporaryAuthStorage();
      sendError(requestId, "Google sign-in did not produce a valid handoff.");
      return;
    }

    const message: GoogleOAuthDialogMessage = {
      type: GOOGLE_OAUTH_MESSAGE_TYPE,
      requestId,
      status: "success",
      handoffTicket: data.handoffTicket,
    };
    clearTemporaryAuthStorage();
    if (send(message)) {
      setStatus("Signed in. You can return to Word.");
    }
    return;
  }

  const response = await fetch(`${API_BASE}/auth/oauth`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "google",
      callbackPath: "/oauth-dialog.html",
      next: "/assistant",
    }),
  });
  if (!response.ok) {
    const message = await responseError(response);
    clearTemporaryAuthStorage();
    sendError(requestId, message);
    return;
  }
  const data = (await response.json()) as { url?: string };
  if (!data.url) {
    clearTemporaryAuthStorage();
    sendError(requestId, "Unable to open Google sign-in.");
    return;
  }

  window.location.assign(data.url);
}

Office.onReady(() => {
  void runGoogleOAuth().catch((error: unknown) => {
    const requestId =
      new URL(window.location.href).searchParams.get("requestId") ??
      window.sessionStorage.getItem(REQUEST_STORAGE_KEY);
    const message =
      error instanceof Error
        ? error.message
        : "Unable to complete Google sign-in.";
    if (requestId) {
      sendError(requestId, message);
    } else {
      setStatus(message);
    }
  });
});
