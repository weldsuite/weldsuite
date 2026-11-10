//! `parse_alert` (`engine/actions/alerts.ts`): turn a monitoring alert
//! (Splunk, Datadog, Grafana, or anything alike) into the few fields a
//! helpdesk ticket needs, so a workflow can open, escalate and close a
//! WeldDesk conversation from an inbound webhook. Pure: no I/O, and odd input
//! (a string, an array, null) never errors, it answers `success: false`.
//!
//! Inputs: `payload` (defaults to the trigger body), `source` (auto, splunk,
//! datadog or grafana), `defaultPriority` (low, medium, high or urgent).

use serde_json::{Map, Value, json};

use super::{ActionCtx, ActionResult};
use crate::js::js_string;

const URGENT: &[&str] = &["critical", "fatal", "emergency", "disaster", "p1", "sev1"];
const HIGH: &[&str] = &["high", "error", "major", "p2", "sev2"];
const MEDIUM: &[&str] = &["warning", "warn", "medium", "moderate", "p3", "sev3"];
const LOW: &[&str] = &[
    "low",
    "info",
    "informational",
    "minor",
    "notice",
    "debug",
    "p4",
    "p5",
    "sev4",
    "sev5",
];
const RESOLVED_STATES: &[&str] = &["resolved", "ok", "recovered", "closed"];

/// A scalar as trimmed text; objects, arrays and empty values give "".
fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.trim().to_owned(),
        Some(v @ (Value::Number(_) | Value::Bool(_))) => js_string(Some(v)),
        _ => String::new(),
    }
}

/// The first non-empty text among the keys of `map`.
fn first(map: &Map<String, Value>, keys: &[&str]) -> String {
    keys.iter()
        .map(|key| text(map.get(*key)))
        .find(|t| !t.is_empty())
        .unwrap_or_default()
}

/// The first non-empty text among already-read candidates.
fn pick(candidates: &[String]) -> String {
    candidates
        .iter()
        .find(|t| !t.is_empty())
        .cloned()
        .unwrap_or_default()
}

