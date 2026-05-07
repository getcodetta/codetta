import type { ChatMessage } from "./ai";
import { getJson, setJson } from "./localStore";

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  /** Qualified provider:model id used for the last turn, or a bare
   *  Ollama model id from older sessions. Optional because sessions
   *  saved before the model field was added carry it as undefined,
   *  and consumers already gate on `if (session.model)`. */
  model?: string;
  updatedAt: number;
  /**
   * Provider-side session id (currently only set by the Claude Code
   * provider). When present we pass it as `resumeSessionId` on the
   * next turn so the CLI's --resume keeps the server-side context
   * window + prompt cache alive instead of re-paying cold-start every
   * turn. Cleared when the user starts a new chat.
   */
  claudeSessionId?: string;
  /**
   * Cumulative USD cost of every Claude Code turn in this chat,
   * summed from the `cost_usd` field of each `result` event. Lets the
   * UI show running spend in the footer + warn at a configurable
   * budget threshold. Only Claude Code populates this today.
   */
  totalCostUsd?: number;
}

const KEY = (wsId: string) => `lcp.ollama.history.${wsId}`;
const MAX_SESSIONS = 30;

export function loadSessions(wsId: string): ChatSession[] {
  const arr = getJson<unknown[]>(KEY(wsId), [], Array.isArray);
  return arr
    .filter(isValidSession)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function isValidSession(s: unknown): s is ChatSession {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.title === "string" &&
    Array.isArray(o.messages) &&
    typeof o.updatedAt === "number"
  );
}

export function saveSession(wsId: string, session: ChatSession): void {
  const all = loadSessions(wsId).filter((s) => s.id !== session.id);
  all.unshift(session);
  setJson(KEY(wsId), all.slice(0, MAX_SESSIONS));
}

export function deleteSession(wsId: string, id: string): void {
  const all = loadSessions(wsId).filter((s) => s.id !== id);
  setJson(KEY(wsId), all);
}

export function newSessionId(): string {
  return "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.content ?? "";
  const trimmed = first.trim().split("\n")[0] ?? "";
  return trimmed.length > 60 ? trimmed.slice(0, 57) + "…" : trimmed || "Untitled";
}
