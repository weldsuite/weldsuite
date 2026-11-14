//! Responses, results and exports of one form (`routes/responses/index.ts`),
//! at `/api/forms/forms/:id/…`:
//!
//! ```text
//! GET    /:id/responses                       list (status, dates, q, version, person, invitation, answer filters, sort, cursor)
//! GET    /:id/responses/export?format=csv|xlsx
//! POST   /:id/responses/bulk-delete
//! GET    /:id/responses/:rid                  one response with its integration actions
//! DELETE /:id/responses/:rid
//! GET    /:id/responses/:rid/files/:fileId    from the private bucket
//! POST   /:id/responses/:rid/actions/:actionId/retry
//! GET    /:id/columns | /:id/summary | /:id/insights
//! ```
//!
//! Permissions: the workspace's `form_responses:read|export|delete`,
//! narrowed by the member's relation to the form (restricted form → 404).
//! Deleting publishes `form_response:deleted`.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, HeaderValue, StatusCode, header};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::FORM_RESPONSE_DELETED;
use weldsuite_catalogs::permission_keys::{
    FORM_RESPONSES_DELETE, FORM_RESPONSES_EXPORT, FORM_RESPONSES_READ, FORMS_UPDATE,
};
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text};
use weldsuite_kit::{Data, List, NoContent, Pagination};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::{Member, load_form};
use crate::FormsState;
use crate::access::Need;
use crate::common::{FormsResult, answer, form_urlencoded_component, forms_error, text};
use crate::counters::Counters;
use crate::export::export_responses;
use crate::input;
use crate::response_model::{ResponseFilter, build_columns, load_versions};
use crate::responses::{
    DeletedResponse, delete_responses, find_response_file, get_response, list_responses,
    retry_action,
};
use crate::results::{insights, summarise};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<FormsState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/forms/{id}/responses",
            get(list).route_layer(need(FORM_RESPONSES_READ)),
        )
        .route(
            "/forms/{id}/responses/export",
            get(export).route_layer(need(FORM_RESPONSES_EXPORT)),
        )
        .route(
            "/forms/{id}/responses/bulk-delete",
            post(bulk_delete).route_layer(need(FORM_RESPONSES_DELETE)),
        )
        .route(
            "/forms/{id}/responses/{rid}",
            get(one).route_layer(need(FORM_RESPONSES_READ)),
        )
        .route(
            "/forms/{id}/responses/{rid}",
            axum::routing::delete(remove).route_layer(need(FORM_RESPONSES_DELETE)),
        )
        .route(
            "/forms/{id}/responses/{rid}/files/{fileId}",
            get(file).route_layer(need(FORM_RESPONSES_READ)),
        )
        .route(
            "/forms/{id}/responses/{rid}/actions/{actionId}/retry",
            post(retry).route_layer(need(FORMS_UPDATE)),
        )
        .route(
            "/forms/{id}/columns",
            get(columns).route_layer(need(FORM_RESPONSES_READ)),
        )
        .route(
            "/forms/{id}/summary",
            get(summary).route_layer(need(FORM_RESPONSES_READ)),
        )
        .route(
            "/forms/{id}/insights",
            get(form_insights).route_layer(need(FORM_RESPONSES_READ)),
        )
}

// ── Schemas ──────────────────────────────────────────────────────────────────

fn max(max: usize) -> Text {
    Text::length(None, Some(max))
}

fn iso_date() -> Text {
    Text {
        format: Some(Format::DatetimeOffset),
        ..Text::default()
    }
}

fn opt(issues: &mut Issues, q: &Map<String, Value>, key: &str, rules: Text) -> Option<String> {
    issues
        .text_with(q, key, Presence::Optional, rules)
        .into_option()
}

/// `listFormResponsesQuerySchema` (with `cursor` and `limit`) or
/// `exportFormResponsesQuerySchema` (with `format` instead).
pub(crate) struct ListQuery {
    pub(crate) filter: ResponseFilter,
    pub(crate) sort: Option<String>,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<i64>,
    pub(crate) format: Option<String>,
}

fn list_query(issues: &mut Issues, q: &Map<String, Value>, export: bool) -> ListQuery {
    let filter = ResponseFilter {
        status: issues
            .choice(
                q,
                "status",
                Presence::Optional,
                &["completed", "in_progress", "all"],
            )
            .into_option(),
        from: opt(issues, q, "from", iso_date()),
        to: opt(issues, q, "to", iso_date()),
        q: opt(issues, q, "q", max(200)),
        version_id: opt(issues, q, "versionId", max(30)),
        person_id: opt(issues, q, "personId", max(30)),
        invitation_id: opt(issues, q, "invitationId", max(30)),
        filters: opt(issues, q, "filters", max(5000)),
    };
    let sort = issues
        .choice(
            q,
            "sort",
            Presence::Optional,
            &["newest", "oldest", "score_desc", "score_asc"],
        )
        .into_option();
    if export {
        let format = issues
            .choice(q, "format", Presence::Required, &["csv", "xlsx"])
            .into_option();
        return ListQuery {
            filter,
            sort,
            cursor: None,
            limit: None,
            format,
        };
    }
    let cursor = opt(issues, q, "cursor", max(200));
    let limit = limit_of(issues, q);
    ListQuery {
        filter,
        sort,
        cursor,
        limit,
        format: None,
    }
}

