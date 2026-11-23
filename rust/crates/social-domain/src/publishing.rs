//! WeldSocial's publishing through PostPeer (`@weldsuite/social-publishing`'s
//! `publishing.ts`): the workspace's PostPeer profile, connecting and syncing
//! channels, publishing and scheduling (the atomic claim, credit metering,
//! partial-failure refunds), cancelling, the delivery webhook's
//! reconciliation and the analytics sync.
//!
//! Every statement and every PostPeer call is the TypeScript service's, in
//! its order; the conformance suite compares the calls and the answers.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveEnum, ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, QueryFilter,
    QuerySelect, RuntimeErr,
};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm, orm_error, utc_now, utc_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_ports::OutboundHttp;
use weldsuite_schema::master::postpeer_post_index;
use weldsuite_schema::tenant::enums::{
    SocialAccountStatus, SocialMediaType, SocialPlatform, SocialPostStatus,
};
use weldsuite_schema::tenant::{social_accounts, social_media, social_posts, workspace_settings};

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
    Database(DbErr),
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
            // The driver's own message, as before the ORM.
            Self::Database(
                DbErr::Conn(RuntimeErr::SqlxError(error))
                | DbErr::Exec(RuntimeErr::SqlxError(error))
                | DbErr::Query(RuntimeErr::SqlxError(error)),
            ) => error.fmt(f),
            Self::Database(error) => error.fmt(f),
        }
    }
}

