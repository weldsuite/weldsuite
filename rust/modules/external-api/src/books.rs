//! WeldBooks through the public API: the ledger's resources read-only
//! (`routes/v1/accounting/read-only-routes.ts`: a write is a 405 pointing at
//! WeldBooks), `/v1/accounting-settings` (the singleton row) and
//! `/v1/accounting-contacts` (`parties`, writable). Ciphertext columns are
//! never selected (`columnsFor`): the generated tables leave them out.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{MethodRouter, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    ACCOUNTING_CONTACT_CREATED, ACCOUNTING_CONTACT_DELETED, ACCOUNTING_CONTACT_UPDATED,
};
use weldsuite_kit::id::generate_id;

use crate::ExternalApiState;
use crate::crud::{
    Answer, Caller, created, get_live, like, live_or_404, no_content, now, ok, page, soft_delete,
    table_list_sql, text,
};
use crate::schemas::{LIST_ACCOUNTING_CONTACTS, LIST_READ_ONLY};
use crate::schemas_gen::{CREATE_ACCOUNTING_CONTACT, UPDATE_ACCOUNTING_CONTACT};
use crate::session::{ApiSession, internal_with, not_found, unauthorized};
use crate::simple::{F, filters, scoped};
use crate::table::Table;
use crate::tables_gen::{
    ACCOUNTS, BANK_ACCOUNTS, BANK_TRANSACTIONS, BILLS, DOCUMENTS, ENTITIES, FISCAL_PERIODS,
    FX_RATES, ICP_DECLARATIONS, INVOICES, JOURNAL_ENTRIES, PARTIES, PAYMENTS, RECONCILIATION_RULES,
    RECURRING_INVOICES, SETTINGS, TAX_RATES, VAT_RETURNS,
};
use crate::zod;

type S = State<ExternalApiState>;

/// A ledger resource served for reading only.
struct ReadOnly {
    path: &'static str,
    scope: &'static str,
    table: &'static Table,
    /// The 404's label (`Invoice`).
    label: &'static str,
    /// The 405's noun (`invoices`).
    noun: &'static str,
    sql: (&'static str, &'static str),
}

/// With `entity_id`: the list filters on it.
macro_rules! by_entity {
    ($table:ident) => {
        table_list_sql!(
            $table,
            "t.deleted_at is null and ($3->>'entityId' is null or t.entity_id = $3->>'entityId')"
        )
    };
}

static READ_ONLY: [ReadOnly; 16] = [
    ReadOnly {
        path: "/accounting-entities",
        scope: "accounting_entities:read",
        table: &ENTITIES,
        label: "Accounting entity",
        noun: "accounting entities",
        sql: table_list_sql!(
            entities,
            "t.deleted_at is null and ($3->>'entityId' is null or true)"
        ),
    },
    ReadOnly {
        path: "/gl-accounts",
        scope: "gl_accounts:read",
        table: &ACCOUNTS,
        label: "GL account",
        noun: "GL accounts",
        sql: by_entity!(accounts),
    },
    ReadOnly {
        path: "/invoices",
        scope: "invoices:read",
        table: &INVOICES,
        label: "Invoice",
        noun: "invoices",
        sql: by_entity!(invoices),
    },
    ReadOnly {
        path: "/bills",
        scope: "bills:read",
        table: &BILLS,
        label: "Bill",
        noun: "bills",
        sql: by_entity!(bills),
    },
    ReadOnly {
        path: "/journal-entries",
        scope: "journal_entries:read",
        table: &JOURNAL_ENTRIES,
        label: "Journal entry",
        noun: "journal entries",
        sql: by_entity!(journal_entries),
    },
    ReadOnly {
        path: "/payments",
        scope: "payments:read",
        table: &PAYMENTS,
        label: "Payment",
        noun: "payments",
        sql: by_entity!(payments),
    },
    ReadOnly {
        path: "/bank-accounts",
        scope: "bank_accounts:read",
        table: &BANK_ACCOUNTS,
        label: "Bank account",
        noun: "bank accounts",
        sql: by_entity!(bank_accounts),
    },
    ReadOnly {
        path: "/bank-transactions",
        scope: "bank_transactions:read",
        table: &BANK_TRANSACTIONS,
        label: "Bank transaction",
        noun: "bank transactions",
        sql: by_entity!(bank_transactions),
    },
    ReadOnly {
        path: "/tax-rates",
        scope: "tax_rates:read",
        table: &TAX_RATES,
        label: "Tax rate",
        noun: "tax rates",
        sql: by_entity!(tax_rates),
    },
    ReadOnly {
        path: "/recurring-invoices",
        scope: "recurring_invoices:read",
        table: &RECURRING_INVOICES,
        label: "Recurring invoice",
        noun: "recurring invoices",
        sql: by_entity!(recurring_invoices),
    },
    ReadOnly {
        path: "/reconciliation-rules",
        scope: "reconciliation_rules:read",
        table: &RECONCILIATION_RULES,
        label: "Reconciliation rule",
        noun: "reconciliation rules",
        sql: by_entity!(reconciliation_rules),
    },
    ReadOnly {
        path: "/fiscal-periods",
        scope: "fiscal_periods:read",
        table: &FISCAL_PERIODS,
        label: "Fiscal period",
        noun: "fiscal periods",
        sql: by_entity!(fiscal_periods),
    },
    ReadOnly {
        path: "/fx-rates",
        scope: "fx_rates:read",
        table: &FX_RATES,
        label: "FX rate",
        noun: "FX rates",
        sql: table_list_sql!(fx_rates, "$3->>'entityId' is null or true"),
    },
    ReadOnly {
        path: "/vat-returns",
        scope: "vat_returns:read",
        table: &VAT_RETURNS,
        label: "VAT return",
        noun: "VAT returns",
        sql: by_entity!(vat_returns),
    },
    ReadOnly {
        path: "/icp-declarations",
        scope: "icp_declarations:read",
        table: &ICP_DECLARATIONS,
        label: "ICP declaration",
        noun: "ICP declarations",
        sql: by_entity!(icp_declarations),
    },
    ReadOnly {
        path: "/accounting-documents",
        scope: "accounting_documents:read",
        table: &DOCUMENTS,
        label: "Accounting document",
        noun: "accounting documents",
        sql: by_entity!(documents),
    },
];

