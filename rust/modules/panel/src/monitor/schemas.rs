//! The Zod schemas of `@weldsuite/app-api-client/schemas/weldpanel-monitor`
//! as [`Z`] trees, written by hand: `tools/generate.mts` writes refinements
//! only, and these transform too (a deduplicated recipient list, a prefix
//! without slashes, an endpoint without its trailing slash). Each tree
//! follows its schema's nesting (`.refine().nullable().optional()` is
//! `Opt(Nul(Refine(…)))`), so a bad body gets Zod's own issues.

use serde_json::{Value, json};
use weldsuite_zod::{Hook, Keys, Lit, N, S, Z};

use crate::schemas_gen::TRENDS_SPEC;

/// `z.string().min(1).max(30)`: a project or object id.
const ID: Z = Z::Str(&[S::Min(1, None), S::Max(30, None)]);
/// `z.string().trim().min(1).max(255)`.
const NAME: Z = Z::Str(&[S::Trim, S::Min(1, None), S::Max(255, None)]);
/// `z.string().datetime({ offset: true })`.
const ISO: Z = Z::Str(&[S::Datetime {
    offset: true,
    msg: None,
}]);
const SCOPE: Z = Z::Enum(&["all", "mine"], None);

fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// `[...new Set(items)]`.
fn dedupe(value: Option<Value>) -> Option<Value> {
    match value {
        Some(Value::Array(items)) => {
            let mut out: Vec<Value> = Vec::with_capacity(items.len());
            for item in items {
                if !out.contains(&item) {
                    out.push(item);
                }
            }
            Some(Value::Array(out))
        }
        other => other,
    }
}

// ---------------------------------------------------------------------------
// Delivery channels
// ---------------------------------------------------------------------------

/// `isSlackWebhookUrl(value)`.
pub(crate) fn is_slack_webhook_url(value: &str) -> bool {
    if !value.starts_with("https://hooks.slack.com/") {
        return false;
    }
    url::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("hooks.slack.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.path().len() > 1
    })
}

fn refine_slack_webhook_url(value: Option<&Value>, hook: &mut Hook) {
    if let Some(url) = text(value)
        && !is_slack_webhook_url(url)
    {
        hook.fail("Use a Slack incoming webhook URL (https://hooks.slack.com/…)");
    }
}

/// `panelDeliveryChannelsInputSchema`.
pub(crate) const CHANNELS: Z = Z::Obj(
    &[
        (
            "emailUserIds",
            Z::Transform(
                &Z::Def(
                    &Z::Arr(
                        &Z::Str(&[S::Min(1, None), S::Max(255, None)]),
                        None,
                        Some((20, None)),
                    ),
                    "[]",
                ),
                dedupe,
            ),
        ),
        ("inApp", Z::Def(&Z::Bool, "false")),
        (
            "slackWebhookUrl",
            Z::Opt(&Z::Nul(&Z::Refine(
                &Z::Str(&[S::Max(500, None)]),
                refine_slack_webhook_url,
            ))),
        ),
        (
            "weldchatChannelId",
            Z::Opt(&Z::Nul(&Z::Str(&[S::Min(1, None), S::Max(30, None)]))),
        ),
    ],
    Keys::Strip,
);

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/// `panelAlertConditionSchema`.
pub(crate) const CONDITION: Z = Z::Disc(
    "type",
    &[
        Z::Obj(
            &[
                ("type", Z::Lit(Lit::Str("threshold"))),
                ("operator", Z::Enum(&["above", "below"], None)),
                ("value", Z::Num(&[N::Finite(None)])),
            ],
            Keys::Strip,
        ),
        Z::Obj(
            &[
                ("type", Z::Lit(Lit::Str("change"))),
                ("direction", Z::Enum(&["increase", "decrease", "any"], None)),
                (
                    "percent",
                    Z::Num(&[N::Min(0.0, false, None), N::Max(100_000.0, true, None)]),
                ),
            ],
            Keys::Strip,
        ),
        Z::Obj(
            &[
                ("type", Z::Lit(Lit::Str("anomaly"))),
                ("sensitivity", Z::Enum(&["low", "medium", "high"], None)),
            ],
            Keys::Strip,
        ),
    ],
);

