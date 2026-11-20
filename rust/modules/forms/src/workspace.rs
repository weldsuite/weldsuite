//! Workspace settings (one row), the member's own subscription to a form,
//! and media uploads (`services/settings.ts`).

use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder};
use weldsuite_core_domain::plan_limits::load_workspace_plan;
use weldsuite_ports::PutOptions;

use crate::common::{Ctx, FormsResult, all, forms_error, iso, not_found, one};
use crate::input::SettingsPatch;
use crate::public_cache::refresh_public_cache;

// ---------------------------------------------------------------------------
// Workspace settings
// ---------------------------------------------------------------------------

/// `settingsDto(row, canHideBadge)`.
fn settings_dto(row: Option<&Value>, can_hide_badge: bool) -> Value {
    let field = |key: &str| row.map_or(Value::Null, |row| row[key].clone());
    json!({
        "defaultThemeId": field("defaultThemeId"),
        "senderName": field("senderName"),
        "reminderAfterDays": field("reminderAfterDays"),
        "reminderEveryDays": field("reminderEveryDays"),
        "reminderMaxCount": row.map_or(json!(3), |row| row["reminderMaxCount"].clone()),
        // A plan that may not hide the badge always shows it.
        "showBadge": row.is_none_or(|row| row["showBadge"] == Value::Bool(true) || !can_hide_badge),
        "canHideBadge": can_hide_badge,
    })
}

async fn settings_row(ctx: &Ctx) -> FormsResult<Option<Value>> {
    one(
        &ctx.db,
        sqlx::query_scalar("select to_jsonb(s) from form_settings s limit 1"),
    )
    .await
}

/// `getWorkspaceSettings(ctx)`.
pub(crate) async fn get_workspace_settings(ctx: &Ctx) -> FormsResult<Value> {
    let row = settings_row(ctx).await?;
    let plan = load_workspace_plan(ctx.master()?, &ctx.workspace_id).await?;
    Ok(settings_dto(row.as_ref(), plan.remove_branding))
}

