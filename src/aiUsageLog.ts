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
}

interface WriteableUsageRecord {
  provider: string;
  model: string;
  costUsd: number;
  tokensIn?: number;
  tokensOut?: number;
  wsId?: string;
  chatId?: string;
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
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r: unknown): r is UsageRecord =>
        !!r &&
        typeof r === "object" &&
        typeof (r as UsageRecord).ts === "number" &&
        typeof (r as UsageRecord).provider === "string" &&
        typeof (r as UsageRecord).model === "string" &&
        typeof (r as UsageRecord).costUsd === "number",
    );
  } catch {
    return [];
  }
}

function saveUsage(records: UsageRecord[]) {
  try {
    // Keep the most recent N — append at end, trim from front.
    const trimmed =
      records.length > MAX_RECORDS
        ? records.slice(records.length - MAX_RECORDS)
        : records;
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    /* localStorage full — best-effort */
  }
}

/** Append one usage record. Skips zero-cost zero-token records to
 *  avoid filling the log with noise from no-op providers. */
export function recordUsage(r: WriteableUsageRecord) {
  if ((r.costUsd ?? 0) === 0 && (r.tokensIn ?? 0) === 0 && (r.tokensOut ?? 0) === 0) {
    return;
  }
  const all = loadUsage();
  all.push({
    ts: Date.now(),
    provider: r.provider,
    model: r.model,
    costUsd: r.costUsd,
    tokensIn: r.tokensIn ?? 0,
    tokensOut: r.tokensOut ?? 0,
    wsId: r.wsId,
    chatId: r.chatId,
  });
  saveUsage(all);
  notify();
}

export function clearUsage() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
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
  try {
    const raw = localStorage.getItem(HARD_CAP_KEY);
    const n = raw ? parseFloat(raw) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function saveHardCap(usd: number) {
  try {
    if (usd > 0 && Number.isFinite(usd)) {
      localStorage.setItem(HARD_CAP_KEY, String(usd));
    } else {
      localStorage.removeItem(HARD_CAP_KEY);
    }
  } catch {
    /* ignore */
  }
  notify();
}

/** Returns the cap if it would be exceeded (or already is) by an
 *  incoming turn of estimated cost `pending`. Caller decides what
 *  to do (block + toast, prompt for confirmation, etc.). */
export function wouldExceedHardCap(pending = 0): {
  exceeds: boolean;
  cap: number;
  current: number;
} {
  const cap = loadHardCap();
  if (cap <= 0) return { exceeds: false, cap: 0, current: 0 };
  const current = thisMonthTotal();
  return { exceeds: current + pending >= cap, cap, current };
}
