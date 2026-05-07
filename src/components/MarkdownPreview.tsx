import { useMemo, useRef } from "react";
import { renderMarkdown } from "../markdown";
import { setEditorGoto } from "../editorState";

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
