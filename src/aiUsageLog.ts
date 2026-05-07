// AI usage log — an append-only ledger of every AI turn that
// produced a measurable cost. Records ship to localStorage and are
// read by the Settings → AI Usage Dashboard for monthly rollups,
// per-provider breakdowns, and hard-cap enforcement.
//
// What we record per turn:
//   ts          — millis since epoch
//   provider    — "claude-code" | "anthropic" | "openai" | "ollama"
//   model       — the actual model id reported by the provider
//   costUsd     — cumulative cost reported by the provider (often 0
//                 for Ollama, often 0 for Claude Code subscription
//                 turns, non-zero for API-billed turns)
//   tokensIn    — prompt + cache-read tokens (best-effort)
//   tokensOut   — completion tokens
//   wsId        — workspace where the turn happened (for per-project
//                 spend later)
//   chatId      — chat-tab session id (for jumping to the chat from
//                 the dashboard)
//
// What we do NOT record:
//   - prompt contents
//   - response contents
//   - file paths the agent touched
// Cost data alone is enough to budget; logging more would create a
// privacy regression that defeats the AI privacy work.

import {
  getJson,
  getString,
  remove as lsRemove,
  setJson,
  setString,
} from "./localStore";

const KEY = "lcp.ai.usage.log";

/** Cap to keep localStorage sane. Records older than this get
 *  trimmed on every append. Plenty of room for ~3 years of normal
 *  use; a heavy user blasting 100 turns/day fills it in 50 days. */
const MAX_RECORDS = 5000;

export interface UsageRecord {
  ts: number;
  provider: string;
  model: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  wsId?: string;
  chatId?: string;
  /** Optional verbatim user prompt for the turn. Only present when
   *  the user has opted in via Settings → AI Usage → "Log prompt
   *  text". Truncated server-side to MAX_PROMPT_CHARS to bound the
   *  log size. Undefined for every record written before opt-in. */
  prompt?: string;
}

interface WriteableUsageRecord {
  provider: string;
  model: string;
  costUsd: number;
  tokensIn?: number;
  tokensOut?: number;
  wsId?: string;
  chatId?: string;
  prompt?: string;
}

/** Cap any single recorded prompt to this many characters. Long
 *  prompts (paste-the-whole-readme style) shouldn't dominate the
 *  log size. */
const MAX_PROMPT_CHARS = 1500;

const LOG_PROMPTS_KEY = "lcp.ai.usage.logPrompts";

export function loadLogPrompts(): boolean {
  return getString(LOG_PROMPTS_KEY) === "1";
}

export function saveLogPrompts(on: boolean): void {
  if (on) setString(LOG_PROMPTS_KEY, "1");
  else lsRemove(LOG_PROMPTS_KEY);
  notify();
}

type Listener = () => void;
const listeners = new Set<Listener>();
function notify() {
  for (const l of listeners) l();
}

