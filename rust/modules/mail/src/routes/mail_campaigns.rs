//! `/api/mail-campaigns` (`routes/mail-campaigns/index.ts`,
//! `services/mail/campaigns.ts`): marketing campaigns. A sent, cancelled or
//! failed campaign keeps everything but its tags and preheader.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveEnum, ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{
    MAIL_CAMPAIGN_CREATED, MAIL_CAMPAIGN_DELETED, MAIL_CAMPAIGN_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    CAMPAIGNS_CREATE, CAMPAIGNS_DELETE, CAMPAIGNS_READ, CAMPAIGNS_UPDATE,
};
use weldsuite_db::{orm, utc_now, utc_timestamp};
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_mail_domain::outbound::clock::parse_iso;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::enums::MailCampaignStatus;
use weldsuite_schema::tenant::mail_campaigns;

use crate::routes::mail_drafts::to_millis;
use crate::util::{MailError, answer, list_response, page, validate, validate_query};
use crate::{Caller, MailState};

const STATUSES: [&str; 7] = [
    "draft",
    "scheduled",
    "sending",
    "sent",
    "paused",
    "cancelled",
    "failed",
];

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([CAMPAIGNS_READ]);
    Router::new()
        .route("/mail-campaigns", get(list).route_layer(read()))
        .route("/mail-campaigns/{id}", get(detail).route_layer(read()))
        .route(
            "/mail-campaigns",
            post(create).route_layer(gate.require([CAMPAIGNS_CREATE])),
        )
        .route(
            "/mail-campaigns/{id}",
            patch(update)
                .put(update)
                .route_layer(gate.require([CAMPAIGNS_UPDATE])),
        )
        .route(
            "/mail-campaigns/{id}",
            axum::routing::delete(remove).route_layer(gate.require([CAMPAIGNS_DELETE])),
        )
        .with_state(state)
}

/// A campaign row as Drizzle returns it.
fn js(campaign: mail_campaigns::Model) -> Result<Value, DbErr> {
    serde_json::to_value(campaign).map_err(|error| DbErr::Json(error.to_string()))
}

async fn campaign_row(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    let row = mail_campaigns::Entity::find_by_id(id.to_owned())
        .filter(mail_campaigns::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?;
    row.map(js).transpose()
}

async fn row_by_id(caller: &Caller, id: &str) -> Result<Value, DbErr> {
    let row = mail_campaigns::Entity::find_by_id(id.to_owned())
        .one(&orm(&caller.db))
        .await?
        .ok_or_else(|| DbErr::RecordNotFound(format!("mail campaign {id}")))?;
    js(row)
}

/// A `status` the body or query chose (one of `STATUSES`).
fn campaign_status(status: &str) -> Result<MailCampaignStatus, DbErr> {
    MailCampaignStatus::try_from_value(&status.to_owned())
}

fn event(row: &Value, id: &str) -> Value {
    json!({ "id": id, "name": row["name"], "status": row["status"] })
}

/// `GET /` (`listCampaigns`).
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = validate_query(raw.as_deref(), |issues, q| {
        let status = issues.choice(q, "status", Presence::Optional, &STATUSES);
        let template = issues.text(q, "templateId", Presence::Optional, None, None);
        let limit = issues.whole_number(
            q,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                int: true,
                min: Some(1.0),
                max: Some(100.0),
            },
        );
        let cursor = issues.text(q, "cursor", Presence::Optional, None, None);
        (
            status.into_option(),
            template.into_option().filter(|t| !t.is_empty()),
            limit.into_option(),
            cursor.into_option(),
        )
    });
    let (status, template, limit, cursor) = match query {
        Ok(query) => query,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let limit = limit.unwrap_or(25).min(100);
        let (rows, total) = list_page(
            &caller,
            status.as_deref(),
            template.as_deref(),
            limit,
            cursor.as_deref(),
        )
        .await?;
        let (data, has_more, next) = page(rows, limit);
        Ok(list_response(data, total, has_more, next))
    }
    .await;
    answer(result, "Failed to list campaigns")
}

