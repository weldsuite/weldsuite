//! WeldSocial's publishing through PostPeer (`@weldsuite/social-publishing`'s
//! `publishing.ts`): the workspace's PostPeer profile, connecting and syncing
//! channels, publishing and scheduling (the atomic claim, credit metering,
//! partial-failure refunds), cancelling, the delivery webhook's
//! reconciliation and the analytics sync.
//!
//! Every statement and every PostPeer call is the TypeScript service's, in
//! its order; the conformance suite compares the calls and the answers.

use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, js_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_ports::OutboundHttp;

use crate::credits::{
    Consumed, LedgerEntry, SOCIAL_POST_PER_PLATFORM, consume_credits, refund_credits,
    resolve_internal_workspace_id,
};
use crate::postpeer::{
    PostPeerClient, PostPeerError, object, postpeer_app_id, str_field, to_postpeer_schedule,
};

/// What the routes tell apart (the service's error classes), and every other
/// `Error` by its message.
#[derive(Debug)]
pub enum PublishError {
    /// `PostPeerNotConfiguredError`.
    NotConfigured,
    /// `SocialPublishConflictError`.
    Conflict(String),
    /// `SocialCancelUpstreamError`.
    CancelUpstream(String),
    /// `SocialInsufficientCreditsError`.
    InsufficientCredits {
        current_balance: i64,
        required: i64,
    },
    /// `PostPeerError`, with its status.
    PostPeer(PostPeerError),
    /// Any other `Error`, by its message.
    Message(String),
    Database(sqlx::Error),
}

impl std::fmt::Display for PublishError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured => {
                f.write_str("PostPeer is not configured (POSTPEER_API_KEY missing)")
            }
            Self::Conflict(message) | Self::CancelUpstream(message) | Self::Message(message) => {
                f.write_str(message)
            }
            Self::InsufficientCredits {
                current_balance,
                required,
            } => write!(
                f,
                "Insufficient credits: publishing requires {required}, balance is {current_balance}"
            ),
            Self::PostPeer(error) => f.write_str(&error.message),
            Self::Database(error) => error.fmt(f),
        }
    }
}

impl From<sqlx::Error> for PublishError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<PostPeerError> for PublishError {
    fn from(error: PostPeerError) -> Self {
        Self::PostPeer(error)
    }
}

/// `SocialPublishingContext`: PostPeer's settings, the master database
/// (credits and the post index) and the HTTP client.
#[derive(Clone)]
pub struct Context {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub app_ids: Option<String>,
    pub master: Option<PgPool>,
    pub http: OutboundHttp,
}

impl Context {
    fn client(&self) -> Option<PostPeerClient> {
        PostPeerClient::from_env(
            self.http.clone(),
            self.api_key.as_deref(),
            self.base_url.as_deref(),
        )
    }

    fn require_client(&self) -> Result<PostPeerClient, PublishError> {
        self.client().ok_or(PublishError::NotConfigured)
    }
}

/// `new Date()`, as Drizzle writes it.
pub fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// A JSON value as the `||` and `??` of the service read it.
fn nullish(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `String(value)` for ids PostPeer hands back.
fn id_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        other => other.to_string(),
    }
}

/// `normalisePlatform`: PostPeer's platform names onto `social_platform`.
pub fn normalise_platform(platform: &str) -> Option<&'static str> {
    match platform.to_lowercase().as_str() {
        "x" | "twitter" => Some("twitter"),
        "facebook" => Some("facebook"),
        "instagram" => Some("instagram"),
        "linkedin" => Some("linkedin"),
        "tiktok" => Some("tiktok"),
        _ => None,
    }
}

// ── profile and connect ─────────────────────────────────────────────────────

/// `ensureWorkspaceProfile`: the workspace's PostPeer profile, adopted by
/// name or created on first use, and stored under
/// `workspace_settings.custom_settings.social.postpeerProfileId`.
pub async fn ensure_workspace_profile(
    db: &PgPool,
    ctx: &Context,
    workspace_id: &str,
) -> Result<String, PublishError> {
    let client = ctx.require_client()?;
    let settings: Option<(Option<Value>,)> =
        sqlx::query_as("select custom_settings from workspace_settings where id = $1 limit 1")
            .bind(workspace_id)
            .fetch_optional(db)
            .await?;
    let custom = settings
        .as_ref()
        .and_then(|(custom,)| custom.as_ref())
        .filter(|custom| !custom.is_null())
        .map(object)
        .unwrap_or_default();
    let social = custom.get("social").map(object).unwrap_or_default();
    if let Some(existing) = social.get("postpeerProfileId")
        && truthy(Some(existing))
    {
        return Ok(id_text(existing));
    }
    let profiles = client.list_profiles().await?;
    let adopted = profiles
        .iter()
        .find(|p| str_field(p, "name") == Some(workspace_id))
        .and_then(|p| p.get("id").cloned());
    let profile_id = match adopted.filter(|id| !id.is_null()) {
        Some(id) => id,
        None => client
            .create_profile(workspace_id)
            .await?
            .get("id")
            .cloned()
            .unwrap_or(Value::Null),
    };
    let mut social = social;
    if profile_id.is_null() {
        social.remove("postpeerProfileId");
    } else {
        social.insert("postpeerProfileId".to_owned(), profile_id.clone());
    }
    let mut custom = custom;
    custom.insert("social".to_owned(), Value::Object(social));
    let now = now();
    if settings.is_some() {
        sqlx::query(
            "update workspace_settings as t set custom_settings = $2::jsonb,
                 updated_at = r.updated_at
             from jsonb_populate_record(null::workspace_settings, jsonb_build_object('updated_at', $3::text)) r
             where t.id = $1",
        )
        .bind(workspace_id)
        .bind(Value::Object(custom))
        .bind(&now)
        .execute(db)
        .await?;
    } else {
        sqlx::query(
            "insert into workspace_settings (id, custom_settings, created_at, updated_at)
             select $1, $2::jsonb, r.created_at, r.updated_at
             from jsonb_populate_record(null::workspace_settings,
                 jsonb_build_object('created_at', $3::text, 'updated_at', $3::text)) r",
        )
        .bind(workspace_id)
        .bind(Value::Object(custom))
        .bind(&now)
        .execute(db)
        .await?;
    }
    Ok(id_text(&profile_id))
}

