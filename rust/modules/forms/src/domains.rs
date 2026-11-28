//! A workspace's own host names for its form links (`forms.acme.com`), on
//! the Kubernetes editions only: rows in the master `forms_custom_domains`
//! (host names are unique across workspaces), so the forms portal and the
//! sweep never open a tenant database.
//!
//! A domain serves every form of its workspace at `/f/<publicId>` and
//! `/i/<publicId>.<token>`, and optionally one chosen form (its home form)
//! at `/`. Forms of other workspaces are a 404 there, from the moment it is
//! added ([`host_allows`]). Once
//! a workspace marks an active domain primary, `publicUrl` and invitation
//! links use it ([`link_base`]); the install's portal URL keeps working.
//!
//! A domain goes live in three steps, each checked on add, on refresh and by
//! [`sweep_domains`] every few minutes, as WeldCommerce's shop domains:
//!
//! 1. **Ownership**: a TXT record `_weldforms.<host>` with
//!    `weldforms-verify=<token>`, so no workspace can take another's domain.
//! 2. **Routing**: a CNAME to the install's forms target, or for an apex
//!    domain A records to its ingress addresses.
//! 3. **Certificate**: cert-manager issues one over HTTP-01; the host's
//!    `Ingress` sends everything to the forms portal.

use std::sync::Arc;
use std::time::Duration;

use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{EventName, FORM_DOMAIN_FAILED, FORM_DOMAIN_VERIFIED};
use weldsuite_custom_domains::{CertManagerHosts, SSL_FAILED, normalize_host};
use weldsuite_db::{orm, utc_now};
use weldsuite_events::{EntityEventPublisher, EventContext, publish_entity_event};
use weldsuite_ports::DynCache;
use weldsuite_schema::master::forms_custom_domains as domains;

use crate::common::{Env, FormsResult, Svc};

/// Where the ownership record goes.
pub(crate) const VERIFY_LABEL: &str = "_weldforms";
pub(crate) const VERIFY_PREFIX: &str = "weldforms-verify=";
/// Domains one workspace may have.
pub(crate) const MAX_DOMAINS_PER_WORKSPACE: u64 = 10;
/// Domains one sweep checks.
const SWEEP_BATCH: u64 = 200;
/// How long a host lookup or a workspace's link base stays cached; every
/// change forgets both.
const CACHE_TTL: Duration = Duration::from_secs(300);

/// The install's default portal (`FORMS_PORTAL_URL`), without a trailing slash.
pub(crate) fn portal_url(env: &Env) -> String {
    let base = env
        .non_empty("FORMS_PORTAL_URL")
        .unwrap_or_else(|| "https://forms.weldsuite.org".to_owned());
    base.trim_end_matches('/').to_owned()
}

/// The host of the install's default portal.
fn portal_host(env: &Env) -> Option<String> {
    url::Url::parse(&portal_url(env))
        .ok()
        .and_then(|url| url.host_str().map(normalize_host))
}

/// Whether a host name is the install's own portal (or under it).
pub(crate) fn is_portal_host(env: &Env, host: &str) -> bool {
    portal_host(env).is_some_and(|portal| weldsuite_custom_domains::is_under(host, &portal))
}

/// A host name of at most 253 characters in labels of 1–63 letters, digits
/// and inner hyphens, with at least two labels and a non-numeric top label;
/// lower case.
pub(crate) fn is_host_name(host: &str) -> bool {
    host.len() <= 253
        && host.contains('.')
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
        && !host
            .rsplit('.')
            .next()
            .is_some_and(|tld| tld.bytes().all(|b| b.is_ascii_digit()))
}

/// An apex domain, as far as the API can tell without a public suffix list:
/// two labels (`example.com`).
fn looks_like_apex(host: &str) -> bool {
    host.split('.').count() == 2
}

/// The DNS records the customer adds, and whether each is in place.
fn dns_records(cert: Option<&CertManagerHosts>, row: &domains::Model) -> Vec<Value> {
    let mut records = vec![json!({
        "type": "TXT",
        "name": format!("{VERIFY_LABEL}.{}", row.hostname),
        "value": format!("{VERIFY_PREFIX}{}", row.verification_token),
        "purpose": "ownership",
        "satisfied": row.verified_at.is_some(),
    })];
    let Some(cert) = cert else {
        return records;
    };
    let target = cert.target();
    let routed = row.ssl_status.is_some();
    if looks_like_apex(&row.hostname) && !target.apex_addresses.is_empty() {
        for address in &target.apex_addresses {
            let kind = if address.contains(':') { "AAAA" } else { "A" };
            records.push(json!({
                "type": kind, "name": row.hostname, "value": address,
                "purpose": "routing", "satisfied": routed,
            }));
        }
    } else {
        records.push(json!({
            "type": "CNAME", "name": row.hostname, "value": target.host,
            "purpose": "routing", "satisfied": routed,
        }));
    }
    records
}

