//! Audit logs on the public API (`routes/v1/audit-logs/index.ts`):
//! `GET /v1/audit-logs` and `GET /v1/audit-logs/:id`, scope
//! `audit_logs:read`. Read-only, so a SIEM can poll it.
//!
//! An item is `{ id, createdAt, action, entityType, entityId, description,
//! changes, performedBy, performedByName, ipAddress, source }`; `source` is
//! `metadata.source`. The `data` snapshot and the rest of the metadata are
//! never selected.
//!
//! Filters: `action`, `entityType`, `entityId`, `performedBy` (exact),
//! `since` / `until` (timestamps on `createdAt`, both inclusive). `order` is
//! `desc` (default, newest first) or `asc` (oldest first, to poll forward).
//! `cursor` is the `id` of the last row of the previous page; one that names
//! no row answers 400, so a poller never silently starts over.
//!
//! Rows are ordered and the cursor is compared on
//! `(date_trunc('milliseconds', created_at), id)`: `created_at` has
//! microseconds, the cursor row is read back at milliseconds, and comparing
//! the two directly would skip or repeat the rows that share the cursor's
//! millisecond.
//!
//! Audit rows are never written through the public API: writes answer 405.

use axum::Router;
use axum::extract::{Path, RawQuery, Request};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{MethodRouter, get};
use serde_json::{Value, json};
use weldsuite_kit::validation::{Issues, Presence, query_values};

use crate::ExternalApiState;
use crate::crud::{Answer, Caller, js_date, ok};
use crate::list::{ListQuery, Page};
use crate::session::{ApiSession, bad_request, not_found, unauthorized};
use crate::simple::scoped;

const READ_SCOPE: &str = "audit_logs:read";

/// A row as the API shows it (`PUBLIC_COLUMNS` through `toPublic`): only
/// these columns are ever selected. `createdAt` is `toISOString()` of the
/// `Date` the driver reads, which cuts the microseconds off.
macro_rules! public_row {
    () => {
        "jsonb_build_object('id', t.id, \
         'createdAt', to_char(date_trunc('milliseconds', t.created_at), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
         'action', t.action, 'entityType', t.entity_type, 'entityId', t.entity_id, \
         'description', t.description, 'changes', t.changes, 'performedBy', t.performed_by, \
         'performedByName', t.performed_by_name, 'ipAddress', t.ip_address, \
         'source', t.metadata->>'source')"
    };
}

/// The filters, `$1` to `$6`: action, entity type, entity id, performer,
/// since and until.
macro_rules! filters {
    () => {
        "($1::text is null or t.action = $1) and ($2::text is null or t.entity_type = $2) \
         and ($3::text is null or t.entity_id = $3) and ($4::text is null or t.performed_by = $4) \
         and ($5::text is null or t.created_at >= $5::timestamp) \
         and ($6::text is null or t.created_at <= $6::timestamp)"
    };
}

/// One page in `$direction` after the cursor (`$7` its millisecond, `$8` its
/// id), `$9` rows.
macro_rules! page_sql {
    ($compare:literal, $direction:literal) => {
        concat!(
            "select ",
            public_row!(),
            " from audit_logs t where ",
            filters!(),
            " and ($7::text is null or (date_trunc('milliseconds', t.created_at), t.id) ",
            $compare,
            " ($7::timestamp, $8::text)) order by date_trunc('milliseconds', t.created_at) ",
            $direction,
            ", t.id ",
            $direction,
            " limit $9"
        )
    };
}

const PAGE_ASC: &str = page_sql!(">", "asc");
const PAGE_DESC: &str = page_sql!("<", "desc");
const COUNT: &str = concat!("select count(*) from audit_logs t where ", filters!());

/// The cursor row's instant, exact to the millisecond (`MS_TEXT`).
const CURSOR_ROW: &str = "select to_char(date_trunc('milliseconds', created_at), \
     'YYYY-MM-DD\"T\"HH24:MI:SS.MS') from audit_logs where id = $1 limit 1";

const DETAIL: &str = concat!(
    "select ",
    public_row!(),
    " from audit_logs t where t.id = $1 limit 1"
);

/// The worker's routes.
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    router
        .route("/audit-logs", scoped(get(list), READ_SCOPE).merge(writes()))
        .route(
            "/audit-logs/{id}",
            scoped(get(detail), READ_SCOPE).merge(writes()),
        )
        .route("/audit-logs/{id}/{*rest}", writes())
}