const INTERVAL: Z = Z::Enum(&["hourly", "daily", "weekly"], None);
const SERIES_INDEX: Z = Z::Num(&[
    N::Int(None),
    N::Min(0.0, true, None),
    N::Max(4.0, true, None),
]);
const REPORT_ID: Z = Z::Opt(&Z::Nul(&ID));
const SPEC: Z = Z::Opt(&Z::Nul(&TRENDS_SPEC));

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(_) => true,
    }
}

fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.get(key))
}

/// `createPanelAlertSchema`'s refine: a report or a spec, not both.
fn refine_create_alert(value: Option<&Value>, hook: &mut Hook) {
    if truthy(field(value, "reportId")) == truthy(field(value, "spec")) {
        hook.fail_at(&[json!("reportId")], "Give either a report or a spec");
    }
}

/// `updatePanelAlertSchema`'s refine: not both.
fn refine_update_alert(value: Option<&Value>, hook: &mut Hook) {
    if truthy(field(value, "reportId")) && truthy(field(value, "spec")) {
        hook.fail_at(&[json!("reportId")], "Give either a report or a spec");
    }
}

/// `createPanelAlertSchema`.
pub(crate) const CREATE_ALERT: Z = Z::Refine(
    &Z::Obj(
        &[
            ("projectId", ID),
            ("name", NAME),
            ("reportId", REPORT_ID),
            ("spec", SPEC),
            ("seriesIndex", Z::Def(&SERIES_INDEX, "0")),
            ("condition", CONDITION),
            ("checkInterval", Z::Def(&INTERVAL, "\"daily\"")),
            ("channels", CHANNELS),
            ("enabled", Z::Def(&Z::Bool, "true")),
        ],
        Keys::Strip,
    ),
    refine_create_alert,
);

/// `updatePanelAlertSchema`.
pub(crate) const UPDATE_ALERT: Z = Z::Refine(
    &Z::Obj(
        &[
            ("name", Z::Opt(&NAME)),
            ("reportId", REPORT_ID),
            ("spec", SPEC),
            ("seriesIndex", Z::Opt(&SERIES_INDEX)),
            ("condition", Z::Opt(&CONDITION)),
            ("checkInterval", Z::Opt(&INTERVAL)),
            ("channels", Z::Opt(&CHANNELS)),
            ("enabled", Z::Opt(&Z::Bool)),
        ],
        Keys::Strip,
    ),
    refine_update_alert,
);

/// `snoozePanelAlertSchema`.
pub(crate) const SNOOZE_ALERT: Z = Z::Obj(&[("until", Z::Nul(&ISO))], Keys::Strip);

/// The alerts' list query.
pub(crate) const ALERT_LIST_QUERY: Z = Z::Obj(
    &[("projectId", Z::Opt(&ID)), ("scope", Z::Opt(&SCOPE))],
    Keys::Strip,
);

/// A history page: `?cursor` (ISO) and `?limit` (1 to `max`).
macro_rules! page_query {
    ($max:expr) => {
        Z::Obj(
            &[
                ("cursor", Z::Opt(&ISO)),
                (
                    "limit",
                    Z::Opt(&Z::CoerceNum(&[
                        N::Int(None),
                        N::Min(1.0, true, None),
                        N::Max($max, true, None),
                    ])),
                ),
            ],
            Keys::Strip,
        )
    };
}

/// An alert's history page (`limit` at most 100).
pub(crate) const ALERT_PAGE_QUERY: Z = page_query!(100.0);

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

fn refine_time_zone(value: Option<&Value>, hook: &mut Hook) {
    if let Some(zone) = text(value)
        && weldsuite_panel_domain::js::time_zone(zone).is_none()
    {
        hook.fail("Unknown timezone");
    }
}

