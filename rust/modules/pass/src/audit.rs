//! WeldPass's own trails, kept off the entity-event bus: `weldpass_audit_events`
//! for the secret vaults (`audit.ts`) and `weldpass_vault_events` for the
//! password manager (`vault-events.ts`). Reveals and 2FA codes are recorded
//! like writes. Only key names, titles and member ids are stored, never a
//! value. A failed write is logged loudly and swallowed: the request that
//! caused it has usually committed already.

use http::HeaderMap;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_kit::generate_id;

use crate::js;

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
    let result = sqlx::query(
        "insert into weldpass_audit_events \
         (id, project_id, environment_id, secret_id, actor_id, action, target_key, metadata, ip, user_agent) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(generate_id("wpa"))
    .bind(entry.project_id)
    .bind(entry.environment_id)
    .bind(entry.secret_id)
    .bind(entry.actor_id)
    .bind(entry.action)
    .bind(entry.target_key)
    .bind(&entry.metadata)
    .bind(context.ip.as_deref())
    .bind(context.user_agent.as_deref())
    .execute(db)
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
    let label = entry.target_label.map(|label| js::utf16_slice(label, 0, 255));
    let result = sqlx::query(
        "insert into weldpass_vault_events \
         (id, vault_id, item_id, actor_id, action, target_label, metadata, ip, user_agent) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(generate_id("wpx"))
    .bind(entry.vault_id)
    .bind(entry.item_id)
    .bind(entry.actor_id)
    .bind(entry.action)
    .bind(label)
    .bind(&entry.metadata)
    .bind(context.ip.as_deref())
    .bind(context.user_agent.as_deref())
    .execute(db)
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
