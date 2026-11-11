//! The published form as respondents get it, cached so that opening a form
//! never opens the tenant database (`services/public-cache.ts`): KV on
//! Global, Valkey here, under the same key (`forms:public:<publicId>`) and
//! in the same JSON, so either backend reads the other's entry.
//!
//! Refreshed on publish, close, reopen, settings changes and when a response
//! crosses the form's limit or the workspace's quota. Staff suspension and the
//! content-screen hold are not in the entry: they live on the master registry
//! row, which every request reads.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::common::{Ctx, FormsResult, Svc, int, month_of, opt_text, text};
use crate::model::{FormSettings, parsed_definition, parsed_theme};
use crate::usage::load_usage;

pub(crate) const CACHE_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;

pub(crate) fn cache_key(public_id: &str) -> String {
    format!("forms:public:{public_id}")
}

/// `branding` of an entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Branding {
    pub(crate) workspace_name: String,
    pub(crate) logo_url: Option<String>,
    pub(crate) show_badge: bool,
}

/// `PublicCacheEntry`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicCacheEntry {
    pub(crate) form_id: String,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) version_id: Option<String>,
    pub(crate) definition: Option<Value>,
    pub(crate) theme: Value,
    pub(crate) settings: FormSettings,
    pub(crate) branding: Branding,
    /// The form's own response limit has been reached.
    pub(crate) limit_reached: bool,
    /// `YYYY-MM` of the month the workspace was over its quota.
    pub(crate) over_quota_month: Option<String>,
}

/// `readPublicCache(kv, publicId)`: `None` on a miss or an entry that does
/// not parse.
pub(crate) async fn read_public_cache(
    svc: &Svc,
    public_id: &str,
) -> FormsResult<Option<PublicCacheEntry>> {
    match svc.cache.get_boxed(&cache_key(public_id)).await {
        Ok(Some(raw)) => Ok(serde_json::from_str(&raw).ok()),
        Ok(None) => Ok(None),
        Err(error) => {
            tracing::warn!(%error, "forms: reading the public cache failed");
            Ok(None)
        }
    }
}

pub(crate) async fn write_public_cache(
    svc: &Svc,
    public_id: &str,
    entry: &PublicCacheEntry,
) -> FormsResult<()> {
    let text = serde_json::to_string(entry)?;
    svc.cache
        .put_boxed(
            &cache_key(public_id),
            &text,
            Some(Duration::from_secs(CACHE_TTL_SECONDS)),
        )
        .await?;
    Ok(())
}

pub(crate) async fn drop_public_cache(svc: &Svc, public_id: &str) -> FormsResult<()> {
    svc.cache.delete_boxed(&cache_key(public_id)).await?;
    Ok(())
}

/// `buildPublicEntry(ctx, form, now)`: the entry from the tenant and master rows.
pub(crate) async fn build_public_entry(
    ctx: &Ctx,
    form: &Value,
    now_ms: i64,
) -> FormsResult<PublicCacheEntry> {
    let version = match opt_text(form, "publishedVersionId") {
        Some(version_id) => {
            crate::common::one(
                &ctx.db,
                sqlx::query_scalar("select to_jsonb(v) from form_versions v where id = $1 limit 1")
                    .bind(version_id),
            )
            .await?
        }
        None => None,
    };
    let settings = FormSettings::parse(&form["settings"]);
    let workspace_name: Option<String> =
        sqlx::query_scalar("select name from workspaces where id = $1 limit 1")
            .bind(&ctx.workspace_id)
            .fetch_optional(ctx.master()?)
            .await?;
    let show_badge_row: Option<bool> =
        sqlx::query_scalar("select show_badge from form_settings limit 1")
            .fetch_optional(&ctx.db)
            .await?;
    let usage = load_usage(ctx, now_ms).await?;
    let theme = parsed_theme(version.as_ref().map_or(&Value::Null, |v| &v["theme"]));
    // The badge is only switchable off on plans that allow removing branding.
    let show_badge = show_badge_row.is_none_or(|row| row || !usage.workspace_plan.remove_branding);
    let limit_reached = settings
        .response_limit
        .is_some_and(|limit| int(form, "responseCount") >= limit);
    Ok(PublicCacheEntry {
        form_id: text(form, "id").to_owned(),
        title: text(form, "title").to_owned(),
        status: text(form, "status").to_owned(),
        version_id: version.as_ref().map(|v| text(v, "id").to_owned()),
        definition: version
            .as_ref()
            .map(|v| parsed_definition(&v["definition"])),
        branding: Branding {
            workspace_name: workspace_name.unwrap_or_else(|| "WeldSuite".to_owned()),
            logo_url: theme["logoUrl"].as_str().map(str::to_owned),
            show_badge,
        },
        theme,
        settings,
        limit_reached,
        over_quota_month: usage.over_quota().then(|| month_of(now_ms)),
    })
}

/// `refreshPublicCache(ctx, form)`: rebuilds and stores the entry of a form
/// that went live; a form that never did has none.
pub(crate) async fn refresh_public_cache(
    ctx: &Ctx,
    form: &Value,
) -> FormsResult<Option<PublicCacheEntry>> {
    let Some(public_id) = opt_text(form, "publicId") else {
        return Ok(None);
    };
    let entry = build_public_entry(ctx, form, ctx.now_ms()).await?;
    write_public_cache(&ctx.svc, &public_id, &entry).await?;
    Ok(Some(entry))
}
