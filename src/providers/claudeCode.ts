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
 * On a resumed session Claude Code already has the prior history server-
 * side, so we only need to send the most recent user turn. Falls back
 * to the empty string if no user message exists (shouldn't happen).
 */
function lastUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return m.content;
  }
  return "";
}

/**
 * Flatten our internal ChatMessage history into a single prompt string for
 * `claude -p`. Used only on the FIRST turn of a Claude Code conversation —
 * subsequent turns reuse the server-side session via --resume and send
 * just the latest user message.
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

  async *chat({ model, messages, signal, resumeSessionId, chatSessionId }) {
    // When resuming an existing Claude Code session, send only the LATEST
    // user message — the CLI already has the server-side history. Sending
    // the full transcript again would double-count it. On a fresh session
    // we still flatten the whole thing so the model has context.
    const prompt = resumeSessionId
      ? lastUserMessage(messages)
      : flattenMessages(messages);
    const cwd = (typeof window !== "undefined" &&
      (window as unknown as { __LCP_WS_ROOT?: string }).__LCP_WS_ROOT) ||
      undefined;

    let streamId: string;
    try {
      streamId = await invoke<string>("claude_code_chat", {
        prompt,
        cwd,
        model,
        resumeSessionId,
        chatSessionId,
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
    // Track per-message-block whether we've consumed text via
    // content_block_delta events (--include-partial-messages). When
    // we have, the final `assistant` event would double-emit the
    // same text — skip text blocks for any message id we've already
    // streamed via deltas. Tool_use blocks are still emitted via
    // the assistant event (their input streams as input_json_delta
    // chunks which we don't bother assembling — easier to use the
    // final whole tool_use).
    const streamedMessageIds = new Set<string>();

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
        //   {"type":"system","subtype":"init","session_id":"<uuid>",...}
        //   {"type":"assistant","message":{"role":"assistant","content":[
        //      {"type":"text","text":"..."},
        //      {"type":"tool_use","id":"...","name":"Read","input":{...}},
        //   ]}}
        //   {"type":"user","message":{"role":"user","content":[
        //      {"type":"tool_result","tool_use_id":"...","content":"..."},
        //   ]}}
        //   {"type":"result","subtype":"success","session_id":"<uuid>",...}
        // Capture the session id once at init so the chat panel can
        // pass it back via resumeSessionId on the next turn.
        if (
          obj.type === "system" &&
          obj.subtype === "init" &&
          typeof obj.session_id === "string"
        ) {
          queue.push({ kind: "session", id: obj.session_id });
          wake();
        }
        // Token-level streaming via --include-partial-messages.
        // Each `stream_event` line wraps a raw Anthropic API
        // streaming event. We only need text deltas — tool_use
        // input deltas and message_start/stop are noise here
        // because the wrapping `assistant` event (still emitted)
        // gives us the complete tool_use block at end of message.
        if (obj.type === "stream_event" && obj.event) {
          const ev = obj.event;
          if (
            ev.type === "content_block_delta" &&
            ev.delta?.type === "text_delta" &&
            typeof ev.delta.text === "string"
          ) {
            const msgId =
              typeof obj.message_id === "string" ? obj.message_id : "current";
            streamedMessageIds.add(msgId);
            queue.push({ kind: "content", text: ev.delta.text });
            wake();
          }
        }
        if (obj.type === "assistant" && obj.message?.content) {
          // If we've already streamed this message's text via
          // content_block_delta events, suppress the duplicate text
          // blocks here. tool_use blocks always pass through (their
          // arg deltas weren't consumed above).
          const msgId =
            typeof obj.message?.id === "string" ? obj.message.id : "current";
          const alreadyStreamed = streamedMessageIds.has(msgId);
          for (const block of obj.message.content) {
            if (alreadyStreamed && block.type === "text") continue;
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
        // with tool_result blocks. Surface them so the chat UI can render
        // what each tool actually returned (Read file contents, Bash
        // stdout, Glob hits, etc.) — without this the user sees only
        // "I'll explore the codebase" → silence → final answer.
        // End-of-turn report carries cost + token usage + total duration +
        // model used. Surface it so the chat UI can show "$0.02 · 1.2k in /
        // 567 out · cached 89% · 3.1s" in the status strip — invaluable for
        // catching the documented resume-cache-miss spend regressions.
        if (obj.type === "result") {
          const u = (obj.usage ?? {}) as Record<string, unknown>;
          const num = (v: unknown) =>
            typeof v === "number" && Number.isFinite(v) ? v : 0;
          queue.push({
            kind: "usage",
            cost: typeof obj.cost_usd === "number" ? obj.cost_usd : undefined,
            durationMs:
              typeof obj.duration_ms === "number"
                ? obj.duration_ms
                : undefined,
            model: typeof obj.model === "string" ? obj.model : undefined,
            tokens: {
              input: num(u.input_tokens),
              output: num(u.output_tokens),
              cacheRead: num(u.cache_read_input_tokens),
              cacheCreate: num(u.cache_creation_input_tokens),
            },
            isError: obj.is_error === true,
          });
          wake();
        }
        if (obj.type === "user" && obj.message?.content) {
          for (const block of obj.message.content) {
            if (block.type !== "tool_result") continue;
            // Content can be a string OR an array of blocks (text + image).
            // Flatten to a string for the simple chat-card renderer.
            let text = "";
            if (typeof block.content === "string") {
              text = block.content;
            } else if (Array.isArray(block.content)) {
              text = block.content
                .map((c: unknown) => {
                  if (c && typeof c === "object") {
                    const co = c as Record<string, unknown>;
                    if (co.type === "text" && typeof co.text === "string") {
                      return co.text;
                    }
                    if (co.type === "image") return "[image]";
                  }
                  return "";
                })
                .join("\n");
            }
            queue.push({
              kind: "tool_result",
              tool_use_id:
                typeof block.tool_use_id === "string"
                  ? block.tool_use_id
                  : "",
              content: text,
              is_error: block.is_error === true,
            });
          }
          wake();
        }
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