/// `getConnectUrl`: the hosted OAuth URL for `platform`, under the
/// workspace's profile and the platform's BYOK app.
pub async fn get_connect_url(
    db: &PgPool,
    ctx: &Context,
    workspace_id: &str,
    platform: &str,
    redirect_uri: Option<&str>,
) -> Result<Value, PublishError> {
    let client = ctx.require_client()?;
    let profile_id = ensure_workspace_profile(db, ctx, workspace_id).await?;
    let app_id = postpeer_app_id(ctx.app_ids.as_deref(), platform);
    let answer = client
        .get_connect_url(platform, &profile_id, redirect_uri, app_id.as_deref())
        .await?;
    let mut out = Map::new();
    if let Some(url) = answer.get("url").filter(|url| !url.is_null()) {
        out.insert("url".to_owned(), url.clone());
    }
    out.insert("profileId".to_owned(), Value::String(profile_id));
    if let Some(app_id) = app_id {
        out.insert("appId".to_owned(), Value::String(app_id));
    }
    Ok(Value::Object(out))
}

// ── account sync ────────────────────────────────────────────────────────────

/// `syncAccounts`: the channels connected under every profile the workspace
/// owns, into `social_accounts` (matched on the integration id or on the
/// channel itself). Integrations of any other profile are never imported.
#[allow(clippy::too_many_lines)] // the service's one loop
pub async fn sync_accounts(
    db: &PgPool,
    ctx: &Context,
    workspace_id: &str,
    connected_by: &str,
) -> Result<Value, PublishError> {
    let client = ctx.require_client()?;
    let primary = ensure_workspace_profile(db, ctx, workspace_id).await?;
    let mut own: Vec<String> = vec![primary];
    if let Ok(profiles) = client.list_profiles().await {
        for profile in profiles {
            if str_field(&profile, "name") == Some(workspace_id) {
                let id = profile.get("id").map(id_text).unwrap_or_default();
                if !own.contains(&id) {
                    own.push(id);
                }
            }
        }
    }
    let mut integrations = Vec::new();
    for profile_id in &own {
        integrations.extend(client.list_integrations(profile_id).await?);
    }
    let mut account_ids: Vec<String> = Vec::new();
    let now = now();
    for integration in integrations {
        let Some(profile_id) = integration
            .get("profileId")
            .filter(|p| truthy(Some(p)))
            .map(id_text)
        else {
            continue;
        };
        if !own.contains(&profile_id) {
            continue;
        }
        let platform_raw = integration
            .get("platform")
            .map_or_else(|| "undefined".to_owned(), id_text);
        let Some(platform) = normalise_platform(&platform_raw) else {
            continue;
        };
        let integration_id = integration.get("id").map(id_text).unwrap_or_default();
        let platform_account_id = integration
            .get("platformUserId")
            .filter(|v| !v.is_null())
            .map_or_else(|| integration_id.clone(), id_text);
        let text = |key: &str| integration.get(key).filter(|v| !v.is_null()).map(id_text);
        let existing: Option<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
            "select id, name, username, avatar_url from social_accounts
             where postpeer_integration_id = $1
                or (platform = $2::social_platform and platform_account_id = $3)
             limit 1",
        )
        .bind(&integration_id)
        .bind(platform)
        .bind(&platform_account_id)
        .fetch_optional(db)
        .await?;
        if let Some((id, name, username, avatar_url)) = existing {
            sqlx::query(
                "update social_accounts set name = $2, username = $3, avatar_url = $4,
                     postpeer_integration_id = $5, postpeer_profile_id = $6, status = 'active',
                     last_sync_at = $7::timestamp, deleted_at = null, updated_at = $7::timestamp
                 where id = $1",
            )
            .bind(&id)
            .bind(text("name").or_else(|| text("username")).unwrap_or(name))
            .bind(text("username").or(username))
            .bind(text("avatarUrl").or(avatar_url))
            .bind(&integration_id)
            .bind(&profile_id)
            .bind(&now)
            .execute(db)
            .await?;
            account_ids.push(id);
        } else {
            let id = generate_id("sac");
            sqlx::query(
                "insert into social_accounts
                     (id, platform, platform_account_id, name, username, avatar_url,
                      postpeer_integration_id, postpeer_profile_id, status, last_sync_at,
                      connected_by_user_id, created_at, updated_at)
                 values ($1, $2::social_platform, $3, $4, $5, $6, $7, $8, 'active', $9::timestamp,
                         $10, $9::timestamp, $9::timestamp)
                 on conflict (platform, platform_account_id) do update set
                     postpeer_integration_id = $7, postpeer_profile_id = $8, status = 'active',
                     last_sync_at = $9::timestamp, deleted_at = null, updated_at = $9::timestamp",
            )
            .bind(&id)
            .bind(platform)
            .bind(&platform_account_id)
            .bind(
                text("name")
                    .or_else(|| text("username"))
                    .unwrap_or_else(|| format!("{platform} account")),
            )
            .bind(text("username"))
            .bind(text("avatarUrl"))
            .bind(&integration_id)
            .bind(&profile_id)
            .bind(&now)
            .bind(connected_by)
            .execute(db)
            .await?;
            account_ids.push(id);
        }
    }
    Ok(json!({ "synced": account_ids.len(), "accountIds": account_ids }))
}

