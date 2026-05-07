import { useEffect, useMemo, useRef } from "react";
import { renderMarkdown } from "../markdown";
import { onMdPreviewScroll, setEditorGoto } from "../editorState";

interface Props {
  content: string;
  /** When true, clicking a rendered block jumps the editor to that
   *  block's source line. Used by the markdown split preview where
   *  the editor and preview share a file. False (default) for chat
   *  bubbles and tool output, where line numbers refer to a file
   *  the user isn't even editing. */
  interactive?: boolean;
}

export function MarkdownPreview({ content, interactive = false }: Props) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  const ref = useRef<HTMLDivElement>(null);

  // Editor-driven scroll-sync. Only meaningful in interactive (split)
  // mode; chat-side previews don't have an editor pointing at them.
  // The scrollable ancestor is the .preview-half wrapper from
  // EditorPane (overflow-y: auto), not .md-preview itself, so we walk
  // up looking for the first scrollable parent. Behaviour: jump
  // (not smooth) — scroll-sync should track the editor 1:1 without
  // a lagging animation that breaks the "shared scroll" illusion.
  useEffect(() => {
    if (!interactive) return;
    return onMdPreviewScroll((line) => {
      const root = ref.current;
      if (!root) return;
      const blocks = root.querySelectorAll<HTMLElement>("[data-source-line]");
      if (blocks.length === 0) return;
      let target: HTMLElement | null = null;
      for (const b of blocks) {
        const bl = parseInt(b.dataset.sourceLine ?? "0", 10);
        if (bl > line) break;
        target = b;
      }
      if (!target) return;
      // Find the scrollable ancestor — usually .preview-half.
      let scroller: HTMLElement | null = root.parentElement;
      while (scroller && scroller !== document.body) {
        const overflowY = getComputedStyle(scroller).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") break;
        scroller = scroller.parentElement;
      }
      if (!scroller || scroller === document.body) return;
      // offsetTop of the target is relative to its offsetParent;
      // getBoundingClientRect gives us the absolute screen position
      // which we can convert to a scrollTop on the scroller.
      const targetRect = target.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const delta = targetRect.top - scrollerRect.top;
      scroller.scrollTo({
        top: scroller.scrollTop + delta - 8,
        behavior: "auto",
      });
    });
  }, [interactive]);

  // Headings are flagged with .md-anchor as the primary jump targets;
  // every block carries data-source-line so users can also click into
  // paragraphs / code blocks. Links + checkboxes keep their native
  // behaviour.
  const handleClick = interactive
    ? (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (target.closest("a") || target.closest("input")) return;
        const el = target.closest<HTMLElement>("[data-source-line]");
        if (!el) return;
        const line = parseInt(el.dataset.sourceLine ?? "0", 10);
        if (line > 0) setEditorGoto(line, 1);
      }
    : undefined;

  return (
    <div
      ref={ref}
      className={`md-preview${interactive ? " md-preview-interactive" : ""}`}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