impl From<DbErr> for PublishError {
    fn from(error: DbErr) -> Self {
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

/// `$n::timestamp` of a `toISOString()`: Postgres reads its date and time
/// and ignores the zone. A text Postgres can't read is the failed cast.
fn timestamp_of(iso: &str) -> Result<PrimitiveDateTime, DbErr> {
    let at = OffsetDateTime::parse(iso, &time::format_description::well_known::Rfc3339)
        .map_err(|_| {
            DbErr::Type(format!(
                "invalid input syntax for type timestamp: \"{iso}\""
            ))
        })?;
    Ok(PrimitiveDateTime::new(at.date(), at.time()))
}

/// `$n::social_post_status` of a status the service read or chose.
fn post_status(status: &str) -> Result<SocialPostStatus, DbErr> {
    SocialPostStatus::try_from_value(&status.to_owned())
}

/// `$n::int` of a credit count.
fn int_of(value: i64) -> Result<i32, DbErr> {
    i32::try_from(value).map_err(|_| DbErr::Type("integer out of range".to_owned()))
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
    let settings: Option<Option<Value>> = workspace_settings::Entity::find()
        .select_only()
        .column(workspace_settings::Column::CustomSettings)
        .filter(workspace_settings::Column::Id.eq(workspace_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    let custom = settings
        .as_ref()
        .and_then(Option::as_ref)
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
    // `new Date()` into the `timestamptz` columns.
    let now = utc_now().assume_utc();
    if settings.is_some() {
        workspace_settings::Entity::update_many()
            .col_expr(
                workspace_settings::Column::CustomSettings,
                Expr::value(Value::Object(custom)),
            )
            .col_expr(workspace_settings::Column::UpdatedAt, Expr::value(now))
            .filter(workspace_settings::Column::Id.eq(workspace_id))
            .exec(&orm(db))
            .await?;
    } else {
        workspace_settings::Entity::insert(workspace_settings::ActiveModel {
            id: Set(workspace_id.to_owned()),
            custom_settings: Set(Some(Value::Object(custom))),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        })
        .exec_without_returning(&orm(db))
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
    let now = utc_now();
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
        let platform_value = SocialPlatform::try_from_value(&platform.to_owned())?;
        let existing: Option<(String, String, Option<String>, Option<String>)> =
            social_accounts::Entity::find()
                .select_only()
                .columns([
                    social_accounts::Column::Id,
                    social_accounts::Column::Name,
                    social_accounts::Column::Username,
                    social_accounts::Column::AvatarUrl,
                ])
                .filter(
                    Condition::any()
                        .add(social_accounts::Column::PostpeerIntegrationId.eq(&integration_id))
                        .add(
                            Condition::all()
                                .add(social_accounts::Column::Platform.eq(platform_value))
                                .add(
                                    social_accounts::Column::PlatformAccountId
                                        .eq(&platform_account_id),
                                ),
                        ),
                )
                .into_tuple()
                .one(&orm(db))
                .await?;
        if let Some((id, name, username, avatar_url)) = existing {
            social_accounts::Entity::update_many()
                .set(social_accounts::ActiveModel {
                    name: Set(text("name").or_else(|| text("username")).unwrap_or(name)),
                    username: Set(text("username").or(username)),
                    avatar_url: Set(text("avatarUrl").or(avatar_url)),
                    postpeer_integration_id: Set(Some(integration_id.clone())),
                    postpeer_profile_id: Set(Some(profile_id.clone())),
                    status: Set(SocialAccountStatus::Active),
                    last_sync_at: Set(Some(now)),
                    deleted_at: Set(None),
                    updated_at: Set(now),
                    ..Default::default()
                })
                .filter(social_accounts::Column::Id.eq(&id))
                .exec(&orm(db))
                .await?;
            account_ids.push(id);
        } else {
            let id = generate_id("sac");
            // On a clash the row takes the same integration, profile, status
            // and times, and is live again: `excluded` holds exactly those.
            social_accounts::Entity::insert(social_accounts::ActiveModel {
                id: Set(id.clone()),
                platform: Set(platform_value),
                platform_account_id: Set(platform_account_id.clone()),
                name: Set(text("name")
                    .or_else(|| text("username"))
                    .unwrap_or_else(|| format!("{platform} account"))),
                username: Set(text("username")),
                avatar_url: Set(text("avatarUrl")),
                postpeer_integration_id: Set(Some(integration_id.clone())),
                postpeer_profile_id: Set(Some(profile_id.clone())),
                status: Set(SocialAccountStatus::Active),
                last_sync_at: Set(Some(now)),
                connected_by_user_id: Set(connected_by.to_owned()),
                created_at: Set(now),
                updated_at: Set(now),
                ..Default::default()
            })
            .on_conflict(
                OnConflict::columns([
                    social_accounts::Column::Platform,
                    social_accounts::Column::PlatformAccountId,
                ])
                .update_columns([
                    social_accounts::Column::PostpeerIntegrationId,
                    social_accounts::Column::PostpeerProfileId,
                    social_accounts::Column::Status,
                    social_accounts::Column::LastSyncAt,
                    social_accounts::Column::DeletedAt,
                    social_accounts::Column::UpdatedAt,
                ])
                .to_owned(),
            )
            .exec_without_returning(&orm(db))
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

/// The columns of a post the service reads.
#[derive(FromQueryResult)]
struct PostRow {
    id: String,
    content: String,
    status: SocialPostStatus,
    target_account_ids: Value,
    media_ids: Option<Value>,
    postpeer_post_id: Option<String>,
    credits_consumed: Option<i32>,
    credit_transaction_id: Option<String>,
    platform_content: Option<Value>,
    published_at: Option<PrimitiveDateTime>,
    last_publish_error: Option<String>,
}

async fn live_post(db: &PgPool, id: &str) -> Result<Option<Post>, DbErr> {
    let row = social_posts::Entity::find()
        .select_only()
        .columns([
            social_posts::Column::Id,
            social_posts::Column::Content,
            social_posts::Column::Status,
            social_posts::Column::TargetAccountIds,
            social_posts::Column::MediaIds,
            social_posts::Column::PostpeerPostId,
            social_posts::Column::CreditsConsumed,
            social_posts::Column::CreditTransactionId,
            social_posts::Column::PlatformContent,
            social_posts::Column::PublishedAt,
            social_posts::Column::LastPublishError,
        ])
        .filter(social_posts::Column::Id.eq(id))
        .filter(social_posts::Column::DeletedAt.is_null())
        .into_model::<PostRow>()
        .one(&orm(db))
        .await?;
    Ok(row.map(|row| Post {
        id: row.id,
        content: row.content,
        status: row.status.to_value(),
        target_account_ids: row.target_account_ids,
        media_ids: row.media_ids.unwrap_or(Value::Null),
        postpeer_post_id: row.postpeer_post_id,
        credits_consumed: row.credits_consumed,
        credit_transaction_id: row.credit_transaction_id,
        platform_content: row.platform_content.unwrap_or(Value::Null),
        published_at: row.published_at.map(|at| iso_timestamp(at.assume_utc())),
        last_publish_error: row.last_publish_error,
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
    let rows: Vec<(String, SocialPlatform, Option<String>)> = social_accounts::Entity::find()
        .select_only()
        .columns([
            social_accounts::Column::Id,
            social_accounts::Column::Platform,
            social_accounts::Column::PostpeerIntegrationId,
        ])
        .filter(social_accounts::Column::Id.is_in(ids))
        .filter(social_accounts::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    let targets: Vec<Target> = rows
        .into_iter()
        .filter_map(|(id, platform, integration)| {
            integration
                .filter(|i| !i.is_empty())
                .map(|integration_id| Target {
                    id,
                    platform: platform.to_value(),
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
async fn media_items(db: &PgPool, post: &Post) -> Result<Option<Vec<Value>>, DbErr> {
    let ids = string_list(&post.media_ids);
    if ids.is_empty() {
        return Ok(None);
    }
    let rows: Vec<(String, Option<String>)> = social_media::Entity::find()
        .select_only()
        .columns([social_media::Column::MediaType, social_media::Column::Url])
        .filter(social_media::Column::Id.is_in(ids))
        .into_tuple::<(SocialMediaType, Option<String>)>()
        .all(&orm(db))
        .await?
        .into_iter()
        .map(|(kind, url)| (kind.to_value(), url))
        .collect();
    Ok(Some(
        rows.into_iter()
            .filter_map(|(kind, url)| {
                url.filter(|u| !u.is_empty())
                    .map(|url| json!({ "type": kind, "url": url }))
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
    let now = utc_now();
    // One statement, so two publishes can't both claim the post.
    let mut claim = social_posts::Entity::update_many()
        .col_expr(
            social_posts::Column::Status,
            social_posts::Column::Status.save_as(Expr::val(SocialPostStatus::Publishing)),
        )
        .col_expr(social_posts::Column::LastPublishAttemptAt, Expr::value(now))
        .col_expr(
            social_posts::Column::PublishAttempts,
            sea_orm::ExprTrait::add(Expr::col(social_posts::Column::PublishAttempts), 1),
        )
        .col_expr(social_posts::Column::UpdatedAt, Expr::value(now));
    if let Some(at) = schedule {
        claim = claim.col_expr(social_posts::Column::ScheduledAt, Expr::value(timestamp_of(at)?));
    }
    if let Some(timezone) = timezone {
        claim = claim.col_expr(social_posts::Column::Timezone, Expr::value(timezone));
    }
    let claimed: Option<Option<i32>> = claim
        .filter(social_posts::Column::Id.eq(post_id))
        .filter(social_posts::Column::DeletedAt.is_null())
        .filter(
            social_posts::Column::Status
                .is_not_in([SocialPostStatus::Publishing, SocialPostStatus::Published]),
        )
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next()
        .map(|post| post.publish_attempts);
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
            social_posts::Entity::update_many()
                .col_expr(
                    social_posts::Column::Status,
                    social_posts::Column::Status.save_as(Expr::val(post_status(&post.status)?)),
                )
                .col_expr(
                    social_posts::Column::LastPublishError,
                    Expr::value("insufficient_credits"),
                )
                .col_expr(social_posts::Column::UpdatedAt, Expr::value(utc_now()))
                .filter(social_posts::Column::Id.eq(&post.id))
                .exec(&orm(db))
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
            social_posts::Entity::update_many()
                .col_expr(
                    social_posts::Column::Status,
                    social_posts::Column::Status.save_as(Expr::val(SocialPostStatus::Failed)),
                )
                .col_expr(
                    social_posts::Column::LastPublishError,
                    Expr::value(error.message.clone()),
                )
                .col_expr(social_posts::Column::UpdatedAt, Expr::value(utc_now()))
                .filter(social_posts::Column::Id.eq(post_id))
                .exec(&orm(db))
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
    let now = utc_now();
    let mut done = social_posts::Entity::update_many().col_expr(
        social_posts::Column::Status,
        social_posts::Column::Status.save_as(Expr::val(post_status(status)?)),
    );
    if let Some(postpeer_id) = postpeer_post_id.as_ref().map(id_text) {
        done = done.col_expr(social_posts::Column::PostpeerPostId, Expr::value(postpeer_id));
    }
    done.col_expr(
        social_posts::Column::PlatformContent,
        Expr::value(Value::Array(platform_content.clone())),
    )
    .col_expr(
        social_posts::Column::PublishedAt,
        Expr::value((status == "published").then_some(now)),
    )
    .col_expr(social_posts::Column::LastPublishError, Expr::value(last_error))
    .col_expr(
        social_posts::Column::CreditsConsumed,
        Expr::value(int_of(if transaction.is_some() {
            cost - refunded
        } else {
            0
        })?),
    )
    .col_expr(
        social_posts::Column::CreditTransactionId,
        Expr::value(transaction.clone()),
    )
    .col_expr(social_posts::Column::UpdatedAt, Expr::value(now))
    .filter(social_posts::Column::Id.eq(post_id))
    .exec(&orm(db))
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
    let result = postpeer_post_index::Entity::insert(postpeer_post_index::ActiveModel {
        postpeer_post_id: Set(postpeer_id.to_owned()),
        // Without an org the column is left out, and the insert fails on
        // its not-null constraint as the `null` it was given did.
        clerk_org_id: org_id.map_or(NotSet, |org| Set(org.to_owned())),
        social_post_id: Set(post_id.to_owned()),
        ..Default::default()
    })
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(&orm(master))
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
    // Only while the post still has the schedule it was read with.
    let same_schedule = match post.postpeer_post_id.as_deref().filter(|p| !p.is_empty()) {
        Some(upstream) => social_posts::Column::PostpeerPostId.eq(upstream),
        None => social_posts::Column::PostpeerPostId.is_null(),
    };
    let cancelled = social_posts::Entity::update_many()
        .col_expr(
            social_posts::Column::Status,
            social_posts::Column::Status.save_as(Expr::val(SocialPostStatus::Draft)),
        )
        .col_expr(
            social_posts::Column::ScheduledAt,
            Expr::value(Option::<PrimitiveDateTime>::None),
        )
        .col_expr(
            social_posts::Column::PostpeerPostId,
            Expr::value(Option::<String>::None),
        )
        .col_expr(social_posts::Column::CreditsConsumed, Expr::value(0))
        .col_expr(
            social_posts::Column::CreditTransactionId,
            Expr::value(Option::<String>::None),
        )
        .col_expr(social_posts::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(social_posts::Column::Id.eq(post_id))
        .filter(social_posts::Column::DeletedAt.is_null())
        .filter(
            social_posts::Column::Status
                .is_not_in([SocialPostStatus::Published, SocialPostStatus::Publishing]),
        )
        .filter(same_schedule)
        .exec(&orm(db))
        .await?;
    if cancelled.rows_affected == 0 {
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
    let row: Result<Option<(String, String)>, DbErr> = postpeer_post_index::Entity::find()
        .select_only()
        .columns([
            postpeer_post_index::Column::ClerkOrgId,
            postpeer_post_index::Column::SocialPostId,
        ])
        .filter(postpeer_post_index::Column::PostpeerPostId.eq(postpeer_post_id))
        .into_tuple()
        .one(&orm(master))
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
    let now_at = OffsetDateTime::now_utc();
    let now_iso = iso_timestamp(now_at);
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
    let published_at = published_at.as_deref().map(timestamp_of).transpose()?;
    social_posts::Entity::update_many()
        .col_expr(
            social_posts::Column::Status,
            social_posts::Column::Status.save_as(Expr::val(post_status(&next_status)?)),
        )
        .col_expr(
            social_posts::Column::PlatformContent,
            Expr::value(Value::Array(merged)),
        )
        .col_expr(social_posts::Column::PublishedAt, Expr::value(published_at))
        .col_expr(social_posts::Column::LastPublishError, Expr::value(last_error))
        .col_expr(social_posts::Column::CreditsConsumed, Expr::value(int_of(consumed)?))
        .col_expr(social_posts::Column::UpdatedAt, Expr::value(utc_timestamp(now_at)))
        .filter(social_posts::Column::Id.eq(post_id))
        .exec(&orm(db))
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
    let post: Option<(String, Option<String>, Value)> = social_posts::Entity::find()
        .select_only()
        .columns([
            social_posts::Column::Id,
            social_posts::Column::PostpeerPostId,
            social_posts::Column::TargetAccountIds,
        ])
        .filter(social_posts::Column::Id.eq(post_id))
        .filter(social_posts::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
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
        social_accounts::Entity::find()
            .select_only()
            .columns([
                social_accounts::Column::Id,
                social_accounts::Column::PostpeerIntegrationId,
            ])
            .filter(social_accounts::Column::Id.is_in(ids))
            .into_tuple()
            .all(&orm(db))
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
        insert_snapshots(db, &rows).await?;
    }
    Ok(json!({ "snapshots": rows.len() }))
}

/// The snapshots in one statement, each value converted by Postgres to its
/// column's type as `jsonb_populate_recordset` reads PostPeer's metrics
/// (a count PostPeer sends as text, a rate as a float).
#[allow(
    clippy::disallowed_methods,
    reason = "a bulk INSERT … SELECT from jsonb_populate_recordset: Postgres converts PostPeer's raw metric values to the columns' types, all rows in one statement"
)]
async fn insert_snapshots(db: &PgPool, rows: &[Value]) -> Result<(), DbErr> {
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
    .bind(Value::Array(rows.to_vec()))
    .execute(db)
    .await
    .map_err(orm_error)?;
    Ok(())
}

/// A number as JavaScript writes it into JSON: whole values as integers.
fn js_number(number: f64) -> Value {
    weldsuite_core_domain::js::number_value(number)
}
