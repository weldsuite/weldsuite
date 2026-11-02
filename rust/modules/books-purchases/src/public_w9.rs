//! `/public/w9/:token` (`routes/public-w9/index.ts`): the W-9 form a vendor
//! fills in from a request link. No session: the random token is the
//! credential; its hash leads through the workspace cache (`w9:<hash>` →
//! `{ orgId, requestId }`) to the workspace and the pending request.
//!
//! Unknown, expired, completed and cancelled tokens all answer the same bare
//! 404. Bodies over 10 KB are refused. The TIN is validated, sealed into the
//! vendor and never echoed; the entity event of the completed request
//! carries no personal data.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, State};
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::address::normalize_postal_address;
use weldsuite_books_domain::guards::{AuditInput, write_audit};
use weldsuite_books_domain::http::{BooksState, now, now_ms};
use weldsuite_books_domain::jurisdictions::us::{is_address_state_code, validate_zip};
use weldsuite_books_domain::tables::{PARTIES, W9_REQUESTS};
use weldsuite_books_domain::vendor_tax::{
    TIN_TYPES, VendorTaxError, VendorTaxInput, W9_FEDERAL_CLASSIFICATIONS, build_vendor_tax_change,
    is_corporation_classification, iso_millis, sha256_hex, w9_event_data, w9_kv_key,
};
use weldsuite_catalogs::entity_events::{ACCOUNTING_CONTACT_UPDATED, W9_REQUEST_COMPLETED};
use weldsuite_db::{Keyring, PgPool, Tenant, Workspaces};
use weldsuite_events::{EntityEvent, EventContext, EventSource};
use weldsuite_kit::RequestEnv;
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_ports::{DynCache, RequestCache};

/// `W9_MAX_BODY_BYTES`.
const MAX_BODY_BYTES: usize = 10 * 1024;

#[derive(Clone)]
struct PublicState {
    books: BooksState,
    workspaces: Option<Arc<Workspaces>>,
}

/// The public W-9 routes at their full path. `workspaces` opens the tenant
/// a token leads to (a request's own `Tenant`, in conformance builds, wins).
pub fn public_router<S>(state: &BooksState, workspaces: Option<Arc<Workspaces>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let routes = Router::new()
        .route("/{token}", get(load).post(submit))
        .layer(axum::middleware::map_response(robots_headers))
        .with_state(PublicState {
            books: state.clone(),
            workspaces,
        });
    Router::new().nest("/public/w9", routes)
}

