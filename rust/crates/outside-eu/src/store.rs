//! A workspace's opt-ins, in its tenant database: the `outsideEu` object of
//! `workspace_settings.features` (`packages/core/db/src/schema/workspace-settings.ts`),
//! keyed by [`ServiceId`]:
//!
//! ```json
//! { "outsideEu": { "telnyx": { "enabled": true, "enabledBy": "user_…",
//!   "enabledAt": "2026-11-20T10:00:00.000Z", "acknowledgedAt": "…", "via": "admin" } } }
//! ```
//!
//! No table of its own, so no migration: `features` is a jsonb column every
//! workspace database has, and `PUT /api/settings` never writes it. A
//! service with no entry, or `enabled: false`, is off. Each write runs in a
//! transaction that locks the row, and keeps every other key of `features`.
//!
//! Who may write: a workspace admin through `/api/outside-eu-services`
//! ([`Via::Admin`], with the acknowledgement), staff through
//! `weldsuite admin outside-eu` ([`Via::Staff`]), and the move from Global,
//! which records the non-EU integrations a workspace already connected
//! there ([`Via::Move`], ADR OPS-025 decision 6) by calling [`set`].

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;

use crate::catalog::ServiceId;

/// The key under `workspace_settings.features`.
pub const FEATURES_KEY: &str = "outsideEu";

/// Who switched a service on or off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    /// A workspace admin, in the settings page.
    Admin,
    /// WeldSuite staff, with `weldsuite admin outside-eu`.
    Staff,
    /// The move from Global: an integration the workspace had connected there.
    Move,
}

impl Via {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Staff => "staff",
            Self::Move => "move",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "admin" => Some(Self::Admin),
            "staff" => Some(Self::Staff),
            "move" => Some(Self::Move),
            _ => None,
        }
    }
}

/// One service's state for the workspace.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptIn {
    pub enabled: bool,
    /// The user id (an admin) or email (staff) that switched it on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled_at: Option<String>,
    /// When the admin confirmed that the data leaves the EU; `None` for a
    /// switch staff or the move made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acknowledged_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<Via>,
    /// Staff's and the move's reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled_at: Option<String>,
}

/// Every service the workspace has an entry for.
pub type OptIns = BTreeMap<ServiceId, OptIn>;

/// One switch.
#[derive(Debug, Clone, Copy)]
pub struct Change<'a> {
    pub service: ServiceId,
    pub enabled: bool,
    /// A user id, or a staff member's email.
    pub actor: &'a str,
    pub via: Via,
    /// The admin ticked "I understand the data leaves the EU".
    pub acknowledged: bool,
    pub reason: Option<&'a str>,
    /// ISO 8601, as `weldsuite_events::iso_timestamp` writes it.
    pub at: &'a str,
}

/// The `outsideEu` object of a `features` value, keeping only services this
/// build knows and entries it can read.
pub fn parse(features: &Value) -> OptIns {
    features
        .get(FEATURES_KEY)
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(key, entry)| {
            let service = ServiceId::parse(key)?;
            let opt_in = serde_json::from_value::<OptIn>(entry.clone()).ok()?;
            Some((service, opt_in))
        })
        .collect()
}

/// The entry after `change`, from the one before. Switching on what is on,
/// or off what is off, keeps the entry as it is.
pub fn apply(before: Option<&OptIn>, change: &Change<'_>) -> OptIn {
    let was_on = before.is_some_and(|b| b.enabled);
    match (change.enabled, was_on) {
        (true, true) | (false, false) => before.cloned().unwrap_or_default(),
        (true, false) => OptIn {
            enabled: true,
            enabled_by: Some(change.actor.to_owned()),
            enabled_at: Some(change.at.to_owned()),
            acknowledged_at: change.acknowledged.then(|| change.at.to_owned()),
            via: Some(change.via),
            reason: change
                .reason
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .map(str::to_owned),
            disabled_by: None,
            disabled_at: None,
        },
        (false, true) => OptIn {
            enabled: false,
            disabled_by: Some(change.actor.to_owned()),
            disabled_at: Some(change.at.to_owned()),
            via: Some(change.via),
            reason: change
                .reason
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .map(str::to_owned),
            ..OptIn::default()
        },
    }
}