// ── publishing ──────────────────────────────────────────────────────────────

/// `PublishPostOptions`.
#[derive(Debug, Clone)]
pub struct PublishOptions {
    pub now: bool,
    pub scheduled_at: Option<String>,
    pub timezone: Option<String>,
}

/// The post as the service reads it.
#[derive(Debug, Clone)]
struct Post {
    id: String,
    content: String,
    status: String,
    target_account_ids: Value,
    media_ids: Value,
    postpeer_post_id: Option<String>,
    credits_consumed: Option<i32>,
    credit_transaction_id: Option<String>,
    platform_content: Value,
    published_at: Option<String>,
    last_publish_error: Option<String>,
}

async fn live_post(db: &PgPool, id: &str) -> Result<Option<Post>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select jsonb_build_object(
             'id', id, 'content', content, 'status', status,
             'targetAccountIds', target_account_ids, 'mediaIds', media_ids,
             'postpeerPostId', postpeer_post_id, 'creditsConsumed', credits_consumed,
             'creditTransactionId', credit_transaction_id, 'platformContent', platform_content,
             'publishedAt', to_jsonb(published_at), 'lastPublishError', last_publish_error)
         from social_posts where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| Post {
        id: str_field(&row, "id").unwrap_or_default().to_owned(),
        content: str_field(&row, "content").unwrap_or_default().to_owned(),
        status: str_field(&row, "status").unwrap_or_default().to_owned(),
        target_account_ids: row["targetAccountIds"].clone(),
        media_ids: row["mediaIds"].clone(),
        postpeer_post_id: str_field(&row, "postpeerPostId").map(str::to_owned),
        credits_consumed: row["creditsConsumed"]
            .as_i64()
            .and_then(|n| i32::try_from(n).ok()),
        credit_transaction_id: str_field(&row, "creditTransactionId").map(str::to_owned),
        platform_content: row["platformContent"].clone(),
        published_at: str_field(&row, "publishedAt").and_then(js_timestamp),
        last_publish_error: str_field(&row, "lastPublishError").map(str::to_owned),
    }))
}

/// One publish target: our account and its PostPeer integration.
#[derive(Debug, Clone)]
struct Target {
    id: String,
    platform: String,
    integration_id: String,
}

fn string_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| items.iter().map(id_text).collect())
        .unwrap_or_default()
}

/// `resolvePublishTargets`.
async fn publish_targets(db: &PgPool, post: &Post) -> Result<Vec<Target>, PublishError> {
    let ids = string_list(&post.target_account_ids);
    if ids.is_empty() {
        return Err(PublishError::Message(
            "Post has no target accounts".to_owned(),
        ));
    }
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "select id, platform::text, postpeer_integration_id from social_accounts
         where id = any($1) and deleted_at is null",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let targets: Vec<Target> = rows
        .into_iter()
        .filter_map(|(id, platform, integration)| {
            integration
                .filter(|i| !i.is_empty())
                .map(|integration_id| Target {
                    id,
                    platform,
                    integration_id,
                })
        })
        .collect();
    if targets.is_empty() {
        return Err(PublishError::Message(
            "No PostPeer-connected accounts among the post targets".to_owned(),
        ));
    }
    Ok(targets)
}

/// `loadMediaItems`: `None` for a post without media.
async fn media_items(db: &PgPool, post: &Post) -> Result<Option<Vec<Value>>, sqlx::Error> {
    let ids = string_list(&post.media_ids);
    if ids.is_empty() {
        return Ok(None);
    }
    let rows: Vec<(Option<String>, Option<String>)> =
        sqlx::query_as("select media_type::text, url from social_media where id = any($1)")
            .bind(&ids)
            .fetch_all(db)
            .await?;
    Ok(Some(
        rows.into_iter()
            .filter_map(|(kind, url)| {
                url.filter(|u| !u.is_empty()).map(
                    |url| json!({ "type": kind.unwrap_or_else(|| "image".to_owned()), "url": url }),
                )
            })
            .collect(),
    ))
}

/// `claimPublishSlot`: flip the post to `publishing` unless it already is
/// (or is published); the attempt number.
async fn claim_publish_slot(
    db: &PgPool,
    post_id: &str,
    options: &PublishOptions,
    scheduled_utc: Option<&str>,
) -> Result<i64, PublishError> {
    let schedule = (!options.now).then_some(scheduled_utc).flatten();
    let timezone = schedule
        .and(options.timezone.as_deref())
        .filter(|tz| !tz.is_empty());
    let now = now();
    let claimed: Option<Option<i32>> = sqlx::query_scalar(
        "update social_posts set status = 'publishing', last_publish_attempt_at = $2::timestamp,
             publish_attempts = publish_attempts + 1, updated_at = $2::timestamp,
             scheduled_at = case when $3::text is null then scheduled_at else $3::timestamp end,
             timezone = coalesce($4, timezone)
         where id = $1 and deleted_at is null and status not in ('publishing', 'published')
         returning publish_attempts",
    )
    .bind(post_id)
    .bind(&now)
    .bind(schedule)
    .bind(timezone)
    .fetch_optional(db)
    .await?;
    match claimed {
        None => Err(PublishError::Conflict(
            "Post is already being published or has been published".to_owned(),
        )),
        Some(attempts) => Ok(attempts.map_or(0, i64::from)),
    }
}