/// `panelSubscriptionScheduleSchema`'s superRefine.
fn refine_schedule(value: Option<&Value>, hook: &mut Hook) {
    let frequency = text(field(value, "frequency"));
    if frequency == Some("weekly") && field(value, "weekday").is_none() {
        hook.fail_at(&[json!("weekday")], "Choose a weekday");
    }
    if frequency == Some("monthly") && field(value, "monthDay").is_none() {
        hook.fail_at(&[json!("monthDay")], "Choose a day of the month");
    }
}

/// `panelSubscriptionScheduleSchema`.
pub(crate) const SCHEDULE: Z = Z::Refine(
    &Z::Obj(
        &[
            ("frequency", Z::Enum(&["daily", "weekly", "monthly"], None)),
            (
                "hour",
                Z::Num(&[
                    N::Int(None),
                    N::Min(0.0, true, None),
                    N::Max(23.0, true, None),
                ]),
            ),
            (
                "weekday",
                Z::Opt(&Z::Num(&[
                    N::Int(None),
                    N::Min(0.0, true, None),
                    N::Max(6.0, true, None),
                ])),
            ),
            (
                "monthDay",
                Z::Opt(&Z::Num(&[
                    N::Int(None),
                    N::Min(1.0, true, None),
                    N::Max(28.0, true, None),
                ])),
            ),
            (
                "timezone",
                Z::Def(
                    &Z::Refine(
                        &Z::Str(&[S::Min(1, None), S::Max(64, None)]),
                        refine_time_zone,
                    ),
                    "\"UTC\"",
                ),
            ),
        ],
        Keys::Strip,
    ),
    refine_schedule,
);

const TARGET_TYPE: Z = Z::Enum(&["report", "dashboard"], None);

/// `createPanelSubscriptionSchema`.
pub(crate) const CREATE_SUBSCRIPTION: Z = Z::Obj(
    &[
        ("projectId", ID),
        ("name", NAME),
        ("targetType", TARGET_TYPE),
        ("targetId", ID),
        ("schedule", SCHEDULE),
        ("channels", CHANNELS),
        ("enabled", Z::Def(&Z::Bool, "true")),
    ],
    Keys::Strip,
);

/// `updatePanelSubscriptionSchema`.
pub(crate) const UPDATE_SUBSCRIPTION: Z = Z::Obj(
    &[
        ("name", Z::Opt(&NAME)),
        ("schedule", Z::Opt(&SCHEDULE)),
        ("channels", Z::Opt(&CHANNELS)),
        ("enabled", Z::Opt(&Z::Bool)),
    ],
    Keys::Strip,
);

/// The subscriptions' list query.
pub(crate) const SUBSCRIPTION_LIST_QUERY: Z = Z::Obj(
    &[
        ("projectId", Z::Opt(&ID)),
        ("targetType", Z::Opt(&TARGET_TYPE)),
        ("targetId", Z::Opt(&ID)),
        ("scope", Z::Opt(&SCOPE)),
    ],
    Keys::Strip,
);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/// Suffixes no outbound request may go to (`PRIVATE_SUFFIXES`).
const PRIVATE_SUFFIXES: [&str; 8] = [
    ".localhost",
    ".local",
    ".internal",
    ".lan",
    ".home",
    ".corp",
    ".intranet",
    ".weldsuite.org",
];

/// `isPublicHostname(hostname)`: a dotted DNS name, no IP literal,
/// `localhost`, private suffix or WeldSuite host.
pub(crate) fn is_public_hostname(hostname: &str) -> bool {
    let lower = hostname.to_lowercase();
    let host = lower.strip_suffix('.').unwrap_or(&lower);
    if host.is_empty() || !host.contains('.') || host.starts_with('[') || host.contains(':') {
        return false;
    }
    let ipv4 = {
        let parts: Vec<&str> = host.split('.').collect();
        parts.len() == 4
            && parts
                .iter()
                .all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
    };
    if ipv4 || host == "localhost" || host == "weldsuite.org" {
        return false;
    }
    !PRIVATE_SUFFIXES.iter().any(|suffix| host.ends_with(suffix))
}