fn object(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

/// Severity words differ in case and punctuation ("SEV-1", "Sev 1"):
/// compare on letters and digits.
fn severity_key(severity: &str) -> String {
    severity
        .to_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect()
}

fn severity_to_priority(severity: &str, fallback: &str) -> String {
    let key = severity_key(severity);
    let key = key.as_str();
    let mapped = if URGENT.contains(&key) {
        "urgent"
    } else if HIGH.contains(&key) {
        "high"
    } else if MEDIUM.contains(&key) {
        "medium"
    } else if LOW.contains(&key) {
        "low"
    } else {
        fallback
    };
    mapped.to_owned()
}

struct Fields {
    external_id: String,
    title: String,
    message: String,
    severity: String,
    resolved: bool,
    url: String,
}

fn grafana(p: &Map<String, Value>) -> Fields {
    let alerts: Vec<Map<String, Value>> = match p.get("alerts") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                Value::Object(map) => Some(map.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    let first_alert = alerts.first().cloned().unwrap_or_default();
    let labels = object(first_alert.get("labels"));
    let annotations = object(first_alert.get("annotations"));
    let common = object(p.get("commonLabels"));
    let common_notes = object(p.get("commonAnnotations"));
    let summaries: Vec<String> = alerts
        .iter()
        .map(|a| first(&object(a.get("annotations")), &["summary", "description"]))
        .filter(|s| !s.is_empty())
        .collect();
    Fields {
        external_id: pick(&[
            text(p.get("groupKey")),
            text(first_alert.get("fingerprint")),
        ]),
        title: pick(&[
            text(p.get("title")),
            text(common_notes.get("summary")),
            text(common.get("alertname")),
            text(labels.get("alertname")),
            text(annotations.get("summary")),
        ]),
        message: pick(&[
            text(p.get("message")),
            summaries.join("\n"),
            text(common_notes.get("description")),
            text(annotations.get("description")),
        ]),
        severity: pick(&[text(common.get("severity")), text(labels.get("severity"))]),
        resolved: text(p.get("status")).to_lowercase() == "resolved",
        url: pick(&[
            text(first_alert.get("generatorURL")),
            text(p.get("externalURL")),
        ]),
    }
}

/// What makes one Datadog alert one ticket (`datadogKey`). A multi-alert
/// monitor fires once per group (host:a, host:b, ...) under one `alert_id`, so
/// the group is part of the key. `aggreg_key` when present, else `alert_id`
/// plus the group (`alert_scope`, else `scope`; its tags sorted, so a firing
/// and its recovery agree), else `alert_id`, else `id`.
fn datadog_key(p: &Map<String, Value>) -> String {
    let aggreg_key = first(p, &["aggreg_key"]);
    if !aggreg_key.is_empty() {
        return aggreg_key;
    }
    let alert_id = first(p, &["alert_id"]);
    if alert_id.is_empty() {
        return first(p, &["id"]);
    }
    let mut tags: Vec<String> = first(p, &["alert_scope", "scope"])
        .split(',')
        .map(|tag| tag.trim().to_owned())
        .filter(|tag| !tag.is_empty())
        .collect();
    tags.sort();
    if tags.is_empty() {
        alert_id
    } else {
        format!("{alert_id}:{}", tags.join(","))
    }
}

fn datadog(p: &Map<String, Value>) -> Fields {
    let transition = text(p.get("alert_transition")).to_lowercase();
    let kind = text(p.get("alert_type")).to_lowercase();
    Fields {
        external_id: datadog_key(p),
        title: first(p, &["alert_title", "title"]),
        message: first(p, &["body", "message", "text", "event_msg"]),
        severity: first(p, &["alert_priority", "alert_type"]),
        resolved: transition == "recovered" || kind == "success",
        url: first(p, &["link", "url"]),
    }
}

fn splunk(p: &Map<String, Value>) -> Fields {
    let result = object(p.get("result"));
    let name = first(p, &["search_name"]);
    let mut lines: Vec<String> = Vec::new();
    if !name.is_empty() {
        lines.push(format!("Splunk alert \"{name}\" fired."));
    }
    let mut place: Vec<String> = Vec::new();
    let app = first(p, &["app"]);
    if !app.is_empty() {
        place.push(format!("app {app}"));
    }
    let owner = first(p, &["owner"]);
    if !owner.is_empty() {
        place.push(format!("owner {owner}"));
    }
    if !place.is_empty() {
        lines.push(place.join(", "));
    }
    // By field name (the map is ordered), as the TypeScript engine sorts them.
    for (field, value) in &result {
        let value = text(Some(value));
        if !value.is_empty() {
            lines.push(format!("{field}: {value}"));
        }
    }
    Fields {
        external_id: if name.is_empty() {
            first(p, &["sid"])
        } else {
            name.clone()
        },
        title: name,
        message: lines.join("\n"),
        severity: first(&result, &["severity", "urgency"]),
        resolved: false,
        url: first(p, &["results_link"]),
    }
}

fn generic(p: &Map<String, Value>) -> Fields {
    let status = first(p, &["status", "state"]).to_lowercase();
    Fields {
        external_id: first(p, &["id", "externalId", "fingerprint"]),
        title: first(p, &["title", "summary", "name"]),
        message: first(p, &["message", "description", "body", "text"]),
        severity: first(p, &["severity", "priority", "level"]),
        resolved: RESOLVED_STATES.contains(&status.as_str()),
        url: first(p, &["url", "link"]),
    }
}

fn detect(p: &Map<String, Value>) -> &'static str {
    let has = |key: &str| p.contains_key(key);
    if p.get("alerts").is_some_and(Value::is_array) && (has("groupKey") || has("receiver")) {
        "grafana"
    } else if has("search_name") && (has("sid") || has("results_link")) {
        "splunk"
    } else if ["alert_transition", "alert_type", "aggreg_key", "alert_id"]
        .iter()
        .any(|key| has(key))
    {
        "datadog"
    } else {
        "generic"
    }
}

/// The payload as an object: an object as is, a JSON string parsed, anything
/// else `None`.
fn as_payload(payload: &Value) -> Option<Map<String, Value>> {
    match payload {
        Value::Object(map) => Some(map.clone()),
        Value::String(raw) => match serde_json::from_str::<Value>(raw) {
            Ok(Value::Object(map)) => Some(map),
            _ => None,
        },
        _ => None,
    }
}

/// The widest key the conversation's `external_id` column takes.
const EXTERNAL_ID_MAX: usize = 255;

/// FNV-1a over the UTF-8 bytes, as 8 hex digits: a stable suffix for a key
/// that had to be cut.
fn fnv1a(text: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in text.bytes() {
        hash = (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

/// `fitExternalId`: a key over 255 characters is cut to 246 plus `~` and a
/// hash of the whole key, so long keys stay distinct.
pub(super) fn fit_external_id(external_id: &str) -> String {
    if external_id.chars().count() <= EXTERNAL_ID_MAX {
        return external_id.to_owned();
    }
    let head: String = external_id.chars().take(EXTERNAL_ID_MAX - 9).collect();
    format!("{head}~{}", fnv1a(external_id))
}

/// `parseAlert(payload, source, defaultPriority)`.
pub(super) fn parse_alert(payload: &Value, source: &str, default_priority: &str) -> Value {
    let Some(p) = as_payload(payload) else {
        return json!({ "success": false, "error": "The alert payload is not a JSON object" });
    };
    let chosen = source.to_lowercase();
    let kind = match chosen.as_str() {
        "splunk" => "splunk",
        "datadog" => "datadog",
        "grafana" => "grafana",
        _ => detect(&p),
    };
    let fields = match kind {
        "grafana" => grafana(&p),
        "datadog" => datadog(&p),
        "splunk" => splunk(&p),
        _ => generic(&p),
    };
    if fields.external_id.is_empty() && fields.title.is_empty() {
        return json!({ "success": false, "error": "The alert has neither an id nor a title" });
    }
    let title = if fields.title.is_empty() {
        format!("{kind} alert {}", fields.external_id)
    } else {
        fields.title.clone()
    };
    let link = if !fields.url.is_empty() && !fields.message.contains(&fields.url) {
        format!("\n\n{}", fields.url)
    } else {
        String::new()
    };
    let body = if fields.message.is_empty() {
        title.clone()
    } else {
        fields.message.clone()
    };
    let id_part = if fields.external_id.is_empty() {
        &fields.title
    } else {
        &fields.external_id
    };
    json!({
        "success": true,
        "source": kind,
        "externalId": fit_external_id(&format!("{kind}:{id_part}")),
        "title": title,
        "message": format!("{body}{link}"),
        "severity": fields.severity,
        "priority": severity_to_priority(&fields.severity, default_priority),
        "state": if fields.resolved { "closed" } else { "open" },
        "resolved": fields.resolved,
        "url": fields.url,
        "tags": [kind, "alert"],
    })
}

/// `handleParseAlert`.
#[allow(clippy::unnecessary_wraps)] // the dispatcher's signature
pub(super) fn run(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let given = inputs
        .get("payload")
        .filter(|v| !v.is_null() && **v != json!(""));
    let payload = given.unwrap_or_else(|| ctx.trigger_data.get("body").unwrap_or(&Value::Null));
    let source = text(inputs.get("source"));
    let source = if source.is_empty() { "auto" } else { &source };
    let priority = text(inputs.get("defaultPriority")).to_lowercase();
    let priority = match priority.as_str() {
        p @ ("low" | "medium" | "high" | "urgent") => p,
        _ => "medium",
    };
    Ok(parse_alert(payload, source, priority))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_grafana_firing_and_resolved_on_one_key() {
        let firing = json!({
            "receiver": "weldsuite",
            "status": "firing",
            "groupKey": "{}:{alertname=\"HighCPU\"}",
            "title": "[FIRING:1] HighCPU web-1",
            "message": "CPU is above 90%",
            "commonLabels": { "severity": "critical" },
            "alerts": [{ "generatorURL": "https://g.test/1", "fingerprint": "fp" }],
        });
        let parsed = parse_alert(&firing, "auto", "medium");
        assert_eq!(parsed["source"], "grafana");
        assert_eq!(parsed["externalId"], "grafana:{}:{alertname=\"HighCPU\"}");
        assert_eq!(parsed["priority"], "urgent");
        assert_eq!(parsed["state"], "open");
        assert_eq!(parsed["message"], "CPU is above 90%\n\nhttps://g.test/1");

        let mut resolved = firing.clone();
        resolved["status"] = json!("resolved");
        let closed = parse_alert(&resolved, "auto", "medium");
        assert_eq!(closed["state"], "closed");
        assert_eq!(closed["externalId"], parsed["externalId"]);
    }

    #[test]
    fn reads_datadog_and_splunk() {
        let datadog = json!({
            "alert_id": "77", "alert_title": "Disk low", "alert_transition": "Recovered",
            "alert_priority": "P2", "body": "ok again", "link": "https://dd.test/77",
        });
        let parsed = parse_alert(&datadog, "auto", "medium");
        assert_eq!(parsed["externalId"], "datadog:77");
        assert_eq!(parsed["priority"], "high");
        assert_eq!(parsed["resolved"], true);

        let splunk = json!({
            "sid": "s1", "search_name": "Failed logins", "app": "search", "owner": "admin",
            "results_link": "https://splunk.test/1",
            "result": { "urgency": "High", "host": "auth-1" },
        });
        let parsed = parse_alert(&splunk, "auto", "low");
        assert_eq!(parsed["externalId"], "splunk:Failed logins");
        assert_eq!(parsed["priority"], "high");
        assert_eq!(parsed["state"], "open");
        assert_eq!(
            parsed["message"],
            "Splunk alert \"Failed logins\" fired.\napp search, owner admin\nhost: auth-1\nurgency: High\n\nhttps://splunk.test/1"
        );
    }

    #[test]
    fn refuses_what_is_not_an_alert() {
        for payload in [
            json!(null),
            json!("nope"),
            json!([1]),
            json!(7),
            json!({}),
            json!({ "id": " " }),
        ] {
            assert_eq!(parse_alert(&payload, "auto", "medium")["success"], false);
        }
        assert_eq!(
            parse_alert(&json!("{\"title\":\"T\"}"), "auto", "low")["priority"],
            "low"
        );
    }

    #[test]
    fn maps_severity_words() {
        for (word, priority) in [
            ("SEV-1", "urgent"),
            ("Major", "high"),
            ("WARN", "medium"),
            ("P5", "low"),
            ("purple", "high"),
        ] {
            assert_eq!(severity_to_priority(word, "high"), priority);
        }
    }

    #[test]
    fn keys_datadog_alerts_per_group() {
        let id = |payload: Value| parse_alert(&payload, "auto", "medium")["externalId"].clone();
        let base = json!({ "alert_id": "7771", "alert_title": "CPU" });
        let with = |extra: Value| {
            let mut p = base.clone();
            for (k, v) in extra.as_object().expect("an object") {
                p[k] = v.clone();
            }
            p
        };
        assert_eq!(
            id(with(json!({ "aggreg_key": "g1", "alert_scope": "host:a" }))),
            "datadog:g1"
        );
        assert_eq!(
            id(with(json!({ "alert_scope": "host:a,env:prod" }))),
            "datadog:7771:env:prod,host:a"
        );
        assert_eq!(
            id(with(
                json!({ "alert_scope": " env:prod, host:a", "alert_transition": "Recovered" })
            )),
            "datadog:7771:env:prod,host:a"
        );
        assert_ne!(
            id(with(json!({ "alert_scope": "host:a" }))),
            id(with(json!({ "alert_scope": "host:b" })))
        );
        assert_eq!(
            id(with(json!({ "scope": "host:a" }))),
            "datadog:7771:host:a"
        );
        assert_eq!(id(with(json!({ "tags": "host:a" }))), "datadog:7771");
        assert_eq!(
            id(json!({ "id": "900", "alert_type": "error" })),
            "datadog:900"
        );
    }

    #[test]
    fn cuts_long_ids_by_characters() {
        let long = "é".repeat(300);
        let fitted = fit_external_id(&long);
        assert_eq!(fitted.chars().count(), 255);
        assert!(fitted.starts_with(&"é".repeat(246)));
        assert_eq!(fit_external_id(&"a".repeat(255)), "a".repeat(255));
    }
}
