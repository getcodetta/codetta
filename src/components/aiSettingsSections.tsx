// Two of the larger SettingsModal sub-sections: AI privacy editor +
// AI usage dashboard. Pulled out so the giant SettingsModal file
// shrinks and so each section's state + render lives next to its own
// concerns. They share the Section / Row / Toggle primitives via
// settingsBits.tsx.

import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_EXCLUSIONS,
  effectivePatterns,
  loadPrivacySettings,
  matchExclusion,
  savePrivacySettings,
} from "../aiPrivacy";
import {
  clearUsage,
  loadHardCap,
  loadLogPrompts,
  loadUsage,
  loadWsBudgets,
  saveHardCap,
  saveLogPrompts,
  setWsBudget,
  subscribeUsage,
  summarizeByMonth,
  thisMonthTotal,
  thisMonthWorkspaceTotal,
  type UsageRecord,
} from "../aiUsageLog";
import { confirm as dialogConfirm } from "../dialog";
import { search } from "../ipc";
import { useStore } from "../store";
import { detectFrameworks, type DetectedFramework } from "../projectDetect";
import { errMsg } from "../notify";
import { Row, Toggle } from "./settingsBits";

export function AIPrivacyEditor() {
  const [settings, setSettings] = useState(() => loadPrivacySettings());
  const [draft, setDraft] = useState("");
  const [test, setTest] = useState("");
  const [detected, setDetected] = useState<DetectedFramework[]>([]);
  const [detectError, setDetectError] = useState<string | null>(null);
  const activeId = useStore((s) => s.activeId);
  const activeRoot = useStore((s) =>
    s.activeId ? s.loaded[s.activeId]?.meta.root ?? null : null,
  );

  const persist = (next: typeof settings) => {
    setSettings(next);
    savePrivacySettings(next);
  };

  // Scan the active workspace for framework markers so we can suggest
  // stack-specific privacy patterns. Re-runs when the workspace changes
  // OR when the user adds/removes patterns (so the suggestion list
  // hides items as soon as they're applied). Bounded at 600 files —
  // marker detection only needs the early walker output.
  useEffect(() => {
    if (!activeRoot) {
      setDetected([]);
      setDetectError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const files = await search.listFiles(activeRoot, 600);
        if (cancelled) return;
        // Strip the workspace root prefix so the detector sees relative
        // paths — its regexes are anchored at workspace-relative root.
        const root = activeRoot.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
        const rel = files.map((f) => {
          const norm = f.replace(/\\/g, "/");
          return norm.startsWith(root) ? norm.slice(root.length) : norm;
        });
        setDetected(detectFrameworks(rel, settings.patterns));
        setDetectError(null);
      } catch (e) {
        if (cancelled) return;
        setDetected([]);
        setDetectError(errMsg(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeRoot, settings.patterns]);

  const applySuggestion = (fw: DetectedFramework) => {
    const merged = [...settings.patterns];
    for (const p of fw.patterns) if (!merged.includes(p)) merged.push(p);
    persist({ ...settings, patterns: merged });
  };

  const applyAllSuggestions = () => {
    const merged = [...settings.patterns];
    for (const fw of detected) {
      for (const p of fw.patterns) if (!merged.includes(p)) merged.push(p);
    }
    persist({ ...settings, patterns: merged });
  };

  const addPattern = () => {
    const p = draft.trim();
    if (!p) return;
    if (settings.patterns.includes(p)) {
      setDraft("");
      return;
    }
    persist({ ...settings, patterns: [...settings.patterns, p] });
    setDraft("");
  };

  const removePattern = (p: string) => {
    persist({
      ...settings,
      patterns: settings.patterns.filter((x) => x !== p),
    });
  };

  // Live test: enter a path, see whether the current effective list
  // would exclude it (and which pattern matched).
  const testMatch = test
    ? matchExclusion(test, effectivePatterns(settings))
    : null;
  const effective = effectivePatterns(settings);

  return (
    <>
      <div className="settings-row settings-row-note">
        Files matching any of these globs are <strong>never</strong> sent
        to any AI provider — Claude Code's Read/Edit/Write/MultiEdit/
        NotebookEdit tool calls are denied with an explanation, the
        chat panel skips them when expanding <code>/file</code>, and a
        warning banner appears when an excluded file is the active
        editor buffer.
      </div>

      <Toggle
        label="Enable AI privacy exclusions"
        value={settings.enabled}
        onChange={(v) => persist({ ...settings, enabled: v })}
      />

      {settings.enabled && (
        <>
          <Toggle
            label="Include built-in defaults (.env, .ssh keys, secrets/, .aws/, etc.)"
            value={settings.useDefaults}
            onChange={(v) => persist({ ...settings, useDefaults: v })}
          />

          {settings.useDefaults && (
            <div className="settings-row settings-row-note">
              Built-in patterns ({DEFAULT_EXCLUSIONS.length}):{" "}
              {DEFAULT_EXCLUSIONS.map((p, i) => (
                <span key={p}>
                  <code>{p}</code>
                  {i < DEFAULT_EXCLUSIONS.length - 1 ? ", " : ""}
                </span>
              ))}
            </div>
          )}

          {activeId && detected.length > 0 && (
            <>
              <div className="cc-allow-subhead">
                Suggested for this project
                {detected.length > 1 && (
                  <button
                    className="privacy-suggest-apply-all"
                    onClick={applyAllSuggestions}
                    title="Add every suggested pattern from every detected framework"
                  >
                    Add all ({detected.reduce((n, fw) => n + fw.patterns.length, 0)})
                  </button>
                )}
              </div>
              <div className="settings-row settings-row-note">
                Detected{" "}
                {detected.map((fw, i) => (
                  <span key={fw.id}>
                    <strong>{fw.label}</strong>
                    {i < detected.length - 1 ? ", " : ""}
                  </span>
                ))}{" "}
                — these stack-specific patterns aren't in the defaults
                but tend to leak the same kind of secret data.
              </div>
              {detected.map((fw) => (
                <div key={fw.id} className="privacy-suggest-group">
                  <div className="privacy-suggest-group-head">
                    <span className="privacy-suggest-group-name">
                      {fw.label}
                    </span>
                    <button
                      className="privacy-suggest-add"
                      onClick={() => applySuggestion(fw)}
                      title={`Add ${fw.patterns.length} ${fw.label} pattern${fw.patterns.length === 1 ? "" : "s"} to your exclusion list`}
                    >
                      + Add {fw.patterns.length}
                    </button>
                  </div>
                  <div className="privacy-suggest-patterns">
                    {fw.patterns.map((p) => (
                      <code key={p} className="privacy-suggest-pattern">
                        {p}
                      </code>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
          {activeId && detectError && (
            <div className="settings-row settings-row-note">
              Couldn't scan workspace for framework hints: {detectError}
            </div>
          )}

          <div className="cc-allow-subhead">Your patterns</div>
          <div className="cc-allow-list">
            {settings.patterns.length === 0 ? (
              <div className="settings-row settings-row-note">
                No custom patterns. Use the input below to add one
                (git-style globs: <code>**/*.token</code>,{" "}
                <code>secrets/**</code>, <code>internal/**/*.ts</code>).
              </div>
            ) : (
              settings.patterns.map((p) => (
                <div key={p} className="cc-allow-row">
                  <code className="cc-allow-name">{p}</code>
                  <button
                    className="cc-allow-remove"
                    onClick={() => removePattern(p)}
                    title={`Stop excluding ${p}`}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>

          <Row label="Add pattern">
            <div style={{ display: "flex", gap: 6, width: "100%" }}>
              <input
                className="sftp-field"
                value={draft}
                placeholder="**/*.token"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addPattern();
                }}
              />
              <button
                className="sftp-btn sftp-btn-primary"
                onClick={addPattern}
                disabled={!draft.trim()}
              >
                Add
              </button>
            </div>
          </Row>

          <Row label="Test a path">
            <input
              className="sftp-field"
              value={test}
              placeholder="C:/Users/me/project/.env  →  see if it's excluded"
              onChange={(e) => setTest(e.target.value)}
            />
          </Row>
          {test && (
            <div
              className={`sftp-profile-test ${
                testMatch ? "sftp-profile-test-fail" : "sftp-profile-test-ok"
              }`}
            >
              {testMatch
                ? `✗ Blocked — matches pattern: ${testMatch}`
                : `✓ Not excluded — would be sent to AI`}
            </div>
          )}

          <div className="settings-row settings-row-note">
            {effective.length} effective pattern
            {effective.length === 1 ? "" : "s"} active.
          </div>
        </>
      )}
    </>
  );
}

export function AIUsageDashboard() {
  const [records, setRecords] = useState<UsageRecord[]>(() => loadUsage());
  const [cap, setCap] = useState<string>(() => {
    const v = loadHardCap();
    return v > 0 ? v.toString() : "";
  });
  const [logPrompts, setLogPrompts] = useState<boolean>(() => loadLogPrompts());
  const [wsBudgets, setWsBudgets] = useState<Record<string, number>>(() =>
    loadWsBudgets(),
  );
  const [openPromptIdx, setOpenPromptIdx] = useState<number | null>(null);
  const loadedWorkspaces = useStore((s) => s.loaded);

  useEffect(
    () =>
      subscribeUsage(() => {
        setRecords(loadUsage());
        setWsBudgets(loadWsBudgets());
      }),
    [],
  );

  const months = useMemo(() => summarizeByMonth(records), [records]);
  const thisMonth = useMemo(() => thisMonthTotal(records), [records]);
  const recent = useMemo(() => records.slice(-12).reverse(), [records]);

  // Workspace summary table — list any workspace currently loaded OR
  // any workspace that has either a budget OR recorded usage this
  // month, so caps and history don't disappear when a workspace is
  // closed.
  const wsSummary = useMemo(() => {
    const ids = new Set<string>();
    for (const k of Object.keys(loadedWorkspaces)) ids.add(k);
    for (const k of Object.keys(wsBudgets)) ids.add(k);
    for (const r of records) if (r.wsId) ids.add(r.wsId);
    return Array.from(ids).map((wsId) => ({
      wsId,
      name: loadedWorkspaces[wsId]?.meta?.name ?? "(closed workspace)",
      budget: wsBudgets[wsId] ?? 0,
      thisMonth: thisMonthWorkspaceTotal(wsId, records),
    }));
  }, [loadedWorkspaces, wsBudgets, records]);

  const persistCap = (next: string) => {
    setCap(next);
    const n = parseFloat(next);
    saveHardCap(Number.isFinite(n) && n > 0 ? n : 0);
  };

  const toggleLogPrompts = (v: boolean) => {
    setLogPrompts(v);
    saveLogPrompts(v);
  };

  const persistWsBudget = (wsId: string, next: string) => {
    const n = parseFloat(next);
    setWsBudget(wsId, Number.isFinite(n) && n > 0 ? n : 0);
    setWsBudgets(loadWsBudgets());
  };

  const capNum = parseFloat(cap);
  const capActive = Number.isFinite(capNum) && capNum > 0;
  const pctOfCap = capActive ? Math.min(100, (thisMonth / capNum) * 100) : 0;

  return (
    <>
      <div className="settings-row settings-row-note">
        Cross-chat ledger of every AI turn that produced a measurable
        cost. Used to enforce a monthly hard cap and show what's
        being spent where.{" "}
        <strong>Prompt + response contents are not stored</strong> —
        only timestamps, models, costs, and token counts.
      </div>

      <div className="ai-usage-summary">
        <div className="ai-usage-stat">
          <span className="ai-usage-num">${thisMonth.toFixed(2)}</span>
          <span className="ai-usage-lbl">This month</span>
        </div>
        <div className="ai-usage-stat">
          <span className="ai-usage-num">{records.length}</span>
          <span className="ai-usage-lbl">Logged turns (lifetime)</span>
        </div>
        <div className="ai-usage-stat">
          <span className="ai-usage-num">
            ${months.reduce((s, m) => s + m.total, 0).toFixed(2)}
          </span>
          <span className="ai-usage-lbl">Lifetime total</span>
        </div>
      </div>

      <Row label="Monthly hard cap (USD)">
        <div className="cc-budget-input">
          <span className="cc-budget-prefix">$</span>
          <input
            type="number"
            min="0"
            step="0.50"
            placeholder="0  (no cap)"
            value={cap}
            onChange={(e) => persistCap(e.target.value)}
            className="cc-budget-field"
          />
          <span className="cc-budget-suffix">USD</span>
        </div>
      </Row>
      {capActive && (
        <div className="ai-usage-bar">
          <div
            className="ai-usage-bar-fill"
            style={{
              width: `${pctOfCap}%`,
              background:
                pctOfCap >= 100
                  ? "#dc4646"
                  : pctOfCap >= 80
                    ? "#ffb061"
                    : "var(--accent)",
            }}
          />
        </div>
      )}
      <div className="settings-row settings-row-note">
        When this month's spend reaches the cap, new AI turns are
        blocked with a toast. Raise the cap or delete it to continue.
        Distinct from the per-chat warning budget below — that just
        toasts; this one stops sends.
      </div>

      {months.length > 0 && (
        <>
          <div className="cc-allow-subhead">By month</div>
          <div className="ai-usage-months">
            {months.slice(0, 6).map((m) => (
              <div key={m.month} className="ai-usage-month-row">
                <span className="ai-usage-month-name">{m.month}</span>
                <span className="ai-usage-month-total">
                  ${m.total.toFixed(2)}
                </span>
                <span className="ai-usage-month-detail">
                  {m.turns} turn{m.turns === 1 ? "" : "s"} ·{" "}
                  {(m.tokensIn + m.tokensOut).toLocaleString()} tokens
                </span>
                <span className="ai-usage-month-providers">
                  {Object.entries(m.perProvider)
                    .filter(([, v]) => v > 0)
                    .sort((a, b) => b[1] - a[1])
                    .map(([p, v]) => `${p} $${v.toFixed(2)}`)
                    .join(" · ") || "free"}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="cc-allow-subhead">Per-workspace budgets</div>
      <div className="settings-row settings-row-note">
        Per-workspace caps take precedence over the global cap above.
        Useful for "this client gets $50/month" billing per project.
        Workspaces show even when closed if they have a budget set or
        recorded usage this month.
      </div>
      {wsSummary.length === 0 ? (
        <div className="settings-row settings-row-note">
          No workspaces with usage or budget yet.
        </div>
      ) : (
        <div className="ai-usage-ws">
          {wsSummary.map((w) => (
            <div key={w.wsId} className="ai-usage-ws-row">
              <div className="ai-usage-ws-meta">
                <strong>{w.name}</strong>
                <span>{w.wsId}</span>
              </div>
              <div className="ai-usage-ws-spend">
                ${w.thisMonth.toFixed(2)}
                <span> spent this month</span>
              </div>
              <div className="cc-budget-input">
                <span className="cc-budget-prefix">$</span>
                <input
                  type="number"
                  min="0"
                  step="0.50"
                  placeholder="no cap"
                  value={w.budget > 0 ? String(w.budget) : ""}
                  onChange={(e) => persistWsBudget(w.wsId, e.target.value)}
                  className="cc-budget-field"
                />
                <span className="cc-budget-suffix">/mo</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="cc-allow-subhead">Prompt audit log</div>
      <Toggle
        label="Log full prompt text in audit trail"
        value={logPrompts}
        onChange={toggleLogPrompts}
      />
      <div className="settings-row settings-row-note">
        OFF (default) — only ts / provider / model / cost / tokens are
        logged.
        <br />
        ON — the user prompt for each turn is also stored (truncated to
        1500 chars) so the recent-turns list shows previews and a "View"
        button. Older entries written before this toggle aren't
        backfilled.
      </div>

      {recent.length > 0 && (
        <>
          <div className="cc-allow-subhead">Recent turns</div>
          <div className="ai-usage-recent">
            {recent.map((r, i) => (
              <div key={r.ts + ":" + i}>
                <div className="ai-usage-recent-row">
                  <span className="ai-usage-recent-ts">
                    {new Date(r.ts).toLocaleString()}
                  </span>
                  <span className="ai-usage-recent-model">
                    <code>
                      {r.provider}:{r.model}
                    </code>
                  </span>
                  <span className="ai-usage-recent-tokens">
                    {(r.tokensIn + r.tokensOut).toLocaleString()} tok
                  </span>
                  <span className="ai-usage-recent-cost">
                    {r.costUsd > 0 ? `$${r.costUsd.toFixed(4)}` : "free"}
                  </span>
                </div>
                {r.prompt && (
                  <div className="ai-usage-recent-prompt">
                    <button
                      className="ai-usage-recent-prompt-toggle"
                      onClick={() =>
                        setOpenPromptIdx(openPromptIdx === i ? null : i)
                      }
                    >
                      {openPromptIdx === i ? "▾" : "▸"} {r.prompt.slice(0, 90)}
                      {r.prompt.length > 90 ? "…" : ""}
                    </button>
                    {openPromptIdx === i && (
                      <pre className="ai-usage-recent-prompt-full">
                        {r.prompt}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="settings-row">
        <button
          className="cc-allow-clear"
          onClick={async () => {
            const ok = await dialogConfirm(
              "Delete the entire AI usage log? This is local-only, but you'll lose monthly history.",
              {
                title: "Clear usage log",
                okLabel: "Delete",
                cancelLabel: "Cancel",
                danger: true,
              },
            );
            if (ok) clearUsage();
          }}
        >
          Clear log
        </button>
      </div>
    </>
  );
}
