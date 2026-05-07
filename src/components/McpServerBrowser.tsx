import { useEffect, useState } from "react";
import { claudeMcp, type McpServer } from "../ipc";
import { useStore } from "../store";
import { error as toastError, errMsg, success as toastSuccess } from "../notify";
import { confirm as dialogConfirm, prompt as dialogPrompt } from "../dialog";

/**
 * Curated catalog of well-known MCP servers worth one-click installing.
 * Each entry is the canonical command/args pair; we add to either user
 * (~/.claude.json) or project (.mcp.json) scope based on user choice.
 *
 * Source: https://github.com/modelcontextprotocol/servers and the
 * widely-used 3rd-party servers.
 */
interface McpPlaceholder {
  /** Literal token in args / env that the user-supplied value replaces. */
  token: string;
  /** Human-readable prompt label, e.g. "Directory path". */
  label: string;
  /** Optional default to pre-fill the input with. */
  default?: string;
  /** Optional one-line validator: returns null if OK, error string if bad. */
  validate?: (v: string) => string | null;
}

interface McpCatalogEntry {
  name: string;
  /** One-emoji icon shown on the card. Keeps it visual without needing
   *  per-server SVGs. */
  icon: string;
  description: string;
  command: string;
  args: string[];
  /** Optional env vars baked into the install. Same placeholder substitution. */
  env?: Record<string, string>;
  /**
   * Required user inputs. Each placeholder's `token` (e.g. "<path>")
   * gets replaced in args and env values with the user's input. We
   * prompt for these BEFORE the install, so we never write a broken
   * config full of literal placeholder strings to the user's
   * ~/.claude.json (which is what the v0.2.0 install path did).
   */
  placeholders?: McpPlaceholder[];
  /** Optional one-line note about post-install setup (env vars, etc.) */
  postInstallNote?: string;
  /** Where the official docs live. */
  docsUrl?: string;
}

const isAbsPath = (v: string): string | null => {
  // Accept both POSIX (/foo/bar) and Windows (C:\foo) absolute paths.
  if (/^([a-zA-Z]:[\\/]|\/)/.test(v.trim())) return null;
  return "Use an absolute path (e.g. C:\\Users\\you\\code or /home/you/code)";
};

const CURATED: McpCatalogEntry[] = [
  {
    name: "filesystem",
    icon: "📁",
    description: "Read / list files in a sandboxed directory",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "<path>"],
    placeholders: [
      {
        token: "<path>",
        label: "Directory the agent can access (absolute path)",
        validate: isAbsPath,
      },
    ],
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    name: "git",
    icon: "⎇",
    description: "Git operations (log, diff, branch, blame, …)",
    command: "uvx",
    args: ["mcp-server-git", "--repository", "<repo-path>"],
    placeholders: [
      {
        token: "<repo-path>",
        label: "Path to the git repo (absolute)",
        validate: isAbsPath,
      },
    ],
    postInstallNote: "Requires `uv` installed (pip install uv).",
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
  },
  {
    name: "fetch",
    icon: "🌐",
    description: "HTTP requests (GET / POST a URL, return JSON or text)",
    command: "uvx",
    args: ["mcp-server-fetch"],
    postInstallNote: "Requires `uv` installed (pip install uv).",
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    name: "github",
    icon: "🐙",
    description: "GitHub API — read/write issues, PRs, repos",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "<token>" },
    placeholders: [
      {
        token: "<token>",
        label: "GitHub personal access token (https://github.com/settings/tokens)",
        validate: (v) =>
          v.startsWith("ghp_") || v.startsWith("github_pat_")
            ? null
            : "Token should start with 'ghp_' or 'github_pat_'",
      },
    ],
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
  },
  {
    name: "puppeteer",
    icon: "🎭",
    description: "Browser automation — navigate, screenshot, scrape",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
  },
  {
    name: "sqlite",
    icon: "🗄",
    description: "Run SQL against a local SQLite database",
    command: "uvx",
    args: ["mcp-server-sqlite", "--db-path", "<path>"],
    placeholders: [
      {
        token: "<path>",
        label: "Path to the .db file (absolute)",
        validate: isAbsPath,
      },
    ],
    postInstallNote: "Requires `uv` installed (pip install uv).",
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
  },
  {
    name: "postgres",
    icon: "🐘",
    description: "Read-only PostgreSQL queries",
    command: "npx",
    args: [
      "-y",
      "@modelcontextprotocol/server-postgres",
      "<connection-url>",
    ],
    placeholders: [
      {
        token: "<connection-url>",
        label: "Postgres connection URL (postgres://user:pass@host:port/db)",
        validate: (v) =>
          /^postgres(?:ql)?:\/\//.test(v.trim())
            ? null
            : "Must start with postgres:// or postgresql://",
      },
    ],
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
  },
];

/**
 * Walk an args list (and optional env map) replacing every placeholder
 * token with the user-supplied value. Pure function — easy to test.
 */
