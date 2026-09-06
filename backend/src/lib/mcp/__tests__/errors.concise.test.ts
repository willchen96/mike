import { describe, expect, it } from "vitest";
import { conciseMcpErrorMessage } from "../errors";

/**
 * The MCP SDK embeds entire server response bodies in thrown Error messages.
 * Google's front end answers requests to a wrong path with a full HTML 400
 * page ("Error 400 (Bad Request)!!1"), which — unfiltered — reached the
 * connectors UI verbatim. These tests pin the two guarantees of the concise
 * formatter: the body never survives, and the one actionable hint (Google's
 * MCP endpoints are versioned; discovery metadata advertises the unversioned
 * path) fires exactly when it applies.
 */

function googleHtml400Error(): Error {
  const err = new Error(
    "Streamable HTTP error: Error POSTing to endpoint: <html lang=\"en\"><title>Error 400 (Bad Request)!!1</title><main>The server cannot process the request because it is malformed.</main>",
  );
  (err as Error & { code?: number }).code = 400;
  return err;
}

describe("conciseMcpErrorMessage", () => {
  it("never passes an embedded HTML error page through to the user", () => {
    const message = conciseMcpErrorMessage(googleHtml400Error());
    expect(message).not.toContain("<html");
    expect(message).not.toContain("!!1");
    expect(message).toContain("HTTP 400");
  });

  it("adds the versioned-endpoint hint for an unversioned Google URL", () => {
    const message = conciseMcpErrorMessage(
      googleHtml400Error(),
      "https://drivemcp.googleapis.com/mcp",
    );
    expect(message).toContain("drivemcp.googleapis.com/mcp/v1");
  });

  it("stays quiet for a Google URL that is already versioned", () => {
    const message = conciseMcpErrorMessage(
      googleHtml400Error(),
      "https://drivemcp.googleapis.com/mcp/v1",
    );
    expect(message).not.toContain("versioned");
  });

  it("stays quiet for non-Google servers", () => {
    const message = conciseMcpErrorMessage(
      googleHtml400Error(),
      "https://mcp.example.com/mcp",
    );
    expect(message).not.toContain("versioned");
  });

  it("adds the Slack endpoint hint when a wrong slack.com path redirects", () => {
    // Wrong slack.com paths answer with a 302 (to an HTML page) instead of a
    // JSON-RPC error; the SDK surfaces that as an opaque non-2xx failure.
    const err = new Error("Streamable HTTP error: HTTP 302");
    (err as Error & { code?: number }).code = 302;
    const message = conciseMcpErrorMessage(err, "https://slack.com/api/mcp");
    expect(message).toContain("https://mcp.slack.com/mcp");
  });

  it("stays quiet for the real Slack endpoint", () => {
    const err = new Error("Streamable HTTP error: HTTP 404");
    (err as Error & { code?: number }).code = 404;
    const message = conciseMcpErrorMessage(err, "https://mcp.slack.com/mcp");
    expect(message).not.toContain("other slack.com URLs");
  });

  it("passes plain error messages through untouched", () => {
    const message = conciseMcpErrorMessage(new Error("OAuth state is invalid or expired."));
    expect(message).toBe("OAuth state is invalid or expired.");
  });
});