/// `updateWorkspaceSettings(ctx, input)`: upserts the single row; switching
/// the badge off needs a plan that allows it (403 `PLAN_REQUIRED`).
pub(crate) async fn update_workspace_settings(
    ctx: &Ctx,
    input: &SettingsPatch,
) -> FormsResult<Value> {
    let plan = load_workspace_plan(ctx.master()?, &ctx.workspace_id).await?;
    if input.show_badge == Some(false) && !plan.remove_branding {
        return Err(forms_error(
            403,
            "PLAN_REQUIRED",
            "Your plan does not include removing the \"Made with WeldForms\" badge.",
        ));
    }
    if let Some(Some(theme)) = &input.default_theme_id
        && !theme.is_empty()
    {
        let found: Option<String> =
            sqlx::query_scalar("select id from form_themes where id = $1 limit 1")
                .bind(theme)
                .fetch_optional(&ctx.db)
                .await?;
        if found.is_none() {
            return Err(not_found("Theme"));
        }
    }
    let existing = settings_row(ctx).await?;
    let now = iso(ctx.now_ms());
    let id = match &existing {
        Some(row) => row["id"].as_str().unwrap_or_default().to_owned(),
        None => weldsuite_kit::generate_id("fst"),
    };
    let int = |value: Option<i64>| value.map(|v| i32::try_from(v).unwrap_or(i32::MAX));
    let mut q = QueryBuilder::<Postgres>::new("update form_settings set updated_at = ");
    q.push_bind(now.clone()).push("::timestamptz");
    if let Some(theme) = &input.default_theme_id {
        q.push(", default_theme_id = ").push_bind(theme.clone());
    }
    if let Some(name) = &input.sender_name {
        q.push(", sender_name = ").push_bind(name.clone());
    }
    if let Some(days) = input.reminder_after_days {
        q.push(", reminder_after_days = ").push_bind(int(days));
    }
    if let Some(days) = input.reminder_every_days {
        q.push(", reminder_every_days = ").push_bind(int(days));
    }
    if let Some(count) = input.reminder_max_count {
        q.push(", reminder_max_count = ")
            .push_bind(int(Some(count)));
    }
    if let Some(show) = input.show_badge {
        q.push(", show_badge = ").push_bind(show);
    }
    q.push(" where id = ").push_bind(id.clone());
    // The single row: inserted with the column defaults, then set as an update would.
    let mut tx = ctx.db.begin().await?;
    if existing.is_none() {
        sqlx::query("insert into form_settings (id, updated_at) values ($1, $2::timestamptz)")
            .bind(&id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
    }
    q.build().execute(&mut *tx).await?;
    tx.commit().await?;
    let row = settings_row(ctx).await?;
    // The badge is part of what respondents get from the cache.
    if input.show_badge.is_some() {
        let live = all(
            &ctx.db,
            sqlx::query_scalar("select to_jsonb(f) from forms f where public_id is not null"),
        )
        .await?;
        for form in &live {
            refresh_public_cache(ctx, form).await?;
        }
    }
    Ok(settings_dto(row.as_ref(), plan.remove_branding))
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

/// `getSubscription(ctx, formId, userId)`: `off` for anyone who never chose.
pub(crate) async fn get_subscription(
    ctx: &Ctx,
    form_id: &str,
    user_id: &str,
) -> FormsResult<Value> {
    let mode: Option<String> = sqlx::query_scalar(
        "select mode from form_subscriptions where form_id = $1 and user_id = $2 limit 1",
    )
    .bind(form_id)
    .bind(user_id)
    .fetch_optional(&ctx.db)
    .await?;
    Ok(json!({ "mode": mode.unwrap_or_else(|| "off".to_owned()) }))
}

/// `setSubscription(ctx, formId, userId, input)`.
pub(crate) async fn set_subscription(
    ctx: &Ctx,
    form_id: &str,
    user_id: &str,
    mode: &str,
) -> FormsResult<Value> {
    let existing: Option<String> = sqlx::query_scalar(
        "select id from form_subscriptions where form_id = $1 and user_id = $2 limit 1",
    )
    .bind(form_id)
    .bind(user_id)
    .fetch_optional(&ctx.db)
    .await?;
    match existing {
        Some(id) => {
            sqlx::query("update form_subscriptions set mode = $2, updated_at = $3::timestamptz where id = $1")
                .bind(id)
                .bind(mode)
                .bind(iso(ctx.now_ms()))
                .execute(&ctx.db)
                .await?;
        }
        None => {
            sqlx::query("insert into form_subscriptions (id, form_id, user_id, mode) values ($1, $2, $3, $4)")
                .bind(weldsuite_kit::generate_id("fsb"))
                .bind(form_id)
                .bind(user_id)
                .bind(mode)
                .execute(&ctx.db)
                .await?;
        }
    }
    Ok(json!({ "mode": mode }))
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

pub(crate) const MAX_MEDIA_BYTES: usize = 5 * 1024 * 1024;

/// Images only; SVG is left out because it can carry script.
fn media_extension(content_type: &str) -> Option<&'static str> {
    match content_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/avif" => Some("avif"),
        _ => None,
    }
}

/// `publicMediaUrl(env, key)`.
fn public_media_url(ctx: &Ctx, key: &str) -> String {
    let base = ctx
        .env()
        .non_empty("R2_PUBLIC_URL")
        .or_else(|| ctx.env().non_empty("S3_PUBLIC_URL"))
        .unwrap_or_else(|| "https://weldsuite-storage.weldsuite.org".to_owned());
    let base = base.strip_suffix('/').unwrap_or(&base);
    format!("{base}/{key}")
}

/// `uploadMedia(ctx, file)`: an image in the public bucket under
/// `workspaces/<org>/weldforms/media/`.
pub(crate) async fn upload_media(
    ctx: &Ctx,
    content_type: &str,
    bytes: Vec<u8>,
) -> FormsResult<Value> {
    let Some(extension) = media_extension(content_type) else {
        return Err(forms_error(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "Upload a PNG, JPEG, GIF, WebP or AVIF image.",
        ));
    };
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err(forms_error(
            413,
            "FILE_TOO_LARGE",
            "Images can be at most 5 MB.",
        ));
    }
    if bytes.is_empty() {
        return Err(forms_error(400, "BAD_REQUEST", "The file is empty."));
    }
    let key = format!(
        "workspaces/{}/weldforms/media/{}.{extension}",
        ctx.clerk_org_id,
        weldsuite_kit::random_string(16, weldsuite_kit::id::ALPHANUMERIC)
    );
    let Some(store) = ctx
        .svc
        .files
        .as_ref()
        .and_then(|files| files.public.clone())
    else {
        return Err(crate::common::Fail::Internal(
            "forms: no public bucket".to_owned(),
        ));
    };
    let size = bytes.len();
    store
        .put_boxed(&key, bytes, &PutOptions::content_type(content_type))
        .await?;
    Ok(json!({ "url": public_media_url(ctx, &key), "contentType": content_type, "size": size }))
}
