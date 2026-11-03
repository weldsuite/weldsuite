//! The CRM sync (integration-webhook-worker's `lib/engine` and
//! `workflows/crm-sync.ts`): the `CRM_SYNC` Workflow as the
//! `integrations.crm-sync` job (Attio, `HubSpot`, Google Calendar into the
//! tenant's companies, people, opportunities and calendar events), the
//! providers' webhooks that keep it current between runs ([`webhooks`]), and
//! the due sweep that starts it on a schedule ([`due`]).
//!
//! WeldConnect's CRM routes start the job (`RequestCrmSyncRuns`); on Global
//! that is the `CRM_SYNC` binding to this worker.

pub mod adapters;
pub mod due;
pub mod engine;
pub mod job;
pub mod mapper;
pub mod tables;
pub mod webhooks;

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use weldsuite_core_domain::js::{Js, js_date, js_string, stringify};
use weldsuite_db::PgPool;
use weldsuite_ports::{DynRealtimePublisher, OutboundHttp};

use crate::books::TenantResolver;

/// The job `CRM_SYNC` starts.
pub const CRM_SYNC_JOB: &str = "integrations.crm-sync";

/// What the CRM sync needs: the workspaces' tenant databases (by Clerk org
/// id or `workspaces.id`), the providers over HTTP, the OAuth clients
/// (`<PROVIDER>_CLIENT_ID` / `_SECRET`) and realtime (`REALTIME`).
#[derive(Clone)]
pub struct CrmDeps {
    pub tenants: TenantResolver,
    pub http: Option<OutboundHttp>,
    pub env: Arc<HashMap<String, String>>,
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
}

impl CrmDeps {
    /// `getTenantDbForWorkspace(env, workspaceId)`.
    pub(crate) async fn db(&self, workspace_id: &str) -> Result<PgPool, String> {
        (self.tenants)(workspace_id.to_owned())
            .await
            .map(|tenant| tenant.db)
    }

    /// A non-empty setting.
    pub(crate) fn env(&self, name: &str) -> Option<String> {
        self.env.get(name).filter(|v| !v.is_empty()).cloned()
    }
}

/// Values a sync writes into a row, by Drizzle property: what the field
/// mappings (or Google's transform) produced. `dates` are the properties
/// holding a JavaScript `Date` (as its ISO string): Drizzle writes those, and
/// throws for anything else in a `date`-mode column. `invalid_date` is a
/// `new Date(...)` of something unparsable, which throws when written.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Record {
    pub values: Map<String, Value>,
    pub dates: Vec<String>,
    pub invalid_date: bool,
}

impl Record {
    /// Plain values, no `Date`s.
    pub fn plain(values: Map<String, Value>) -> Self {
        Self {
            values,
            ..Self::default()
        }
    }

    /// `record[prop] = new Date(value)`.
    pub(crate) fn set_date(&mut self, prop: &str, value: Option<&Value>) {
        let text = value.map_or_else(|| "undefined".to_owned(), |v| js_string(&Js::from_jsonb(v)));
        if let Some(iso) = js_date(&text) {
            self.values.insert(prop.to_owned(), Value::String(iso));
            if !self.dates.iter().any(|d| d == prop) {
                self.dates.push(prop.to_owned());
            }
        } else {
            self.values.insert(prop.to_owned(), Value::Null);
            self.invalid_date = true;
        }
    }

    /// `{ ...record, ...defaults }`: a default of `undefined` (`None`) leaves
    /// the key out, as Drizzle skips it.
    #[must_use]
    pub fn with_defaults(mut self, defaults: &[(&str, Option<Value>)]) -> Self {
        for (key, value) in defaults {
            self.dates.retain(|d| d != key);
            match value {
                Some(value) => {
                    self.values.insert((*key).to_owned(), value.clone());
                }
                None => {
                    self.values.remove(*key);
                }
            }
        }
        self
    }
}

/// `computeChecksum(data)`: SHA-256 of `JSON.stringify(data)`, as hex.
pub fn checksum(raw: &Js) -> String {
    hex::encode(Sha256::digest(stringify(raw).as_bytes()))
}

/// `Date.now()`.
pub(crate) fn now_millis() -> i64 {
    i64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .unwrap_or_default()
}

/// `new Date(millis).toISOString()`.
pub(crate) fn iso_of_millis(millis: i64) -> String {
    crate::github::iso_of_millis(millis)
}

/// `new Date().toISOString()`.
pub(crate) fn now_iso() -> String {
    iso_of_millis(now_millis())
}

/// `new Date(iso).getTime()` of an ISO string.
pub(crate) fn millis_of_iso(iso: &str) -> Option<i64> {
    crate::github::millis_of_iso(iso)
}

/// A database error's message, as the driver's `err.message` reads.
pub(crate) fn db_message(error: &sqlx::Error) -> String {
    match error {
        sqlx::Error::Database(error) => error.message().to_owned(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn checksum_hashes_the_json_in_its_own_key_order() {
        let raw: Js = serde_json::from_str(r#"{"b":1,"a":[1.5,"x"]}"#).expect("json");
        assert_eq!(
            checksum(&raw),
            hex::encode(Sha256::digest(br#"{"b":1,"a":[1.5,"x"]}"#))
        );
    }

    #[test]
    fn defaults_override_and_undefined_drops() {
        let mut record = Record::plain(
            json!({ "title": "x", "calendarId": "c" })
                .as_object()
                .cloned()
                .expect("object"),
        );
        record.set_date("startTime", Some(&json!("2026-10-05T10:00:00+02:00")));
        let record = record.with_defaults(&[("calendarId", None), ("type", Some(json!("event")))]);
        assert_eq!(
            Value::Object(record.values),
            json!({ "title": "x", "startTime": "2026-10-05T08:00:00.000Z", "type": "event" })
        );
        assert_eq!(record.dates, vec!["startTime"]);
    }
}