/// Every answer: never cached, never indexed, no referrer.
async fn robots_headers(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    headers.insert(
        "x-robots-tag",
        HeaderValue::from_static("noindex, nofollow"),
    );
    headers.insert(
        http::header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

fn answer(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        axum::Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

fn not_found() -> Response {
    answer(StatusCode::NOT_FOUND, "NOT_FOUND", "Not found")
}

/// What the request carries in place of a session: the conformance
/// harness's tenant, cache and env.
struct Shared {
    tenant: Option<Tenant>,
    cache: Option<RequestCache>,
    env: Option<RequestEnv>,
}

impl Shared {
    fn of(parts: &Parts) -> Self {
        Self {
            tenant: parts.extensions.get::<Tenant>().cloned(),
            cache: parts.extensions.get::<RequestCache>().cloned(),
            env: parts.extensions.get::<RequestEnv>().cloned(),
        }
    }

    fn cache(&self, state: &PublicState) -> Option<Arc<dyn DynCache>> {
        self.cache
            .as_ref()
            .map(|cache| Arc::clone(&cache.0))
            .or_else(|| state.books.cache.clone())
    }

    fn keyring(&self, state: &PublicState) -> Keyring {
        match &self.env {
            Some(env) => Keyring {
                v1: env
                    .get("DATABASE_ENCRYPTION_KEY")
                    .filter(|k| !k.is_empty())
                    .map(str::to_owned),
                v2: env
                    .get("DATABASE_ENCRYPTION_KEY_V2")
                    .filter(|k| !k.is_empty())
                    .map(str::to_owned),
            },
            None => state.books.keyring.clone(),
        }
    }
}

/// `resolve(c, token)`: the pending, unexpired request behind a token.
struct Resolved {
    db: PgPool,
    workspace_id: String,
    hash: String,
    request: Value,
    party: Value,
}

async fn resolve(
    shared: &Shared,
    state: &PublicState,
    token: &str,
) -> Result<Option<Resolved>, String> {
    let hash = sha256_hex(token);
    let Some(cache) = shared.cache(state) else {
        return Err("WORKSPACE_CACHE is not bound".to_owned());
    };
    let entry = cache
        .get_boxed(&w9_kv_key(&hash))
        .await
        .map_err(|error| format!("{error:?}"))?;
    let entry: Value = entry
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or(Value::Null);
    let org_id = entry
        .get("orgId")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty());
    let request_id = entry
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty());
    let (Some(org_id), Some(request_id)) = (org_id, request_id) else {
        return Ok(None);
    };
    let tenant = if let Some(tenant) = &shared.tenant {
        tenant.clone()
    } else {
        let Some(workspaces) = &state.workspaces else {
            return Err("no workspace registry".to_owned());
        };
        workspaces
            .tenant(org_id)
            .await
            .map_err(|error| format!("{error:?}"))?
    };
    if tenant.suspended {
        return Ok(None);
    }
    let db = tenant.db.clone();
    let request: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(w9_requests),
        " from w9_requests t where t.id = $1 and t.token_hash = $2 limit 1"
    ))
    .bind(request_id)
    .bind(&hash)
    .fetch_optional(&db)
    .await
    .map_err(|error| error.to_string())?;
    let Some(request) = request.map(|row| W9_REQUESTS.js(row)) else {
        return Ok(None);
    };
    let expires = request
        .get("expiresAt")
        .and_then(Value::as_str)
        .and_then(iso_millis)
        .unwrap_or(0);
    if request.get("status").and_then(Value::as_str) != Some("pending") || expires <= now_ms() {
        return Ok(None);
    }
    let party: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(parties),
        " from parties t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(
        request
            .get("partyId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
    .fetch_optional(&db)
    .await
    .map_err(|error| error.to_string())?;
    let Some(party) = party.map(|row| PARTIES.js(row)) else {
        return Ok(None);
    };
    Ok(Some(Resolved {
        db,
        workspace_id: tenant.workspace_id.clone(),
        hash,
        request,
        party,
    }))
}

// ── GET /:token ─────────────────────────────────────────────────────────────

async fn load(
    State(state): State<PublicState>,
    Path(token): Path<String>,
    request: axum::extract::Request,
) -> Response {
    let (parts, _) = request.into_parts();
    let shared = Shared::of(&parts);
    let resolved = match resolve(&shared, &state, &token).await {
        Ok(Some(resolved)) => resolved,
        Ok(None) => return not_found(),
        Err(error) => {
            tracing::error!(error, "[books-api/public-w9] load failed");
            return not_found();
        }
    };
    let entity: Result<Option<(String, Option<String>)>, sqlx::Error> =
        sqlx::query_as("select name, legal_name from entities where id = $1 limit 1")
            .bind(
                resolved
                    .request
                    .get("entityId")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
            .fetch_optional(&resolved.db)
            .await;
    let entity = match entity {
        Ok(entity) => entity,
        Err(error) => {
            tracing::error!(%error, "[books-api/public-w9] load failed");
            return not_found();
        }
    };
    let payer = entity
        .map(|(name, legal)| legal.unwrap_or(name))
        .unwrap_or_default();
    axum::Json(json!({
        "data": {
            "payer": { "name": payer },
            "vendor": { "displayName": resolved.party.get("displayName").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!("")) },
            "expiresAt": resolved.request.get("expiresAt").cloned().unwrap_or(Value::Null),
        }
    }))
    .into_response()
}

