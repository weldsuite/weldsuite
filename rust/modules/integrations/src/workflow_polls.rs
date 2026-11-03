//! WeldConnect's poll triggers (integration-webhook-worker's
//! `runIntegrationPolls`): every ten minutes, for each workspace with an
//! active `google_sheets.new_row`, `gmail.new_email`,
//! `google_calendar.new_event` or `airtable.new_record` trigger, the
//! watched sheet, inbox, calendar or table is read and every new row,
//! message, event or record dispatched to the matching workflows
//! (`matchAndDispatchIntegrationTriggers`). The cursors live in the
//! connection's `settings`.
//!
//! Global keeps the D1 `tenant_work_index` (kind `workflow_poll`); here the
//! master `workspace_due_index` (kind [`WORKFLOW_POLL_DUE_KIND`]) says which
//! workspaces to open. WeldConnect's workflow writes mark a workspace due;
//! a workspace without poll triggers is dropped from the index after its
//! pass, one whose poll fails is retried after the interval. Global's
//! one-time seed of every workspace has no equivalent: these editions have
//! the write-path marks from their first release.

use serde_json::{Map, Value, json};
use weldsuite_core_domain::js::{Js, js_date, js_string};
use weldsuite_db::due_index::{SweepResult, run_sweep};
use weldsuite_db::{Keyring, PgPool};
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::crm::adapters::{form, json_of, send};
use crate::crm::mapper::truthy;
use crate::crm::{db_message, iso_of_millis, millis_of_iso, now_millis};
use crate::workflow_events::{
    ExecuteWorkflowRuns, IntegrationEvent, connection_credential, match_and_dispatch,
};

/// The `workspace_due_index` kind of the integration polls.
pub const WORKFLOW_POLL_DUE_KIND: &str = "workflow_poll";
/// `TENANT_WORK_INTERVAL_MS`.
pub const POLL_INTERVAL_MS: i64 = 10 * 60_000;
const TOKEN_REFRESH_WINDOW_MS: i64 = 5 * 60_000;

/// `WORKFLOW_POLL_TRIGGER_EVENTS`.
const POLL_EVENTS: [(&str, &str); 4] = [
    ("google_sheets", "google_sheets.new_row"),
    ("gmail", "gmail.new_email"),
    ("google_calendar", "google_calendar.new_event"),
    ("airtable", "airtable.new_record"),
];

/// `encodeURIComponent(text)`.
pub fn encode_uri_component(text: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `t.x ?? t.config?.x`.
fn either<'a>(trigger: &'a Value, key: &str) -> Option<&'a Value> {
    trigger
        .get(key)
        .filter(|v| !v.is_null())
        .or_else(|| trigger.get("config").and_then(|c| c.get(key)))
        .filter(|v| !v.is_null())
}

/// `isPollTrigger(t, provider, event)`.
fn is_poll_trigger(trigger: &Value, provider: &str, event: &str) -> bool {
    trigger.get("type").and_then(Value::as_str) == Some("integration_event")
        && either(trigger, "provider").and_then(Value::as_str) == Some(provider)
        && either(trigger, "event").and_then(Value::as_str) == Some(event)
}

/// `triggersIncludeWorkflowPoll(triggers)`.
pub fn includes_workflow_poll(triggers: &[Value]) -> bool {
    triggers.iter().any(|t| {
        if !t.is_object() || t.get("isEnabled") == Some(&Value::Bool(false)) {
            return false;
        }
        let config = t.get("config").filter(|c| c.is_object());
        let pick = |key: &str| {
            t.get(key)
                .filter(|v| !v.is_null())
                .or_else(|| config.and_then(|c| c.get(key)).filter(|v| !v.is_null()))
        };
        if pick("type").and_then(Value::as_str) != Some("integration_event") {
            return false;
        }
        let provider = pick("provider")
            .map(|v| js_string(&Js::from_jsonb(v)))
            .unwrap_or_default();
        let event = pick("event")
            .map(|v| js_string(&Js::from_jsonb(v)))
            .unwrap_or_default();
        POLL_EVENTS
            .iter()
            .any(|(p, e)| *p == provider && *e == event)
    })
}

