// Sidebar text-search panel — full-window equivalent of VS Code's
// search view. Companion to the Ctrl+Shift+F command-palette shortcut:
// the palette is faster for "I want one match", this panel is better
// for "I want to browse all 47 hits across 12 files".
//
// Backed by the same Rust `search_text` command the palette uses, so
// the case-sensitivity / binary-detection / heavy-dir-skip behaviour
// matches across both surfaces.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { search } from "../ipc";
import type { SearchHit } from "../ipc";
import { setEditorGoto } from "../editorState";
import { errMsg } from "../notify";
import { relPath } from "../pathUtils";

interface Props {
  wsId: string;
  root: string;
}

interface CacheEntry {
  query: string;
  caseSensitive: boolean;
  hits: SearchHit[];
  ranAt: number;
}

// Module-level cache keyed by root so switching to the search tab
// preserves the last query + results. Cleared on root change inside
// the panel's effect.
const lastResultByRoot = new Map<string, CacheEntry>();

const MAX_HITS = 500;
const DEBOUNCE_MS = 220;
const RENDER_INITIAL_GROUPS = 30;

export function SearchPanel({ wsId, root }: Props) {
  const cached = root ? lastResultByRoot.get(root) : undefined;
  const [query, setQuery] = useState(cached?.query ?? "");
  const [caseSensitive, setCaseSensitive] = useState(
    cached?.caseSensitive ?? false,
  );
  const [hits, setHits] = useState<SearchHit[]>(cached?.hits ?? []);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Guard against stale results from a slower scan landing after a
  // newer one. Same pattern as TodosPanel — id increments each call,
  // late returns get dropped.
  const scanIdRef = useRef(0);
  const mountedRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset state when the workspace root changes — a stale query / hits
  // from the previous workspace would mislead the user.
  useEffect(() => {
    setExpanded(false);
    const c = root ? lastResultByRoot.get(root) : undefined;
    setQuery(c?.query ?? "");
    setCaseSensitive(c?.caseSensitive ?? false);
    setHits(c?.hits ?? []);
    setError(null);
  }, [root]);

  const runSearch = useCallback(
    async (q: string, cs: boolean) => {
      if (!root || q.length === 0) {
        setHits([]);
        setError(null);
        setSearching(false);
        return;
      }
      const id = ++scanIdRef.current;
      setSearching(true);
      setError(null);
      try {
        const out = await search.searchText(root, q, cs, MAX_HITS);
        if (!mountedRef.current || scanIdRef.current !== id) return;
        setHits(out);
        lastResultByRoot.set(root, {
          query: q,
          caseSensitive: cs,
          hits: out,
          ranAt: Date.now(),
        });
      } catch (e) {
        if (!mountedRef.current || scanIdRef.current !== id) return;
        setHits([]);
        setError(errMsg(e));
      } finally {
        if (mountedRef.current && scanIdRef.current === id) {
          setSearching(false);
        }
      }
    },
    [root],
  );

  // Debounced search-on-type. Bails early for empty / single-char
  // queries so we don't hammer the workspace on every keystroke for
  // matches that would be too noisy to read anyway.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    const handle = window.setTimeout(() => {
      void runSearch(q, caseSensitive);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, caseSensitive, runSearch]);

  // Group hits by file, preserving the order Rust returned (which is
  // already sort-by-path inside the walker).
  const groups = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const h of hits) {
      const arr = map.get(h.path);
      if (arr) arr.push(h);
      else map.set(h.path, [h]);
    }
    return Array.from(map.entries());
  }, [hits]);

  const visibleGroups = expanded
    ? groups
    : groups.slice(0, RENDER_INITIAL_GROUPS);
  const hiddenGroupCount = groups.length - visibleGroups.length;

  const onHitClick = async (hit: SearchHit) => {
    await useStore.getState().openFile(wsId, hit.path);
    setEditorGoto(hit.line, hit.col);
  };

  const renderHitText = (text: string, q: string) => {
    // Highlight the first match of `q` in the line so the eye can
    // jump to it. Case-insensitive when the toggle is off; falls
    // back to plain text if the line was returned with no match
    // visible (column past the end, etc.).
    if (!q) return text;
    const haystack = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? q : q.toLowerCase();
    const idx = haystack.indexOf(needle);
    if (idx < 0) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="search-hit-mark">
          {text.slice(idx, idx + q.length)}
        </mark>
        {text.slice(idx + q.length)}
      </>
    );
  };

  const totalHits = hits.length;
  const fileCount = groups.length;
  const trimmed = query.trim();

  return (
    <div className="search-panel">
      <div className="search-panel-toolbar">
        <input
          ref={inputRef}
          type="text"
          className="search-panel-input"
          placeholder="Search workspace…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Workspace text search"
        />
        <button
          className={`search-panel-toggle ${caseSensitive ? "active" : ""}`}
          onClick={() => setCaseSensitive((v) => !v)}
          title={`Case ${caseSensitive ? "sensitive" : "insensitive"}`}
          aria-label={`Case sensitive: ${caseSensitive ? "on" : "off"}`}
          aria-pressed={caseSensitive}
        >
          Aa
        </button>
      </div>

      <div className="search-panel-status">
        {searching && trimmed.length >= 2 && "Searching…"}
        {!searching && trimmed.length === 0 && "Type at least 2 characters."}
        {!searching && trimmed.length === 1 && "Keep typing…"}
        {!searching &&
          trimmed.length >= 2 &&
          totalHits === 0 &&
          !error &&
          "No matches."}
        {!searching && totalHits > 0 && (
          <>
            {totalHits === MAX_HITS ? `${MAX_HITS}+ matches` : `${totalHits} matches`}
            {" in "}
            {fileCount} file{fileCount === 1 ? "" : "s"}
          </>
        )}
        {error && <span className="search-panel-error"> · {error}</span>}
      </div>

      <div className="search-panel-results">
        {visibleGroups.map(([path, items]) => (
          <div key={path} className="search-panel-group">
            <div className="search-panel-group-head" title={path}>
              <span className="search-panel-group-name">
                {relPath(path, root) || path}
              </span>
              <span className="search-panel-group-count">{items.length}</span>
            </div>
            {items.map((h, i) => (
              <button
                key={`${h.path}:${h.line}:${h.col}:${i}`}
                className="search-panel-hit"
                onClick={() => void onHitClick(h)}
                title={`${h.path}:${h.line}:${h.col}`}
              >
                <span className="search-panel-hit-line">{h.line}</span>
                <span className="search-panel-hit-text">
                  {renderHitText(h.text, trimmed)}
                </span>
              </button>
            ))}
          </div>
        ))}
        {hiddenGroupCount > 0 && (
          <button
            className="search-panel-show-more"
            onClick={() => setExpanded(true)}
          >
            Show {hiddenGroupCount} more file
            {hiddenGroupCount === 1 ? "" : "s"}…
          </button>
        )}
      </div>
    </div>
  );
}