/// `z.coerce.number().int().min(1).max(200).optional()`.
pub(crate) fn limit_of(issues: &mut Issues, q: &Map<String, Value>) -> Option<i64> {
    issues
        .whole_number(
            q,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                int: true,
                min: Some(1.0),
                max: Some(200.0),
            },
        )
        .into_option()
}

/// `bulkDeleteFormResponsesSchema`: `ids`, 1 to 500 ids.
fn bulk_delete_body(issues: &mut Issues, b: &Map<String, Value>) -> Vec<String> {
    issues
        .list(
            b,
            "ids",
            Presence::Required,
            Some(1),
            Some(500),
            |issues, item| issues.item_text(item, Text::length(Some(1), Some(30))),
        )
        .into_option()
        .unwrap_or_default()
}

fn summary_query(
    issues: &mut Issues,
    q: &Map<String, Value>,
) -> (Option<String>, Option<String>, Option<String>) {
    (
        opt(issues, q, "versionId", max(30)),
        opt(issues, q, "from", iso_date()),
        opt(issues, q, "to", iso_date()),
    )
}

fn insights_query(issues: &mut Issues, q: &Map<String, Value>) -> (Option<String>, Option<String>) {
    (
        opt(issues, q, "from", iso_date()),
        opt(issues, q, "to", iso_date()),
    )
}

// ── Events and files ─────────────────────────────────────────────────────────

/// `publishDeleted(c, deleted)`: one `form_response:deleted` per response.
pub(crate) fn publish_deleted(member: &Member, deleted: &[DeletedResponse]) {
    for response in deleted {
        member.publish(FORM_RESPONSE_DELETED, &response.id, &response.data);
    }
}

/// `dropFiles(c, keys)`: the bucket keys removed after the answer, 1000 a call.
pub(crate) fn drop_files(member: &Member, keys: Vec<String>) {
    if keys.is_empty() {
        return;
    }
    let Some(files) = member.ctx.svc.files.clone() else {
        return;
    };
    member.ctx.after(async move {
        for chunk in keys.chunks(1000) {
            if let Err(error) = files.private.delete_many_boxed(chunk).await {
                tracing::warn!(%error, "forms: deleting a deleted response's files failed");
            }
        }
    });
}

/// `Content-Disposition: attachment; filename="…"; filename*=UTF-8''…`.
fn attachment(ascii_name: &str, name: &str) -> String {
    format!(
        "attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{}",
        form_urlencoded_component(name)
    )
}

/// `name.replace(/[^\x20-\x7e]|["\\]/g, '_')`, per UTF-16 code unit.
fn ascii_file_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if (' '..='~').contains(&c) && c != '"' && c != '\\' {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('_');
            }
        }
    }
    out
}

fn download(
    status: StatusCode,
    content_type: &str,
    disposition: &str,
    length: Option<i64>,
    body: Vec<u8>,
) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    let value = |text: &str| HeaderValue::from_str(text).unwrap_or(HeaderValue::from_static(""));
    headers.insert(header::CONTENT_TYPE, value(content_type));
    if let Some(length) = length {
        headers.insert(header::CONTENT_LENGTH, value(&length.to_string()));
    }
    headers.insert(header::CONTENT_DISPOSITION, value(disposition));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

// ── List and export ──────────────────────────────────────────────────────────

async fn list(member: Member, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    answer(
        async {
            let query = input::query(query.as_deref(), |issues, q| list_query(issues, q, false))?;
            let loaded = load_form(&member, &id, Some(Need::ReadResponses)).await?;
            let page = list_responses(
                &member.ctx,
                text(&loaded.form, "id"),
                &query.filter,
                query.sort.as_deref(),
                query.cursor.as_deref(),
                query.limit,
            )
            .await?;
            Ok(List::new(
                page.rows,
                Pagination::new(
                    u64::try_from(page.total).unwrap_or(0),
                    page.next.is_some(),
                    page.next,
                ),
            )
            .into_response())
        }
        .await,
    )
}

async fn export(member: Member, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    answer(
        async {
            let query = input::query(query.as_deref(), |issues, q| list_query(issues, q, true))?;
            let loaded = load_form(&member, &id, Some(Need::ExportResponses)).await?;
            let file = export_responses(
                &member.ctx,
                &loaded.form,
                query.format.as_deref().unwrap_or("csv"),
                &query.filter,
                query.sort.as_deref(),
            )
            .await?;
            Ok(download(
                StatusCode::OK,
                file.content_type,
                &attachment(&file.filename, &file.filename),
                None,
                file.body,
            ))
        }
        .await,
    )
}