/// `listCampaigns`' page (`limit + 1` rows after the cursor) and its total.
async fn list_page(
    caller: &Caller,
    status: Option<&str>,
    template: Option<&str>,
    limit: i64,
    cursor: Option<&str>,
) -> Result<(Vec<Value>, i64), DbErr> {
    let db = orm(&caller.db);
    let cursor_row: Option<(PrimitiveDateTime, String)> = match cursor.filter(|c| !c.is_empty()) {
        Some(cursor) => {
            mail_campaigns::Entity::find_by_id(cursor.to_owned())
                .select_only()
                .columns([
                    mail_campaigns::Column::CreatedAt,
                    mail_campaigns::Column::Id,
                ])
                .into_tuple()
                .one(&db)
                .await?
        }
        None => None,
    };
    let mut scope = Condition::all().add(mail_campaigns::Column::DeletedAt.is_null());
    if let Some(status) = status {
        scope = scope.add(mail_campaigns::Column::Status.eq(campaign_status(status)?));
    }
    if let Some(template) = template {
        scope = scope.add(mail_campaigns::Column::TemplateId.eq(template));
    }
    let mut page_scope = scope.clone();
    if let Some((at, id)) = cursor_row {
        let at = to_millis(at);
        page_scope = page_scope.add(
            Condition::any()
                .add(mail_campaigns::Column::CreatedAt.lt(at))
                .add(
                    Condition::all()
                        .add(mail_campaigns::Column::CreatedAt.eq(at))
                        .add(mail_campaigns::Column::Id.lt(id)),
                ),
        );
    }
    let rows = mail_campaigns::Entity::find()
        .filter(page_scope)
        .order_by_desc(mail_campaigns::Column::CreatedAt)
        .order_by_desc(mail_campaigns::Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(&db)
        .await?;
    let total = mail_campaigns::Entity::find()
        .filter(scope)
        .count(&db)
        .await?;
    let rows = rows.into_iter().map(js).collect::<Result<Vec<_>, _>>()?;
    Ok((rows, i64::try_from(total).unwrap_or(i64::MAX)))
}

/// `GET /:id`.
async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        match campaign_row(&caller, &id).await? {
            Some(row) => Ok(Data(row).into_response()),
            None => Err(MailError::not_found("Campaign", Some(&id))),
        }
    }
    .await;
    answer(result, "Failed to fetch campaign")
}

const EMAIL: Text = Text {
    trim: false,
    lowercase: false,
    format: Some(Format::Email),
    min: None,
    max: None,
};

/// `recipientListSchema`.
fn read_recipients(
    issues: &mut Issues,
    body: &Map<String, Value>,
    presence: Presence,
) -> Option<Value> {
    issues
        .nested(body, "recipientList", presence, |issues, list| {
            let mut out = Map::new();
            if let Some(v) = issues
                .choice(
                    list,
                    "type",
                    Presence::Required,
                    &["contacts", "people", "segments", "manual", "csv"],
                )
                .into_option()
            {
                out.insert("type".into(), Value::String(v));
            }
            for key in ["contactIds", "personIds", "segmentIds"] {
                if let Some(v) = issues
                    .list(list, key, Presence::Optional, None, None, |issues, item| {
                        issues.item_text(item, Text::default())
                    })
                    .into_option()
                {
                    out.insert(key.into(), json!(v));
                }
            }
            if let Some(v) = issues
                .list(
                    list,
                    "emails",
                    Presence::Optional,
                    None,
                    None,
                    |issues, item| {
                        let fields = issues.object(item)?;
                        let before = issues.count();
                        let mut entry = Map::new();
                        if let Some(email) = issues
                            .text_with(fields, "email", Presence::Required, EMAIL)
                            .into_option()
                        {
                            entry.insert("email".into(), Value::String(email));
                        }
                        if let Some(name) = issues
                            .text(fields, "name", Presence::Optional, None, None)
                            .into_option()
                        {
                            entry.insert("name".into(), Value::String(name));
                        }
                        (issues.count() == before).then_some(Value::Object(entry))
                    },
                )
                .into_option()
            {
                out.insert("emails".into(), Value::Array(v));
            }
            if let Some(v) = issues
                .text_with(
                    list,
                    "csvUrl",
                    Presence::Optional,
                    Text {
                        format: Some(Format::Url),
                        ..Text::default()
                    },
                )
                .into_option()
            {
                out.insert("csvUrl".into(), Value::String(v));
            }
            for key in ["excludeUnsubscribed", "excludeBounced"] {
                if let Some(v) = issues.boolean(list, key, Presence::Optional).into_option() {
                    out.insert(key.into(), Value::Bool(v));
                }
            }
            Value::Object(out)
        })
        .into_option()
}

