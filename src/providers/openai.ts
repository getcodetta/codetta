import type { ChatMessage, ToolCall } from "../ai";
import type { ChatProvider, ProviderModel } from "./types";
import { getApiKey } from "./keys";

const BASE = "https://api.openai.com/v1";

// Curated default model list (most users won't need to fetch /v1/models).
const DEFAULT_MODELS: ProviderModel[] = [
  {
    providerId: "openai",
    modelId: "gpt-4o-mini",
    displayName: "GPT-4o mini",
    contextWindow: 128_000,
    supportsTools: true,
  },
  {
    providerId: "openai",
    modelId: "gpt-4o",
    displayName: "GPT-4o",
    contextWindow: 128_000,
    supportsTools: true,
  },
  {
    providerId: "openai",
    modelId: "gpt-4.1-mini",
    displayName: "GPT-4.1 mini",
    contextWindow: 128_000,
    supportsTools: true,
  },
  {
    providerId: "openai",
    modelId: "gpt-4.1",
    displayName: "GPT-4.1",
    contextWindow: 128_000,
    supportsTools: true,
  },
  {
    providerId: "openai",
    modelId: "o3-mini",
    displayName: "o3-mini (reasoning)",
    contextWindow: 200_000,
    supportsTools: true,
  },
];

// OpenAI does not accept role="tool" without prior assistant messages
// containing matching tool_calls. Our internal ChatMessage shape already
// matches OpenAI's, so passthrough is trivial.
function toOpenAiMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.tool_calls.map((c, i) => ({
          id: c.id ?? `call_${i}`,
          type: "function" as const,
          function: {
            name: c.function.name,
            arguments: JSON.stringify(c.function.arguments ?? {}),
          },
        })),
      };
    }
    if (m.role === "tool") {
      return {
        role: "tool" as const,
        content: m.content,
        tool_call_id: m.tool_call_id ?? "call_0",
      };
    }
    return { role: m.role, content: m.content };
  });
}

export const openaiProvider: ChatProvider = {
  id: "openai",
  displayName: "OpenAI",
  needsApiKey: true,
  keyHelpUrl: "https://platform.openai.com/api-keys",

  async isAvailable() {
    return !!getApiKey("openai");
  },

  async listModels(): Promise<ProviderModel[]> {
    return DEFAULT_MODELS;
  },

  async *chat({ model, messages, tools, signal }) {
    const apiKey = getApiKey("openai");
    if (!apiKey) {
      throw new Error("OpenAI API key not configured. Add it in Settings → AI Providers.");
    }
    const body: Record<string, unknown> = {
      model,
      messages: toOpenAiMessages(messages),
      stream: true,
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: t.function,
      }));
    }
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenAI chat failed: HTTP ${res.status} ${errText.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    // Tool calls arrive incrementally — we accumulate per-index then emit
    // a single tool_call event when streaming finishes.
    const pendingCalls = new Map<
      number,
      { id: string; name: string; argsBuf: string }
    >();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE: events separated by blank line, each line "data: {...}".
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const rawLine = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const line = rawLine.trim();
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          for (const c of pendingCalls.values()) {
            yield {
              kind: "tool_call",
              call: makeCallFromPending(c),
            };
          }
          pendingCalls.clear();
          return;
        }
        try {
          const j = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
          };
          const delta = j.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) {
            yield { kind: "content", text: delta.content };
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              let cur = pendingCalls.get(idx);
              if (!cur) {
                cur = { id: tc.id ?? `call_${idx}`, name: "", argsBuf: "" };
                pendingCalls.set(idx, cur);
              }
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.name = tc.function.name;
              if (tc.function?.arguments) cur.argsBuf += tc.function.arguments;
            }
          }
        } catch {
          /* skip malformed event */
        }
      }
    }
    // If the stream ended without [DONE], flush whatever we have.
    for (const c of pendingCalls.values()) {
      yield { kind: "tool_call", call: makeCallFromPending(c) };
    }
  },
};

function makeCallFromPending(c: {
  id: string;
  name: string;
  argsBuf: string;
}): ToolCall {
  let args: Record<string, unknown> = {};
  if (c.argsBuf) {
    try {
      const parsed = JSON.parse(c.argsBuf);
      if (parsed && typeof parsed === "object") {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      /* leave empty */
    }
  }
  return { id: c.id, function: { name: c.name, arguments: args } };
}