/// The master database and `workspaces.id` credits are metered against.
struct Metering {
    master: PgPool,
    workspace_id: String,
}

/// `resolveMetering`: `None` (unmetered) without a master database or a
/// workspace for the org.
async fn resolve_metering(ctx: &Context, org_id: Option<&str>) -> Option<Metering> {
    let master = ctx.master.clone()?;
    let org_id = org_id?;
    match resolve_internal_workspace_id(&master, org_id).await {
        Ok(Some(workspace_id)) => Some(Metering {
            master,
            workspace_id,
        }),
        Ok(None) => {
            tracing::warn!("[social-publishing] no master workspace for org {org_id} — unmetered");
            None
        }
        Err(error) => {
            tracing::warn!(%error, "[social-publishing] credit metering unavailable — unmetered");
            None
        }
    }
}

/// `chargePublishCredits`: the ledger transaction, `None` when unmetered.
async fn charge_publish_credits(
    db: &PgPool,
    metering: Option<&Metering>,
    post: &Post,
    attempt: i64,
    targets: &[Target],
    cost: i64,
    publish_now: bool,
) -> Result<Option<String>, PublishError> {
    let Some(metering) = metering else {
        return Ok(None);
    };
    let platforms: Vec<&str> = targets.iter().map(|t| t.platform.as_str()).collect();
    let entry = LedgerEntry {
        workspace_id: &metering.workspace_id,
        amount: cost,
        service_type: Some("social_post"),
        idempotency_key: Some(format!("social:{}:{attempt}", post.id)),
        reference_id: Some(&post.id),
        reference_type: Some("social_post"),
        description: Some(format!(
            "Social post to {} platform(s){}",
            targets.len(),
            if publish_now { "" } else { " (scheduled)" }
        )),
        metadata: Some(json!({
            "postId": post.id,
            "platforms": platforms,
            "scheduled": !publish_now,
        })),
    };
    let charge = match consume_credits(&metering.master, &entry).await {
        Ok(charge) => charge,
        Err(error) => {
            tracing::error!(%error, "[social-publishing] credit charge FAILED (publishing unmetered!)");
            return Ok(None);
        }
    };
    match charge {
        Consumed::Ok { transaction_id } => Ok(Some(transaction_id)),
        Consumed::Insufficient {
            current_balance,
            required,
        } => {
            sqlx::query(
                "update social_posts set status = $2::social_post_status,
                     last_publish_error = 'insufficient_credits', updated_at = $3::timestamp
                 where id = $1",
            )
            .bind(&post.id)
            .bind(&post.status)
            .bind(now())
            .execute(db)
            .await?;
            Err(PublishError::InsufficientCredits {
                current_balance,
                required,
            })
        }
    }
}

/// A refund that never fails the caller (the service logs and moves on).
async fn refund(metering: &Metering, entry: LedgerEntry<'_>, what: &str) -> bool {
    match refund_credits(&metering.master, &entry).await {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(%error, "[social-publishing] {what} FAILED");
            false
        }
    }
}

/// `buildPlatformContent`: one entry per target, matched to PostPeer's
/// results by account first, then by platform.
fn build_platform_content(targets: &[Target], results: &[Value], publish_now: bool) -> Vec<Value> {
    let mut unclaimed: Vec<Value> = results.to_vec();
    let mut matches: Vec<Option<Value>> = vec![None; targets.len()];
    for (i, target) in targets.iter().enumerate() {
        if let Some(index) = unclaimed.iter().position(|r| {
            r.get("accountId")
                .filter(|a| truthy(Some(a)))
                .is_some_and(|a| a.as_str() == Some(target.integration_id.as_str()))
        }) {
            matches[i] = Some(unclaimed.remove(index));
        }
    }
    for (i, target) in targets.iter().enumerate() {
        if matches[i].is_some() {
            continue;
        }
        if let Some(index) = unclaimed.iter().position(|r| {
            normalise_platform(&r.get("platform").map(id_text).unwrap_or_default())
                == Some(target.platform.as_str())
        }) {
            matches[i] = Some(unclaimed.remove(index));
        }
    }
    targets
        .iter()
        .zip(matches)
        .map(|(target, matched)| {
            let success = matched.as_ref().map(|m| truthy(m.get("success")));
            let status = match success {
                Some(false) => "failed",
                Some(true) if publish_now => "published",
                _ => "pending",
            };
            let mut entry = Map::new();
            entry.insert("platform".to_owned(), json!(target.platform));
            entry.insert("accountId".to_owned(), json!(target.id));
            if let Some(url) = matched.as_ref().and_then(|m| m.get("platformPostUrl")) {
                entry.insert("publishedUrl".to_owned(), url.clone());
            }
            entry.insert("status".to_owned(), json!(status));
            if let Some(error) = matched.as_ref().and_then(|m| m.get("error")) {
                entry.insert("error".to_owned(), error.clone());
            }
            if status == "published" {
                entry.insert("publishedAt".to_owned(), json!(now()));
            }
            Value::Object(entry)
        })
        .collect()
}

