import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeWithProvider, streamWithProvider } from "../llm/providers";
function streamResponse(chunks: unknown[]): Response {
  const body = `${chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function functionTool(
  name: string,
  parameters: Record<string, unknown> = { type: "object" },
) {
  return {
    type: "function" as const,
    function: { name, description: `${name} test tool`, parameters },
  };
}

beforeEach(() => {
  vi.stubEnv("GATEWAY_MODELS", "legal-chat,openai/gpt-5.4,gateway/v0-1.5-md");
  vi.stubEnv("GATEWAY_API_KEY", "gateway-user-key");
  vi.stubEnv("GATEWAY_DEFAULT_MODEL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("gateway transport", () => {
  it("calls an OpenAI-compatible gateway with Chat Completions and no reasoning field", async () => {
    vi.stubEnv("GATEWAY_BASE_URL", "https://gateway.example/v1/");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "A gateway title" } }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeWithProvider({
      model: "gateway/openai/gpt-5.4",
      user: "Title this",
    });

    expect(result).toBe("A gateway title");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gateway.example/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer gateway-user-key",
    );
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "openai/gpt-5.4" });
    // Reasoning controls are disabled for this protocol, so the optional
    // OpenAI extension must not reach a gateway that may reject it.
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("reasoning");
  });

  it("forwards a gateway-native model id that starts with the router slug", async () => {
    vi.stubEnv("GATEWAY_BASE_URL", "https://gateway.example/v1");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "A v0 title" } }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await completeWithProvider({
      model: "gateway/gateway/v0-1.5-md",
      user: "Title this",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "gateway/v0-1.5-md",
    });
  });

  it("streams a tool call, its result, and the final text in compatible mode", async () => {
    vi.stubEnv("GATEWAY_BASE_URL", "https://gateway.example/v1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        streamResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      type: "function",
                      function: {
                        name: "lookup",
                        arguments: '{"term":"contract"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: "tool_calls" }],
          },
        ]),
      )
      .mockResolvedValueOnce(
        streamResponse([
          { choices: [{ delta: { content: "Done" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const runTools = vi
      .fn()
      .mockResolvedValue([{ tool_use_id: "call-1", content: "result" }]);

    const result = await streamWithProvider({
      model: "gateway/openai/gpt-5.4",
      systemPrompt: "Help",
      messages: [{ role: "user", content: "Review" }],
      tools: [functionTool("lookup")],
      reasoning: "high",
      runTools,
    });

    expect(result.fullText).toBe("Done");
    expect(runTools).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://gateway.example/v1/chat/completions",
    );
    const secondBody = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
    );
    expect(secondBody.model).toBe("openai/gpt-5.4");
    // A requested reasoning level must not reach a gateway whose models
    // Mike cannot check for support.
    expect(secondBody).not.toHaveProperty("reasoning_effort");
    expect(secondBody.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant" }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call-1",
          content: "result",
        }),
      ]),
    );
  });

  it("sends aliases without Authorization when the deployment key is omitted", async () => {
    vi.stubEnv("GATEWAY_BASE_URL", "http://localhost:8080/v1");
    vi.stubEnv("GATEWAY_API_KEY", "");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Title" } }],
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await completeWithProvider({ model: "gateway/legal-chat", user: "Title" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(init.body)).model).toBe("legal-chat");
  });
  it("rejects unlisted models before any HTTP request", async () => {
    vi.stubEnv("GATEWAY_BASE_URL", "http://localhost:8080/v1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      completeWithProvider({ model: "gateway/unlisted", user: "Title" }),
    ).rejects.toThrow("not available");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