/// `createBody` / `updateBody`.
#[allow(clippy::too_many_lines)] // one reader per schema field, in order
fn read_campaign(
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = Map::new();
    let put = |out: &mut Map<String, Value>, key: &str, value: Option<Value>| {
        if let Some(value) = value {
            out.insert(key.into(), value);
        }
    };
    let s = |v: Option<String>| v.map(Value::String);
    put(
        &mut out,
        "templateId",
        s(issues
            .text(body, "templateId", Presence::Optional, None, None)
            .into_option()),
    );
    put(
        &mut out,
        "name",
        s(issues
            .text(body, "name", required, Some(1), Some(255))
            .into_option()),
    );
    put(
        &mut out,
        "subject",
        s(issues
            .text(body, "subject", required, Some(1), Some(998))
            .into_option()),
    );
    put(
        &mut out,
        "preheader",
        s(issues
            .text(body, "preheader", Presence::Optional, None, Some(500))
            .into_option()),
    );
    put(
        &mut out,
        "htmlContent",
        s(issues
            .text(body, "htmlContent", required, Some(1), None)
            .into_option()),
    );
    put(
        &mut out,
        "textContent",
        s(issues
            .text(body, "textContent", Presence::Optional, None, None)
            .into_option()),
    );
    put(
        &mut out,
        "recipientList",
        read_recipients(issues, body, required),
    );
    put(
        &mut out,
        "fromName",
        s(issues
            .text(body, "fromName", required, Some(1), Some(255))
            .into_option()),
    );
    put(
        &mut out,
        "fromEmail",
        s(issues
            .text_with(
                body,
                "fromEmail",
                required,
                Text {
                    max: Some(255),
                    ..EMAIL
                },
            )
            .into_option()),
    );
    put(
        &mut out,
        "replyToEmail",
        s(issues
            .text_with(
                body,
                "replyToEmail",
                Presence::Optional,
                Text {
                    max: Some(255),
                    ..EMAIL
                },
            )
            .into_option()),
    );
    put(
        &mut out,
        "scheduledAt",
        s(issues
            .text_with(
                body,
                "scheduledAt",
                Presence::Optional,
                Text {
                    format: Some(Format::Datetime),
                    ..Text::default()
                },
            )
            .into_option()),
    );
    put(
        &mut out,
        "status",
        s(issues
            .choice(body, "status", Presence::Optional, &STATUSES)
            .into_option()),
    );
    for key in ["trackOpens", "trackClicks"] {
        put(
            &mut out,
            key,
            issues
                .boolean(body, key, Presence::Optional)
                .into_option()
                .map(Value::Bool),
        );
    }
    put(
        &mut out,
        "tags",
        issues
            .list(
                body,
                "tags",
                Presence::Optional,
                None,
                None,
                |issues, item| issues.item_text(item, Text::default()),
            )
            .into_option()
            .map(|v| json!(v)),
    );
    out
}

fn text<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str)
}

fn flag(data: &Map<String, Value>, key: &str) -> Option<bool> {
    data.get(key).and_then(Value::as_bool)
}

/// `countRecipients(list)`.
fn count_recipients(list: &Value) -> i64 {
    ["personIds", "contactIds", "segmentIds", "emails"]
        .iter()
        .map(|k| list[*k].as_array().map_or(0, Vec::len))
        .map(|n| i64::try_from(n).unwrap_or_default())
        .sum()
}

/// `new Date(scheduledAt)` as Drizzle writes it.
fn scheduled_at(data: &Map<String, Value>) -> Option<PrimitiveDateTime> {
    text(data, "scheduledAt")
        .filter(|s| !s.is_empty())
        .and_then(parse_iso)
        .map(|ms| {
            let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
                .unwrap_or(OffsetDateTime::UNIX_EPOCH);
            utc_timestamp(at)
        })
}

fn owned(data: &Map<String, Value>, key: &str) -> Option<String> {
    text(data, key).map(str::to_owned)
}

/// `POST /` (`createCampaign`).
async fn create(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_campaign(issues, body, false)
    }) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let id = generate_id("camp");
        let recipients = data.get("recipientList").cloned().unwrap_or(Value::Null);
        // An `integer` column: what Postgres refuses ("out of range") stays
        // the route's 500.
        let total = i32::try_from(count_recipients(&recipients))
            .map_err(|_| DbErr::Custom("total_recipients: integer out of range".to_owned()))?;
        let at = utc_now();
        mail_campaigns::Entity::insert(mail_campaigns::ActiveModel {
            id: Set(id.clone()),
            template_id: Set(owned(&data, "templateId")),
            name: Set(owned(&data, "name").unwrap_or_default()),
            subject: Set(owned(&data, "subject").unwrap_or_default()),
            preheader: Set(owned(&data, "preheader")),
            html_content: Set(owned(&data, "htmlContent").unwrap_or_default()),
            text_content: Set(owned(&data, "textContent")),
            recipient_list: Set(recipients),
            total_recipients: Set(total),
            from_name: Set(owned(&data, "fromName").unwrap_or_default()),
            from_email: Set(owned(&data, "fromEmail").unwrap_or_default()),
            reply_to_email: Set(owned(&data, "replyToEmail")),
            scheduled_at: Set(scheduled_at(&data)),
            status: Set(campaign_status(text(&data, "status").unwrap_or("draft"))?),
            track_opens: Set(flag(&data, "trackOpens").unwrap_or(true)),
            track_clicks: Set(flag(&data, "trackClicks").unwrap_or(true)),
            tags: Set(data.get("tags").cloned()),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
        .await?;
        let row = row_by_id(&caller, &id).await?;
        caller.publish(&state, MAIL_CAMPAIGN_CREATED, &id, &event(&row, &id));
        Ok(Created(row).into_response())
    }
    .await;
    answer(result, "Failed to create campaign")
}

