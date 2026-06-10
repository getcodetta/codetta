// Per-file commit history ("File History…" in the file tree and
// source-control context menus). Lists the last 50 commits touching a
// file (git log --follow, so renames don't truncate the story);
// clicking a commit opens a read-only diff of that file at the commit
// vs its parent in the editor area. Modal chrome follows the
// git-commit-modal pattern in SourceControlPanel.

import { useEffect, useRef, useState } from "react";
import { git as gitApi, type GitCommit } from "../ipc";
import { requestDiff } from "../editorState";
import { error as toastError, errMsg } from "../notify";
import { langOf } from "../langDetect";
import { useModalFocus } from "../useModalFocus";
import { Icon } from "./Icon";

function authorInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatRelative(unixSec: number): string {
  const now = Date.now() / 1000;
  const ago = now - unixSec;
  if (ago < 60) return "just now";
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  if (ago < 86400 * 7) return `${Math.floor(ago / 86400)}d ago`;
  if (ago < 86400 * 30) return `${Math.floor(ago / (86400 * 7))}w ago`;
  return new Date(unixSec * 1000).toLocaleDateString();
}

interface Props {
  /** Repo root (workspace root) all git commands run against. */
  root: string;
  /** Repo-relative path of the file, forward slashes. */
  relPath: string;
  onClose: () => void;
}

export function FileHistoryModal({ root, relPath, onClose }: Props) {
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(cardRef, true);

  useEffect(() => {
    let cancelled = false;
    gitApi
      .fileLog(root, relPath, 50)
      .then((list) => {
        if (!cancelled) setCommits(list);
      })
      .catch((e) => {
        if (!cancelled) {
          setCommits([]);
          setLoadError(errMsg(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [root, relPath]);

  // Esc closes — same scoping as the commit-detail modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const openDiffAt = async (c: GitCommit) => {
    try {
      // git_show returns "" for missing-at-ref files, so the first
      // commit of a file (no ~1 side) diffs cleanly against empty.
      const original = await gitApi.show(root, `${c.full_hash}~1`, relPath);
      const modified = await gitApi.show(root, c.full_hash, relPath);
      requestDiff({
        path: relPath,
        refspec: `${c.hash}~1 vs ${c.hash}`,
        originalContent: original,
        modifiedContent: modified,
        language: langOf(relPath),
      });
      // The diff opens behind the backdrop — close so it's visible.
      onClose();
    } catch (e) {
      toastError(`Diff failed: ${errMsg(e)}`);
    }
  };

  return (
    <div className="git-commit-modal" onMouseDown={onClose}>
      <div
        ref={cardRef}
        tabIndex={-1}
        className="git-commit-card git-file-history-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-file-history-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="git-commit-card-head">
          <span className="git-commit-title" id="git-file-history-title">
            File History — {relPath}
          </span>
          <button
            className="git-commit-close"
            onClick={onClose}
            aria-label="Close file history"
            title="Close (Esc)"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="git-commit-card-meta">
          Last {commits?.length ?? 0} commits touching this file (follows
          renames) · click a commit to see its diff
        </div>
        <div className="git-history-list git-file-history-list">
          {commits === null && (
            <div className="git-history-empty">Loading…</div>
          )}
          {commits !== null && commits.length === 0 && (
            <div className="git-history-empty">
              {loadError ?? "No commits found for this file."}
            </div>
          )}
          {(commits ?? []).map((c) => (
            <button
              key={c.full_hash}
              className="git-history-row"
              onClick={() => void openDiffAt(c)}
              title={`${c.subject}\n\n${c.author_name} <${c.author_email}>\n${c.full_hash}`}
            >
              <span
                className="git-history-avatar"
                aria-hidden="true"
                title={c.author_name}
              >
                {authorInitials(c.author_name)}
              </span>
              <span className="git-history-meta">
                <span className="git-history-subject">{c.subject}</span>
                <span className="git-history-sub">
                  <span className="git-history-hash">{c.hash}</span>
                  <span className="git-history-author">{c.author_name}</span>
                  <span className="git-history-time">
                    {formatRelative(c.timestamp)}
                  </span>
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
