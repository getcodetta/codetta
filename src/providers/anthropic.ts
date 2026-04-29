import type { ChatMessage, ToolCall } from "../ai";
import type { ChatProvider, ProviderModel } from "./types";
import { getApiKey } from "./keys";

const BASE = "https://api.anthropic.com/v1";

const DEFAULT_MODELS: ProviderModel[] = [
  {
    providerId: "anthropic",
    modelId: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5 (fastest)",
    contextWindow: 200_000,
    supportsTools: true,
  },
  {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6 (balanced)",
    contextWindow: 1_000_000,
    supportsTools: true,
  },
  {
    providerId: "anthropic",
    modelId: "claude-opus-4-7",
    displayName: "Claude Opus 4.7 (smartest)",
    contextWindow: 1_000_000,
    supportsTools: true,
  },
];

function toAnthropicMessages(messages: ChatMessage[]) {
  // Anthropic separates the system prompt from the conversation. Find any
  // role==="system" messages and merge them into a single system string.
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns: Array<{
    role: "user" | "assistant";
    content: unknown;
  }> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      // Tool results are appended as user-role messages with tool_result content blocks.
      turns.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id ?? "tool_0",
            content: m.content,
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant") {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      if (m.tool_calls) {
        for (const c of m.tool_calls) {
          blocks.push({
            type: "tool_use",
            id: c.id ?? "tool_0",
            name: c.function.name,
            input: c.function.arguments ?? {},
          });
        }
      }
      turns.push({ role: "assistant", content: blocks });
      continue;
    }
    if (m.role === "user") {
      turns.push({ role: "user", content: m.content });
    }
  }
  return { system, turns };
}

export const anthropicProvider: ChatProvider = {
  id: "anthropic",
  displayName: "Anthropic",
  needsApiKey: true,
  keyHelpUrl: "https://console.anthropic.com/settings/keys",

  async isAvailable() {
    return !!getApiKey("anthropic");
  },

  async listModels(): Promise<ProviderModel[]> {
    return DEFAULT_MODELS;
  },

  async *chat({ model, messages, tools, signal }) {
    const apiKey = getApiKey("anthropic");
    if (!apiKey) {
      throw new Error("Anthropic API key not configured. Add it in Settings → AI Providers.");
    }
    const { system, turns } = toAnthropicMessages(messages);
    const body: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      stream: true,
      messages: turns,
    };
    if (system) body.system = system;
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }
    const res = await fetch(`${BASE}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Anthropic chat failed: HTTP ${res.status} ${errText.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    // Track in-flight tool_use content blocks to assemble args.
    const blocks = new Map<
      number,
      { id: string; name: string; argsBuf: string }
    >();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const rawLine = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const line = rawLine.trim();
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const j = JSON.parse(payload) as {
            type?: string;
            index?: number;
            content_block?: {
              type?: string;
              id?: string;
              name?: string;
            };
            delta?: {
              type?: string;
              text?: string;
              partial_json?: string;
            };
          };
          if (j.type === "content_block_start" && j.content_block?.type === "tool_use") {
            blocks.set(j.index ?? 0, {
              id: j.content_block.id ?? `tool_${j.index ?? 0}`,
              name: j.content_block.name ?? "",
              argsBuf: "",
            });
          } else if (j.type === "content_block_delta") {
            if (j.delta?.type === "text_delta" && j.delta.text) {
              yield { kind: "content", text: j.delta.text };
            } else if (j.delta?.type === "input_json_delta" && j.delta.partial_json) {
              const cur = blocks.get(j.index ?? 0);
              if (cur) cur.argsBuf += j.delta.partial_json;
            }
          } else if (j.type === "content_block_stop") {
            const cur = blocks.get(j.index ?? 0);
            if (cur && cur.name) {
              yield { kind: "tool_call", call: makeCallFromBlock(cur) };
              blocks.delete(j.index ?? 0);
            }
          } else if (j.type === "message_stop") {
            return;
          }
        } catch {
          /* skip */
        }
      }
    }
    for (const cur of blocks.values()) {
      if (cur.name) yield { kind: "tool_call", call: makeCallFromBlock(cur) };
    }
  },
};

function makeCallFromBlock(c: {
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
