// Shared form-row primitives for the Settings modal: the Section wrapper
// (which respects the side-TOC's active-section context), the Row pair
// label/value layout, the Toggle switch, the API-key reveal/edit row,
// and the three-way Allow/Ask/Deny tool-permission row.
//
// Pulled out of SettingsModal so sub-section components (AI privacy
// editor, AI usage dashboard, SFTP profiles editor, …) can live in
// their own files and import these bits, instead of staying inline in
// the giant 1600-line SettingsModal.

import { createContext, useContext, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getApiKey, setApiKey } from "../providers";
import type { ProviderId } from "../providers";
import {
  getToolPolicy,
  onToolPolicyChange,
  setToolPolicy,
  type ToolPermission,
  type ToolPolicy,
} from "../toolPermissions";

/**
 * Context so the Section component can read the currently-selected TOC
 * slug without prop-drilling through every section call site. The
 * SettingsModal sets the value; all Sections inside the provider read
 * it to decide whether to render their body. Empty string = "no slug
 * selected", which Section treats as "render everything" (the JSON
 * editor view, when the TOC isn't active).
 */
export const ActiveSectionContext = createContext<string>("");

export function Section({
  title,
  children,
  id,
}: {
  title: string;
  children: React.ReactNode;
  /** Stable slug auto-derived from the title when omitted; the TOC
   *  uses this for selection. */
  id?: string;
}) {
  const slug =
    id ??
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  // Read the currently-selected section from context. When it doesn't
  // match this section, render a marker div (so the TOC discovery still
  // finds us) but suppress the heavy children. The marker keeps the
  // data-section attribute the TOC needs.
  const activeSlug = useContext(ActiveSectionContext);
  const isActive = !activeSlug || activeSlug === slug;
  return (
    <div
      className={`settings-section ${isActive ? "is-active" : "is-hidden"}`}
      id={`settings-section-${slug}`}
      data-section={slug}
      data-title={title}
    >
      {isActive && (
        <>
          <div className="settings-section-title">{title}</div>
          <div className="settings-section-body">{children}</div>
        </>
      )}
    </div>
  );
}

export function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <span className="settings-row-label">{label}</span>
      {children}
    </div>
  );
}

export function ToolPermissionRow({
  label,
  hint,
  field,
}: {
  label: string;
  hint: string;
  field: keyof ToolPolicy;
}) {
  const [policy, setPolicy] = useState<ToolPolicy>(() => getToolPolicy());
  // Stay live: other rows and the chat's "Allow always" flow also write
  // the policy while this row is mounted.
  useEffect(() => onToolPolicyChange(() => setPolicy(getToolPolicy())), []);
  const setValue = (v: ToolPermission) => {
    // Patch a FRESH read. Persisting the mount-time snapshot used to
    // silently revert every other row changed in the same Settings
    // visit — set Write to Deny, change another row, and the Deny
    // un-set itself. Rows must never write a cached full policy.
    setToolPolicy({ ...getToolPolicy(), [field]: v });
  };
  const cur = policy[field];
  return (
    <div className="settings-row settings-row-multiline">
      <div className="settings-row-stack">
        <span className="settings-row-label">{label}</span>
        <span className="settings-row-sub">{hint}</span>
      </div>
      <div className="settings-segmented">
        {(["allow", "ask", "deny"] as ToolPermission[]).map((v) => (
          <button
            key={v}
            className={`segmented-btn ${cur === v ? "active" : ""}`}
            onClick={() => setValue(v)}
          >
            {v === "allow" ? "Allow" : v === "ask" ? "Ask" : "Deny"}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ApiKeyRow({
  providerId,
  displayName,
  helpUrl,
}: {
  providerId: ProviderId;
  displayName: string;
  helpUrl?: string;
}) {
  const [value, setValue] = useState(() => getApiKey(providerId));
  const [revealed, setRevealed] = useState(false);
  const masked = value
    ? value.length <= 8
      ? "•".repeat(value.length)
      : value.slice(0, 4) +
        "•".repeat(Math.max(4, value.length - 8)) +
        value.slice(-4)
    : "";
  return (
    <div className="settings-row">
      <span className="settings-row-label">{displayName} API key</span>
      <div className="settings-key-cell">
        <input
          type={revealed ? "text" : "password"}
          value={revealed ? value : value || ""}
          placeholder={value && !revealed ? masked : "(not set)"}
          onChange={(e) => {
            setValue(e.target.value);
            setApiKey(providerId, e.target.value);
          }}
          className="settings-key-input"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          className="settings-key-toggle"
          onClick={() => setRevealed((v) => !v)}
          title={revealed ? "Hide" : "Reveal"}
        >
          {revealed ? "🙈" : "👁"}
        </button>
        {helpUrl && (
          <button
            className="settings-key-help"
            onClick={() => void openUrl(helpUrl)}
            title="Get an API key"
          >
            Get key
          </button>
        )}
      </div>
    </div>
  );
}

export function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="settings-row">
      <span className="settings-row-label">{label}</span>
      <button
        className={`settings-toggle ${value ? "on" : ""}`}
        onClick={() => onChange(!value)}
        role="switch"
        aria-checked={value}
      >
        <span className="settings-toggle-knob" />
      </button>
    </div>
  );
}
