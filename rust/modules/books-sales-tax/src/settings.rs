//! `/api/sales-tax` settings routes (`routes/sales-tax/settings.ts`): which
//! engine calculates the entity's sales tax and its credentials, the
//! provider registration check, the calculation preview the document forms
//! use, and address validation.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::address::normalize_postal_address;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, Reply, now, ok, reply, validate};
use weldsuite_books_domain::sales_tax::document_tax::{
    DocumentContext, DocumentKind, IssueDate, Runtime,
};
use weldsuite_books_domain::sales_tax::errors::SalesTaxError;
use weldsuite_books_domain::sales_tax::load::{LoadError, LoadOptions, load_sales_tax_context};
use weldsuite_books_domain::sales_tax::route_helpers::{
    require_entity_id, require_sales_tax_entity,
};
use weldsuite_books_domain::tax::{
    Direction, DocumentTaxItem, SupplyArgs, TaxArgs, calculate_document_tax,
    resolve_gst_bill_supply, resolve_gst_supply,
};
use weldsuite_catalogs::entity_events::ACCOUNTING_ENTITY_UPDATED;
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::br_fiscal;
use crate::common::{num, refuse, text};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |keys: &[&str]| gate.require(keys.iter().map(|k| (*k).to_owned()));
    Router::new()
        .route(
            "/settings",
            get(get_settings).route_layer(need(&["taxes:read"])),
        )
        .route(
            "/settings",
            axum::routing::put(put_settings).route_layer(need(&["taxes:update"])),
        )
        .route(
            "/registration-check",
            post(registration_check).route_layer(need(&["taxes:read", "taxes:update"])),
        )
        .route(
            "/calculate",
            post(calculate).route_layer(need(&[
                "invoices:create",
                "invoices:update",
                "bills:create",
                "bills:update",
                "taxes:read",
            ])),
        )
        .route(
            "/validate-address",
            post(validate_address).route_layer(need(&[
                "invoices:create",
                "invoices:update",
                "taxes:read",
            ])),
        )
        .with_state(state)
}

const ENGINES: [&str; 3] = ["manual", "stripe_tax", "avalara"];

/// `salesTaxRuntimeFromEnv(c.env)`.
pub(crate) fn runtime(caller: &Caller, state: &BooksState) -> Runtime {
    Runtime {
        keyring: caller.keyring(state),
        http: caller.http(state),
    }
}

/// A loading failure as the routes answer it (`salesTaxErrorResponse`, or
/// the route's 500).
pub(crate) fn load_failed(error: LoadError) -> Refusal {
    match error {
        LoadError::Engine(error) => {
            Refusal::Response(Box::new(SalesTaxError::Engine(error).response()))
        }
        LoadError::Database(error) => Refusal::Database(error),
    }
}

fn engine_error(error: weldsuite_books_domain::sales_tax::errors::EngineError) -> Refusal {
    Refusal::Response(Box::new(SalesTaxError::Engine(error).response()))
}

/// `settingsPayload(db, entity)`.
async fn settings_payload(caller: &Caller, entity: &Value) -> Result<Value, sqlx::Error> {
    let engine = text(entity, "salesTaxEngine")
        .filter(|e| ENGINES.contains(e))
        .unwrap_or("manual");
    let config = &entity["salesTaxEngineConfig"];
    let agencies: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'stateCode', state_code, 'level', level, 'name', name, \
         'status', status, 'registeredFrom', registered_from::text, 'registeredUntil', registered_until::text, \
         'providerRegistrationRef', provider_registration_ref) from sales_tax_agencies \
         where entity_id = $1 and deleted_at is null order by state_code asc, name asc",
    )
    .bind(text(entity, "id"))
    .fetch_all(&caller.db)
    .await?;
    let credentials_engine = config.get("credentialsEngine").and_then(Value::as_str);
    let has_credentials = text(entity, "salesTaxCredentialsEncrypted")
        .is_some_and(|c| !c.is_empty())
        && credentials_engine.is_none_or(|e| e.is_empty() || e == engine);
    let registered: Vec<Value> = agencies
        .iter()
        .filter(|a| a["status"].as_str() == Some("registered"))
        .map(|a| a["stateCode"].clone())
        .collect();
    Ok(json!({
        "entityId": entity["id"],
        "engine": engine,
        "config": {
            "companyCode": config.get("companyCode").cloned().unwrap_or(Value::Null),
            "environment": config.get("environment").cloned().filter(|e| !e.is_null()).unwrap_or(json!("production")),
        },
        "hasCredentials": has_credentials,
        "engineOptions": [
            { "id": "manual", "credentialFields": [], "configFields": [] },
            { "id": "stripe_tax", "credentialFields": ["apiKey"], "configFields": [] },
            { "id": "avalara", "credentialFields": ["accountId", "licenseKey"], "configFields": ["companyCode", "environment"] },
        ],
        "agencies": agencies,
        "registeredStates": registered,
    }))
}