/// `isEndpoint(value)`: an `https://` origin without path, query, hash or
/// credentials, on a public host name.
fn is_endpoint(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && (url.path() == "/" || url.path().is_empty())
            && url.query().is_none_or(str::is_empty)
            && url.fragment().is_none_or(str::is_empty)
            && url
                .host_str()
                .is_some_and(|host| is_public_hostname(&js_hostname(host)))
    })
}

/// `new URL(…).hostname` as JavaScript writes an IPv6 host (with brackets).
fn js_hostname(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    }
}

fn refine_endpoint(value: Option<&Value>, hook: &mut Hook) {
    if let Some(endpoint) = text(value)
        && !is_endpoint(endpoint)
    {
        hook.fail("Use an https:// origin without a path");
    }
}

/// `(v) => (v ? v.replace(/\/$/, '') : null)`: a `TransformFn`, so an `Option`.
#[allow(clippy::unnecessary_wraps)]
fn endpoint_or_null(value: Option<Value>) -> Option<Value> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Some(Value::String(
            text.strip_suffix('/').unwrap_or(&text).to_owned(),
        )),
        _ => Some(Value::Null),
    }
}

/// `trimSlashes`: `/a/b/` → `a/b`.
fn trim_slashes(value: Option<Value>) -> Option<Value> {
    match value {
        Some(Value::String(text)) => Some(Value::String(text.trim_matches('/').to_owned())),
        other => other,
    }
}

/// `panelExportDestinationSchema`'s superRefine.
fn refine_destination(value: Option<&Value>, hook: &mut Hook) {
    if text(field(value, "provider")) != Some("s3") && !truthy(field(value, "endpoint")) {
        hook.fail_at(&[json!("endpoint")], "This provider needs its endpoint");
    }
}

/// `panelExportDestinationSchema`.
pub(crate) const DESTINATION: Z = Z::Refine(
    &Z::Obj(
        &[
            (
                "provider",
                Z::Enum(&["s3", "r2", "gcs", "minio", "other"], None),
            ),
            (
                "endpoint",
                Z::Transform(
                    &Z::Opt(&Z::Nul(&Z::Refine(
                        &Z::Str(&[S::Max(500, None)]),
                        refine_endpoint,
                    ))),
                    endpoint_or_null,
                ),
            ),
            (
                "region",
                Z::Str(&[
                    S::Trim,
                    S::Regex("^[A-Za-z0-9-]{1,64}$", Some("Not a valid region")),
                ]),
            ),
            (
                "bucket",
                Z::Str(&[
                    S::Trim,
                    S::Regex(
                        "^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$",
                        Some("Not a valid bucket name"),
                    ),
                ]),
            ),
            (
                "prefix",
                Z::Transform(
                    &Z::Def(
                        &Z::Str(&[
                            S::Trim,
                            S::Max(200, None),
                            S::Regex(
                                "^[A-Za-z0-9!_.*'()/-]*$",
                                Some("Use letters, digits and / - _ . ! * ' ( ) only"),
                            ),
                        ]),
                        "\"\"",
                    ),
                    trim_slashes,
                ),
            ),
            (
                "accessKeyId",
                Z::Str(&[S::Trim, S::Min(1, None), S::Max(128, None)]),
            ),
            ("pathStyle", Z::Def(&Z::Bool, "false")),
        ],
        Keys::Strip,
    ),
    refine_destination,
);

const SECRET: Z = Z::Str(&[S::Min(1, None), S::Max(256, None)]);
const TABLES: Z = Z::Transform(
    &Z::Arr(
        &Z::Enum(&["events", "people", "groups", "identities"], None),
        Some((1, None)),
        Some((4, None)),
    ),
    dedupe,
);
const FREQUENCY: Z = Z::Enum(&["hourly", "daily"], None);

