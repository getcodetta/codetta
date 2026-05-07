import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  chatStream,
  ping,
  pullStream,
  type ChatMessage,
  type ToolCall,
} from "../ai";
import {
  hasApiKey,
  invalidateClaudeCodeCache,
  listAllModels,
  listAllCloudModels,
  makeQualifiedModel,
  parseQualifiedModel,
  warmupOllamaModel,
  type ProviderModel,
} from "../providers";
import { openSettings } from "../settingsBus";
import { useStore, parseKey, findPaneById } from "../store";
import { useEditorState, getActiveEditor } from "../editorState";
import { setWorkspaceRoot } from "../wsRoot";
import {
  getString as lsGetString,
  setString as lsSetString,
} from "../localStore";
import {
  balanceFences,
  cleanStaleToolMessages,
  extractCodeBlocks,
  extractTaggedCodeBlocks,
  isShellLang,
  parseInlineToolCalls,
  pickPriorityFiles,
  splitThinking,
} from "../chatTextUtils";
import { executeTool, TOOLS } from "../aiTools";
import { SLASH_COMMANDS, type SlashCommand } from "../slashCommands";
import {
  extractEditDiffs,
  InterleavedBlocks,
  RunningToolRow,
  ToolCallRow,
  toolDetailFor,
} from "./chatToolRender";
import { ComposeCard } from "./composeCard";
import { PermissionCard, PrivacyBanner } from "./aiInlineCards";
import {
  ClaudeSessionsButton,
  HeaderMenu,
  TimelineScrubber,
  TodosCard,
  UsageChip,
} from "./chatPanelChrome";
import { matchExclusion } from "../aiPrivacy";
import { ClaudePermissionOverlay } from "./ClaudePermissionOverlay";
import { recordUsage, wouldExceedHardCap } from "../aiUsageLog";
import { captureSnapshot } from "../composeSnapshots";
import {
  error as toastError,
  errMsg,
  info as toastInfo,
  success as toastSuccess,
} from "../notify";
import { confirm as dialogConfirm } from "../dialog";
import {
  loadSessions,
  saveSession,
  deleteSession,
  newSessionId,
  deriveTitle,
  type ChatSession,
} from "../chatHistory";
import {
  search,
  pty,
  fs,
  claudeCode as claudeCodeIpc,
} from "../ipc";
import { MarkdownPreview } from "./MarkdownPreview";
import { ModelBrowser } from "./ModelBrowser";
import { permissionFor } from "../toolPermissions";

interface Props {
  wsId: string;
  root: string;
  /**
   * When set, this AIChatPanel instance is bound to a moveable AI tab
   * (one of `WorkspaceData.aiChats[aiChatId]`). It will load that tab's
   * stored sessionId on mount, and write back any sessionId / title
   * changes so they survive pane drags + reloads.
   *
   * When omitted, the panel runs in legacy "right-side singleton" mode:
   * it auto-restores the most-recent saved session on workspace switch,
   * just like before.
   */
  aiChatId?: string;
}

