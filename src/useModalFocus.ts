// Focus management for modal dialogs. Every modal in the app renders
// role="dialog" aria-modal="true", but until this hook none of them
// actually took focus, trapped Tab, or restored focus on close — so
// opening Settings over the editor left keystrokes flowing into the
// code buffer behind the backdrop, and aria-modal lied to screen
// readers about the rest of the page being inert.
//
// Usage: const ref = useRef<HTMLDivElement | null>(null);
//        useModalFocus(ref, open);
//        <div ref={ref} role="dialog" …>
//
// Behavior:
// - On open: focuses the first focusable element inside the dialog
//   (unless something inside already has focus, e.g. via autoFocus).
// - While open: Tab / Shift+Tab cycle within the dialog.
// - Stacked modals: if focus currently sits in a modal that appears
//   LATER in the DOM (portals append to body, so later-opened modals
//   follow earlier ones), this hook stands down and lets the top
//   modal's own trap handle the key.
// - On close/unmount: restores focus to the element focused before.

import { useEffect } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), ' +
  'textarea:not([disabled]), select:not([disabled]), ' +
  '[tabindex]:not([tabindex="-1"])';

export function useModalFocus(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
) {
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    if (!el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? el).focus();
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const active = document.activeElement as HTMLElement | null;
      // A modal stacked above this one owns the keyboard.
      const activeModal = active?.closest('[aria-modal="true"]');
      if (
        activeModal &&
        activeModal !== el &&
        el.compareDocumentPosition(activeModal) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ) {
        return;
      }
      const items = Array.from(
        el.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((n) => n.offsetParent !== null || n === active);
      if (items.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey) {
        if (active === first || !el.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !el.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      // Restore focus to where the user was before the modal opened.
      // The element may have unmounted (e.g. tab closed) — focus() on
      // a detached node is a harmless no-op.
      prev?.focus?.();
    };
  }, [ref, open]);
}