/// `features` with `service`'s entry replaced, every other key kept.
pub fn merge(features: Option<&Value>, service: ServiceId, entry: &OptIn) -> Value {
    let mut features: Map<String, Value> = features
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut services: Map<String, Value> = features
        .get(FEATURES_KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    services.insert(
        service.as_str().to_owned(),
        serde_json::to_value(entry).unwrap_or(Value::Null),
    );
    features.insert(FEATURES_KEY.to_owned(), Value::Object(services));
    Value::Object(features)
}

/// The workspace's opt-ins.
pub async fn read(db: &PgPool) -> Result<OptIns, sqlx::Error> {
    let features: Option<Option<Value>> = sqlx::query_scalar(
        "select features from workspace_settings
         where deleted_at is null
         order by created_at asc
         limit 1",
    )
    .fetch_optional(db)
    .await?;
    Ok(features.flatten().map(|f| parse(&f)).unwrap_or_default())
}

/// Whether `service` is switched on, without reading the rest.
pub async fn is_on(db: &PgPool, service: ServiceId) -> Result<bool, sqlx::Error> {
    let on: Option<bool> = sqlx::query_scalar(
        "select coalesce((features -> 'outsideEu' -> $1 ->> 'enabled') = 'true', false)
         from workspace_settings
         where deleted_at is null
         order by created_at asc
         limit 1",
    )
    .bind(service.as_str())
    .fetch_optional(db)
    .await?;
    Ok(on.unwrap_or(false))
}

/// Switches one service on or off: `(before, after)`. A workspace without a
/// `workspace_settings` row gets one.
pub async fn set(db: &PgPool, change: &Change<'_>) -> Result<(OptIn, OptIn), sqlx::Error> {
    let mut tx = db.begin().await?;
    let row: Option<(String, Option<Value>)> = sqlx::query_as(
        "select id, features from workspace_settings
         where deleted_at is null
         order by created_at asc
         limit 1
         for update",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let current = row
        .as_ref()
        .and_then(|(_, features)| features.as_ref())
        .map(parse)
        .unwrap_or_default();
    let before = current.get(&change.service).cloned().unwrap_or_default();
    let after = apply(current.get(&change.service), change);
    if after != before {
        let features = merge(
            row.as_ref().and_then(|(_, f)| f.as_ref()),
            change.service,
            &after,
        );
        match &row {
            Some((id, _)) => {
                sqlx::query(
                    "update workspace_settings
                     set features = $2::jsonb, updated_at = $3::timestamptz
                     where id = $1",
                )
                .bind(id)
                .bind(&features)
                .bind(change.at)
                .execute(&mut *tx)
                .await?;
            }
            None => {
                sqlx::query(
                    "insert into workspace_settings (id, features, created_at, updated_at)
                     values ($1, $2::jsonb, $3::timestamptz, $3::timestamptz)",
                )
                .bind(generate_id("ws"))
                .bind(&features)
                .bind(change.at)
                .execute(&mut *tx)
                .await?;
            }
        }
    }
    tx.commit().await?;
    Ok((before, after))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const AT: &str = "2026-11-20T10:00:00.000Z";

    fn change(enabled: bool) -> Change<'static> {
        Change {
            service: ServiceId::Telnyx,
            enabled,
            actor: "user_admin",
            via: Via::Admin,
            acknowledged: true,
            reason: None,
            at: AT,
        }
    }

    #[test]
    fn switching_on_records_who_when_and_the_acknowledgement() {
        let on = apply(None, &change(true));
        assert!(on.enabled);
        assert_eq!(on.enabled_by.as_deref(), Some("user_admin"));
        assert_eq!(on.enabled_at.as_deref(), Some(AT));
        assert_eq!(on.acknowledged_at.as_deref(), Some(AT));
        assert_eq!(on.via, Some(Via::Admin));

        // On again keeps the first switch.
        let later = Change {
            actor: "user_other",
            at: "2026-11-21T00:00:00.000Z",
            ..change(true)
        };
        assert_eq!(apply(Some(&on), &later), on);

        let off = apply(Some(&on), &change(false));
        assert!(!off.enabled);
        assert_eq!(off.disabled_by.as_deref(), Some("user_admin"));
        assert_eq!(off.enabled_by, None);
        assert_eq!(apply(Some(&off), &change(false)), off);
    }

    #[test]
    fn staff_and_the_move_carry_a_reason_and_no_acknowledgement() {
        let moved = apply(
            None,
            &Change {
                via: Via::Move,
                acknowledged: false,
                actor: "staff@weldsuite.org",
                reason: Some("  connected on Global  "),
                ..change(true)
            },
        );
        assert_eq!(moved.acknowledged_at, None);
        assert_eq!(moved.via, Some(Via::Move));
        assert_eq!(moved.reason.as_deref(), Some("connected on Global"));
    }

    #[test]
    fn merging_keeps_every_other_key() {
        let features = json!({
            "multiCurrency": true,
            "outsideEu": { "slack": { "enabled": true }, "retired-service": { "enabled": true } },
        });
        let entry = apply(None, &change(true));
        let merged = merge(Some(&features), ServiceId::Telnyx, &entry);
        assert_eq!(merged["multiCurrency"], json!(true));
        assert_eq!(merged["outsideEu"]["slack"]["enabled"], json!(true));
        assert_eq!(
            merged["outsideEu"]["retired-service"]["enabled"],
            json!(true)
        );
        assert_eq!(
            merged["outsideEu"]["telnyx"]["enabledBy"],
            json!("user_admin")
        );
        // A null or non-object `features` starts empty.
        let fresh = merge(Some(&Value::Null), ServiceId::Slack, &entry);
        assert_eq!(fresh["outsideEu"]["slack"]["enabled"], json!(true));

        let parsed = parse(&merged);
        assert_eq!(parsed.len(), 2, "the unknown service is skipped");
        assert!(parsed[&ServiceId::Telnyx].enabled);
        assert!(parse(&json!({ "outsideEu": "nope" })).is_empty());
        assert!(parse(&json!({ "outsideEu": { "telnyx": "on" } })).is_empty());
    }
}