/// `rejectWrites(noun)`: no session is 401, anything else the 405 that
/// sends the caller to WeldBooks.
fn reject_writes(request: &Request, noun: &str) -> Response {
    if request.extensions().get::<ApiSession>().is_none() {
        return unauthorized("Unauthorized").into_response();
    }
    let body = json!({
        "error": {
            "code": "METHOD_NOT_ALLOWED",
            "message": format!(
                "The {noun} resource is read-only through the public API. Create and change {noun} in WeldBooks."
            ),
        }
    });
    let mut response = (StatusCode::METHOD_NOT_ALLOWED, axum::Json(body)).into_response();
    response.headers_mut().insert(
        http::header::ALLOW,
        http::HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    response
}

/// The write methods of `noun`'s paths, answered by [`reject_writes`].
fn writes(noun: &'static str) -> MethodRouter<ExternalApiState> {
    let reject = move |request: Request| async move { reject_writes(&request, noun) };
    axum::routing::post(reject)
        .put(reject)
        .patch(reject)
        .delete(reject)
}

/// WeldBooks' routes.
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    let mut router = router;
    for spec in &READ_ONLY {
        let list_route = move |caller: Caller, RawQuery(raw): RawQuery| async move {
            let q = zod::query(&LIST_READ_ONLY, raw.as_deref())?;
            page(
                &caller.db,
                spec.sql,
                spec.table,
                &q,
                filters(&[F::Eq("entityId")], &q),
            )
            .await
        };
        let detail = move |caller: Caller, Path(id): Path<String>| async move {
            get_live(&caller.db, spec.table, spec.label, &id).await
        };
        router = router
            .route(
                spec.path,
                scoped(get(list_route), spec.scope).merge(writes(spec.noun)),
            )
            .route(
                &format!("{}/{{id}}", spec.path),
                scoped(get(detail), spec.scope).merge(writes(spec.noun)),
            )
            .route(
                &format!("{}/{{id}}/{{*rest}}", spec.path),
                writes(spec.noun),
            );
    }
    router
        .route(
            "/accounting-settings",
            scoped(get(settings), "accounting_settings:read").merge(writes("accounting settings")),
        )
        .route(
            "/accounting-settings/{*rest}",
            writes("accounting settings"),
        )
        .route(
            "/accounting-contacts",
            scoped(get(list_contacts), "accounting_contacts:read")
                .merge(scoped(post(create_contact), "accounting_contacts:write")),
        )
        .route(
            "/accounting-contacts/{id}",
            scoped(get(get_contact), "accounting_contacts:read").merge(scoped(
                patch(update_contact).delete(delete_contact),
                "accounting_contacts:write",
            )),
        )
}

