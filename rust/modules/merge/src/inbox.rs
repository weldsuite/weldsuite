//! The inbox (`routes/inbox/*`, `services/inbox.ts`):
//!
//! ```text
//!   GET   /inbox?include=archived|snoozed                 → the derived items, newest first
//!   PATCH /inbox/items/:itemKey {read?, snoozedUntil?, archived?} → the item's state (created on first use)
//!   POST  /inbox/read-all                                 → { updated }: every visible unread item marked read
//! ```
//!
//! The items are derived on every request: review requests, the member's
//! pull requests with failed checks or requested changes, issues assigned
//! to them that changed lately, and their recently merged pull requests.
//! The member's own read, snooze and archive state (`merge_inbox_states`,
//! keyed by the item's id) is applied: archived and still-snoozed items are
//! left out unless asked for.
//!
//! Permission: `merge_pull_requests:read`. The assigned-issue items need
//! `merge_issues:read` as well and are left out without it. The state is
//! per-member UI state: own rows only, no entity events.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::IntoResponse;
use http::HeaderMap;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::OnConflict;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::permission_keys::MERGE_ISSUES_READ;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Field, Format, Presence, Text, js_date_parse};
use weldsuite_kit::{Data, generate_id};
use weldsuite_schema::tenant::{merge_inbox_states, merge_issues};

use crate::db::{col, instant_opt, json_row, json_rows, millis, now_at, text};
use crate::issues::hydrate_issues;
use crate::pull_requests::{Filter, member_github_login, query_pull_requests, to_list_items};
use crate::schemas::nothing_to_update;
use crate::{Answer, Caller, Refusal, all, validate, validate_query};

const PER_KIND: i64 = 50;
const ASSIGNED_DAYS: i64 = 14;
const MERGED_DAYS: i64 = 3;
/// The longest item key `merge_inbox_states.item_key` holds.
const MAX_ITEM_KEY: usize = 200;

/// One inbox entry before sorting: its id, `at`, and the item.
struct Item {
    id: String,
    at: String,
    value: Value,
}

async fn pull_request_items(
    caller: &Caller,
    kind: &str,
    filter: Filter,
    merged_at: bool,
    items: &mut Vec<Item>,
) -> Result<(), DbErr> {
    let rows = query_pull_requests(&caller.db, filter, PER_KIND).await?;
    let list = to_list_items(&caller.db, &rows).await?;
    for (row, item) in rows.iter().zip(list) {
        let at = if merged_at && !col(&row.pr, "mergedAt").is_null() {
            col(&row.pr, "mergedAt")
        } else {
            col(&row.pr, "providerUpdatedAt")
        };
        let id = format!("{kind}:{}", text(&row.pr, "id"));
        let at = at.as_str().unwrap_or_default().to_owned();
        items.push(Item {
            value: json!({ "id": id, "kind": kind, "at": at, "pullRequest": item, "issue": null }),
            id,
            at,
        });
    }
    Ok(())
}

/// `applyStates(db, userId, items, include, now)`: the member's read,
/// snooze and archive state on the derived items. A snooze that has passed
/// is over.
async fn apply_states(
    db: &PgPool,
    user_id: &str,
    items: Vec<Item>,
    include: Option<&str>,
    now_ms: f64,
) -> Result<Vec<Item>, DbErr> {
    if items.is_empty() {
        return Ok(items);
    }
    let keys: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
    let states = json_rows(
        merge_inbox_states::Entity::find()
            .filter(merge_inbox_states::Column::UserId.eq(user_id))
            .filter(merge_inbox_states::Column::ItemKey.is_in(keys))
            .all(&orm(db))
            .await?
            .into_iter()
            .map(serde_json::to_value),
    )?;
    let by_key: HashMap<String, Value> = states
        .into_iter()
        .map(|state| (text(&state, "itemKey").to_owned(), state))
        .collect();
    let mut out = Vec::with_capacity(items.len());
    for mut item in items {
        let state = by_key.get(&item.id);
        let snoozed = state
            .and_then(|s| s.get("snoozedUntil"))
            .and_then(Value::as_str)
            .filter(|until| js_date_parse(until).is_some_and(|ms| ms > now_ms))
            .map(str::to_owned);
        let archived = state.is_some_and(|s| !s["archivedAt"].is_null());
        if archived && include != Some("archived") {
            continue;
        }
        if snoozed.is_some() && include != Some("snoozed") {
            continue;
        }
        if let Some(fields) = item.value.as_object_mut() {
            fields.insert(
                "read".to_owned(),
                json!(state.is_some_and(|s| !s["readAt"].is_null())),
            );
            fields.insert("snoozedUntil".to_owned(), json!(snoozed));
        }
        out.push(item);
    }
    Ok(out)
}

