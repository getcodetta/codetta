import { useMemo } from "react";
import { renderMarkdown } from "../markdown";

export function MarkdownPreview({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  return (
    <div className="md-preview" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