/// `triggerIntegrationId(t)`.
fn trigger_integration(trigger: &Value) -> Option<String> {
    either(trigger, "integrationId").map(|v| js_string(&Js::from_jsonb(v)))
}

/// `triggerField(t, field)`: the config's value, else a filter's.
fn trigger_field(trigger: &Value, field: &str) -> Option<String> {
    if let Some(value) = trigger
        .get("config")
        .and_then(|c| c.get(field))
        .filter(|v| !v.is_null())
    {
        return Some(js_string(&Js::from_jsonb(value)));
    }
    let filters = trigger
        .get("filters")
        .filter(|v| !v.is_null())
        .or_else(|| trigger.get("config").and_then(|c| c.get("filters")));
    filters
        .and_then(Value::as_array)
        .and_then(|f| {
            f.iter()
                .find(|x| x.get("field").and_then(Value::as_str) == Some(field))
        })
        .map(|f| {
            f.get("value")
                .map_or_else(|| "undefined".to_owned(), |v| js_string(&Js::from_jsonb(v)))
        })
}

/// `Date.parse(text)`: `None` is `NaN`.
fn parse_date(text: &str) -> Option<i64> {
    js_date(text).and_then(|iso| millis_of_iso(&iso))
}

/// What one workspace's pass needs.
pub struct PollDeps<'a> {
    pub db: &'a PgPool,
    pub http: Option<&'a OutboundHttp>,
    pub runs: Option<&'a dyn ExecuteWorkflowRuns>,
    pub keyring: &'a Keyring,
    pub google_client: Option<(String, String)>,
    /// The workspace runs carry (its Clerk org id).
    pub workspace: &'a str,
}

/// The connected integrations, as the pass changes their settings.
struct Integrations(Vec<Value>);

impl Integrations {
    /// `pick(type, integrationId)`.
    fn pick(&self, kind: &str, id: Option<&str>) -> Option<usize> {
        self.0.iter().position(|row| {
            row.get("type").and_then(Value::as_str) == Some(kind)
                && id
                    .filter(|id| !id.is_empty())
                    .is_none_or(|id| row.get("id").and_then(Value::as_str) == Some(id))
        })
    }
}

