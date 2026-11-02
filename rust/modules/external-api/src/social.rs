//! WeldSocial's objects: `/v1/social-accounts`, `/v1/social-campaigns`,
//! `/v1/social-analytics` and `/v1/social-media` (`routes/v1/<object>`).
//! Every write strips the server-owned keys a passthrough body may carry
//! (`stripServerFields`).

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    SOCIAL_ACCOUNT_CREATED, SOCIAL_ACCOUNT_DELETED, SOCIAL_ACCOUNT_UPDATED,
    SOCIAL_CAMPAIGN_CREATED, SOCIAL_CAMPAIGN_DELETED, SOCIAL_CAMPAIGN_UPDATED,
    SOCIAL_MEDIA_CREATED, SOCIAL_MEDIA_DELETED, SOCIAL_MEDIA_UPDATED,
};
use weldsuite_kit::id::generate_id;

use crate::ExternalApiState;
use crate::crud::{
    Answer, Caller, Fail, created, dates, get_live, no_content, now, ok, page, pick,
    table_list_sql, text, with_updated,
};
use crate::schemas::{
    LIST_SOCIAL_ACCOUNTS, LIST_SOCIAL_ANALYTICS, LIST_SOCIAL_CAMPAIGNS, LIST_SOCIAL_MEDIA,
};
use crate::schemas_gen::{
    CREATE_SOCIAL_ACCOUNT, CREATE_SOCIAL_ANALYTICS, CREATE_SOCIAL_CAMPAIGN, CREATE_SOCIAL_MEDIA,
    UPDATE_SOCIAL_ACCOUNT, UPDATE_SOCIAL_ANALYTICS, UPDATE_SOCIAL_CAMPAIGN, UPDATE_SOCIAL_MEDIA,
};
use crate::session::not_found;
use crate::simple::{self, Dates, F, Simple, Stats, scoped};
use crate::tables_gen::{SOCIAL_ACCOUNTS, SOCIAL_ANALYTICS, SOCIAL_CAMPAIGNS, SOCIAL_MEDIA};
use crate::zod;

type S = State<ExternalApiState>;

/// Social's routes (`social-posts` is not served here yet).
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    [&ACCOUNTS, &CAMPAIGNS, &ANALYTICS]
        .into_iter()
        .fold(router, simple::mount)
        .route(
            "/social-media",
            scoped(get(list_media), "social_posts:read")
                .merge(scoped(post(create_media), "social_posts:write")),
        )
        .route(
            "/social-media/{id}",
            scoped(get(get_media), "social_posts:read").merge(scoped(
                patch(update_media).delete(delete_media),
                "social_posts:write",
            )),
        )
}

/// `stripServerFields(body)`.
fn strip_server_fields(values: &mut Map<String, Value>) {
    for key in [
        "id",
        "createdAt",
        "updatedAt",
        "deletedAt",
        "connectedByUserId",
        "createdByUserId",
        "uploadedByUserId",
    ] {
        values.remove(key);
    }
}

/// `a ?? b` over the values.
fn coalesce(values: &Map<String, Value>, keys: &[&str], fallback: Value) -> Value {
    keys.iter()
        .find_map(|key| values.get(*key).filter(|v| !v.is_null()).cloned())
        .unwrap_or(fallback)
}

fn account_values(
    caller: &Caller,
    values: &mut Map<String, Value>,
    create: bool,
) -> Result<Dates, Fail> {
    strip_server_fields(values);
    if create {
        let platform = coalesce(values, &["platform"], json!("twitter"));
        let account = coalesce(values, &["platformAccountId"], json!(caller.session.key_id));
        let name = coalesce(
            values,
            &["name", "displayName", "username"],
            json!("Unknown"),
        );
        values.insert("platform".into(), platform);
        values.insert("platformAccountId".into(), account);
        values.insert("name".into(), name);
        values.insert("connectedByUserId".into(), json!(caller.session.actor()));
    }
    Ok(&[])
}

static ACCOUNTS: Simple = Simple {
    path: "/social-accounts",
    scope: "social_accounts",
    table: &SOCIAL_ACCOUNTS,
    label: "SocialAccount",
    prefix: "soca",
    list: &LIST_SOCIAL_ACCOUNTS,
    create: &CREATE_SOCIAL_ACCOUNT,
    update: &UPDATE_SOCIAL_ACCOUNT,
    sql: table_list_sql!(
        social_accounts,
        "t.deleted_at is null \
         and ($3->>'platform' is null or t.platform = ($3->>'platform')::social_platform) \
         and ($3->>'status' is null or t.status = ($3->>'status')::social_account_status)"
    ),
    filters: &[F::Eq("platform"), F::Eq("status")],
    dates: &[],
    events: Some([
        SOCIAL_ACCOUNT_CREATED,
        SOCIAL_ACCOUNT_UPDATED,
        SOCIAL_ACCOUNT_DELETED,
    ]),
    data: &["platform", "name", "status"],
    deleted_data: Some(&["platform", "name"]),
    prepare: Some(account_values),
    stats: Stats::None,
    touch: true,
};

