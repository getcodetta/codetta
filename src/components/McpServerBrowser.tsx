import { useEffect, useState } from "react";
import { claudeMcp, type McpServer } from "../ipc";
import { useStore } from "../store";
import { error as toastError, success as toastSuccess } from "../notify";
import { confirm as dialogConfirm } from "../dialog";

/**
 * Curated catalog of well-known MCP servers worth one-click installing.
 * Each entry is the canonical command/args pair; we add to either user
 * (~/.claude.json) or project (.mcp.json) scope based on user choice.
 *
 * Source: https://github.com/modelcontextprotocol/servers and the
 * widely-used 3rd-party servers.
 */
interface McpCatalogEntry {
  name: string;
  description: string;
  command: string;
  args: string[];
  /** Per-server hint about anything the user must set (path, token). */
  configHint?: string;
  /** Where the official docs live. */
  docsUrl?: string;
}

const CURATED: McpCatalogEntry[] = [
  {
    name: "filesystem",
    description: "Read / list files in a sandboxed directory",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "<path>"],
    configHint:
      "Replace <path> with an absolute directory you want Claude to access.",
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    name: "git",
    description: "Git operations (log, diff, branch, blame, …)",
    command: "uvx",
    args: ["mcp-server-git", "--repository", "<repo-path>"],
    configHint:
      "Replace <repo-path> with the absolute path to the repo. Requires `uv` installed.",
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
  },
  {
    name: "fetch",
    description: "HTTP requests (GET / POST a URL, return JSON or text)",
    command: "uvx",
    args: ["mcp-server-fetch"],
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    name: "github",
    description: "GitHub API — read/write issues, PRs, repos",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    configHint:
      "Set GITHUB_PERSONAL_ACCESS_TOKEN in env after install.",
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
  },
  {
    name: "puppeteer",
    description: "Browser automation — navigate, screenshot, scrape",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
  },
  {
    name: "sqlite",
    description: "Run SQL against a local SQLite database",
    command: "uvx",
    args: ["mcp-server-sqlite", "--db-path", "<path>"],
    configHint: "Replace <path> with the .db file path. Requires `uv`.",
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
  },
  {
    name: "postgres",
    description: "Read-only PostgreSQL queries",
    command: "npx",
    args: [
      "-y",
      "@modelcontextprotocol/server-postgres",
      "<connection-url>",
    ],
    configHint: "Replace <connection-url> with postgres://user:pass@host/db",
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
  },
];

export function McpServerBrowser() {
  const activeId = useStore((s) => s.activeId);
  const cwd = useStore((s) =>
    s.activeId ? s.loaded[s.activeId]?.meta.root : null,
  );
  const [installed, setInstalled] = useState<McpServer[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!cwd) return;
    try {
      const list = await claudeMcp.list(cwd);
      setInstalled(list);
    } catch (e) {
      toastError(`Failed to load MCP servers: ${e}`);
      setInstalled([]);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  if (!activeId || !cwd) {
    return (
      <div className="settings-row settings-row-note">
        Open a workspace to manage MCP servers (project-scoped configs
        live in <code>.mcp.json</code> at the workspace root).
      </div>
    );
  }

  const installedNames = new Set(installed?.map((s) => s.name));

  const install = async (entry: McpCatalogEntry, scope: "user" | "project") => {
    if (busy) return;
    setBusy(true);
    try {
      const target = await claudeMcp.add(
        cwd,
        entry.name,
        scope,
        entry.command,
        entry.args,
        {},
      );
      toastSuccess(
        `Added ${entry.name} (${scope}) → ${target}${entry.configHint ? ` · ${entry.configHint}` : ""}`,
      );
      await refresh();
    } catch (e) {
      toastError(`Install failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: McpServer) => {
    const ok = await dialogConfirm(
      `Remove MCP server "${s.name}" from ${s.scope} scope? Claude Code will lose access to its tools on the next session.`,
      {
        title: `Remove ${s.name}?`,
        okLabel: "Remove",
        cancelLabel: "Cancel",
        danger: true,
      },
    );
    if (!ok) return;
    try {
      await claudeMcp.remove(cwd, s.name, s.scope as "user" | "project");
      toastSuccess(`Removed ${s.name} (${s.scope})`);
      await refresh();
    } catch (e) {
      toastError(`Remove failed: ${e}`);
    }
  };

  return (
    <>
      <div className="mcp-section-head">Installed</div>
      {installed && installed.length === 0 && (
        <div className="settings-row settings-row-note">
          No MCP servers configured. Pick one from the catalog below to
          one-click install.
        </div>
      )}
      {installed && installed.length > 0 && (
        <div className="mcp-list">
          {installed.map((s) => (
            <div key={`${s.scope}:${s.name}`} className="mcp-row">
              <div className="mcp-row-main">
                <span className="mcp-name">{s.name}</span>
                <span className={`mcp-scope-badge mcp-scope-${s.scope}`}>
                  {s.scope}
                </span>
              </div>
              <div className="mcp-row-cmd">
                <code>
                  {s.command} {(s.args ?? []).join(" ")}
                </code>
              </div>
              <button
                className="mcp-remove-btn"
                onClick={() => void remove(s)}
                title={`Remove from ${s.scope} scope`}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      {installed &&
        hasShadowing(installed) && (
          <div className="settings-row settings-row-note mcp-warning">
            ⚠ A project-scope server is shadowing a user-scope one of
            the same name. Per{" "}
            <a
              href="https://github.com/anthropics/claude-code/issues/16728"
              target="_blank"
              rel="noopener noreferrer"
            >
              anthropics/claude-code#16728
            </a>
            , project entries silently override user entries — Claude
            Code will only run the project version.
          </div>
        )}

      <div className="mcp-section-head">Catalog</div>
      <div className="settings-row settings-row-note">
        One-click installs for popular MCP servers. <strong>User</strong>{" "}
        scope = available in every workspace; <strong>project</strong> scope
        = checked into <code>.mcp.json</code> for this workspace only
        (good for sharing with your team).
      </div>
      <div className="mcp-catalog">
        {CURATED.map((entry) => {
          const already = installedNames.has(entry.name);
          return (
            <div key={entry.name} className="mcp-cat-row">
              <div className="mcp-cat-main">
                <div className="mcp-cat-title">
                  <span className="mcp-name">{entry.name}</span>
                  {already && (
                    <span className="mcp-cat-installed">installed</span>
                  )}
                </div>
                <div className="mcp-cat-desc">{entry.description}</div>
                {entry.configHint && (
                  <div className="mcp-cat-hint">⚙ {entry.configHint}</div>
                )}
              </div>
              <div className="mcp-cat-actions">
                {entry.docsUrl && (
                  <a
                    href={entry.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mcp-cat-docs"
                  >
                    docs ↗
                  </a>
                )}
                <button
                  className="mcp-cat-install"
                  disabled={busy}
                  onClick={() => void install(entry, "user")}
                  title="Install for every workspace (~/.claude.json)"
                >
                  + User
                </button>
                <button
                  className="mcp-cat-install"
                  disabled={busy}
                  onClick={() => void install(entry, "project")}
                  title="Install for this workspace only (.mcp.json)"
                >
                  + Project
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function hasShadowing(list: McpServer[]): boolean {
  const seen = new Set<string>();
  for (const s of list) {
    if (s.scope === "user") seen.add(s.name);
  }
  return list.some((s) => s.scope === "project" && seen.has(s.name));
}