// ── GET /settings ───────────────────────────────────────────────────────────

async fn get_settings(caller: Caller) -> Response {
    reply(
        async {
            let entity = require_sales_tax_entity(&caller).await?;
            Ok(ok(settings_payload(&caller, &entity).await?))
        }
        .await,
        "Failed to fetch sales tax settings",
    )
}

// ── PUT /settings ───────────────────────────────────────────────────────────

struct SettingsBody {
    engine: String,
    company_code: Field<String>,
    environment: Field<String>,
    /// `Absent`, `Null` (remove), or the given credentials.
    credentials: Field<Map<String, Value>>,
}

fn read_settings(issues: &mut Issues, body: &Map<String, Value>) -> SettingsBody {
    let engine = issues.choice(body, "engine", Presence::Required, &ENGINES);
    let config = issues.nested(body, "config", Presence::Optional, |i, c| {
        (
            i.text(c, "companyCode", Presence::Optional, Some(1), Some(25)),
            i.choice(
                c,
                "environment",
                Presence::Optional,
                &["sandbox", "production"],
            ),
        )
    });
    let credentials = issues.nested(body, "credentials", Presence::Nullish, |i, c| {
        let mut out = Map::new();
        for (key, min, max) in [
            ("apiKey", 8, 300),
            ("accountId", 1, 50),
            ("licenseKey", 1, 200),
        ] {
            if let Field::Set(value) = i.text(c, key, Presence::Optional, Some(min), Some(max)) {
                out.insert(key.to_owned(), json!(value));
            }
        }
        let extra: Vec<&String> = c
            .keys()
            .filter(|k| !["apiKey", "accountId", "licenseKey"].contains(&k.as_str()))
            .collect();
        if !extra.is_empty() {
            let listed = extra
                .iter()
                .map(|k| format!("'{k}'"))
                .collect::<Vec<_>>()
                .join(", ");
            i.issue_here(json!({
                "code": "unrecognized_keys",
                "keys": extra,
                "message": format!("Unrecognized key(s) in object: {listed}"),
            }));
        }
        out
    });
    let (company_code, environment) = match config {
        Field::Set((code, env)) => (code, env),
        _ => (Field::Absent, Field::Absent),
    };
    SettingsBody {
        engine: engine.into_option().unwrap_or_default(),
        company_code,
        environment,
        credentials,
    }
}

async fn put_settings(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_settings) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update sales tax settings"),
    };
    reply(
        update_settings(&caller, &state, data).await,
        "Failed to update sales tax settings",
    )
}

