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

/// `panel:quota:<workspaceId>` → `ok`, `replay_blocked` or `events_blocked`
/// (plain string), written by panel-api's usage settlement.
pub(crate) fn quota_key(workspace_id: &str) -> String {
    format!("panel:quota:{workspace_id}")
}

/// `parseQuotaState(raw)`: anything but the two blocked states is `ok`.
pub(crate) fn parse_quota_state(raw: Option<&str>) -> &'static str {
    match raw {
        Some("replay_blocked") => "replay_blocked",
        Some("events_blocked") => "events_blocked",
        _ => "ok",
    }
}

/// `panel:key:<sha256 hex of the secret key>` → the key record (JSON),
/// written by panel-api when a secret key (`wps_…`) is created, deleted when
/// it is revoked; the master `panel_key_registry` row is the source of
/// truth.
pub(crate) fn key_key(key_hash: &str) -> String {
    format!("panel:key:{key_hash}")
}

/// `panel:snapshot-request:<projectId>` → the heatmap snapshot the project
/// waits for (JSON), written by panel-api.
pub(crate) fn snapshot_request_key(project_id: &str) -> String {
    format!("panel:snapshot-request:{project_id}")
}

/// `v === 1`, as JavaScript compares a parsed number.
fn is_version_one(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64) == Some(1.0)
}

/// A parsed key record (`parseKeyRecord`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct KeyRecord {
    pub(crate) key_id: String,
    pub(crate) workspace_id: String,
    pub(crate) project_id: String,
    /// `active` or `paused`; missing means active.
    pub(crate) status: Option<String>,
}

impl KeyRecord {
    /// `parseKeyRecord(raw)`: null for a missing, malformed or
    /// unknown-version record.
    pub(crate) fn parse(raw: Option<&str>) -> Option<Self> {
        let raw = raw.filter(|raw| !raw.is_empty())?;
        let value: Value = serde_json::from_str(raw).ok()?;
        let object = value.as_object()?;
        if !is_version_one(object.get("v")) {
            return None;
        }
        let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
        Some(Self {
            key_id: text("keyId")?,
            workspace_id: text("workspaceId")?,
            project_id: text("projectId")?,
            status: text("status").filter(|status| status == "active" || status == "paused"),
        })
    }

    /// The record as panel-api writes it.
    pub(crate) fn to_value(&self) -> Value {
        let mut record = json!({
            "v": 1,
            "keyId": self.key_id,
            "workspaceId": self.workspace_id,
            "projectId": self.project_id,
        });
        if let Some(status) = &self.status {
            record["status"] = json!(status);
        }
        record
    }
}

/// `DEVICE_CLASSES`: the viewport width classes heatmaps are grouped by.
pub(crate) fn is_device_class(value: &str) -> bool {
    matches!(value, "desktop" | "tablet" | "mobile")
}

/// `PAGE_GROUP_ID`: `/^[\w-]{1,64}$/`, as it ends up in an object key and
/// a query string.
pub(crate) fn is_page_group_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `parseSnapshotRequest(raw)`: `{ pageGroupId, urlPattern, deviceClass }`,
/// or null for a missing or malformed request.
pub(crate) fn parse_snapshot_request(raw: Option<&str>) -> Option<Value> {
    let raw = raw.filter(|raw| !raw.is_empty())?;
    let value: Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object()?;
    let page_group_id = object
        .get("pageGroupId")
        .and_then(Value::as_str)
        .filter(|id| is_page_group_id(id))?;
    let url_pattern = object
        .get("urlPattern")
        .and_then(Value::as_str)
        .filter(|pattern| !pattern.is_empty())?;
    let device_class = object
        .get("deviceClass")
        .and_then(Value::as_str)
        .filter(|class| is_device_class(class))?;
    Some(json!({
        "pageGroupId": page_group_id,
        "urlPattern": url_pattern,
        "deviceClass": device_class,
    }))
}

/// `replayChunkKey(...)`:
/// `<tier>/<workspace>/<project>/<yyyy-mm-dd>/<session>/<seq>.json.gz`,
/// `day` the chunk's own UTC start day.
pub(crate) fn replay_chunk_key(
    tier: &str,
    workspace_id: &str,
    project_id: &str,
    day: &str,
    session_id: &str,
    seq: u64,
) -> String {
    format!("{tier}/{workspace_id}/{project_id}/{day}/{session_id}/{seq}.json.gz")
}

/// `heatmapSnapshotKey(...)`: one masked full snapshot per page group and
/// device class, overwritten when a newer one arrives.
pub(crate) fn heatmap_snapshot_key(
    workspace_id: &str,
    project_id: &str,
    page_group_id: &str,
    device_class: &str,
) -> String {
    format!("snapshots/{workspace_id}/{project_id}/{page_group_id}/{device_class}.json.gz")
}

