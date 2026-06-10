// SFTP/SSH connection profile manager — saved profiles list + inline
// editor + test-connection button. Stored locally in localStorage
// alongside the existing API-key trust model. Used by the Remote
// SFTP browser panel and the file-tree upload/push flows.
//
// Pulled out of SettingsModal so the connection schema + load/save
// helpers live next to the editor that owns them, and so the modal
// shell shrinks.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errMsg } from "../notify";
import { Row } from "./settingsBits";
import {
  emptySftpProfile as emptyProfile,
  loadSftpProfiles,
  saveSftpProfiles,
  type SftpProfile,
} from "../sftpProfiles";

export function SftpProfilesEditor() {
  const [profiles, setProfiles] = useState<SftpProfile[]>(() =>
    loadSftpProfiles(),
  );
  const [editing, setEditing] = useState<SftpProfile | null>(null);
  const [testState, setTestState] = useState<{
    profileId: string | "draft";
    status: "idle" | "testing" | "ok" | "fail";
    msg?: string;
  } | null>(null);

  const persist = (next: SftpProfile[]) => {
    setProfiles(next);
    saveSftpProfiles(next);
  };

  const startNew = () => {
    setEditing(emptyProfile());
    setTestState(null);
  };

  const startEdit = (p: SftpProfile) => {
    setEditing({ ...p });
    setTestState(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setTestState(null);
  };

  const saveEdit = () => {
    if (!editing) return;
    const trimmed: SftpProfile = {
      ...editing,
      name: editing.name.trim() || `${editing.user}@${editing.host}`,
      host: editing.host.trim(),
      user: editing.user.trim(),
      port: Math.max(1, Math.min(65535, editing.port || 22)),
    };
    if (!trimmed.host || !trimmed.user) return;
    const idx = profiles.findIndex((p) => p.id === trimmed.id);
    const next = [...profiles];
    if (idx >= 0) next[idx] = trimmed;
    else next.push(trimmed);
    persist(next);
    setEditing(null);
    setTestState(null);
  };

  const removeProfile = (id: string) => {
    if (!confirm("Delete this connection profile?")) return;
    persist(profiles.filter((p) => p.id !== id));
  };

  const testConnection = async (p: SftpProfile, key: string | "draft") => {
    setTestState({ profileId: key, status: "testing" });
    try {
      const result = await invoke<{
        server_banner: string;
        home_dir: string;
        entry_count: number;
      }>("sftp_test_connection", {
        args: {
          host: p.host,
          port: p.port,
          user: p.user,
          password: p.password,
          privateKeyPath: p.privateKeyPath?.trim() || undefined,
        },
      });
      setTestState({
        profileId: key,
        status: "ok",
        msg: `${result.server_banner} — home: ${result.home_dir} (${result.entry_count} entries)`,
      });
    } catch (e) {
      setTestState({
        profileId: key,
        status: "fail",
        msg: errMsg(e),
      });
    }
  };

  return (
    <>
      <div className="settings-row settings-row-note">
        Saved SFTP/SSH connections. Test verifies credentials before
        saving. Used by the Remote browser in the sidebar and as a
        deploy target for upload/download from the file tree.
        Passwords are stored locally in <code>localStorage</code>.
      </div>

      {profiles.length === 0 && !editing && (
        <div className="settings-row settings-row-note">
          No connections yet. Click <strong>Add connection</strong> below.
        </div>
      )}

      {profiles.map((p) => (
        <div key={p.id} className="sftp-profile-row">
          <div className="sftp-profile-meta">
            <span className="sftp-profile-name">{p.name}</span>
            <span className="sftp-profile-detail">
              {p.user}@{p.host}:{p.port}
            </span>
          </div>
          <div className="sftp-profile-actions">
            <button
              className="sftp-btn"
              onClick={() => void testConnection(p, p.id)}
              disabled={
                testState?.profileId === p.id && testState.status === "testing"
              }
            >
              {testState?.profileId === p.id && testState.status === "testing"
                ? "Testing…"
                : "Test"}
            </button>
            <button className="sftp-btn" onClick={() => startEdit(p)}>
              Edit
            </button>
            <button
              className="sftp-btn sftp-btn-danger"
              onClick={() => removeProfile(p.id)}
            >
              Delete
            </button>
          </div>
          {testState?.profileId === p.id &&
            testState.status !== "idle" &&
            testState.status !== "testing" && (
              <div
                className={`sftp-profile-test sftp-profile-test-${testState.status}`}
              >
                {testState.status === "ok" ? "✓ " : "✗ "}
                {testState.msg}
              </div>
            )}
        </div>
      ))}

      {editing && (
        <div className="sftp-profile-edit">
          <Row label="Label">
            <input
              className="sftp-field"
              value={editing.name}
              placeholder="Production web server"
              onChange={(e) =>
                setEditing({ ...editing, name: e.target.value })
              }
            />
          </Row>
          <Row label="Host">
            <input
              className="sftp-field"
              value={editing.host}
              placeholder="example.com or 192.0.2.10"
              onChange={(e) =>
                setEditing({ ...editing, host: e.target.value })
              }
            />
          </Row>
          <Row label="Port">
            <input
              className="settings-num"
              type="number"
              min={1}
              max={65535}
              value={editing.port}
              onChange={(e) =>
                setEditing({ ...editing, port: Number(e.target.value) || 22 })
              }
            />
          </Row>
          <Row label="Username">
            <input
              className="sftp-field"
              value={editing.user}
              autoComplete="off"
              onChange={(e) =>
                setEditing({ ...editing, user: e.target.value })
              }
            />
          </Row>
          <Row label="Password">
            <input
              className="sftp-field"
              type="password"
              value={editing.password}
              autoComplete="new-password"
              onChange={(e) =>
                setEditing({ ...editing, password: e.target.value })
              }
            />
          </Row>
          <Row label="Default folder">
            <input
              className="sftp-field"
              value={editing.defaultPath ?? ""}
              placeholder="/var/www/site (optional — defaults to SSH home)"
              onChange={(e) =>
                setEditing({ ...editing, defaultPath: e.target.value })
              }
            />
          </Row>
          <Row label="Private key">
            <input
              className="sftp-field"
              value={editing.privateKeyPath ?? ""}
              placeholder="C:/Users/me/.ssh/id_ed25519 (optional — leave blank for password)"
              onChange={(e) =>
                setEditing({ ...editing, privateKeyPath: e.target.value })
              }
            />
          </Row>
          <div className="sftp-profile-edit-actions">
            <button
              className="sftp-btn"
              onClick={() => void testConnection(editing, "draft")}
              disabled={
                !editing.host ||
                !editing.user ||
                (testState?.profileId === "draft" &&
                  testState.status === "testing")
              }
            >
              {testState?.profileId === "draft" &&
              testState.status === "testing"
                ? "Testing…"
                : "Test connection"}
            </button>
            <button
              className="sftp-btn sftp-btn-primary"
              onClick={saveEdit}
              disabled={!editing.host || !editing.user}
            >
              Save
            </button>
            <button className="sftp-btn" onClick={cancelEdit}>
              Cancel
            </button>
          </div>
          {testState?.profileId === "draft" &&
            testState.status !== "idle" &&
            testState.status !== "testing" && (
              <div
                className={`sftp-profile-test sftp-profile-test-${testState.status}`}
              >
                {testState.status === "ok" ? "✓ " : "✗ "}
                {testState.msg}
              </div>
            )}
        </div>
      )}

      {!editing && (
        <div className="settings-row">
          <button className="sftp-btn sftp-btn-primary" onClick={startNew}>
            + Add connection
          </button>
        </div>
      )}
    </>
  );
}