#[allow(clippy::too_many_lines, reason = "mirrors settings.ts's PUT /settings")]
async fn update_settings(caller: &Caller, state: &BooksState, data: SettingsBody) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = text(&entity, "id").unwrap_or_default().to_owned();
    let mut next = entity["salesTaxEngineConfig"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    if let Field::Set(code) = &data.company_code {
        next.insert("companyCode".into(), json!(code));
    }
    if let Field::Set(env) = &data.environment {
        next.insert("environment".into(), json!(env));
    }
    let mut blob = text(&entity, "salesTaxCredentialsEncrypted").map(str::to_owned);
    match &data.credentials {
        Field::Null => {
            blob = None;
            next.remove("credentialsEngine");
        }
        Field::Set(creds) => {
            let get = |k: &str| {
                creds
                    .get(k)
                    .and_then(Value::as_str)
                    .filter(|v| !v.is_empty())
            };
            if data.engine == "stripe_tax" && get("apiKey").is_none() {
                return Err(refuse(
                    "Stripe Tax needs an API key (a restricted key with Tax read and write access)",
                    400,
                ));
            }
            if data.engine == "avalara"
                && (get("accountId").is_none() || get("licenseKey").is_none())
            {
                return Err(refuse("Avalara needs an account ID and a license key", 400));
            }
            if data.engine == "manual" {
                return Err(refuse("The manual engine has no credentials", 400));
            }
            let keyring = caller.keyring(state);
            if keyring.v1.is_none() && keyring.v2.is_none() {
                return Err(Refusal::unavailable(
                    "Encryption is not configured, so engine credentials can not be stored",
                ));
            }
            let sealed = if data.engine == "stripe_tax" {
                json!({ "apiKey": creds.get("apiKey") })
            } else {
                let mut out = Map::new();
                for key in ["accountId", "licenseKey"] {
                    if let Some(v) = creds.get(key) {
                        out.insert(key.to_owned(), v.clone());
                    }
                }
                Value::Object(out)
            };
            blob = Some(
                weldsuite_db::encrypt_field(&sealed.to_string(), &keyring)
                    .map_err(|e| Refusal::Internal(e.to_string()))?,
            );
            next.insert("credentialsEngine".into(), json!(data.engine));
        }
        Field::Absent => {}
    }
    if data.engine != "manual" {
        let credentials_engine = next.get("credentialsEngine").and_then(Value::as_str);
        let stored = blob.as_deref().is_some_and(|b| !b.is_empty())
            && credentials_engine.is_none_or(|e| e.is_empty() || e == data.engine);
        if !stored {
            return Err(refuse(
                format!(
                    "Enter the {} credentials to use this engine",
                    if data.engine == "stripe_tax" {
                        "Stripe Tax"
                    } else {
                        "Avalara"
                    }
                ),
                400,
            ));
        }
    }
    if data.engine == "avalara"
        && next
            .get("companyCode")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return Err(refuse(
            "Avalara needs the company code the transactions are recorded under",
            400,
        ));
    }
    sqlx::query(
        "update entities set sales_tax_engine = $1, sales_tax_engine_config = $2, \
         sales_tax_credentials_encrypted = $3, updated_at = $4::timestamp where id = $5",
    )
    .bind(&data.engine)
    .bind(Value::Object(next.clone()))
    .bind(&blob)
    .bind(now())
    .bind(&entity_id)
    .execute(&caller.db)
    .await?;
    let mut audit = Map::new();
    audit.insert(
        "salesTaxEngine".into(),
        change(entity["salesTaxEngine"].clone(), json!(data.engine)),
    );
    audit.insert(
        "credentialsChanged".into(),
        change(Value::Null, json!(!data.credentials.is_absent())),
    );
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "accounting_entity",
            entity_id: &entity_id,
            action: "engine_changed",
            changes: Some(audit),
        },
    )
    .await;
    caller.publish(
        state,
        ACCOUNTING_ENTITY_UPDATED,
        &entity_id,
        json!({ "id": entity_id, "salesTaxEngine": data.engine }),
    );
    let mut updated = entity.as_object().cloned().unwrap_or_default();
    updated.insert("salesTaxEngine".into(), json!(data.engine));
    updated.insert("salesTaxEngineConfig".into(), Value::Object(next));
    updated.insert("salesTaxCredentialsEncrypted".into(), json!(blob));
    Ok(ok(settings_payload(caller, &Value::Object(updated)).await?))
}

// ── POST /registration-check ────────────────────────────────────────────────

async fn registration_check(caller: Caller, State(state): State<BooksState>) -> Response {
    reply(
        check_registrations(&caller, &state).await,
        "Failed to check the provider registrations",
    )
}

