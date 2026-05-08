// Persistent store for user-saved AI prompt templates.
//
// Templates are tiny canned prompts ("Tighten this prose", "Add JSDoc
// to this function") that the user can fire from the command palette
// and have prefilled into the AI chat composer. Persisted in
// localStorage under a single key so it survives reloads without
// touching workspace state — these are user-scoped, not workspace-
// scoped.
//
// Storage shape: a JSON array of `AITemplate`. We seed three sensible
// defaults the first time the array is empty so the feature isn't a
// dead-end for new users; once the user has saved (or removed) any
// templates, we never re-seed.

export interface AITemplate {
  id: string;
  label: string;
  prompt: string;
}

const KEY = "lcp.aiTemplates";

const SEED_DEFAULTS: { label: string; prompt: string }[] = [
  {
    label: "Tighten this prose",
    prompt:
      "Tighten this writing without changing the meaning. Remove filler, prefer concrete verbs, keep the original voice.",
  },
  {
    label: "Add JSDoc to this function",
    prompt:
      "Add a concise JSDoc / TSDoc comment to this function. Document params, return, and any non-obvious side effects.",
  },
  {
    label: "Suggest a better name",
    prompt:
      "Propose 3 better names for this identifier. For each, briefly explain why.",
  },
];

type Listener = (templates: AITemplate[]) => void;
const listeners = new Set<Listener>();

function genId(): string {
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore — fall through to fallback */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readRaw(): AITemplate[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is AITemplate =>
        t &&
        typeof t === "object" &&
        typeof t.id === "string" &&
        typeof t.label === "string" &&
        typeof t.prompt === "string",
    );
  } catch {
    return [];
  }
}

function writeRaw(templates: AITemplate[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(templates));
  } catch {
    /* localStorage may be full or disabled — surface as a no-op */
  }
}

function notify(templates: AITemplate[]): void {
  for (const l of listeners) l(templates);
}

let seeded = false;

function ensureSeeded(): AITemplate[] {
  const existing = readRaw();
  if (existing.length > 0 || seeded) {
    seeded = true;
    return existing;
  }
  // Mark seeded BEFORE we write so a re-entrant call doesn't double-seed.
  seeded = true;
  const seeded_templates: AITemplate[] = SEED_DEFAULTS.map((d) => ({
    id: genId(),
    label: d.label,
    prompt: d.prompt,
  }));
  writeRaw(seeded_templates);
  return seeded_templates;
}

export function getTemplates(): AITemplate[] {
  return ensureSeeded();
}

export function addTemplate(label: string, prompt: string): AITemplate {
  const all = ensureSeeded();
  const t: AITemplate = { id: genId(), label, prompt };
  const next = [...all, t];
  writeRaw(next);
  notify(next);
  return t;
}

export function removeTemplate(id: string): void {
  const all = ensureSeeded();
  const next = all.filter((t) => t.id !== id);
  if (next.length === all.length) return;
  writeRaw(next);
  notify(next);
}

export function subscribeTemplates(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