/// `listQuery`, read.
struct Query {
    page: ListQuery,
    action: Option<String>,
    entity_type: Option<String>,
    entity_id: Option<String>,
    performed_by: Option<String>,
    /// `new Date(since).toISOString()`.
    since: Option<String>,
    until: Option<String>,
    ascending: bool,
}

/// `isoTimestamp`'s refinement, `!Number.isNaN(Date.parse(v))`, on a value
/// that passed as a string: the instant, or the issue. (`Date.parse` as
/// [`js_date`] reads it: the ISO forms, a time without an offset as UTC.)
fn instant(issues: &mut Issues, key: &str, text: Option<String>) -> Option<String> {
    let parsed = js_date(&text?);
    if parsed.is_none() {
        issues.custom(key, "Expected an ISO 8601 timestamp");
    }
    parsed
}

/// `zValidator('query', listQuery)`: the fields in the schema's order, the
/// two refinements after every synchronous check, as Zod settles them.
fn read_query(raw: Option<&str>) -> Result<Query, Response> {
    let mut issues = Issues::default();
    let page = ListQuery::read(&mut issues, raw);
    let fields = query_values(raw);
    let filter = |issues: &mut Issues, key: &str| {
        issues
            .text(&fields, key, Presence::Optional, Some(1), None)
            .into_option()
    };
    let action = filter(&mut issues, "action");
    let entity_type = filter(&mut issues, "entityType");
    let entity_id = filter(&mut issues, "entityId");
    let performed_by = filter(&mut issues, "performedBy");
    let since = issues
        .text(&fields, "since", Presence::Optional, None, None)
        .into_option();
    let until = issues
        .text(&fields, "until", Presence::Optional, None, None)
        .into_option();
    let order = issues
        .choice(&fields, "order", Presence::Optional, &["asc", "desc"])
        .into_option();
    let since = instant(&mut issues, "since", since);
    let until = instant(&mut issues, "until", until);
    issues.finish().map_err(IntoResponse::into_response)?;
    Ok(Query {
        page,
        action,
        entity_type,
        entity_id,
        performed_by,
        since,
        until,
        ascending: order.as_deref() == Some("asc"),
    })
}

/// `GET /`: a page in `order`, cursor-paged, with the count of everything
/// the filters match.
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let query = match read_query(raw.as_deref()) {
        Ok(query) => query,
        Err(invalid) => return Ok(invalid),
    };

    // `if (q.cursor)`: an empty cursor is none.
    let mut after: Option<(String, &str)> = None;
    if let Some(cursor) = query.page.cursor.as_deref().filter(|c| !c.is_empty()) {
        let found: Option<String> = sqlx::query_scalar(CURSOR_ROW)
            .bind(cursor)
            .fetch_optional(&caller.db)
            .await?;
        let Some(millisecond) = found else {
            return Err(bad_request("Invalid cursor")
                .with_details(json!({ "field": "cursor" }))
                .into());
        };
        after = Some((format!("{millisecond}Z"), cursor));
    }

    let probe = query.page.limit + 1;
    let mut rows: Vec<Value> =
        sqlx::query_scalar(if query.ascending { PAGE_ASC } else { PAGE_DESC })
            .bind(query.action.as_deref())
            .bind(query.entity_type.as_deref())
            .bind(query.entity_id.as_deref())
            .bind(query.performed_by.as_deref())
            .bind(query.since.as_deref())
            .bind(query.until.as_deref())
            .bind(after.as_ref().map(|(at, _)| at.as_str()))
            .bind(after.as_ref().map(|(_, id)| *id))
            .bind(probe)
            .fetch_all(&caller.db)
            .await?;
    let total: i64 = sqlx::query_scalar(COUNT)
        .bind(query.action.as_deref())
        .bind(query.entity_type.as_deref())
        .bind(query.entity_id.as_deref())
        .bind(query.performed_by.as_deref())
        .bind(query.since.as_deref())
        .bind(query.until.as_deref())
        .fetch_one(&caller.db)
        .await?;

    let limit = usize::try_from(query.page.limit).unwrap_or(usize::MAX);
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let cursor = if has_more {
        rows.last()
            .and_then(|row| row.get("id"))
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    Ok(Page {
        rows,
        total,
        has_more,
        cursor,
    }
    .respond())
}

/// `GET /:id`.
async fn detail(caller: Caller, Path(id): Path<String>) -> Answer {
    let row: Option<Value> = sqlx::query_scalar(DETAIL)
        .bind(&id)
        .fetch_optional(&caller.db)
        .await?;
    match row {
        Some(row) => ok(row),
        None => Err(not_found("Audit log", &id).into()),
    }
}

