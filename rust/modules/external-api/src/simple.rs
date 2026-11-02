//! The plain object groups: list with equality and `like` filters, the live
//! row, create as `{ ...body, id, createdAt, updatedAt }`, update as
//! `{ ...body, updatedAt }` on the live row (404 when none), soft delete, and
//! the same small event data on each (`routes/v1/goals/index.ts` and the
//! groups written like it). What a group does beyond that is a [`Prepare`]
//! hook on the values.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::routing::{MethodRouter, get, post};
use http::HeaderMap;
use serde_json::{Map, Value};
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_kit::id::generate_id;

use crate::ExternalApiState;
use crate::crud::{
    Answer, Caller, Fail, created, dates, flag, get_live, like, no_content, now, ok, page, pick,
    soft_delete, text, to_date, with_id, with_updated,
};
use crate::session::{not_found, require_scope};
use crate::table::Table;
use crate::zod::{self, Parsed, Z};

/// A value a [`Prepare`] hook writes where the new row's id belongs (it is
/// generated after the hook runs).
pub(crate) const ID_PLACEHOLDER: &str = "\u{0}id\u{0}";

/// A list filter: the query key, and how it filters.
#[derive(Debug, Clone, Copy)]
pub(crate) enum F {
    /// `like(column, %term%)` when set.
    Like(&'static str),
    /// `eq(column, value)` when set (not empty).
    Eq(&'static str),
    /// `eq(column, flag)` when present.
    Flag(&'static str),
}

/// A route's own step on the values it writes: `create` is true on POST.
pub(crate) type Prepare = fn(&Caller, &mut Map<String, Value>, bool) -> Result<(), Fail>;

/// An object group.
pub(crate) struct Simple {
    /// `/goals`.
    pub(crate) path: &'static str,
    /// `goals`: `goals:read` / `goals:write`.
    pub(crate) scope: &'static str,
    pub(crate) table: &'static Table,
    /// The not-found label (`Goal`).
    pub(crate) label: &'static str,
    /// `generateId` prefix.
    pub(crate) prefix: &'static str,
    pub(crate) list: &'static Z,
    pub(crate) create: &'static Z,
    pub(crate) update: &'static Z,
    /// The list and count statements (`table_list_sql!`), reading `$3` by
    /// the filters' query keys.
    pub(crate) sql: (&'static str, &'static str),
    pub(crate) filters: &'static [F],
    /// `coerceDates`: the body strings written as `Date`s.
    pub(crate) dates: &'static [&'static str],
    /// The created / updated / deleted events, and the row fields their
    /// data carries after `id`.
    pub(crate) events: Option<[EventName; 3]>,
    pub(crate) data: &'static [&'static str],
    pub(crate) prepare: Option<Prepare>,
    /// Computed counters the list and the detail add (`withProjectStats`).
    pub(crate) stats: Stats,
    /// Whether the writes stamp `updatedAt` (a create always stamps `createdAt`).
    pub(crate) touch: bool,
}

/// The computed stats a group's reads add.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Stats {
    None,
    Project,
    Milestone,
}

/// `requireScope(scope)` for a scope known at run time.
pub(crate) fn scoped<S>(route: MethodRouter<S>, scope: &'static str) -> MethodRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    route.route_layer(axum::middleware::from_fn_with_state(scope, require_scope))
}

/// Leak a scope name once per group at start-up (`goals:read`).
fn scope_name(scope: &str, access: &str) -> &'static str {
    Box::leak(format!("{scope}:{access}").into_boxed_str())
}

/// Mount `spec`'s five routes.
pub(crate) fn mount(
    router: Router<ExternalApiState>,
    spec: &'static Simple,
) -> Router<ExternalApiState> {
    let read = scope_name(spec.scope, "read");
    let write = scope_name(spec.scope, "write");
    let collection = scoped(
        get(move |caller: Caller, RawQuery(raw): RawQuery| list(spec, caller, raw)),
        read,
    )
    .merge(scoped(
        post(
            move |State(state): State<ExternalApiState>,
                  caller: Caller,
                  headers: HeaderMap,
                  body: Bytes| { create(spec, state, caller, headers, body) },
        ),
        write,
    ));
    let item = scoped(
        get(move |caller: Caller, Path(id): Path<String>| detail(spec, caller, id)),
        read,
    )
    .merge(scoped(
        axum::routing::patch(
            move |State(state): State<ExternalApiState>,
                  caller: Caller,
                  Path(id): Path<String>,
                  headers: HeaderMap,
                  body: Bytes| { update(spec, state, caller, id, headers, body) },
        )
        .delete(
            move |State(state): State<ExternalApiState>, caller: Caller, Path(id): Path<String>| {
                remove(spec, state, caller, id)
            },
        ),
        write,
    ));
    router
        .route(spec.path, collection)
        .route(&format!("{}/{{id}}", spec.path), item)
}

