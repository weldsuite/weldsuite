//! `/api/feature-requests` (`app-api/src/routes/feature-requests`): the
//! product feedback board, in the master `feature_requests` table and global
//! across workspaces. Every route takes the baseline `general:read`: any
//! member may browse, submit and vote. No entity events (`feature_request`
//! is not in the catalog, and the table is outside every tenant).
//!
//! The list projects its columns: the submitter's email and id, the admin
//! notes and the voters of other people's requests never leave the server;
//! `voters` is read only to answer `hasVoted`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveEnum, ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::master::enums::{FeatureStatus, FeatureType};
use weldsuite_schema::master::feature_requests::{self, Column};
use weldsuite_schema::tenant::workspace_members;

use crate::{
    Caller, CorePlatformState, PlatformError, PlatformResult, answer, validate, validate_query,
};

const TYPES: [&str; 3] = ["feature", "bug", "improvement"];
const SORTS: [&str; 3] = ["votes", "newest", "oldest"];

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CorePlatformState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require(["general:read"]);
    Router::new()
        .route("/", get(list).post(create).route_layer(read()))
        .route("/stats", get(stats).route_layer(read()))
        .route("/{id}/vote", post(vote).route_layer(read()))
}

/// `(voters || []).includes(userId)`: an array holds the id, a string
/// contains it; anything else throws in JavaScript (`None`).
fn has_voted(voters: Option<&Value>, user_id: &str) -> Option<bool> {
    match voters {
        None | Some(Value::Null | Value::Bool(false)) => Some(false),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => Some(false),
        Some(Value::String(text)) if text.is_empty() => Some(false),
        Some(Value::Array(items)) => Some(items.iter().any(|item| item == user_id)),
        Some(Value::String(text)) => Some(text.contains(user_id)),
        Some(_) => None,
    }
}

/// `GET /?type=&sortBy=`: the board, with the caller's vote on each.
async fn list(
    State(state): State<CorePlatformState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    answer(
        async {
            let (kind, sort) = validate_query(query.as_deref(), |issues, values| {
                let kind = issues.choice(values, "type", Presence::Optional, &TYPES);
                let sort = issues.choice(values, "sortBy", Presence::Optional, &SORTS);
                (
                    kind.into_option(),
                    sort.into_option().unwrap_or_else(|| "votes".to_owned()),
                )
            })?;
            let failed = |e: &dyn std::fmt::Display| {
                PlatformError::internal("Failed to fetch feature requests", e.to_string())
            };
            let mut select = feature_requests::Entity::find();
            if let Some(kind) = &kind {
                let kind = FeatureType::try_from_value(kind).map_err(|e| failed(&e))?;
                select = select.filter(Column::Type.eq(kind));
            }
            let select = match sort.as_str() {
                "newest" => select.order_by_desc(Column::CreatedAt),
                "oldest" => select.order_by_asc(Column::CreatedAt),
                _ => select.order_by_desc(Column::VoteCount),
            };
            let rows = select
                .order_by_desc(Column::Id)
                .all(&orm(&caller.master(&state)))
                .await
                .map_err(|e| failed(&e))?;
            let mut out = Vec::with_capacity(rows.len());
            for row in rows {
                let row = serde_json::to_value(row).map_err(|e| failed(&e))?;
                let voted = has_voted(row.get("voters"), &caller.user_id)
                    .ok_or_else(|| failed(&"voters is not a list"))?;
                let mut item = Map::new();
                for key in [
                    "id",
                    "title",
                    "description",
                    "type",
                    "status",
                    "voteCount",
                    "submitterName",
                    "createdAt",
                    "updatedAt",
                    "completedAt",
                ] {
                    item.insert(key.to_owned(), row.get(key).cloned().unwrap_or(Value::Null));
                }
                item.insert("hasVoted".to_owned(), Value::Bool(voted));
                out.push(Value::Object(item));
            }
            Ok(Data(out).into_response())
        }
        .await,
    )
}

