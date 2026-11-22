//! WeldMail through the public API (`routes/v1/mail-*`): `/v1/mail-accounts`,
//! `/v1/mail-messages`, `/v1/mail-threads`, `/v1/mail-labels`,
//! `/v1/mail-folders`, `/v1/mail-drafts` and `/v1/mail-attachments`, and
//! sending ([`sending`], `routes/v1/mail-sending`: compose, reply, forward,
//! draft-send and uploads). The MCP server's copy of `/v1` leaves sending
//! out, so an agent drafts and a person presses send.
//!
//! Every route resolves the caller's principal first
//! ([`MailPrincipal::from_session`]): a personal key acts as its member and
//! opens what WeldMail opens for them; a workspace key or an app token acts
//! as the workspace and opens **shared mailboxes only**. Anything in a
//! mailbox out of reach answers 404, never 403, lists included, so a key
//! cannot probe which private mailboxes exist.
//!
//! On Kubernetes mailbox contents live in Postgres (MAIL-010), so the store
//! the worker goes through (`getWorkspaceMail`) is the tenant database here,
//! through `weldsuite-mail-domain`.

mod accounts;
mod attachments;
mod drafts;
mod folders;
mod labels;
mod messages;
mod schemas;
mod sending;
mod threads;

use std::sync::Arc;

use axum::Router;
use axum::extract::FromRequestParts;
use axum::routing::{get, post};
use http::request::Parts;
use serde_json::{Map, Value};
use weldsuite_db::{MasterDb, PgPool};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_mail_domain::access::MailPrincipal;
use weldsuite_mail_domain::outbound::{OutboundBindings, OutboundGuard, RequestOutbound};
use weldsuite_mail_domain::recipients::{DnsOverHttps, MxLookup, RequestDoh};
use weldsuite_ports::{DynCache, FileStores, RequestCache, StorageBuckets};

use crate::ExternalApiState;
use crate::crud::{Caller, Fail};
use crate::simple::scoped;

/// The mail routes, at their `/v1` paths.
#[allow(clippy::too_many_lines)] // the route table
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    router
        .route(
            "/mail-accounts",
            scoped(get(accounts::list), "mail_accounts:read"),
        )
        .route(
            "/mail-accounts/{id}",
            scoped(get(accounts::detail), "mail_accounts:read"),
        )
        .route(
            "/mail-accounts/{id}/send",
            scoped(post(sending::send), "mail_messages:send"),
        )
        .route(
            "/mail-messages",
            scoped(get(messages::list), "mail_messages:read"),
        )
        .route(
            "/mail-messages/bulk",
            scoped(post(messages::bulk), "mail_messages:write"),
        )
        .route(
            "/mail-messages/{id}",
            scoped(get(messages::detail), "mail_messages:read").merge(scoped(
                axum::routing::patch(messages::update).delete(messages::remove),
                "mail_messages:write",
            )),
        )
        .route(
            "/mail-messages/{id}/attachments",
            scoped(get(messages::attachments), "mail_attachments:read"),
        )
        .route(
            "/mail-messages/{id}/labels",
            scoped(post(messages::labels), "mail_messages:write"),
        )
        .route(
            "/mail-messages/{id}/move",
            scoped(post(messages::move_to), "mail_messages:write"),
        )
        .route(
            "/mail-messages/{id}/reply",
            scoped(post(sending::reply), "mail_messages:send"),
        )
        .route(
            "/mail-messages/{id}/forward",
            scoped(post(sending::forward), "mail_messages:send"),
        )
        .route(
            "/mail-threads",
            scoped(get(threads::list), "mail_messages:read"),
        )
        .route(
            "/mail-threads/{thread_key}",
            scoped(get(threads::detail), "mail_messages:read"),
        )
        .route(
            "/mail-threads/{thread_key}/read",
            scoped(post(threads::read), "mail_messages:write"),
        )
        .route(
            "/mail-threads/{thread_key}/labels",
            scoped(post(threads::labels), "mail_messages:write"),
        )
        .route(
            "/mail-labels",
            scoped(get(labels::list), "mail_labels:read")
                .merge(scoped(post(labels::create), "mail_labels:write")),
        )
        .route(
            "/mail-labels/{id}",
            scoped(get(labels::detail), "mail_labels:read").merge(scoped(
                axum::routing::patch(labels::update).delete(labels::remove),
                "mail_labels:write",
            )),
        )
        .route(
            "/mail-folders",
            scoped(get(folders::list), "mail_folders:read")
                .merge(scoped(post(folders::create), "mail_folders:write")),
        )
        .route(
            "/mail-folders/{id}",
            scoped(get(folders::detail), "mail_folders:read").merge(scoped(
                axum::routing::patch(folders::update).delete(folders::remove),
                "mail_folders:write",
            )),
        )
        .route(
            "/mail-drafts",
            scoped(get(drafts::list), "mail_drafts:read")
                .merge(scoped(post(drafts::create), "mail_drafts:write")),
        )
        .route(
            "/mail-drafts/{id}",
            scoped(get(drafts::detail), "mail_drafts:read").merge(scoped(
                axum::routing::patch(drafts::update).delete(drafts::remove),
                "mail_drafts:write",
            )),
        )
        .route(
            "/mail-drafts/{id}/send",
            scoped(post(sending::send_draft), "mail_messages:send"),
        )
        .route(
            "/mail-attachments",
            scoped(post(sending::upload), "mail_attachments:write")
                // Up to 5 MB a file, with room for a multipart envelope.
                .layer(axum::extract::DefaultBodyLimit::max(6 * 1024 * 1024)),
        )
        .route(
            "/mail-attachments/{id}",
            scoped(get(attachments::detail), "mail_attachments:read"),
        )
        .route(
            "/mail-attachments/{id}/download",
            scoped(get(attachments::download), "mail_attachments:read"),
        )
}