async fn bulk_delete(
    member: Member,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let ids = input::json(&headers, &body, bulk_delete_body)?;
            let loaded = load_form(&member, &id, Some(Need::DeleteResponses)).await?;
            let (deleted, keys) =
                delete_responses(&member.ctx, &ids, Some(text(&loaded.form, "id"))).await?;
            drop_files(&member, keys);
            publish_deleted(&member, &deleted);
            Ok(Data(json!({ "deleted": deleted.len() })).into_response())
        }
        .await,
    )
}

// ── One response ─────────────────────────────────────────────────────────────

async fn one(member: Member, Path((id, rid)): Path<(String, String)>) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, Some(Need::ReadResponses)).await?;
            Ok(
                Data(get_response(&member.ctx, text(&loaded.form, "id"), &rid).await?)
                    .into_response(),
            )
        }
        .await,
    )
}

async fn remove(member: Member, Path((id, rid)): Path<(String, String)>) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, Some(Need::DeleteResponses)).await?;
            let (deleted, keys) =
                delete_responses(&member.ctx, &[rid], Some(text(&loaded.form, "id"))).await?;
            if deleted.is_empty() {
                return Err(forms_error(404, "NOT_FOUND", "Response not found"));
            }
            drop_files(&member, keys);
            publish_deleted(&member, &deleted);
            Ok(NoContent.into_response())
        }
        .await,
    )
}

/// Streams an uploaded file or signature: never cached, never sniffed, always a download.
async fn file(
    member: Member,
    Path((id, rid, file_id)): Path<(String, String, String)>,
) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, Some(Need::ReadResponses)).await?;
            let file =
                find_response_file(&member.ctx, text(&loaded.form, "id"), &rid, &file_id).await?;
            let object = match &member.ctx.svc.files {
                Some(files) => files.private.get_boxed(text(&file, "storageKey")).await?,
                None => None,
            };
            let Some(object) = object else {
                return Err(forms_error(
                    404,
                    "NOT_FOUND",
                    "The file is no longer available.",
                ));
            };
            let name = text(&file, "name");
            Ok(download(
                StatusCode::OK,
                text(&file, "contentType"),
                &attachment(&ascii_file_name(name), name),
                file["sizeBytes"].as_i64(),
                object.bytes,
            ))
        }
        .await,
    )
}

/// Runs the step of one integration again; the response shows it pending
/// until the run finishes.
async fn retry(
    member: Member,
    Path((id, rid, action_id)): Path<(String, String, String)>,
) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, Some(Need::Edit)).await?;
            retry_action(&member.ctx, &loaded.form, &rid, &action_id).await?;
            Ok(Data(json!({ "queued": true })).into_response())
        }
        .await,
    )
}

// ── Columns, summary, insights ───────────────────────────────────────────────

async fn columns(member: Member, Path(id): Path<String>) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, Some(Need::ReadResponses)).await?;
            let versions = load_versions(&member.ctx.db, text(&loaded.form, "id")).await?;
            let columns: Vec<Value> = build_columns(&versions)
                .iter()
                .map(crate::response_model::Column::to_json)
                .collect();
            Ok(Data(columns).into_response())
        }
        .await,
    )
}

async fn summary(member: Member, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    answer(
        async {
            let (version_id, from, to) = input::query(query.as_deref(), summary_query)?;
            let loaded = load_form(&member, &id, Some(Need::ReadResponses)).await?;
            let summary = summarise(
                &member.ctx,
                text(&loaded.form, "id"),
                version_id.as_deref(),
                from.as_deref(),
                to.as_deref(),
            )
            .await?;
            Ok(Data(summary).into_response())
        }
        .await,
    )
}

async fn form_insights(
    member: Member,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    answer(
        async {
            let (from, to): (Option<String>, Option<String>) =
                input::query(query.as_deref(), insights_query)?;
            let loaded = load_form(&member, &id, Some(Need::ReadResponses)).await?;
            let form_id = text(&loaded.form, "id");
            let counters = Counters::new(
                Arc::clone(&member.ctx.svc.cache),
                form_id,
                member.ctx.now_ms(),
            );
            let result: FormsResult<Value> = insights(
                &member.ctx,
                form_id,
                &counters,
                from.as_deref(),
                to.as_deref(),
            )
            .await;
            Ok(Data(result?).into_response())
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_names_are_ascii_and_quoted_safely() {
        assert_eq!(ascii_file_name("My CV \"final\".pdf"), "My CV _final_.pdf");
        assert_eq!(ascii_file_name("café😀"), "caf___");
        assert_eq!(
            attachment("a b.pdf", "a b.pdf"),
            "attachment; filename=\"a b.pdf\"; filename*=UTF-8''a%20b.pdf"
        );
    }
}