/// What `publishPost` answers.
#[derive(Debug, Clone)]
pub struct Published {
    pub post_id: String,
    pub postpeer_post_id: Option<Value>,
    pub status: &'static str,
    pub platform_content: Vec<Value>,
}

impl Published {
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("postId".to_owned(), json!(self.post_id));
        if let Some(id) = &self.postpeer_post_id {
            out.insert("postpeerPostId".to_owned(), id.clone());
        }
        out.insert("status".to_owned(), json!(self.status));
        out.insert("platformContent".to_owned(), json!(self.platform_content));
        Value::Object(out)
    }
}

/// `publishPost`: publish now, or schedule, through PostPeer.
#[allow(clippy::too_many_lines)] // the service's one sequence, step by step
pub async fn publish_post(
    db: &PgPool,
    ctx: &Context,
    org_id: Option<&str>,
    post_id: &str,
    options: &PublishOptions,
) -> Result<Published, PublishError> {
    let client = ctx.require_client()?;
    let post = live_post(db, post_id)
        .await?
        .ok_or_else(|| PublishError::Message(format!("Social post not found: {post_id}")))?;
    let targets = publish_targets(db, &post).await?;
    let schedule = if options.now {
        None
    } else {
        let at = options
            .scheduled_at
            .as_deref()
            .filter(|at| !at.is_empty())
            .ok_or_else(|| {
                PublishError::Message(
                    "scheduledAt is required when publishing with now: false".to_owned(),
                )
            })?;
        Some(to_postpeer_schedule(at).map_err(PublishError::Message)?)
    };
    let media = media_items(db, &post).await?;
    let attempt = claim_publish_slot(db, post_id, options, schedule.as_deref()).await?;
    let cost = i64::try_from(targets.len()).unwrap_or(0) * SOCIAL_POST_PER_PLATFORM;
    let metering = resolve_metering(ctx, org_id).await;
    let transaction = charge_publish_credits(
        db,
        metering.as_ref(),
        &post,
        attempt,
        &targets,
        cost,
        options.now,
    )
    .await?;

    // Cancel a schedule this post already has, so the old time can't fire too.
    if let Some(previous) = post.postpeer_post_id.as_deref().filter(|p| !p.is_empty())
        && post.status == "scheduled"
        && let Err(error) = client.delete_post(previous).await
    {
        tracing::warn!(%error, "[social-publishing] failed to cancel previous PostPeer post {previous}");
    }

    let mut input = Map::new();
    input.insert("content".to_owned(), json!(post.content));
    input.insert(
        "platforms".to_owned(),
        Value::Array(
            targets
                .iter()
                .map(|t| json!({ "platform": t.platform, "accountId": t.integration_id }))
                .collect(),
        ),
    );
    if let Some(media) = media {
        input.insert("mediaItems".to_owned(), Value::Array(media));
    }
    if options.now {
        input.insert("publishNow".to_owned(), json!(true));
    }
    if let Some(at) = &schedule {
        input.insert("scheduledFor".to_owned(), json!(at));
        input.insert("timezone".to_owned(), json!("UTC"));
    }
    let result = match client.create_post(&Value::Object(input)).await {
        Ok(result) => result,
        Err(error) => {
            sqlx::query(
                "update social_posts set status = 'failed', last_publish_error = $2,
                     updated_at = $3::timestamp
                 where id = $1",
            )
            .bind(post_id)
            .bind(&error.message)
            .bind(now())
            .execute(db)
            .await?;
            if let (Some(metering), Some(transaction)) = (&metering, &transaction) {
                refund(
                    metering,
                    LedgerEntry {
                        workspace_id: &metering.workspace_id,
                        amount: cost,
                        service_type: None,
                        idempotency_key: Some(format!("social_refund:{transaction}")),
                        reference_id: Some(post_id),
                        reference_type: Some("social_post"),
                        description: Some(
                            "Social publish failed before submission — refund".to_owned(),
                        ),
                        metadata: None,
                    },
                    "refund after failed submit",
                )
                .await;
            }
            return Err(PublishError::PostPeer(error));
        }
    };

    let results = result
        .get("platforms")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let platform_content = build_platform_content(&targets, &results, options.now);
    let failed = |p: &Value| p["status"] == "failed";
    let any_failed = platform_content.iter().any(failed);
    let all_failed = !platform_content.is_empty() && platform_content.iter().all(failed);
    let status = match (options.now, all_failed) {
        (false, _) => "scheduled",
        (true, true) => "failed",
        (true, false) => "published",
    };

    let mut refunded = 0;
    if options.now
        && let (Some(metering), Some(transaction)) = (&metering, &transaction)
    {
        let failed_count = platform_content.iter().filter(|p| failed(p)).count();
        if failed_count > 0 {
            let amount = i64::try_from(failed_count).unwrap_or(0) * SOCIAL_POST_PER_PLATFORM;
            if refund(
                metering,
                LedgerEntry {
                    workspace_id: &metering.workspace_id,
                    amount,
                    service_type: None,
                    idempotency_key: Some(format!("social_refund:{transaction}:immediate")),
                    reference_id: Some(post_id),
                    reference_type: Some("social_post"),
                    description: Some(format!(
                        "Social publish failed on {failed_count} platform(s) — partial refund"
                    )),
                    metadata: None,
                },
                "partial refund",
            )
            .await
            {
                refunded = amount;
            }
        }
    }

    let postpeer_post_id = result.get("postId").filter(|id| !id.is_null()).cloned();
    let last_error = if any_failed {
        platform_content
            .iter()
            .find(|p| truthy(p.get("error")))
            .and_then(|p| p.get("error"))
            .map(id_text)
    } else {
        None
    };
    let now = now();
    sqlx::query(
        "update social_posts set status = $2::social_post_status,
             postpeer_post_id = case when $3::text is null then postpeer_post_id else $3 end,
             platform_content = $4::jsonb,
             published_at = case when $2 = 'published' then $5::timestamp else null end,
             last_publish_error = $6, credits_consumed = $7::int, credit_transaction_id = $8,
             updated_at = $5::timestamp
         where id = $1",
    )
    .bind(post_id)
    .bind(status)
    .bind(postpeer_post_id.as_ref().map(id_text))
    .bind(Value::Array(platform_content.clone()))
    .bind(&now)
    .bind(last_error)
    .bind(if transaction.is_some() {
        cost - refunded
    } else {
        0
    })
    .bind(transaction.as_deref())
    .execute(db)
    .await?;

    // The delivery webhook finds the workspace through this index.
    if let Some(postpeer_id) = postpeer_post_id.as_ref().filter(|id| truthy(Some(id))) {
        index_postpeer_post(ctx, org_id, post_id, &id_text(postpeer_id)).await;
    }

    Ok(Published {
        post_id: post_id.to_owned(),
        postpeer_post_id,
        status,
        platform_content,
    })
}