/// `String(value)` of a JSON value, as a template literal writes it.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number
            .as_f64()
            .map_or_else(|| number.to_string(), crate::js::number_text),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
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

/// `panel:tier:<workspaceId>` → the replay tier last written into the
/// workspace's project records (`tierKvKey`).
pub(crate) fn tier_key(workspace_id: &str) -> String {
    format!("panel:tier:{workspace_id}")
}

/// The tier a plan writes new recording chunks to
/// (`panelPlanLimits(slug).replayTier`): `90d` on Scale and Enterprise,
/// `30d` on Free, Business, a plan WeldPanel doesn't know or none (Global's
/// default, so an install without billing keeps it).
pub fn plan_replay_tier(plan_slug: Option<&str>) -> &'static str {
    match plan_slug.map(|slug| slug.trim().to_lowercase()).as_deref() {
        Some("scale" | "enterprise") => "90d",
        _ => "30d",
    }
}

/// `withReplayTier(record, tier)`: `90d` is written, `30d` is the default
/// and left out.
pub(crate) fn with_replay_tier(mut record: Value, tier: &str) -> Value {
    if let Some(object) = record.as_object_mut() {
        if tier == "90d" {
            object.insert("replayTier".to_owned(), json!(tier));
        } else {
            object.remove("replayTier");
        }
    }
    record
}

/// `parseProjectRecord(raw)` as stored, without the settings filled in:
/// `None` for a missing, malformed or unknown-version record.
pub(crate) fn stored_project_record(raw: Option<&str>) -> Option<Value> {
    let value: Value = serde_json::from_str(raw.filter(|raw| !raw.is_empty())?).ok()?;
    let object = value.as_object()?;
    (is_version_one(object.get("v"))
        && object.get("projectId").is_some_and(Value::is_string)
        && object.get("workspaceId").is_some_and(Value::is_string))
    .then_some(value)
}

/// Whether a stored record already names `tier`
/// (`record.replayTier === (tier === '90d' ? tier : undefined)`).
pub(crate) fn names_replay_tier(record: &Value, tier: &str) -> bool {
    match record.get("replayTier") {
        None => tier != "90d",
        Some(Value::String(named)) => tier == "90d" && named == tier,
        Some(_) => false,
    }
}

/// A parsed project record (`parseProjectRecord`), its settings filled in.
#[derive(Debug, Clone)]
pub(crate) struct ProjectRecord {
    pub(crate) project_id: String,
    pub(crate) workspace_id: String,
    pub(crate) status: String,
    pub(crate) allowed_domains: Vec<String>,
    pub(crate) settings: Value,
    /// `replayTier`: the retention tier new recording chunks go to,
    /// written by panel-api's billing; missing (or null) means `30d`.
    pub(crate) replay_tier: Option<Value>,
}

impl ProjectRecord {
    /// `project.replayTier ?? '30d'`, as the chunk key writes it.
    pub(crate) fn replay_tier(&self) -> String {
        self.replay_tier
            .as_ref()
            .map_or_else(|| "30d".to_owned(), js_string)
    }