/// `createPanelExportSchema`.
pub(crate) const CREATE_EXPORT: Z = Z::Obj(
    &[
        ("projectId", ID),
        ("name", NAME),
        ("destination", DESTINATION),
        ("secretAccessKey", SECRET),
        ("tables", TABLES),
        ("frequency", Z::Def(&FREQUENCY, "\"daily\"")),
        ("startAt", Z::Opt(&ISO)),
    ],
    Keys::Strip,
);

/// `updatePanelExportSchema`.
pub(crate) const UPDATE_EXPORT: Z = Z::Obj(
    &[
        ("name", Z::Opt(&NAME)),
        ("destination", Z::Opt(&DESTINATION)),
        ("secretAccessKey", Z::Opt(&SECRET)),
        ("tables", Z::Opt(&TABLES)),
        ("frequency", Z::Opt(&FREQUENCY)),
    ],
    Keys::Strip,
);

/// `testPanelExportSchema`'s refine.
fn refine_test_export(value: Option<&Value>, hook: &mut Hook) {
    let saved = truthy(field(value, "exportId"));
    let fresh = truthy(field(value, "projectId"))
        && truthy(field(value, "destination"))
        && truthy(field(value, "secretAccessKey"));
    if !saved && !fresh {
        hook.fail("Send a saved export, or a project, destination and secret key");
    }
}

/// `testPanelExportSchema`.
pub(crate) const TEST_EXPORT: Z = Z::Refine(
    &Z::Obj(
        &[
            ("exportId", Z::Opt(&ID)),
            ("projectId", Z::Opt(&ID)),
            ("destination", Z::Opt(&DESTINATION)),
            ("secretAccessKey", Z::Opt(&SECRET)),
        ],
        Keys::Strip,
    ),
    refine_test_export,
);

/// The exports' list query: `?projectId` is required.
pub(crate) const EXPORT_LIST_QUERY: Z = Z::Obj(&[("projectId", ID)], Keys::Strip);

/// An export's runs page (`limit` at most 200).
pub(crate) const EXPORT_PAGE_QUERY: Z = page_query!(200.0);

// ---------------------------------------------------------------------------
// Custom domains
// ---------------------------------------------------------------------------

