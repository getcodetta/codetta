// Two small chat-panel cards extracted from AIChatPanel:
//
//   - PermissionCard: legacy inline permission prompt for the Ollama /
//     OpenAI tool-execution loop (Codetta runs the tool itself there
//     and asks the user before doing it). Distinct from
//     ClaudePermissionOverlay, which is the Claude-Code-CLI hook flow.
//
//   - PrivacyBanner: warning shown above the chat input when the
//     currently-focused editor file matches an AI privacy exclusion
//     glob. Pure read of aiPrivacy state — re-renders on subscribePrivacy
//     so Settings edits land immediately without remounting the panel.
//
// Both are tiny presentational components; pulled out of the 4000-line
// chat panel so adding a new permission action / refining the banner
// copy doesn't need to touch the giant file.
import { useEffect, useState } from "react";
import type { ToolCall } from "../ai";
import { matchExclusion, subscribePrivacy } from "../aiPrivacy";
import { openSettings } from "../settingsBus";
import { Icon } from "./Icon";
import {
  extractPathArg,
  rememberToolAlways,
  rememberToolPath,
} from "../toolPermissions";

export function PermissionCard({
  call,
  onResolve,
}: {
  call: ToolCall;
  onResolve: (decision: "allow" | "deny") => void;
}) {
  const args = call.function.arguments;
  const path = extractPathArg(args);
  const argsSummary = Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 200)}`)
    .join(", ");
  return (
    <div className="ai-perm-card">
      <div className="ai-perm-head">
        <span className="ai-perm-icon">🔒</span>
        <span className="ai-perm-title">Permission needed</span>
      </div>
      <div className="ai-perm-body">
        <div className="ai-perm-row">
          <span className="ai-perm-label">Tool</span>
          <code className="ai-perm-tool">{call.function.name}</code>
        </div>
        {argsSummary && (
          <div className="ai-perm-row">
            <span className="ai-perm-label">Args</span>
            <code className="ai-perm-args">{argsSummary}</code>
          </div>
        )}
      </div>
      <div className="ai-perm-actions">
        <button
          className="ai-perm-btn ai-perm-btn-primary"
          onClick={() => onResolve("allow")}
          title="Run this call only"
        >
          <Icon name="check" size={12} />
          <span>Allow once</span>
        </button>
        <button
          className="ai-perm-btn"
          onClick={() => {
            rememberToolAlways(call.function.name);
            onResolve("allow");
          }}
          title={`Auto-allow every future ${call.function.name} call`}
        >
          <Icon name="check" size={12} />
          <span>Allow always ({call.function.name})</span>
        </button>
        {path && (
          <button
            className="ai-perm-btn"
            onClick={() => {
              rememberToolPath(call.function.name, path);
              onResolve("allow");
            }}
            title={`Auto-allow ${call.function.name} calls for this exact path`}
          >
            <Icon name="check" size={12} />
            <span>Allow this path</span>
          </button>
        )}
        <button
          className="ai-perm-btn ai-perm-btn-danger"
          onClick={() => onResolve("deny")}
          title="Reject this call — the model will see a denial message"
        >
          <Icon name="x" size={12} />
          <span>Deny</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Renders an inline warning when the active editor file matches an AI
 * privacy exclusion. The privacy gate in ClaudePermissionOverlay also
 * blocks the actual tool call, but the banner gives the user context
 * BEFORE they type a prompt that would have been declined.
 */
export function PrivacyBanner({
  activeFilePath,
}: {
  activeFilePath: string | null;
}) {
  // Recompute when privacy settings change (Settings → save).
  const [, setTick] = useState(0);
  useEffect(() => {
    return subscribePrivacy(() => setTick((n) => n + 1));
  }, []);
  if (!activeFilePath) return null;
  const matched = matchExclusion(activeFilePath);
  if (!matched) return null;
  const fileName = activeFilePath.split(/[\\/]/).pop() ?? activeFilePath;
  return (
    <div className="ai-privacy-banner" role="status">
      <span className="ai-privacy-icon">🛡</span>
      <div className="ai-privacy-text">
        <strong>{fileName}</strong> is on your AI privacy exclusion list.
        AI tools can't read or edit it (matches <code>{matched}</code>).
      </div>
      <button
        className="ai-privacy-settings"
        onClick={() => openSettings()}
        title="Open privacy settings"
      >
        Manage
      </button>
    </div>
  );
}
