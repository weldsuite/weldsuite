//! WeldPass's own trails, kept off the entity-event bus: `weldpass_audit_events`
//! for the secret vaults (`audit.ts`) and `weldpass_vault_events` for the
//! password manager (`vault-events.ts`). Reveals and 2FA codes are recorded
//! like writes. Only key names, titles and member ids are stored, never a
//! value. A failed write is logged loudly and swallowed: the request that
//! caused it has usually committed already.

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

use crate::{PassResult, js, row_json};

/// `WeldPassAuditContext`: who asked, read once per request.
#[derive(Debug, Clone, Default)]
pub(crate) struct AuditContext {
    pub(crate) ip: Option<String>,
    pub(crate) user_agent: Option<String>,
}

impl AuditContext {
    /// `auditContextFrom(headers)`: `CF-Connecting-IP`, else
    /// `X-Forwarded-For` (as sent; the ingress sets it on Kubernetes), and
    /// the first 500 characters of `User-Agent`.
    pub(crate) fn from_headers(headers: &HeaderMap) -> Self {
        let header = |name: &str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };
        Self {
            ip: header("cf-connecting-ip").or_else(|| header("x-forwarded-for")),
            user_agent: header("user-agent").map(|agent| js::utf16_slice(&agent, 0, 500)),
        }
    }
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

/// `recordAudit`.
pub(crate) async fn record_audit(db: &PgPool, context: &AuditContext, entry: AuditEntry<'_>) {
    let result = weldpass_audit_events::Entity::insert(weldpass_audit_events::ActiveModel {
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
    .await;
    if let Err(error) = result {
        tracing::error!(
            action = entry.action,
            project_id = entry.project_id,
            %error,
            "[weldpass] audit write failed"
        );
    }
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

/// `recordVaultEvent`: the label cut to 255 characters.
pub(crate) async fn record_vault_event(db: &PgPool, context: &AuditContext, entry: VaultEvent<'_>) {
    let label = entry
        .target_label
        .map(|label| js::utf16_slice(label, 0, 255));
    let result = weldpass_vault_events::Entity::insert(weldpass_vault_events::ActiveModel {
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
    .await;
    if let Err(error) = result {
        tracing::error!(
            action = entry.action,
            vault_id = entry.vault_id,
            %error,
            "[weldpass] vault event write failed"
        );
    }
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
