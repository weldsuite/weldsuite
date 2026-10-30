//! Calendar access and sharing (`services/calendar-access.ts`): the calendars
//! a user may see are the ones they own and the ones shared with them.

use std::collections::HashMap;

use serde_json::{Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::generate_id;

use crate::{now, text};

/// How a user may touch a calendar (`getCalendarAccess`).
pub(crate) struct CalendarAccess {
    pub(crate) calendar: Value,
    pub(crate) is_own: bool,
    /// `view`, `edit` or `manage`; owners always `manage`.
    pub(crate) permission: String,
}

impl CalendarAccess {
    /// Owner, or a share that lets the caller edit (`canWrite`).
    pub(crate) fn can_write(&self) -> bool {
        self.is_own || self.permission == "edit" || self.permission == "manage"
    }
}

/// A calendar row by id, not deleted.
pub(crate) async fn calendar_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from calendars c where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// Every calendar id the user may read, their own first
/// (`getAccessibleCalendarIds`).
pub(crate) async fn accessible_calendar_ids(
    db: &PgPool,
    user_id: &str,
) -> Result<Vec<String>, sqlx::Error> {
    let mut ids: Vec<String> =
        sqlx::query_scalar("select id from calendars where owner_id = $1 and deleted_at is null")
            .bind(user_id)
            .fetch_all(db)
            .await?;
    let shared: Vec<String> = sqlx::query_scalar(
        "select calendar_id from calendar_shares where shared_with_id = $1 and deleted_at is null",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    ids.extend(shared);
    Ok(ids)
}

/// Ids of the calendars `user_id` owns, shares excluded (`getOwnedCalendarIds`).
pub(crate) async fn owned_calendar_ids(
    db: &PgPool,
    user_id: &str,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar("select id from calendars where owner_id = $1 and deleted_at is null")
        .bind(user_id)
        .fetch_all(db)
        .await
}

/// A `calendarIds` filter narrowed to what the user may read; everything
/// readable without one (`resolveRequestedCalendarIds`).
pub(crate) async fn resolve_requested(
    db: &PgPool,
    user_id: &str,
    requested: Option<&str>,
) -> Result<Vec<String>, sqlx::Error> {
    let accessible = accessible_calendar_ids(db, user_id).await?;
    let Some(requested) = requested.filter(|r| !r.is_empty()) else {
        return Ok(accessible);
    };
    Ok(requested
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty() && accessible.iter().any(|a| a == id))
        .map(str::to_owned)
        .collect())
}

/// The user's calendars, default first, then the ones shared with them, each
/// with `isOwn` and `permission` (`listCalendarsForUser`).
pub(crate) async fn list_for_user(db: &PgPool, user_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let shares: Vec<(String, String)> = sqlx::query_as(
        "select calendar_id, permission from calendar_shares
         where shared_with_id = $1 and deleted_at is null",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    // `new Map(...)`: the last share of a calendar wins.
    let mut permissions: HashMap<String, String> = HashMap::new();
    for (calendar_id, permission) in &shares {
        permissions.insert(calendar_id.clone(), permission.clone());
    }
    let shared_ids: Vec<String> = shares.into_iter().map(|(id, _)| id).collect();

    let own: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from calendars c
         where owner_id = $1 and deleted_at is null
         order by is_default desc, name",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let others: Vec<Value> = if shared_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar(
            "select to_jsonb(c) from calendars c
             where id = any($1) and deleted_at is null
             order by name",
        )
        .bind(&shared_ids)
        .fetch_all(db)
        .await?
    };

    let mut out = Vec::with_capacity(own.len() + others.len());
    for row in own {
        let mut row = js_row(row);
        row["isOwn"] = Value::Bool(true);
        row["permission"] = json!("manage");
        out.push(row);
    }
    for row in others {
        let mut row = js_row(row);
        let permission = permissions
            .get(text(&row, "id"))
            .cloned()
            .unwrap_or_else(|| "view".to_owned());
        row["isOwn"] = Value::Bool(false);
        row["permission"] = Value::String(permission);
        out.push(row);
    }
    Ok(out)
}

