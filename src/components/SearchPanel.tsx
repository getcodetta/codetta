// Sidebar text-search panel — full-window equivalent of VS Code's
// search view. Companion to the Ctrl+Shift+F command-palette shortcut:
// the palette is faster for "I want one match", this panel is better
// for "I want to browse all 47 hits across 12 files".
//
// Backed by the same Rust `search_text` command the palette uses, so
// the case-sensitivity / binary-detection / heavy-dir-skip behaviour
// matches across both surfaces.
//
// Replace mode: toggling the chevron reveals a replacement input. Each
// hit gets a per-line replace dot and each file group gets "Replace all
// in this file"; a header button runs the replacement across every
// match in every file. We do the rewrite ourselves on the frontend
// (read file → string-replace → write) instead of routing through Rust
// because the existing fs.writeFile already goes through the atomic
// writer, and keeping the replace logic next to the search UI lets us
// preview pending changes inline.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { fs, search } from "../ipc";
import type { SearchHit } from "../ipc";
import { setEditorGoto } from "../editorState";
import { confirm as dialogConfirm } from "../dialog";
import { errMsg, error as toastError, success as toastSuccess } from "../notify";
import { relPath } from "../pathUtils";
import { Icon } from "./Icon";

interface Props {
  wsId: string;
  root: string;
}

interface CacheEntry {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  includeGlobs: string;
  excludeGlobs: string;
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
  const [regex, setRegex] = useState(cached?.regex ?? false);
  // File-pattern filters: shown only when filesOpen is on. Stored as
  // newline-separated strings for multi-line input UX, split into a
  // string[] when sent to Rust.
  const [filesOpen, setFilesOpen] = useState(
    !!(cached?.includeGlobs || cached?.excludeGlobs),
  );
  const [includeGlobs, setIncludeGlobs] = useState(cached?.includeGlobs ?? "");
  const [excludeGlobs, setExcludeGlobs] = useState(cached?.excludeGlobs ?? "");

