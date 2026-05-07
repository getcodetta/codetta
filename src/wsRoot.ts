// Typed shim for the workspace-root global the Claude Code provider needs
// at spawn time. AIChatPanel sets it on mount + when the active workspace
// root changes; the provider reads it just before invoking the Tauri
// claude_code_chat command. Lifting it out of an ad-hoc `(window as
// unknown as { __LCP_WS_ROOT?: string })` cast at every callsite — the
// cast was duplicated in two files, drift-prone, and silently broke the
// type system locally.

interface WindowWithWsRoot {
  __LCP_WS_ROOT?: string;
}

function w(): WindowWithWsRoot {
  if (typeof window === "undefined") return {};
  return window as unknown as WindowWithWsRoot;
}

export function setWorkspaceRoot(root: string | undefined): void {
  w().__LCP_WS_ROOT = root;
}

export function getWorkspaceRoot(): string | undefined {
  return w().__LCP_WS_ROOT;
}