/// `buildInbox(db, { userId, canReadIssues, include })`.
async fn build_inbox(caller: &Caller, include: Option<&str>) -> Result<Vec<Item>, DbErr> {
    let now = OffsetDateTime::now_utc();
    let user_id = caller.user_id.clone();
    let login = member_github_login(&caller.db, &user_id)
        .await?
        .filter(|l| !l.is_empty());
    let mut items: Vec<Item> = Vec::new();
    let mine = || Some((user_id.clone(), login.clone()));

    if let Some(login) = &login {
        pull_request_items(
            caller,
            "review_requested",
            Filter {
                state: Some("open"),
                draft: Some(false),
                review_requested_from: Some(login.clone()),
                ..Filter::default()
            },
            false,
            &mut items,
        )
        .await?;
    }
    pull_request_items(
        caller,
        "checks_failed",
        Filter {
            state: Some("open"),
            authored_by: mine(),
            checks_status: Some("failure"),
            ..Filter::default()
        },
        false,
        &mut items,
    )
    .await?;
    pull_request_items(
        caller,
        "changes_requested",
        Filter {
            state: Some("open"),
            authored_by: mine(),
            review_decision: Some("changes_requested"),
            ..Filter::default()
        },
        false,
        &mut items,
    )
    .await?;
    pull_request_items(
        caller,
        "merged",
        Filter {
            state: Some("merged"),
            authored_by: mine(),
            merged_since: Some(millis(now - time::Duration::days(MERGED_DAYS))),
            ..Filter::default()
        },
        true,
        &mut items,
    )
    .await?;

    if caller.can(MERGE_ISSUES_READ) {
        let rows = json_rows(
            merge_issues::Entity::find()
                .filter(merge_issues::Column::AssigneeUserId.eq(&user_id))
                .filter(merge_issues::Column::DeletedAt.is_null())
                .filter(
                    merge_issues::Column::UpdatedAt
                        .gte(millis(now - time::Duration::days(ASSIGNED_DAYS))),
                )
                .order_by_desc(merge_issues::Column::UpdatedAt)
                .order_by_desc(merge_issues::Column::Id)
                .limit(PER_KIND.unsigned_abs())
                .all(&orm(&caller.db))
                .await?
                .into_iter()
                .map(serde_json::to_value),
        )?;
        let issues = hydrate_issues(&caller.db, &rows).await?;
        for (row, issue) in rows.iter().zip(issues) {
            let id = format!("assigned:{}", text(row, "id"));
            let at = text(row, "updatedAt").to_owned();
            items.push(Item {
                value: json!({ "id": id, "kind": "assigned", "at": at, "pullRequest": null, "issue": issue }),
                id,
                at,
            });
        }
    }

    // Newest first; the id breaks ties so the order is stable.
    items.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| b.id.cmp(&a.id)));
    #[allow(clippy::cast_precision_loss)]
    let now_ms = (now.unix_timestamp_nanos() / 1_000_000) as f64;
    apply_states(&caller.db, &user_id, items, include, now_ms).await
}

/// `GET /inbox?include=`.
pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Answer {
    let include = validate_query(query.as_deref(), |issues, fields| {
        issues
            .choice(
                fields,
                "include",
                Presence::Optional,
                &["archived", "snoozed"],
            )
            .into_option()
    })?;
    let items = build_inbox(&caller, include.as_deref()).await?;
    Ok(all(items.into_iter().map(|item| item.value).collect()))
}