fn id_of(row: &Value) -> String {
    row.get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn settings_of(row: &Value) -> Map<String, Value> {
    row.get("settings")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// `saveSettings(integration, settings)`, and the row's own copy.
async fn save_settings(
    deps: &PollDeps<'_>,
    rows: &mut Integrations,
    index: usize,
    settings: Map<String, Value>,
) -> Result<(), String> {
    let id = id_of(&rows.0[index]);
    sqlx::query(
        "update workflow_integrations set settings = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(&id)
    .bind(Value::Object(settings.clone()))
    .bind(crate::crm::engine::now())
    .execute(deps.db)
    .await
    .map_err(|e| db_message(&e))?;
    rows.0[index]["settings"] = Value::Object(settings);
    Ok(())
}

async fn dispatch(
    deps: &PollDeps<'_>,
    integration: &str,
    provider: &'static str,
    event: &'static str,
    data: Map<String, Value>,
) {
    let event = IntegrationEvent {
        provider,
        event,
        data,
    };
    match_and_dispatch(
        deps.db,
        deps.runs,
        deps.workspace,
        Some(integration),
        &event,
    )
    .await;
}

fn bearer(url: String, token: &str) -> HttpRequest {
    HttpRequest::empty("GET", url).header("Authorization", format!("Bearer {token}"))
}

/// `resolveGoogleToken(env, db, integration)`: the access token, refreshed
/// (and stored) when it expires within five minutes.
async fn google_token(deps: &PollDeps<'_>, row: &Value) -> Result<Option<String>, String> {
    let tokens = row.get("oauth_tokens").cloned().unwrap_or(Value::Null);
    let Some(access) = tokens.get("accessToken").filter(|t| truthy(Some(t))) else {
        return Ok(None);
    };
    let decrypt = |v: &Value| {
        weldsuite_connect_domain::crypto::maybe_decrypt_field(
            &js_string(&Js::from_jsonb(v)),
            deps.keyring,
        )
    };
    let mut access = decrypt(access);
    let expires = tokens
        .get("expiresAt")
        .filter(|v| truthy(Some(v)))
        .and_then(|v| parse_date(&js_string(&Js::from_jsonb(v))));
    let soon = expires.is_some_and(|at| at - now_millis() < TOKEN_REFRESH_WINDOW_MS);
    let refresh = tokens.get("refreshToken").filter(|t| truthy(Some(t)));
    if let (true, Some(refresh), Some((client_id, client_secret))) =
        (soon, refresh, deps.google_client.as_ref())
    {
        let refresh_token = decrypt(refresh);
        let request = HttpRequest {
            method: "POST".to_owned(),
            url: "https://oauth2.googleapis.com/token".to_owned(),
            headers: vec![(
                "Content-Type".to_owned(),
                "application/x-www-form-urlencoded".to_owned(),
            )],
            body: Some(form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", &refresh_token),
                ("client_id", client_id),
                ("client_secret", client_secret),
            ])),
        };
        let response = send(deps.http, request).await?;
        let json = json_of(&response)?.to_value();
        if response.ok()
            && let Some(fresh) = json.get("access_token").filter(|t| truthy(Some(t)))
        {
            access = js_string(&Js::from_jsonb(fresh));
            let stored = if deps.keyring.v1.is_some() || deps.keyring.v2.is_some() {
                weldsuite_db::encrypt_field(&access, deps.keyring).map_err(|e| e.to_string())?
            } else {
                access.clone()
            };
            let mut next = Map::new();
            next.insert("accessToken".to_owned(), json!(stored));
            next.insert("refreshToken".to_owned(), refresh.clone());
            if let Some(seconds) = json
                .get("expires_in")
                .filter(|v| truthy(Some(v)))
                .and_then(Value::as_f64)
            {
                #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
                let at = (now_millis() as f64 + seconds * 1000.0) as i64;
                next.insert("expiresAt".to_owned(), json!(iso_of_millis(at)));
            }
            sqlx::query(
                "update workflow_integrations set oauth_tokens = $2, updated_at = $3::timestamp where id = $1",
            )
            .bind(id_of(row))
            .bind(Value::Object(next))
            .bind(crate::crm::engine::now())
            .execute(deps.db)
            .await
            .map_err(|e| db_message(&e))?;
        }
    }
    Ok(Some(access))
}

/// `Number(x)` for the stored cursors.
fn number_of(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) if s.trim().is_empty() => 0.0,
        Some(Value::String(s)) => s.trim().parse().unwrap_or(f64::NAN),
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(_) => f64::NAN,
    }
}

/// JSON of a whole number of milliseconds, as JavaScript writes it.
fn number_json(value: f64) -> Value {
    weldsuite_core_domain::js::number_value(value)
}

async fn poll_sheets(
    deps: &PollDeps<'_>,
    rows: &mut Integrations,
    t: &Value,
) -> Result<usize, String> {
    let Some(spreadsheet) = trigger_field(t, "spreadsheetId").filter(|s| !s.is_empty()) else {
        return Ok(0);
    };
    let sheet = trigger_field(t, "sheetName").unwrap_or_else(|| "Sheet1".to_owned());
    let Some(index) = rows.pick("google_sheets", trigger_integration(t).as_deref()) else {
        return Ok(0);
    };
    let row = rows.0[index].clone();
    let Some(token) = google_token(deps, &row).await? else {
        return Ok(0);
    };
    let url = format!(
        "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet}/values/{}",
        encode_uri_component(&sheet)
    );
    let response = send(deps.http, bearer(url, &token)).await?;
    if !response.ok() {
        return Ok(0);
    }
    let values = json_of(&response)?.to_value();
    let values = values
        .get("values")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut settings = settings_of(&row);
    let mut cursors = settings
        .get("sheetsCursors")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let key = format!("{spreadsheet}!{sheet}");
    let previous = cursors.get(&key).cloned();
    let count = values.len();
    let mut dispatched = 0;
    match previous.as_ref().and_then(Value::as_u64) {
        None if previous.is_none() => {
            cursors.insert(key.clone(), json!(count));
        }
        Some(prev) if u64::try_from(count).unwrap_or(u64::MAX) > prev => {
            for i in usize::try_from(prev).unwrap_or(count)..count {
                let mut data = Map::new();
                data.insert("rowNumber".to_owned(), json!(i + 1));
                data.insert(
                    "values".to_owned(),
                    values
                        .get(i)
                        .filter(|v| !v.is_null())
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                );
                dispatch(
                    deps,
                    &id_of(&row),
                    "google_sheets",
                    "google_sheets.new_row",
                    data,
                )
                .await;
                dispatched += 1;
            }
            cursors.insert(key.clone(), json!(count));
        }
        _ => {}
    }
    if cursors.get(&key) != previous.as_ref() {
        settings.insert("sheetsCursors".to_owned(), Value::Object(cursors));
        save_settings(deps, rows, index, settings).await?;
    }
    Ok(dispatched)
}

