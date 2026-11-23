//! Labels and assignees across the seam (`services/issue-sync/people.ts`).
//! Labels match by name (case-insensitive); a provider label WeldMerge does
//! not have is created as a label of the issue's team. An assignee matches
//! through the member's linked provider account.

use sea_orm::ActiveValue::Set;
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{merge_labels, merge_provider_accounts};

use crate::PendingEvent;
use crate::db::{json_rows, now_at, opt_text, same_or_null, text};
use crate::labels::{label_row, lower_name};
use crate::teams::find_team;

/// `createLabel(db, { teamId, name })`: `None` when the team is gone or the
/// name is taken.
async fn create_label(
    db: &PgPool,
    team_id: &str,
    name: &str,
) -> Result<Option<Value>, DbErr> {
    if find_team(db, team_id).await?.is_none() {
        return Ok(None);
    }
    let name = weldsuite_kit::validation::js_trim(name);
    let db = orm(db);
    let taken = merge_labels::Entity::find()
        .select_only()
        .column(merge_labels::Column::Id)
        .filter(merge_labels::Column::DeletedAt.is_null())
        .filter(merge_labels::Column::TeamId.eq(team_id))
        .filter(sea_orm::ExprTrait::eq(lower_name(), name.to_lowercase()))
        .into_tuple::<String>()
        .one(&db)
        .await?;
    if taken.is_some() {
        return Ok(None);
    }
    let (_, at) = now_at();
    let row = merge_labels::Entity::insert(merge_labels::ActiveModel {
        id: Set(generate_id("mlb")),
        team_id: Set(Some(team_id.to_owned())),
        name: Set(name.to_owned()),
        color: Set(None),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    })
    .exec_with_returning(&db)
    .await?;
    label_row(row).map(Some)
}

/// `resolveLabelIds(db, teamId, names)`: WeldMerge label ids for provider
/// label names, creating the missing ones as team labels (with their
/// `merge_label` created events).
pub(crate) async fn resolve_label_ids(
    db: &PgPool,
    team_id: &str,
    names: &[String],
) -> Result<(Vec<String>, Vec<PendingEvent>), DbErr> {
    // `new Map(names.map(n => [n.toLowerCase(), n]))`: first position, last name.
    let mut wanted: Vec<(String, String)> = Vec::new();
    for name in names.iter().filter(|n| !n.is_empty()) {
        let lower = name.to_lowercase();
        match wanted.iter_mut().find(|(key, _)| *key == lower) {
            Some(entry) => entry.1.clone_from(name),
            None => wanted.push((lower, name.clone())),
        }
    }
    if wanted.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let lowers: Vec<String> = wanted.iter().map(|(lower, _)| lower.clone()).collect();
    let existing: Vec<Value> = json_rows(
        merge_labels::Entity::find()
            .filter(merge_labels::Column::DeletedAt.is_null())
            .filter(
                Condition::any()
                    .add(merge_labels::Column::TeamId.eq(team_id))
                    .add(merge_labels::Column::TeamId.is_null()),
            )
            .filter(sea_orm::ExprTrait::is_in(lower_name(), lowers))
            .all(&orm(db))
            .await?
            .into_iter()
            .map(serde_json::to_value),
    )?;
    // The team's own label wins over a workspace-wide one of the same name.
    let mut by_name: Vec<(String, String)> = Vec::new();
    let mut set = |name: String, id: String| match by_name.iter_mut().find(|(n, _)| *n == name) {
        Some(entry) => entry.1 = id,
        None => by_name.push((name, id)),
    };
    for label in existing.iter().filter(|l| l["teamId"].is_null()) {
        set(
            text(label, "name").to_lowercase(),
            text(label, "id").to_owned(),
        );
    }
    for label in existing.iter().filter(|l| !l["teamId"].is_null()) {
        set(
            text(label, "name").to_lowercase(),
            text(label, "id").to_owned(),
        );
    }
    let mut ids = Vec::new();
    let mut events = Vec::new();
    for (lower, name) in wanted {
        let found = by_name
            .iter()
            .find(|(n, _)| *n == lower)
            .map(|(_, id)| id.clone());
        let id = if let Some(id) = found {
            id
        } else {
            let short: String = name.chars().take(100).collect();
            let Some(created) = create_label(db, team_id, &short).await? else {
                continue;
            };
            let id = text(&created, "id").to_owned();
            events.push(PendingEvent::new(
                "merge_label",
                "created",
                &id,
                json!({ "id": id, "teamId": team_id, "name": created["name"] }),
            ));
            id
        };
        ids.push(id);
    }
    Ok((ids, events))
}

/// `labelNames(db, labelIds)`: the names of labels, for pushing to the
/// provider; labels that no longer exist are left out.
pub(crate) async fn label_names(
    db: &PgPool,
    label_ids: &[String],
) -> Result<Vec<String>, DbErr> {
    if label_ids.is_empty() {
        return Ok(Vec::new());
    }
    merge_labels::Entity::find()
        .select_only()
        .column(merge_labels::Column::Name)
        .filter(merge_labels::Column::Id.is_in(label_ids.iter().map(String::as_str)))
        .filter(merge_labels::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await
}

/// `memberForLogin(db, provider, host, login)`.
pub(crate) async fn member_for_login(
    db: &PgPool,
    provider: &str,
    host: Option<&str>,
    login: &str,
) -> Result<Option<String>, DbErr> {
    merge_provider_accounts::Entity::find()
        .select_only()
        .column(merge_provider_accounts::Column::UserId)
        .filter(merge_provider_accounts::Column::Provider.eq(provider))
        .filter(same_or_null(merge_provider_accounts::Column::Host, host))
        .filter(merge_provider_accounts::Column::Login.eq(login.to_lowercase()))
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `loginForMember(db, provider, host, userId)`.
pub(crate) async fn login_for_member(
    db: &PgPool,
    provider: &str,
    host: Option<&str>,
    user_id: &str,
) -> Result<Option<String>, DbErr> {
    merge_provider_accounts::Entity::find()
        .select_only()
        .column(merge_provider_accounts::Column::Login)
        .filter(merge_provider_accounts::Column::Provider.eq(provider))
        .filter(same_or_null(merge_provider_accounts::Column::Host, host))
        .filter(merge_provider_accounts::Column::UserId.eq(user_id))
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `resolveAssignee(db, provider, host, providerLogin, currentUserId)`: a
/// provider assignee with no linked member leaves the current one alone; no
/// provider assignee clears the current one only when it is a member with a
/// linked account.
pub(crate) async fn resolve_assignee(
    db: &PgPool,
    provider: &str,
    host: Option<&str>,
    provider_login: Option<&str>,
    current_user_id: Option<&str>,
) -> Result<Option<String>, DbErr> {
    if let Some(login) = provider_login.filter(|l| !l.is_empty()) {
        return Ok(member_for_login(db, provider, host, login)
            .await?
            .or_else(|| current_user_id.map(str::to_owned)));
    }
    let Some(current) = current_user_id else {
        return Ok(None);
    };
    Ok(
        if login_for_member(db, provider, host, current)
            .await?
            .is_some()
        {
            None
        } else {
            Some(current.to_owned())
        },
    )
}

/// The connection's host, as the account lookups match it.
pub(crate) fn host_of(connection: &Value) -> Option<String> {
    opt_text(connection, "host")
}