async fn check_registrations(caller: &Caller, state: &BooksState) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let rt = runtime(caller, state);
    let ctx = load_sales_tax_context(
        &caller.db,
        text(&entity, "id").unwrap_or_default(),
        LoadOptions {
            keyring: Some(&rt.keyring),
            http: rt.http.as_ref(),
        },
    )
    .await
    .map_err(load_failed)?;
    let Some(listed) = ctx.engine.list_registrations().await else {
        return Err(refuse(
            "The manual engine has no provider registrations to check. Choose Stripe Tax or Avalara first.",
            400,
        ));
    };
    let provider: Vec<_> = listed
        .map_err(engine_error)?
        .into_iter()
        .filter(|r| r.active)
        .collect();
    let registered: Vec<&Value> = ctx
        .agencies
        .iter()
        .filter(|a| text(a, "status") == Some("registered") && text(a, "level") == Some("state"))
        .collect();
    // `new Map(provider.map(r => [state, r]))`: the last one of a state wins.
    let provider_of = |state: &str| {
        provider
            .iter()
            .rev()
            .find(|r| r.state_code.to_uppercase() == state.to_uppercase())
    };
    let ours: Vec<String> = registered
        .iter()
        .map(|a| text(a, "stateCode").unwrap_or("").to_uppercase())
        .collect();
    let state_of = |a: &Value| text(a, "stateCode").unwrap_or("").to_owned();
    let matched: Vec<Value> = registered
        .iter()
        .filter_map(|a| {
            provider_of(&state_of(a)).map(|p| {
                json!({ "agencyId": a["id"], "stateCode": a["stateCode"], "name": a["name"], "providerRef": p.reference })
            })
        })
        .collect();
    let missing_in_provider: Vec<Value> = registered
        .iter()
        .filter(|a| provider_of(&state_of(a)).is_none())
        .map(|a| json!({ "agencyId": a["id"], "stateCode": a["stateCode"], "name": a["name"] }))
        .collect();
    let missing_in_books: Vec<Value> = provider
        .iter()
        .filter(|r| !ours.contains(&r.state_code.to_uppercase()))
        .map(|r| json!({ "stateCode": r.state_code, "providerRef": r.reference }))
        .collect();
    let in_sync = missing_in_provider.is_empty() && missing_in_books.is_empty();
    Ok(ok(json!({
        "engine": ctx.engine_id,
        "matched": matched,
        "missingInProvider": missing_in_provider,
        "missingInWeldBooks": missing_in_books,
        "inSync": in_sync,
    })))
}

// ── POST /calculate ─────────────────────────────────────────────────────────

const ADDRESS_FIELDS: [&str; 10] = [
    "line1",
    "line2",
    "city",
    "state",
    "postalCode",
    "country",
    "county",
    "street",
    "houseNumber",
    "province",
];