async fn poll_gmail(
    deps: &PollDeps<'_>,
    rows: &mut Integrations,
    t: &Value,
) -> Result<usize, String> {
    let Some(index) = rows.pick("gmail", trigger_integration(t).as_deref()) else {
        return Ok(0);
    };
    let row = rows.0[index].clone();
    let Some(token) = google_token(deps, &row).await? else {
        return Ok(0);
    };
    let query = trigger_field(t, "query").unwrap_or_else(|| "newer_than:1d".to_owned());
    let mut settings = settings_of(&row);
    let last = number_of(settings.get("gmailLastTs"));
    let mut max = last;
    let mut dispatched = 0;
    let listing = send(
        deps.http,
        bearer(
            format!(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&labelIds=INBOX&q={}",
                encode_uri_component(&query)
            ),
            &token,
        ),
    )
    .await?;
    if !listing.ok() {
        return Ok(0);
    }
    let page = json_of(&listing)?.to_value();
    for message in page
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let id = message
            .get("id")
            .map_or_else(|| "undefined".to_owned(), |v| js_string(&Js::from_jsonb(v)));
        let response = send(
            deps.http,
            bearer(
                format!(
                    "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject"
                ),
                &token,
            ),
        )
        .await?;
        if !response.ok() {
            continue;
        }
        let msg = json_of(&response)?.to_value();
        let ts = number_of(msg.get("internalDate"));
        if ts > max {
            max = ts;
        }
        if last != 0.0 && ts > last {
            let header = |name: &str| {
                msg.get("payload")
                    .and_then(|p| p.get("headers"))
                    .and_then(Value::as_array)
                    .and_then(|h| {
                        h.iter()
                            .find(|x| x.get("name").and_then(Value::as_str) == Some(name))
                    })
                    .and_then(|h| h.get("value"))
                    .cloned()
            };
            let mut data = Map::new();
            for (key, value) in [
                ("id", msg.get("id").cloned()),
                ("threadId", msg.get("threadId").cloned()),
                ("from", header("From")),
                ("subject", header("Subject")),
                ("snippet", msg.get("snippet").cloned()),
            ] {
                if let Some(value) = value {
                    data.insert(key.to_owned(), value);
                }
            }
            dispatch(deps, &id_of(&row), "gmail", "gmail.new_email", data).await;
            dispatched += 1;
        }
    }
    // `maxTs !== lastTs` (NaN differs from itself).
    #[allow(clippy::float_cmp)] // whole milliseconds, compared as JavaScript does
    let changed = max != last;
    if changed {
        settings.insert("gmailLastTs".to_owned(), number_json(max));
        save_settings(deps, rows, index, settings).await?;
    }
    Ok(dispatched)
}

