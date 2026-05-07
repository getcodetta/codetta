// Per-user log of recently-run palette commands. Used by the
// CommandPalette to reorder the default-mode list so frequently-
// invoked commands surface near the top instead of being buried in
// alphabetical noise.
//
// Storage shape: { [commandId]: { lastUsed: epoch_ms, count: number } }
// We weight the score with a recency-decayed count so a command run
// 50 times last week loses to one run 5 times today.
//
// Capped at HISTORY_LIMIT entries — the rarely-used long tail rolls
// off rather than dragging localStorage open every keystroke.

import { getJson, setJson } from "./localStore";

const KEY = "lcp.commandHistory.v1";
const HISTORY_LIMIT = 60;
// Half-life (ms) used by the recency decay. 7 days means a command
// run a week ago counts ~half as much as one run today; chosen to
// match a typical "what am I working on this week" rhythm.
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

interface Entry {
  lastUsed: number;
  count: number;
}

type Map = Record<string, Entry>;

function load(): Map {
  const raw = getJson<Record<string, unknown>>(KEY, {}, (v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
  const out: Map = {};
  for (const [id, v] of Object.entries(raw)) {
    if (
      v &&
      typeof v === "object" &&
      typeof (v as Entry).lastUsed === "number" &&
      typeof (v as Entry).count === "number"
    ) {
      out[id] = { lastUsed: (v as Entry).lastUsed, count: (v as Entry).count };
    }
  }
  return out;
}

function save(map: Map): void {
  // Trim to HISTORY_LIMIT, dropping the lowest-scored entries first
  // so a recent rare command doesn't get evicted by an old common one.
  const ids = Object.keys(map);
  if (ids.length > HISTORY_LIMIT) {
    const now = Date.now();
    const scored = ids.map((id) => ({ id, score: scoreEntry(map[id], now) }));
    scored.sort((a, b) => b.score - a.score);
    const keep = scored.slice(0, HISTORY_LIMIT);
    const trimmed: Map = {};
    for (const { id } of keep) trimmed[id] = map[id];
    map = trimmed;
  }
  setJson(KEY, map);
}

function scoreEntry(entry: Entry, now: number): number {
  const age = now - entry.lastUsed;
  // Exponential decay: 2^(-age / half-life). Using 0.5 ** keeps the
  // arithmetic simple and avoids importing Math.exp.
  const decay = Math.pow(0.5, age / HALF_LIFE_MS);
  return entry.count * decay;
}

let _cache: Map | null = null;
function getMap(): Map {
  if (_cache) return _cache;
  _cache = load();
  return _cache;
}

export function recordCommand(id: string): void {
  const map = getMap();
  const existing = map[id];
  if (existing) {
    existing.lastUsed = Date.now();
    existing.count += 1;
  } else {
    map[id] = { lastUsed: Date.now(), count: 1 };
  }
  save(map);
}

/**
 * Score a command id for default-mode sorting. Higher = closer to the
 * top of the palette. Returns 0 when the id has never been run, so
 * unseen commands fall through to whatever ordering the caller already
 * has.
 */
export function scoreCommand(id: string): number {
  const map = getMap();
  const entry = map[id];
  if (!entry) return 0;
  return scoreEntry(entry, Date.now());
}