/// `addressSchema` (`.nullish()` at `key`): every field an optional string.
fn read_address(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Field<Value> {
    issues.nested(body, key, presence, |i, address| {
        let mut out = Map::new();
        for field in ADDRESS_FIELDS {
            if let Field::Set(v) = i.text(address, field, Presence::Optional, None, None) {
                out.insert(field.to_owned(), json!(v));
            }
        }
        Value::Object(out)
    })
}

/// `z.union([z.string(), z.number()]).transform(String)`.
fn amount(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Field<String> {
    match issues.string_or_number(body, key, presence) {
        Field::Set(Value::String(s)) => Field::Set(s),
        Field::Set(Value::Number(n)) => Field::Set(weldsuite_books_domain::js::number_text(
            n.as_f64().unwrap_or(f64::NAN),
        )),
        Field::Set(_) | Field::Absent => Field::Absent,
        Field::Null => Field::Null,
    }
}

struct Preview {
    kind: String,
    contact_id: Option<String>,
    issue_date: Option<String>,
    currency: Option<String>,
    billing: Option<Value>,
    shipping: Option<Value>,
    ship_from: Option<Value>,
    delivery: Option<Value>,
    marketplace: Option<bool>,
    original_invoice_id: Option<String>,
    place_of_supply: Option<String>,
    fiscal_data: Option<Value>,
    items: Vec<DocumentTaxItem>,
}

#[allow(clippy::too_many_lines, reason = "previewSchema, field by field")]
fn read_preview(issues: &mut Issues, body: &Map<String, Value>) -> Preview {
    let nullish = Presence::Nullish;
    let kind = issues.choice(
        body,
        "kind",
        Presence::Optional,
        &["invoice", "estimate", "credit_memo", "bill"],
    );
    let contact_id = issues.text(body, "contactId", nullish, None, Some(30));
    let issue_date = issues.text(body, "issueDate", Presence::Optional, None, None);
    let currency = issues.text(body, "currency", Presence::Optional, None, None);
    if let Field::Set(code) = &currency {
        issues.string_length("currency", 3, code.encode_utf16().count());
    }
    let billing = read_address(issues, body, "billingAddress", nullish);
    let shipping = read_address(issues, body, "shippingAddress", nullish);
    let ship_from = read_address(issues, body, "shipFromAddress", nullish);
    let delivery = read_address(issues, body, "deliveryAddress", nullish);
    let marketplace = issues.boolean(body, "marketplaceFacilitated", nullish);
    let original_invoice_id = issues.text(body, "originalInvoiceId", nullish, None, Some(30));
    let place_of_supply = issues.pattern(
        body,
        "placeOfSupply",
        nullish,
        None,
        None,
        |t| t.len() == 2 && t.bytes().all(|b| b.is_ascii_digit()),
        "Invalid",
    );
    let fiscal_data = br_fiscal::br_document_fiscal(issues, body);
    let items = issues.list(
        body,
        "items",
        Presence::Required,
        Some(1),
        Some(500),
        |i, item| {
            let fields = i.object(item)?;
            let id = i.text(fields, "id", Presence::Optional, None, Some(30));
            let description = i.text(fields, "description", nullish, None, None);
            let quantity = amount(i, fields, "quantity", Presence::Optional);
            let unit_price = amount(i, fields, "unitPrice", Presence::Required);
            let discount = amount(i, fields, "discountPercent", Presence::Optional);
            let sort_order = i.number(
                fields,
                "sortOrder",
                Presence::Optional,
                weldsuite_kit::validation::Number::default(),
            );
            let product_id = i.text(fields, "productId", nullish, None, Some(30));
            let tax_code = i.text(fields, "taxCode", nullish, None, Some(30));
            let tax_use = i.choice(fields, "taxUse", nullish, &["business", "personal"]);
            let tax_included = i.boolean(fields, "taxIncluded", nullish);
            let override_amount = amount(i, fields, "taxOverrideAmount", nullish);
            let override_reason = i.text(fields, "taxOverrideReason", nullish, None, Some(255));
            let accrue = i.boolean(fields, "accrueUseTax", nullish);
            let original_line_id = i.text(fields, "originalLineId", nullish, None, Some(30));
            let tax_rate_id = i.text(fields, "taxRateId", nullish, None, Some(30));
            let tax_rate = amount(i, fields, "taxRate", nullish);
            let ncm = br_fiscal::ncm(i, fields);
            let cfop = br_fiscal::cfop(i, fields);
            let fiscal = br_fiscal::br_line_fiscal(i, fields);
            Some(DocumentTaxItem {
                quantity: quantity.into_option(),
                unit_price: unit_price.into_option().unwrap_or_default(),
                discount_percent: discount.into_option(),
                tax_rate: tax_rate.into_option(),
                tax_rate_id: tax_rate_id.into_option(),
                id: id.into_option(),
                description: description.into_option(),
                sort_order: sort_order.into_option(),
                product_id: product_id.into_option(),
                tax_code: tax_code.into_option(),
                tax_use: tax_use.into_option(),
                tax_included: tax_included.into_option(),
                tax_override_amount: override_amount.into_option(),
                tax_override_reason: override_reason.into_option(),
                accrue_use_tax: accrue.into_option(),
                original_line_id: original_line_id.into_option(),
                ncm: ncm.into_option(),
                cfop: cfop.into_option(),
                fiscal_data: fiscal.into_option(),
            })
        },
    );
    Preview {
        kind: kind.into_option().unwrap_or_else(|| "invoice".to_owned()),
        contact_id: contact_id.into_option(),
        issue_date: issue_date.into_option(),
        currency: currency.into_option(),
        billing: billing.into_option(),
        shipping: shipping.into_option(),
        ship_from: ship_from.into_option(),
        delivery: delivery.into_option(),
        marketplace: marketplace.into_option(),
        original_invoice_id: original_invoice_id.into_option(),
        place_of_supply: place_of_supply.into_option(),
        fiscal_data: fiscal_data.into_option(),
        items: items.into_option().unwrap_or_default(),
    }
}

async fn calculate(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_preview) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to calculate tax"),
    };
    reply(
        preview(&caller, &state, data).await,
        "Failed to calculate tax",
    )
}

