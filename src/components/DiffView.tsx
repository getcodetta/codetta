import { DiffEditor } from "@monaco-editor/react";
import { useResolvedTheme } from "../theme";

interface Props {
  originalContent: string;
  modifiedContent: string;
  language?: string;
  path?: string;
}

export function DiffView({
  originalContent,
  modifiedContent,
  language,
  path: _path,
}: Props) {
  const t = useResolvedTheme();
  return (
    <div className="diff-view">
      <DiffEditor
        height="100%"
        original={originalContent}
        modified={modifiedContent}
        language={language ?? "plaintext"}
        theme={t === "dark" ? "vs-dark" : "vs"}
        options={{
          readOnly: true,
          renderSideBySide: true,
          originalEditable: false,
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 13,
        }}
      />
    </div>
  );
}
