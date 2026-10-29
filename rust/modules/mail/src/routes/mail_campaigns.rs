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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    MAIL_CAMPAIGN_CREATED, MAIL_CAMPAIGN_DELETED, MAIL_CAMPAIGN_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    CAMPAIGNS_CREATE, CAMPAIGNS_DELETE, CAMPAIGNS_READ, CAMPAIGNS_UPDATE,
};
use weldsuite_db::js_row;
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_mail_domain::outbound::clock::{iso as iso_ms, parse_iso};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::util::{MailError, answer, list_response, now, page, validate, validate_query};
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

async fn campaign_row(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from mail_campaigns c where c.id = $1 and c.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(js_row))
}

async fn row_by_id(caller: &Caller, id: &str) -> Result<Value, sqlx::Error> {
    let row: Value = sqlx::query_scalar("select to_jsonb(c) from mail_campaigns c where c.id = $1")
        .bind(id)
        .fetch_one(&caller.db)
        .await?;
    Ok(js_row(row))
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
        let cursor_row: Option<(String, String)> =
            match cursor.as_deref().filter(|c| !c.is_empty()) {
                Some(cursor) => {
                    sqlx::query_as(
                        "select to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), id
                         from mail_campaigns where id = $1 limit 1",
                    )
                    .bind(cursor)
                    .fetch_optional(&caller.db)
                    .await?
                }
                None => None,
            };
        let (cursor_at, cursor_id) = cursor_row.unzip();
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(c) from mail_campaigns c
             where c.deleted_at is null
               and ($1::text is null or c.status = $1::mail_campaign_status)
               and ($2::text is null or c.template_id = $2)
               and ($3::timestamp is null or (c.created_at < $3::timestamp
                    or (c.created_at = $3::timestamp and c.id < $4)))
             order by c.created_at desc, c.id desc limit $5",
        )
        .bind(&status)
        .bind(&template)
        .bind(&cursor_at)
        .bind(&cursor_id)
        .bind(limit + 1)
        .fetch_all(&caller.db)
        .await?;
        let total: i32 = sqlx::query_scalar(
            "select count(*)::int from mail_campaigns c
             where c.deleted_at is null
               and ($1::text is null or c.status = $1::mail_campaign_status)
               and ($2::text is null or c.template_id = $2)",
        )
        .bind(&status)
        .bind(&template)
        .fetch_one(&caller.db)
        .await?;
        let rows = rows.into_iter().map(js_row).collect();
        let (data, has_more, next) = page(rows, limit);
        Ok(list_response(data, i64::from(total), has_more, next))
    }
    .await;
    answer(result, "Failed to list campaigns")
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
fn read_recipients(issues: &mut Issues, body: &Map<String, Value>, presence: Presence) -> Option<Value> {
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
                .list(list, "emails", Presence::Optional, None, None, |issues, item| {
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
                })
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
fn read_campaign(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> Map<String, Value> {
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
    put(&mut out, "templateId", s(issues.text(body, "templateId", Presence::Optional, None, None).into_option()));
    put(&mut out, "name", s(issues.text(body, "name", required, Some(1), Some(255)).into_option()));
    put(&mut out, "subject", s(issues.text(body, "subject", required, Some(1), Some(998)).into_option()));
    put(&mut out, "preheader", s(issues.text(body, "preheader", Presence::Optional, None, Some(500)).into_option()));
    put(&mut out, "htmlContent", s(issues.text(body, "htmlContent", required, Some(1), None).into_option()));
    put(&mut out, "textContent", s(issues.text(body, "textContent", Presence::Optional, None, None).into_option()));
    put(&mut out, "recipientList", read_recipients(issues, body, required));
    put(&mut out, "fromName", s(issues.text(body, "fromName", required, Some(1), Some(255)).into_option()));
    put(
        &mut out,
        "fromEmail",
        s(issues
            .text_with(body, "fromEmail", required, Text { max: Some(255), ..EMAIL })
            .into_option()),
    );
    put(
        &mut out,
        "replyToEmail",
        s(issues
            .text_with(body, "replyToEmail", Presence::Optional, Text { max: Some(255), ..EMAIL })
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
    put(&mut out, "status", s(issues.choice(body, "status", Presence::Optional, &STATUSES).into_option()));
    for key in ["trackOpens", "trackClicks"] {
        put(&mut out, key, issues.boolean(body, key, Presence::Optional).into_option().map(Value::Bool));
    }
    put(
        &mut out,
        "tags",
        issues
            .list(body, "tags", Presence::Optional, None, None, |issues, item| {
                issues.item_text(item, Text::default())
            })
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
fn scheduled_at(data: &Map<String, Value>) -> Option<String> {
    text(data, "scheduledAt")
        .filter(|s| !s.is_empty())
        .and_then(parse_iso)
        .map(iso_ms)
}

/// `POST /` (`createCampaign`).
async fn create(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| read_campaign(issues, body, false)) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let id = generate_id("camp");
        let recipients = data.get("recipientList").cloned().unwrap_or(Value::Null);
        sqlx::query(
            "insert into mail_campaigns (id, template_id, name, subject, preheader, html_content,
               text_content, recipient_list, total_recipients, from_name, from_email,
               reply_to_email, scheduled_at, status, track_opens, track_clicks, tags,
               created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamp,
               $14::mail_campaign_status, $15, $16, $17, $18::timestamp, $18::timestamp)",
        )
        .bind(&id)
        .bind(text(&data, "templateId"))
        .bind(text(&data, "name"))
        .bind(text(&data, "subject"))
        .bind(text(&data, "preheader"))
        .bind(text(&data, "htmlContent"))
        .bind(text(&data, "textContent"))
        .bind(&recipients)
        .bind(count_recipients(&recipients))
        .bind(text(&data, "fromName"))
        .bind(text(&data, "fromEmail"))
        .bind(text(&data, "replyToEmail"))
        .bind(scheduled_at(&data))
        .bind(text(&data, "status").unwrap_or("draft"))
        .bind(flag(&data, "trackOpens").unwrap_or(true))
        .bind(flag(&data, "trackClicks").unwrap_or(true))
        .bind(data.get("tags").cloned())
        .bind(now())
        .execute(&caller.db)
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
    let data = match validate(&headers, &body, |issues, body| read_campaign(issues, body, true)) {
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
        let recipients = data.get("recipientList").cloned();
        let total = recipients.as_ref().map(count_recipients);
        sqlx::query(
            "update mail_campaigns set updated_at = $2::timestamp,
               template_id = coalesce($3, template_id), name = coalesce($4, name),
               subject = coalesce($5, subject), preheader = coalesce($6, preheader),
               html_content = coalesce($7, html_content), text_content = coalesce($8, text_content),
               recipient_list = coalesce($9, recipient_list),
               total_recipients = coalesce($10::int, total_recipients),
               from_name = coalesce($11, from_name), from_email = coalesce($12, from_email),
               reply_to_email = coalesce($13, reply_to_email),
               scheduled_at = coalesce($14::timestamp, scheduled_at),
               status = coalesce($15::mail_campaign_status, status),
               track_opens = coalesce($16, track_opens), track_clicks = coalesce($17, track_clicks),
               tags = coalesce($18, tags)
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(text(&data, "templateId"))
        .bind(text(&data, "name"))
        .bind(text(&data, "subject"))
        .bind(text(&data, "preheader"))
        .bind(text(&data, "htmlContent"))
        .bind(text(&data, "textContent"))
        .bind(recipients)
        .bind(total)
        .bind(text(&data, "fromName"))
        .bind(text(&data, "fromEmail"))
        .bind(text(&data, "replyToEmail"))
        .bind(scheduled_at(&data))
        .bind(text(&data, "status"))
        .bind(flag(&data, "trackOpens"))
        .bind(flag(&data, "trackClicks"))
        .bind(data.get("tags").cloned())
        .execute(&caller.db)
        .await?;
        let after = row_by_id(&caller, &id).await?;
        caller.publish(&state, MAIL_CAMPAIGN_UPDATED, &id, &event(&after, &id));
        Ok(Data(after).into_response())
    }
    .await;
    answer(result, "Failed to update campaign")
}

/// `DELETE /:id` (`softDeleteCampaign`).
async fn remove(State(state): State<MailState>, caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(existing) = campaign_row(&caller, &id).await? else {
            return Err(MailError::not_found("Campaign", Some(&id)));
        };
        sqlx::query(
            "update mail_campaigns set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
        caller.publish(&state, MAIL_CAMPAIGN_DELETED, &id, &event(&existing, &id));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete campaign")
}