// ── POST /:token ────────────────────────────────────────────────────────────

/// The form, as `submissionSchema` let it through.
struct Form {
    legal_name: String,
    business_name: Option<String>,
    federal: String,
    llc: Option<String>,
    exempt_payee_code: Option<String>,
    fatca_code: Option<String>,
    line1: String,
    line2: Option<String>,
    city: String,
    state: String,
    postal_code: String,
    tin_type: String,
    tin: String,
    signed_name: String,
}

fn text(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    min: Option<usize>,
    max: Option<usize>,
    presence: Presence,
) -> Option<String> {
    issues
        .text_with(body, key, presence, Text::trimmed(min, max))
        .into_option()
}

/// The keys of `submissionSchema`.
const FORM_KEYS: [&str; 11] = [
    "legalName",
    "businessName",
    "federalTaxClassification",
    "llcTaxClassification",
    "exemptPayeeCode",
    "fatcaCode",
    "address",
    "tinType",
    "tin",
    "signedName",
    "certify",
];

/// `submissionSchema` (`.strict()`): the issues, or the form.
fn read_form(issues: &mut Issues, body: &Map<String, Value>) -> Option<Form> {
    let required = Presence::Required;
    let optional = Presence::Optional;
    let legal_name = text(issues, body, "legalName", Some(1), Some(100), required);
    let business_name = text(issues, body, "businessName", None, Some(100), optional);
    let federal = issues
        .choice(
            body,
            "federalTaxClassification",
            required,
            &W9_FEDERAL_CLASSIFICATIONS,
        )
        .into_option();
    let llc = issues
        .choice(body, "llcTaxClassification", optional, &["C", "S", "P"])
        .into_option();
    let exempt_payee_code = text(issues, body, "exemptPayeeCode", None, Some(2), optional);
    let fatca_code = text(issues, body, "fatcaCode", None, Some(2), optional);
    let address = issues
        .nested(body, "address", required, |issues, fields| {
            let line1 = text(issues, fields, "line1", Some(1), Some(100), required);
            let line2 = text(issues, fields, "line2", None, Some(100), optional);
            let city = text(issues, fields, "city", Some(1), Some(60), required);
            let state = match issues.text_with(fields, "state", required, Text::trimmed(None, None))
            {
                Field::Set(state) => {
                    let length = state.encode_utf16().count();
                    issues.string_length("state", 2, length);
                    (length == 2).then_some(state)
                }
                _ => None,
            };
            let postal_code = text(issues, fields, "postalCode", Some(5), Some(10), required);
            (line1, line2, city, state, postal_code)
        })
        .into_option();
    let tin_type = issues
        .choice(body, "tinType", required, &TIN_TYPES)
        .into_option();
    let tin = text(issues, body, "tin", Some(9), Some(11), required);
    let signed_name = text(issues, body, "signedName", Some(2), Some(100), required);
    if body.get("certify") != Some(&Value::Bool(true)) {
        let path = issues.path_of("certify");
        issues.push_raw(json!({
            "received": body.get("certify").cloned().unwrap_or(Value::Null),
            "code": "invalid_literal",
            "expected": true,
            "path": path,
            "message": "You must certify the form",
        }));
    }
    let extra: Vec<&String> = body
        .keys()
        .filter(|k| !FORM_KEYS.contains(&k.as_str()))
        .collect();
    if !extra.is_empty() {
        let listed = extra
            .iter()
            .map(|k| format!("'{k}'"))
            .collect::<Vec<_>>()
            .join(", ");
        issues.push_raw(json!({
            "code": "unrecognized_keys",
            "keys": extra,
            "path": [],
            "message": format!("Unrecognized key(s) in object: {listed}"),
        }));
    }
    let (line1, line2, city, state, postal_code) = address?;
    Some(Form {
        legal_name: legal_name?,
        business_name,
        federal: federal?,
        llc,
        exempt_payee_code,
        fatca_code,
        line1: line1?,
        line2,
        city: city?,
        state: state?,
        postal_code: postal_code?,
        tin_type: tin_type?,
        tin: tin?,
        signed_name: signed_name?,
    })
}