async fn poll_calendar(
    deps: &PollDeps<'_>,
    rows: &mut Integrations,
    t: &Value,
) -> Result<usize, String> {
    let Some(index) = rows.pick("google_calendar", trigger_integration(t).as_deref()) else {
        return Ok(0);
    };
    let row = rows.0[index].clone();
    let Some(token) = google_token(deps, &row).await? else {
        return Ok(0);
    };
    let calendar = trigger_field(t, "calendarId").unwrap_or_else(|| "primary".to_owned());
    let mut settings = settings_of(&row);
    let last = settings
        .get("calendarLastCreated")
        .filter(|v| truthy(Some(v)))
        .map_or(Some(0), |v| parse_date(&js_string(&Js::from_jsonb(v))));
    let mut max = last;
    let mut dispatched = 0;
    let url = format!(
        "https://www.googleapis.com/calendar/v3/calendars/{}/events?timeMin={}&singleEvents=true&orderBy=startTime&maxResults=10",
        encode_uri_component(&calendar),
        encode_uri_component(&iso_of_millis(now_millis()))
    );
    let response = send(deps.http, bearer(url, &token)).await?;
    if !response.ok() {
        return Ok(0);
    }
    let data = json_of(&response)?.to_value();
    for ev in data
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let created = ev
            .get("created")
            .filter(|v| truthy(Some(v)))
            .map_or(Some(0), |v| parse_date(&js_string(&Js::from_jsonb(v))));
        if let (Some(c), Some(m)) = (created, max)
            && c > m
        {
            max = Some(c);
        }
        if let (Some(c), Some(l)) = (created, last)
            && l != 0
            && c > l
        {
            let mut out = Map::new();
            for key in ["id", "summary", "start", "end", "htmlLink"] {
                if let Some(value) = ev.get(key) {
                    out.insert(key.to_owned(), value.clone());
                }
            }
            dispatch(
                deps,
                &id_of(&row),
                "google_calendar",
                "google_calendar.new_event",
                out,
            )
            .await;
            dispatched += 1;
        }
    }
    if max != last
        && let Some(max) = max
    {
        settings.insert("calendarLastCreated".to_owned(), json!(iso_of_millis(max)));
        save_settings(deps, rows, index, settings).await?;
    }
    Ok(dispatched)
}

async fn poll_airtable(
    deps: &PollDeps<'_>,
    rows: &mut Integrations,
    t: &Value,
) -> Result<usize, String> {
    let (Some(base), Some(table)) = (
        trigger_field(t, "baseId").filter(|s| !s.is_empty()),
        trigger_field(t, "tableId").filter(|s| !s.is_empty()),
    ) else {
        return Ok(0);
    };
    let Some(index) = rows.pick("airtable", trigger_integration(t).as_deref()) else {
        return Ok(0);
    };
    let row = rows.0[index].clone();
    let Some(token) = connection_credential(&row, "token", deps.keyring) else {
        return Ok(0);
    };
    let mut settings = settings_of(&row);
    let mut cursors = settings
        .get("airtableCursors")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let key = format!("{base}:{table}");
    let previous = cursors
        .get(&key)
        .filter(|v| truthy(Some(v)))
        .map_or(Some(0), |v| parse_date(&js_string(&Js::from_jsonb(v))));
    let mut max = previous;
    let mut dispatched = 0;
    let response = send(
        deps.http,
        bearer(
            format!(
                "https://api.airtable.com/v0/{base}/{}?pageSize=50",
                encode_uri_component(&table)
            ),
            &token,
        ),
    )
    .await?;
    if !response.ok() {
        return Ok(0);
    }
    let data = json_of(&response)?.to_value();
    let mut records = data
        .get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let created_of = |r: &Value| {
        r.get("createdTime")
            .map(|v| js_string(&Js::from_jsonb(v)))
            .and_then(|t| parse_date(&t))
    };
    records.sort_by_key(|r| created_of(r).unwrap_or(i64::MIN));
    for record in records {
        let created = created_of(&record);
        if let (Some(c), Some(m)) = (created, max)
            && c > m
        {
            max = Some(c);
        }
        if let (Some(c), Some(p)) = (created, previous)
            && p != 0
            && c > p
        {
            let mut out = Map::new();
            for key in ["id", "fields", "createdTime"] {
                if let Some(value) = record.get(key) {
                    out.insert(key.to_owned(), value.clone());
                }
            }
            dispatch(deps, &id_of(&row), "airtable", "airtable.new_record", out).await;
            dispatched += 1;
        }
    }
    if max != previous
        && let Some(max) = max
    {
        cursors.insert(key, json!(iso_of_millis(max)));
        settings.insert("airtableCursors".to_owned(), Value::Object(cursors));
        save_settings(deps, rows, index, settings).await?;
    }
    Ok(dispatched)
}

