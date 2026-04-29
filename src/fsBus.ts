import { listen } from "@tauri-apps/api/event";

class FsBus extends EventTarget {}
export const fsBus = new FsBus();

let started = false;
export function startFsBusOnce() {
  if (started) return;
  started = true;
  void listen<{ ws_id: string; dirs: string[] }>("fs:event", (e) => {
    const { ws_id, dirs } = e.payload;
    fsBus.dispatchEvent(
      new CustomEvent("ws", { detail: { wsId: ws_id, dirs } }),
    );
    for (const d of dirs) {
      fsBus.dispatchEvent(
        new CustomEvent("dir", { detail: { wsId: ws_id, dir: d } }),
      );
    }
  });
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function pathsEqual(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}