    /// `parseProjectRecord(raw)` then `withSettingDefaults`: null for a
    /// missing, malformed or unknown-version record.
    pub(crate) fn parse(raw: Option<&str>) -> Option<Self> {
        let raw = raw.filter(|raw| !raw.is_empty())?;
        let value: Value = serde_json::from_str(raw).ok()?;
        let object = value.as_object()?;
        if !is_version_one(object.get("v")) {
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
            replay_tier: object
                .get("replayTier")
                .filter(|tier| !tier.is_null())
                .cloned(),
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
    "p.track=s(\"track\");p.identify=s(\"identify\");p.reset=s(\"reset\");p.optOut=s(\"optOut\");p.optIn=s(\"optIn\");p.flush=s(\"flush\");",
    "p.register=s(\"register\");p.registerOnce=s(\"registerOnce\");p.unregister=s(\"unregister\");p.group=s(\"group\");p.resetGroups=s(\"resetGroups\");",
    "p.consent={grant:s(\"consent.grant\"),revoke:s(\"consent.revoke\")};",
    "p.people={set:s(\"people.set\"),set_once:s(\"people.set_once\"),unset:s(\"people.unset\"),increment:s(\"people.increment\")};",
    "p.groups={set:s(\"groups.set\"),set_once:s(\"groups.set_once\"),unset:s(\"groups.unset\")}}(window);",
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
    fn key_records_read_as_panel_api_writes_them() {
        let record = KeyRecord::parse(Some(
            r#"{"v":1,"keyId":"pnk_1","workspaceId":"ws_1","projectId":"pnp_1","status":"paused"}"#,
        ))
        .expect("a record");
        assert_eq!(record.status.as_deref(), Some("paused"));
        assert_eq!(
            KeyRecord::parse(Some(&record.to_value().to_string())),
            Some(record)
        );
        let unknown_status = KeyRecord::parse(Some(
            r#"{"v":1.0,"keyId":"pnk_1","workspaceId":"ws_1","projectId":"pnp_1","status":"gone"}"#,
        ))
        .expect("a record");
        assert_eq!(unknown_status.status, None);
        for bad in [
            r#"{"v":2,"keyId":"pnk_1","workspaceId":"ws_1","projectId":"pnp_1"}"#,
            r#"{"v":1,"workspaceId":"ws_1","projectId":"pnp_1"}"#,
            "null",
            "not json",
            "",
        ] {
            assert_eq!(KeyRecord::parse(Some(bad)), None, "{bad}");
        }
        assert_eq!(key_key("abc"), "panel:key:abc");
    }

    #[test]
    fn snapshot_requests_need_a_page_group_a_pattern_and_a_device_class() {
        let request = json!({ "pageGroupId": "pnh_products", "urlPattern": "/products/*", "deviceClass": "tablet" });
        assert_eq!(
            parse_snapshot_request(Some(&request.to_string())),
            Some(request)
        );
        for bad in [
            json!({ "pageGroupId": "../x", "urlPattern": "/", "deviceClass": "desktop" }),
            json!({ "pageGroupId": "pnh_1", "urlPattern": "", "deviceClass": "desktop" }),
            json!({ "pageGroupId": "pnh_1", "urlPattern": "/", "deviceClass": "phone" }),
            json!(null),
        ] {
            assert_eq!(
                parse_snapshot_request(Some(&bad.to_string())),
                None,
                "{bad}"
            );
        }
        assert_eq!(
            snapshot_request_key("pnp_1"),
            "panel:snapshot-request:pnp_1"
        );
    }

    #[test]
    fn object_keys_have_global_s_layout() {
        assert_eq!(
            replay_chunk_key("30d", "ws_1", "pnp_1", "2026-10-27", "s-1", 3),
            "30d/ws_1/pnp_1/2026-10-27/s-1/3.json.gz"
        );
        assert_eq!(
            heatmap_snapshot_key("ws_1", "pnp_1", "pnh_products", "mobile"),
            "snapshots/ws_1/pnp_1/pnh_products/mobile.json.gz"
        );
        let tier = |extra: &str| {
            ProjectRecord::parse(Some(&format!(
                r#"{{"v":1,"projectId":"p","workspaceId":"w"{extra}}}"#
            )))
            .expect("a record")
            .replay_tier()
        };
        assert_eq!(tier(""), "30d");
        assert_eq!(tier(r#","replayTier":null"#), "30d");
        assert_eq!(tier(r#","replayTier":"90d""#), "90d");
    }

    #[test]
    fn the_plan_decides_the_replay_tier_and_30d_is_left_out() {
        for slug in ["scale", "enterprise", " Scale "] {
            assert_eq!(plan_replay_tier(Some(slug)), "90d", "{slug}");
        }
        for slug in [Some("free"), Some("business"), Some("unknown"), None] {
            assert_eq!(plan_replay_tier(slug), "30d", "{slug:?}");
        }
        let record = project_record("pnp_1", "ws_1", &json!("active"), &json!([]), &json!({}));
        let ninety = with_replay_tier(record.clone(), "90d");
        assert_eq!(ninety["replayTier"], "90d");
        assert!(names_replay_tier(&ninety, "90d"));
        assert!(!names_replay_tier(&ninety, "30d"));
        let thirty = with_replay_tier(ninety, "30d");
        assert!(thirty.get("replayTier").is_none());
        assert!(names_replay_tier(&thirty, "30d"));
        assert!(!names_replay_tier(&json!({ "replayTier": null }), "30d"));
        assert_eq!(tier_key("ws_1"), "panel:tier:ws_1");
    }

    #[test]
    fn reads_a_stored_record_as_it_is() {
        let raw = r#"{"v":1,"projectId":"p","workspaceId":"w","settings":{},"extra":1}"#;
        assert_eq!(
            stored_project_record(Some(raw)),
            Some(serde_json::from_str::<Value>(raw).expect("json"))
        );
        for raw in [
            r#"{"v":2,"projectId":"p","workspaceId":"w"}"#,
            r#"{"v":1,"projectId":1,"workspaceId":"w"}"#,
            "not json",
            "",
        ] {
            assert!(stored_project_record(Some(raw)).is_none(), "{raw}");
        }
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