  function splitGlobs(raw: string): string[] {
    return raw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const [hits, setHits] = useState<SearchHit[]>(cached?.hits ?? []);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Replace mode: hidden by default to keep the search-only flow clean.
  // The replacement string is intentionally NOT cached across panel
  // mounts — a stale "replace foo with bar" carrying over from another
  // workspace is a footgun.
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [replacing, setReplacing] = useState(false);
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
    setRegex(c?.regex ?? false);
    setIncludeGlobs(c?.includeGlobs ?? "");
    setExcludeGlobs(c?.excludeGlobs ?? "");
    setFilesOpen(!!(c?.includeGlobs || c?.excludeGlobs));
    setHits(c?.hits ?? []);
    setError(null);
  }, [root]);

  const runSearch = useCallback(
    async (q: string, cs: boolean, useRegex: boolean) => {
      if (!root || q.length === 0) {
        setHits([]);
        setError(null);
        setSearching(false);
        return;
      }
      const id = ++scanIdRef.current;
      setSearching(true);
      setError(null);
      const inc = splitGlobs(includeGlobs);
      const exc = splitGlobs(excludeGlobs);
      try {
        const out = useRegex
          ? await search.searchRegex(
              root,
              q,
              cs,
              MAX_HITS,
              inc.length > 0 ? inc : undefined,
              exc.length > 0 ? exc : undefined,
            )
          : await search.searchText(
              root,
              q,
              cs,
              MAX_HITS,
              inc.length > 0 ? inc : undefined,
              exc.length > 0 ? exc : undefined,
            );
        if (!mountedRef.current || scanIdRef.current !== id) return;
        setHits(out);
        lastResultByRoot.set(root, {
          query: q,
          caseSensitive: cs,
          regex: useRegex,
          includeGlobs,
          excludeGlobs,
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
    [root, includeGlobs, excludeGlobs],
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
      void runSearch(q, caseSensitive, regex);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, caseSensitive, regex, includeGlobs, excludeGlobs, runSearch]);

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
    // visible (column past the end, etc.). When replace mode is
    // active, also render the replacement preview struck-through-
    // on-the-original-+-inserted-after style so the user sees what
    // each line will become.
    if (!q) return text;
    let idx = -1;
    let matchLen = 0;
    if (regex) {
      try {
        const re = new RegExp(q, caseSensitive ? "" : "i");
        const m = re.exec(text);
        if (m) {
          idx = m.index;
          matchLen = m[0].length;
        }
      } catch {
        // Bad regex — render plain text. The status row already shows
        // the compile error from the server-side attempt.
        return text;
      }
    } else {
      const haystack = caseSensitive ? text : text.toLowerCase();
      const needle = caseSensitive ? q : q.toLowerCase();
      idx = haystack.indexOf(needle);
      matchLen = needle.length;
    }
    if (idx < 0) return text;
    const matchSlice = text.slice(idx, idx + matchLen);
    const showReplaceMark = replaceOpen && replacement;
    // For regex mode, expand $1..$n backrefs against this specific
    // match by running .replace() on the matched substring. Wrap in a
    // try because a malformed replacement string can throw — fall
    // back to the literal replacement text if so.
    let previewReplacement = replacement;
    if (showReplaceMark && regex) {
      try {
        const re = new RegExp(q, caseSensitive ? "" : "i");
        previewReplacement = matchSlice.replace(re, replacement);
      } catch {
        previewReplacement = replacement;
      }
    }
    return (
      <>
        {text.slice(0, idx)}
        <mark
          className={`search-hit-mark ${
            showReplaceMark ? "search-hit-mark-replaced" : ""
          }`}
        >
          {matchSlice}
        </mark>
        {showReplaceMark && (
          <mark className="search-hit-mark-replacement">
            {previewReplacement}
          </mark>
        )}
        {text.slice(idx + matchLen)}
      </>
    );
  };

  // Replace `query` with `replacement` in `content`, honouring the
  // current case-sensitivity + regex toggles. Returns the new content
  // + the number of matches replaced. Pure — used both for the per-
  // file executor below and for preview rendering.
  //
  // In regex mode the replacement string follows JS RegExp.replace
  // semantics — $1..$9 backreferences, $& whole match, $$ literal
  // dollar sign. The pattern is compiled with the global flag so a
  // single .replace() call rewrites every match in the file. Bad
  // patterns return a zero-count result; the caller's UI flow already
  // surfaces compile errors via the search status row, so the replace
  // path doesn't need to throw here.
  //
  // Caveat: the search side compiles patterns with Rust's regex crate,
  // the replace side uses the JavaScript RegExp engine. They overlap on
  // the common subset (anchors, character classes, quantifiers, \d \w
  // \s) but a few edge cases differ — JS supports lookahead/backref
  // and Rust doesn't, Rust supports \A/\z and JS doesn't. For the
  // patterns most users actually write (no lookbehind or named groups)
  // both engines agree. A pattern that searches with one but fails to
  // compile with the other would be visible immediately as zero
  // replaced.
  const applyReplaceToContent = useCallback(
    (content: string, q: string, repl: string) => {
      if (!q) return { next: content, count: 0 };
      if (regex) {
        try {
          const re = new RegExp(q, caseSensitive ? "g" : "gi");
          // Two-pass: count first, then replace. We pass `repl` as a
          // STRING (not a function) so JS expands $1..$9 / $& / $$
          // backreferences natively — String.replace's function
          // replacer doesn't perform that expansion. Cost is one extra
          // O(n) pass over the file content, which is fine on the file-
          // size cap we already enforce upstream.
          const matches = content.match(re);
          const count = matches ? matches.length : 0;
          const next = count > 0 ? content.replace(re, repl) : content;
          return { next, count };
        } catch {
          return { next: content, count: 0 };
        }
      }
      let count = 0;
      let next = "";
      let cursor = 0;
      const haystack = caseSensitive ? content : content.toLowerCase();
      const needle = caseSensitive ? q : q.toLowerCase();
      while (cursor <= content.length) {
        const idx = haystack.indexOf(needle, cursor);
        if (idx < 0) {
          next += content.slice(cursor);
          break;
        }
        next += content.slice(cursor, idx) + repl;
        cursor = idx + q.length;
        count++;
      }
      return { next, count };
    },
    [caseSensitive, regex],
  );

  const replaceInFiles = useCallback(
    async (paths: string[]) => {
      if (replacing) return;
      const q = query.trim();
      if (!q || replacement === q) return;
      const ok = await dialogConfirm(
        `Replace "${q}" with "${replacement}" in ${paths.length} file${paths.length === 1 ? "" : "s"}?\n\nThis writes to disk immediately. Use git or your editor's undo to roll back.`,
        {
          title: "Replace across files",
          okLabel: `Replace in ${paths.length}`,
          cancelLabel: "Cancel",
          danger: true,
        },
      );
      if (!ok) return;
      setReplacing(true);
      let totalReplaced = 0;
      let filesChanged = 0;
      const failures: string[] = [];
      try {
        for (const p of paths) {
          try {
            const content = await fs.readFile(p);
            const { next, count } = applyReplaceToContent(content, q, replacement);
            if (count === 0 || next === content) continue;
            await fs.writeFile(p, next);
            totalReplaced += count;
            filesChanged++;
          } catch (e) {
            failures.push(`${relPath(p, root) || p}: ${errMsg(e)}`);
          }
        }
        if (failures.length > 0) {
          toastError(
            `Replaced ${totalReplaced} in ${filesChanged}, ${failures.length} failed (see console)`,
          );
          for (const f of failures) console.warn("[replace]", f);
        } else {
          toastSuccess(
            `Replaced ${totalReplaced} occurrence${totalReplaced === 1 ? "" : "s"} in ${filesChanged} file${filesChanged === 1 ? "" : "s"}`,
          );
        }
        // Re-run the search so the (now-empty) hits clear from the UI
        // and any remaining matches in still-unprocessed files appear.
        // Use the current toggle state since both literal and regex
        // replace are supported now.
        void runSearch(q, caseSensitive, regex);
      } finally {
        setReplacing(false);
      }
    },
    [
      applyReplaceToContent,
      caseSensitive,
      query,
      regex,
      replacement,
      replacing,
      root,
      runSearch,
    ],
  );

  const totalHits = hits.length;
  const fileCount = groups.length;
  const trimmed = query.trim();
  // Regex replace honours JS-style $1/$2/$& backreferences. Equality
  // check skipped in regex mode because "(.+)" / "$1" is a perfectly
  // valid no-op-ish replacement that we still want to allow.
  const canReplace =
    replaceOpen &&
    !replacing &&
    trimmed.length > 0 &&
    (regex || replacement !== trimmed) &&
    totalHits > 0;

  return (
    <div className="search-panel">
      <div className="search-panel-toolbar">
        <button
          className={`search-panel-replace-toggle ${replaceOpen ? "open" : ""}`}
          onClick={() => setReplaceOpen((v) => !v)}
          title={replaceOpen ? "Hide replace" : "Show replace"}
          aria-label={replaceOpen ? "Hide replace" : "Show replace"}
          aria-expanded={replaceOpen}
        >
          <Icon name={replaceOpen ? "chevron-down" : "chevron-right"} size={14} />
        </button>
        <div className="search-panel-inputs">
          <input
            ref={inputRef}
            type="text"
            className="search-panel-input"
            placeholder="Search workspace…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Workspace text search"
          />
          {replaceOpen && (
            <input
              type="text"
              className="search-panel-input"
              placeholder="Replace with…"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              aria-label="Replacement text"
            />
          )}
        </div>
        <button
          className={`search-panel-toggle ${caseSensitive ? "active" : ""}`}
          onClick={() => setCaseSensitive((v) => !v)}
          title={`Case ${caseSensitive ? "sensitive" : "insensitive"}`}
          aria-label={`Case sensitive: ${caseSensitive ? "on" : "off"}`}
          aria-pressed={caseSensitive}
        >
          Aa
        </button>
        <button
          className={`search-panel-toggle ${regex ? "active" : ""}`}
          onClick={() => setRegex((v) => !v)}
          title={
            regex
              ? "Regex mode (Rust regex syntax — Perl-ish without lookahead/backrefs)"
              : "Literal substring mode"
          }
          aria-label={`Regex: ${regex ? "on" : "off"}`}
          aria-pressed={regex}
        >
          .*
        </button>
        <button
          className={`search-panel-toggle ${filesOpen || includeGlobs || excludeGlobs ? "active" : ""}`}
          onClick={() => setFilesOpen((v) => !v)}
          title="Include / exclude file patterns"
          aria-label={`File patterns: ${filesOpen ? "shown" : "hidden"}`}
          aria-pressed={filesOpen}
        >
          {"{}"}
        </button>
      </div>
      {filesOpen && (
        <div className="search-panel-globs">
          <input
            type="text"
            className="search-panel-input"
            placeholder="Include — e.g. src/**, **/*.ts (comma or newline)"
            value={includeGlobs}
            onChange={(e) => setIncludeGlobs(e.target.value)}
            aria-label="Include file patterns"
          />
          <input
            type="text"
            className="search-panel-input"
            placeholder="Exclude — e.g. **/*.test.ts, dist/**"
            value={excludeGlobs}
            onChange={(e) => setExcludeGlobs(e.target.value)}
            aria-label="Exclude file patterns"
          />
        </div>
      )}
      {canReplace && (
        <div className="search-panel-replace-actions">
          <button
            className="search-panel-replace-all"
            onClick={() =>
              void replaceInFiles(groups.map(([p]) => p))
            }
            disabled={replacing}
            title={`Replace ${totalHits} occurrence${totalHits === 1 ? "" : "s"} in ${fileCount} file${fileCount === 1 ? "" : "s"}`}
          >
            <Icon name="rotate-ccw" size={12} />
            <span>
              {replacing
                ? "Replacing…"
                : `Replace all (${totalHits} in ${fileCount})`}
            </span>
          </button>
        </div>
      )}

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
              {canReplace && (
                <button
                  className="search-panel-group-replace"
                  onClick={() => void replaceInFiles([path])}
                  disabled={replacing}
                  title={`Replace ${items.length} occurrence${items.length === 1 ? "" : "s"} in this file`}
                  aria-label={`Replace in ${relPath(path, root) || path}`}
                >
                  <Icon name="rotate-ccw" size={12} />
                </button>
              )}
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