/// `GET /stats`: totals by status and type.
async fn stats(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    let rows: Result<Vec<(FeatureStatus, FeatureType)>, DbErr> =
        feature_requests::Entity::find()
            .select_only()
            .columns([Column::Status, Column::Type])
            .into_tuple()
            .all(&orm(&caller.master(&state)))
            .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => {
            return PlatformError::internal("Failed to fetch feature request stats", error)
                .respond();
        }
    };
    let mut counts = [0u64; 9];
    for (status, kind) in &rows {
        let slot = match status {
            FeatureStatus::Open => 0,
            FeatureStatus::UnderReview => 1,
            FeatureStatus::Planned => 2,
            FeatureStatus::InProgress => 3,
            FeatureStatus::Completed => 4,
            FeatureStatus::Declined => 5,
        };
        counts[slot] += 1;
        let slot = match kind {
            FeatureType::Feature => 6,
            FeatureType::Bug => 7,
            FeatureType::Improvement => 8,
        };
        counts[slot] += 1;
    }
    Data(json!({
        "total": rows.len(),
        "open": counts[0],
        "underReview": counts[1],
        "planned": counts[2],
        "inProgress": counts[3],
        "completed": counts[4],
        "declined": counts[5],
        "features": counts[6],
        "bugs": counts[7],
        "improvements": counts[8],
    }))
    .into_response()
}

/// `createFeatureRequestSchema`.
fn read_create(issues: &mut Issues, body: &Map<String, Value>) -> (String, String, String) {
    let from = issues.count();
    let title = issues.text(body, "title", Presence::Required, Some(1), Some(500));
    issues.custom_message(from, "too_small", "Title is required");
    let from = issues.count();
    let description = issues.text(body, "description", Presence::Required, Some(1), None);
    issues.custom_message(from, "too_small", "Description is required");
    let kind = issues.choice(body, "type", Presence::Optional, &TYPES);
    (
        title.into_option().unwrap_or_default(),
        description.into_option().unwrap_or_default(),
        kind.into_option().unwrap_or_else(|| "feature".to_owned()),
    )
}

/// A member's name and email.
type MemberRow = (Option<String>, Option<String>);

/// The submitter's name and email from their tenant member row, best effort:
/// feedback never fails on it.
async fn submitter(caller: &Caller) -> (String, String) {
    let member: Result<Option<MemberRow>, DbErr> = workspace_members::Entity::find()
        .select_only()
        .columns([
            workspace_members::Column::Name,
            workspace_members::Column::Email,
        ])
        .filter(workspace_members::Column::UserId.eq(&caller.user_id))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
        .await;
    let (name, email) = match member {
        Ok(Some((name, email))) => (name, email),
        Ok(None) => (None, None),
        Err(error) => {
            tracing::warn!(%error, "feature requests: submitter lookup failed");
            (None, None)
        }
    };
    (
        name.filter(|n| !n.is_empty())
            .unwrap_or_else(|| "Unknown".to_owned()),
        email.filter(|e| !e.is_empty()).unwrap_or_default(),
    )
}

/// `POST /`: submit a request.
async fn create(
    State(state): State<CorePlatformState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (title, description, kind) = validate(&headers, &body, read_create)?;
            let (name, email) = submitter(&caller).await;
            let failed = |e: DbErr| PlatformError::internal("Failed to submit feature request", e);
            let request = feature_requests::ActiveModel {
                id: Set(generate_id("freq")),
                title: Set(title),
                description: Set(description),
                type_: Set(FeatureType::try_from_value(&kind).map_err(failed)?),
                submitter_id: Set(caller.user_id.clone()),
                submitter_name: Set(name),
                submitter_email: Set(email),
                ..Default::default()
            };
            let created = feature_requests::Entity::insert(request)
                .exec_with_returning(&orm(&caller.master(&state)))
                .await
                .map_err(failed)?;
            let mut created = serde_json::to_value(created)
                .map_err(|e| failed(DbErr::Json(e.to_string())))?;
            created["hasVoted"] = Value::Bool(false);
            Ok(Created(created).into_response())
        }
        .await,
    )
}