/// A domain as the API answers it.
pub(crate) fn present(cert: Option<&CertManagerHosts>, row: &domains::Model) -> Value {
    json!({
        "id": row.id,
        "hostname": row.hostname,
        "isPrimary": row.is_primary,
        "status": row.status,
        "sslStatus": row.ssl_status,
        "lastError": row.last_error,
        "lastCheckedAt": row.last_checked_at.map(iso),
        "verifiedAt": row.verified_at.map(iso),
        "homeFormPublicId": row.home_form_public_id,
        "url": format!("https://{}", row.hostname),
        "dnsRecords": dns_records(cert, row),
        "createdAt": iso(row.created_at),
    })
}

/// What an event says of a domain: never its ownership token.
pub(crate) fn event_data(row: &domains::Model) -> Value {
    json!({
        "id": row.id,
        "hostname": row.hostname,
        "isPrimary": row.is_primary,
        "status": row.status,
        "sslStatus": row.ssl_status,
        "homeFormPublicId": row.home_form_public_id,
    })
}

fn iso(at: time::PrimitiveDateTime) -> String {
    let at = at.assume_utc();
    let ms = at.unix_timestamp() * 1000 + i64::from(at.millisecond());
    crate::common::iso(ms)
}

/// A workspace's domains, primary first.
pub(crate) async fn list(
    master: &PgPool,
    workspace_id: &str,
) -> Result<Vec<domains::Model>, DbErr> {
    domains::Entity::find()
        .filter(domains::Column::WorkspaceId.eq(workspace_id))
        .order_by_desc(domains::Column::IsPrimary)
        .order_by_asc(domains::Column::CreatedAt)
        .all(&orm(master))
        .await
}

/// One of a workspace's domains.
pub(crate) async fn find(
    master: &PgPool,
    workspace_id: &str,
    id: &str,
) -> Result<Option<domains::Model>, DbErr> {
    domains::Entity::find_by_id(id.to_owned())
        .filter(domains::Column::WorkspaceId.eq(workspace_id))
        .one(&orm(master))
        .await
}

/// A fresh ownership token: 32 hex characters.
pub(crate) fn new_token() -> String {
    weldsuite_kit::portal::tokens::random_token(16)
}

/// Moves a domain along (ownership, routing, certificate) and saves where it
/// stands; answers the row and the event the change deserves. Without
/// cert-manager the row is answered as it is.
pub(crate) async fn check(
    master: &PgPool,
    cert: Option<&CertManagerHosts>,
    row: domains::Model,
) -> (domains::Model, Option<EventName>) {
    let Some(cert) = cert else {
        return (row, None);
    };
    let now = utc_now();
    let mut change = domains::ActiveModel {
        id: Set(row.id.clone()),
        last_checked_at: Set(Some(now)),
        updated_at: Set(now),
        ..Default::default()
    };
    let mut verified = row.verified_at.is_some();
    let mut status = row.status.clone();
    let mut ssl = row.ssl_status.clone();
    let mut error: Option<String> = None;
    if !verified {
        let name = format!("{VERIFY_LABEL}.{}", row.hostname);
        let expected = format!("{VERIFY_PREFIX}{}", row.verification_token);
        match cert.txt_records(&name).await {
            Ok(records) if records.iter().any(|r| r.trim() == expected) => {
                verified = true;
                change.verified_at = Set(Some(now));
            }
            Ok(_) => {
                error = Some(format!(
                    "Add the TXT record {name} with the value {expected}"
                ));
            }
            Err(problem) => error = Some(problem.message),
        }
    }
    if verified {
        match cert.reconcile(&row.hostname).await {
            Ok(state) => {
                status = if state.status == "active" {
                    "active".to_owned()
                } else if state.ssl_status.as_deref() == Some(SSL_FAILED) {
                    "failed".to_owned()
                } else {
                    "pending".to_owned()
                };
                ssl = state.ssl_status;
                error = state.errors.into_iter().next();
            }
            Err(problem) => error = Some(problem.message),
        }
    }
    change.status = Set(status.clone());
    change.ssl_status = Set(ssl);
    change.last_error = Set(error);
    let event = match (row.status.as_str(), status.as_str()) {
        (before, "active") if before != "active" => Some(FORM_DOMAIN_VERIFIED),
        (before, "failed") if before != "failed" => Some(FORM_DOMAIN_FAILED),
        _ => None,
    };
    match domains::Entity::update(change).exec(&orm(master)).await {
        Ok(saved) => (saved, event),
        Err(problem) => {
            tracing::error!(error = %problem, host = %row.hostname, "forms: a domain's check was not saved");
            (row, None)
        }
    }
}

