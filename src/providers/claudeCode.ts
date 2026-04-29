import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ChatMessage, ChatStreamEvent, ToolCall } from "../ai";
import type { ChatProvider, ProviderModel } from "./types";

// "default" passes no --model flag, so Claude Code uses whatever your
// `claude /login` session is configured for. This is the most reliable
// choice — the aliases (sonnet/opus/haiku) only work if your CLI version
// recognizes them and your subscription has access.
const DEFAULT_MODELS: ProviderModel[] = [
  {
    providerId: "claude-code",
    modelId: "default",
    displayName: "Default (uses your Claude Code configured model)",
    contextWindow: 200_000,
    supportsTools: true,
  },
  {
    providerId: "claude-code",
    modelId: "sonnet",
    displayName: "Sonnet alias (override — only if your CLI accepts it)",
    contextWindow: 1_000_000,
    supportsTools: true,
  },
  {
    providerId: "claude-code",
    modelId: "opus",
    displayName: "Opus alias (override — only if your CLI accepts it)",
    contextWindow: 1_000_000,
    supportsTools: true,
  },
  {
    providerId: "claude-code",
    modelId: "haiku",
    displayName: "Haiku alias (override — only if your CLI accepts it)",
    contextWindow: 200_000,
    supportsTools: true,
  },
];

let availabilityCache: { ok: boolean; checkedAt: number } | null = null;
const AVAILABILITY_TTL_MS = 5_000;

async function checkAvailability(): Promise<boolean> {
  if (
    availabilityCache &&
    Date.now() - availabilityCache.checkedAt < AVAILABILITY_TTL_MS
  ) {
    return availabilityCache.ok;
  }
  try {
    await invoke<string>("claude_code_check");
    availabilityCache = { ok: true, checkedAt: Date.now() };
    return true;
  } catch {
    availabilityCache = { ok: false, checkedAt: Date.now() };
    return false;
  }
}

/** Force a fresh availability check next time isAvailable is called. */
export function invalidateClaudeCodeCache(): void {
  availabilityCache = null;
}

/**
 * Flatten our internal ChatMessage history into a single prompt string for
 * `claude -p`. The CLI is one-shot; multi-turn continuity is achieved with
 * --resume <session-id>, but for simplicity we just concatenate prior turns.
 */
function flattenMessages(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      parts.push(`[System]\n${m.content}\n`);
    } else if (m.role === "user") {
      parts.push(`[User]\n${m.content}\n`);
    } else if (m.role === "assistant") {
      if (m.content) parts.push(`[Assistant]\n${m.content}\n`);
    } else if (m.role === "tool") {
      parts.push(`[Tool result]\n${m.content}\n`);
    }
  }
  return parts.join("\n");
}

export const claudeCodeProvider: ChatProvider = {
  id: "claude-code",
  displayName: "Claude Code (local CLI)",
  needsApiKey: false,
  keyHelpUrl: "https://docs.claude.com/en/docs/claude-code/quickstart",

  async isAvailable() {
    return await checkAvailability();
  },

  async listModels(): Promise<ProviderModel[]> {
    return DEFAULT_MODELS;
  },

  async *chat({ model, messages, signal }) {
    const prompt = flattenMessages(messages);
    const cwd = (typeof window !== "undefined" &&
      (window as unknown as { __LCP_WS_ROOT?: string }).__LCP_WS_ROOT) ||
      undefined;

    let streamId: string;
    try {
      streamId = await invoke<string>("claude_code_chat", {
        prompt,
        cwd,
        model,
      });
    } catch (e) {
      throw new Error(`claude CLI failed to spawn: ${e}`);
    }

    const queue: ChatStreamEvent[] = [];
    let done = false;
    let waker: (() => void) | null = null;
    const wake = () => {
      if (waker) {
        const fn = waker;
        waker = null;
        fn();
      }
    };

    const handle = (data: { kind: string; line?: string; code?: number }) => {
      if (data.kind === "end") {
        done = true;
        wake();
        return;
      }
      if (data.kind === "stderr" && data.line) {
        // Detect "model doesn't exist" error and rewrite to actionable message.
        const line = data.line;
        const isModelError = /model.*(doesn't exist|not found|access)/i.test(
          line,
        );
        const text = isModelError
          ? `\n\n**Model rejected by Claude Code CLI.** Open ⊕ Models and pick one of the aliases (sonnet / opus / haiku). Your CLI may not recognize dated model IDs.`
          : `\n[claude] ${line}`;
        queue.push({ kind: "content", text });
        wake();
        return;
      }
      if (data.kind !== "line" || !data.line) return;
      try {
        const obj = JSON.parse(data.line);
        // Claude Code stream-json shape:
        //   {"type":"system","subtype":"init",...}
        //   {"type":"assistant","message":{"role":"assistant","content":[
        //      {"type":"text","text":"..."},
        //      {"type":"tool_use","id":"...","name":"Read","input":{...}},
        //   ]}}
        //   {"type":"user","message":{"role":"user","content":[
        //      {"type":"tool_result","tool_use_id":"...","content":"..."},
        //   ]}}
        //   {"type":"result","subtype":"success",...}
        if (obj.type === "assistant" && obj.message?.content) {
          for (const block of obj.message.content) {
            if (block.type === "text" && typeof block.text === "string") {
              // Claude Code sometimes returns model-rejection errors as
              // assistant text (not stderr). Detect that and append a
              // helpful action hint.
              const looksLikeModelError =
                /selected model.*may not exist|may not have access|Run --model to pick/i.test(
                  block.text,
                );
              const text = looksLikeModelError
                ? `${block.text}\n\n**→ Open ⊕ Models in the menu and pick "Default" — it skips the --model flag and uses whatever your \`claude /login\` is configured for.**`
                : block.text;
              queue.push({ kind: "content", text });
            } else if (block.type === "tool_use") {
              const call: ToolCall = {
                id: typeof block.id === "string" ? block.id : undefined,
                function: {
                  name: typeof block.name === "string" ? block.name : "tool",
                  arguments:
                    block.input && typeof block.input === "object"
                      ? (block.input as Record<string, unknown>)
                      : {},
                },
              };
              queue.push({ kind: "tool_call", call });
            }
          }
          wake();
        }
        // Tool results from Claude Code's own loop arrive as user messages
        // with tool_result blocks. We don't surface them as ChatStreamEvents
        // since the loop on our side won't run them (Claude Code already did).
      } catch {
        /* skip non-JSON lines */
      }
    };

    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<{ kind: string; line?: string; code?: number }>(
        `claude-stream:${streamId}`,
        (e) => handle(e.payload),
      );
    } catch (e) {
      throw new Error(`failed to listen for claude stream: ${e}`);
    }

    const onAbort = () => {
      void invoke("claude_code_kill", { id: streamId }).catch(() => {});
    };
    signal?.addEventListener("abort", onAbort);

    try {
      while (true) {
        // Drain the queue.
        while (queue.length > 0) {
          const ev = queue.shift()!;
          yield ev;
        }
        if (done) break;
        // Wait for next event.
        await new Promise<void>((resolve) => {
          waker = resolve;
        });
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (unlisten) unlisten();
    }
  },
};