/// The audit log is written by the platform only. Still 401 without a
/// session, like the other read-only resources.
fn reject_writes(request: &Request) -> Response {
    if request.extensions().get::<ApiSession>().is_none() {
        return unauthorized("Unauthorized").into_response();
    }
    let body = json!({
        "error": {
            "code": "METHOD_NOT_ALLOWED",
            "message": "The audit logs resource is read-only through the public API.",
        }
    });
    let mut response = (StatusCode::METHOD_NOT_ALLOWED, axum::Json(body)).into_response();
    response.headers_mut().insert(
        http::header::ALLOW,
        http::HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    response
}

fn writes() -> MethodRouter<ExternalApiState> {
    let reject = |request: Request| async move { reject_writes(&request) };
    axum::routing::post(reject)
        .put(reject)
        .patch(reject)
        .delete(reject)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The query as read, or `None` for a 400.
    fn read(raw: Option<&str>) -> Option<Query> {
        match read_query(raw) {
            Ok(query) => Some(query),
            Err(response) => {
                assert_eq!(response.status(), StatusCode::BAD_REQUEST);
                None
            }
        }
    }

    #[test]
    fn the_query_reads_like_the_schema() {
        let Some(query) = read(Some(
            "order=asc&limit=2&entityType=order&since=2026-11-01T10:00:00.250Z&until=2026-11-02",
        )) else {
            panic!("a valid query");
        };
        assert!(query.ascending);
        assert_eq!(query.page.limit, 2);
        assert_eq!(query.entity_type.as_deref(), Some("order"));
        assert_eq!(query.since.as_deref(), Some("2026-11-01T10:00:00.250Z"));
        assert_eq!(query.until.as_deref(), Some("2026-11-02T00:00:00.000Z"));
        assert_eq!(query.action, None);

        let Some(defaults) = read(None) else {
            panic!("a valid query");
        };
        assert!(!defaults.ascending);
        assert_eq!(defaults.page.limit, 50);
        assert_eq!(defaults.page.cursor, None);
    }

    #[test]
    fn a_bad_timestamp_order_or_limit_is_refused() {
        for raw in [
            "since=yesterday",
            "until=nope",
            "order=sideways",
            "limit=0",
            "limit=500",
            "action=",
        ] {
            assert!(read(Some(raw)).is_none(), "{raw}");
        }
    }

    #[test]
    fn the_refinements_come_after_the_other_checks() {
        // Zod settles `since`'s refinement after `order`'s enum check.
        let mut issues = Issues::default();
        let fields = query_values(Some("since=yesterday&order=sideways"));
        let since = issues
            .text(&fields, "since", Presence::Optional, None, None)
            .into_option();
        issues.choice(&fields, "order", Presence::Optional, &["asc", "desc"]);
        assert_eq!(instant(&mut issues, "since", since), None);
        let Err(invalid) = issues.finish() else {
            panic!("two issues");
        };
        let codes: Vec<&str> = invalid
            .issues()
            .iter()
            .filter_map(|issue| issue["code"].as_str())
            .collect();
        assert_eq!(codes, ["invalid_enum_value", "custom"]);
        assert_eq!(
            invalid.issues()[1],
            json!({ "code": "custom", "message": "Expected an ISO 8601 timestamp", "path": ["since"] })
        );
    }

    #[test]
    fn the_statements_compare_on_the_millisecond() {
        assert!(PAGE_ASC.contains(
            "(date_trunc('milliseconds', t.created_at), t.id) > ($7::timestamp, $8::text)"
        ));
        assert!(
            PAGE_ASC.ends_with(
                "order by date_trunc('milliseconds', t.created_at) asc, t.id asc limit $9"
            )
        );
        assert!(PAGE_DESC.contains(
            "(date_trunc('milliseconds', t.created_at), t.id) < ($7::timestamp, $8::text)"
        ));
        assert!(PAGE_DESC.ends_with(
            "order by date_trunc('milliseconds', t.created_at) desc, t.id desc limit $9"
        ));
        // Neither the snapshot nor the metadata is selected.
        for statement in [PAGE_ASC, DETAIL] {
            assert!(!statement.contains("t.data"));
            assert!(!statement.contains("to_jsonb"));
            assert!(statement.contains("t.metadata->>'source'"));
        }
        assert!(!COUNT.contains("$7"));
    }
}
