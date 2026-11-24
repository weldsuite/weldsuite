//! The master `storefront_hosts` registry: which workspace, channel and site
//! a shop host belongs to, and what the storefront edge needs to serve it
//! (mode, live version or deployment, visibility, password) without opening
//! a tenant database. Every site change that matters to the edge is
//! mirrored onto its host rows here ([`sync_site`]); lookups are cached for
//! 30 seconds and the cache entries of a site's hosts are dropped on every
//! change.

use std::sync::Arc;
use std::time::Duration;

use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use weldsuite_db::{orm, utc_now};
use weldsuite_ports::DynCache;
use weldsuite_schema::master::storefront_hosts;

const CACHE_TTL: Duration = Duration::from_secs(30);

fn cache_key(host: &str) -> String {
    format!("sfh:{host}")
}

/// A shop host as the edge and the hosted principal see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostEntry {
    pub(crate) id: String,
    pub(crate) hostname: String,
    pub(crate) workspace_id: String,
    pub(crate) channel_id: String,
    pub(crate) site_id: String,
    pub(crate) is_primary: bool,
    /// `builder` or `static`.
    pub(crate) mode: String,
    pub(crate) published_version_id: Option<String>,
    pub(crate) deployment_id: Option<String>,
    /// `live`, `password` or `coming_soon`.
    pub(crate) visibility: String,
    pub(crate) password_hash: Option<String>,
    /// The site's primary active host (itself when it is the primary).
    pub(crate) primary_host: String,
    /// Every active host of the site.
    pub(crate) site_hosts: Vec<String>,
}

/// What the edge mirrors of a site.
#[derive(Debug, Clone, Default)]
pub(crate) struct SiteMirror {
    pub(crate) mode: String,
    pub(crate) published_version_id: Option<String>,
    pub(crate) deployment_id: Option<String>,
    pub(crate) visibility: String,
    pub(crate) password_hash: Option<String>,
}

/// The active host `host`, from the cache or the master database; `None`
/// for an unknown, pending or failed host.
pub(crate) async fn lookup(
    master: &PgPool,
    cache: Option<&Arc<dyn DynCache>>,
    host: &str,
) -> Result<Option<HostEntry>, DbErr> {
    let key = cache_key(host);
    if let Some(cache) = cache
        && let Ok(Some(raw)) = cache.get_boxed(&key).await
        && let Ok(entry) = serde_json::from_str::<Option<HostEntry>>(&raw)
    {
        return Ok(entry);
    }
    let entry = read(master, host).await?;
    if let Some(cache) = cache
        && let Ok(raw) = serde_json::to_string(&entry)
        && let Err(error) = cache.put_boxed(&key, &raw, Some(CACHE_TTL)).await
    {
        tracing::warn!(%error, "[online-store] host cache write failed");
    }
    Ok(entry)
}

async fn read(master: &PgPool, host: &str) -> Result<Option<HostEntry>, DbErr> {
    let db = orm(master);
    let Some(row) = storefront_hosts::Entity::find()
        .filter(storefront_hosts::Column::Hostname.eq(host))
        .filter(storefront_hosts::Column::Status.eq("active"))
        .one(&db)
        .await?
    else {
        return Ok(None);
    };
    let siblings = storefront_hosts::Entity::find()
        .filter(storefront_hosts::Column::WorkspaceId.eq(row.workspace_id.clone()))
        .filter(storefront_hosts::Column::SiteId.eq(row.site_id.clone()))
        .filter(storefront_hosts::Column::Status.eq("active"))
        .order_by_desc(storefront_hosts::Column::IsPrimary)
        .order_by_asc(storefront_hosts::Column::CreatedAt)
        .all(&db)
        .await?;
    let primary_host = siblings
        .first()
        .map_or_else(|| row.hostname.clone(), |p| p.hostname.clone());
    Ok(Some(HostEntry {
        id: row.id,
        hostname: row.hostname.clone(),
        workspace_id: row.workspace_id,
        channel_id: row.channel_id,
        site_id: row.site_id,
        is_primary: primary_host == row.hostname,
        mode: row.mode,
        published_version_id: row.published_version_id,
        deployment_id: row.deployment_id,
        visibility: row.visibility,
        password_hash: row.password_hash,
        primary_host,
        site_hosts: siblings.into_iter().map(|h| h.hostname).collect(),
    }))
}

/// Drops the cache entries of `hosts`.
pub(crate) async fn forget(cache: Option<&Arc<dyn DynCache>>, hosts: &[String]) {
    let Some(cache) = cache else {
        return;
    };
    for host in hosts {
        if let Err(error) = cache.delete_boxed(&cache_key(host)).await {
            tracing::warn!(%error, "[online-store] host cache delete failed");
        }
    }
}

/// Every host row of a site.
pub(crate) async fn site_hosts(
    master: &PgPool,
    workspace_id: &str,
    site_id: &str,
) -> Result<Vec<storefront_hosts::Model>, DbErr> {
    storefront_hosts::Entity::find()
        .filter(storefront_hosts::Column::WorkspaceId.eq(workspace_id))
        .filter(storefront_hosts::Column::SiteId.eq(site_id))
        .order_by_desc(storefront_hosts::Column::IsPrimary)
        .order_by_asc(storefront_hosts::Column::CreatedAt)
        .all(&orm(master))
        .await
}

/// Mirrors the site's state onto its host rows and drops their cache
/// entries.
pub(crate) async fn sync_site(
    master: &PgPool,
    cache: Option<&Arc<dyn DynCache>>,
    workspace_id: &str,
    site_id: &str,
    mirror: &SiteMirror,
) -> Result<(), DbErr> {
    storefront_hosts::Entity::update_many()
        .set(storefront_hosts::ActiveModel {
            mode: Set(mirror.mode.clone()),
            published_version_id: Set(mirror.published_version_id.clone()),
            deployment_id: Set(mirror.deployment_id.clone()),
            visibility: Set(mirror.visibility.clone()),
            password_hash: Set(mirror.password_hash.clone()),
            updated_at: Set(utc_now()),
            ..Default::default()
        })
        .filter(storefront_hosts::Column::WorkspaceId.eq(workspace_id))
        .filter(storefront_hosts::Column::SiteId.eq(site_id))
        .exec(&orm(master))
        .await?;
    let hosts: Vec<String> = site_hosts(master, workspace_id, site_id)
        .await?
        .into_iter()
        .map(|h| h.hostname)
        .collect();
    forget(cache, &hosts).await;
    Ok(())
}

/// Removes every host row of a site (the site is deleted); answers the
/// removed rows so their cluster objects can go too.
pub(crate) async fn remove_site(
    master: &PgPool,
    cache: Option<&Arc<dyn DynCache>>,
    workspace_id: &str,
    site_id: &str,
) -> Result<Vec<storefront_hosts::Model>, DbErr> {
    let rows = site_hosts(master, workspace_id, site_id).await?;
    storefront_hosts::Entity::delete_many()
        .filter(storefront_hosts::Column::WorkspaceId.eq(workspace_id))
        .filter(storefront_hosts::Column::SiteId.eq(site_id))
        .exec(&orm(master))
        .await?;
    let hosts: Vec<String> = rows.iter().map(|h| h.hostname.clone()).collect();
    forget(cache, &hosts).await;
    Ok(rows)
}