export function subscribeUsage(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function loadUsage(): UsageRecord[] {
  const arr = getJson<unknown[]>(KEY, [], Array.isArray);
  return arr.filter(
    (r: unknown): r is UsageRecord =>
      !!r &&
      typeof r === "object" &&
      typeof (r as UsageRecord).ts === "number" &&
      typeof (r as UsageRecord).provider === "string" &&
      typeof (r as UsageRecord).model === "string" &&
      typeof (r as UsageRecord).costUsd === "number",
  );
}

function saveUsage(records: UsageRecord[]) {
  // Keep the most recent N — append at end, trim from front.
  const trimmed =
    records.length > MAX_RECORDS
      ? records.slice(records.length - MAX_RECORDS)
      : records;
  setJson(KEY, trimmed);
}

/** Append one usage record. Skips zero-cost zero-token records to
 *  avoid filling the log with noise from no-op providers. The
 *  prompt (when supplied) is only persisted if the user has opted
 *  into prompt logging via Settings — defence-in-depth against
 *  accidental capture of sensitive turns. */
export function recordUsage(r: WriteableUsageRecord) {
  if ((r.costUsd ?? 0) === 0 && (r.tokensIn ?? 0) === 0 && (r.tokensOut ?? 0) === 0) {
    return;
  }
  const all = loadUsage();
  const wantsPrompts = loadLogPrompts();
  let prompt: string | undefined;
  if (wantsPrompts && r.prompt) {
    prompt =
      r.prompt.length > MAX_PROMPT_CHARS
        ? r.prompt.slice(0, MAX_PROMPT_CHARS) + "…"
        : r.prompt;
  }
  all.push({
    ts: Date.now(),
    provider: r.provider,
    model: r.model,
    costUsd: r.costUsd,
    tokensIn: r.tokensIn ?? 0,
    tokensOut: r.tokensOut ?? 0,
    wsId: r.wsId,
    chatId: r.chatId,
    prompt,
  });
  saveUsage(all);
  notify();
}

export function clearUsage() {
  lsRemove(KEY);
  notify();
}

// ---------- Aggregation helpers (used by the dashboard) ----------

export interface MonthlySummary {
  /** YYYY-MM */
  month: string;
  total: number;
  perProvider: Record<string, number>;
  turns: number;
  tokensIn: number;
  tokensOut: number;
}

function ymKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function summarizeByMonth(records: UsageRecord[]): MonthlySummary[] {
  const buckets = new Map<string, MonthlySummary>();
  for (const r of records) {
    const key = ymKey(new Date(r.ts));
    let b = buckets.get(key);
    if (!b) {
      b = {
        month: key,
        total: 0,
        perProvider: {},
        turns: 0,
        tokensIn: 0,
        tokensOut: 0,
      };
      buckets.set(key, b);
    }
    b.total += r.costUsd;
    b.perProvider[r.provider] = (b.perProvider[r.provider] ?? 0) + r.costUsd;
    b.turns += 1;
    b.tokensIn += r.tokensIn;
    b.tokensOut += r.tokensOut;
  }
  return Array.from(buckets.values()).sort((a, b) =>
    b.month.localeCompare(a.month),
  );
}

export function thisMonthTotal(records?: UsageRecord[]): number {
  const list = records ?? loadUsage();
  const key = ymKey(new Date());
  let sum = 0;
  for (const r of list) {
    if (ymKey(new Date(r.ts)) === key) sum += r.costUsd;
  }
  return sum;
}

// ---------- Hard cap enforcement ----------
//
// User can set a monthly hard cap. Once exceeded, the chat panel
// refuses to dispatch new turns until the user raises the cap or
// the calendar rolls over. Distinct from the per-chat warning
// budget already wired into AIChatPanel — this is the cross-chat
// cross-provider stop button.

const HARD_CAP_KEY = "lcp.ai.usage.hardCapUsd";

export function loadHardCap(): number {
  const raw = getString(HARD_CAP_KEY);
  const n = raw ? parseFloat(raw) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function saveHardCap(usd: number) {
  if (usd > 0 && Number.isFinite(usd)) setString(HARD_CAP_KEY, String(usd));
  else lsRemove(HARD_CAP_KEY);
  notify();
}

// ---------- Per-workspace budgets ----------
//
// Per-workspace cap is checked BEFORE the global cap. If a workspace
// has its own budget AND this month's spend in that workspace meets
// or exceeds it, sends are blocked even if the global cap allows
// more. Useful for "this client gets $50/month" billing per project.

const WS_BUDGETS_KEY = "lcp.ai.usage.wsBudgetsUsd";

export function loadWsBudgets(): Record<string, number> {
  const parsed = getJson<Record<string, unknown>>(
    WS_BUDGETS_KEY,
    {},
    (p): p is Record<string, unknown> =>
      !!p && typeof p === "object" && !Array.isArray(p),
  );
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

export function saveWsBudgets(budgets: Record<string, number>) {
  const cleaned: Record<string, number> = {};
  for (const [k, v] of Object.entries(budgets)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) cleaned[k] = v;
  }
  if (Object.keys(cleaned).length > 0) setJson(WS_BUDGETS_KEY, cleaned);
  else lsRemove(WS_BUDGETS_KEY);
  notify();
}

export function setWsBudget(wsId: string, usd: number) {
  const cur = loadWsBudgets();
  if (usd > 0 && Number.isFinite(usd)) cur[wsId] = usd;
  else delete cur[wsId];
  saveWsBudgets(cur);
}

/** Sum spend in a single workspace this calendar month. */
export function thisMonthWorkspaceTotal(wsId: string, records?: UsageRecord[]): number {
  const list = records ?? loadUsage();
  const ymKey = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const key = ymKey(new Date());
  let sum = 0;
  for (const r of list) {
    if (r.wsId === wsId && ymKey(new Date(r.ts)) === key) sum += r.costUsd;
  }
  return sum;
}

/** Returns the cap that would be hit by the next turn — workspace
 *  cap takes precedence (if set + active for this wsId), then the
 *  global cap. Caller blocks the send if `exceeds`. */
export function wouldExceedHardCap(pending = 0, wsId?: string): {
  exceeds: boolean;
  cap: number;
  current: number;
  scope: "workspace" | "global" | "none";
} {
  if (wsId) {
    const wsBudgets = loadWsBudgets();
    const wsCap = wsBudgets[wsId] ?? 0;
    if (wsCap > 0) {
      const wsCurrent = thisMonthWorkspaceTotal(wsId);
      if (wsCurrent + pending >= wsCap) {
        return {
          exceeds: true,
          cap: wsCap,
          current: wsCurrent,
          scope: "workspace",
        };
      }
    }
  }
  const cap = loadHardCap();
  if (cap <= 0) return { exceeds: false, cap: 0, current: 0, scope: "none" };
  const current = thisMonthTotal();
  return {
    exceeds: current + pending >= cap,
    cap,
    current,
    scope: "global",
  };
}