/// `GET /accounting-settings`: the live settings row, never created here.
async fn settings(caller: Caller) -> Answer {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::tables_gen::row!(settings),
        " from settings t where t.deleted_at is null limit 1"
    ))
    .fetch_optional(&caller.db)
    .await?;
    match row {
        Some(row) => ok(SETTINGS.js(row)),
        None => Err(crate::session::not_found_resource("Accounting settings").into()),
    }
}

// ---------------------------------------------------------------------------
// Accounting contacts (`parties`)
// ---------------------------------------------------------------------------

const CONTACTS_LIST: (&str, &str) = table_list_sql!(
    parties,
    "t.deleted_at is null \
     and ($3->>'search' is null or t.display_name like $3->>'search' or t.party_code like $3->>'search') \
     and ($3->>'role' is null or t.role = $3->>'role')"
);

/// `toPartyColumns(body)`: `name` is the display name, `type` the role.
fn party_columns(body: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(name) = body.get("name") {
        out.insert("displayName".into(), name.clone());
    }
    if let Some(kind) = body.get("type") {
        out.insert("role".into(), kind.clone());
    }
    out
}

/// `toResponse(row)`: the row with `name` and `type` beside its columns.
fn contact_response(row: Value) -> Value {
    let Value::Object(mut map) = row else {
        return row;
    };
    let name = map.get("displayName").cloned().unwrap_or(Value::Null);
    let kind = map.get("role").cloned().unwrap_or(Value::Null);
    map.insert("name".into(), name);
    map.insert("type".into(), kind);
    Value::Object(map)
}

async fn list_contacts(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_ACCOUNTING_CONTACTS, raw.as_deref())?;
    let filters = json!({ "search": like(&q, "search"), "role": text(&q, "role") });
    let mut page = crate::list::list_rows(
        &caller.db,
        CONTACTS_LIST,
        &crate::crud::list_query(&q),
        &filters,
    )
    .await?;
    page.rows = page
        .rows
        .into_iter()
        .map(|row| contact_response(PARTIES.js(row)))
        .collect();
    Ok(page.respond())
}

async fn get_contact(caller: Caller, Path(id): Path<String>) -> Answer {
    let row = live_or_404(&caller.db, &PARTIES, "Accounting contact", &id).await?;
    ok(contact_response(row))
}

async fn create_contact(
    State(state): S,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_ACCOUNTING_CONTACT, &headers, &body)?;
    let body = &parsed.body;
    let stamp = now();
    let id = generate_id("acn");
    let mut values = Map::new();
    values.insert("id".into(), json!(id));
    values.extend(party_columns(body));
    let role = match body.get("type") {
        Some(Value::Null) | None => json!("customer"),
        Some(kind) => kind.clone(),
    };
    values.insert("role".into(), role);
    values.insert("outstandingBalance".into(), json!("0"));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    let row = PARTIES
        .insert(&caller.db, &values, &["createdAt", "updatedAt"])
        .await?;
    let mut response = body.clone();
    if let Value::Object(fields) = contact_response(row) {
        response.extend(fields);
    }
    let response = Value::Object(response);
    caller.publish(
        &state.events,
        ACCOUNTING_CONTACT_CREATED,
        &id,
        response.clone(),
    );
    created(response)
}

async fn update_contact(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_ACCOUNTING_CONTACT, &headers, &body)?;
    live_or_404(&caller.db, &PARTIES, "Accounting contact", &id).await?;
    let mut update = party_columns(&parsed.body);
    update.insert("updatedAt".into(), json!(now()));
    let row = PARTIES
        .patch(&caller.db, &id, &update, true, &["updatedAt"])
        .await?
        .ok_or_else(|| internal_with("Failed to update accounting contact"))?;
    let response = contact_response(row);
    caller.publish(
        &state.events,
        ACCOUNTING_CONTACT_UPDATED,
        &id,
        response.clone(),
    );
    ok(response)
}

async fn delete_contact(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    soft_delete(&caller.db, &PARTIES, &id)
        .await?
        .ok_or_else(|| not_found("Accounting contact", &id))?;
    caller.publish(
        &state.events,
        ACCOUNTING_CONTACT_DELETED,
        &id,
        json!({ "id": id }),
    );
    no_content()
}
