// Diagnostics aggregator — wraps Monaco's marker stream so the rest of
// the app can read every problem across every open model without
// importing Monaco directly. Companion to src/components/DiagnosticsPanel.tsx.
//
// Only TypeScript / JavaScript produce markers out of the box (Monaco
// ships those language services in-process). Other languages will report
// nothing here unless an LSP/marker provider is registered separately.

export interface DiagnosticEntry {
  /** The Monaco model URI as a string — typically "file://..." or a
   *  raw path. The panel strips the "file://" prefix before opening. */
  uri: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  col: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  /** Owner + code, e.g. "ts(2304)". Useful as a tooltip hint. */
  source?: string;
}

type Listener = (entries: DiagnosticEntry[]) => void;

let _entries: DiagnosticEntry[] = [];
const listeners = new Set<Listener>();

// Track whether the Monaco subscription has been wired so we never
// register the listener twice (would cause double-fan-out).
let _wired = false;
let _wiring: Promise<void> | null = null;

// Map Monaco's MarkerSeverity ints to our string union. Monaco doesn't
// re-export the enum cleanly via the type-only import we want, so the
// mapping lives here as plain numbers (Error=8, Warning=4, Info=2, Hint=1).
function severityFromInt(s: number): DiagnosticEntry["severity"] {
  switch (s) {
    case 8:
      return "error";
    case 4:
      return "warning";
    case 2:
      return "info";
    case 1:
      return "hint";
    default:
      return "info";
  }
}

function notify() {
  for (const l of listeners) l(_entries);
}

async function ensureWired(): Promise<void> {
  if (_wired) return;
  if (_wiring) return _wiring;
  _wiring = (async () => {
    // Lazy import — keeps Monaco out of any code path that doesn't
    // actually need diagnostics (e.g. the headless test harness).
    const monaco = await import("monaco-editor");
    if (_wired) return; // raced
    _wired = true;

    const recollect = () => {
      const markers = monaco.editor.getModelMarkers({});
      const next: DiagnosticEntry[] = markers.map((m) => {
        const code =
          typeof m.code === "string"
            ? m.code
            : m.code && typeof m.code === "object" && "value" in m.code
              ? String((m.code as { value: unknown }).value)
              : undefined;
        const source =
          m.owner && code
            ? `${m.owner}(${code})`
            : (m.owner ?? code ?? undefined);
        return {
          uri: m.resource.toString(),
          line: m.startLineNumber,
          col: m.startColumn,
          severity: severityFromInt(m.severity),
          message: m.message,
          source,
        };
      });
      _entries = next;
      notify();
    };

    monaco.editor.onDidChangeMarkers(() => {
      recollect();
    });

    // Initial pull — markers may already exist from earlier-mounted models.
    recollect();
  })();
  return _wiring;
}

export function getDiagnostics(): DiagnosticEntry[] {
  // Trigger wiring on first read so callers don't have to remember to
  // bootstrap. Fire-and-forget — listeners will receive the populated
  // list as soon as Monaco resolves.
  void ensureWired();
  return _entries;
}

export function subscribeDiagnostics(cb: Listener): () => void {
  listeners.add(cb);
  void ensureWired();
  // Replay current snapshot so a freshly-mounted subscriber doesn't
  // sit empty until the next marker change.
  if (_entries.length > 0) {
    queueMicrotask(() => cb(_entries));
  }
  return () => {
    listeners.delete(cb);
  };
}