function substitute(
  args: string[],
  env: Record<string, string> | undefined,
  values: Record<string, string>,
): { args: string[]; env: Record<string, string> } {
  const replaceAll = (s: string): string => {
    let out = s;
    for (const [token, value] of Object.entries(values)) {
      out = out.split(token).join(value);
    }
    return out;
  };
  return {
    args: args.map(replaceAll),
    env: Object.fromEntries(
      Object.entries(env ?? {}).map(([k, v]) => [k, replaceAll(v)]),
    ),
  };
}

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
      toastError(`Failed to load MCP servers: ${errMsg(e)}`);
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

  // Map name -> set of scopes it's installed in. Lets the catalog
  // badge say "user", "project", or "both" instead of an opaque
  // "installed".
  const scopesByName = new Map<string, Set<"user" | "project">>();
  for (const s of installed ?? []) {
    if (s.scope !== "user" && s.scope !== "project") continue;
    if (!scopesByName.has(s.name)) scopesByName.set(s.name, new Set());
    scopesByName.get(s.name)!.add(s.scope);
  }

  const install = async (entry: McpCatalogEntry, scope: "user" | "project") => {
    if (busy) return;

    // Prompt for any placeholder values BEFORE writing anything to
    // disk, so we never persist a config full of literal "<path>" /
    // "<token>" strings (the v0.2.0 install path's bug — Claude Code
    // would then spawn the literal string as an argument).
    const values: Record<string, string> = {};
    for (const ph of entry.placeholders ?? []) {
      const v = await dialogPrompt(
        `${ph.label}\n\n(Installing ${entry.name} → ${scope} scope)`,
        ph.default ?? "",
        {
          title: `${entry.name}: configure`,
          okLabel: "Next",
          cancelLabel: "Cancel install",
        },
      );
      if (v === null) return; // user cancelled — don't half-install
      const trimmed = v.trim();
      if (!trimmed) {
        toastError(`${ph.label} can't be empty.`);
        return;
      }
      const err = ph.validate ? ph.validate(trimmed) : null;
      if (err) {
        toastError(`${entry.name}: ${err}`);
        return;
      }
      values[ph.token] = trimmed;
    }

    const { args, env } = substitute(entry.args, entry.env, values);

    setBusy(true);
    try {
      const target = await claudeMcp.add(
        cwd,
        entry.name,
        scope,
        entry.command,
        args,
        env,
      );
      toastSuccess(
        `Added ${entry.name} (${scope}) → ${target}` +
          (entry.postInstallNote ? ` · ${entry.postInstallNote}` : ""),
      );
      await refresh();
    } catch (e) {
      toastError(`Install failed: ${errMsg(e)}`);
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
      toastError(`Remove failed: ${errMsg(e)}`);
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
          const scopes = scopesByName.get(entry.name);
          const inUser = !!scopes?.has("user");
          const inProject = !!scopes?.has("project");
          const inBoth = inUser && inProject;
          const needsConfig = (entry.placeholders?.length ?? 0) > 0;
          const status = inBoth
            ? { cls: "both", label: "both scopes", title: "Installed in both user and project. Project config silently overrides user (anthropics/claude-code#16728)." }
            : inUser
              ? { cls: "user", label: "user", title: "Installed in your user config (~/.claude.json) — available in every workspace." }
              : inProject
                ? { cls: "project", label: "project", title: "Installed in this workspace's .mcp.json — applies only here." }
                : null;
          return (
            <div
              key={entry.name}
              className={`mcp-card ${status ? "mcp-card-installed" : ""}`}
            >
              <div className="mcp-card-head">
                <span className="mcp-card-icon" aria-hidden>
                  {entry.icon}
                </span>
                <div className="mcp-card-title-wrap">
                  <span className="mcp-card-name">{entry.name}</span>
                  {entry.docsUrl && (
                    <a
                      href={entry.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mcp-card-docs"
                      title="Open official docs"
                    >
                      docs ↗
                    </a>
                  )}
                </div>
                {status && (
                  <span
                    className={`mcp-card-status mcp-card-status-${status.cls}`}
                    title={status.title}
                  >
                    ✓ {status.label}
                  </span>
                )}
              </div>

              <div className="mcp-card-desc">{entry.description}</div>

              {(needsConfig || entry.postInstallNote) && (
                <div className="mcp-card-meta">
                  {needsConfig && (
                    <span className="mcp-card-meta-chip">
                      ⚙ asks for{" "}
                      {(entry.placeholders ?? [])
                        .map((p) => p.label.split(/[\s(,]/)[0].toLowerCase())
                        .join(" + ")}
                    </span>
                  )}
                  {entry.postInstallNote && (
                    <span className="mcp-card-meta-chip mcp-card-meta-warn">
                      ⓘ {entry.postInstallNote}
                    </span>
                  )}
                </div>
              )}

              <div className="mcp-card-actions">
                <button
                  className={`mcp-card-btn ${inUser ? "mcp-card-btn-reinstall" : "mcp-card-btn-install"}`}
                  disabled={busy}
                  onClick={() => void install(entry, "user")}
                  title={
                    inUser
                      ? "Reinstall in user scope — overwrites the existing config (you'll be re-prompted for any required values)."
                      : "Install for every workspace (~/.claude.json)"
                  }
                >
                  <span className="mcp-card-btn-icon">
                    {inUser ? "↻" : "+"}
                  </span>
                  User
                </button>
                <button
                  className={`mcp-card-btn ${inProject ? "mcp-card-btn-reinstall" : "mcp-card-btn-install"}`}
                  disabled={busy}
                  onClick={() => void install(entry, "project")}
                  title={
                    inProject
                      ? "Reinstall in project scope — overwrites .mcp.json (you'll be re-prompted for any required values)."
                      : "Install for this workspace only (.mcp.json — checked into git)"
                  }
                >
                  <span className="mcp-card-btn-icon">
                    {inProject ? "↻" : "+"}
                  </span>
                  Project
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
