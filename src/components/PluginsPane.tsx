// Plugins tab — manage Claude Code plugin marketplaces (any GitHub repo
// with .claude-plugin/marketplace.json, including your own) and browse +
// install the plugins they offer.
//
// Reads marketplace state straight from Claude Code's own files:
//   ~/.claude/plugins/known_marketplaces.json   → added marketplaces
//   <installLocation>/.claude-plugin/marketplace.json → its plugins[]
// and drives add/install/remove through the `claude plugin …` CLI (which
// clones/validates repos and writes the correct settings scope).

import { useCallback, useEffect, useState } from "react";
import { claudePlugin, fs } from "../ipc";
import { error as toastError, success as toastSuccess } from "../notify";
import { confirm as dialogConfirm } from "../dialog";
import { Icon } from "./Icon";

interface Props {
  root: string;
}

type Scope = "user" | "project";

interface Marketplace {
  name: string;
  repo?: string;
  installLocation?: string;
}
interface AvailablePlugin {
  name: string;
  description?: string;
  category?: string;
}

function leniencyParse(stdout: string): Record<string, unknown>[] {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) return v as Record<string, unknown>[];
    if (v && typeof v === "object") {
      for (const val of Object.values(v)) {
        if (Array.isArray(val)) return val as Record<string, unknown>[];
      }
    }
  } catch {
    /* not json */
  }
  return [];
}

