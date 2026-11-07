//! Labels and assignees across the seam (`services/issue-sync/people.ts`).
//! Labels match by name (case-insensitive); a provider label WeldMerge does
//! not have is created as a label of the issue's team. An assignee matches
//! through the member's linked provider account.

use serde_json::{Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::generate_id;

use crate::db::{opt_text, text};
use crate::teams::find_team;
use crate::{PendingEvent, now};

/// `createLabel(db, { teamId, name })`: `None` when the team is gone or the
/// name is taken.
async fn create_label(
    db: &PgPool,
    team_id: &str,
    name: &str,
) -> Result<Option<Value>, sqlx::Error> {
    if find_team(db, team_id).await?.is_none() {
        return Ok(None);
    }
    let name = weldsuite_kit::validation::js_trim(name);
    let taken: Option<String> = sqlx::query_scalar(
        "select id from merge_labels where deleted_at is null and team_id = $1 and lower(name) = $2 limit 1",
    )
    .bind(team_id)
    .bind(name.to_lowercase())
    .fetch_optional(db)
    .await?;
    if taken.is_some() {
        return Ok(None);
    }
    let row: Value = sqlx::query_scalar(
        "insert into merge_labels (id, team_id, name, color, created_at, updated_at) \
         values ($1, $2, $3, null, $4::timestamptz, $4::timestamptz) returning to_jsonb(merge_labels.*)",
    )
    .bind(generate_id("mlb"))
    .bind(team_id)
    .bind(name)
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(Some(js_row(row)))
}

/// `resolveLabelIds(db, teamId, names)`: WeldMerge label ids for provider
/// label names, creating the missing ones as team labels (with their
/// `merge_label` created events).
pub(crate) async fn resolve_label_ids(
    db: &PgPool,
    team_id: &str,
    names: &[String],
) -> Result<(Vec<String>, Vec<PendingEvent>), sqlx::Error> {
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
    let existing: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(l) from merge_labels l where l.deleted_at is null \
         and (l.team_id = $1 or l.team_id is null) and lower(l.name) = any($2)",
    )
    .bind(team_id)
    .bind(&lowers)
    .fetch_all(db)
    .await?;
    let existing: Vec<Value> = existing.into_iter().map(js_row).collect();
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
) -> Result<Vec<String>, sqlx::Error> {
    if label_ids.is_empty() {
        return Ok(Vec::new());
    }
    sqlx::query_scalar("select name from merge_labels where id = any($1) and deleted_at is null")
        .bind(label_ids)
        .fetch_all(db)
        .await
}

/// `memberForLogin(db, provider, host, login)`.
pub(crate) async fn member_for_login(
    db: &PgPool,
    provider: &str,
    host: Option<&str>,
    login: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select user_id from merge_provider_accounts where provider = $1 \
         and (case when $2::text is null then host is null else host = $2 end) and login = $3 limit 1",
    )
    .bind(provider)
    .bind(host)
    .bind(login.to_lowercase())
    .fetch_optional(db)
    .await
}

/// `loginForMember(db, provider, host, userId)`.
pub(crate) async fn login_for_member(
    db: &PgPool,
    provider: &str,
    host: Option<&str>,
    user_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select login from merge_provider_accounts where provider = $1 \
         and (case when $2::text is null then host is null else host = $2 end) and user_id = $3 limit 1",
    )
    .bind(provider)
    .bind(host)
    .bind(user_id)
    .fetch_optional(db)
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
) -> Result<Option<String>, sqlx::Error> {
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