/// The `$3` filters object of a parsed list query.
pub(crate) fn filters(spec_filters: &[F], parsed: &Parsed) -> Value {
    let mut out = Map::new();
    for filter in spec_filters {
        let (key, value) = match *filter {
            F::Like(key) => (key, like(parsed, key)),
            F::Eq(key) => (key, text(parsed, key)),
            F::Flag(key) => (key, flag(parsed, key)),
        };
        out.insert(key.to_owned(), value);
    }
    Value::Object(out)
}

async fn list(spec: &'static Simple, caller: Caller, raw: Option<String>) -> Answer {
    let q = zod::query(spec.list, raw.as_deref())?;
    let filters = filters(spec.filters, &q);
    if spec.stats == Stats::None {
        return page(&caller.db, spec.sql, spec.table, &q, filters).await;
    }
    crate::flow::decorated_page(&caller, spec, &q, filters).await
}

async fn detail(spec: &'static Simple, caller: Caller, id: String) -> Answer {
    if spec.stats == Stats::None {
        return get_live(&caller.db, spec.table, spec.label, &id).await;
    }
    let row = crate::crud::live_or_404(&caller.db, spec.table, spec.label, &id).await?;
    let mut rows = crate::flow::decorate(&caller.db, spec.stats, vec![row]).await?;
    ok(rows.pop().unwrap_or(Value::Null))
}

/// `coerceDates(values)`: each listed string as a `Date`; the properties
/// that hold one.
pub(crate) fn coerce_dates(
    values: &mut Map<String, Value>,
    fields: &'static [&'static str],
) -> Result<Vec<&'static str>, Fail> {
    let mut out = Vec::new();
    for field in fields {
        if let Some(Value::String(text)) = values.get(*field).cloned() {
            values.insert((*field).to_owned(), to_date(&text)?);
            out.push(*field);
        }
    }
    Ok(out)
}

fn event_data(spec: &Simple, id: &str, row: &Value) -> Value {
    pick(id, row, spec.data)
}

async fn create(
    spec: &'static Simple,
    state: ExternalApiState,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(spec.create, &headers, &body)?;
    let mut body = parsed.body.clone();
    if let Some(prepare) = spec.prepare {
        prepare(&caller, &mut body, true)?;
    }
    let mut own = coerce_dates(&mut body, spec.dates)?;
    let stamp = now();
    let id = generate_id(spec.prefix);
    for value in body.values_mut() {
        if value.as_str() == Some(ID_PLACEHOLDER) {
            *value = Value::String(id.clone());
        }
    }
    let mut values = with_id(&body, &id, &stamp);
    if !spec.touch {
        values.remove("updatedAt");
    }
    own.extend(["createdAt", "updatedAt"]);
    let row = spec
        .table
        .insert(&caller.db, &values, &dates(&parsed, &own))
        .await?;
    if let Some([created_event, _, _]) = spec.events {
        caller.publish(
            &state.events,
            created_event,
            &id,
            event_data(spec, &id, &row),
        );
    }
    created(row)
}

async fn update(
    spec: &'static Simple,
    state: ExternalApiState,
    caller: Caller,
    id: String,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(spec.update, &headers, &body)?;
    let mut body = parsed.body.clone();
    if let Some(prepare) = spec.prepare {
        prepare(&caller, &mut body, false)?;
    }
    let mut own = coerce_dates(&mut body, spec.dates)?;
    let values = if spec.touch {
        with_updated(&body, &now())
    } else {
        body
    };
    own.push("updatedAt");
    let row = spec
        .table
        .patch(&caller.db, &id, &values, true, &dates(&parsed, &own))
        .await?
        .ok_or_else(|| not_found(spec.label, &id))?;
    if let Some([_, updated_event, _]) = spec.events {
        caller.publish(
            &state.events,
            updated_event,
            &id,
            event_data(spec, &id, &row),
        );
    }
    ok(row)
}

async fn remove(
    spec: &'static Simple,
    state: ExternalApiState,
    caller: Caller,
    id: String,
) -> Answer {
    let removed = if spec.table.soft_delete {
        soft_delete(&caller.db, spec.table, &id).await?
    } else {
        spec.table.delete(&caller.db, &id).await?
    };
    let row = removed.ok_or_else(|| not_found(spec.label, &id))?;
    if let Some([_, _, deleted_event]) = spec.events {
        caller.publish(
            &state.events,
            deleted_event,
            &id,
            event_data(spec, &id, &row),
        );
    }
    no_content()
}
