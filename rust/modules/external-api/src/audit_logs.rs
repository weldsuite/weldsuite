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
use sea_orm::sea_query::{Expr, Func, Order};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, Select,
};
use serde::Serialize;
use serde_json::{Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{orm, utc_timestamp};
use weldsuite_kit::validation::{Issues, Presence, query_values};
use weldsuite_schema::tenant::audit_logs;

use crate::ExternalApiState;
use crate::crud::{Answer, Caller, js_date, ok};
use crate::list::{ListQuery, Page, cast};
use crate::session::{ApiSession, bad_request, not_found, unauthorized};
use crate::simple::scoped;

const READ_SCOPE: &str = "audit_logs:read";

/// A row as the API shows it (`PUBLIC_COLUMNS` through `toPublic`): only
/// these columns are ever selected. `createdAt` is `toISOString()` of the
/// `Date` the driver reads, which cuts the microseconds off; `source` is
/// `metadata->>'source'`.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicRow {
    id: String,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    created_at: PrimitiveDateTime,
    action: String,
    entity_type: String,
    entity_id: String,
    description: String,
    changes: Option<Value>,
    performed_by: Option<String>,
    performed_by_name: Option<String>,
    ip_address: Option<String>,
    source: Option<String>,
}

/// `select <PUBLIC_COLUMNS> from audit_logs`: neither the `data` snapshot
/// nor the rest of the metadata.
fn public_rows() -> Select<audit_logs::Entity> {
    use audit_logs::Column;
    audit_logs::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::CreatedAt,
            Column::Action,
            Column::EntityType,
            Column::EntityId,
            Column::Description,
            Column::Changes,
            Column::PerformedBy,
            Column::PerformedByName,
            Column::IpAddress,
        ])
        .column_as(
            sea_orm::sea_query::extension::postgres::PgExpr::cast_json_field(
                Column::Metadata.into_expr(),
                "source",
            ),
            "source",
        )
}

/// `date_trunc('milliseconds', t.created_at)`: what rows are ordered and the
/// cursor compared on.
fn created_ms() -> Expr {
    Func::cust("date_trunc")
        .arg("milliseconds")
        .arg(audit_logs::Column::CreatedAt.into_expr())
        .into()
}

/// The filters: action, entity type, entity id, performer (exact), and
/// `since` / `until` on `createdAt` (`::timestamp`, both inclusive).
fn filters(query: &Query) -> Condition {
    use audit_logs::Column;
    let at = |text: &str| cast(text.to_owned(), "timestamp");
    Condition::all()
        .add_option(query.action.as_deref().map(|v| Column::Action.eq(v)))
        .add_option(query.entity_type.as_deref().map(|v| Column::EntityType.eq(v)))
        .add_option(query.entity_id.as_deref().map(|v| Column::EntityId.eq(v)))
        .add_option(query.performed_by.as_deref().map(|v| Column::PerformedBy.eq(v)))
        .add_option(
            query
                .since
                .as_deref()
                .map(|since| sea_orm::ExprTrait::gte(Column::CreatedAt.into_expr(), at(since))),
        )
        .add_option(
            query
                .until
                .as_deref()
                .map(|until| sea_orm::ExprTrait::lte(Column::CreatedAt.into_expr(), at(until))),
        )
}

/// One page in `order` after the cursor row (its millisecond and id), with
/// `limit + 1` rows.
fn page(query: &Query, after: Option<(PrimitiveDateTime, &str)>) -> Select<audit_logs::Entity> {
    use sea_orm::ExprTrait as _;
    let mut select = public_rows().filter(filters(query));
    if let Some((at, id)) = after {
        let row = Expr::tuple([created_ms(), audit_logs::Column::Id.into_expr()]);
        let cursor = Expr::tuple([Expr::val(at), Expr::val(id)]);
        select = select.filter(if query.ascending {
            row.gt(cursor)
        } else {
            row.lt(cursor)
        });
    }
    let order = if query.ascending {
        Order::Asc
    } else {
        Order::Desc
    };
    select
        .order_by(created_ms(), order.clone())
        .order_by(audit_logs::Column::Id, order)
        .limit(u64::try_from(query.page.limit + 1).unwrap_or(0))
}

/// The rows as JSON.
fn rows_json(rows: Vec<PublicRow>) -> Result<Vec<Value>, DbErr> {
    rows.into_iter()
        .map(|row| serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string())))
        .collect()
}

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
    let db = orm(&caller.db);
    let mut after: Option<(PrimitiveDateTime, &str)> = None;
    if let Some(cursor) = query.page.cursor.as_deref().filter(|c| !c.is_empty()) {
        let found: Option<PrimitiveDateTime> = audit_logs::Entity::find_by_id(cursor.to_owned())
            .select_only()
            .column(audit_logs::Column::CreatedAt)
            .into_tuple()
            .one(&db)
            .await?;
        let Some(created_at) = found else {
            return Err(bad_request("Invalid cursor")
                .with_details(json!({ "field": "cursor" }))
                .into());
        };
        // The cursor row's instant, exact to the millisecond (`MS_TEXT`).
        after = Some((utc_timestamp(created_at.assume_utc()), cursor));
    }

    let rows: Vec<PublicRow> = page(&query, after).into_model().all(&db).await?;
    let total = audit_logs::Entity::find()
        .filter(filters(&query))
        .count(&db)
        .await?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    Ok(Page::of(rows_json(rows)?, total, query.page.limit).respond())
}

/// `GET /:id`.
async fn detail(caller: Caller, Path(id): Path<String>) -> Answer {
    let row: Option<PublicRow> = public_rows()
        .filter(audit_logs::Column::Id.eq(id.as_str()))
        .into_model()
        .one(&orm(&caller.db))
        .await?;
    match row {
        Some(row) => ok(rows_json(vec![row])?.pop().unwrap_or(Value::Null)),
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
        use sea_orm::{DbBackend, QueryTrait};
        let Some(mut query) = read(Some("order=asc&limit=2&action=created")) else {
            panic!("a valid query");
        };
        let at = PrimitiveDateTime::new(
            time::macros::date!(2026 - 11 - 01),
            time::macros::time!(10:00:00.250),
        );
        let sql = |query: &Query| page(query, Some((at, "log_1"))).build(DbBackend::Postgres).sql;
        let ascending = sql(&query);
        assert!(
            ascending.contains(
                r#"(date_trunc($2, "audit_logs"."created_at"), "audit_logs"."id") > ($3, $4)"#
            ),
            "{ascending}"
        );
        assert!(
            ascending.ends_with(
                r#"ORDER BY date_trunc($5, "audit_logs"."created_at") ASC, "audit_logs"."id" ASC LIMIT $6"#
            ),
            "{ascending}"
        );
        query.ascending = false;
        let descending = sql(&query);
        assert!(
            descending.contains(
                r#"(date_trunc($2, "audit_logs"."created_at"), "audit_logs"."id") < ($3, $4)"#
            ),
            "{descending}"
        );
        assert!(descending.contains(r#"DESC, "audit_logs"."id" DESC LIMIT $6"#));
        // Neither the snapshot nor the rest of the metadata is selected.
        assert!(!ascending.contains(r#""data""#));
        assert!(ascending.contains(r#"("audit_logs"."metadata" ->> $1) AS "source""#));
    }
}
