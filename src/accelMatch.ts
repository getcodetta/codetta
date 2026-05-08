// Pure accelerator string matcher.
//
// Parses an accelerator like "Ctrl+Shift+T", "Alt+Z", "F11", "Ctrl+`", "Ctrl+,"
// and returns true iff a KeyboardEvent matches it exactly.
//
// Precedence rules:
//  1. "Ctrl" in an accel string matches `e.ctrlKey OR e.metaKey` so the same
//     accel works on both Windows/Linux (Ctrl) and macOS (Cmd). This mirrors
//     how the existing keydown handler in App.tsx treats the two.
//  2. The match is STRICT about modifiers: an accel without "Shift" rejects
//     events where Shift is held. Otherwise `accel: "Ctrl+S"` would also fire
//     on Ctrl+Shift+S, swallowing the Save All shortcut.
//  3. The key portion is normalised to lowercase for letters but compared
//     verbatim for symbols (`=`, `-`, `,`, `.`, `` ` ``, `+`, `0`) and F-keys
//     (`F1`..`F12`).
//  4. "+" inside the accel is the separator. The literal `+` key is allowed
//     as the final segment because we split off the last `+` only when the
//     remaining string still has content.

export function accelMatches(
  accel: string | undefined,
  e: KeyboardEvent,
): boolean {
  if (!accel) return false;

  // Split on "+" but treat a trailing literal "+" as the key.
  // "Ctrl++" -> ["Ctrl", "+"], "Ctrl+=" -> ["Ctrl", "="].
  const parts: string[] = [];
  let buf = "";
  for (let i = 0; i < accel.length; i++) {
    const ch = accel[i];
    if (ch === "+" && buf.length > 0 && i < accel.length - 1) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) parts.push(buf);
  if (parts.length === 0) return false;

  const keyPart = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());

  const wantCtrl = mods.includes("ctrl") || mods.includes("cmd") || mods.includes("meta");
  const wantShift = mods.includes("shift");
  const wantAlt = mods.includes("alt") || mods.includes("option");

  // Treat ctrlKey OR metaKey as "ctrl" for the purposes of matching, so
  // the same accel works cross-platform.
  const haveCtrl = e.ctrlKey || e.metaKey;
  const haveShift = e.shiftKey;
  const haveAlt = e.altKey;

  if (wantCtrl !== haveCtrl) return false;
  if (wantShift !== haveShift) return false;
  if (wantAlt !== haveAlt) return false;

  // Now compare the key. F-keys are case-sensitive ("F1" not "f1") in the
  // KeyboardEvent.key spec; everything else we lowercase for letter keys.
  if (/^F([1-9]|1[0-2])$/.test(keyPart)) {
    return e.key === keyPart;
  }

  // Single-char comparison: lowercase both sides so Shift+letter still
  // matches on the letter (the wantShift check above already gates that).
  return e.key.toLowerCase() === keyPart.toLowerCase();
}

/**
 * Canonicalize an accel string so two equivalent specs compare equal.
 * Used by the chord dispatcher to compare a stored "leading combo"
 * against the leading half parsed at lookup time. Lowercases, sorts
 * modifiers in a fixed order (ctrl, shift, alt, meta), keeps the
 * trailing key as-is (lowercased).
 */
export function normalizeAccel(s: string): string {
  // Same Ctrl++ / trailing-+ split rule as accelMatches so a leading
  // like "Ctrl++" round-trips through normalize and still matches.
  const parts: string[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "+" && buf.length > 0 && i < s.length - 1) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) parts.push(buf);
  const mods: string[] = [];
  let key = "";
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const lower = parts[i].toLowerCase();
    if (
      !isLast &&
      (lower === "ctrl" ||
        lower === "control" ||
        lower === "cmd" ||
        lower === "command" ||
        lower === "meta")
    ) {
      if (!mods.includes("ctrl")) mods.push("ctrl");
    } else if (!isLast && lower === "shift") {
      if (!mods.includes("shift")) mods.push("shift");
    } else if (!isLast && (lower === "alt" || lower === "option")) {
      if (!mods.includes("alt")) mods.push("alt");
    } else if (!isLast && (lower === "win" || lower === "super")) {
      if (!mods.includes("meta")) mods.push("meta");
    } else {
      key = lower;
    }
  }
  const order = ["ctrl", "shift", "alt", "meta"];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...mods, key].filter(Boolean).join("+");
}

/**
 * Two-step "chord" shortcut, e.g. "Ctrl+K Ctrl+0". Returns the leading
 * combo and the follow-up combo when the accel contains a SPACE outside
 * any parentheses with non-empty halves; otherwise null.
 */
export function parseChordAccel(
  accel: string,
): { leading: string; followup: string } | null {
  let depth = 0;
  for (let i = 0; i < accel.length; i++) {
    const ch = accel[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === " " && depth === 0) {
      const leading = accel.slice(0, i).trim();
      const followup = accel.slice(i + 1).trim();
      if (!leading || !followup) return null;
      return { leading, followup };
    }
  }
  return null;
}

/** True when the event is just a modifier key being pressed on its own
 *  (Ctrl, Alt, Shift, Meta). Such keydowns shouldn't arm a chord or
 *  count as the second half of one — wait for the actual letter / number. */
export function isModifierOnly(e: KeyboardEvent): boolean {
  return (
    e.key === "Control" ||
    e.key === "Shift" ||
    e.key === "Alt" ||
    e.key === "Meta" ||
    e.key === "OS"
  );
}
