// Pure helpers for matching declarative accelerator strings (e.g.
// "Ctrl+S", "Ctrl+Shift+F", "Ctrl+K Ctrl+0") against KeyboardEvents.
//
// Chord shape: two combos joined by a single SPACE — the leading combo
// arms a pending state, the follow-up combo within CHORD_TIMEOUT_MS
// (see App.tsx) commits the action. Author-defined strings only;
// we don't try to be clever about user input.

/**
 * Match a single (non-chord) accelerator string like "Ctrl+Shift+S"
 * against a KeyboardEvent. Modifier matching is exact: an accel that
 * doesn't list Shift will NOT match an event that has Shift held.
 *
 * Cmd is treated as Ctrl on macOS so the same string works on both
 * platforms — Codetta accels are authored with the Windows mnemonic
 * but the OS modifier is Cmd on Mac.
 */
export function accelMatches(accel: string, e: KeyboardEvent): boolean {
  const parts = accel.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  let needCtrl = false;
  let needShift = false;
  let needAlt = false;
  let needMeta = false;
  let key: string | null = null;
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === "ctrl" || lower === "control" || lower === "cmd" || lower === "command") {
      // Ctrl on Win/Linux, Cmd on Mac — but accept either modifier on
      // either platform so testing doesn't get platform-coupled.
      needCtrl = true;
    } else if (lower === "shift") {
      needShift = true;
    } else if (lower === "alt" || lower === "option") {
      needAlt = true;
    } else if (lower === "meta" || lower === "win" || lower === "super") {
      needMeta = true;
    } else {
      key = p;
    }
  }
  if (key === null) return false;
  const haveCtrl = e.ctrlKey || e.metaKey;
  // The accel uses "Ctrl" semantically. On mac, metaKey carries it; on
  // win/linux, ctrlKey does. Either lights up needCtrl satisfaction.
  if (needCtrl !== haveCtrl) return false;
  if (needShift !== e.shiftKey) return false;
  if (needAlt !== e.altKey) return false;
  // needMeta is only checked when the author explicitly wrote "Meta" —
  // otherwise meta is folded into Ctrl above.
  if (needMeta && !e.metaKey) return false;
  // Compare the trailing key. e.key is the produced character (so "S"
  // vs "s" differ by Shift), so compare case-insensitively for letters
  // and exactly for symbols/F-keys.
  const evKey = e.key;
  if (key.length === 1 && evKey.length === 1) {
    return key.toLowerCase() === evKey.toLowerCase();
  }
  return key === evKey;
}

/**
 * Canonicalize an accel string so two equivalent specs compare equal.
 * Lowercases, sorts modifiers in a fixed order (Ctrl, Shift, Alt, Meta),
 * leaves the trailing key as-is (lowercased). Used to compare a stored
 * "leading combo" string against the leading half parsed at lookup time.
 */
export function normalizeAccel(s: string): string {
  const parts = s.split("+").map((p) => p.trim()).filter(Boolean);
  const mods: string[] = [];
  let key = "";
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === "ctrl" || lower === "control" || lower === "cmd" || lower === "command") {
      if (!mods.includes("ctrl")) mods.push("ctrl");
    } else if (lower === "shift") {
      if (!mods.includes("shift")) mods.push("shift");
    } else if (lower === "alt" || lower === "option") {
      if (!mods.includes("alt")) mods.push("alt");
    } else if (lower === "meta" || lower === "win" || lower === "super") {
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
 * Returns null if `accel` is not a chord. Otherwise parses both halves
 * and returns the leading combo (e.g. "Ctrl+K") and follow-up combo
 * (e.g. "Ctrl+0" or "S").
 *
 * A chord is defined as a string containing a literal SPACE outside any
 * parentheses, with non-empty halves on either side.
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

/**
 * True if the event is just a modifier key being pressed on its own
 * (Ctrl, Alt, Shift, Meta). These keydowns shouldn't arm a chord or
 * count as the second half of one — wait for the actual letter/number
 * to come through.
 */
export function isModifierOnly(e: KeyboardEvent): boolean {
  return (
    e.key === "Control" ||
    e.key === "Shift" ||
    e.key === "Alt" ||
    e.key === "Meta" ||
    e.key === "OS"
  );
}