// ---------------------------------------------------------------------------
// Lookups, cached
// ---------------------------------------------------------------------------

fn host_key(host: &str) -> String {
    format!("forms:domain:host:{host}")
}

fn base_key(workspace_id: &str) -> String {
    format!("forms:domain:base:{workspace_id}")
}

/// What the portal and the respondent routes need of a host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostEntry {
    pub(crate) workspace_id: String,
    pub(crate) home_form_public_id: Option<String>,
    /// Live: ownership, routing and certificate in place.
    pub(crate) active: bool,
}

/// A domain by its host name, whatever its status; `None` for a host no
/// workspace has added.
pub(crate) async fn lookup_host(
    master: &PgPool,
    cache: &Arc<dyn DynCache>,
    host: &str,
) -> Result<Option<HostEntry>, DbErr> {
    let key = host_key(host);
    if let Ok(Some(raw)) = cache.get_boxed(&key).await
        && let Ok(entry) = serde_json::from_str::<Option<HostEntry>>(&raw)
    {
        return Ok(entry);
    }
    let entry = domains::Entity::find()
        .filter(domains::Column::Hostname.eq(host))
        .one(&orm(master))
        .await?
        .map(|row| HostEntry {
            active: row.status == "active",
            workspace_id: row.workspace_id,
            home_form_public_id: row.home_form_public_id,
        });
    if let Ok(raw) = serde_json::to_string(&entry)
        && let Err(error) = cache.put_boxed(&key, &raw, Some(CACHE_TTL)).await
    {
        tracing::warn!(%error, "forms: the domain cache write failed");
    }
    Ok(entry)
}

/// Where a workspace's form links point: `https://<primary domain>` when it
/// has an active primary one, else the install's portal. Never fails: a
/// problem is logged and the portal answered.
pub(crate) async fn link_base(svc: &Svc, master: Option<&PgPool>, workspace_id: &str) -> String {
    let fallback = portal_url(&svc.env);
    let Some(master) = master else {
        return fallback;
    };
    let key = base_key(workspace_id);
    if let Ok(Some(raw)) = svc.cache.get_boxed(&key).await {
        return if raw.is_empty() { fallback } else { raw };
    }
    let primary = domains::Entity::find()
        .filter(domains::Column::WorkspaceId.eq(workspace_id))
        .filter(domains::Column::IsPrimary.eq(true))
        .filter(domains::Column::Status.eq("active"))
        .one(&orm(master))
        .await;
    let base = match primary {
        Ok(row) => row.map(|row| format!("https://{}", row.hostname)),
        Err(error) => {
            tracing::warn!(%error, "forms: reading the primary domain failed");
            return fallback;
        }
    };
    let cached = base.clone().unwrap_or_default();
    if let Err(error) = svc.cache.put_boxed(&key, &cached, Some(CACHE_TTL)).await {
        tracing::warn!(%error, "forms: the domain cache write failed");
    }
    base.unwrap_or(fallback)
}

/// [`link_base`] of a member's or a job's workspace.
pub(crate) async fn base_of(ctx: &crate::common::Ctx) -> String {
    link_base(&ctx.svc, ctx.master.as_ref(), &ctx.workspace_id).await
}

/// Forgets what is cached of a workspace's domains: its link base and the
/// given hosts. The public cache entries are untouched (they hold no URL).
pub(crate) async fn forget(cache: &Arc<dyn DynCache>, workspace_id: &str, hosts: &[String]) {
    let keys = hosts
        .iter()
        .map(|host| host_key(host))
        .chain(std::iter::once(base_key(workspace_id)));
    for key in keys {
        if let Err(error) = cache.delete_boxed(&key).await {
            tracing::warn!(%error, "forms: the domain cache delete failed");
        }
    }
}