/// `pollWorkspaceIntegrations`: the events dispatched, and whether the
/// workspace still has poll triggers.
pub async fn poll_workspace(deps: &PollDeps<'_>) -> Result<(usize, bool), String> {
    let workflows: Vec<Option<Value>> = sqlx::query_scalar(
        "select triggers from workflows where status = 'active' and deleted_at is null",
    )
    .fetch_all(deps.db)
    .await
    .map_err(|e| db_message(&e))?;
    let triggers: Vec<Value> = workflows
        .into_iter()
        .flatten()
        .filter_map(|t| t.as_array().cloned())
        .flatten()
        .collect();
    if triggers.is_empty() {
        return Ok((0, false));
    }
    let buckets: Vec<Vec<&Value>> = POLL_EVENTS
        .iter()
        .map(|(provider, event)| {
            triggers
                .iter()
                .filter(|t| is_poll_trigger(t, provider, event))
                .collect()
        })
        .collect();
    if !includes_workflow_poll(&triggers) && buckets.iter().all(Vec::is_empty) {
        return Ok((0, false));
    }
    let connected: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from workflow_integrations t where t.status = 'connected' and t.deleted_at is null",
    )
    .fetch_all(deps.db)
    .await
    .map_err(|e| db_message(&e))?;
    let mut rows = Integrations(connected);
    let mut dispatched = 0;
    for t in &buckets[0] {
        dispatched += poll_sheets(deps, &mut rows, t).await?;
    }
    for t in &buckets[1] {
        dispatched += poll_gmail(deps, &mut rows, t).await?;
    }
    for t in &buckets[2] {
        dispatched += poll_calendar(deps, &mut rows, t).await?;
    }
    for t in &buckets[3] {
        dispatched += poll_airtable(deps, &mut rows, t).await?;
    }
    Ok((dispatched, true))
}

/// A workspace's tenant database and the id its runs carry (the Clerk org).
pub type PollOpener = crate::crm::due::WorkspaceOpener;

/// What a cron tick of the polls needs besides the master database.
pub struct PollSweep<'a> {
    pub open: &'a PollOpener,
    pub http: Option<&'a OutboundHttp>,
    pub runs: Option<&'a dyn ExecuteWorkflowRuns>,
    pub keyring: &'a Keyring,
    pub google_client: Option<(String, String)>,
}

/// `runIntegrationPolls`: the due workspaces (50 a tick), each polled and
/// kept for the next interval while it has poll triggers.
pub async fn run_workflow_polls(
    master: &PgPool,
    sweep: &PollSweep<'_>,
    now: time::OffsetDateTime,
) -> (SweepResult, usize) {
    let dispatched = std::sync::Mutex::new(0usize);
    let interval = time::Duration::milliseconds(POLL_INTERVAL_MS);
    let result = run_sweep(
        master,
        WORKFLOW_POLL_DUE_KIND,
        now,
        50,
        Some(interval),
        |workspace_id: String, now| {
            let open = std::sync::Arc::clone(sweep.open);
            let dispatched = &dispatched;
            async move {
                let (db, org) = open(workspace_id).await?;
                let deps = PollDeps {
                    db: &db,
                    http: sweep.http,
                    runs: sweep.runs,
                    keyring: sweep.keyring,
                    google_client: sweep.google_client.clone(),
                    workspace: &org,
                };
                let (count, has_polls) = poll_workspace(&deps).await?;
                *dispatched
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) += count;
                Ok::<_, String>(has_polls.then_some(now + interval))
            }
        },
    )
    .await;
    let dispatched = dispatched
        .into_inner()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    tracing::info!(
        "[Poll] Done. Workspaces: {}, Dispatched: {dispatched}",
        result.due
    );
    (result, dispatched)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_components_encode_as_javascript_does() {
        assert_eq!(encode_uri_component("Sheet 1/ä!*"), "Sheet%201%2F%C3%A4!*");
    }

    #[test]
    fn poll_triggers_are_found_in_the_config_too() {
        let triggers = vec![
            json!({ "type": "integration_event", "config": { "provider": "gmail", "event": "gmail.new_email" } }),
        ];
        assert!(includes_workflow_poll(&triggers));
        assert!(!includes_workflow_poll(&[json!({
            "type": "integration_event", "isEnabled": false, "provider": "gmail", "event": "gmail.new_email"
        })]));
        assert_eq!(
            trigger_field(
                &json!({ "filters": [{ "field": "baseId", "value": 7 }] }),
                "baseId"
            )
            .as_deref(),
            Some("7")
        );
    }
}
