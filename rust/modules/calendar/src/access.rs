//! Calendar access and sharing (`services/calendar-access.ts`): the calendars
//! a user may see are the ones they own and the ones shared with them.

use std::collections::HashMap;

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{calendar_shares, calendars, workspace_members};

use crate::{now, text};

/// A row as the API returns it: the entity serializes as Drizzle did.
pub(crate) fn row_json<M: serde::Serialize>(model: M) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

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
pub(crate) async fn calendar_row(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    calendars::Entity::find()
        .filter(calendars::Column::Id.eq(id))
        .filter(calendars::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// Every calendar id the user may read, their own first
/// (`getAccessibleCalendarIds`).
pub(crate) async fn accessible_calendar_ids(
    db: &PgPool,
    user_id: &str,
) -> Result<Vec<String>, DbErr> {
    let mut ids = owned_calendar_ids(db, user_id).await?;
    let shared: Vec<String> = calendar_shares::Entity::find()
        .select_only()
        .column(calendar_shares::Column::CalendarId)
        .filter(calendar_shares::Column::SharedWithId.eq(user_id))
        .filter(calendar_shares::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    ids.extend(shared);
    Ok(ids)
}

/// Ids of the calendars `user_id` owns, shares excluded (`getOwnedCalendarIds`).
pub(crate) async fn owned_calendar_ids(db: &PgPool, user_id: &str) -> Result<Vec<String>, DbErr> {
    calendars::Entity::find()
        .select_only()
        .column(calendars::Column::Id)
        .filter(calendars::Column::OwnerId.eq(user_id))
        .filter(calendars::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await
}

/// A `calendarIds` filter narrowed to what the user may read; everything
/// readable without one (`resolveRequestedCalendarIds`).
pub(crate) async fn resolve_requested(
    db: &PgPool,
    user_id: &str,
    requested: Option<&str>,
) -> Result<Vec<String>, DbErr> {
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
pub(crate) async fn list_for_user(db: &PgPool, user_id: &str) -> Result<Vec<Value>, DbErr> {
    let shares: Vec<(String, String)> = calendar_shares::Entity::find()
        .select_only()
        .columns([
            calendar_shares::Column::CalendarId,
            calendar_shares::Column::Permission,
        ])
        .filter(calendar_shares::Column::SharedWithId.eq(user_id))
        .filter(calendar_shares::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    // `new Map(...)`: the last share of a calendar wins.
    let mut permissions: HashMap<String, String> = HashMap::new();
    for (calendar_id, permission) in &shares {
        permissions.insert(calendar_id.clone(), permission.clone());
    }
    let shared_ids: Vec<String> = shares.into_iter().map(|(id, _)| id).collect();

    let own = calendars::Entity::find()
        .filter(calendars::Column::OwnerId.eq(user_id))
        .filter(calendars::Column::DeletedAt.is_null())
        .order_by_desc(calendars::Column::IsDefault)
        .order_by_asc(calendars::Column::Name)
        .all(&orm(db))
        .await?;
    let others = if shared_ids.is_empty() {
        Vec::new()
    } else {
        calendars::Entity::find()
            .filter(calendars::Column::Id.is_in(shared_ids))
            .filter(calendars::Column::DeletedAt.is_null())
            .order_by_asc(calendars::Column::Name)
            .all(&orm(db))
            .await?
    };

    let mut out = Vec::with_capacity(own.len() + others.len());
    for row in own {
        let mut row = row_json(row)?;
        row["isOwn"] = Value::Bool(true);
        row["permission"] = json!("manage");
        out.push(row);
    }
    for row in others {
        let mut row = row_json(row)?;
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
) -> Result<Option<CalendarAccess>, DbErr> {
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
    let share: Option<String> = calendar_shares::Entity::find()
        .select_only()
        .column(calendar_shares::Column::Permission)
        .filter(calendar_shares::Column::CalendarId.eq(calendar_id))
        .filter(calendar_shares::Column::SharedWithId.eq(user_id))
        .filter(calendar_shares::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(share.map(|permission| CalendarAccess {
        calendar,
        is_own: false,
        permission,
    }))
}

/// The user's default calendar, created when missing; `true` when created
/// (`ensureDefaultCalendar`).
pub(crate) async fn ensure_default(db: &PgPool, user_id: &str) -> Result<(Value, bool), DbErr> {
    let existing = calendars::Entity::find()
        .filter(calendars::Column::OwnerId.eq(user_id))
        .filter(calendars::Column::IsDefault.eq(true))
        .filter(calendars::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    if let Some(row) = existing {
        return Ok((row_json(row)?, false));
    }
    let now = now();
    let row = calendars::Entity::insert(calendars::ActiveModel {
        id: Set(generate_id("cal")),
        name: Set("My Calendar".to_owned()),
        color: Set(Some("#3b82f6".to_owned())),
        owner_id: Set(user_id.to_owned()),
        is_default: Set(Some(true)),
        is_active: Set(Some(true)),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    Ok((row_json(row)?, true))
}

/// Whether `user_id` is an active member of the workspace
/// (`isActiveWorkspaceMember`).
pub(crate) async fn is_active_member(db: &PgPool, user_id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::Id)
        .filter(workspace_members::Column::UserId.eq(user_id))
        .filter(workspace_members::Column::Status.eq("ACTIVE"))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

/// The calendar's share rows (`listCalendarShares`).
pub(crate) async fn list_shares(db: &PgPool, calendar_id: &str) -> Result<Vec<Value>, DbErr> {
    calendar_shares::Entity::find()
        .filter(calendar_shares::Column::CalendarId.eq(calendar_id))
        .filter(calendar_shares::Column::DeletedAt.is_null())
        .all(&orm(db))
        .await?
        .into_iter()
        .map(row_json)
        .collect()
}

/// A share, created or with its permission updated (`upsertCalendarShare`):
/// `(id, created)`.
pub(crate) async fn upsert_share(
    db: &PgPool,
    calendar_id: &str,
    shared_with_id: &str,
    permission: &str,
    shared_by_id: &str,
) -> Result<(String, bool), DbErr> {
    let existing: Option<String> = calendar_shares::Entity::find()
        .select_only()
        .column(calendar_shares::Column::Id)
        .filter(calendar_shares::Column::CalendarId.eq(calendar_id))
        .filter(calendar_shares::Column::SharedWithId.eq(shared_with_id))
        .filter(calendar_shares::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let now = now();
    if let Some(id) = existing {
        calendar_shares::Entity::update_many()
            .col_expr(
                calendar_shares::Column::Permission,
                Expr::value(permission.to_owned()),
            )
            .col_expr(calendar_shares::Column::UpdatedAt, Expr::value(now))
            .filter(calendar_shares::Column::Id.eq(&id))
            .exec(&orm(db))
            .await?;
        return Ok((id, false));
    }
    let id = generate_id("csh");
    calendar_shares::Entity::insert(calendar_shares::ActiveModel {
        id: Set(id.clone()),
        calendar_id: Set(calendar_id.to_owned()),
        shared_with_id: Set(shared_with_id.to_owned()),
        permission: Set(permission.to_owned()),
        shared_by_id: Set(shared_by_id.to_owned()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    Ok((id, true))
}

/// Soft-delete a share of this calendar (`removeCalendarShare`).
pub(crate) async fn remove_share(
    db: &PgPool,
    calendar_id: &str,
    share_id: &str,
) -> Result<(), DbErr> {
    let now = now();
    calendar_shares::Entity::update_many()
        .col_expr(calendar_shares::Column::DeletedAt, Expr::value(now))
        .col_expr(calendar_shares::Column::UpdatedAt, Expr::value(now))
        .filter(calendar_shares::Column::Id.eq(share_id))
        .filter(calendar_shares::Column::CalendarId.eq(calendar_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}
