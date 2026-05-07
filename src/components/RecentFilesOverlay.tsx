import { createPortal } from "react-dom";
import { basename, relPath } from "../pathUtils";

interface Props {
  open: boolean;
  files: string[];
  selectedIndex: number;
  workspaceRoot?: string;
  onSelect: (index: number) => void;
}

export function RecentFilesOverlay({
  open,
  files,
  selectedIndex,
  workspaceRoot,
  onSelect,
}: Props) {
  if (!open || files.length === 0) return null;
  return createPortal(
    <div className="recent-overlay">
      <div className="recent-overlay-card">
        <div className="recent-overlay-header">Recent Files</div>
        <ul className="recent-overlay-list">
          {files.map((p, i) => (
            <li
              key={p}
              className={`recent-overlay-item ${i === selectedIndex ? "active" : ""}`}
              onMouseEnter={() => onSelect(i)}
            >
              <span className="recent-overlay-name">{basename(p)}</span>
              <span className="recent-overlay-path">
                {workspaceRoot ? relPath(p, workspaceRoot) : p}
              </span>
            </li>
          ))}
        </ul>
        <div className="recent-overlay-footer">
          Hold <kbd>Ctrl</kbd> + <kbd>Tab</kbd> to cycle ·{" "}
          <kbd>Shift+Tab</kbd> back · release <kbd>Ctrl</kbd> to commit ·{" "}
          <kbd>Esc</kbd> to cancel
        </div>
      </div>
    </div>,
    document.body,
  );
}
