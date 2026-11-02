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
use serde_json::{Map, Value, json};
use weldsuite_db::js_row;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{
    Caller, CorePlatformState, PlatformError, PlatformResult, answer, now, validate, validate_query,
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
            let master = caller.master(&state);
            let rows: Vec<Value> = match sort.as_str() {
                "newest" => {
                    sqlx::query_scalar(
                        "select to_jsonb(f) from feature_requests f
                         where ($1::text is null or f.type::text = $1::text)
                         order by f.created_at desc, f.id desc",
                    )
                    .bind(&kind)
                    .fetch_all(&master)
                    .await
                }
                "oldest" => {
                    sqlx::query_scalar(
                        "select to_jsonb(f) from feature_requests f
                         where ($1::text is null or f.type::text = $1::text)
                         order by f.created_at asc, f.id desc",
                    )
                    .bind(&kind)
                    .fetch_all(&master)
                    .await
                }
                _ => {
                    sqlx::query_scalar(
                        "select to_jsonb(f) from feature_requests f
                         where ($1::text is null or f.type::text = $1::text)
                         order by f.vote_count desc, f.id desc",
                    )
                    .bind(&kind)
                    .fetch_all(&master)
                    .await
                }
            }
            .map_err(|e| failed(&e))?;
            let mut out = Vec::with_capacity(rows.len());
            for row in rows {
                let row = js_row(row);
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
    let rows: Result<Vec<(String, String)>, sqlx::Error> =
        sqlx::query_as("select status::text, type::text from feature_requests")
            .fetch_all(&caller.master(&state))
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
        let slot = match status.as_str() {
            "open" => Some(0),
            "under_review" => Some(1),
            "planned" => Some(2),
            "in_progress" => Some(3),
            "completed" => Some(4),
            "declined" => Some(5),
            _ => None,
        };
        if let Some(slot) = slot {
            counts[slot] += 1;
        }
        let slot = match kind.as_str() {
            "feature" => Some(6),
            "bug" => Some(7),
            "improvement" => Some(8),
            _ => None,
        };
        if let Some(slot) = slot {
            counts[slot] += 1;
        }
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
    let member: Result<Option<MemberRow>, sqlx::Error> = sqlx::query_as(
        "select name, email from workspace_members
             where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(&caller.user_id)
    .fetch_optional(&caller.db)
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
            let created: Value = sqlx::query_scalar(
                "insert into feature_requests as f
                   (id, title, description, type, submitter_id, submitter_name, submitter_email)
                 values ($1, $2, $3, $4::text::feature_type, $5, $6, $7)
                 returning to_jsonb(f)",
            )
            .bind(generate_id("freq"))
            .bind(&title)
            .bind(&description)
            .bind(&kind)
            .bind(&caller.user_id)
            .bind(&name)
            .bind(&email)
            .fetch_one(&caller.master(&state))
            .await
            .map_err(|e| PlatformError::internal("Failed to submit feature request", e))?;
            let mut created = js_row(created);
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
    let master = caller.master(state);
    let voters: Option<Option<Value>> =
        sqlx::query_scalar("select voters from feature_requests where id = $1 limit 1")
            .bind(id)
            .fetch_optional(&master)
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
    let updated: Option<(i32, Option<Value>)> = sqlx::query_as(
        "update feature_requests
         set voters = $2::jsonb, vote_count = $3, updated_at = $4::timestamptz
         where id = $1
         returning vote_count, voters",
    )
    .bind(id)
    .bind(Value::Array(next.clone()).to_string())
    .bind(i32::try_from(next.len()).unwrap_or(i32::MAX))
    .bind(now())
    .fetch_optional(&master)
    .await
    .map_err(|e| failed(&e))?;
    let (vote_count, voters) = match updated {
        Some((count, Some(voters))) => (json!(count), voters),
        Some((count, None)) => (json!(count), Value::Array(next)),
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