#[allow(
    clippy::too_many_lines,
    reason = "mirrors settings.ts's POST /calculate"
)]
async fn preview(caller: &Caller, state: &BooksState, data: Preview) -> Reply {
    let entity_id = require_entity_id(caller).await?;
    let purchase = data.kind == "bill";
    let billing = normalize_postal_address(data.billing.as_ref());
    let shipping = normalize_postal_address(data.shipping.as_ref());
    let items: Vec<DocumentTaxItem> = data
        .items
        .into_iter()
        .enumerate()
        .map(|(index, mut item)| {
            if item.id.is_none() {
                item.id = Some(format!("line_{index}"));
            }
            item
        })
        .collect();
    let db = &caller.db;
    let gst = if purchase {
        resolve_gst_bill_supply(db, &entity_id, data.contact_id.as_deref(), billing.as_ref())
            .await?
    } else {
        resolve_gst_supply(
            db,
            SupplyArgs {
                entity_id: &entity_id,
                contact_id: data.contact_id.as_deref(),
                place_of_supply: data.place_of_supply.as_deref(),
                shipping_address: shipping.as_ref(),
                billing_address: billing.as_ref(),
            },
        )
        .await?
    };
    let rt = runtime(caller, state);
    let buyer = shipping.as_ref().or(billing.as_ref());
    let country = buyer.and_then(|b| b.get("country")).and_then(Value::as_str);
    let province = buyer.and_then(|b| b.get("state")).and_then(Value::as_str);
    let document = DocumentContext {
        kind: match data.kind.as_str() {
            "estimate" => DocumentKind::Estimate,
            "credit_memo" => DocumentKind::CreditMemo,
            "bill" => DocumentKind::Bill,
            _ => DocumentKind::Invoice,
        },
        document_id: None,
        document_number: None,
        contact_id: data.contact_id.clone(),
        issue_date: IssueDate::Text(
            data.issue_date
                .clone()
                .unwrap_or_else(|| now()[..10].to_owned()),
        ),
        currency: data.currency.clone(),
        billing_address: billing.clone(),
        shipping_address: shipping.clone(),
        delivery_address: normalize_postal_address(data.delivery.as_ref()),
        ship_from_address: normalize_postal_address(data.ship_from.as_ref()),
        marketplace_facilitated: data.marketplace,
        fiscal_data: data.fiscal_data.clone(),
        original_invoice_id: data.original_invoice_id.clone(),
    };
    let mut args = TaxArgs::new(
        &entity_id,
        if purchase {
            Direction::Purchase
        } else {
            Direction::Sales
        },
        &items,
    );
    args.buyer_country = country;
    args.billing_province = province;
    args = args.with_gst(gst.as_ref());
    args.document = Some(&document);
    args.runtime = Some(&rt);
    let calc = calculate_document_tax(db, &args).await?;

    // The same rows grouped per jurisdiction, for the totals block.
    let mut groups: Vec<(String, Map<String, Value>)> = Vec::new();
    for row in &calc.tax_breakdown {
        let tax_rate = weldsuite_books_domain::js::js_number_value(row.get("taxRate"));
        let level = text(row, "jurisdictionLevel");
        let kind = text(row, "kind");
        let code = row
            .get("jurisdictionCode")
            .filter(|v| !v.is_null())
            .or_else(|| row.get("taxRateName"));
        let key = format!(
            "{}|{}|{}|{}",
            code.map(js_string).unwrap_or_default(),
            level.unwrap_or(""),
            weldsuite_books_domain::js::number_text(tax_rate),
            kind.unwrap_or("")
        );
        let taxable = weldsuite_books_domain::js::js_number_value(row.get("taxableAmount"));
        let tax = weldsuite_books_domain::js::js_number_value(row.get("taxAmount"));
        if let Some((_, entry)) = groups.iter_mut().find(|(k, _)| *k == key) {
            let sum = |a: &Value, b: f64| {
                weldsuite_books_domain::js::math_round((a.as_f64().unwrap_or(0.0) + b) * 100.0)
                    / 100.0
            };
            let t = sum(&entry["taxableAmount"], taxable);
            let x = sum(&entry["taxAmount"], tax);
            entry.insert("taxableAmount".into(), num(t));
            entry.insert("taxAmount".into(), num(x));
        } else {
            let mut entry = Map::new();
            entry.insert(
                "jurisdictionCode".into(),
                row.get("jurisdictionCode").cloned().unwrap_or(Value::Null),
            );
            entry.insert(
                "jurisdictionName".into(),
                row.get("jurisdictionName")
                    .filter(|v| !v.is_null())
                    .or_else(|| row.get("taxRateName"))
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            entry.insert("level".into(), json!(level.unwrap_or("state")));
            entry.insert(
                "stateCode".into(),
                row.get("stateCode").cloned().unwrap_or(Value::Null),
            );
            entry.insert(
                "agencyId".into(),
                row.get("agencyId").cloned().unwrap_or(Value::Null),
            );
            entry.insert("rate".into(), num(tax_rate));
            entry.insert("taxableAmount".into(), num(taxable));
            entry.insert("taxAmount".into(), num(tax));
            entry.insert("kind".into(), json!(kind.unwrap_or("tax")));
            groups.push((key, entry));
        }
    }
    let meta = calc.sales_tax.as_ref();
    let lines: Vec<Value> = calc
        .processed_items
        .iter()
        .enumerate()
        .map(|(index, p)| {
            json!({
                "index": index,
                "id": items[index].id,
                "lineTotal": p.line_total,
                "taxAmount": p.tax_amount,
                "lineTotalWithTax": p.line_total_with_tax,
                "taxRate": p.tax_rate,
                "taxRateId": p.tax_rate_id,
                "taxCode": p.tax_code,
            })
        })
        .collect();
    Ok(ok(json!({
        "engine": meta.map(|m| m.engine.clone()),
        "engineRef": meta.and_then(|m| m.engine_ref.clone()),
        "calculatedAt": meta.map_or_else(now, |m| m.calculated_at.clone()),
        "warnings": meta.map(|m| m.warnings.clone()).unwrap_or_default(),
        "shipToState": meta.and_then(|m| m.ship_to_state.clone()),
        "shipToPostalCode": meta.and_then(|m| m.ship_to_postal_code.clone()),
        "addressIncomplete": meta.is_some_and(|m| m.address_incomplete),
        "subtotal": calc.subtotal,
        "discountTotal": calc.discount_total,
        "taxTotal": calc.tax_total,
        "total": calc.total,
        "lines": lines,
        "jurisdictions": groups.into_iter().map(|(_, e)| Value::Object(e)).collect::<Vec<_>>(),
        "taxBreakdown": calc.tax_breakdown,
        "placeOfSupply": gst.and_then(|g| g.place_of_supply),
    })))
}

/// `${value}` of a JSON scalar.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => weldsuite_books_domain::js::number_text(n.as_f64().unwrap_or(f64::NAN)),
        Value::Null => "null".to_owned(),
        other => other.to_string(),
    }
}