/// `isHostname(value)`: two or more labels of letters, digits and inner
/// hyphens, a letters-only top level.
pub(crate) fn is_hostname(value: &str) -> bool {
    if value.len() < 4 || value.len() > 253 {
        return false;
    }
    let labels: Vec<&str> = value.split('.').collect();
    let Some(tld) = labels.last() else {
        return false;
    };
    if labels.len() < 2
        || !(2..=63).contains(&tld.len())
        || !tld.bytes().all(|b| b.is_ascii_lowercase())
    {
        return false;
    }
    labels.iter().all(|label| {
        (1..=63).contains(&label.len())
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

fn refine_hostname(value: Option<&Value>, hook: &mut Hook) {
    if let Some(host) = text(value)
        && !is_hostname(host)
    {
        hook.fail("Enter a host name like stats.example.com");
    }
}

fn refine_own_hostname(value: Option<&Value>, hook: &mut Hook) {
    if let Some(host) = text(value)
        && (host == "weldsuite.org" || host.ends_with(".weldsuite.org"))
    {
        hook.fail("Use a host name of your own");
    }
}

/// `createPanelDomainSchema`.
pub(crate) const CREATE_DOMAIN: Z = Z::Obj(
    &[(
        "hostname",
        Z::Refine(
            &Z::Refine(&Z::Str(&[S::Trim, S::Lower]), refine_hostname),
            refine_own_hostname,
        ),
    )],
    Keys::Strip,
);

#[cfg(test)]
mod tests {
    use super::*;

    fn issues(schema: &Z, value: &Value) -> Vec<Value> {
        weldsuite_zod::parse_issues(schema, value)
            .err()
            .unwrap_or_default()
    }

    #[test]
    fn hosts_endpoints_and_webhooks() {
        assert!(is_public_hostname("acc.r2.cloudflarestorage.com"));
        assert!(is_public_hostname("storage.googleapis.com."));
        for host in [
            "localhost",
            "nas",
            "192.168.1.2",
            "printer.local",
            "weldsuite.org",
            "x.weldsuite.org",
            "[fe80::1]",
        ] {
            assert!(!is_public_hostname(host), "{host}");
        }
        assert!(is_endpoint("https://minio.example.com"));
        assert!(!is_endpoint("https://127.0.0.1:9000"));
        assert!(!is_endpoint("http://minio.example.com"));
        assert!(!is_endpoint("https://minio.example.com/path"));
        assert!(is_slack_webhook_url(
            "https://hooks.slack.com/services/T1/B1/x"
        ));
        assert!(!is_slack_webhook_url("https://evil.example/hook"));
        assert!(is_hostname("stats.example.com"));
        assert!(!is_hostname("stats"));
        assert!(!is_hostname("-a.example.com"));
    }

    #[test]
    fn bodies_parse_as_zod_parses_them() {
        let parsed = weldsuite_zod::parse_issues(
            &CREATE_EXPORT,
            &json!({
                "projectId": "pnp_a", "name": " Raw ", "secretAccessKey": "k",
                "tables": ["events", "people", "events"],
                "destination": { "provider": "s3", "region": "eu-west-1", "bucket": "acme-raw", "prefix": "/weldpanel/", "accessKeyId": "AKIA" }
            }),
        )
        .expect("valid");
        assert_eq!(parsed.body["tables"], json!(["events", "people"]));
        assert_eq!(parsed.body["name"], json!("Raw"));
        assert_eq!(
            parsed.body["destination"],
            json!({ "provider": "s3", "endpoint": null, "region": "eu-west-1", "bucket": "acme-raw", "prefix": "weldpanel", "accessKeyId": "AKIA", "pathStyle": false })
        );
        let r2 = issues(
            &DESTINATION,
            &json!({ "provider": "r2", "region": "auto", "bucket": "raw", "accessKeyId": "a" }),
        );
        assert_eq!(r2[0]["message"], json!("This provider needs its endpoint"));
        assert_eq!(r2[0]["path"], json!(["endpoint"]));
        let weekly = issues(
            &SCHEDULE,
            &json!({ "frequency": "weekly", "hour": 9, "timezone": "UTC" }),
        );
        assert_eq!(weekly[0]["path"], json!(["weekday"]));
        let mars = issues(
            &SCHEDULE,
            &json!({ "frequency": "daily", "hour": 9, "timezone": "Mars/Olympus" }),
        );
        assert_eq!(mars[0]["message"], json!("Unknown timezone"));
        let both = issues(
            &UPDATE_ALERT,
            &json!({ "reportId": "pnr_1", "spec": { "kind": "trends", "projectId": "p", "series": [{ "event": "a" }] } }),
        );
        assert_eq!(both[0]["message"], json!("Give either a report or a spec"));
        let own = issues(&CREATE_DOMAIN, &json!({ "hostname": " PNL.weldsuite.org" }));
        assert_eq!(own[0]["message"], json!("Use a host name of your own"));
        let host = weldsuite_zod::parse_issues(
            &CREATE_DOMAIN,
            &json!({ "hostname": " Stats.Example.com " }),
        )
        .expect("valid");
        assert_eq!(host.body["hostname"], json!("stats.example.com"));
        let channels =
            weldsuite_zod::parse_issues(&CHANNELS, &json!({ "emailUserIds": ["a", "a", "b"] }))
                .expect("valid");
        assert_eq!(
            Value::Object(channels.body),
            json!({ "emailUserIds": ["a", "b"], "inApp": false })
        );
    }
}