/// How `user_id` may touch the calendar, or `None` when they can't see it
/// (`getCalendarAccess`).
pub(crate) async fn calendar_access(
    db: &PgPool,
    calendar_id: &str,
    user_id: &str,
) -> Result<Option<CalendarAccess>, sqlx::Error> {
    let Some(calendar) = calendar_row(db, calendar_id).await? else {
        return Ok(None);
    };
    if text(&calendar, "ownerId") == user_id {
        return Ok(Some(CalendarAccess {
            calendar,
            is_own: true,
            permission: "manage".to_owned(),
        }));
    }
    let share: Option<String> = sqlx::query_scalar(
        "select permission from calendar_shares
         where calendar_id = $1 and shared_with_id = $2 and deleted_at is null
         limit 1",
    )
    .bind(calendar_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(share.map(|permission| CalendarAccess {
        calendar,
        is_own: false,
        permission,
    }))
}

/// The user's default calendar, created when missing; `true` when created
/// (`ensureDefaultCalendar`).
pub(crate) async fn ensure_default(
    db: &PgPool,
    user_id: &str,
) -> Result<(Value, bool), sqlx::Error> {
    let existing: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from calendars c
         where owner_id = $1 and is_default = true and deleted_at is null
         limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    if let Some(row) = existing {
        return Ok((js_row(row), false));
    }
    let now = now();
    let row: Value = sqlx::query_scalar(
        "insert into calendars (id, name, color, owner_id, is_default, is_active, created_at, updated_at)
         values ($1, 'My Calendar', '#3b82f6', $2, true, true, $3::timestamp, $3::timestamp)
         returning to_jsonb(calendars)",
    )
    .bind(generate_id("cal"))
    .bind(user_id)
    .bind(&now)
    .fetch_one(db)
    .await?;
    Ok((js_row(row), true))
}

/// Whether `user_id` is an active member of the workspace
/// (`isActiveWorkspaceMember`).
pub(crate) async fn is_active_member(db: &PgPool, user_id: &str) -> Result<bool, sqlx::Error> {
    let found: Option<String> = sqlx::query_scalar(
        "select id from workspace_members
         where user_id = $1 and status = 'ACTIVE' and deleted_at is null
         limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

/// The calendar's share rows (`listCalendarShares`).
pub(crate) async fn list_shares(db: &PgPool, calendar_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from calendar_shares s where calendar_id = $1 and deleted_at is null",
    )
    .bind(calendar_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// A share, created or with its permission updated (`upsertCalendarShare`):
/// `(id, created)`.
pub(crate) async fn upsert_share(
    db: &PgPool,
    calendar_id: &str,
    shared_with_id: &str,
    permission: &str,
    shared_by_id: &str,
) -> Result<(String, bool), sqlx::Error> {
    let existing: Option<String> = sqlx::query_scalar(
        "select id from calendar_shares
         where calendar_id = $1 and shared_with_id = $2 and deleted_at is null
         limit 1",
    )
    .bind(calendar_id)
    .bind(shared_with_id)
    .fetch_optional(db)
    .await?;
    let now = now();
    if let Some(id) = existing {
        sqlx::query(
            "update calendar_shares set permission = $2, updated_at = $3::timestamp where id = $1",
        )
        .bind(&id)
        .bind(permission)
        .bind(&now)
        .execute(db)
        .await?;
        return Ok((id, false));
    }
    let id = generate_id("csh");
    sqlx::query(
        "insert into calendar_shares
             (id, calendar_id, shared_with_id, permission, shared_by_id, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6::timestamp, $6::timestamp)",
    )
    .bind(&id)
    .bind(calendar_id)
    .bind(shared_with_id)
    .bind(permission)
    .bind(shared_by_id)
    .bind(&now)
    .execute(db)
    .await?;
    Ok((id, true))
}

/// Soft-delete a share of this calendar (`removeCalendarShare`).
pub(crate) async fn remove_share(
    db: &PgPool,
    calendar_id: &str,
    share_id: &str,
) -> Result<(), sqlx::Error> {
    let now = now();
    sqlx::query(
        "update calendar_shares set deleted_at = $3::timestamp, updated_at = $3::timestamp
         where id = $1 and calendar_id = $2",
    )
    .bind(share_id)
    .bind(calendar_id)
    .bind(&now)
    .execute(db)
    .await?;
    Ok(())
}