// ── POST /validate-address ──────────────────────────────────────────────────

async fn validate_address(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let address = match validate(&headers, &body, |i, b| {
        read_address(i, b, "address", Presence::Required)
    }) {
        Ok(address) => address.into_option().unwrap_or(Value::Null),
        Err(refusal) => return refusal.respond("Failed to validate the address"),
    };
    reply(
        check_address(&caller, &state, &address).await,
        "Failed to validate the address",
    )
}

async fn check_address(caller: &Caller, state: &BooksState, address: &Value) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let rt = runtime(caller, state);
    let ctx = load_sales_tax_context(
        &caller.db,
        text(&entity, "id").unwrap_or_default(),
        LoadOptions {
            keyring: Some(&rt.keyring),
            http: rt.http.as_ref(),
        },
    )
    .await
    .map_err(load_failed)?;
    if !matches!(
        ctx.engine,
        weldsuite_books_domain::sales_tax::Engine::Avalara(_)
    ) {
        return Err(refuse(
            "Address validation needs a provider engine that offers it (Avalara). The manual engine and Stripe Tax do not validate addresses.",
            400,
        ));
    }
    let Some(normalized) = normalize_postal_address(Some(address)) else {
        return Err(refuse("Enter an address to validate", 400));
    };
    let Some(result) = ctx.engine.validate_address(&normalized).await else {
        return Err(refuse("Enter an address to validate", 400));
    };
    let validation = result.map_err(engine_error)?;
    let mut out = Map::new();
    out.insert("engine".into(), json!(ctx.engine_id));
    out.extend(validation.to_json());
    Ok(ok(Value::Object(out)))
}
