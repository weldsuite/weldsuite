//! Workspace settings (one row), the member's own subscription to a form,
//! and media uploads (`services/settings.ts`).

use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use weldsuite_core_domain::plan_limits::load_workspace_plan;
use weldsuite_db::{OrmConn, atomically_with, orm};
use weldsuite_ports::PutOptions;
use weldsuite_schema::tenant::{form_settings, form_subscriptions, form_themes, forms};

use crate::common::{Ctx, FormsResult, forms_error, instant, not_found, row_json, rows_json};
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
    form_settings::Entity::find()
        .one(&orm(&ctx.db))
        .await?
        .map(row_json)
        .transpose()
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
        let found: Option<String> = form_themes::Entity::find()
            .select_only()
            .column(form_themes::Column::Id)
            .filter(form_themes::Column::Id.eq(theme))
            .into_tuple()
            .one(&orm(&ctx.db))
            .await?;
        if found.is_none() {
            return Err(not_found("Theme"));
        }
    }
    let existing = settings_row(ctx).await?;
    let now = instant(ctx.now_ms());
    let id = match &existing {
        Some(row) => row["id"].as_str().unwrap_or_default().to_owned(),
        None => weldsuite_kit::generate_id("fst"),
    };
    let int = |value: Option<i64>| value.map(|v| i32::try_from(v).unwrap_or(i32::MAX));
    let mut update = form_settings::Entity::update_many()
        .col_expr(form_settings::Column::UpdatedAt, Expr::value(now));
    if let Some(theme) = &input.default_theme_id {
        update = update.col_expr(
            form_settings::Column::DefaultThemeId,
            Expr::value(theme.clone()),
        );
    }
    if let Some(name) = &input.sender_name {
        update = update.col_expr(form_settings::Column::SenderName, Expr::value(name.clone()));
    }
    if let Some(days) = input.reminder_after_days {
        update = update.col_expr(
            form_settings::Column::ReminderAfterDays,
            Expr::value(int(days)),
        );
    }
    if let Some(days) = input.reminder_every_days {
        update = update.col_expr(
            form_settings::Column::ReminderEveryDays,
            Expr::value(int(days)),
        );
    }
    if let Some(count) = input.reminder_max_count {
        update = update.col_expr(
            form_settings::Column::ReminderMaxCount,
            Expr::value(int(Some(count))),
        );
    }
    if let Some(show) = input.show_badge {
        update = update.col_expr(form_settings::Column::ShowBadge, Expr::value(show));
    }
    let update = update.filter(form_settings::Column::Id.eq(id.clone()));
    // The single row: inserted with the column defaults, then set as an update would.
    let missing = existing.is_none();
    atomically_with(&ctx.db, |tx| {
        Box::pin(async move {
            let db = OrmConn::new(tx);
            if missing {
                form_settings::Entity::insert(form_settings::ActiveModel {
                    id: Set(id),
                    updated_at: Set(now),
                    ..Default::default()
                })
                .exec_without_returning(&db)
                .await?;
            }
            update.exec(&db).await?;
            FormsResult::Ok(())
        })
    })
    .await?;
    let row = settings_row(ctx).await?;
    // The badge is part of what respondents get from the cache.
    if input.show_badge.is_some() {
        let live = rows_json(
            forms::Entity::find()
                .filter(forms::Column::PublicId.is_not_null())
                .all(&orm(&ctx.db))
                .await?,
        )?;
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
    let mode: Option<String> = form_subscriptions::Entity::find()
        .select_only()
        .column(form_subscriptions::Column::Mode)
        .filter(form_subscriptions::Column::FormId.eq(form_id))
        .filter(form_subscriptions::Column::UserId.eq(user_id))
        .into_tuple()
        .one(&orm(&ctx.db))
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
    let db = orm(&ctx.db);
    let existing: Option<String> = form_subscriptions::Entity::find()
        .select_only()
        .column(form_subscriptions::Column::Id)
        .filter(form_subscriptions::Column::FormId.eq(form_id))
        .filter(form_subscriptions::Column::UserId.eq(user_id))
        .into_tuple()
        .one(&db)
        .await?;
    match existing {
        Some(id) => {
            form_subscriptions::Entity::update_many()
                .col_expr(form_subscriptions::Column::Mode, Expr::value(mode))
                .col_expr(
                    form_subscriptions::Column::UpdatedAt,
                    Expr::value(instant(ctx.now_ms())),
                )
                .filter(form_subscriptions::Column::Id.eq(id))
                .exec(&db)
                .await?;
        }
        None => {
            form_subscriptions::Entity::insert(form_subscriptions::ActiveModel {
                id: Set(weldsuite_kit::generate_id("fsb")),
                form_id: Set(form_id.to_owned()),
                user_id: Set(user_id.to_owned()),
                mode: Set(mode.to_owned()),
                ..Default::default()
            })
            .exec_without_returning(&db)
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
