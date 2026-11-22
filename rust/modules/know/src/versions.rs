//! Page version history (`know-api/src/services/knowledge-versions.ts`):
//! immutable snapshots of a page's block JSON. Autosave snapshots at most
//! every ten minutes; named versions are explicit.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, EntityTrait, FromQueryResult, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde::Serialize;
use serde_json::{Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::KNOWLEDGE_PAGE_UPDATED;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{Created, Data, generate_id};
use weldsuite_schema::tenant::{knowledge_page_versions as versions, knowledge_pages as pages};

use crate::pages::{load_page, load_writable_page, page_row};
use crate::{Caller, KnowError, KnowState, Refusal, all, minutes_ago, now, row, validate};

/// The shortest gap between two automatic snapshots of a page.
const AUTO_SNAPSHOT_MINUTES: i64 = 10;

async fn create_version(
    db: &PgPool,
    page_id: &str,
    content: &Value,
    created_by: &str,
    label: Option<&str>,
) -> Result<Value, sea_orm::DbErr> {
    let version = versions::Entity::insert(versions::ActiveModel {
        id: Set(generate_id("kver")),
        page_id: Set(page_id.to_owned()),
        content: Set(content.clone()),
        label: Set(label.map(str::to_owned)),
        created_by_id: Set(Some(created_by.to_owned())),
        created_at: Set(now()),
    })
    .exec_with_returning(&orm(db))
    .await?;
    Ok(row(version))
}

/// An automatic snapshot, unless the page has one from the last ten minutes.
pub(crate) async fn maybe_auto_snapshot(
    db: &PgPool,
    page_id: &str,
    content: &Value,
    created_by: &str,
) -> Result<(), sea_orm::DbErr> {
    let recent: Option<String> = versions::Entity::find()
        .select_only()
        .column(versions::Column::Id)
        .filter(versions::Column::PageId.eq(page_id))
        .filter(versions::Column::CreatedAt.gt(minutes_ago(AUTO_SNAPSHOT_MINUTES)))
        .into_tuple()
        .one(&orm(db))
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
) -> Result<Option<Value>, sea_orm::DbErr> {
    let version = versions::Entity::find_by_id(version_id.to_owned())
        .filter(versions::Column::PageId.eq(page_id))
        .one(&orm(db))
        .await?;
    Ok(version.map(row))
}

/// A version in the page's history: no content.
#[derive(FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionSummary {
    id: String,
    page_id: String,
    label: Option<String>,
    created_by_id: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    created_at: PrimitiveDateTime,
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
        let rows: Vec<VersionSummary> = versions::Entity::find()
            .select_only()
            .columns([
                versions::Column::Id,
                versions::Column::PageId,
                versions::Column::Label,
                versions::Column::CreatedById,
                versions::Column::CreatedAt,
            ])
            .filter(versions::Column::PageId.eq(&id))
            .order_by_desc(versions::Column::CreatedAt)
            .into_model()
            .all(&orm(&caller.db))
            .await?;
        Ok::<_, KnowError>(rows.into_iter().map(row).collect())
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
        pages::Entity::update_many()
            .col_expr(
                pages::Column::ContentJson,
                Expr::value(version["content"].clone()),
            )
            .col_expr(pages::Column::LastEditedBy, Expr::value(&caller.user_id))
            .col_expr(pages::Column::UpdatedAt, Expr::value(now()))
            .filter(pages::Column::Id.eq(&id))
            .exec(&orm(db))
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
