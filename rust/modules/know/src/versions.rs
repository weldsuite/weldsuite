//! Page version history (`know-api/src/services/knowledge-versions.ts`):
//! immutable snapshots of a page's block JSON. Autosave snapshots at most
//! every ten minutes; named versions are explicit.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::KNOWLEDGE_PAGE_UPDATED;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{Created, Data, generate_id};

use crate::pages::{load_page, load_writable_page, page_row};
use crate::{Caller, KnowError, KnowState, Refusal, all, minutes_ago, now, validate};

/// The shortest gap between two automatic snapshots of a page.
const AUTO_SNAPSHOT_MINUTES: i64 = 10;

async fn create_version(
    db: &PgPool,
    page_id: &str,
    content: &Value,
    created_by: &str,
    label: Option<&str>,
) -> Result<Value, sqlx::Error> {
    let row: Value = sqlx::query_scalar(
        "insert into knowledge_page_versions (id, page_id, content, label, created_by_id, created_at)
         values ($1, $2, $3, $4, $5, $6::timestamp)
         returning to_jsonb(knowledge_page_versions)",
    )
    .bind(generate_id("kver"))
    .bind(page_id)
    .bind(content)
    .bind(label)
    .bind(created_by)
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

/// An automatic snapshot, unless the page has one from the last ten minutes.
pub(crate) async fn maybe_auto_snapshot(
    db: &PgPool,
    page_id: &str,
    content: &Value,
    created_by: &str,
) -> Result<(), sqlx::Error> {
    let recent: Option<String> = sqlx::query_scalar(
        "select id from knowledge_page_versions
         where page_id = $1 and created_at > $2::timestamp limit 1",
    )
    .bind(page_id)
    .bind(minutes_ago(AUTO_SNAPSHOT_MINUTES))
    .fetch_optional(db)
    .await?;
    if recent.is_none() {
        create_version(db, page_id, content, created_by, None).await?;
    }
    Ok(())
}

async fn version_row(
    db: &PgPool,
    page_id: &str,
    version_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(v) from knowledge_page_versions v where id = $1 and page_id = $2 limit 1",
    )
    .bind(version_id)
    .bind(page_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// A page's content, `[]` when it has none (`page.contentJson ?? []`).
fn content_of(page: &Value) -> Value {
    match &page["contentJson"] {
        Value::Null => json!([]),
        content => content.clone(),
    }
}

// ── GET /pages/:id/versions ────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        load_page(&caller.db, &id, &caller.user_id).await?;
        let rows: Vec<Value> = sqlx::query_scalar(
            "select jsonb_build_object(
                      'id', id, 'pageId', page_id, 'label', label, 'createdById', created_by_id,
                      'createdAt', created_at)
             from knowledge_page_versions
             where page_id = $1
             order by created_at desc",
        )
        .bind(&id)
        .fetch_all(&caller.db)
        .await?;
        Ok::<_, KnowError>(rows.into_iter().map(js_row).collect())
    }
    .await;
    match result {
        Ok(rows) => all(rows),
        Err(error) => error.respond("Failed to list versions"),
    }
}

// ── POST /pages/:id/versions ───────────────────────────────────────────────

/// A named snapshot of the page as it is now.
pub(crate) async fn create(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let label = match validate(&headers, &body, |issues, fields| {
        issues.text(fields, "label", Presence::Nullish, None, Some(255))
    }) {
        Ok(label) => label.into_option(),
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let result = async {
        let page = load_writable_page(&caller.db, &id, &caller.user_id).await?;
        let row = create_version(
            &caller.db,
            &id,
            &content_of(&page),
            &caller.user_id,
            label.as_deref(),
        )
        .await?;
        Ok::<_, KnowError>(row)
    }
    .await;
    match result {
        Ok(row) => Created(row).into_response(),
        Err(error) => error.respond("Failed to create version"),
    }
}

// ── GET /pages/:id/versions/:versionId ─────────────────────────────────────

pub(crate) async fn detail(
    caller: Caller,
    Path((id, version_id)): Path<(String, String)>,
) -> Response {
    let result = async {
        load_page(&caller.db, &id, &caller.user_id).await?;
        version_row(&caller.db, &id, &version_id)
            .await?
            .ok_or_else(|| Refusal::not_found("Version", &version_id))
    }
    .await;
    match result {
        Ok(row) => Data(row).into_response(),
        Err(refusal) => refusal.respond("Failed to fetch version"),
    }
}

// ── POST /pages/:id/versions/:versionId/restore ────────────────────────────

/// Put a snapshot back on the live page, keeping a backup version of what
/// was there.
pub(crate) async fn restore(
    State(state): State<KnowState>,
    caller: Caller,
    Path((id, version_id)): Path<(String, String)>,
) -> Response {
    let result = async {
        let db = &caller.db;
        let page = load_writable_page(db, &id, &caller.user_id).await?;
        if page["isLocked"] == true {
            return Err(Refusal::conflict("Page is locked"));
        }
        let Some(version) = version_row(db, &id, &version_id).await? else {
            return Err(Refusal::not_found("Version", &version_id));
        };
        create_version(
            db,
            &id,
            &content_of(&page),
            &caller.user_id,
            Some("Before restore"),
        )
        .await?;
        sqlx::query(
            "update knowledge_pages
             set content_json = $2, last_edited_by = $3, updated_at = $4::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(&version["content"])
        .bind(&caller.user_id)
        .bind(now())
        .execute(db)
        .await?;
        caller.publish(
            &state,
            KNOWLEDGE_PAGE_UPDATED,
            &id,
            &json!({ "id": id, "spaceId": page["spaceId"], "title": page["title"] }),
        );
        Ok(page_row(db, &id).await?.unwrap_or(Value::Null))
    }
    .await;
    match result {
        Ok(row) => Data(row).into_response(),
        Err(refusal) => refusal.respond("Failed to restore version"),
    }
}
