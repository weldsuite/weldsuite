//! `@weldsuite/panel-domain`: the project settings and their defaults, the
//! project token, the record the collector reads and its cache keys, and
//! the allowed-origin check; plus the install snippet of
//! `@weldsuite/panel-sdk/install`.

use serde_json::{Map, Value, json};

/// `panel:project:<token>` → the project record (JSON). Written by the
/// project routes, read by the collector.
pub(crate) fn project_key(token: &str) -> String {
    format!("panel:project:{token}")
}

/// `panel:seen:<projectId>` → ISO time of the last event the collector
/// accepted for the project.
pub(crate) fn seen_key(project_id: &str) -> String {
    format!("panel:seen:{project_id}")
}

/// `DEFAULT_PANEL_SETTINGS`, in its key order.
pub(crate) fn default_settings() -> Vec<(&'static str, Value)> {
    vec![
        ("autocapture", json!(true)),
        ("maskingLevel", json!("balanced")),
        ("consentMode", json!("required")),
        ("recordingSampleRate", json!(1)),
        ("excludedUrls", json!([])),
        ("ipFilters", json!([])),
        ("aiEnabled", json!(true)),
    ]
}

/// `withSettingDefaults(settings)`: `{ ...DEFAULT_PANEL_SETTINGS, ...settings }`.
pub(crate) fn with_setting_defaults(settings: Option<&Value>) -> Value {
    let mut merged: Map<String, Value> = default_settings()
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect();
    if let Some(Value::Object(stored)) = settings {
        for (key, value) in stored {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

/// `generateProjectToken()`: `wpk_` + 32 lowercase hex characters.
pub(crate) fn generate_project_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system has a random source");
    format!("wpk_{}", hex::encode(bytes))
}

/// `isProjectToken(value)`: `/^wpk_[0-9a-f]{32}$/`.
pub(crate) fn is_project_token(value: &str) -> bool {
    value.len() == 36
        && value.starts_with("wpk_")
        && value[4..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `toProjectRecord(project, workspaceId)`.
pub(crate) fn project_record(
    project_id: &str,
    workspace_id: &str,
    status: &Value,
    allowed_domains: &Value,
    settings: &Value,
) -> Value {
    json!({
        "v": 1,
        "projectId": project_id,
        "workspaceId": workspace_id,
        "status": status,
        "allowedDomains": allowed_domains,
        "settings": settings,
    })
}

/// A parsed project record (`parseProjectRecord`), its settings filled in.
#[derive(Debug, Clone)]
pub(crate) struct ProjectRecord {
    pub(crate) project_id: String,
    pub(crate) workspace_id: String,
    pub(crate) status: String,
    pub(crate) allowed_domains: Vec<String>,
    pub(crate) settings: Value,
}

impl ProjectRecord {
    /// `parseProjectRecord(raw)` then `withSettingDefaults`: null for a
    /// missing, malformed or unknown-version record.
    pub(crate) fn parse(raw: Option<&str>) -> Option<Self> {
        let raw = raw.filter(|raw| !raw.is_empty())?;
        let value: Value = serde_json::from_str(raw).ok()?;
        let object = value.as_object()?;
        if object.get("v") != Some(&json!(1)) {
            return None;
        }
        let project_id = object.get("projectId")?.as_str()?.to_owned();
        let workspace_id = object.get("workspaceId")?.as_str()?.to_owned();
        Some(Self {
            project_id,
            workspace_id,
            status: object
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            allowed_domains: strings(object.get("allowedDomains")),
            settings: with_setting_defaults(object.get("settings")),
        })
    }

    pub(crate) fn setting_strings(&self, key: &str) -> Vec<String> {
        strings(self.settings.get(key))
    }
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// `isAllowedOrigin(origin, allowedDomains)`: any origin when the list is
/// empty, else an exact host or a subdomain of a listed host.
pub(crate) fn is_allowed_origin(origin: Option<&str>, allowed_domains: &[String]) -> bool {
    if allowed_domains.is_empty() {
        return true;
    }
    let Some(origin) = origin else {
        return false;
    };
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    let host = url.host_str().unwrap_or_default().to_lowercase();
    allowed_domains.iter().any(|domain| {
        let trimmed = weldsuite_kit::validation::js_trim(domain).to_lowercase();
        let d = trimmed.strip_prefix("*.").unwrap_or(&trimmed);
        !d.is_empty() && (host == d || host.ends_with(&format!(".{d}")))
    })
}

/// `DEFAULT_HOST` of the SDK: Global's collector.
pub(crate) const DEFAULT_HOST: &str = "https://pnl.weldsuite.org";

/// `trimTrailingSlashes(url)`.
pub(crate) fn trim_trailing_slashes(url: &str) -> &str {
    url.trim_end_matches('/')
}

/// The stub that queues calls made before the SDK loads (`STUB`).
const STUB: &str = concat!(
    "!function(w,p,s){p=w.weldpanel=w.weldpanel||{q:[]};if(!p.q)return;",
    "s=function(n){return function(){p.q.push([n,[].slice.call(arguments)])}};",
    "p.track=s(\"track\");p.optOut=s(\"optOut\");p.optIn=s(\"optIn\");p.flush=s(\"flush\");",
    "p.consent={grant:s(\"consent.grant\"),revoke:s(\"consent.revoke\")}}(window);",
);

fn attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
}

/// `installSnippet(token, host)`: the stub, then the async loader.
pub(crate) fn install_snippet(token: &str, host: &str) -> String {
    let origin = trim_trailing_slashes(host);
    format!(
        "<script>{STUB}</script>\n<script async src=\"{}/s.js\" data-project=\"{}\"></script>",
        attr(origin),
        attr(token)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_have_the_collector_shape() {
        let token = generate_project_token();
        assert!(is_project_token(&token), "{token}");
        assert!(!is_project_token("wpk_ABCDEF00000000000000000000000000"));
        assert!(!is_project_token("wpk_abc"));
    }

    #[test]
    fn origins_match_hosts_and_subdomains() {
        let domains = vec!["example.com".to_owned(), "*.Shop.io ".to_owned()];
        assert!(is_allowed_origin(Some("https://example.com"), &domains));
        assert!(is_allowed_origin(Some("https://www.example.com"), &domains));
        assert!(is_allowed_origin(Some("https://a.shop.io:8443"), &domains));
        assert!(!is_allowed_origin(Some("https://badexample.com"), &domains));
        assert!(!is_allowed_origin(Some("null"), &domains));
        assert!(!is_allowed_origin(None, &domains));
        assert!(is_allowed_origin(None, &[]));
    }

    #[test]
    fn records_need_version_one() {
        assert!(
            ProjectRecord::parse(Some("{\"v\":2,\"projectId\":\"p\",\"workspaceId\":\"w\"}"))
                .is_none()
        );
        assert!(ProjectRecord::parse(Some("not json")).is_none());
        let record = ProjectRecord::parse(Some(
            "{\"v\":1,\"projectId\":\"p\",\"workspaceId\":\"w\",\"status\":\"active\",\"allowedDomains\":[],\"settings\":{\"autocapture\":false}}",
        ))
        .expect("a record");
        assert_eq!(record.settings["autocapture"], json!(false));
        assert_eq!(record.settings["consentMode"], json!("required"));
    }
}