/// The worker's bindings a mail route reads, as the request has them:
/// conformance builds insert the test's env, master database, KV, buckets,
/// transport and ledgers; otherwise the app's.
#[derive(Clone, Default)]
pub(crate) struct Bindings {
    env: Option<RequestEnv>,
    master: Option<PgPool>,
    cache: Option<Arc<dyn DynCache>>,
    outbound: Option<OutboundBindings>,
    buckets: Option<StorageBuckets>,
    doh: Option<Arc<dyn DnsOverHttps>>,
}

impl Bindings {
    fn from_parts(parts: &Parts) -> Self {
        Self {
            env: parts.extensions.get::<RequestEnv>().cloned(),
            master: parts.extensions.get::<MasterDb>().map(|m| m.0.clone()),
            cache: parts
                .extensions
                .get::<RequestCache>()
                .map(|c| Arc::clone(&c.0)),
            outbound: parts
                .extensions
                .get::<RequestOutbound>()
                .map(|o| o.0.clone()),
            buckets: parts.extensions.get::<StorageBuckets>().cloned(),
            doh: parts
                .extensions
                .get::<RequestDoh>()
                .map(|d| Arc::clone(&d.0)),
        }
    }

    /// The master database: only what the test shares in conformance
    /// builds, else the app's.
    fn master(&self, state: &ExternalApiState) -> Option<PgPool> {
        if self.env.is_some() {
            return self.master.clone();
        }
        Some(self.master.clone().unwrap_or_else(|| state.master.clone()))
    }

    fn cache(&self, state: &ExternalApiState) -> Option<Arc<dyn DynCache>> {
        self.cache.clone().or_else(|| state.cache.clone())
    }

    /// `SEND_EMAIL` and the outbound ledgers.
    pub(crate) fn outbound(&self, state: &ExternalApiState) -> OutboundBindings {
        self.outbound
            .clone()
            .unwrap_or_else(|| state.mail.outbound.clone())
    }

    /// `env.PRIVATE_STORAGE` / `env.STORAGE`, each optional: only the
    /// buckets a conformance test shares, else the app's.
    pub(crate) fn buckets(&self, state: &ExternalApiState) -> StorageBuckets {
        if self.env.is_some() {
            return self.buckets.clone().unwrap_or_default();
        }
        self.buckets.clone().unwrap_or_else(|| StorageBuckets {
            private: state.files.clone(),
            public: state.public_files.clone(),
        })
    }

    /// Both buckets as `getStoredObject` reads them.
    pub(crate) fn files(&self, state: &ExternalApiState) -> Option<FileStores> {
        self.buckets(state).file_stores()
    }

    /// The MX lookup's cache and DNS-over-HTTPS client.
    pub(crate) fn mx(&self, state: &ExternalApiState) -> MxLookup {
        MxLookup {
            cache: self.cache(state),
            doh: self.doh.clone().or_else(|| state.mail.doh.clone()),
        }
    }

    /// The outbound guard as the worker builds it from its env: the master
    /// database only when the worker has one (`DATABASE_URL_MASTER`; a test
    /// that sets none gets the guard's fail-open answers).
    pub(crate) fn guard(&self, state: &ExternalApiState) -> OutboundGuard {
        let master = match &self.env {
            Some(env) => env
                .get("DATABASE_URL_MASTER")
                .and_then(|_| self.master(state)),
            None => self.master(state),
        };
        self.outbound(state).guard(master, self.cache(state))
    }