export function PluginsPane({ root }: Props) {
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([]);
  const [pluginsByMarket, setPluginsByMarket] = useState<
    Record<string, AvailablePlugin[]>
  >({});
  // "name@marketplace" → enabled. Presence = installed.
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [marketUrl, setMarketUrl] = useState("");
  const [scope, setScope] = useState<Scope>("user");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cliMissing, setCliMissing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { homeDir, join } = await import("@tauri-apps/api/path");
      const home = await homeDir();
      const knownPath = await join(
        home,
        ".claude",
        "plugins",
        "known_marketplaces.json",
      );
      // Marketplaces straight from Claude Code's own file (reliable shape).
      let mkts: Marketplace[] = [];
      try {
        const raw = await fs.readFile(knownPath.replace(/\\/g, "/"));
        const obj = JSON.parse(raw) as Record<string, unknown>;
        mkts = Object.entries(obj).map(([name, v]) => {
          const e = (v ?? {}) as Record<string, unknown>;
          const src = (e.source ?? {}) as Record<string, unknown>;
          return {
            name,
            repo: src.repo as string | undefined,
            installLocation: e.installLocation as string | undefined,
          };
        });
      } catch {
        /* no marketplaces file yet */
      }
      setMarketplaces(mkts);

      // Available plugins per marketplace from its cloned marketplace.json.
      const byMarket: Record<string, AvailablePlugin[]> = {};
      for (const m of mkts) {
        if (!m.installLocation) continue;
        try {
          const mpPath =
            m.installLocation.replace(/\\/g, "/") +
            "/.claude-plugin/marketplace.json";
          const raw = await fs.readFile(mpPath);
          const parsed = JSON.parse(raw) as { plugins?: Record<string, unknown>[] };
          byMarket[m.name] = (parsed.plugins ?? []).map((p) => ({
            name: String(p.name ?? ""),
            description: p.description as string | undefined,
            category: p.category as string | undefined,
          }));
        } catch {
          byMarket[m.name] = [];
        }
      }
      setPluginsByMarket(byMarket);

      // Installed plugins (best-effort schema) to mark install/enable state.
      try {
        const pl = await claudePlugin.run(["plugin", "list", "--json"], root);
        const map: Record<string, boolean> = {};
        for (const o of leniencyParse(pl.stdout)) {
          const name = (o.name as string) ?? (o.id as string);
          if (!name) continue;
          const mk = o.marketplace as string | undefined;
          const key = mk ? `${name}@${mk}` : name;
          map[key] = (o.enabled as boolean | undefined) ?? true;
        }
        setInstalled(map);
        setCliMissing(false);
      } catch {
        setCliMissing(true);
      }

      // Auto-expand when there's exactly one marketplace.
      setExpanded((cur) => cur ?? (mkts.length === 1 ? mkts[0].name : null));
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (args: string[], okMsg: string) => {
    setBusy(true);
    try {
      const scoped = scope === "project" ? [...args, "--scope", "project"] : args;
      const out = await claudePlugin.run(scoped, root);
      if (out.code === 0) toastSuccess(okMsg);
      else
        toastError((out.stderr || out.stdout || `Exited ${out.code}`).slice(0, 400));
      await refresh();
    } catch (e) {
      toastError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const addMarketplace = async () => {
    const v = marketUrl.trim();
    if (!v) {
      toastError("Enter a GitHub repo (owner/repo) or URL.");
      return;
    }
    await run(["plugin", "marketplace", "add", v], `Added marketplace ${v}`);
    setMarketUrl("");
  };

  const removeMarketplace = async (name: string) => {
    const ok = await dialogConfirm(`Remove marketplace "${name}"?`, {
      okLabel: "Remove",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;
    await run(["plugin", "marketplace", "remove", name], `Removed ${name}`);
  };

  const installPlugin = (pluginName: string, market: string) =>
    run(
      ["plugin", "install", `${pluginName}@${market}`],
      `Installed ${pluginName}`,
    );
  const uninstallPlugin = (pluginName: string, market: string) =>
    run(
      ["plugin", "uninstall", `${pluginName}@${market}`],
      `Uninstalled ${pluginName}`,
    );

  const q = query.trim().toLowerCase();

  return (
    <div className="cust-pane cust-pane-scroll">
      <div className="plugins-intro">
        Plugins bundle skills, commands, subagents, hooks, and MCP servers.
        Add any GitHub repo that's a Claude Code marketplace (a repo with{" "}
        <code>.claude-plugin/marketplace.json</code>) — including your own.
      </div>

      {cliMissing && (
        <div className="settings-row settings-row-note mcp-warning">
          <Icon name="alert-triangle" size={12} /> Claude Code CLI not found.
          Install it and run <code>claude /login</code>, then reopen this tab.
        </div>
      )}

      <div className="plugins-add">
        <input
          className="plugins-input"
          placeholder="owner/repo  ·  owner/repo@branch  ·  https://…"
          value={marketUrl}
          onChange={(e) => setMarketUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addMarketplace();
          }}
        />
        <div className="mcp-seg">
          {(["user", "project"] as const).map((s) => (
            <button
              key={s}
              className={`mcp-seg-btn ${scope === s ? "active" : ""}`}
              onClick={() => setScope(s)}
              title={
                s === "user"
                  ? "Available in every workspace"
                  : "This workspace's .claude/settings.json"
              }
            >
              {s}
            </button>
          ))}
        </div>
        <button
          className="cust-btn primary"
          disabled={busy}
          onClick={() => void addMarketplace()}
        >
          <Icon name="plus" size={12} /> Add
        </button>
      </div>

      <div className="mcp-section-head">Marketplaces</div>
      {loading && <div className="cust-empty">Loading…</div>}
      {!loading && marketplaces.length === 0 && !cliMissing && (
        <div className="settings-row settings-row-note">
          No marketplaces yet. Add one above — try{" "}
          <code>anthropics/claude-plugins-official</code>.
        </div>
      )}

      {marketplaces.map((m) => {
        const all = pluginsByMarket[m.name] ?? [];
        const list = q
          ? all.filter(
              (p) =>
                p.name.toLowerCase().includes(q) ||
                (p.description ?? "").toLowerCase().includes(q),
            )
          : all;
        const isOpen = expanded === m.name;
        const shown = list.slice(0, 100);
        return (
          <div key={m.name} className="plugins-market">
            <div className="plugins-market-head">
              <button
                className="plugins-market-toggle"
                onClick={() => {
                  setExpanded((cur) => (cur === m.name ? null : m.name));
                  setQuery("");
                }}
                aria-expanded={isOpen}
              >
                <Icon
                  name={isOpen ? "chevron-down" : "chevron-right"}
                  size={11}
                />
                <span className="plugins-market-name">{m.name}</span>
                <span className="plugins-market-count">{all.length}</span>
              </button>
              {m.repo && <span className="plugins-market-repo">{m.repo}</span>}
              <button
                className="mcp-remove-btn"
                disabled={busy}
                onClick={() =>
                  void run(
                    ["plugin", "marketplace", "update", m.name],
                    `Updated ${m.name}`,
                  )
                }
              >
                Update
              </button>
              <button
                className="mcp-remove-btn"
                disabled={busy}
                onClick={() => void removeMarketplace(m.name)}
              >
                Remove
              </button>
            </div>

            {isOpen && (
              <div className="plugins-list">
                {all.length > 8 && (
                  <div className="plugins-list-search">
                    <Icon name="search" size={12} />
                    <input
                      autoFocus
                      placeholder={`Search ${all.length} plugins…`}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    {query && (
                      <button
                        className="mcp-search-clear"
                        onClick={() => setQuery("")}
                        aria-label="Clear search"
                      >
                        <Icon name="x" size={11} />
                      </button>
                    )}
                  </div>
                )}
                {all.length === 0 && (
                  <div className="cust-empty">
                    No plugins listed in this marketplace.
                  </div>
                )}
                {list.length === 0 && all.length > 0 && (
                  <div className="cust-empty">No plugins match “{query}”.</div>
                )}
                {shown.map((p) => {
                  const key = `${p.name}@${m.name}`;
                  const isInstalled = key in installed || p.name in installed;
                  return (
                    <div key={p.name} className="plugins-item">
                      <div className="plugins-item-main">
                        <div className="plugins-item-top">
                          <span className="plugins-item-name">{p.name}</span>
                          {p.category && (
                            <span className="plugins-item-cat">{p.category}</span>
                          )}
                        </div>
                        {p.description && (
                          <div className="plugins-item-desc">{p.description}</div>
                        )}
                      </div>
                      {isInstalled ? (
                        <button
                          className="mcp-remove-btn"
                          disabled={busy}
                          onClick={() => void uninstallPlugin(p.name, m.name)}
                        >
                          Uninstall
                        </button>
                      ) : (
                        <button
                          className="cust-btn primary plugins-install"
                          disabled={busy}
                          onClick={() => void installPlugin(p.name, m.name)}
                        >
                          Install
                        </button>
                      )}
                    </div>
                  );
                })}
                {list.length > shown.length && (
                  <div className="cust-empty">
                    +{list.length - shown.length} more — refine your search.
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