/// `POST /:id/vote`: toggle the caller's vote.
async fn vote(
    State(state): State<CorePlatformState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(vote_on(&state, &caller, &id).await)
}

async fn vote_on(state: &CorePlatformState, caller: &Caller, id: &str) -> PlatformResult<Response> {
    let failed =
        |e: &dyn std::fmt::Display| PlatformError::internal("Failed to vote", e.to_string());
    let master = orm(&caller.master(state));
    let voters: Option<Option<Value>> = feature_requests::Entity::find()
        .select_only()
        .column(Column::Voters)
        .filter(Column::Id.eq(id))
        .into_tuple()
        .one(&master)
        .await
        .map_err(|e| failed(&e))?;
    let Some(voters) = voters else {
        return Err(ApiError::not_found("Feature request", Some(id)).into());
    };
    // `request.voters || []`; only a list can be filtered and spread.
    let voters = match voters {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(failed(&"voters is not a list")),
    };
    let had_voted = voters.iter().any(|v| v == caller.user_id.as_str());
    let next: Vec<Value> = if had_voted {
        voters
            .into_iter()
            .filter(|v| v != caller.user_id.as_str())
            .collect()
    } else {
        let mut next = voters;
        next.push(Value::String(caller.user_id.clone()));
        next
    };
    let updated = feature_requests::Entity::update_many()
        .col_expr(Column::Voters, Expr::value(Value::Array(next.clone())))
        .col_expr(
            Column::VoteCount,
            Expr::value(i32::try_from(next.len()).unwrap_or(i32::MAX)),
        )
        .col_expr(Column::UpdatedAt, Expr::value(utc_now().assume_utc()))
        .filter(Column::Id.eq(id))
        .exec_with_returning(&master)
        .await
        .map_err(|e| failed(&e))?
        .into_iter()
        .next();
    let (vote_count, voters) = match updated {
        Some(feature_requests::Model {
            vote_count,
            voters: Some(voters),
            ..
        }) => (json!(vote_count), voters),
        Some(row) => (json!(row.vote_count), Value::Array(next)),
        None => (json!(next.len()), Value::Array(next)),
    };
    Ok(Data(json!({
        "voteCount": vote_count,
        "voters": voters,
        "hasVoted": !had_voted,
    }))
    .into_response())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn has_voted_reads_voters_as_javascript_does() {
        assert_eq!(has_voted(None, "u1"), Some(false));
        assert_eq!(has_voted(Some(&json!(null)), "u1"), Some(false));
        assert_eq!(has_voted(Some(&json!(["u0", "u1"])), "u1"), Some(true));
        assert_eq!(has_voted(Some(&json!(["u0"])), "u1"), Some(false));
        assert_eq!(has_voted(Some(&json!("xu1x")), "u1"), Some(true));
        assert_eq!(has_voted(Some(&json!({ "u1": true })), "u1"), None);
    }

    #[test]
    fn bodies_read_like_zod() {
        let body = json!({ "title": "", "description": "", "type": null });
        let mut issues = Issues::default();
        let _ = read_create(&mut issues, body.as_object().expect("an object"));
        let Err(invalid) = issues.finish() else {
            panic!("expected issues");
        };
        let flat = invalid.flatten();
        assert_eq!(flat["fieldErrors"]["title"], json!(["Title is required"]));
        assert_eq!(
            flat["fieldErrors"]["description"],
            json!(["Description is required"])
        );
        assert_eq!(
            flat["fieldErrors"]["type"],
            json!(["Expected 'feature' | 'bug' | 'improvement', received null"])
        );
    }
}