/// `stateDto(row)`.
fn state_dto(row: &Value) -> Value {
    json!({
        "itemKey": row["itemKey"],
        "read": !row["readAt"].is_null(),
        "snoozedUntil": col(row, "snoozedUntil"),
        "archived": !row["archivedAt"].is_null(),
    })
}

/// `PATCH /inbox/items/:itemKey`: sets the member's read, snooze and archive
/// state of one item (created on first use); only the fields given change.
pub(crate) async fn update_item(
    caller: Caller,
    Path(item_key): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let (read, snoozed_until, archived) = validate(&headers, &body, |issues, fields| {
        let start = issues.count();
        let read = (
            issues.boolean(fields, "read", Presence::Optional),
            issues.text_with(
                fields,
                "snoozedUntil",
                Presence::Nullish,
                Text {
                    format: Some(Format::DatetimeOffset),
                    ..Text::default()
                },
            ),
            issues.boolean(fields, "archived", Presence::Optional),
        );
        nothing_to_update(issues, start, fields, &["read", "snoozedUntil", "archived"]);
        read
    })?;
    if item_key.encode_utf16().count() > MAX_ITEM_KEY {
        return Err(Refusal::bad_request("The item key is too long"));
    }
    let (_, at) = now_at();
    let set_snooze = !snoozed_until.is_absent();
    let snooze = match snoozed_until {
        Field::Set(until) => {
            js_date_parse(&until).and_then(weldsuite_kit::validation::js_iso_from_millis)
        }
        _ => None,
    };
    let read = read.into_option();
    let archived = archived.into_option();
    // A new row takes every field; an existing one only the fields sent.
    let mut changed = vec![merge_inbox_states::Column::UpdatedAt];
    if read.is_some() {
        changed.push(merge_inbox_states::Column::ReadAt);
    }
    if set_snooze {
        changed.push(merge_inbox_states::Column::SnoozedUntil);
    }
    if archived.is_some() {
        changed.push(merge_inbox_states::Column::ArchivedAt);
    }
    let row = merge_inbox_states::Entity::insert(merge_inbox_states::ActiveModel {
        id: Set(generate_id("mib")),
        user_id: Set(caller.user_id.clone()),
        item_key: Set(item_key),
        created_at: Set(at),
        updated_at: Set(at),
        read_at: Set((read == Some(true)).then_some(at)),
        snoozed_until: Set(instant_opt(snooze.as_deref())?),
        archived_at: Set((archived == Some(true)).then_some(at)),
    })
    .on_conflict(
        OnConflict::columns([
            merge_inbox_states::Column::UserId,
            merge_inbox_states::Column::ItemKey,
        ])
        .update_columns(changed)
        .to_owned(),
    )
    .exec_with_returning(&orm(&caller.db))
    .await?;
    Ok(Data(state_dto(&json_row(serde_json::to_value(row))?)).into_response())
}

/// `POST /inbox/read-all`: marks every unread item the member can see read.
pub(crate) async fn read_all(caller: Caller) -> Answer {
    let items = build_inbox(&caller, None).await?;
    let (_, at) = now_at();
    let db = orm(&caller.db);
    let mut updated = 0_u64;
    for item in items
        .iter()
        .filter(|item| item.value.get("read") != Some(&Value::Bool(true)))
    {
        merge_inbox_states::Entity::insert(merge_inbox_states::ActiveModel {
            id: Set(generate_id("mib")),
            user_id: Set(caller.user_id.clone()),
            item_key: Set(item.id.clone()),
            read_at: Set(Some(at)),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::columns([
                merge_inbox_states::Column::UserId,
                merge_inbox_states::Column::ItemKey,
            ])
            .update_columns([
                merge_inbox_states::Column::ReadAt,
                merge_inbox_states::Column::UpdatedAt,
            ])
            .to_owned(),
        )
        .exec_without_returning(&db)
        .await?;
        updated += 1;
    }
    Ok(Data(json!({ "updated": updated })).into_response())
}