/// `indexPostpeerPost`: best effort.
async fn index_postpeer_post(
    ctx: &Context,
    org_id: Option<&str>,
    post_id: &str,
    postpeer_id: &str,
) {
    let Some(master) = &ctx.master else {
        tracing::error!(
            "[social-publishing] failed to index PostPeer post {postpeer_id}: no master database"
        );
        return;
    };
    let result = sqlx::query(
        "insert into postpeer_post_index (postpeer_post_id, clerk_org_id, social_post_id)
         values ($1, $2, $3) on conflict do nothing",
    )
    .bind(postpeer_id)
    .bind(org_id)
    .bind(post_id)
    .execute(master)
    .await;
    if let Err(error) = result {
        tracing::error!(%error, "[social-publishing] failed to index PostPeer post {postpeer_id}");
    }
}

// ── cancelling ──────────────────────────────────────────────────────────────

/// `cancelPost`: delete the live PostPeer schedule first (a failure aborts),
/// then back to `draft` and refund the schedule's credits. `false` when the
/// post doesn't exist.
pub async fn cancel_post(
    db: &PgPool,
    ctx: &Context,
    org_id: Option<&str>,
    post_id: &str,
) -> Result<bool, PublishError> {
    let Some(post) = live_post(db, post_id).await? else {
        return Ok(false);
    };
    if post.status == "published" || post.status == "publishing" {
        return Err(PublishError::Conflict(
            "Cannot cancel a post that is already published or publishing".to_owned(),
        ));
    }
    if let Some(upstream) = post.postpeer_post_id.as_deref().filter(|p| !p.is_empty())
        && post.status == "scheduled"
    {
        let Some(client) = ctx.client() else {
            return Err(PublishError::CancelUpstream(format!(
                "Cannot cancel scheduled post {post_id}: PostPeer is not configured, so its live schedule ({upstream}) cannot be removed"
            )));
        };
        match client.delete_post(upstream).await {
            Ok(()) => {}
            Err(error) if error.status == 404 => {
                tracing::warn!(
                    "[social-publishing] PostPeer post {upstream} already absent — treating cancel as done"
                );
            }
            Err(error) => {
                tracing::error!(%error, "[social-publishing] failed to cancel PostPeer post {upstream} — post left scheduled");
                return Err(PublishError::CancelUpstream(
                    "Failed to remove the scheduled post from PostPeer — it is still scheduled to publish. Please try again."
                        .to_owned(),
                ));
            }
        }
    }
    let cancelled: Option<String> = sqlx::query_scalar(
        "update social_posts set status = 'draft', scheduled_at = null, postpeer_post_id = null,
             credits_consumed = 0, credit_transaction_id = null, updated_at = $3::timestamp
         where id = $1 and deleted_at is null and status not in ('published', 'publishing')
           and (case when $2::text is null then postpeer_post_id is null
                     else postpeer_post_id = $2 end)
         returning id",
    )
    .bind(post_id)
    .bind(post.postpeer_post_id.as_deref().filter(|p| !p.is_empty()))
    .bind(now())
    .fetch_optional(db)
    .await?;
    if cancelled.is_none() {
        return Err(PublishError::Conflict(
            "Cannot cancel: the post was published, is publishing, or its schedule changed. Reload and try again."
                .to_owned(),
        ));
    }
    let consumed = i64::from(post.credits_consumed.unwrap_or(0));
    if let Some(transaction) = post
        .credit_transaction_id
        .as_deref()
        .filter(|t| !t.is_empty())
        && consumed > 0
        && let Some(metering) = resolve_metering(ctx, org_id).await
    {
        refund(
            &metering,
            LedgerEntry {
                workspace_id: &metering.workspace_id,
                amount: consumed,
                service_type: None,
                idempotency_key: Some(format!("social_refund_cancel:{transaction}")),
                reference_id: Some(post_id),
                reference_type: Some("social_post"),
                description: Some("Scheduled social post cancelled — refund".to_owned()),
                metadata: None,
            },
            "cancel refund",
        )
        .await;
    }
    Ok(true)
}