fn campaign_values(
    caller: &Caller,
    values: &mut Map<String, Value>,
    create: bool,
) -> Result<Dates, Fail> {
    strip_server_fields(values);
    if create {
        values.insert("createdByUserId".into(), json!(caller.session.actor()));
    }
    Ok(&[])
}

static CAMPAIGNS: Simple = Simple {
    path: "/social-campaigns",
    scope: "social_campaigns",
    table: &SOCIAL_CAMPAIGNS,
    label: "SocialCampaign",
    prefix: "socc",
    list: &LIST_SOCIAL_CAMPAIGNS,
    create: &CREATE_SOCIAL_CAMPAIGN,
    update: &UPDATE_SOCIAL_CAMPAIGN,
    sql: table_list_sql!(
        social_campaigns,
        "t.deleted_at is null and ($3->>'status' is null or t.status = ($3->>'status')::social_campaign_status)"
    ),
    filters: &[F::Eq("status")],
    dates: &[],
    events: Some([
        SOCIAL_CAMPAIGN_CREATED,
        SOCIAL_CAMPAIGN_UPDATED,
        SOCIAL_CAMPAIGN_DELETED,
    ]),
    data: &["name", "status"],
    deleted_data: Some(&["name"]),
    prepare: Some(campaign_values),
    stats: Stats::None,
    touch: true,
};

/// social-analytics: a snapshot is taken now unless it says when.
fn analytics_values(
    _: &Caller,
    values: &mut Map<String, Value>,
    create: bool,
) -> Result<Dates, Fail> {
    strip_server_fields(values);
    if create && matches!(values.get("snapshotAt"), Some(Value::Null) | None) {
        values.insert("snapshotAt".into(), json!(now()));
        return Ok(&["snapshotAt"]);
    }
    Ok(&[])
}

static ANALYTICS: Simple = Simple {
    path: "/social-analytics",
    scope: "social_analytics",
    table: &SOCIAL_ANALYTICS,
    label: "SocialAnalytics",
    prefix: "soan",
    list: &LIST_SOCIAL_ANALYTICS,
    create: &CREATE_SOCIAL_ANALYTICS,
    update: &UPDATE_SOCIAL_ANALYTICS,
    sql: table_list_sql!(
        social_analytics,
        "($3->>'postId' is null or t.post_id = $3->>'postId') \
         and ($3->>'accountId' is null or t.account_id = $3->>'accountId')"
    ),
    filters: &[F::Eq("postId"), F::Eq("accountId")],
    dates: &[],
    events: None,
    data: &[],
    deleted_data: None,
    prepare: Some(analytics_values),
    stats: Stats::None,
    touch: true,
};

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

const MEDIA_LIST: (&str, &str) = table_list_sql!(
    social_media,
    "t.deleted_at is null \
     and ($3->>'mediaType' is null or t.media_type = ($3->>'mediaType')::social_media_type) \
     and ($3->>'status' is null or t.status = ($3->>'status')::social_media_status)"
);

/// `guessMime(fileName, mediaType)`.
fn guess_mime(file_name: &str, media_type: &str) -> &'static str {
    let lower = file_name.to_lowercase();
    let ends = |suffix: &str| lower.ends_with(suffix);
    if ends(".png") {
        "image/png"
    } else if ends(".jpg") || ends(".jpeg") {
        "image/jpeg"
    } else if ends(".gif") {
        "image/gif"
    } else if ends(".webp") {
        "image/webp"
    } else if ends(".mp4") {
        "video/mp4"
    } else if ends(".webm") {
        "video/webm"
    } else if media_type == "video" {
        "video/mp4"
    } else if media_type == "gif" {
        "image/gif"
    } else {
        "image/png"
    }
}

/// `guessMediaType(fileName, explicit)`.
fn guess_media_type(file_name: &str, explicit: Option<&str>) -> &'static str {
    match explicit {
        Some("image") => return "image",
        Some("video") => return "video",
        Some("gif") => return "gif",
        _ => {}
    }
    let lower = file_name.to_lowercase();
    if lower.ends_with(".mp4") || lower.ends_with(".webm") || lower.ends_with(".mov") {
        "video"
    } else if lower.ends_with(".gif") {
        "gif"
    } else {
        "image"
    }
}

const MEDIA_EVENT: [&str; 3] = ["fileName", "mediaType", "status"];