fn check_the_form(details: &Value) -> Response {
    (
        StatusCode::BAD_REQUEST,
        axum::Json(json!({ "error": { "code": "BAD_REQUEST", "message": "Check the form", "details": details } })),
    )
        .into_response()
}

fn too_large() -> Response {
    answer(
        StatusCode::PAYLOAD_TOO_LARGE,
        "PAYLOAD_TOO_LARGE",
        "The form is too large",
    )
}

async fn submit(
    State(state): State<PublicState>,
    Path(token): Path<String>,
    headers: HeaderMap,
    request: axum::extract::Request,
) -> Response {
    let declared = headers
        .get(http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .map_or(0.0, weldsuite_kit::validation::js_number);
    if declared > 10240.0 {
        return too_large();
    }
    let (parts, body) = request.into_parts();
    let Ok(raw) = axum::body::to_bytes(body, usize::MAX).await else {
        return too_large();
    };
    // `c.req.text()` decodes as UTF-8; the encoded length is what counts.
    let text_body = String::from_utf8_lossy(&raw).into_owned();
    if text_body.len() > MAX_BODY_BYTES {
        return too_large();
    }
    let shared = Shared::of(&parts);
    match submit_form(&shared, &state, &token, &text_body).await {
        Ok(response) => response,
        Err(VendorTaxError::Invalid(message)) => {
            answer(StatusCode::BAD_REQUEST, "BAD_REQUEST", &message)
        }
        Err(VendorTaxError::NoKey) => answer(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_UNAVAILABLE",
            "The form cannot be saved right now",
        ),
        Err(error) => {
            tracing::error!(%error, "[books-api/public-w9] submit failed");
            answer(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                "The form could not be saved",
            )
        }
    }
}

#[allow(clippy::too_many_lines)] // the route's steps, as TypeScript has them
async fn submit_form(
    shared: &Shared,
    state: &PublicState,
    token: &str,
    text_body: &str,
) -> Result<Response, VendorTaxError> {
    let resolved = match resolve(shared, state, token).await {
        Ok(Some(resolved)) => resolved,
        Ok(None) => return Ok(not_found()),
        Err(error) => return Err(VendorTaxError::Internal(error)),
    };
    let Ok(body) = serde_json::from_str::<Value>(text_body) else {
        return Ok(answer(
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
            "The form is not valid JSON",
        ));
    };
    let mut issues = Issues::default();
    let form = issues
        .object(&body)
        .and_then(|fields| read_form(&mut issues, fields));
    if let Err(invalid) = issues.finish() {
        return Ok(check_the_form(&invalid.flatten()));
    }
    let Some(form) = form else {
        return Err(VendorTaxError::Internal("the form vanished".to_owned()));
    };

    let us_state = form.state.to_uppercase();
    if !is_address_state_code(&us_state) {
        return Ok(check_the_form(
            &json!({ "fieldErrors": { "address.state": ["Not a US state code"] } }),
        ));
    }
    let zip = validate_zip(&form.postal_code);
    if !zip.valid {
        let message = zip.error.unwrap_or_else(|| "Not a ZIP code".to_owned());
        return Ok(check_the_form(
            &json!({ "fieldErrors": { "address.postalCode": [message] } }),
        ));
    }
    let mut address = Map::new();
    address.insert("line1".into(), json!(form.line1));
    if let Some(line2) = form.line2.as_deref().filter(|l| !l.is_empty()) {
        address.insert("line2".into(), json!(line2));
    }
    address.insert("city".into(), json!(form.city));
    address.insert("state".into(), json!(us_state));
    address.insert(
        "postalCode".into(),
        json!(zip.formatted.unwrap_or(form.postal_code.clone())),
    );
    address.insert("country".into(), json!("US"));

    let now = now();
    let today = now[..10].to_owned();
    let mut w9 = Map::new();
    let mut put = |key: &str, value: Option<&str>| {
        if let Some(value) = value {
            w9.insert(key.to_owned(), json!(value));
        }
    };
    put("legalName", Some(&form.legal_name));
    put("businessName", form.business_name.as_deref());
    put("federalTaxClassification", Some(&form.federal));
    put("llcTaxClassification", form.llc.as_deref());
    put("exemptPayeeCode", form.exempt_payee_code.as_deref());
    put("fatcaCode", form.fatca_code.as_deref());
    put("receivedAt", Some(&today));
    put("signedName", Some(&form.signed_name));
    put("source", Some("online"));
    let input = VendorTaxInput {
        tin_type: Field::Set(form.tin_type.clone()),
        tin: Field::Set(form.tin.clone()),
        w9: Field::Set(w9),
        ..VendorTaxInput::default()
    };
    let party = &resolved.party;
    let tax = build_vendor_tax_change(Some(party), &input, &shared.keyring(state))?;

    // A corporation needs no 1099 (attorneys keep theirs): a vendor already flagged stays flagged.
    let corporation = is_corporation_classification(Some(&form.federal), form.llc.as_deref());
    let has_address = normalize_postal_address(party.get("billingAddress"))
        .and_then(|a| {
            a.get("line1")
                .and_then(Value::as_str)
                .map(|l| !l.is_empty())
        })
        .unwrap_or(false);
    let mut columns = tax.columns.clone();
    columns.insert(
        "is1099Vendor".into(),
        json!(party.get("is1099Vendor") == Some(&Value::Bool(true)) || !corporation),
    );
    if !has_address {
        columns.insert("billingAddress".into(), Value::Object(address));
    }
    columns.insert("updatedAt".into(), json!(now));
    let party_id = party
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let request_id = resolved
        .request
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut tx = resolved.db.begin().await?;
    PARTIES
        .patch_raw(&mut *tx, &party_id, PARTIES.values(&columns), false)
        .await?;
    sqlx::query(
        "update w9_requests set status = 'completed', completed_at = $2::timestamp, updated_at = $2::timestamp \
         where id = $1 and status = 'pending'",
    )
    .bind(&request_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    if let Some(cache) = shared.cache(state) {
        cache
            .delete_boxed(&w9_kv_key(&resolved.hash))
            .await
            .map_err(|error| VendorTaxError::Internal(format!("{error:?}")))?;
    }
    let entity_id = resolved
        .request
        .get("entityId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut changes = Map::new();
    changes.insert(
        "tin".into(),
        json!({
            "old": if party.get("tinLast4").and_then(Value::as_str).is_some_and(|t| !t.is_empty()) { json!("on file") } else { Value::Null },
            "new": "changed",
        }),
    );
    write_audit(
        &resolved.db,
        AuditInput {
            accounting_entity_id: entity_id.as_deref(),
            entity_type: "w9_request",
            entity_id: &request_id,
            action: "completed",
            changes: Some(changes),
        },
        None,
        None,
    )
    .await;

    let mut completed = resolved.request.clone();
    completed["status"] = json!("completed");
    completed["completedAt"] = json!(now);
    let context = EventContext::new(resolved.workspace_id.clone(), "w9-public", EventSource::Api);
    let publisher = state.books.events.clone();
    let events = vec![
        EntityEvent::new(
            W9_REQUEST_COMPLETED,
            &request_id,
            w9_event_data(&completed, Map::new()),
        ),
        EntityEvent::new(
            ACCOUNTING_CONTACT_UPDATED,
            &party_id,
            json!({ "id": party_id, "w9Received": true }),
        ),
    ];
    state.books.events.tracker().spawn(async move {
        for event in events {
            publisher.publish_and_wait(&context, event).await;
        }
    });
    Ok(axum::Json(json!({ "data": { "completed": true } })).into_response())
}