/// Whether a form of `workspace_id` may be served on `host`, the host the
/// respondent reached the portal on (`X-Forms-Host`). A host some workspace
/// added as a form domain, live or not yet, serves that workspace's forms
/// only. Any other host is the install's own portal (only the install's
/// Ingress routes it there; no host at all is Global or an older portal) and
/// serves every form, so a portal URL that differs from `FORMS_PORTAL_URL`
/// (local development, an install that never set it) keeps working.
pub(crate) async fn host_allows(
    svc: &Svc,
    master: &PgPool,
    host: Option<&str>,
    workspace_id: &str,
) -> FormsResult<bool> {
    let Some(host) = host.map(normalize_host).filter(|h| !h.is_empty()) else {
        return Ok(true);
    };
    if portal_host(&svc.env).as_deref() == Some(host.as_str()) {
        return Ok(true);
    }
    Ok(lookup_host(master, &svc.cache, &host)
        .await?
        .is_none_or(|entry| entry.workspace_id == workspace_id))
}

/// `weldsuite cron forms-domains`: checks the domains that aren't live yet,
/// from the master database alone, and publishes the changes. Answers how
/// many were checked.
pub async fn sweep_domains(
    master: &PgPool,
    cert: Option<&CertManagerHosts>,
    cache: Option<&Arc<dyn DynCache>>,
    events: Option<&EntityEventPublisher>,
) -> Result<usize, DbErr> {
    if cert.is_none() {
        return Ok(0);
    }
    let rows = domains::Entity::find()
        .filter(domains::Column::Status.ne("active"))
        .order_by_asc(domains::Column::LastCheckedAt)
        .limit(SWEEP_BATCH)
        .all(&orm(master))
        .await?;
    let checked = rows.len();
    for row in rows {
        let (row, event) = check(master, cert, row).await;
        if let Some(cache) = cache {
            forget(
                cache,
                &row.workspace_id,
                std::slice::from_ref(&row.hostname),
            )
            .await;
        }
        if let (Some(event), Some(events)) = (event, events) {
            let ctx = EventContext::from_ids(&row.workspace_id, None, "system");
            publish_entity_event(events, &ctx, event, &row.id, &event_data(&row));
        }
    }
    Ok(checked)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_names() {
        for good in ["forms.example.com", "example.nl", "a-b.example.co.uk"] {
            assert!(is_host_name(good), "{good}");
        }
        for bad in [
            "localhost",
            "-forms.example.com",
            "forms..example.com",
            "Forms.Example.com",
            "1.2.3.4",
            "forms_1.example.com",
        ] {
            assert!(!is_host_name(bad), "{bad}");
        }
    }

    #[test]
    fn apex_heuristic() {
        assert!(looks_like_apex("example.com"));
        assert!(!looks_like_apex("forms.example.com"));
    }

    /// Against the master schema (`WELDSUITE_TEST_MASTER_URL`, built by
    /// `scripts/rust-test-db.ts`); skipped without it.
    mod db {
        use std::collections::HashMap;

        use sea_orm::{ActiveValue::Set, EntityTrait};
        use weldsuite_db::{master_pool, orm, utc_now};
        use weldsuite_ports::MemoryCache;

        use super::super::*;
        use crate::FormsState;

        fn fresh(prefix: &str) -> String {
            format!("{prefix}{}", new_token().get(..10).unwrap_or_default())
        }

        fn svc(cache: &Arc<MemoryCache>) -> Svc {
            let env = HashMap::from([(
                "FORMS_PORTAL_URL".to_owned(),
                "https://forms.install.test/".to_owned(),
            )]);
            let state = FormsState {
                events: EntityEventPublisher::new(None, weldsuite_events::TaskTracker::new()),
                master: None,
                files: None,
                cache: Some(Arc::clone(cache) as Arc<dyn DynCache>),
                jobs: None,
                realtime: None,
                mail: None,
                http: None,
                tenants: None,
                outbound: weldsuite_mail_domain::outbound::OutboundBindings::default(),
                env: Arc::new(env),
                local_cache: Arc::default(),
                ai: None,
                domains: None,
            };
            state.services(&http::Extensions::new())
        }

        async fn insert(master: &PgPool, workspace: &str, host: &str, status: &str, primary: bool) {
            let now = utc_now();
            domains::Entity::insert(domains::ActiveModel {
                id: Set(fresh("fdom_")),
                created_at: Set(now),
                updated_at: Set(now),
                hostname: Set(host.to_owned()),
                workspace_id: Set(workspace.to_owned()),
                is_primary: Set(primary),
                status: Set(status.to_owned()),
                ssl_status: Set(None),
                verification_token: Set(new_token()),
                last_error: Set(None),
                last_checked_at: Set(None),
                verified_at: Set(None),
                home_form_public_id: Set(Some("home123".to_owned())),
                created_by_user_id: Set(None),
            })
            .exec(&orm(master))
            .await
            .expect("insert a domain");
        }

        fn master() -> Option<PgPool> {
            let Ok(url) = std::env::var("WELDSUITE_TEST_MASTER_URL") else {
                eprintln!("WELDSUITE_TEST_MASTER_URL not set; skipping");
                return None;
            };
            Some(master_pool(&url, 2).expect("master pool"))
        }

        #[tokio::test]
        async fn a_custom_domain_serves_only_its_workspaces_forms() {
            let Some(master) = master() else { return };
            let cache = Arc::new(MemoryCache::default());
            let svc = svc(&cache);
            let (ours, theirs) = (fresh("ws_a"), fresh("ws_b"));
            let live = format!("{}.acme.test", fresh("forms"));
            let pending = format!("{}.acme.test", fresh("wait"));
            insert(&master, &ours, &live, "active", false).await;
            insert(&master, &ours, &pending, "pending", false).await;

            // No host (Global, an older portal) and the install's portal: every form.
            assert!(
                host_allows(&svc, &master, None, &theirs)
                    .await
                    .unwrap_or(false)
            );
            assert!(
                host_allows(&svc, &master, Some("forms.install.test"), &theirs)
                    .await
                    .unwrap_or(false)
            );
            // The live domain: its own workspace's forms only, whatever the case.
            assert!(
                host_allows(&svc, &master, Some(&live.to_uppercase()), &ours)
                    .await
                    .unwrap_or(false)
            );
            assert!(
                !host_allows(&svc, &master, Some(&live), &theirs)
                    .await
                    .unwrap_or(true)
            );
            // A domain not live yet already serves its own workspace's forms only.
            assert!(
                host_allows(&svc, &master, Some(&pending), &ours)
                    .await
                    .unwrap_or(false)
            );
            assert!(
                !host_allows(&svc, &master, Some(&pending), &theirs)
                    .await
                    .unwrap_or(true)
            );
            // A host nobody added is the install's own portal (say, localhost).
            assert!(
                host_allows(&svc, &master, Some("localhost"), &theirs)
                    .await
                    .unwrap_or(false)
            );

            let entry = lookup_host(&master, &svc.cache, &live)
                .await
                .expect("lookup");
            assert_eq!(
                entry,
                Some(HostEntry {
                    workspace_id: ours.clone(),
                    home_form_public_id: Some("home123".to_owned()),
                    active: true,
                })
            );
            let waiting = lookup_host(&master, &svc.cache, &pending)
                .await
                .expect("lookup");
            assert_eq!(waiting.map(|entry| entry.active), Some(false));
        }

        #[tokio::test]
        async fn links_use_the_active_primary_domain() {
            let Some(master) = master() else { return };
            let cache = Arc::new(MemoryCache::default());
            let svc = svc(&cache);
            let workspace = fresh("ws_p");
            assert_eq!(
                link_base(&svc, Some(&master), &workspace).await,
                "https://forms.install.test"
            );
            assert_eq!(
                link_base(&svc, None, &workspace).await,
                "https://forms.install.test"
            );

            let host = format!("{}.acme.test", fresh("links"));
            insert(&master, &workspace, &host, "active", true).await;
            // Cached until a change forgets it.
            assert_eq!(
                link_base(&svc, Some(&master), &workspace).await,
                "https://forms.install.test"
            );
            forget(&svc.cache, &workspace, std::slice::from_ref(&host)).await;
            assert_eq!(
                link_base(&svc, Some(&master), &workspace).await,
                format!("https://{host}")
            );
            assert_eq!(
                crate::common::public_form_url(&format!("https://{host}"), Some("abc")),
                Some(format!("https://{host}/f/abc"))
            );
        }

        #[tokio::test]
        async fn without_cert_manager_a_check_changes_nothing() {
            let Some(master) = master() else { return };
            let workspace = fresh("ws_c");
            let host = format!("{}.acme.test", fresh("check"));
            insert(&master, &workspace, &host, "pending", false).await;
            let row = list(&master, &workspace).await.expect("list").remove(0);
            let (after, event) = check(&master, None, row.clone()).await;
            assert_eq!(after, row);
            assert!(event.is_none());
            assert_eq!(sweep_domains(&master, None, None, None).await.ok(), Some(0));
            let shown = present(None, &row);
            assert_eq!(shown["dnsRecords"][0]["type"], "TXT");
            assert_eq!(shown["dnsRecords"][0]["name"], format!("_weldforms.{host}"));
            assert!(shown.get("verificationToken").is_none());
        }
    }
}