/// `cancelDeliveryBeforeDelete`: stop the delivery; a post already live
/// can't be recalled, which doesn't block deleting it.
pub async fn cancel_delivery_before_delete(
    db: &PgPool,
    ctx: &Context,
    org_id: Option<&str>,
    post_id: &str,
) -> Result<(), PublishError> {
    match cancel_post(db, ctx, org_id, post_id).await {
        Ok(_) | Err(PublishError::Conflict(_)) => Ok(()),
        Err(error) => Err(error),
    }
}

// ── the delivery webhook ────────────────────────────────────────────────────

/// `resolvePostpeerPost` from the master index; `None` when it has no row
/// (or can't be read). The legacy KV mapping is the caller's.
pub async fn resolve_postpeer_post(
    ctx: &Context,
    postpeer_post_id: &str,
) -> Option<(String, String)> {
    let master = ctx.master.as_ref()?;
    let row: Result<Option<(String, String)>, sqlx::Error> = sqlx::query_as(
        "select clerk_org_id, social_post_id from postpeer_post_index
         where postpeer_post_id = $1 limit 1",
    )
    .bind(postpeer_post_id)
    .fetch_optional(master)
    .await;
    match row {
        Ok(row) => row,
        Err(error) => {
            tracing::error!(%error, "[social-publishing] postpeer post index lookup failed");
            None
        }
    }
}

/// `reconcileFromWebhook`: PostPeer's delivery results onto the post, and a
/// refund for each platform that just failed. `false` when the post is gone.
#[allow(clippy::too_many_lines)] // the service's one sequence
pub async fn reconcile_from_webhook(
    db: &PgPool,
    ctx: &Context,
    org_id: &str,
    post_id: &str,
    payload: &Value,
) -> Result<bool, PublishError> {
    let data = payload
        .get("data")
        .filter(|d| !d.is_null())
        .unwrap_or(payload);
    let event = payload
        .get("event")
        .filter(|e| !e.is_null())
        .map(id_text)
        .unwrap_or_default();
    let incoming = data
        .get("platforms")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let Some(post) = live_post(db, post_id).await? else {
        return Ok(false);
    };
    let existing = post
        .platform_content
        .as_array()
        .cloned()
        .unwrap_or_default();
    let now_iso = now();
    let mut newly_failed: Vec<String> = Vec::new();
    let merged: Vec<Value> = existing
        .into_iter()
        .map(|pc| {
            let account = pc.get("accountId").cloned().unwrap_or(Value::Null);
            let platform = pc.get("platform").cloned().unwrap_or(Value::Null);
            let found = incoming.iter().find(|p| {
                p.get("accountId").cloned().unwrap_or(Value::Null) == account
                    || normalise_platform(&p.get("platform").map(id_text).unwrap_or_default())
                        .map(|n| json!(n))
                        == Some(platform.clone())
            });
            let Some(found) = found else {
                return pc;
            };
            let success = truthy(found.get("success"));
            if !success && pc.get("status") != Some(&json!("failed")) {
                newly_failed.push(account.as_str().unwrap_or_default().to_owned());
            }
            let mut next = object(&pc);
            let published_url = found
                .get("platformPostUrl")
                .filter(|v| !v.is_null())
                .or_else(|| pc.get("publishedUrl"));
            set_or_remove(&mut next, "publishedUrl", published_url);
            next.insert(
                "status".to_owned(),
                json!(if success { "published" } else { "failed" }),
            );
            let error = found
                .get("error")
                .filter(|v| !v.is_null())
                .or_else(|| pc.get("error"));
            set_or_remove(&mut next, "error", error);
            let published_at = if success {
                pc.get("publishedAt")
                    .filter(|v| !v.is_null())
                    .cloned()
                    .or_else(|| Some(json!(now_iso)))
            } else {
                pc.get("publishedAt").cloned()
            };
            set_or_remove(&mut next, "publishedAt", published_at.as_ref());
            Value::Object(next)
        })
        .collect();

    let failed = event.contains("failed") || merged.iter().any(|p| p["status"] == "failed");
    let published = event.contains("published")
        || (!merged.is_empty() && merged.iter().all(|p| p["status"] == "published"));
    let next_status = if published && !failed {
        "published".to_owned()
    } else if failed && !published {
        "failed".to_owned()
    } else {
        post.status.clone()
    };

    let mut consumed = i64::from(post.credits_consumed.unwrap_or(0));
    if let Some(transaction) = post
        .credit_transaction_id
        .as_deref()
        .filter(|t| !t.is_empty())
        && consumed > 0
        && !newly_failed.is_empty()
        && let Some(metering) = resolve_metering(ctx, Some(org_id)).await
    {
        for account in &newly_failed {
            let amount = SOCIAL_POST_PER_PLATFORM.min(consumed);
            if amount <= 0 {
                break;
            }
            if refund(
                &metering,
                LedgerEntry {
                    workspace_id: &metering.workspace_id,
                    amount,
                    service_type: None,
                    idempotency_key: Some(format!("social_refund:{transaction}:{account}")),
                    reference_id: Some(post_id),
                    reference_type: Some("social_post"),
                    description: Some("Social platform delivery failed — refund".to_owned()),
                    metadata: Some(json!({ "accountId": account })),
                },
                "webhook failure refund",
            )
            .await
            {
                consumed -= amount;
            }
        }
    }

    let published_at = if next_status == "published" {
        post.published_at.clone().or_else(|| Some(now_iso.clone()))
    } else {
        post.published_at.clone()
    };
    let last_error = if failed {
        merged
            .iter()
            .find(|p| truthy(p.get("error")))
            .and_then(|p| p.get("error"))
            .map(id_text)
            .or_else(|| post.last_publish_error.clone())
    } else {
        post.last_publish_error.clone()
    };
    sqlx::query(
        "update social_posts set status = $2::social_post_status, platform_content = $3::jsonb,
             published_at = $4::timestamp, last_publish_error = $5, credits_consumed = $6::int,
             updated_at = $7::timestamp
         where id = $1",
    )
    .bind(post_id)
    .bind(&next_status)
    .bind(Value::Array(merged))
    .bind(published_at)
    .bind(last_error)
    .bind(consumed)
    .bind(&now_iso)
    .execute(db)
    .await?;
    Ok(true)
}