async fn list_media(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_SOCIAL_MEDIA, raw.as_deref())?;
    let filters = json!({ "mediaType": text(&q, "mediaType"), "status": text(&q, "status") });
    page(&caller.db, MEDIA_LIST, &SOCIAL_MEDIA, &q, filters).await
}

async fn get_media(caller: Caller, Path(id): Path<String>) -> Answer {
    get_live(&caller.db, &SOCIAL_MEDIA, "SocialMedia", &id).await
}

/// A non-empty string field.
fn non_empty<'a>(body: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    body.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

async fn create_media(State(state): S, caller: Caller, headers: HeaderMap, body: Bytes) -> Answer {
    let parsed = zod::json(&CREATE_SOCIAL_MEDIA, &headers, &body)?;
    let body = &parsed.body;
    let id = generate_id("smed");
    let file_name = match body.get("fileName") {
        Some(Value::Null) | None => "asset".to_owned(),
        Some(Value::String(name)) => name.clone(),
        Some(other) => other.to_string(),
    };
    let url = body.get("url").and_then(Value::as_str);
    let media_type = guess_media_type(&file_name, body.get("mediaType").and_then(Value::as_str));
    let mime = non_empty(body, "mimeType")
        .or_else(|| non_empty(body, "contentType"))
        .map_or_else(
            || guess_mime(&file_name, media_type).to_owned(),
            str::to_owned,
        );
    let size = match (body.get("fileSize"), body.get("size")) {
        (Some(Value::Number(n)), _) | (_, Some(Value::Number(n))) => Value::Number(n.clone()),
        _ => json!(0),
    };
    let storage_path = non_empty(body, "storagePath").map_or_else(
        || match url {
            Some(url) => format!("url:{url}"),
            None => format!("social-media/{id}/{file_name}"),
        },
        str::to_owned,
    );
    let mut values = body.clone();
    strip_server_fields(&mut values);
    let stamp = now();
    values.insert("id".into(), json!(id));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    values.insert("fileName".into(), json!(file_name));
    values.insert(
        "originalName".into(),
        json!(non_empty(body, "originalName").unwrap_or(&file_name)),
    );
    values.insert("mimeType".into(), json!(mime));
    values.insert("fileSize".into(), size);
    values.insert("mediaType".into(), json!(media_type));
    values.insert("storagePath".into(), json!(storage_path));
    values.insert("url".into(), url.map_or(Value::Null, |u| json!(u)));
    let provider =
        non_empty(body, "storageProvider").unwrap_or(if url.is_some() { "url" } else { "r2" });
    values.insert("storageProvider".into(), json!(provider));
    let status = if url.is_some() {
        json!("ready")
    } else {
        match body.get("status") {
            Some(Value::Null) | None => json!("uploading"),
            Some(status) => status.clone(),
        }
    };
    values.insert("status".into(), status);
    values.insert(
        "altText".into(),
        body.get("altText")
            .filter(|v| v.is_string())
            .cloned()
            .unwrap_or(Value::Null),
    );
    values.insert("uploadedByUserId".into(), json!(caller.session.actor()));
    let row = SOCIAL_MEDIA
        .insert(
            &caller.db,
            &values,
            &dates(&parsed, &["createdAt", "updatedAt"]),
        )
        .await?;
    caller.publish(
        &state.events,
        SOCIAL_MEDIA_CREATED,
        &id,
        pick(&id, &row, &MEDIA_EVENT),
    );
    created(row)
}

async fn update_media(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_SOCIAL_MEDIA, &headers, &body)?;
    let mut body = parsed.body.clone();
    strip_server_fields(&mut body);
    let update = with_updated(&body, &now());
    let row = SOCIAL_MEDIA
        .patch(
            &caller.db,
            &id,
            &update,
            true,
            &dates(&parsed, &["updatedAt"]),
        )
        .await?
        .ok_or_else(|| not_found("SocialMedia", &id))?;
    caller.publish(
        &state.events,
        SOCIAL_MEDIA_UPDATED,
        &id,
        pick(&id, &row, &MEDIA_EVENT),
    );
    ok(row)
}

async fn delete_media(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    let stamp = now();
    let mut set = Map::new();
    set.insert("deletedAt".into(), json!(stamp));
    set.insert("updatedAt".into(), json!(stamp));
    set.insert("status".into(), json!("deleted"));
    SOCIAL_MEDIA
        .patch(&caller.db, &id, &set, true, &["deletedAt", "updatedAt"])
        .await?
        .ok_or_else(|| not_found("SocialMedia", &id))?;
    caller.publish(
        &state.events,
        SOCIAL_MEDIA_DELETED,
        &id,
        json!({ "id": id }),
    );
    no_content()
}