// Per-chat budget threshold in USD, persisted in localStorage. 0 =
// disabled (no warning ever fires). Read on every turn so changes
// from Settings take effect immediately.
const BUDGET_KEY = "lcp.claudeCode.budgetUsd";
function readBudgetUsd(): number {
  const raw = lsGetString(BUDGET_KEY);
  if (!raw) return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const OLLAMA_DOWNLOAD = "https://ollama.com/download";
const SUGGESTED_MODELS = [
  "qwen2.5-coder:7b",
  "qwen2.5-coder:3b",
  "llama3.2:3b",
  "phi3:mini",
];
const STORAGE_KEY = "lcp.ollama.lastModel";

// Pure text helpers (extractCodeBlocks, splitThinking, parseInlineToolCalls,
// etc.) live in chatTextUtils.ts so the chat panel doesn't have to host
// 250 lines of regex / brace-walking that's reusable elsewhere.


function insertIntoActiveEditor(text: string): boolean {
  const ed = getActiveEditor();
  if (!ed) return false;
  const sel = ed.getSelection();
  if (!sel) return false;
  ed.executeEdits("ai-insert", [
    {
      range: sel,
      text,
      forceMoveMarkers: true,
    },
  ]);
  ed.focus();
  return true;
}

export function AIChatPanel({ wsId, root, aiChatId }: Props) {
  // Start in "ready" rather than "checking" so the panel renders the
  // normal UI immediately on open. "Checking for Ollama…" used to flash
  // up before model discovery finished, which was confusing for users
  // who don't even use Ollama (they're on Claude Code or a cloud key).
  // Discovery still runs in the background and may flip the state to
  // "missing" / "no-models" if no models exist anywhere.
  const [status, setStatus] = useState<
    "checking" | "missing" | "ready" | "no-models"
  >("ready");
  const [allModels, setAllModels] = useState<ProviderModel[]>([]);
  // Curated cloud models, shown in the browser regardless of key status so
  // users can discover what's available before setting up a key.
  const [allCloudCatalog, setAllCloudCatalog] = useState<ProviderModel[]>([]);
  const [claudeCodeAvailable, setClaudeCodeAvailable] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  // Live chronological block log for the in-progress assistant bubble.
  // Mirrors `blocksThisRound` inside sendUserText so the streaming
  // bubble can render text → tool → text → tool in real time instead
  // of dumping all tool calls above the text on round-end. Cleared
  // when streaming ends and the message is committed to `messages`.
  const [streamingBlocks, setStreamingBlocks] = useState<
    NonNullable<ChatMessage["blocks"]>
  >([]);
  // Per-model pull progress so multiple installs can run in parallel.
  // Map(modelName → "human-readable progress line"). Empty = nothing pulling.
  const [pullProgressMap, setPullProgressMap] = useState<
    Record<string, string>
  >({});
  const [browserOpen, setBrowserOpen] = useState(false);
  const isAnyPulling = Object.keys(pullProgressMap).length > 0;
  const aggregatedPullProgress = isAnyPulling
    ? Object.values(pullProgressMap).join(" · ")
    : null;
  const [attachContext, setAttachContext] = useState(true);
  const [runningTools, setRunningTools] = useState(false);
  // Tool calls currently in flight, with enough detail per row to render
  // a per-line "Tool path" + a short preview of the change (so the user
  // can see what's about to land instead of a truncated "+7" overflow).
  // Each entry tracks status so done rows can render a checkmark
  // instead of the perpetual-spinner illusion. id matches the
  // tool_use_id so tool_result events can flip the matching label
  // to "done" the moment the result lands.
  const [activeToolLabels, setActiveToolLabels] = useState<
    Array<{
      id?: string;
      name: string;
      detail: string;
      preview?: string;
      status: "running" | "done" | "error";
    }>
  >([]);
  // Live tool calls + results for the in-progress bubble. Mirror state
  // updated alongside streamingBlocks so InterleavedBlocks can resolve
  // each `tool_call` block to a real ToolCall + its result while the
  // round is still streaming. Cleared on round end.
  const [streamingToolCalls, setStreamingToolCalls] = useState<ToolCall[]>([]);
  const [streamingToolResults, setStreamingToolResults] = useState<
    Array<{ tool_use_id: string; content: string; is_error?: boolean }>
  >([]);
  // Inline permission request — when a tool needs "ask" approval, instead
  // of popping a modal we render a card in the chat with multiple options.
  // The chat loop awaits a Promise that resolves when the user clicks one.
  const [pendingPermission, setPendingPermission] = useState<{
    call: ToolCall;
    resolve: (decision: "allow" | "deny") => void;
  } | null>(null);
  // Live tokens-per-second during streaming, and a sticky "warming up"
  // marker for the cold-start window before the first token arrives.
  const [tokensPerSec, setTokensPerSec] = useState<number | null>(null);
  // Most-recent end-of-turn usage report from the agentic provider
  // (Claude Code emits this in its `result` event). Pinned in the
  // status strip so the user sees what the last turn cost in dollars +
  // tokens, including cache hit ratio. Cleared on new chat / clear.
  const [lastUsage, setLastUsage] = useState<{
    cost?: number;
    durationMs?: number;
    model?: string;
    tokens?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheCreate: number;
    };
  } | null>(null);
  // Latest TodoWrite snapshot from the agent, rendered as a sticky
  // checklist above the chat. Per Shrivu Shankar — "the todo list is
  // the most informative single artifact of an agent run". Updated
  // every time Claude Code emits a TodoWrite tool_use; cleared on new
  // chat / clear / restore.
  const [todos, setTodos] = useState<Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm?: string;
  }> | null>(null);
  // Cumulative USD spend across every turn in this chat. Persisted
  // alongside the conversation so the running tally survives reloads.
  // Used by the spend chip in the footer + the budget-warning toast.
  const [chatTotalCost, setChatTotalCost] = useState<number>(0);
  // Toggle: has the user been warned about the budget for this chat
  // yet? Avoids spamming the toast every turn once they cross.
  const [budgetWarned, setBudgetWarned] = useState(false);
  // Timeline scrubber — when non-null, messages past this index are
  // dimmed and the user can branch from that point into a new chat
  // tab without disturbing the current one. Null = no scrub (live).
  // Reset on session change, new chat, regenerate.
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const [warmingUp, setWarmingUp] = useState(false);
  // EMA of recent assistant generations for the slow-model banner.
  const [recentTps, setRecentTps] = useState<number | null>(null);
  // Wall-clock of the last stream event we received from the provider.
  // Used by the inline-status to switch from "Generating response…" to
  // "Still working — Xs since last update" when the stream goes quiet
  // for a noticeable while. User reported waiting "so long for messages
  // to come back" with the indicator hidden — this gives them visible
  // proof that the app hasn't lost track.
  const [lastStreamEventAt, setLastStreamEventAt] = useState<number | null>(
    null,
  );
  // Keying the 1-Hz tick interval by `streaming === null ? 'idle' : 'live'`
  // so we set it up exactly once per turn (start) and tear it down once
  // (end), instead of churning the interval on every incoming event when
  // we used `lastStreamEventAt` as the dep.
  const [, setNowTick] = useState(0);
  const isStreamingForTick = streaming !== null;
  useEffect(() => {
    if (!isStreamingForTick) return;
    const t = window.setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [isStreamingForTick]);
  // Initialize sessionId DIRECTLY from the chat-tab descriptor on
  // first render. Was using a fresh newSessionId() which created a
  // race: the setAIChatSession effect would briefly overwrite the
  // descriptor with the throwaway id before the restore effect set
  // it back. If a save fired during that window, the chat history
  // got persisted under the throwaway id and refresh-resume couldn't
  // find it. Reading synchronously here closes the race.
  const [sessionId, setSessionId] = useState<string>(() => {
    if (aiChatId) {
      const desc = useStore.getState().loaded[wsId]?.aiChats[aiChatId];
      if (desc?.sessionId) return desc.sessionId;
    }
    return newSessionId();
  });
  // Claude Code provider session id, captured from stream-json `system/init`.
  // Lets us pass --resume on every follow-up turn so the CLI keeps the
  // server-side context window alive instead of re-paying cold-start cost.
  // Cleared when the user starts a new chat or restores a non-CC session.
  const [claudeSessionId, setClaudeSessionId] = useState<string | undefined>(
    undefined,
  );
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [attachTree, setAttachTree] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [attachTerminal, setAttachTerminal] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const editorState = useEditorState();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickyBottomRef = useRef(true);
  const [expandedMsgIdx, setExpandedMsgIdx] = useState<Set<number>>(new Set());

  // Reset expanded state when the conversation switches (new chat / restore).
  useEffect(() => {
    setExpandedMsgIdx(new Set());
  }, [sessionId]);

  // Auto-grow the prompt textarea up to ~8 lines so multi-paragraph
  // questions don't get cropped behind a tiny scrollbar. Falls back to
  // the rows={2} baseline when empty.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = 8 * 18 + 16; // ~8 rows of line-height 18px + padding
    el.style.height = Math.min(el.scrollHeight, max) + "px";
  }, [input]);

  const refresh = async (showChecking = false) => {
    if (showChecking) setStatus("checking");
    // Always re-check Claude Code availability so post-install detects.
    invalidateClaudeCodeCache();
    // Aggregate models across every configured provider.
    let aggregate: ProviderModel[] = [];
    try {
      aggregate = await listAllModels();
    } catch {
      aggregate = [];
    }
    setAllModels(aggregate);
    // Always populate curated cloud lists so the browser can show them
    // regardless of key status.
    try {
      setAllCloudCatalog(await listAllCloudModels());
    } catch {
      setAllCloudCatalog([]);
    }
    // Detect whether the Claude Code CLI is available on PATH.
    try {
      const ccProvider = (await import("../providers")).getProvider(
        "claude-code",
      );
      setClaudeCodeAvailable(await ccProvider.isAvailable());
    } catch {
      setClaudeCodeAvailable(false);
    }
    // Track Ollama-specific availability for the install/pull onboarding UI.
    const ollamaUp = await ping();

    if (aggregate.length > 0) {
      setStatus("ready");
      // Migrate any unqualified persisted model to ollama:<name>.
      const stored = lsGetString(STORAGE_KEY);
      const isPresent = (q: string) =>
        aggregate.some(
          (m) => makeQualifiedModel(m.providerId, m.modelId) === q,
        );
      // Migrate stale Claude Code model IDs to "default". Both dated IDs
      // (claude-opus-4-7 etc.) and aliases (sonnet/opus/haiku) can be
      // rejected by various CLI versions or subscription tiers, but
      // "default" — which skips the --model flag — always works.
      const migrateClaudeCode = (q: string): string => {
        if (!q.startsWith("claude-code:")) return q;
        const id = q.slice("claude-code:".length);
        if (
          id.startsWith("claude-opus") ||
          id.startsWith("claude-sonnet") ||
          id.startsWith("claude-haiku")
        ) {
          return "claude-code:default";
        }
        return q;
      };
      const migratedSelected = selected ? migrateClaudeCode(selected) : selected;
      if (migratedSelected !== selected) {
        setSelected(migratedSelected);
      }
      if (!migratedSelected || !isPresent(migratedSelected)) {
        let preferred: string | null = null;
        if (stored) {
          const qualified = parseQualifiedModel(stored)
            ? stored
            : makeQualifiedModel("ollama", stored);
          const migratedStored = migrateClaudeCode(qualified);
          if (isPresent(migratedStored)) preferred = migratedStored;
        }
        if (!preferred) {
          const first = aggregate[0];
          preferred = makeQualifiedModel(first.providerId, first.modelId);
        }
        setSelected(preferred);
      }
      return;
    }
    // No models anywhere.
    if (ollamaUp) {
      setStatus("no-models");
    } else {
      setStatus("missing");
    }
  };

  useEffect(() => {
    void refresh(true);
  }, []);

  // Auto-poll when Ollama isn't reachable or has no models so the
  // user doesn't have to keep clicking Refresh after installing.
  // Backs off aggressively — most Codetta users don't run Ollama
  // (they're on Claude Code or a cloud key), and a 4-second poll
  // floods their console with localhost:11434 ECONNREFUSED forever.
  // Strategy:
  //   - First 6 attempts: 4s interval (catches a fresh install)
  //   - Next 6 attempts: 30s interval
  //   - After that: stop entirely until the user clicks Refresh
  useEffect(() => {
    if (status === "ready" || status === "checking") return;
    if (isAnyPulling) return;
    let attempt = 0;
    let timer: number | undefined;
    const tick = () => {
      attempt++;
      void refresh(false);
      let next: number | null;
      if (attempt < 6) next = 4000;
      else if (attempt < 12) next = 30000;
      else next = null; // give up; user can click Refresh
      if (next != null) timer = window.setTimeout(tick, next);
    };
    timer = window.setTimeout(tick, 4000);
    return () => {
      if (timer != null) window.clearTimeout(timer);
    };
  }, [status, isAnyPulling]);

  // Expose workspace root globally so the Claude Code provider can spawn
  // its CLI subprocess with the right cwd. Stored via the typed
  // setWorkspaceRoot helper instead of an inline window cast so the
  // shape is declared in exactly one place.
  useEffect(() => {
    setWorkspaceRoot(root);
  }, [root]);

  // Refresh-resume: on mount, ask Rust if there's an in-flight (or
  // recently-completed-since-app-start) Claude Code stream for this
  // chat session id. If yes, replay every buffered event so the user
  // sees the partial assistant text + active tool calls exactly as they
  // were before the page reload, then subscribe to live events going
  // forward. Without this, a refresh during a long agentic turn would
  // strand the user with an apparently-frozen UI while the subprocess
  // kept running invisibly in the background.
  useEffect(() => {
    if (!sessionId) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    // Per-message flag: whether the in-flight assistant message has
    // had any text streamed via content_block_delta. Reset on
    // message_start; checked when the wrapping `assistant` event
    // arrives so we don't double-render the same text.
    let replayMsgGotDeltas = false;

    const replayLine = (line: { kind?: string; line?: string; code?: number }) => {
      if (line.kind === "end") {
        // Subprocess finished. Finalize: collect any accumulated streaming
        // text + active tool calls into a real assistant message so it
        // gets persisted. The next round will re-send a fresh system prompt.
        setStreaming((acc) => {
          const text = acc ?? "";
          if (text.length > 0) {
            const msg: ChatMessage = { role: "assistant", content: text };
            setMessages((m) => [...m, msg]);
          }
          return null;
        });
        setRunningTools(false);
        setActiveToolLabels([]);
        return;
      }
      if (line.kind === "stderr" && line.line) {
        setStreaming((acc) =>
          (acc ?? "") + `\n[claude] ${line.line}`,
        );
        return;
      }
      if (line.kind !== "line" || !line.line) return;
      try {
        const obj = JSON.parse(line.line);
        if (
          obj.type === "system" &&
          obj.subtype === "init" &&
          typeof obj.session_id === "string"
        ) {
          setClaudeSessionId(obj.session_id);
        }
        // Token-level deltas via --include-partial-messages. Append
        // each text_delta straight to streaming. The wrapping
        // `assistant` event still fires later with the complete
        // text; per-message flag (reset on message_start) lets us
        // skip the duplicate.
        if (obj.type === "stream_event" && obj.event) {
          const ev = obj.event;
          if (ev.type === "message_start") {
            replayMsgGotDeltas = false;
          } else if (
            ev.type === "content_block_delta" &&
            ev.delta?.type === "text_delta" &&
            typeof ev.delta.text === "string"
          ) {
            setStreaming((acc) => (acc ?? "") + ev.delta.text);
            replayMsgGotDeltas = true;
          }
        }
        if (obj.type === "assistant" && obj.message?.content) {
          const alreadyStreamed = replayMsgGotDeltas;
          replayMsgGotDeltas = false;
          for (const block of obj.message.content) {
            if (block.type === "text" && typeof block.text === "string") {
              if (alreadyStreamed) continue;
              setStreaming((acc) => (acc ?? "") + block.text);
            } else if (block.type === "tool_use") {
              const args =
                block.input && typeof block.input === "object"
                  ? (block.input as Record<string, unknown>)
                  : {};
              const name = typeof block.name === "string" ? block.name : "tool";
              const detail = toolDetailFor(name, args);
              let preview: string | undefined;
              if (name === "Edit" && typeof args.new_string === "string") {
                preview = args.new_string;
              } else if (name === "Write" && typeof args.content === "string") {
                preview = args.content;
              } else if (name === "Bash" && typeof args.command === "string") {
                preview = args.command;
              }
              const id = typeof block.id === "string" ? block.id : undefined;
              setActiveToolLabels((labels) => {
                const next = labels.slice(-9);
                next.push({
                  id,
                  name,
                  detail,
                  preview,
                  status: "running" as const,
                });
                return next;
              });
              setRunningTools(true);
            }
          }
        }
        // Tool results during resume — flip the matching label to done.
        if (obj.type === "user" && obj.message?.content) {
          for (const block of obj.message.content) {
            if (
              block.type === "tool_result" &&
              typeof block.tool_use_id === "string"
            ) {
              const id = block.tool_use_id;
              const isError = block.is_error === true;
              setActiveToolLabels((labels) =>
                labels.map((l) =>
                  l.id === id
                    ? { ...l, status: isError ? "error" : "done" }
                    : l,
                ),
              );
            }
          }
        }
      } catch {
        /* skip non-JSON */
      }
    };

    void invoke<{
      stream_id: string;
      lines: Array<{ kind?: string; line?: string; code?: number }>;
      ended: number | null;
    } | null>("claude_code_attach", { chatSessionId: sessionId })
      .then(async (att) => {
        if (cancelled || !att) return;
        // Replay everything we missed.
        for (const ln of att.lines) replayLine(ln);
        // ALWAYS subscribe for live events — even when att.ended is
        // set, there can be a brief race where the watchdog/wait
        // thread emits an "end" line right after we read the buffer
        // but before we'd have noticed. A live listener is harmless
        // when the channel is silent (no events ever fire) and
        // critical when the channel is still active.
        try {
          const u = await listen<{
            kind?: string;
            line?: string;
            code?: number;
          }>(`claude-stream:${att.stream_id}`, (e) => replayLine(e.payload));
          if (cancelled) {
            u();
            return;
          }
          unlisten = u;
        } catch (e) {
          console.warn("resume listen failed", e);
        }
      })
      .catch((e) => console.warn("resume attach failed", e));

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
    // We deliberately depend ONLY on sessionId (the chat-tab id), not on
    // the message list — re-running this effect after every assistant
    // message would re-replay buffered events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (selected) lsSetString(STORAGE_KEY, selected);
    // Mirror the selected model onto the chat descriptor so the AI
    // chats rail can render a per-chat provider badge without each rail
    // row mounting an AIChatPanel itself.
    if (selected && aiChatId) {
      useStore.getState().setAIChatModel(wsId, aiChatId, selected);
    }
    // Pre-warm Ollama models on selection so the first chat doesn't pay the
    // cold-start cost (often 20-60s for a 32B model).
    if (!selected) return;
    const parsed = parseQualifiedModel(selected);
    if (!parsed || parsed.providerId !== "ollama") return;
    setWarmingUp(true);
    void warmupOllamaModel(parsed.modelId).finally(() => {
      setWarmingUp(false);
    });
  }, [selected, aiChatId, wsId]);

  // Track whether user is parked at the bottom. We only auto-follow when
  // they were already at (or near) the bottom — otherwise we leave their
  // scroll position alone while they're reading earlier output.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickyBottomRef.current = remaining < 60;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (!stickyBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming, streamingBlocks, streamingToolCalls]);

  // Reset chat & restore appropriate session when workspace or bound
  // chat-tab changes.
  //
  // - With `aiChatId` set (tabbed mode): load THAT tab's stored sessionId
  //   from the workspace store. Each tab has its own conversation, so we
  //   must not fall back to "the most recent session in the workspace" —
  //   that would make every newly-opened tab show the same chat.
  // - Without `aiChatId` (singleton sidebar mode): keep the legacy
  //   behavior of restoring the most-recently-saved session.
  useEffect(() => {
    setInput("");
    const list = loadSessions(wsId);
    setSessions(list);

    if (aiChatId) {
      const desc = useStore.getState().loaded[wsId]?.aiChats[aiChatId];
      const targetSid = desc?.sessionId ?? newSessionId();
      const found = list.find((s) => s.id === targetSid);
      setSessionId(targetSid);
      // Restore the Claude Code session id alongside the conversation
      // so the next turn resumes server-side context. If the chat is
      // empty / non-CC, this stays undefined.
      setClaudeSessionId(found?.claudeSessionId);
      setChatTotalCost(found?.totalCostUsd ?? 0);
      setBudgetWarned(false);
      setScrubIndex(null);
      if (found) {
        setMessages(cleanStaleToolMessages(found.messages));
        if (found.model) {
          const q = parseQualifiedModel(found.model)
            ? found.model
            : makeQualifiedModel("ollama", found.model);
          setSelected((cur) => cur || q);
        }
      } else {
        setMessages([]);
      }
      return;
    }

    if (list.length > 0) {
      setSessionId(list[0].id);
      setClaudeSessionId(list[0].claudeSessionId);
      setChatTotalCost(list[0].totalCostUsd ?? 0);
      setBudgetWarned(false);
      setScrubIndex(null);
      // Filter out stale "Unknown tool: X" result messages from older
      // sessions where we incorrectly tried to execute the agentic
      // provider's tool calls on our side. They're meaningless garbage.
      setMessages(cleanStaleToolMessages(list[0].messages));
      if (list[0].model) {
        const q = parseQualifiedModel(list[0].model)
          ? list[0].model
          : makeQualifiedModel("ollama", list[0].model);
        setSelected((cur) => cur || q);
      }
    } else {
      setSessionId(newSessionId());
      setClaudeSessionId(undefined);
    setLastUsage(null);
    setTodos(null);
    setChatTotalCost(0);
    setBudgetWarned(false);
    setScrubIndex(null);
      setMessages([]);
    }
  }, [wsId, aiChatId]);

  // When sessionId changes inside a tabbed panel (e.g. via /new or the
  // history dropdown), persist it back to the descriptor so a reload
  // re-opens the same conversation.
  useEffect(() => {
    if (!aiChatId) return;
    useStore.getState().setAIChatSession(wsId, aiChatId, sessionId);
  }, [wsId, aiChatId, sessionId]);

  // Mirror the auto-derived chat title back to the tab label when in
  // tabbed mode. Cheap — only runs when messages or descriptor change.
  useEffect(() => {
    if (!aiChatId) return;
    if (messages.length === 0) return;
    const title = deriveTitle(messages);
    if (!title) return;
    const desc = useStore.getState().loaded[wsId]?.aiChats[aiChatId];
    if (!desc || desc.title === title) return;
    useStore.getState().setAIChatTitle(wsId, aiChatId, title);
  }, [wsId, aiChatId, messages]);

  // Persist session whenever messages change. Used to be debounced
  // 400ms but a refresh during that window orphaned the chat — the
  // descriptor still pointed to a sessionId whose saved row had only
  // the old messages, so restore looked broken. Save immediately
  // (writes are localStorage-cheap) AND register a beforeunload
  // hook to flush one last time on page close.
  useEffect(() => {
    if (messages.length === 0) return;
    const session: ChatSession = {
      id: sessionId,
      title: deriveTitle(messages),
      messages,
      model: selected,
      updatedAt: Date.now(),
      claudeSessionId,
      totalCostUsd: chatTotalCost > 0 ? chatTotalCost : undefined,
    };
    saveSession(wsId, session);
    setSessions(loadSessions(wsId));
  }, [messages, sessionId, wsId, selected, claudeSessionId, chatTotalCost]);

  // Last-resort flush: if the page is about to close (refresh, tab
  // close), write the current state synchronously even if a streaming
  // message hasn't fully accumulated. Captures partial assistant text
  // into a transient assistant message so refresh-resume has data to
  // re-attach to.
  useEffect(() => {
    if (!sessionId) return;
    const onBeforeUnload = () => {
      const assistantSoFar = streaming;
      const finalMessages =
        assistantSoFar !== null && assistantSoFar.trim().length > 0
          ? [
              ...messages,
              { role: "assistant" as const, content: assistantSoFar },
            ]
          : messages;
      if (finalMessages.length === 0) return;
      const session: ChatSession = {
        id: sessionId,
        title: deriveTitle(finalMessages),
        messages: finalMessages,
        model: selected,
        updatedAt: Date.now(),
        claudeSessionId,
        totalCostUsd: chatTotalCost > 0 ? chatTotalCost : undefined,
      };
      saveSession(wsId, session);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [
    messages,
    streaming,
    sessionId,
    wsId,
    selected,
    claudeSessionId,
    chatTotalCost,
  ]);

  // Queue of follow-up messages typed while a turn is in flight.
  // Drains automatically once the active turn finishes.
  const queueRef = useRef<string[]>([]);
  const [queueLen, setQueueLen] = useState(0);
  const drainQueue = useCallback(async () => {
    while (queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      setQueueLen(queueRef.current.length);
      if (!next) continue;
      // Re-check running state — user may have hit Stop, in which
      // case we drop the queue.
      if (abortRef.current?.signal.aborted) {
        queueRef.current = [];
        setQueueLen(0);
        return;
      }
      await sendUserText(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    if (streaming !== null || runningTools) {
      // Active turn — queue this message instead of dropping it.
      queueRef.current.push(text);
      setQueueLen(queueRef.current.length);
      toastInfo(`Queued (${queueRef.current.length} pending)`);
      return;
    }
    await sendUserText(text);
  };

  const sendUserText = async (
    text: string,
    baseMessages: ChatMessage[] = messages,
  ) => {
    if (!text || !selected) return;
    if (streaming !== null || runningTools) {
      // Defensive: caller shouldn't get here, but if they do, queue
      // rather than drop.
      queueRef.current.push(text);
      setQueueLen(queueRef.current.length);
      return;
    }

    // Cross-chat hard-cap check. Per-workspace budget takes precedence
    // (if one is set on this workspace), then the global cap. The
    // permission overlay's privacy gate runs separately.
    const cap = wouldExceedHardCap(0, wsId);
    if (cap.exceeds) {
      const scope =
        cap.scope === "workspace"
          ? "Workspace AI cap"
          : "Monthly AI hard cap";
      toastError(
        `🛑 ${scope} reached: $${cap.current.toFixed(2)} / $${cap.cap.toFixed(2)}. Raise it in Settings → AI Usage Dashboard to send.`,
      );
      return;
    }

    // Compose context: active file path + (when reasonable) its content.
    const ws = useStore.getState().loaded[wsId];
    const ap = ws?.layout.activePaneId
      ? findPaneById(ws.layout.editorRoot, ws.layout.activePaneId)
      : null;
    const activeKey = ap && ap.kind === "tabs" ? ap.active : null;
    const parsed = activeKey ? parseKey(activeKey) : null;
    const sysParts: string[] = [
      [
        "You are a coding agent embedded in Codetta, a desktop code editor.",
        "The user has a workspace open and you are running with the workspace root as the current working directory.",
        "",
        "OPERATING PRINCIPLES",
        "- Investigate before answering. Ground every claim in real code — never guess at file paths, function names, or APIs.",
        "- Read enough context to be useful. For non-trivial questions read 5+ relevant files before responding; for quick questions one file is fine.",
        "- Run tools in parallel whenever they're independent (multiple reads, multiple greps in one turn).",
        "- When changing code, keep edits minimal and focused on what the user asked. Don't refactor surrounding code, don't add speculative features, don't invent new abstractions.",
        "- Default to no comments. Add a comment only when WHY is non-obvious.",
        "- If something isn't in the codebase or you don't know it, say so — don't fabricate.",
        "",
        "COMMUNICATION",
        "- Reply in concise prose with markdown formatting. Reference files using `path:line` format so they're clickable.",
        "- Match response length to the question: a one-line question gets a one-line answer, not headers and sections.",
        "- For multi-step work, give brief progress updates between tool batches.",
        "- End with what changed and what's next, in 1-2 sentences. Skip long recaps.",
        "",
        "SAFETY",
        "- Confirm before destructive actions (rm, dropping branches, force-push, deleting data).",
        "- Don't push, deploy, or send messages to external systems without explicit user approval.",
      ].join("\n"),
    ];
    // Auto-attach the project tree when:
    //   1. The user explicitly typed /tree (attachTree flag), OR
    //   2. This is the first message of a new chat (so the model gets oriented), OR
    //   3. The user's text mentions the codebase/project at a high level.
    const isFirstMessage = baseMessages.length === 0;
    const codebaseRegex =
      /\b(codebase|project|repo|repository|files?|folders?|directories|directory|structure|architecture|layout)\b/i;
    const mentionsCodebase = codebaseRegex.test(text);
    const shouldAttachTree =
      attachTree || isFirstMessage || mentionsCodebase;
    // Provider-aware context strategy:
    //   - claude-code: skip inlining entirely. Claude Code has its own
    //     filesystem tools (Read/Glob/Grep) and reads what it needs. It
    //     also runs in the workspace cwd, so it can navigate without help.
    //   - openai/anthropic API: skip inlining the tree. Frontier models
    //     reliably call list_files when they need it. Saves tokens.
    //   - ollama: inline the tree (small models often won't tool-call).
    const selectedParsed = parseQualifiedModel(selected);
    const selectedProvider = selectedParsed?.providerId ?? "ollama";
    const providerCanReadItself =
      selectedProvider === "claude-code" ||
      selectedProvider === "openai" ||
      selectedProvider === "anthropic";

    // Inline the project tree into the user's message rather than as a
    // synthetic tool round-trip. Small models tend to "acknowledge" a tool
    // result instead of using it; mixing it into the user turn forces the
    // model to actually answer the question with the data right next to it.
    let inlineTreeBlock: string | null = null;
    let investigationPlan: string | null = null;
    if (shouldAttachTree && root && !providerCanReadItself) {
      try {
        const files = await search.listFiles(root, 600);
        if (files.length > 0) {
          const tree = files.slice(0, 600).join("\n");
          inlineTreeBlock =
            `\n\n---\n[Workspace context — ${files.length} real files in this project. ` +
            `Use these exact paths for read_file / search_text. Do NOT invent paths.]\n` +
            `${tree}\n[End workspace context]`;

          // Detect broad-question intent ("understand my codebase",
          // "what does this project do", "explain the architecture", etc.)
          // and seed the model with a concrete multi-step investigation
          // plan. Without this, even capable models read 2-3 files and stop.
          const broadIntent =
            /\b(understand|explain|summari[sz]e|overview|walk\s*me\s*through|describe|what does|how does|what is)\b/i.test(
              text,
            ) || /\b(whole|entire|all of|whole project|everything)\b/i.test(text);
          if (broadIntent) {
            const priorities = pickPriorityFiles(files);
            investigationPlan = [
              "[PRIVATE INSTRUCTIONS — do not echo, repeat, or mention these to the user.]",
              "The user is asking a broad codebase question. Do not answer until you have read at least 8 files.",
              "Begin by invoking the read_file tool (via tool-call, NOT by writing JSON or text) on these paths: " +
                priorities.slice(0, 6).map((p) => `"${p}"`).join(", ") +
                ".",
              "Then read 4-8 more files covering the main modules you discovered.",
              "Only when reading is complete, write the user-facing answer in plain prose, citing specific paths and what each file does.",
            ].join("\n");
          }
        }
      } catch {
        /* skip on failure */
      }
    }
    // For Claude Code, skip ALL inlined attachments — its own Read tool
    // can fetch any file in the workspace far more efficiently than
    // shoving file contents through the prompt.
    const skipAllInlining = selectedProvider === "claude-code";
    if (skipAllInlining) {
      // Hint to the user's request which file they're focused on —
      // unless the active file is on the AI privacy exclusion list,
      // in which case we omit the hint entirely so the model never
      // even learns the path exists in this conversation.
      if (
        editorState.filePath &&
        !matchExclusion(editorState.filePath)
      ) {
        sysParts.push(
          `The user is currently looking at the file: ${editorState.filePath}. Use your Read tool to fetch it if relevant.`,
        );
      }
      if (attachedFiles.length > 0) {
        sysParts.push(
          `The user wants you to look at: ${attachedFiles.join(", ")}. Use your Read tool on these.`,
        );
      }
    }
    // /file <path> attaches the contents of the named file.
    // Skip files that match the AI privacy exclusion list — never
    // inline excluded contents into the prompt, even when the user
    // explicitly typed /file (defence-in-depth: a typo or muscle-
    // memory shouldn't leak secrets).
    for (const filePath of skipAllInlining ? [] : attachedFiles) {
      try {
        const abs =
          filePath.includes(":") || filePath.startsWith("/")
            ? filePath
            : `${root}/${filePath}`.replace(/\\/g, "/");
        const matched = matchExclusion(abs);
        if (matched) {
          toastError(
            `🛡 Skipped ${filePath} — matches privacy exclusion "${matched}"`,
          );
          continue;
        }
        const content = await fs.readFile(abs);
        const trimmed =
          content.length > 12000
            ? content.slice(0, 12000) + "\n…[truncated]"
            : content;
        sysParts.push(`Contents of ${filePath}:\n\`\`\`\n${trimmed}\n\`\`\``);
      } catch {
        /* skip files that don't exist */
      }
    }
    // /terminal attaches the active terminal's recent output.
    if (attachTerminal && !skipAllInlining) {
      const wsLatest = useStore.getState().loaded[wsId];
      const terms = wsLatest ? Object.values(wsLatest.terminals) : [];
      const t = terms[terms.length - 1];
      if (t?.ptyId) {
        try {
          const buf = await pty.getBuffer(t.ptyId);
          const trimmed = buf.length > 8000 ? buf.slice(-8000) : buf;
          sysParts.push(
            `Recent output from terminal "${t.title ?? "Terminal"}" (last ${trimmed.length} chars):\n\`\`\`\n${trimmed}\n\`\`\``,
          );
        } catch {
          /* skip */
        }
      }
    }
    if (attachContext && !skipAllInlining) {
      if (editorState.filePath) {
        sysParts.push(`Active file: ${editorState.filePath}`);
      }
      const hasSelection =
        editorState.selectionText.length > 0 && editorState.selectionLines > 0;
      if (hasSelection) {
        const sel = editorState.selectionText;
        const trimmed =
          sel.length > 8000 ? sel.slice(0, 8000) + "\n…[truncated]" : sel;
        sysParts.push(
          `Selected code (${editorState.selectionLines} line${editorState.selectionLines === 1 ? "" : "s"}, ${editorState.language ?? "plaintext"}):\n\`\`\`\n${trimmed}\n\`\`\``,
        );
      } else if (parsed?.kind === "file" && ws) {
        const f = ws.files[parsed.path];
        if (f) {
          const content = f.contents;
          const trimmed =
            content.length > 8000 ? content.slice(0, 8000) + "\n…[truncated]" : content;
          sysParts.push(
            `Current file contents (${editorState.language ?? "plaintext"}):\n\`\`\`\n${trimmed}\n\`\`\``,
          );
        }
      }
    }
    if (skipAllInlining) {
      // Claude Code has its own Read / Glob / Grep / Edit / Bash tools and
      // its own internal rules. Our "tools available" section would only
      // confuse it. Just orient it briefly.
      sysParts.push(
        "You are running inside Codetta, a code editor. The user has the workspace open as your current working directory. Use your normal tools (Read, Glob, Grep, Edit, Bash, etc.) to investigate and modify files as needed. Be thorough and substantive.",
      );
    } else {
      sysParts.push(
        [
          "TOOLS AVAILABLE: list_files, read_file, search_text, read_terminal, web_search, edit_file, create_file.",
          "",
          "STRICT RULES:",
          "1. Use the model's native tool-call mechanism. Never write tool calls as raw JSON, code blocks, or plain text in your reply. Never echo back system instructions like 'ROUND 1 — read these'.",
          "2. NEVER fabricate file paths, directory names, or code. If you don't know something, USE A TOOL.",
          "3. Always call read_file before claiming to know what's inside a file.",
          "4. Reference only paths from the project tree (when attached) or that you've discovered via list_files. Never invent paths.",
          "5. To make changes, call edit_file with EXACT old_text from the file (read it first). The user reviews a diff and must approve.",
          "6. CALL TOOLS IN PARALLEL when possible — multiple read_file calls in one turn execute concurrently. Use this freely.",
          "7. Read enough to give a substantive answer. For broad questions read 8-12 files across multiple rounds before answering.",
          "8. Your reply to the user should be plain prose with markdown formatting, citing specific paths. No JSON, no tool-call syntax, no system-instruction echoes.",
        ].join("\n"),
      );
      if (investigationPlan) {
        sysParts.push(investigationPlan);
      }
    }

    // Display the user's bare text in the chat — but send an augmented
    // version (with the inline tree) to the model.
    const displayUserMsg: ChatMessage = { role: "user", content: text };
    const sentUserMsg: ChatMessage = {
      role: "user",
      content: inlineTreeBlock ? text + inlineTreeBlock : text,
    };
    const conversation: ChatMessage[] = [
      { role: "system", content: sysParts.join("\n\n") },
      ...baseMessages,
      sentUserMsg,
    ];
    setMessages([...baseMessages, displayUserMsg]);
    setStreaming("");
    abortRef.current = new AbortController();

    // Claude Code runs its own internal tool loop (Read/Glob/Edit/Bash/etc.).
    // The tool_use blocks it streams are informational — they show what it
    // ALREADY did, not requests for us to execute. So for that provider we
    // skip our N-round tool-execution loop and just stream once.
    const isAgenticProvider = selectedProvider === "claude-code";
    const MAX_ROUNDS = isAgenticProvider ? 1 : 8;

    // Snapshot every open buffer's contents BEFORE the turn fires so
    // the ComposeCard's "Revert all" button can roll back changes if
    // the user doesn't like them. Keyed by the index where the next
    // assistant message will land (= current messages length, since
    // we just pushed the user message).
    if (isAgenticProvider) {
      const wsState = useStore.getState().loaded[wsId];
      if (wsState?.files) {
        // Pending assistant message lands at baseMessages.length + 1
        // (user msg pushed in this turn + assistant about to land).
        captureSnapshot(
          wsId,
          aiChatId,
          baseMessages.length + 1,
          wsState.files,
        );
      }
    }
    try {
      const knownToolNames = new Set(TOOLS.map((t) => t.function.name));
      for (let round = 0; round < MAX_ROUNDS; round++) {
        let acc = "";
        const toolCallsThisRound: ToolCall[] = [];
        // Ordered chronological log of "what arrived when," used by
        // the renderer to show text → tool → text → tool in real
        // sequence instead of the legacy "all text first, all tools
        // second." Text deltas merge with the previous text block
        // when adjacent so 200 deltas don't become 200 markdown
        // bubbles.
        const blocksThisRound: NonNullable<ChatMessage["blocks"]> = [];
        const appendTextBlock = (text: string) => {
          if (!text) return;
          const last = blocksThisRound[blocksThisRound.length - 1];
          if (last && last.kind === "text") {
            last.text += text;
          } else {
            blocksThisRound.push({ kind: "text", text });
          }
          // Mirror to React state so the live bubble re-renders.
          setStreamingBlocks([...blocksThisRound]);
        };
        // Tool results emitted by an agentic provider (Claude Code) for
        // calls it executed itself. Paired with toolCallsThisRound by
        // tool_use_id at the end of the round and attached to the
        // assistant message so the chat UI can render them.
        const toolResultsThisRound: Array<{
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        }> = [];
        let firstTokenAt: number | null = null;
        const startedAt = performance.now();
        // Reset on each new round so the "still working" timer doesn't
        // anchor to a previous turn.
        setLastStreamEventAt(Date.now());
        for await (const ev of chatStream(
          selected,
          conversation,
          abortRef.current.signal,
          TOOLS,
          // Only pass resumeSessionId when we're on Claude Code AND we
          // already have one captured from a prior turn in this chat.
          // Other providers ignore this param.
          selectedProvider === "claude-code" ? claudeSessionId : undefined,
          // chatSessionId tags the in-flight stream in the Rust buffer
          // so a frontend refresh can re-attach via attachToChat().
          selectedProvider === "claude-code" ? sessionId : undefined,
        )) {
          // Any event from the provider is a sign of life — reset the
          // staleness timer so the "still working" badge only fires
          // when the stream really has gone quiet for a while.
          setLastStreamEventAt(Date.now());
          if (ev.kind === "session") {
            // Captured the Claude Code session id — store it so the next
            // turn passes --resume <id> and avoids re-flattening history.
            setClaudeSessionId(ev.id);
            continue;
          }
          if (ev.kind === "usage") {
            setLastUsage({
              cost: ev.cost,
              durationMs: ev.durationMs,
              model: ev.model,
              tokens: ev.tokens,
            });
            // Append to the cross-chat usage log so the dashboard +
            // monthly hard cap have data to work with. Skipped if
            // the turn was free (Ollama, subscription Claude Code).
            // The prompt itself is only persisted when the user has
            // opted in via Settings → AI Usage → "Log prompt text".
            recordUsage({
              provider: selectedProvider,
              model: ev.model ?? selected,
              costUsd: typeof ev.cost === "number" ? ev.cost : 0,
              tokensIn:
                (ev.tokens?.input ?? 0) + (ev.tokens?.cacheRead ?? 0),
              tokensOut: ev.tokens?.output ?? 0,
              wsId,
              chatId: aiChatId,
              prompt: text,
            });
            // Roll into the per-chat running total. Triggers a
            // budget-warning toast the first time we cross the
            // user's configured threshold (resets per chat).
            if (typeof ev.cost === "number" && ev.cost > 0) {
              setChatTotalCost((prev) => {
                const next = prev + ev.cost!;
                const budget = readBudgetUsd();
                if (
                  budget > 0 &&
                  prev < budget &&
                  next >= budget &&
                  !budgetWarned
                ) {
                  setBudgetWarned(true);
                  toastError(
                    `Chat budget reached: $${next.toFixed(4)} / $${budget.toFixed(2)}. Future turns will keep adding cost — start a new chat or stop to cap spend.`,
                  );
                }
                return next;
              });
            }
            continue;
          }
          if (ev.kind === "content") {
            // Empty content events are keep-alive pings (e.g. extended-
            // thinking deltas in the Claude Code provider). They keep
            // the staleness watchdog at the top of the loop fed but
            // don't represent visible tokens — skip the rest of the
            // accounting so they don't anchor firstTokenAt to the
            // wrong moment and tank the t/s display.
            if (ev.text.length === 0) continue;
            if (firstTokenAt === null) {
              firstTokenAt = performance.now();
            }
            acc += ev.text;
            appendTextBlock(ev.text);
            setStreaming(acc);
            // Approximate tokens/sec: ~4 chars per token on average.
            const elapsedSec = (performance.now() - firstTokenAt) / 1000;
            if (elapsedSec > 0.5) {
              setTokensPerSec(acc.length / 4 / elapsedSec);
            }
          } else if (ev.kind === "tool_call") {
            toolCallsThisRound.push(ev.call);
            setStreamingToolCalls([...toolCallsThisRound]);
            if (ev.call.id) {
              blocksThisRound.push({ kind: "tool_call", callId: ev.call.id });
              setStreamingBlocks([...blocksThisRound]);
            }
            // Snapshot TodoWrite into the sticky checklist state so the
            // user gets a live planning view as the agent progresses.
            if (
              ev.call.function.name === "TodoWrite" &&
              Array.isArray(ev.call.function.arguments.todos)
            ) {
              const raw = ev.call.function.arguments.todos as unknown[];
              const cleaned = raw
                .filter(
                  (t): t is Record<string, unknown> =>
                    !!t && typeof t === "object",
                )
                .map((t) => ({
                  content:
                    typeof t.content === "string" ? t.content : "(untitled)",
                  status:
                    t.status === "in_progress" || t.status === "completed"
                      ? (t.status as "in_progress" | "completed")
                      : ("pending" as const),
                  activeForm:
                    typeof t.activeForm === "string" ? t.activeForm : undefined,
                }));
              setTodos(cleaned);
            }
            // Live-surface the tool call in the status strip so the user
            // sees what's happening during long agentic streams (Claude
            // Code may emit many tool_use blocks before any text content).
            const args = ev.call.function.arguments;
            const name = ev.call.function.name;
            const detail = toolDetailFor(name, args);
            // Preview: short snippet of the change so the user sees what's
            // landing without scrolling. For Edit/MultiEdit show the new
            // text, for Write show the content, for Bash echo the command.
            let preview: string | undefined;
            if (name === "Edit" && typeof args.new_string === "string") {
              preview = args.new_string;
            } else if (
              name === "MultiEdit" &&
              Array.isArray(args.edits) &&
              args.edits.length > 0
            ) {
              const first = args.edits[0] as Record<string, unknown>;
              if (typeof first.new_string === "string") preview = first.new_string;
            } else if (name === "Write" && typeof args.content === "string") {
              preview = args.content;
            } else if (name === "Bash" && typeof args.command === "string") {
              preview = args.command;
            }
            const entry = {
              id: ev.call.id,
              name,
              detail,
              preview,
              status: "running" as const,
            };
            setActiveToolLabels((labels) => {
              const next = labels.slice(-9);
              next.push(entry);
              return next;
            });
            setRunningTools(true);
          } else if (ev.kind === "tool_result") {
            // Agentic providers (Claude Code) ran the tool themselves
            // and report the result. Flip the matching activeToolLabels
            // entry to "done" so the user can see WHICH calls actually
            // finished (was a misleading 10-spinners-forever otherwise).
            setActiveToolLabels((labels) =>
              labels.map((l) =>
                l.id && l.id === ev.tool_use_id
                  ? { ...l, status: ev.is_error ? "error" : "done" }
                  : l,
              ),
            );
            // Stash for attachment to the assistant message at end of round.
            toolResultsThisRound.push({
              tool_use_id: ev.tool_use_id,
              content: ev.content,
              is_error: ev.is_error,
            });
            setStreamingToolResults([...toolResultsThisRound]);
          }
        }
        // Record final speed for the slow-model banner heuristic.
        if (firstTokenAt !== null) {
          const elapsedSec = (performance.now() - firstTokenAt) / 1000;
          if (elapsedSec > 1 && acc.length > 40) {
            const tps = acc.length / 4 / elapsedSec;
            setRecentTps((prev) =>
              prev === null ? tps : prev * 0.5 + tps * 0.5,
            );
          }
        }
        void startedAt;
        // Fallback: some models emit tool calls as JSON inside the content
        // stream instead of using Ollama's native tool_calls field. Detect
        // and lift them out before showing the message to the user.
        let visibleContent = acc;
        if (toolCallsThisRound.length === 0 && acc.includes("{")) {
          const parsed = parseInlineToolCalls(acc, knownToolNames);
          if (parsed.calls.length > 0) {
            toolCallsThisRound.push(...parsed.calls);
            visibleContent = parsed.remaining;
          }
        }
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: visibleContent,
          tool_calls:
            toolCallsThisRound.length > 0 ? toolCallsThisRound : undefined,
          tool_results:
            toolResultsThisRound.length > 0
              ? toolResultsThisRound
              : undefined,
          // Persist the chronological log if we collected one this
          // round. Renderer prefers this over content+tool_calls when
          // present (for new messages); old saved sessions without
          // blocks fall back to the legacy combined render.
          blocks: blocksThisRound.length > 0 ? blocksThisRound : undefined,
        };
        conversation.push(assistantMsg);
        setMessages((m) => [...m, assistantMsg]);
        setStreaming(null);
        setStreamingBlocks([]);
        setStreamingToolCalls([]);
        setStreamingToolResults([]);
        setRunningTools(false);
        setActiveToolLabels([]);

        if (toolCallsThisRound.length === 0) break;
        if (abortRef.current?.signal.aborted) break;
        // Agentic providers (Claude Code) ran their own internal tool loop
        // while streaming — the tool_use blocks we collected are display-
        // only. Don't try to "execute" them on our side; just end here.
        if (isAgenticProvider) break;

        // Run independent reads in parallel; serialize writes so their
        // confirm dialogs don't all fire at once.
        const WRITE_TOOLS = new Set(["edit_file", "create_file"]);
        const reads = toolCallsThisRound.filter(
          (c) => !WRITE_TOOLS.has(c.function.name),
        );
        const writes = toolCallsThisRound.filter((c) =>
          WRITE_TOOLS.has(c.function.name),
        );

        setRunningTools(true);
        setActiveToolLabels(
          toolCallsThisRound.map((c) => {
            const args = c.function.arguments;
            const detail = toolDetailFor(c.function.name, args);
            let preview: string | undefined;
            if (c.function.name === "edit_file" && typeof args.new_text === "string") {
              preview = args.new_text;
            } else if (c.function.name === "create_file" && typeof args.content === "string") {
              preview = args.content;
            }
            return {
              id: c.id,
              name: c.function.name,
              detail,
              preview,
              status: "running" as const,
            };
          }),
        );
        const finishToolCall = (call: ToolCall, result: string) => {
          // Mark this label as done so the UI flips its spinner to a
          // checkmark (only really matters for parallel reads where
          // some finish before others; sequential writes look the
          // same either way).
          setActiveToolLabels((labels) =>
            labels.map((l) =>
              l.id && l.id === call.id ? { ...l, status: "done" as const } : l,
            ),
          );
          const trimmed =
            result.length > 16000
              ? result.slice(0, 16000) + "\n…[truncated]"
              : result;
          const toolMsg: ChatMessage = {
            role: "tool",
            content: trimmed,
            tool_call_id: call.id,
          };
          conversation.push(toolMsg);
          setMessages((m) => [...m, toolMsg]);
        };

        const runWithPermission = async (call: ToolCall): Promise<string> => {
          const perm = permissionFor(call.function.name, call.function.arguments);
          if (perm === "deny") {
            return `User has disabled the ${call.function.name} tool in Settings → Tool Permissions.`;
          }
          if (perm === "ask") {
            // Render an inline permission card in the chat and await the
            // user's decision. The card's buttons may also persist a
            // remember-this rule (via rememberToolAlways / rememberToolPath
            // before resolving), so the next call gets "allow" instantly.
            const decision = await new Promise<"allow" | "deny">((resolve) => {
              setPendingPermission({ call, resolve });
            });
            setPendingPermission(null);
            if (decision !== "allow") {
              return `User denied permission for ${call.function.name}.`;
            }
          }
          return executeTool(call, { wsId, root });
        };

        // Parallel reads (each may hit an Ask dialog, queued in series via
        // the dialog manager — the API allows concurrent Promise dispatch).
        const readResults = await Promise.all(reads.map(runWithPermission));
        for (let i = 0; i < reads.length; i++) {
          finishToolCall(reads[i], readResults[i]);
        }

        if (abortRef.current?.signal.aborted) {
          setRunningTools(false);
          break;
        }

        // Sequential writes (each shows a confirm dialog inside executeTool too).
        for (const call of writes) {
          if (abortRef.current?.signal.aborted) break;
          const result = await runWithPermission(call);
          finishToolCall(call, result);
        }
        setRunningTools(false);
        setActiveToolLabels([]);

        if (abortRef.current?.signal.aborted) break;
        // Restart streaming UI for the next round.
        setStreaming("");
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        toastError(`Chat failed: ${errMsg(e)}`);
      }
    } finally {
      setStreaming(null);
      setStreamingBlocks([]);
      setStreamingToolCalls([]);
      setStreamingToolResults([]);
      setRunningTools(false);
      setActiveToolLabels([]);
      setTokensPerSec(null);
      setLastStreamEventAt(null);
      // If a permission card was awaiting a decision when the turn
      // aborted, resolve it as deny so the parent promise unblocks
      // and clear the card so the user doesn't see a stale prompt
      // for a tool call that's no longer in flight.
      setPendingPermission((cur) => {
        if (cur) {
          try {
            cur.resolve("deny");
          } catch {
            /* ignore */
          }
        }
        return null;
      });
      abortRef.current = null;
      // One-shot attach flags reset after the message goes out.
      setAttachTree(false);
      setAttachedFiles([]);
      setAttachTerminal(false);
      // Drain any messages the user typed while this turn was in
      // flight. Fires after a microtask so the React state from the
      // finally block has settled.
      if (queueRef.current.length > 0) {
        setTimeout(() => void drainQueue(), 0);
      }
    }
  };

  const stop = () => {
    // Stop also clears the queue — Stop should mean "I want to
    // change direction now," not "process my queued follow-ups
    // anyway with whatever the agent half-finished."
    queueRef.current = [];
    setQueueLen(0);
    abortRef.current?.abort();
  };

  // Make the "Stop (Esc)" tooltip honest — Esc previously only worked
  // when the chat textarea was focused, so a user reading the streamed
  // output (focus on chat scroll area) couldn't actually use the
  // documented shortcut. Now a window-level listener fires when the
  // turn is in flight AND the user isn't typing in some other input
  // elsewhere in the app (don't steal Esc from the file dialog, the
  // settings modal, etc.). The textarea-bound handler still wins
  // when its own slash-menu / attachment paths apply.
  useEffect(() => {
    if (streaming === null && !runningTools) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      // Skip if focus is in OUR chat input — its onKeyDown owns Esc
      // there (slash-menu close, etc.). Also skip text fields in
      // unrelated overlays (settings, dialog) so we don't steal.
      if (t) {
        if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") return;
        if (t.isContentEditable) return;
      }
      e.preventDefault();
      stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [streaming, runningTools]);

  const regenerateFrom = async (index: number) => {
    if (streaming !== null || runningTools) return;
    const target = messages[index];
    if (!target || target.role !== "user") return;
    // Wipe this message + everything after, then re-send with the same text.
    const truncated = messages.slice(0, index);
    setMessages(truncated);
    setExpandedMsgIdx(new Set());
    // Force a fresh Claude Code session — the existing CC session has
    // turns we just truncated, so resuming it would feed the model
    // context the user explicitly wiped. Next turn will get a new id.
    setClaudeSessionId(undefined);
    setLastUsage(null);
    setTodos(null);
    setChatTotalCost(0);
    setBudgetWarned(false);
    setScrubIndex(null);
    await sendUserText(target.content, truncated);
  };

  const branchFromHere = (index: number) => {
    if (streaming !== null || runningTools) return;
    const target = messages[index];
    if (!target || target.role !== "user") return;
    // Keep the prefix up THROUGH this user message (inclusive). The
    // user can then edit the prompt or just hit send to retry.
    // No assistant turn after — the new chat is queued at the user's
    // message ready for them to send.
    const prefix = messages.slice(0, index + 1);
    // Open a new tab — addAIChat auto-assigns desc.sessionId = chat
    // id. Save the branched session under THAT same id so the new
    // panel's mount effect finds it on first load. Using a fresh
    // newSessionId() and re-binding via setAIChatSession would race
    // the panel mount: the load effect only re-runs on aiChatId
    // change, so it'd pick up the old (auto-assigned) id and find
    // nothing. The new tab would then open empty.
    const newChatId = useStore.getState().addAIChat(wsId, "editor");
    const branchedSession: ChatSession = {
      id: newChatId,
      title: deriveTitle(prefix) + " (branch)",
      messages: prefix,
      model: selected,
      updatedAt: Date.now(),
      // No claudeSessionId — branching forks the conversation, so
      // we want a fresh Claude Code session not a resumed one.
    };
    saveSession(wsId, branchedSession);
    toastInfo(
      "Branched into a new chat tab — the original is untouched",
    );
  };

  const goDeeper = async () => {
    if (streaming !== null || runningTools) return;
    if (messages.length === 0) return;
    await sendUserText(
      "Go deeper. Read more files (5+ more) and expand your answer with concrete details: specific file paths, what each module does, how data flows, and any concerns or improvements you'd suggest. Reference exact paths and code patterns you observe.",
      messages,
    );
  };

  const startNewChat = () => {
    if (streaming !== null) return;
    setSessionId(newSessionId());
    // Forget the prior Claude Code session so the next turn spawns a
    // fresh server-side session instead of resuming an unrelated one.
    setClaudeSessionId(undefined);
    setLastUsage(null);
    setTodos(null);
    setChatTotalCost(0);
    setBudgetWarned(false);
    setScrubIndex(null);
    setMessages([]);
    setInput("");
    setHistoryOpen(false);
  };

  const openSession = (id: string) => {
    if (streaming !== null) return;
    const list = loadSessions(wsId);
    const s = list.find((x) => x.id === id);
    if (!s) return;
    setSessionId(s.id);
    // Restore the Claude Code session id alongside the conversation so
    // resuming this chat picks up the server-side context where it left
    // off. If the chat predates this feature it'll be undefined and the
    // first turn will start a fresh CC session — the next stream-init
    // event will populate it.
    setClaudeSessionId(s.claudeSessionId);
    // Reset transient last-turn telemetry. The cumulative cost IS
    // persisted across reloads, so restore it from the session — the
    // running total in the footer should reflect the chat's full
    // history of spend, not reset to 0.
    setLastUsage(null);
    setTodos(null);
    setChatTotalCost(s.totalCostUsd ?? 0);
    // Also reset the budget-warning latch so a fresh load can warn
    // again if the user has already crossed.
    setBudgetWarned(false);
    setScrubIndex(null);
    setMessages(s.messages);
    setInput("");
    setHistoryOpen(false);
    if (s.model) setSelected((cur) => cur || s.model);
  };

  const runInActiveTerminal = async (text: string) => {
    const wsLatest = useStore.getState().loaded[wsId];
    const terms = wsLatest ? Object.values(wsLatest.terminals) : [];
    const t = terms[terms.length - 1];
    if (!t?.ptyId) {
      toastError("No active terminal — open one first");
      return;
    }
    try {
      // Strip leading "$" or ">" prompts the model often adds.
      const cleaned = text
        .split("\n")
        .map((l) => l.replace(/^[$>]\s*/, ""))
        .join("\n");
      // Send each non-empty line followed by Enter.
      for (const line of cleaned.split("\n")) {
        if (line.trim().length === 0) continue;
        await pty.write(t.ptyId, line + "\r");
      }
      toastSuccess(`Sent to terminal "${t.title ?? "Terminal"}"`);
    } catch (e) {
      toastError(`Failed to send to terminal: ${errMsg(e)}`);
    }
  };

  const runSlashCommand = (cmd: SlashCommand) => {
    if (cmd.action === "new") {
      startNewChat();
      return;
    }
    if (cmd.action === "clear") {
      setMessages([]);
      // Wipe Claude Code session context too — /clear means "forget what
      // we were talking about", and resuming an old CC session would
      // contradict that even if the local message list is empty.
      setClaudeSessionId(undefined);
    setLastUsage(null);
    setTodos(null);
    setChatTotalCost(0);
    setBudgetWarned(false);
    setScrubIndex(null);
      setInput("");
      return;
    }
    if (cmd.action === "tree") {
      setAttachTree(true);
      setInput("");
      toastInfo("Project tree will attach to your next message");
      return;
    }
    if (cmd.action === "terminal") {
      setAttachTerminal(true);
      setInput("");
      toastInfo("Active terminal output will attach to your next message");
      return;
    }
    if (cmd.action === "file") {
      // Parse trailing path from current input ("/file src/foo.ts" -> "src/foo.ts")
      const rest = input.replace(/^\/file\s*/i, "").trim();
      if (!rest) {
        // Don't have a path yet — just complete the command and wait for the user.
        setInput("/file ");
        return;
      }
      setAttachedFiles((prev) =>
        prev.includes(rest) ? prev : [...prev, rest],
      );
      setInput("");
      toastInfo(`Attached ${rest} to next message`);
      return;
    }
    if (cmd.prompt) {
      setInput(cmd.prompt);
      setSlashIndex(0);
    }
  };

  const removeSession = async (id: string) => {
    const list = loadSessions(wsId);
    const s = list.find((x) => x.id === id);
    if (!s) return;
    const ok = await dialogConfirm(
      `Delete chat "${s.title}"?`,
      { title: "Delete chat", okLabel: "Delete", danger: true },
    );
    if (!ok) return;
    deleteSession(wsId, id);
    setSessions(loadSessions(wsId));
    if (id === sessionId) {
      // Active chat deleted — start a new one.
      setSessionId(newSessionId());
      setMessages([]);
    }
  };

  const pullSpecific = async (name: string) => {
    if (!name) return;
    // Already pulling this same model? No-op.
    if (pullProgressMap[name]) return;
    setPullProgressMap((m) => ({ ...m, [name]: `Pulling ${name}…` }));
    try {
      for await (const ev of pullStream(name)) {
        const pct =
          ev.total && ev.completed
            ? Math.round((ev.completed / ev.total) * 100)
            : null;
        const line =
          pct != null
            ? `${name} — ${ev.status} (${pct}%)`
            : `${name} — ${ev.status}`;
        setPullProgressMap((m) => ({ ...m, [name]: line }));
      }
      toastSuccess(`Pulled ${name}`);
      await refresh();
    } catch (e) {
      toastError(`Pull failed: ${errMsg(e)}`);
    } finally {
      setPullProgressMap((m) => {
        const { [name]: _drop, ...rest } = m;
        void _drop;
        return rest;
      });
    }
  };

  const pullModel = () => {
    setBrowserOpen(true);
  };

  const providerMeta: Record<string, { label: string; color: string }> = {
    ollama: { label: "ollama", color: "#4ade80" },
    "claude-code": { label: "claude code", color: "#b18cf0" },
    openai: { label: "openai", color: "#10a37f" },
    anthropic: { label: "anthropic", color: "#d97757" },
  };

  const renderHeader = () => {
    const parsed = parseQualifiedModel(selected);
    return (
      <div className="ai-header">
        <button
          className="ai-header-primary"
          onClick={startNewChat}
          title="New chat (current is saved to history)"
          disabled={streaming !== null || runningTools}
        >
          ✚ New chat
        </button>
        <div className="ai-header-spacer" />
        {parsed?.providerId === "claude-code" && (
          <ClaudeSessionsButton
            cwd={root}
            onResume={async (id) => {
              setClaudeSessionId(id);
              setLastUsage(null);
              setTodos(null);
              // Hydrate the full prior transcript from the on-disk
              // JSONL so the user sees what they're continuing from,
              // not an empty pane. Best-effort — show a toast + start
              // empty if the loader fails (the next user turn still
              // resumes server-side via --resume).
              try {
                const loaded = await claudeCodeIpc.loadSession(root, id);
                const hydrated: ChatMessage[] = loaded.map((m) => ({
                  role: m.role,
                  content: m.content,
                  tool_calls: m.tool_calls,
                  tool_results: m.tool_results,
                }));
                setMessages(hydrated);
                toastInfo(
                  `Resumed Claude Code session — ${hydrated.length} message${hydrated.length === 1 ? "" : "s"} restored`,
                );
              } catch (err) {
                console.warn("loadSession failed", err);
                setMessages([]);
                toastInfo(
                  "Resumed Claude Code session — your next message continues from where you left off",
                );
              }
            }}
          />
        )}
        <HeaderMenu
          historyCount={sessions.length}
          onHistory={() => setHistoryOpen((v) => !v)}
          historyActive={historyOpen}
          onRefresh={() => void refresh()}
          onSettings={() => openSettings()}
          onBrowseModels={() => pullModel()}
        />
      </div>
    );
  };

  const renderModelChip = () => {
    const parsed = parseQualifiedModel(selected);
    const currentModel = allModels.find(
      (m) =>
        parsed &&
        m.providerId === parsed.providerId &&
        m.modelId === parsed.modelId,
    );
    const meta = parsed
      ? (providerMeta[parsed.providerId] ?? {
          label: parsed.providerId,
          color: "#888",
        })
      : null;
    return (
      <button
        className="ai-model-chip"
        onClick={() => setBrowserOpen(true)}
        title={
          currentModel
            ? `${currentModel.displayName} — click to switch`
            : "Open model browser"
        }
      >
        {meta && parsed ? (
          <>
            <span className="ai-model-chip-label">Model</span>
            <span
              className="ai-model-dot"
              style={{ background: meta.color }}
              aria-hidden="true"
            />
            <span className="ai-model-id">{parsed.modelId}</span>
            <span className="ai-model-provider">{meta.label}</span>
          </>
        ) : (
          <>
            <span className="ai-model-chip-label">Model</span>
            <span className="ai-model-btn-empty">Pick a model…</span>
          </>
        )}
        <span className="ai-model-btn-caret">▾</span>
      </button>
    );
  };

  const renderHistoryDropdown = () => {
    if (!historyOpen) return null;
    return (
      <div className="ai-history-dropdown">
        {sessions.length === 0 && (
          <div className="ai-history-empty">No saved chats yet</div>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`ai-history-item ${s.id === sessionId ? "active" : ""}`}
          >
            <button
              className="ai-history-open"
              onClick={() => openSession(s.id)}
              title={`${s.messages.length} messages · ${new Date(s.updatedAt).toLocaleString()}`}
            >
              <span className="ai-history-title">{s.title}</span>
              <span className="ai-history-meta">
                {new Date(s.updatedAt).toLocaleString()} · {s.messages.length} msg
              </span>
            </button>
            <button
              className="ai-history-delete"
              onClick={() => void removeSession(s.id)}
              title="Delete this chat"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    );
  };

  const display = useMemo(() => {
    // System messages are infrastructure: they're rebuilt fresh per turn
    // and shouldn't appear as chat bubbles. Hide them defensively in case
    // any path (old session, future bug) leaves one in `messages`.
    const arr: ChatMessage[] = messages.filter((m) => m.role !== "system");
    // Only render the in-progress assistant bubble once there's actual
    // content to show. While the stream is empty (model is still
    // thinking, or running tools), skip the bubble — the inline status
    // strip below already conveys "working on it" without a giant
    // empty whitespace block in the conversation.
    const hasStreamingText =
      streaming !== null && streaming.trim().length > 0;
    const hasStreamingBlocks = streamingBlocks.length > 0;
    if (streaming !== null && (hasStreamingText || hasStreamingBlocks)) {
      arr.push({
        role: "assistant",
        content: streaming ?? "",
        tool_calls:
          streamingToolCalls.length > 0 ? streamingToolCalls : undefined,
        tool_results:
          streamingToolResults.length > 0 ? streamingToolResults : undefined,
        blocks: hasStreamingBlocks ? streamingBlocks : undefined,
      });
    }
    return arr;
  }, [
    messages,
    streaming,
    streamingBlocks,
    streamingToolCalls,
    streamingToolResults,
  ]);

  const contextLabel = useMemo(() => {
    if (!attachContext) return "No context attached";
    if (editorState.selectionText.length > 0 && editorState.selectionLines > 0) {
      const n = editorState.selectionLines;
      return `Sending ${n} selected line${n === 1 ? "" : "s"} as context`;
    }
    if (editorState.filePath) {
      const base =
        editorState.filePath.replace(/\\/g, "/").split("/").pop() ??
        editorState.filePath;
      return `Sending whole file ${base}`;
    }
    return null;
  }, [
    attachContext,
    editorState.filePath,
    editorState.selectionText,
    editorState.selectionLines,
  ]);

  // No early-return for "checking" — render the normal panel and let
  // model discovery populate the dropdown when it finishes. The previous
  // "Checking for Ollama…" splash was misleading for users who don't
  // run Ollama at all.

  if (status === "missing") {
    return (
      <div className="ai-panel">
        <div className="ai-empty">
          <p>
            <strong>Ollama isn't reachable on localhost:11434.</strong>
          </p>
          <p>
            <strong>If Ollama is already installed:</strong> launch the Ollama
            app (Windows tray / macOS menu bar). The panel will auto-detect
            within a few seconds. Or click <em>Try to start Ollama</em> below —
            we'll attempt to spawn the server in a hidden terminal.
          </p>
          <p>
            <strong>If Ollama isn't installed:</strong> get it from{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                void openUrl(OLLAMA_DOWNLOAD);
              }}
            >
              ollama.com/download
            </a>
            .
          </p>
          <p>
            <strong>Or skip Ollama entirely:</strong> add an OpenAI / Anthropic
            API key in{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                openSettings();
              }}
            >
              Settings → AI Providers
            </a>
            .
          </p>
          <div className="ai-actions">
            <button
              className="primary"
              onClick={async () => {
                try {
                  // Spawn a hidden Ollama server in a workspace terminal.
                  // The user can see / kill it from the terminal panel.
                  useStore.getState().addTerminal(wsId, "bottom", {
                    path: "ollama",
                    args: ["serve"],
                    label: "Ollama Server",
                  });
                  toastInfo(
                    "Spawning Ollama in a terminal. Will auto-detect within a few seconds.",
                  );
                  // Recheck shortly after.
                  setTimeout(() => void refresh(), 2500);
                } catch (e) {
                  toastError(`Could not start Ollama: ${errMsg(e)}`);
                }
              }}
            >
              ▶ Try to start Ollama
            </button>
            <button
              onClick={() => {
                void openUrl(OLLAMA_DOWNLOAD);
                toastInfo("Opened ollama.com/download.");
              }}
            >
              Download Ollama…
            </button>
            <button onClick={() => void refresh()}>Check now</button>
          </div>
          <p className="ai-auto-hint">
            <span className="ai-spinner" /> Auto-checking every 4 s…
          </p>
        </div>
      </div>
    );
  }

  if (status === "no-models") {
    return (
      <div className="ai-panel">
        <div className="ai-empty">
          <p>
            <strong>Ollama is running.</strong> Pull a model to start chatting,
            or add a cloud provider key in <a href="#" onClick={(e) => { e.preventDefault(); openSettings(); }}>Settings</a>.
          </p>
          <ul className="ai-suggested">
            {SUGGESTED_MODELS.map((m) => (
              <li key={m}>
                <button
                  className="ai-pull-btn"
                  onClick={() => void pullSpecific(m)}
                  disabled={!!pullProgressMap[m]}
                >
                  ↓ <code>{m}</code>
                </button>
                <span className="ai-pull-hint">
                  {m.startsWith("qwen2.5-coder:7b")
                    ? "best for coding · ~4.7 GB"
                    : m.startsWith("qwen2.5-coder:3b")
                      ? "smaller coding model · ~1.9 GB"
                      : m.startsWith("llama3.2")
                        ? "general-purpose · ~2 GB"
                        : "tiny, fast · ~2.4 GB"}
                </span>
              </li>
            ))}
          </ul>
          <div className="ai-actions">
            <button className="primary" onClick={() => pullModel()}>
              Browse all models…
            </button>
            <button onClick={() => void refresh()}>Refresh</button>
          </div>
          {aggregatedPullProgress && (
            <p className="ai-progress">{aggregatedPullProgress}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ai-panel">
      {renderHeader()}
      {renderHistoryDropdown()}
      <PrivacyBanner activeFilePath={editorState.filePath} />
      {todos && todos.length > 0 && <TodosCard items={todos} />}
      {messages.length >= 4 && streaming === null && !runningTools && (
        <TimelineScrubber
          totalMessages={messages.length}
          scrubIndex={scrubIndex}
          onScrub={(i) => setScrubIndex(i)}
          onReset={() => setScrubIndex(null)}
          onBranch={
            scrubIndex !== null && aiChatId
              ? () => {
                  // Find the LATEST user message at or before
                  // scrubIndex — branch from there so the new chat
                  // ends with a user prompt ready to send.
                  for (let i = scrubIndex; i >= 0; i--) {
                    if (messages[i].role === "user") {
                      branchFromHere(i);
                      setScrubIndex(null);
                      return;
                    }
                  }
                }
              : undefined
          }
        />
      )}
      <div className="ai-messages" ref={scrollRef}>
        {display.length === 0 && (
          <>
            <div className="ai-welcome">
              <div className="ai-welcome-title">What's on your mind?</div>
              <div className="ai-welcome-sub">
                Ask anything about the active file — its contents are sent
                as context. Or pick a starter:
              </div>
            </div>
            <div className="ai-quick-prompts">
              {[
                {
                  label: "Explain this code",
                  desc: "Walk through what it does",
                  prompt: "Explain what this file does, in simple terms.",
                },
                {
                  label: "Find bugs",
                  desc: "Spot logic errors and edge cases",
                  prompt:
                    "Are there bugs or logic errors in this file? Be specific.",
                },
                {
                  label: "Suggest refactor",
                  desc: "Improve readability or correctness",
                  prompt:
                    "Suggest a refactor that would improve readability or correctness. Show the proposed change.",
                },
                {
                  label: "Write tests",
                  desc: "Generate unit tests",
                  prompt:
                    "Suggest unit tests for the functions in this file.",
                },
                {
                  label: "Add types",
                  desc: "Improve type annotations",
                  prompt:
                    "Suggest type annotations or improvements to existing types.",
                },
                {
                  label: "Summarize",
                  desc: "Key responsibilities in 3–5 bullets",
                  prompt:
                    "Summarize the key responsibilities of this file in 3-5 bullets.",
                },
              ].map((q) => (
                <button
                  key={q.label}
                  className="ai-quick-card"
                  onClick={() => setInput(q.prompt)}
                >
                  <span className="ai-quick-card-title">{q.label}</span>
                  <span className="ai-quick-card-desc">{q.desc}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {(() => {
          // Build a lookup of tool results by call id so each tool_call
          // row can render its result inline (Claude-Code-style). Two
          // sources to merge:
          //   1. Standalone `tool` role messages (Ollama / OpenAI flow,
          //      where Codetta itself runs the tool and posts the result
          //      back as the next message).
          //   2. The `tool_results` array on assistant messages (Claude
          //      Code flow, where the agent ran the tool internally and
          //      we received its result via the same stream).
          const toolResultsById = new Map<string, string>();
          for (const msg of display) {
            if (msg.role === "tool" && msg.tool_call_id) {
              toolResultsById.set(msg.tool_call_id, msg.content);
            }
            if (msg.role === "assistant" && msg.tool_results) {
              for (const tr of msg.tool_results) {
                if (tr.tool_use_id) {
                  toolResultsById.set(tr.tool_use_id, tr.content);
                }
              }
            }
          }
          return display.map((m, i) => {
          const isAssistant = m.role === "assistant";
          const isStreamingThis = isAssistant && i === display.length - 1 && streaming !== null;
          const blocks = isAssistant ? extractCodeBlocks(m.content) : [];
          const insertText = blocks.length > 0 ? blocks.join("\n\n") : m.content;
          const taggedBlocks = isAssistant
            ? extractTaggedCodeBlocks(m.content)
            : [];
          const shellBlocks = taggedBlocks.filter((b) => isShellLang(b.lang));
          const shellText = shellBlocks.map((b) => b.code).join("\n");
          const split = isAssistant
            ? splitThinking(m.content)
            : { thinking: "", visible: m.content };
          const showThinking =
            isStreamingThis && m.content.length === 0 && !m.tool_calls;
          // Collapse long, older assistant messages by default. Keep the most
          // recent one + currently-streaming one fully visible.
          const isLatest = i === display.length - 1;
          const COLLAPSE_THRESHOLD = 600;
          const COLLAPSE_PREVIEW = 320;
          const expanded = expandedMsgIdx.has(i);
          const shouldCollapse =
            isAssistant &&
            !isLatest &&
            !isStreamingThis &&
            !expanded &&
            split.visible.length > COLLAPSE_THRESHOLD;
          const visibleContent = shouldCollapse
            ? split.visible.slice(0, COLLAPSE_PREVIEW) + "…"
            : split.visible;
          // While streaming, the model may be emitting raw tool-call JSON or
          // echoing the investigation plan. Hide that ugliness behind a
          // placeholder until streaming finishes (the parser cleans it up).
          const trimmedStream = visibleContent.trim();
          const looksLikeToolJunk =
            isStreamingThis &&
            trimmedStream.length > 0 &&
            (trimmedStream.startsWith("{") ||
              trimmedStream.startsWith("[") ||
              trimmedStream.startsWith("ROUND ") ||
              /\{\s*"name"\s*:/.test(trimmedStream) ||
              /\{\s*"arguments"/.test(trimmedStream) ||
              /<tool_call>/i.test(trimmedStream));
          if (m.role === "tool") {
            // Tool results are now rendered inline, attached to their
            // matching tool_call row in the parent assistant message.
            // Only show standalone if the result has no matching call
            // (orphan / safety net).
            if (m.tool_call_id && toolResultsById.has(m.tool_call_id)) {
              return null;
            }
            if (/^Unknown tool:/i.test(m.content)) return null;
            return (
              <details key={i} className="ai-msg ai-msg-tool">
                <summary className="ai-tool-summary">
                  <span className="ai-tool-icon">📄</span>
                  Tool result
                  <span className="ai-tool-meta">
                    {m.content.length} chars
                  </span>
                </summary>
                <pre className="ai-tool-body">{m.content}</pre>
              </details>
            );
          }
          const dimmedByScrub = scrubIndex !== null && i > scrubIndex;
          return (
            <div
              key={i}
              className={`ai-msg ai-msg-${m.role}${dimmedByScrub ? " ai-msg-scrubbed-past" : ""}`}
            >
              <span className="ai-msg-role">
                {m.role === "user" ? "You" : "AI"}
                {m.role === "user" && (
                  <>
                    <button
                      className="ai-msg-regen"
                      title="Re-send this message — wipes everything below"
                      onClick={() => void regenerateFrom(i)}
                      disabled={streaming !== null || runningTools}
                    >
                      ↻
                    </button>
                    {aiChatId && (
                      <button
                        className="ai-msg-branch"
                        title="Branch from here — open a new chat tab with the conversation up to this turn, leaving this one intact"
                        onClick={() => branchFromHere(i)}
                        disabled={streaming !== null || runningTools}
                      >
                        ⎇
                      </button>
                    )}
                  </>
                )}
              </span>
              {m.tool_calls && m.tool_calls.length > 0 && (() => {
                // If this turn made 2+ file-modifying tool calls,
                // collapse them into a single ComposeCard with per-
                // file diffs and aggregate stats. The per-call rows
                // still render below for full fidelity (Read/Glob/
                // Bash/etc. don't enter the composer).
                //
                // When the message has a `blocks` log, the per-call
                // rows are rendered inline by <InterleavedBlocks>
                // (preserves chronological order with the text). We
                // still show the ComposeCard summary at top in that
                // case — it's a higher-level affordance (revert
                // all / accept all) that doesn't belong inline.
                const hasBlocks = !!(m.blocks && m.blocks.length > 0);
                const fileCalls = m.tool_calls.filter(
                  (c) => extractEditDiffs(c) !== null,
                );
                const otherCalls = m.tool_calls.filter(
                  (c) => extractEditDiffs(c) === null,
                );
                const useCompose = fileCalls.length >= 2;
                if (hasBlocks && !useCompose) return null;
                const rows = hasBlocks
                  ? []
                  : (useCompose ? otherCalls : m.tool_calls);
                return (
                  <div className="ai-tcalls">
                    {useCompose && (
                      <ComposeCard
                        wsId={wsId}
                        chatId={aiChatId}
                        msgIndex={i}
                        calls={fileCalls}
                      />
                    )}
                    {rows.map((c, j) => (
                      <ToolCallRow
                        key={c.id ?? j}
                        call={c}
                        result={c.id ? toolResultsById.get(c.id) : undefined}
                      />
                    ))}
                  </div>
                );
              })()}
              {isAssistant && split.thinking.length > 0 && (
                <details className="ai-think-block">
                  <summary>
                    <span>💭</span> Reasoning
                  </summary>
                  <div className="ai-think-body">{split.thinking}</div>
                </details>
              )}
              <div className="ai-msg-body">
                {showThinking ? (
                  <span className="ai-thinking">
                    <span className="ai-spinner" /> Thinking…
                  </span>
                ) : looksLikeToolJunk ? (
                  <span className="ai-thinking">
                    <span className="ai-spinner" /> Preparing tool call…
                  </span>
                ) : isAssistant && m.blocks && m.blocks.length > 0 ? (
                  // Chronological render: walk the recorded blocks
                  // log so text and tool calls appear in the order
                  // the model emitted them, not "all text first then
                  // all tools." Works during streaming too — the
                  // live bubble's blocks come from streamingBlocks
                  // state, which is updated in real time. Falls
                  // back to MarkdownPreview below for messages
                  // without a blocks log (older sessions, non-
                  // agentic providers).
                  <InterleavedBlocks
                    blocks={m.blocks}
                    callsById={
                      new Map(
                        (m.tool_calls ?? [])
                          .filter((c): c is ToolCall & { id: string } =>
                            typeof c.id === "string",
                          )
                          .map((c) => [c.id, c]),
                      )
                    }
                    resultsById={(() => {
                      const out = new Map<string, string>();
                      for (const tr of m.tool_results ?? []) {
                        if (tr.tool_use_id) out.set(tr.tool_use_id, tr.content);
                      }
                      return out;
                    })()}
                  />
                ) : isAssistant ? (
                  <>
                    <MarkdownPreview content={balanceFences(visibleContent)} />
                    {shouldCollapse && (
                      <button
                        className="ai-show-more"
                        onClick={() => {
                          setExpandedMsgIdx((s) => new Set(s).add(i));
                        }}
                      >
                        Show {split.visible.length - COLLAPSE_PREVIEW} more chars
                      </button>
                    )}
                    {!shouldCollapse &&
                      isAssistant &&
                      !isLatest &&
                      !isStreamingThis &&
                      split.visible.length > COLLAPSE_THRESHOLD && (
                        <button
                          className="ai-show-more"
                          onClick={() => {
                            setExpandedMsgIdx((s) => {
                              const next = new Set(s);
                              next.delete(i);
                              return next;
                            });
                          }}
                        >
                          Show less
                        </button>
                      )}
                  </>
                ) : (
                  m.content
                )}
              </div>
              {isAssistant && !isStreamingThis && m.content.length > 0 && (
                <div className="ai-msg-actions">
                  <button
                    className="ai-msg-action"
                    onClick={() => {
                      void navigator.clipboard.writeText(m.content);
                      toastSuccess("Copied to clipboard");
                    }}
                    title="Copy message"
                  >
                    📋 Copy
                  </button>
                  {blocks.length > 0 && (
                    <button
                      className="ai-msg-action"
                      onClick={() => {
                        void navigator.clipboard.writeText(blocks.join("\n\n"));
                        toastSuccess(
                          `Copied ${blocks.length} code block${blocks.length === 1 ? "" : "s"}`,
                        );
                      }}
                      title="Copy code blocks only"
                    >
                      &lt;/&gt; Copy code
                    </button>
                  )}
                  <button
                    className="ai-msg-action"
                    onClick={() => {
                      const ok = insertIntoActiveEditor(insertText);
                      if (ok) toastSuccess("Inserted at cursor");
                      else toastError("No active editor");
                    }}
                    title="Insert at cursor / replace selection"
                  >
                    ↳ Insert
                  </button>
                  {shellBlocks.length > 0 && (
                    <button
                      className="ai-msg-action ai-msg-action-run"
                      onClick={async () => {
                        const ok = await dialogConfirm(
                          `Run ${shellBlocks.length} shell command${shellBlocks.length === 1 ? "" : "s"} in the active terminal?\n\n${shellText.slice(0, 800)}${shellText.length > 800 ? "\n…" : ""}`,
                          {
                            title: "Run in terminal",
                            okLabel: "Run",
                            cancelLabel: "Cancel",
                          },
                        );
                        if (ok) await runInActiveTerminal(shellText);
                      }}
                      title="Run the shell command(s) in the active terminal"
                    >
                      ▶ Run
                    </button>
                  )}
                  {isLatest && (
                    <button
                      className="ai-msg-action"
                      onClick={() => void goDeeper()}
                      title="Ask the model to investigate further and expand the answer"
                      disabled={streaming !== null || runningTools}
                    >
                      ↡ Go deeper
                    </button>
                  )}
                </div>
              )}
            </div>
          );
          });
        })()}
        {(runningTools ||
          (streaming !== null && warmingUp && streaming.length === 0) ||
          (streaming !== null && tokensPerSec !== null) ||
          (streaming !== null &&
            streaming.length === 0 &&
            streamingBlocks.length === 0 &&
            !runningTools &&
            !warmingUp)) && (
          <div className="ai-inline-status">
            {runningTools && (
              <div className="ai-running-tools">
                {activeToolLabels.length === 0 ? (
                  <span className="ai-thinking">
                    <span className="ai-spinner" /> Running tools…
                  </span>
                ) : (() => {
                  // Header shows accurate "X of N done" counter so the
                  // user can see progress as results land — was a
                  // perpetual "Running 10 tools" spinner before, even
                  // when 9 had already finished.
                  const done = activeToolLabels.filter(
                    (t) => t.status === "done" || t.status === "error",
                  ).length;
                  const total = activeToolLabels.length;
                  const allDone = done === total;
                  // When all tools are done but the stream is still
                  // active, the agent is generating its follow-up text.
                  // The old "✓ Finished N tools" header looked terminal
                  // and made users think the conversation had ended,
                  // even though more was coming. Keep the spinner +
                  // active wording until streaming actually closes.
                  const streamStillActive = streaming !== null;
                  return (
                    <>
                      <span className="ai-thinking ai-running-header">
                        {allDone && !streamStillActive ? (
                          <span className="ai-running-check">✓</span>
                        ) : (
                          <span className="ai-spinner" />
                        )}
                        {allDone && streamStillActive
                          ? `Got ${total} tool result${total === 1 ? "" : "s"} — generating response…`
                          : allDone
                            ? `Finished ${total} tool${total === 1 ? "" : "s"}`
                            : `${done} of ${total} done · ${total - done} running`}
                      </span>
                      {activeToolLabels.map((t, i) => (
                        <RunningToolRow key={i} entry={t} />
                      ))}
                    </>
                  );
                })()}
              </div>
            )}
            {streaming !== null &&
              warmingUp &&
              streaming.length === 0 &&
              !runningTools && (
                <span className="ai-thinking">
                  <span className="ai-spinner" /> Loading model
                </span>
              )}
            {/* Gap between hitting Enter and the first token / tool call.
                For Claude Code that's CLI spawn + auth + initial API call
                — can be 1-3s on a fresh session, longer with --resume.
                Without this, the user sees their own message then nothing
                and assumes the app froze. */}
            {streaming !== null &&
              streaming.length === 0 &&
              streamingBlocks.length === 0 &&
              !runningTools &&
              !warmingUp && (
                <span className="ai-thinking">
                  <span className="ai-spinner" /> Waiting for response…
                </span>
              )}
            {streaming !== null && tokensPerSec !== null && (
              <span className="ai-inline-tps">
                {tokensPerSec.toFixed(1)} t/s
              </span>
            )}
            {/* Stream-staleness badge. Fires when no provider event has
                arrived in the last 10s while a turn is in flight. Lets
                the user see "the app didn't forget about me" instead
                of suspecting a freeze when a model is slow / a long
                tool is running. After 30s the wording sharpens and we
                surface an inline Stop button so the user has an
                obvious escape hatch from the chat area itself, not
                just buried in the toolbar. */}
            {streaming !== null &&
              lastStreamEventAt !== null &&
              (() => {
                const idleSec = Math.floor(
                  (Date.now() - lastStreamEventAt) / 1000,
                );
                if (idleSec < 10) return null;
                const looksStuck = idleSec >= 30;
                return (
                  <>
                    <span
                      className={`ai-thinking ai-inline-stale${looksStuck ? " ai-inline-stale-stuck" : ""}`}
                      title={
                        looksStuck
                          ? "Stream hasn't produced anything in 30+ seconds. Could be a slow tool, a slow API response, or genuinely stuck — Stop and try again if you don't want to wait."
                          : "No data from the model in this window. Click Stop to cancel if it's stuck."
                      }
                    >
                      ·{" "}
                      {looksStuck
                        ? `unusually slow (${idleSec}s)`
                        : `still working (${idleSec}s)`}
                    </span>
                    {looksStuck && (
                      <button
                        className="ai-inline-stop"
                        onClick={() => stop()}
                        title="Cancel this turn"
                      >
                        ⏹ Stop
                      </button>
                    )}
                  </>
                );
              })()}
          </div>
        )}
        {pendingPermission && (
          <PermissionCard
            call={pendingPermission.call}
            onResolve={(decision) => pendingPermission.resolve(decision)}
          />
        )}
      </div>
      {attachTree && (
        <div
          className="ai-context-indicator"
          title="Project file tree will be attached to your next message — click to cancel"
          onClick={() => setAttachTree(false)}
          role="button"
        >
          <span className="ai-context-dot" />
          Project file tree attached (one-shot)
          <span className="ai-context-toggle">cancel</span>
        </div>
      )}
      {attachTerminal && (
        <div
          className="ai-context-indicator"
          title="Active terminal output will be attached to your next message — click to cancel"
          onClick={() => setAttachTerminal(false)}
          role="button"
        >
          <span className="ai-context-dot" />
          Terminal output attached (one-shot)
          <span className="ai-context-toggle">cancel</span>
        </div>
      )}
      {attachedFiles.length > 0 && (
        <div className="ai-context-indicator" role="status">
          <span className="ai-context-dot" />
          Files: {attachedFiles.join(", ")}
          <button
            className="ai-context-toggle"
            onClick={() => setAttachedFiles([])}
            title="Detach all attached files"
          >
            clear
          </button>
        </div>
      )}
      {contextLabel && (
        <div
          className={`ai-context-indicator ${attachContext ? "" : "off"}`}
          title="Click to toggle whether file/selection is attached to your next message"
          onClick={() => setAttachContext((v) => !v)}
          role="button"
        >
          <span className="ai-context-dot" />
          {contextLabel}
          <span className="ai-context-toggle">
            {attachContext ? "off" : "on"}
          </span>
        </div>
      )}
      {(() => {
        const isSlash = input.startsWith("/");
        if (!isSlash || streaming !== null) return null;
        const q = input.slice(1).toLowerCase();
        const matches = SLASH_COMMANDS.filter((c) =>
          c.name.slice(1).toLowerCase().startsWith(q),
        );
        if (matches.length === 0) return null;
        const idx = Math.max(0, Math.min(slashIndex, matches.length - 1));
        return (
          <div className="ai-slash-suggestions">
            {matches.map((c, i) => (
              <button
                key={c.name}
                className={`ai-slash-item ${i === idx ? "active" : ""}`}
                onMouseEnter={() => setSlashIndex(i)}
                onClick={() => runSlashCommand(c)}
              >
                <span className="ai-slash-name">{c.name}</span>
                <span className="ai-slash-hint">{c.hint}</span>
              </button>
            ))}
          </div>
        );
      })()}
      {renderModelChip()}
      {/* Inline permission card — replaces the old full-window overlay.
          Renders nothing when there are no pending requests; otherwise
          shows the request just above the input where the user is
          already focused, instead of dimming the whole window. */}
      <ClaudePermissionOverlay />
      {queueLen > 0 && (
        <div className="ai-queue-indicator">
          <span>
            {queueLen} message{queueLen === 1 ? "" : "s"} queued — will send
            when the current turn finishes
          </span>
          <button
            className="ai-queue-send-now"
            onClick={() => {
              // Stop the current turn (preserving the queue), then the
              // finally-block in sendUserText will drain it. Without
              // this, the user's only options are wait or discard —
              // there's no "I'm done waiting, send my next message
              // right now" affordance.
              if (queueRef.current.length === 0) return;
              abortRef.current?.abort();
              toastInfo("Stopping current turn — queued message will send next");
            }}
            title="Stop the current turn and send the queued message now"
          >
            ⏭ Send now
          </button>
          <button
            className="ai-queue-clear"
            onClick={() => {
              queueRef.current = [];
              setQueueLen(0);
              toastInfo("Queued messages discarded");
            }}
            title="Discard queued messages"
          >
            Clear
          </button>
        </div>
      )}
      <div className="ai-input-row">
        <textarea
          ref={inputRef}
          className="ai-input"
          rows={2}
          placeholder={
            streaming !== null || runningTools
              ? "Type to queue (sends when this turn finishes; Esc to stop)…"
              : "Ask the model, or type / for commands… (Enter to send, Shift+Enter newline, ↑ to recall)"
          }
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setSlashIndex(0);
          }}
          onKeyDown={(e) => {
            // Esc while a request is in flight = stop. Always wins so the
            // user can bail out of long generations without reaching for
            // the mouse. (Escape with empty input also clears any pending
            // attachments — see below.)
            if (
              e.key === "Escape" &&
              (streaming !== null || runningTools)
            ) {
              e.preventDefault();
              stop();
              return;
            }
            const isSlash = input.startsWith("/");
            const firstWord = isSlash ? input.split(/\s+/)[0] : "";
            const exactCmd = isSlash
              ? SLASH_COMMANDS.find(
                  (c) => c.name.toLowerCase() === firstWord.toLowerCase(),
                )
              : undefined;
            if (isSlash) {
              const q = input.slice(1).toLowerCase();
              const matches = SLASH_COMMANDS.filter((c) =>
                c.name.slice(1).toLowerCase().startsWith(q),
              );
              if (matches.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashIndex((i) =>
                    Math.min(matches.length - 1, i + 1),
                  );
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashIndex((i) => Math.max(0, i - 1));
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                  e.preventDefault();
                  const idx = Math.max(
                    0,
                    Math.min(slashIndex, matches.length - 1),
                  );
                  runSlashCommand(matches[idx]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setInput("");
                  return;
                }
              }
              // Exact-match command typed with arguments (e.g. "/file foo.ts")
              if (
                exactCmd &&
                (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))
              ) {
                e.preventDefault();
                runSlashCommand(exactCmd);
                return;
              }
            }
            // ArrowUp on an empty input recalls the most recent prompt the
            // user sent — same idiom as a shell. Modifier keys skip it so
            // we don't fight selection-extending shortcuts.
            if (
              e.key === "ArrowUp" &&
              input.length === 0 &&
              !e.shiftKey &&
              !e.ctrlKey &&
              !e.metaKey &&
              !e.altKey
            ) {
              const lastUser = [...messages]
                .reverse()
                .find((m) => m.role === "user");
              if (lastUser) {
                e.preventDefault();
                setInput(lastUser.content);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {streaming !== null || runningTools ? (
          <button
            className="ai-send-btn ai-stop-btn"
            onClick={stop}
            title="Stop (Esc)"
          >
            ◼ Stop
          </button>
        ) : (
          <button
            className="primary ai-send-btn"
            onClick={() => void send()}
            disabled={!input.trim() || !selected}
          >
            Send
          </button>
        )}
      </div>
      {aggregatedPullProgress && (
        <div className="ai-status-strip">
          <span className="ai-status-item ai-status-pull">
            {aggregatedPullProgress}
          </span>
        </div>
      )}
      {(lastUsage || chatTotalCost > 0) &&
        streaming === null &&
        !runningTools && (
          <div
            className="ai-usage-strip"
            title={
              lastUsage?.model
                ? `Last turn — ${lastUsage.model}`
                : "Chat usage"
            }
          >
            {lastUsage && <UsageChip usage={lastUsage} />}
            {chatTotalCost > 0 && (
              <span className="ai-usage-total">
                · chat total{" "}
                <strong>${chatTotalCost.toFixed(4)}</strong>
                {(() => {
                  const budget = readBudgetUsd();
                  if (budget <= 0) return null;
                  const pct = Math.min(
                    100,
                    Math.round((chatTotalCost / budget) * 100),
                  );
                  return (
                    <span
                      className={`ai-usage-budget ${pct >= 100 ? "over" : pct >= 80 ? "warn" : ""}`}
                      title={`Budget: $${budget.toFixed(2)}`}
                    >
                      {" "}({pct}% of ${budget.toFixed(2)})
                    </span>
                  );
                })()}
              </span>
            )}
          </div>
        )}
      {recentTps !== null && recentTps < 8 && streaming === null && !runningTools && (() => {
        // The slow-generation banner is meaningful only for LOCAL models
        // (Ollama). Cloud / agentic providers (Claude Code, OpenAI,
        // Anthropic) are not VRAM-bound, and the "smaller model" /
        // "cloud key" remediations don't apply — Claude Code IS the
        // cloud key, OpenAI/Anthropic are already cloud. Hide the
        // banner entirely for those providers.
        const p = parseQualifiedModel(selected ?? "")?.providerId ?? "ollama";
        if (p !== "ollama") return null;
        return (
          <div className="ai-slow-banner">
            Slow generation ({recentTps.toFixed(1)} t/s). Likely VRAM bound.{" "}
            <button
              className="ai-slow-banner-btn"
              onClick={() => {
                setBrowserOpen(true);
                setRecentTps(null);
              }}
            >
              Smaller model
            </button>{" "}
            ·{" "}
            <button
              className="ai-slow-banner-btn"
              onClick={() => {
                openSettings();
                setRecentTps(null);
              }}
            >
              Cloud key
            </button>
          </div>
        );
      })()}
      <ModelBrowser
        open={browserOpen}
        installedNames={
          new Set(
            allModels
              .filter((m) => m.providerId === "ollama")
              .map((m) => m.modelId),
          )
        }
        cloudModels={allCloudCatalog}
        hasKey={{
          ollama: true,
          "claude-code": claudeCodeAvailable,
          openai: hasApiKey("openai"),
          anthropic: hasApiKey("anthropic"),
        }}
        selectedQualified={selected}
        pullProgressByName={pullProgressMap}
        onClose={() => setBrowserOpen(false)}
        onSelect={(q) => setSelected(q)}
        onPull={(name) => void pullSpecific(name)}
        onConfigureKey={() => {
          setBrowserOpen(false);
          openSettings();
        }}
        onInstallClaudeCode={async () => {
          // Spawn a workspace terminal that runs the install. We use the
          // default shell so npm resolves through the user's normal PATH,
          // then queue the install command via pty.write once spawned.
          const termId = useStore
            .getState()
            .addTerminal(wsId, "bottom", undefined);
          // Wait briefly for the PTY to be ready, then send the command.
          setTimeout(() => {
            const ws = useStore.getState().loaded[wsId];
            const t = ws?.terminals[termId];
            if (!t?.ptyId) return;
            void pty.write(
              t.ptyId,
              "npm install -g @anthropic-ai/claude-code\r",
            );
          }, 800);
          toastInfo(
            "Installing Claude Code via npm — when it finishes, run `claude /login`.",
          );
          setBrowserOpen(false);
          // Recheck a few times after install likely finishes.
          setTimeout(() => void refresh(), 15000);
          setTimeout(() => void refresh(), 30000);
        }}
      />
    </div>
  );
}