/// `{ ...pc, key: value }`: `undefined` leaves the key out.
fn set_or_remove(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    match value {
        Some(value) => {
            map.insert(key.to_owned(), value.clone());
        }
        None => {
            map.remove(key);
        }
    }
}

// ── analytics ───────────────────────────────────────────────────────────────

/// `syncAnalytics`: PostPeer's metrics for a published post, one
/// `lifetime` snapshot per account it can attribute.
pub async fn sync_analytics(
    db: &PgPool,
    ctx: &Context,
    post_id: &str,
) -> Result<Value, PublishError> {
    let client = ctx.require_client()?;
    let post: Option<(String, Option<String>, Value)> = sqlx::query_as(
        "select id, postpeer_post_id, coalesce(target_account_ids, 'null'::jsonb)
         from social_posts where id = $1 and deleted_at is null limit 1",
    )
    .bind(post_id)
    .fetch_optional(db)
    .await?;
    let Some((post_id, Some(postpeer_id), targets)) = post else {
        return Ok(json!({ "snapshots": 0 }));
    };
    if postpeer_id.is_empty() {
        return Ok(json!({ "snapshots": 0 }));
    }
    let ids = string_list(&targets);
    let accounts: Vec<(String, Option<String>)> = if ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("select id, postpeer_integration_id from social_accounts where id = any($1)")
            .bind(&ids)
            .fetch_all(db)
            .await?
    };
    let by_integration = |integration: &str| {
        accounts
            .iter()
            .rev()
            .find(|(_, i)| i.as_deref() == Some(integration))
            .map(|(id, _)| id.clone())
    };
    let fallback = (accounts.len() == 1).then(|| accounts[0].0.clone());
    let metrics = client.get_analytics(&postpeer_id).await?;
    let now = now();
    let mut rows: Vec<Value> = Vec::new();
    for metric in metrics {
        let account = metric
            .get("accountId")
            .filter(|a| truthy(Some(a)))
            .and_then(|a| by_integration(&id_text(a)))
            .filter(|a| !a.is_empty())
            .or_else(|| fallback.clone());
        let Some(account) = account else {
            continue;
        };
        let number = |key: &str| metric.get(key).filter(|v| !nullish(Some(v))).cloned();
        let zero = || json!(0);
        let sum = ["likes", "comments", "shares", "saves"]
            .iter()
            .map(|k| number(k).and_then(|v| v.as_f64()).unwrap_or(0.0))
            .sum::<f64>();
        let engagement = number("engagement").unwrap_or_else(|| js_number(sum));
        let impressions = number("impressions").unwrap_or_else(zero);
        let impressions_n = impressions.as_f64().unwrap_or(f64::NAN);
        let rate = if impressions_n > 0.0 {
            js_number(engagement.as_f64().unwrap_or(f64::NAN) / impressions_n * 100.0)
        } else {
            zero()
        };
        rows.push(json!({
            "id": generate_id("san"),
            "post_id": post_id,
            "account_id": account,
            "platform_post_id": metric.get("postId").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!(postpeer_id)),
            "snapshot_period": "lifetime",
            "snapshot_at": now,
            "impressions": impressions,
            "reach": number("reach").unwrap_or_else(zero),
            "likes": number("likes").unwrap_or_else(zero),
            "comments": number("comments").unwrap_or_else(zero),
            "shares": number("shares").unwrap_or_else(zero),
            "saves": number("saves").unwrap_or_else(zero),
            "clicks": number("clicks").unwrap_or_else(zero),
            "video_views": number("views").unwrap_or_else(zero),
            "total_engagement": engagement,
            "engagement_rate": rate,
            "raw_data": metric,
            "created_at": now,
            "updated_at": now,
        }));
    }
    if !rows.is_empty() {
        sqlx::query(
            "insert into social_analytics
                 (id, post_id, account_id, platform_post_id, snapshot_period, snapshot_at,
                  impressions, reach, likes, comments, shares, saves, clicks, video_views,
                  total_engagement, engagement_rate, raw_data, created_at, updated_at)
             select r.id, r.post_id, r.account_id, r.platform_post_id, r.snapshot_period,
                    r.snapshot_at, r.impressions, r.reach, r.likes, r.comments, r.shares, r.saves,
                    r.clicks, r.video_views, r.total_engagement, r.engagement_rate, r.raw_data,
                    r.created_at, r.updated_at
             from jsonb_populate_recordset(null::social_analytics, $1::jsonb) r",
        )
        .bind(Value::Array(rows.clone()))
        .execute(db)
        .await?;
    }
    Ok(json!({ "snapshots": rows.len() }))
}

/// A number as JavaScript writes it into JSON: whole values as integers.
fn js_number(number: f64) -> Value {
    weldsuite_core_domain::js::number_value(number)
}
