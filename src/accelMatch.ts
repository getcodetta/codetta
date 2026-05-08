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
