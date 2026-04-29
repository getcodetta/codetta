// Public AI surface: shared types + a router that dispatches to the
// configured provider (Ollama, OpenAI, Anthropic). Provider-specific
// transport lives under src/providers/.

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

export interface ToolCall {
  id?: string;
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  /** Display-only: an opaque tag to associate a tool message with a call. */
  tool_call_id?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description?: string }>;
      required?: string[];
    };
  };
}

export type ChatStreamEvent =
  | { kind: "content"; text: string }
  | { kind: "tool_call"; call: ToolCall };

import { getProvider, parseQualifiedModel } from "./providers";
import type { ProviderId } from "./providers";

const OLLAMA_BASE = "http://localhost:11434";

/** Back-compat: still used by the no-models / "Ollama running?" UI. */
export async function ping(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Back-compat: list LOCAL Ollama models only (used by the no-models flow). */
export async function listModels(): Promise<OllamaModel[]> {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`);
  if (!res.ok) throw new Error("Ollama not reachable");
  const j = (await res.json()) as { models?: OllamaModel[] };
  return j.models ?? [];
}

/**
 * Stream a chat response. The model id is provider-qualified: e.g.
 * "ollama:qwen2.5-coder:7b" or "openai:gpt-4o-mini". For back-compat,
 * an unqualified id (no provider prefix recognized) defaults to ollama.
 */
export async function* chatStream(
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
  tools?: ToolDef[],
): AsyncGenerator<ChatStreamEvent, void, unknown> {
  const parsed = parseQualifiedModel(model);
  const providerId: ProviderId = parsed?.providerId ?? "ollama";
  const modelId = parsed?.modelId ?? model;
  const provider = getProvider(providerId);
  yield* provider.chat({ model: modelId, messages, tools, signal });
}

/** Ollama-only: pull a model. Yields progress lines. */
export async function* pullStream(
  name: string,
  signal?: AbortSignal,
): AsyncGenerator<{ status: string; completed?: number; total?: number }, void, unknown> {
  const res = await fetch(`${OLLAMA_BASE}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Ollama pull failed: HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* skip */
      }
    }
  }
}