    /// The master database the org id is looked up in.
    fn org_master(&self, state: &ExternalApiState, caller: &Caller) -> PgPool {
        self.master
            .clone()
            .or_else(|| caller.master.clone())
            .unwrap_or_else(|| state.master.clone())
    }
}

/// A mail route's caller: the key's session, the tenant database and the
/// event context ([`Caller`]), the principal, and the request's bindings.
pub(crate) struct MailCaller {
    pub(crate) caller: Caller,
    pub(crate) principal: MailPrincipal,
    pub(crate) bindings: Bindings,
}

impl<S: Send + Sync> FromRequestParts<S> for MailCaller {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let caller = Caller::from_request_parts(parts, state).await?;
        let principal = MailPrincipal::from_session(caller.session.user_id.as_deref());
        Ok(Self {
            caller,
            principal,
            bindings: Bindings::from_parts(parts),
        })
    }
}

impl MailCaller {
    pub(crate) fn db(&self) -> &PgPool {
        &self.caller.db
    }

    /// `orgIdOf(c)`: the workspace's organization id, the prefix of its
    /// storage keys: from the session, else looked up.
    pub(crate) async fn org(&self, state: &ExternalApiState) -> Result<Option<String>, Fail> {
        if let Some(org) = self
            .caller
            .session
            .clerk_org_id
            .as_deref()
            .filter(|org| !org.is_empty())
        {
            return Ok(Some(org.to_owned()));
        }
        let master = self.bindings.org_master(state, &self.caller);
        crate::social_posts::clerk_org_id(&master, &self.caller).await
    }
}

/// `publicMessage(row)`: a message without its raw source, headers,
/// provider bookkeeping, custom fields, soft-delete stamp, the store's
/// `threadKey` or raw attachment rows (they carry storage paths; a route
/// that answers with a message's files adds their public metadata).
pub(crate) fn public_message(mut row: Value) -> Value {
    if let Some(object) = row.as_object_mut() {
        for key in [
            "attachments",
            "rawMessage",
            "headers",
            "triggerRunId",
            "unsnoozeTriggerRunId",
            "mailgunMessageId",
            "mailcowMessageId",
            "providerMessageId",
            "sendProvider",
            "idempotencyKey",
            "customFields",
            "deletedAt",
            "threadKey",
        ] {
            object.remove(key);
        }
    }
    row
}

/// The narrow column set a list row has always had (`publicListMessage`).
const LIST_KEYS: [&str; 24] = [
    "id",
    "accountId",
    "messageId",
    "threadId",
    "from",
    "to",
    "cc",
    "subject",
    "preview",
    "sentDate",
    "receivedDate",
    "isRead",
    "isStarred",
    "isFlagged",
    "isImportant",
    "isDraft",
    "hasAttachments",
    "attachmentCount",
    "priority",
    "labels",
    "sizeBytes",
    "scheduledFor",
    "sendStatus",
    "createdAt",
];

/// `publicListMessage(row)`: picked explicitly, so a list never widens.
pub(crate) fn public_list_message(row: &Value) -> Value {
    let mut out = Map::new();
    for key in LIST_KEYS {
        if let Some(value) = row.get(key) {
            out.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(out)
}

/// `parseBoolFlag(value)`: `"true"` / `"false"`, else unset.
pub(crate) fn bool_flag(parsed: &crate::zod::Parsed, key: &str) -> Option<bool> {
    match parsed.get(key).and_then(Value::as_str) {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    }
}

/// A list's strings (`z.array(z.string())`), empty when absent.
pub(crate) fn strings(parsed: &crate::zod::Parsed, key: &str) -> Vec<String> {
    parsed
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// An optional list of strings: `None` when absent.
pub(crate) fn opt_strings(parsed: &crate::zod::Parsed, key: &str) -> Option<Vec<String>> {
    parsed.get(key).is_some().then(|| strings(parsed, key))
}

/// An optional text field (as given, even empty).
pub(crate) fn opt_text(parsed: &crate::zod::Parsed, key: &str) -> Option<String> {
    parsed.get(key).and_then(Value::as_str).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn public_messages_drop_the_internal_columns() {
        let row = json!({ "id": "msg_1", "rawMessage": "RAW", "threadKey": "t", "subject": "Hi" });
        assert_eq!(
            public_message(row),
            json!({ "id": "msg_1", "subject": "Hi" })
        );
    }

    #[test]
    fn list_rows_keep_the_list_columns() {
        let row = json!({ "id": "msg_1", "textBody": "body", "subject": "Hi" });
        let listed = public_list_message(&row);
        assert_eq!(listed, json!({ "id": "msg_1", "subject": "Hi" }));
    }
}
