import type { ChatMessage } from "./ai";

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  model: string;
  updatedAt: number;
}

const KEY = (wsId: string) => `lcp.ollama.history.${wsId}`;
const MAX_SESSIONS = 30;

export function loadSessions(wsId: string): ChatSession[] {
  try {
    const raw = localStorage.getItem(KEY(wsId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(isValidSession).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
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
  const trimmed = all.slice(0, MAX_SESSIONS);
  try {
    localStorage.setItem(KEY(wsId), JSON.stringify(trimmed));
  } catch {
    /* localStorage full — best effort */
  }
}

export function deleteSession(wsId: string, id: string): void {
  const all = loadSessions(wsId).filter((s) => s.id !== id);
  try {
    localStorage.setItem(KEY(wsId), JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

export function newSessionId(): string {
  return "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.content ?? "";
  const trimmed = first.trim().split("\n")[0] ?? "";
  return trimmed.length > 60 ? trimmed.slice(0, 57) + "…" : trimmed || "Untitled";
}
