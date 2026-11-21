//! Cross-form routes (`routes/cross/index.ts`), at `/api/forms/*`:
//!
//! ```text
//! GET  /responses?personId=   a CRM person's responses across the forms the member may read
//! POST /erase                 GDPR: every response (and its files) of one respondent email
//! ```
//!
//! Both stop at the forms the member can see and holds the right on (a
//! restricted form they are not on is not there for them).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::RawQuery;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::{FORM_RESPONSES_DELETE, FORM_RESPONSES_READ};
use weldsuite_kit::validation::{Format, Issues, Presence, Text};
use weldsuite_kit::{Data, List, Pagination};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::Member;
use super::responses::{drop_files, limit_of, publish_deleted};
use crate::FormsState;
use crate::access::Need;
use crate::common::{answer, text};
use crate::input;
use crate::responses::{
    answerable_form_ids, delete_responses, list_person_responses, response_ids_by_email,
};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<FormsState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/responses",
            get(person_responses).route_layer(need(FORM_RESPONSES_READ)),
        )
        .route(
            "/erase",
            post(erase).route_layer(need(FORM_RESPONSES_DELETE)),
        )
}

/// `listPersonResponsesQuerySchema`.
fn person_query(
    issues: &mut Issues,
    q: &Map<String, Value>,
) -> (String, Option<String>, Option<i64>) {
    let person = issues
        .text_with(
            q,
            "personId",
            Presence::Required,
            Text::length(Some(1), Some(30)),
        )
        .into_option()
        .unwrap_or_default();
    let cursor = issues
        .text_with(
            q,
            "cursor",
            Presence::Optional,
            Text::length(None, Some(200)),
        )
        .into_option();
    (person, cursor, limit_of(issues, q))
}

/// `eraseRespondentSchema`: `email`, trimmed, an address, at most 320.
fn erase_body(issues: &mut Issues, b: &Map<String, Value>) -> String {
    issues
        .text_with(
            b,
            "email",
            Presence::Required,
            Text {
                trim: true,
                lowercase: false,
                format: Some(Format::Email),
                min: None,
                max: Some(320),
            },
        )
        .into_option()
        .unwrap_or_default()
}

async fn person_responses(member: Member, RawQuery(query): RawQuery) -> Response {
    answer(
        async {
            let (person_id, cursor, limit) = input::query(query.as_deref(), person_query)?;
            let ctx = &member.ctx;
            let form_ids = answerable_form_ids(
                &ctx.db,
                &member.user_id,
                &member.grants(),
                Need::ReadResponses,
            )
            .await?;
            let page =
                list_person_responses(ctx, &person_id, &form_ids, cursor.as_deref(), limit).await?;
            let used: Vec<String> = page
                .rows
                .iter()
                .map(|r| text(r, "formId").to_owned())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            let titles: HashMap<String, String> = if used.is_empty() {
                HashMap::new()
            } else {
                sqlx::query_as::<_, (String, String)>(
                    "select id, title from forms where id = any($1)",
                )
                .bind(&used)
                .fetch_all(&ctx.db)
                .await?
                .into_iter()
                .collect()
            };
            let rows: Vec<Value> = page
                .rows
                .into_iter()
                .map(|mut row| {
                    let title = titles
                        .get(text(&row, "formId"))
                        .cloned()
                        .unwrap_or_default();
                    row["formTitle"] = json!(title);
                    row
                })
                .collect();
            Ok(List::new(
                rows,
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

async fn erase(member: Member, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let email = input::json(&headers, &body, erase_body)?;
            let ctx = &member.ctx;
            // Only forms the member may delete answers on; the rest stay.
            let form_ids = answerable_form_ids(
                &ctx.db,
                &member.user_id,
                &member.grants(),
                Need::DeleteResponses,
            )
            .await?;
            let ids = response_ids_by_email(ctx, &email, &form_ids).await?;
            let (deleted, keys) = delete_responses(ctx, &ids, None).await?;
            drop_files(&member, keys);
            publish_deleted(&member, &deleted);
            let forms: HashSet<&str> = deleted.iter().map(|d| d.form_id.as_str()).collect();
            Ok(Data(json!({
                "responsesDeleted": deleted.len(),
                "formsAffected": forms.len(),
            }))
            .into_response())
        }
        .await,
    )
}