/// `PUT|PATCH /:id` (`updateCampaign`).
async fn update(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_campaign(issues, body, true)
    }) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let Some(existing) = campaign_row(&caller, &id).await? else {
            return Err(MailError::not_found("Campaign", None));
        };
        let status = existing["status"].as_str().unwrap_or_default();
        if matches!(status, "sent" | "cancelled" | "failed")
            && data.keys().any(|k| k != "tags" && k != "preheader")
        {
            return Err(MailError::conflict(format!(
                "Campaign is {status}; only tags/preheader can be edited."
            )));
        }
        write_update(&caller, &id, &data).await?;
        let after = row_by_id(&caller, &id).await?;
        caller.publish(&state, MAIL_CAMPAIGN_UPDATED, &id, &event(&after, &id));
        Ok(Data(after).into_response())
    }
    .await;
    answer(result, "Failed to update campaign")
}

/// `updateCampaign`'s write: the fields the body sent, and `updatedAt`.
async fn write_update(caller: &Caller, id: &str, data: &Map<String, Value>) -> Result<(), DbErr> {
    let mut update = mail_campaigns::Entity::update_many()
        .col_expr(mail_campaigns::Column::UpdatedAt, Expr::value(utc_now()));
    for (key, column) in [
        ("templateId", mail_campaigns::Column::TemplateId),
        ("name", mail_campaigns::Column::Name),
        ("subject", mail_campaigns::Column::Subject),
        ("preheader", mail_campaigns::Column::Preheader),
        ("htmlContent", mail_campaigns::Column::HtmlContent),
        ("textContent", mail_campaigns::Column::TextContent),
        ("fromName", mail_campaigns::Column::FromName),
        ("fromEmail", mail_campaigns::Column::FromEmail),
        ("replyToEmail", mail_campaigns::Column::ReplyToEmail),
    ] {
        if let Some(value) = owned(data, key) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    if let Some(recipients) = data.get("recipientList") {
        update = update
            .col_expr(
                mail_campaigns::Column::RecipientList,
                Expr::value(recipients.clone()),
            )
            .col_expr(
                mail_campaigns::Column::TotalRecipients,
                Expr::value(count_recipients(recipients)),
            );
    }
    if let Some(at) = scheduled_at(data) {
        update = update.col_expr(mail_campaigns::Column::ScheduledAt, Expr::value(at));
    }
    if let Some(status) = text(data, "status") {
        update = update.col_expr(
            mail_campaigns::Column::Status,
            mail_campaigns::Column::Status.save_as(Expr::value(campaign_status(status)?)),
        );
    }
    for (key, column) in [
        ("trackOpens", mail_campaigns::Column::TrackOpens),
        ("trackClicks", mail_campaigns::Column::TrackClicks),
    ] {
        if let Some(value) = flag(data, key) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    if let Some(tags) = data.get("tags") {
        update = update.col_expr(mail_campaigns::Column::Tags, Expr::value(tags.clone()));
    }
    update
        .filter(mail_campaigns::Column::Id.eq(id))
        .exec(&orm(&caller.db))
        .await?;
    Ok(())
}

/// `DELETE /:id` (`softDeleteCampaign`).
async fn remove(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = campaign_row(&caller, &id).await? else {
            return Err(MailError::not_found("Campaign", Some(&id)));
        };
        let at = utc_now();
        mail_campaigns::Entity::update_many()
            .col_expr(mail_campaigns::Column::DeletedAt, Expr::value(at))
            .col_expr(mail_campaigns::Column::UpdatedAt, Expr::value(at))
            .filter(mail_campaigns::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, MAIL_CAMPAIGN_DELETED, &id, &event(&existing, &id));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete campaign")
}
