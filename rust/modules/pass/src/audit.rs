//! WeldPass's own trails, kept off the entity-event bus: `weldpass_audit_events`
//! for the secret vaults (`audit.ts`) and `weldpass_vault_events` for the
//! password manager (`vault-events.ts`). Only key names, titles and member
//! ids are stored, never a value.
//!
//! A write's row is best effort ([`record_audit`], [`record_vault_event`]):
//! the change has committed already, so a failed row is logged loudly and
//! swallowed. A read that discloses a value (a reveal, an export, a 2FA code,
//! a device's copy) writes its row first and answers only when the row is in
//! ([`require_audit`], [`require_vault_event`]): otherwise a caller who can
//! make the insert fail reads without a trace.

use http::HeaderMap;
use sea_orm::{
    ColumnTrait, EntityTrait, FromQueryResult, JoinType, QueryFilter, QueryOrder, QuerySelect,
    RelationDef, Set,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{weldpass_audit_events, weldpass_vault_events, workspace_members};

use crate::{PassError, PassResult, js, row_json};

/// `WeldPassAuditContext`: who asked, read once per request.
#[derive(Debug, Clone, Default)]
pub(crate) struct AuditContext {
    pub(crate) ip: Option<String>,
    pub(crate) user_agent: Option<String>,
}

impl AuditContext {
    /// The caller's address ([`client_ip`]) and the first 500 characters of
    /// `User-Agent`.
    pub(crate) fn from_headers(headers: &HeaderMap, trusted_proxies: usize) -> Self {
        Self {
            ip: client_ip(headers, trusted_proxies),
            user_agent: headers
                .get(http::header::USER_AGENT)
                .and_then(|value| value.to_str().ok())
                .map(|agent| js::utf16_slice(agent, 0, 500)),
        }
    }
}

/// The caller's address: the `X-Forwarded-For` entry `trusted_proxies` from
/// the right (each proxy in front appends the address it saw), when it looks
/// like an address. Whatever the client wrote further left is ignored, and so
/// is `CF-Connecting-IP`: on Kubernetes nothing in front sets it, so a client
/// could, and a value longer than the `ip` column (45) failed the trail's
/// insert. What this returns always fits.
pub(crate) fn client_ip(headers: &HeaderMap, trusted_proxies: usize) -> Option<String> {
    let hops: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|hop| !hop.is_empty())
        .collect();
    hops.len()
        .checked_sub(trusted_proxies.max(1))
        .and_then(|at| hops.get(at))
        .filter(|ip| {
            (2..=45).contains(&ip.len())
                && ip
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() || matches!(b, b'.' | b':'))
        })
        .map(|ip| (*ip).to_owned())
}

/// One `weldpass_audit_events` row (`WeldPassAuditEntry`).
pub(crate) struct AuditEntry<'a> {
    pub(crate) project_id: &'a str,
    pub(crate) environment_id: Option<&'a str>,
    pub(crate) secret_id: Option<&'a str>,
    pub(crate) actor_id: &'a str,
    pub(crate) action: &'static str,
    pub(crate) target_key: Option<&'a str>,
    pub(crate) metadata: Value,
}

impl<'a> AuditEntry<'a> {
    pub(crate) fn new(project_id: &'a str, actor_id: &'a str, action: &'static str) -> Self {
        Self {
            project_id,
            environment_id: None,
            secret_id: None,
            actor_id,
            action,
            target_key: None,
            metadata: Value::Object(Map::new()),
        }
    }

    pub(crate) fn environment(mut self, id: &'a str) -> Self {
        self.environment_id = Some(id);
        self
    }

    pub(crate) fn secret(mut self, id: &'a str) -> Self {
        self.secret_id = Some(id);
        self
    }

    pub(crate) fn target(mut self, key: &'a str) -> Self {
        self.target_key = Some(key);
        self
    }

    pub(crate) fn metadata(mut self, metadata: Value) -> Self {
        self.metadata = metadata;
        self
    }
}

/// `recordAudit`, after a write: best effort, a failure is logged.
pub(crate) async fn record_audit(db: &PgPool, context: &AuditContext, entry: AuditEntry<'_>) {
    let (action, project_id) = (entry.action, entry.project_id.to_owned());
    if let Err(error) = insert_audit(db, context, entry).await {
        tracing::error!(
            action,
            project_id,
            %error,
            "[weldpass] audit write failed"
        );
    }
}

/// The row for a read that discloses values, before the answer: its error
/// fails the request, so no value leaves without its row.
pub(crate) async fn require_audit(
    db: &PgPool,
    context: &AuditContext,
    entry: AuditEntry<'_>,
) -> PassResult<()> {
    let (action, project_id) = (entry.action, entry.project_id.to_owned());
    insert_audit(db, context, entry).await.map_err(|error| {
        tracing::error!(
            action,
            project_id,
            %error,
            "[weldpass] audit write failed; the read is refused"
        );
        PassError::Internal(format!("the audit row for {action} was not written"))
    })
}

