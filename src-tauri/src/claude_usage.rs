// Live Claude plan-limit usage — the same data the CLI's interactive
// /usage panel and the official VS Code extension show (5-hour session
// window, 7-day window, per-model weekly caps, extra-usage credits).
//
// The CLI doesn't expose this headlessly, but it fetches it from
// `api.anthropic.com/api/oauth/usage` with the OAuth token it keeps in
// ~/.claude/.credentials.json. We do exactly the same call. The token
// NEVER leaves the Rust side — the frontend gets only the usage/profile
// JSON. If the token has expired we bail with a hint instead of making
// a doomed request (the CLI refreshes it on its next interactive run;
// implementing the refresh dance here isn't worth owning a second
// auth path).

use serde_json::Value;
use std::time::Duration;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";

fn oauth_get(url: &str, token: &str) -> Result<Value, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .into();
    let mut resp = agent
        .get(url)
        .header("Authorization", &format!("Bearer {}", token))
        .header("anthropic-beta", "oauth-2025-04-20")
        .call()
        .map_err(|e| format!("request failed: {}", e))?;
    resp.body_mut()
        .read_json::<Value>()
        .map_err(|e| format!("bad response: {}", e))
}

/// Returns `{ usage, profile, subscriptionType, rateLimitTier }`.
/// `profile` is Null when that call fails — usage alone still renders.
#[tauri::command]
pub fn claude_usage_limits() -> Result<Value, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let cred_path = home.join(".claude").join(".credentials.json");
    let raw = std::fs::read_to_string(&cred_path).map_err(|_| {
        "no Claude Code credentials found — sign in with `claude` in a terminal".to_string()
    })?;
    let cred: Value =
        serde_json::from_str(&raw).map_err(|e| format!("credentials parse: {}", e))?;
    let oauth = cred
        .get("claudeAiOauth")
        .ok_or_else(|| "not signed in via claude.ai OAuth".to_string())?;
    let token = oauth
        .get("accessToken")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "no access token in credentials".to_string())?;
    let expires_at = oauth.get("expiresAt").and_then(|v| v.as_i64()).unwrap_or(0);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    if expires_at > 0 && expires_at < now_ms {
        return Err(
            "Claude session token expired — run `claude` in a terminal once to refresh it"
                .to_string(),
        );
    }

    let usage = oauth_get(USAGE_URL, token)?;
    let profile = oauth_get(PROFILE_URL, token).unwrap_or(Value::Null);
    Ok(serde_json::json!({
        "usage": usage,
        "profile": profile,
        "subscriptionType": oauth.get("subscriptionType").cloned().unwrap_or(Value::Null),
        "rateLimitTier": oauth.get("rateLimitTier").cloned().unwrap_or(Value::Null),
    }))
}