async fn insert_audit(
    db: &PgPool,
    context: &AuditContext,
    entry: AuditEntry<'_>,
) -> Result<(), sea_orm::DbErr> {
    weldpass_audit_events::Entity::insert(weldpass_audit_events::ActiveModel {
        id: Set(generate_id("wpa")),
        project_id: Set(entry.project_id.to_owned()),
        environment_id: Set(entry.environment_id.map(str::to_owned)),
        secret_id: Set(entry.secret_id.map(str::to_owned)),
        actor_id: Set(entry.actor_id.to_owned()),
        action: Set(entry.action.to_owned()),
        target_key: Set(entry.target_key.map(str::to_owned)),
        metadata: Set(entry.metadata),
        ip: Set(context.ip.clone()),
        user_agent: Set(context.user_agent.clone()),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await
    .map(|_| ())
}

/// One `weldpass_vault_events` row (`VaultEventEntry`).
pub(crate) struct VaultEvent<'a> {
    pub(crate) vault_id: &'a str,
    pub(crate) item_id: Option<&'a str>,
    pub(crate) actor_id: &'a str,
    pub(crate) action: &'static str,
    pub(crate) target_label: Option<&'a str>,
    pub(crate) metadata: Value,
}

impl<'a> VaultEvent<'a> {
    pub(crate) fn new(vault_id: &'a str, actor_id: &'a str, action: &'static str) -> Self {
        Self {
            vault_id,
            item_id: None,
            actor_id,
            action,
            target_label: None,
            metadata: json!({}),
        }
    }

    pub(crate) fn item(mut self, id: &'a str) -> Self {
        self.item_id = Some(id);
        self
    }

    pub(crate) fn label(mut self, label: &'a str) -> Self {
        self.target_label = Some(label);
        self
    }

    pub(crate) fn metadata(mut self, metadata: Value) -> Self {
        self.metadata = metadata;
        self
    }
}

/// `recordVaultEvent`, after a write: best effort, a failure is logged.
pub(crate) async fn record_vault_event(db: &PgPool, context: &AuditContext, entry: VaultEvent<'_>) {
    let (action, vault_id) = (entry.action, entry.vault_id.to_owned());
    if let Err(error) = insert_vault_event(db, context, entry).await {
        tracing::error!(
            action,
            vault_id,
            %error,
            "[weldpass] vault event write failed"
        );
    }
}

/// The row for a read that discloses an item (a reveal, a 2FA code, a
/// device's copy), before the answer: its error fails the request.
pub(crate) async fn require_vault_event(
    db: &PgPool,
    context: &AuditContext,
    entry: VaultEvent<'_>,
) -> PassResult<()> {
    let (action, vault_id) = (entry.action, entry.vault_id.to_owned());
    insert_vault_event(db, context, entry)
        .await
        .map_err(|error| {
            tracing::error!(
                action,
                vault_id,
                %error,
                "[weldpass] vault event write failed; the read is refused"
            );
            PassError::Internal(format!("the vault event for {action} was not written"))
        })
}

/// The label cut to 255 characters.
async fn insert_vault_event(
    db: &PgPool,
    context: &AuditContext,
    entry: VaultEvent<'_>,
) -> Result<(), sea_orm::DbErr> {
    let label = entry
        .target_label
        .map(|label| js::utf16_slice(label, 0, 255));
    weldpass_vault_events::Entity::insert(weldpass_vault_events::ActiveModel {
        id: Set(generate_id("wpx")),
        vault_id: Set(entry.vault_id.to_owned()),
        item_id: Set(entry.item_id.map(str::to_owned)),
        actor_id: Set(entry.actor_id.to_owned()),
        action: Set(entry.action.to_owned()),
        target_label: Set(label),
        metadata: Set(entry.metadata),
        ip: Set(context.ip.clone()),
        user_agent: Set(context.user_agent.clone()),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await
    .map(|_| ())
}

/// One trail row as the routes list it (`jsonb_build_object` in the worker's
/// select): the actor's display name, when they are a member.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultEventRow {
    id: String,
    item_id: Option<String>,
    actor_id: String,
    actor_name: Option<String>,
    action: String,
    target_label: Option<String>,
    metadata: Value,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    created_at: OffsetDateTime,
}

/// `leftJoin(workspaceMembers, eq(workspaceMembers.userId, events.actorId))`.
fn actor() -> RelationDef {
    weldpass_vault_events::Entity::belongs_to(workspace_members::Entity)
        .from(weldpass_vault_events::Column::ActorId)
        .to(workspace_members::Column::UserId)
        .into()
}

/// A vault's trail, newest first, before `before` when given: `limit` rows
/// (the route asks one more than its page).
pub(crate) async fn list_vault_events(
    db: &PgPool,
    vault_id: &str,
    before: Option<OffsetDateTime>,
    limit: i64,
) -> PassResult<Vec<Value>> {
    use weldpass_vault_events::Column as Event;
    let mut select = weldpass_vault_events::Entity::find()
        .select_only()
        .columns([Event::Id, Event::ItemId, Event::ActorId])
        .column_as(workspace_members::Column::Name, "actor_name")
        .columns([
            Event::Action,
            Event::TargetLabel,
            Event::Metadata,
            Event::CreatedAt,
        ])
        .join(JoinType::LeftJoin, actor())
        .filter(Event::VaultId.eq(vault_id));
    if let Some(before) = before {
        select = select.filter(Event::CreatedAt.lt(before));
    }
    let rows = select
        .order_by_desc(Event::CreatedAt)
        .limit(u64::try_from(limit).unwrap_or_default())
        .into_model::<VaultEventRow>()
        .all(&orm(db))
        .await?;
    Ok(rows.iter().map(row_json).collect())
}

/// One `weldpass_audit_events` row as the audit route lists it.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditRow {
    id: String,
    environment_id: Option<String>,
    secret_id: Option<String>,
    actor_id: String,
    action: String,
    target_key: Option<String>,
    metadata: Value,
    ip: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    created_at: OffsetDateTime,
}

/// A project's audit trail, newest first, before `before` when given:
/// `limit` rows (the route asks one more than its page).
pub(crate) async fn list_audit_events(
    db: &PgPool,
    project_id: &str,
    before: Option<OffsetDateTime>,
    limit: i64,
) -> PassResult<Vec<Value>> {
    use weldpass_audit_events::Column as Audit;
    let mut select = weldpass_audit_events::Entity::find()
        .select_only()
        .columns([
            Audit::Id,
            Audit::EnvironmentId,
            Audit::SecretId,
            Audit::ActorId,
            Audit::Action,
            Audit::TargetKey,
            Audit::Metadata,
            Audit::Ip,
            Audit::CreatedAt,
        ])
        .filter(Audit::ProjectId.eq(project_id));
    if let Some(before) = before {
        select = select.filter(Audit::CreatedAt.lt(before));
    }
    let rows = select
        .order_by_desc(Audit::CreatedAt)
        .limit(u64::try_from(limit).unwrap_or_default())
        .into_model::<AuditRow>()
        .all(&orm(db))
        .await?;
    Ok(rows.iter().map(row_json).collect())
}

#[cfg(test)]
mod tests {
    use http::{HeaderMap, HeaderValue};

    use super::{AuditContext, client_ip};

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(*name, HeaderValue::from_str(value).expect("a header value"));
        }
        headers
    }

    #[test]
    fn the_address_is_the_one_the_trusted_proxy_saw() {
        let sent = headers(&[("x-forwarded-for", "203.0.113.7")]);
        assert_eq!(client_ip(&sent, 1).as_deref(), Some("203.0.113.7"));
        // A client's own entries sit further left and are skipped.
        let forged = headers(&[("x-forwarded-for", "10.9.9.9, 198.51.100.4")]);
        assert_eq!(client_ip(&forged, 1).as_deref(), Some("198.51.100.4"));
        assert_eq!(client_ip(&forged, 2).as_deref(), Some("10.9.9.9"));
        let split = headers(&[
            ("x-forwarded-for", "10.9.9.9"),
            ("x-forwarded-for", "2001:db8::1"),
        ]);
        assert_eq!(client_ip(&split, 1).as_deref(), Some("2001:db8::1"));
        assert_eq!(client_ip(&HeaderMap::new(), 1), None);
    }

    #[test]
    fn cf_connecting_ip_is_never_read() {
        let sent = headers(&[
            ("cf-connecting-ip", "1.1.1.1"),
            ("x-forwarded-for", "203.0.113.7"),
        ]);
        assert_eq!(client_ip(&sent, 1).as_deref(), Some("203.0.113.7"));
        let only = headers(&[("cf-connecting-ip", "1.1.1.1")]);
        assert_eq!(client_ip(&only, 1), None);
    }

    /// A value that would not fit the `ip` column (45) failed the trail's
    /// insert, and the reveal went out without its row.
    #[test]
    fn what_is_kept_always_fits_the_column() {
        let long = "a".repeat(200);
        let sent = headers(&[("cf-connecting-ip", &long), ("x-forwarded-for", &long)]);
        let context = AuditContext::from_headers(&sent, 1);
        assert_eq!(context.ip, None);
        let not_an_address = headers(&[("x-forwarded-for", "<script>")]);
        assert_eq!(client_ip(&not_an_address, 1), None);
    }
}
