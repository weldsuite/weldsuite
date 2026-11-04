//! `/api/accounting-contacts` (`routes/accounting-contacts/index.ts`): the
//! customers and suppliers of the books, `parties` rows wrapping a CRM
//! company or person. The party keeps the accounting fields; identity facts
//! live on the wrapped company or person, written through the CRM's domain
//! code ([`identity`]). US vendor tax data rides on the same bodies
//! (`books_domain::vendor_tax`): the TIN and the ACH account number are
//! write-only and come back only through the logged reveal routes.

mod body;
mod identity;

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::Response;
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::address::normalize_postal_address;
use weldsuite_books_domain::contacts::load_billing_contacts;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, json_of, no_content, now, ok, paged, reply,
    validate,
};
use weldsuite_books_domain::identifiers::{
    check_vat_number_format, iban_length, iban_problem, normalize_iban,
};
use weldsuite_books_domain::jurisdictions::{br, india, js_trim};
use weldsuite_books_domain::tables::{BILLS, COMPANIES, INVOICES, PARTIES, PEOPLE, TAX_ID_REVEALS};
use weldsuite_books_domain::vendor_tax::{
    NO_KEY_MESSAGE, SecretField, VendorTaxError, build_vendor_tax_change, format_tin, is_tin_type,
    reveal_party_secret, strip_tax_fields_for_event, vendor_tax_derived,
};
use weldsuite_catalogs::entity_events::{
    ACCOUNTING_CONTACT_ARCHIVED, ACCOUNTING_CONTACT_CREATED, ACCOUNTING_CONTACT_DELETED,
    ACCOUNTING_CONTACT_UPDATED,
};
use weldsuite_kit::ApiError;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

pub(crate) use body::hook_message;
use body::{ContactPayload, PAYLOAD_KEYS, normalize, read_payload};
use identity::{
    ContactError, IdentityLink, bad_request, create_identity, person_phone, sync_contact_person,
    sync_identity,
};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |keys: &[&str]| gate.require(keys.iter().map(|k| (*k).to_owned()));
    let read = || need(&["invoices:read"]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create).route_layer(need(&["invoices:create"])))
        .route(
            "/import-from-crm",
            post(import_from_crm).route_layer(need(&["invoices:create"])),
        )
        .route("/{id}", get(detail).route_layer(read()))
        .route(
            "/{id}",
            axum::routing::put(update)
                .patch(update)
                .route_layer(need(&["invoices:update"])),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove)
                .route_layer(need(&["customers:delete", "suppliers:delete"])),
        )
        .route("/{id}/invoices", get(invoices).route_layer(read()))
        .route("/{id}/bills", get(bills).route_layer(read()))
        .route("/{id}/balance", get(balance).route_layer(read()))
        .route(
            "/{id}/archive",
            post(archive).route_layer(need(&["customers:update", "suppliers:update"])),
        )
        .route(
            "/{id}/unarchive",
            post(unarchive).route_layer(need(&["customers:update", "suppliers:update"])),
        )
        .route(
            "/{id}/promote-role",
            post(promote_role).route_layer(need(&["invoices:update"])),
        )
        .route(
            "/{id}/reveal-tin",
            post(reveal_tin).route_layer(need(&["tax_ids:reveal"])),
        )
        .route(
            "/{id}/reveal-ach-account",
            post(reveal_ach).route_layer(need(&["tax_ids:reveal"])),
        )
        .route(
            "/{id}/tax-id-reveals",
            get(reveal_log).route_layer(need(&["tax_ids:reveal"])),
        )
        .route(
            "/{id}/verify-bank-details",
            post(verify_bank_details).route_layer(need(&["banking:manage"])),
        )
        .with_state(state)
}

// ── views ───────────────────────────────────────────────────────────────────

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `value || null`.
fn or_null(value: Option<&str>) -> Value {
    value
        .filter(|v| !v.is_empty())
        .map_or(Value::Null, |v| json!(v))
}

/// `parsePaymentTermsDays(value)`: `30`, `net 30`, `30 days`.
fn parse_payment_terms_days(value: Option<&str>) -> Value {
    let Some(raw) = value.filter(|v| !v.is_empty()) else {
        return Value::Null;
    };
    let lower = js_trim(raw).to_lowercase();
    let rest = lower.strip_prefix("net").map_or(lower.as_str(), |r| {
        r.trim_start_matches(weldsuite_books_domain::jurisdictions::is_js_space)
    });
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let tail = js_trim(&rest[digits.len()..]);
    let tail_ok = tail.is_empty() || tail == "day" || tail == "days";
    if digits.is_empty() || digits.len() > 4 || !tail_ok {
        return Value::Null;
    }
    digits.parse::<i64>().map_or(Value::Null, |n| json!(n))
}

/// `toContactPersonView(person)`.
fn contact_person_view(person: &Value) -> Value {
    json!({
        "personId": person.get("id").cloned().unwrap_or(Value::Null),
        "name": person.get("displayName").cloned().unwrap_or(Value::Null),
        "firstName": or_null(text(person, "firstName")),
        "lastName": or_null(text(person, "lastName")),
        "email": or_null(text(person, "email")),
        "phone": person_phone(person).map_or(Value::Null, Value::String),
    })
}

fn pick<'a>(row: Option<&'a Value>, key: &str) -> Option<&'a str> {
    row.and_then(|r| text(r, key))
}

/// `toContactView(party, company, person, billingContact)`.
fn contact_view(
    party: &Value,
    company: Option<&Value>,
    person: Option<&Value>,
    billing_contact: Option<&Value>,
) -> Value {
    let mut view = party.as_object().cloned().unwrap_or_default();
    view.remove("sensitiveEncrypted");
    let billing = view.remove("billingAddress");
    let shipping = view.remove("shippingAddress");
    view.extend(vendor_tax_derived(party));
    let name = party
        .get("displayName")
        .filter(|v| !v.is_null())
        .or_else(|| {
            company
                .and_then(|c| c.get("displayName"))
                .filter(|v| !v.is_null())
        })
        .or_else(|| {
            person
                .and_then(|p| p.get("displayName"))
                .filter(|v| !v.is_null())
        })
        .cloned()
        .unwrap_or_else(|| json!(""));
    let vat = or_null(pick(company, "vatNumber"));
    let registration = or_null(pick(company, "registrationNumber"));
    let (email, phone, notes) = match company {
        Some(company) => (
            or_null(text(company, "email")),
            or_null(text(company, "phone")),
            or_null(text(company, "notes")),
        ),
        None => (
            or_null(pick(person, "email")),
            person
                .and_then(person_phone)
                .map_or(Value::Null, Value::String),
            or_null(pick(person, "notes")),
        ),
    };
    let null_of = |row: Option<&Value>, key: &str| {
        row.and_then(|r| r.get(key)).cloned().unwrap_or(Value::Null)
    };
    view.insert("name".into(), name);
    view.insert("companyName".into(), null_of(company, "name"));
    view.insert("firstName".into(), null_of(person, "firstName"));
    view.insert("lastName".into(), null_of(person, "lastName"));
    view.insert("email".into(), email);
    view.insert("phone".into(), phone);
    view.insert(
        "contactPerson".into(),
        match (company, billing_contact) {
            (Some(_), Some(contact)) => contact_person_view(contact),
            _ => Value::Null,
        },
    );
    view.insert("vatNumber".into(), vat.clone());
    view.insert("registrationNumber".into(), registration.clone());
    view.insert("notes".into(), notes);
    view.insert("taxNumber".into(), vat);
    view.insert("kvkNumber".into(), registration);
    view.insert(
        "paymentTermsDays".into(),
        parse_payment_terms_days(text(party, "paymentTerms")),
    );
    view.insert(
        "billingAddress".into(),
        normalize_postal_address(billing.as_ref()).unwrap_or(Value::Null),
    );
    view.insert(
        "shippingAddress".into(),
        normalize_postal_address(shipping.as_ref()).unwrap_or(Value::Null),
    );
    Value::Object(view)
}

/// `loadIdentities(db, rows)`.
struct Identities {
    companies: HashMap<String, Value>,
    people: HashMap<String, Value>,
    billing: HashMap<String, Value>,
}

fn ids_of(rows: &[Value], key: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for row in rows {
        if let Some(id) = text(row, key).filter(|id| !id.is_empty())
            && !ids.iter().any(|known| known == id)
        {
            ids.push(id.to_owned());
        }
    }
    ids
}

fn by_id(rows: Vec<Value>) -> HashMap<String, Value> {
    rows.into_iter()
        .filter_map(|row| Some((text(&row, "id")?.to_owned(), row)))
        .collect()
}

async fn load_identities(db: &sqlx::PgPool, rows: &[Value]) -> Result<Identities, sqlx::Error> {
    let company_ids = ids_of(rows, "companyId");
    let person_ids = ids_of(rows, "personId");
    let companies: Vec<Value> = if company_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(companies),
            " from companies t where t.id = any($1)"
        ))
        .bind(&company_ids)
        .fetch_all(db)
        .await?
    };
    let people: Vec<Value> = if person_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(people),
            " from people t where t.id = any($1)"
        ))
        .bind(&person_ids)
        .fetch_all(db)
        .await?
    };
    Ok(Identities {
        companies: by_id(COMPANIES.js_rows(companies)),
        people: by_id(PEOPLE.js_rows(people)),
        billing: load_billing_contacts(db, &company_ids).await?,
    })
}

fn view_with(party: &Value, identities: &Identities) -> Value {
    let company_id = text(party, "companyId").filter(|id| !id.is_empty());
    let person_id = text(party, "personId").filter(|id| !id.is_empty());
    contact_view(
        party,
        company_id.and_then(|id| identities.companies.get(id)),
        person_id.and_then(|id| identities.people.get(id)),
        company_id.and_then(|id| identities.billing.get(id)),
    )
}

/// The live party row.
async fn find_party(db: &sqlx::PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(parties),
        " from parties t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| PARTIES.js(row)))
}

/// `loadContactView(db, id)`.
async fn load_contact_view(db: &sqlx::PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let Some(party) = find_party(db, id).await? else {
        return Ok(None);
    };
    let identities = load_identities(db, std::slice::from_ref(&party)).await?;
    Ok(Some(view_with(&party, &identities)))
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(list_contacts(&caller, &q).await, "Failed to fetch contacts")
}

/// `Number.parseInt(raw || fallback, 10)`, `None` for NaN.
fn parse_page(q: &Query, key: &str, fallback: i64) -> Option<i64> {
    weldsuite_books_domain::js::parse_int(q.present(key).unwrap_or(&fallback.to_string()))
}

/// The list filters: archived, role, search, kind and 1099 vendors.
macro_rules! contacts_where {
    () => {
        "t.deleted_at is null          and ($1 = 'include' or ($1 = 'only' and t.archived_at is not null) or ($1 = 'hide' and t.archived_at is null))          and ($2::text is null or ($2 in ('customer', 'supplier') and (t.role = $2 or t.role = 'both'))               or ($2 not in ('customer', 'supplier') and t.role = $2))          and ($3::text is null or t.display_name ilike $3)          and ($4::text is null or t.kind = $4)          and ($5 = false or t.is_1099_vendor = true)"
    };
}

async fn list_contacts(caller: &Caller, q: &Query) -> Reply {
    let page = parse_page(q, "page", 1).map(|p| p.max(1));
    let size = parse_page(q, "pageSize", 25).map(|s| s.clamp(1, 100));
    let (Some(page), Some(size)) = (page, size) else {
        return Err(Refusal::Internal("page or pageSize is NaN".to_owned()));
    };
    let archived = match q.get("archived") {
        Some("only") => "only",
        Some("include") => "include",
        _ => "hide",
    };
    let role = q.present("role");
    let search = q.present("search").map(|s| format!("%{s}%"));
    let kind = q.get("kind").filter(|k| *k == "company" || *k == "person");
    let vendors_1099 = q.get("is1099Vendor") == Some("true");
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(parties),
        " from parties t where ",
        contacts_where!(),
        " order by t.created_at desc limit $6 offset $7"
    ))
    .bind(archived)
    .bind(role)
    .bind(&search)
    .bind(kind)
    .bind(vendors_1099)
    .bind(size)
    .bind((page - 1) * size)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*)::bigint from parties t where ",
        contacts_where!()
    ))
    .bind(archived)
    .bind(role)
    .bind(&search)
    .bind(kind)
    .bind(vendors_1099)
    .fetch_one(&caller.db)
    .await?;
    let rows = PARTIES.js_rows(rows);
    let identities = load_identities(&caller.db, &rows).await?;
    let data = rows.iter().map(|row| view_with(row, &identities)).collect();
    Ok(paged(data, total, page * size < total, None))
}

// ── GET /:id and its documents ──────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Reply = async {
        match load_contact_view(&caller.db, &id).await? {
            Some(view) => Ok(ok(view)),
            None => Err(Refusal::not_found("Contact", &id)),
        }
    }
    .await;
    reply(result, "Failed to fetch contact")
}

async fn invoices(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Reply = async {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(invoices),
            " from invoices t where t.contact_id = $1 and t.deleted_at is null order by t.issue_date desc"
        ))
        .bind(&id)
        .fetch_all(&caller.db)
        .await?;
        Ok(ok(Value::Array(INVOICES.js_rows(rows))))
    }
    .await;
    reply(result, "Failed to fetch contact invoices")
}

async fn bills(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Reply = async {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(bills),
            " from bills t where t.contact_id = $1 and t.deleted_at is null order by t.issue_date desc"
        ))
        .bind(&id)
        .fetch_all(&caller.db)
        .await?;
        Ok(ok(Value::Array(BILLS.js_rows(rows))))
    }
    .await;
    reply(result, "Failed to fetch contact bills")
}

/// What is open, and what of it is overdue, as text.
macro_rules! balance_sums {
    () => {
        "coalesce(sum(balance_due::numeric), 0)::text,          coalesce(sum(case when due_date < now() and balance_due::numeric > 0 then balance_due::numeric else 0 end), 0)::text"
    };
}

async fn balance(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Reply = async {
        let (inv_out, inv_due): (String, String) = sqlx::query_as(concat!(
            "select ",
            balance_sums!(),
            " from invoices where contact_id = $1 and deleted_at is null"
        ))
        .bind(&id)
        .fetch_one(&caller.db)
        .await?;
        let (bill_out, bill_due): (String, String) = sqlx::query_as(concat!(
            "select ",
            balance_sums!(),
            " from bills where contact_id = $1 and deleted_at is null"
        ))
        .bind(&id)
        .fetch_one(&caller.db)
        .await?;
        Ok(ok(json!({
            "receivable": { "totalOutstanding": inv_out, "totalOverdue": inv_due },
            "payable": { "totalOutstanding": bill_out, "totalOverdue": bill_due },
        })))
    }
    .await;
    reply(result, "Failed to fetch contact balance")
}

async fn import_from_crm() -> Response {
    ok(json!({
        "imported": 0,
        "message": "Contacts and customers now use the same table. No import needed.",
    }))
}

// ── writes ──────────────────────────────────────────────────────────────────

/// The body through the preprocess and the schema, or the hook's 400.
fn read_contact_body(
    headers: &HeaderMap,
    raw: &Bytes,
    partial: bool,
) -> Result<ContactPayload, Refusal> {
    let body = normalize(&json_of(headers, raw)?, partial);
    let mut issues = Issues::default();
    let data = issues
        .object(&body)
        .map(|fields| read_payload(&mut issues, fields, partial));
    issues
        .finish()
        .map_err(|invalid| Refusal::bad_request(hook_message(&invalid)))?;
    data.ok_or_else(|| Refusal::bad_request("Invalid request body"))
}

/// `ContactIdentityError`, `PersonDuplicateEmailError`, `VendorTaxError`,
/// `VendorTaxKeyError`, else the route's 500.
fn contact_refusal(error: ContactError, fallback: &str) -> Refusal {
    match error {
        ContactError::Identity {
            conflict,
            message,
            details,
        } => {
            let error = if conflict {
                ApiError::conflict(message)
            } else {
                ApiError::bad_request(message)
            };
            match details {
                Some(details) => error.with_details(details).into(),
                None => error.into(),
            }
        }
        ContactError::DuplicateEmail(existing) => Refusal::conflict_with(
            "Another person in the CRM already has this email address.",
            json!({ "code": "PERSON_EMAIL_EXISTS", "existingPersonId": existing }),
        ),
        ContactError::Tax(VendorTaxError::Invalid(message)) => Refusal::bad_request(message),
        ContactError::Tax(VendorTaxError::NoKey) => Refusal::unavailable(NO_KEY_MESSAGE),
        ContactError::Tax(other) => Refusal::Internal(format!("{fallback}: {other}")),
        ContactError::Failed(message) => Refusal::Internal(format!("{fallback}: {message}")),
    }
}

/// `assertW9Document(db, data)`.
async fn assert_w9_document(db: &sqlx::PgPool, data: &ContactPayload) -> Result<(), ContactError> {
    let Some(document_id) = data
        .tax
        .w9
        .as_set()
        .and_then(|w9| w9.get("documentId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        return Ok(());
    };
    let found: Option<String> =
        sqlx::query_scalar("select id from documents where id = $1 and deleted_at is null limit 1")
            .bind(document_id)
            .fetch_optional(db)
            .await?;
    if found.is_none() {
        return Err(VendorTaxError::Invalid(format!(
            "w9.documentId: document {document_id} not found"
        ))
        .into());
    }
    Ok(())
}

/// `checkIdentifierFormats(data, storedBilling)`: a VAT number fits its
/// country, an IBAN its length and check digits.
fn check_identifier_formats(
    data: &mut ContactPayload,
    stored_billing: Option<&Value>,
) -> Result<(), ContactError> {
    if let Field::Set(raw) = &data.vat_number {
        let vat = js_trim(raw).to_owned();
        if !vat.is_empty() {
            let billing = match &data.billing_address {
                Field::Absent => stored_billing.cloned(),
                Field::Null => None,
                Field::Set(address) => Some(address.clone()),
            };
            let country = normalize_postal_address(billing.as_ref())
                .and_then(|a| a.get("country").and_then(Value::as_str).map(str::to_owned));
            let check = check_vat_number_format(Some(&vat), country.as_deref());
            if !check.valid {
                let example = check
                    .example
                    .map(|e| format!(" (for example {e})"))
                    .unwrap_or_default();
                return Err(bad_request(
                    format!(
                        "\"{vat}\" is not a valid {} VAT number{example}",
                        check.prefix.unwrap_or("null")
                    ),
                    Some(json!({ "field": "vatNumber" })),
                ));
            }
            if check.prefix.is_some()
                && let Some(formatted) = check.formatted
            {
                data.vat_number = Field::Set(formatted);
            }
        }
    }
    if let Field::Set(raw) = &data.iban {
        let iban = js_trim(raw);
        if !iban.is_empty()
            && let Some(problem) = iban_problem(iban)
        {
            let country: String = normalize_iban(iban).chars().take(2).collect();
            let reason = match problem {
                "country_length" => format!(
                    "an IBAN from {country} has {} characters",
                    iban_length(&country).map_or_else(|| "undefined".to_owned(), |n| n.to_string())
                ),
                "checksum" => "the check digits do not match".to_owned(),
                _ => "it should be two letters, two digits and the account number".to_owned(),
            };
            return Err(bad_request(
                format!("\"{iban}\" is not a valid IBAN: {reason}"),
                Some(json!({ "field": "iban" })),
            ));
        }
    }
    Ok(())
}

/// The entity's jurisdiction, upper-cased (`entity?.jurisdictionCode?.toUpperCase()`).
async fn entity_jurisdiction(caller: &Caller) -> Result<Option<String>, sqlx::Error> {
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Ok(None);
    };
    let code: Option<Option<String>> =
        sqlx::query_scalar("select jurisdiction_code from entities where id = $1 limit 1")
            .bind(entity_id)
            .fetch_optional(&caller.db)
            .await?;
    Ok(code.flatten().map(|c| c.to_uppercase()))
}

fn billing_country(data: &ContactPayload) -> Option<String> {
    normalize_postal_address(data.billing_address.as_set())
        .and_then(|a| a.get("country").and_then(Value::as_str).map(str::to_owned))
}

/// `checkIndianTaxNumber(c, db, data)`.
async fn check_indian_tax_number(
    caller: &Caller,
    data: &mut ContactPayload,
) -> Result<(), ContactError> {
    let Some(vat) = data
        .vat_number
        .as_set()
        .map(|v| js_trim(v).to_owned())
        .filter(|v| !v.is_empty())
    else {
        return Ok(());
    };
    if entity_jurisdiction(caller).await?.as_deref() != Some("IN") {
        return Ok(());
    }
    let country = billing_country(data);
    let indian = country
        .as_deref()
        .is_none_or(|c| ["IN", "IND", "INDIA"].contains(&c));
    let compact: Vec<u8> = vat
        .chars()
        .filter(|c| !(weldsuite_books_domain::jurisdictions::is_js_space(*c) || *c == '-'))
        .collect::<String>()
        .into_bytes();
    let looks_like_gstin = compact.len() >= 11
        && compact[..2].iter().all(u8::is_ascii_digit)
        && compact[2..7].iter().all(u8::is_ascii_alphabetic)
        && compact[7..11].iter().all(u8::is_ascii_digit);
    if !indian || (!looks_like_gstin && country.as_deref() != Some("IN")) {
        return Ok(());
    }
    let pan = data.registration_number.as_set().map(String::as_str);
    let check = india::validate_gstin(&vat, pan);
    if !check.valid {
        return Err(bad_request(
            check.error.unwrap_or_else(|| "Invalid GSTIN".to_owned()),
            Some(json!({ "field": "vatNumber" })),
        ));
    }
    data.vat_number = check.formatted.map_or(Field::Absent, Field::Set);
    Ok(())
}

/// `checkBrazilianTaxNumber(c, db, data)`.
async fn check_brazilian_tax_number(
    caller: &Caller,
    data: &mut ContactPayload,
) -> Result<(), ContactError> {
    let vat = data
        .vat_number
        .as_set()
        .map(|v| js_trim(v).to_owned())
        .filter(|v| !v.is_empty());
    let cpf = data
        .br_fiscal
        .as_set()
        .and_then(|b| b.get("taxId"))
        .and_then(Value::as_str)
        .map(|v| js_trim(v).to_owned())
        .filter(|v| !v.is_empty());
    if vat.is_none() && cpf.is_none() {
        return Ok(());
    }
    if entity_jurisdiction(caller).await?.as_deref() != Some("BR") {
        return Ok(());
    }
    if let Some(country) = billing_country(data)
        && !["BR", "BRA", "BRAZIL", "BRASIL"].contains(&country.to_uppercase().as_str())
    {
        return Ok(());
    }
    let set_tax_id = |data: &mut ContactPayload, formatted: Option<String>| {
        let mut fiscal = data.br_fiscal.as_set().cloned().unwrap_or_default();
        fiscal.insert("taxId".into(), formatted.map_or(Value::Null, Value::String));
        data.br_fiscal = Field::Set(fiscal);
    };
    if let Some(cpf) = cpf {
        let check = br::validate_cpf(&cpf);
        if !check.valid {
            return Err(bad_request(
                check.error.unwrap_or_else(|| "Invalid CPF".to_owned()),
                Some(json!({ "field": "brFiscal.taxId" })),
            ));
        }
        set_tax_id(data, check.formatted);
    }
    let Some(vat) = vat else {
        return Ok(());
    };
    let check = br::validate_cnpj_or_cpf(&vat);
    if !check.valid {
        return Err(bad_request(
            check.error.unwrap_or_else(|| "Invalid CNPJ".to_owned()),
            Some(json!({ "field": "vatNumber" })),
        ));
    }
    let compact: String = vat
        .chars()
        .filter(|c| !matches!(c, '.' | '/' | '-'))
        .collect::<String>()
        .to_uppercase();
    let is_cpf = compact.len() == 11 && compact.bytes().all(|b| b.is_ascii_digit());
    if is_cpf {
        set_tax_id(data, check.formatted);
        data.vat_number = Field::Absent;
    } else {
        data.vat_number = check.formatted.map_or(Field::Absent, Field::Set);
    }
    Ok(())
}

/// `toPartyColumns(data)`.
fn party_columns(data: &ContactPayload) -> Map<String, Value> {
    let mut out = Map::new();
    let field = |f: &Field<String>| match f {
        Field::Absent => None,
        Field::Null => Some(Value::Null),
        Field::Set(v) => Some(json!(v)),
    };
    if let Some(role) = &data.role {
        out.insert("role".into(), json!(role));
    }
    for (key, address) in [
        ("billingAddress", &data.billing_address),
        ("shippingAddress", &data.shipping_address),
    ] {
        if !address.is_absent() {
            out.insert(
                key.into(),
                normalize_postal_address(address.as_set()).unwrap_or(Value::Null),
            );
        }
    }
    match &data.payment_terms_days {
        Field::Absent => {}
        Field::Null => {
            out.insert("paymentTerms".into(), Value::Null);
        }
        Field::Set(days) => {
            out.insert("paymentTerms".into(), json!(days.to_string()));
        }
    }
    if let Some(currency) = &data.currency {
        out.insert("currency".into(), json!(currency.to_uppercase()));
    }
    match &data.iban {
        Field::Absent => {}
        Field::Null => {
            out.insert("iban".into(), Value::Null);
        }
        Field::Set(iban) => {
            let compact: String = iban
                .chars()
                .filter(|c| !weldsuite_books_domain::jurisdictions::is_js_space(*c))
                .collect();
            out.insert("iban".into(), json!(compact.to_uppercase()));
        }
    }
    match &data.bic {
        Field::Absent => {}
        Field::Null => {
            out.insert("bic".into(), Value::Null);
        }
        Field::Set(bic) => {
            out.insert("bic".into(), json!(js_trim(bic).to_uppercase()));
        }
    }
    if let Some(value) = field(&data.default_revenue_account_id) {
        out.insert("defaultRevenueAccountId".into(), value);
    }
    if let Some(value) = field(&data.default_expense_account_id) {
        out.insert("defaultExpenseAccountId".into(), value);
    }
    match &data.sepa_mandate {
        Field::Absent => {}
        Field::Null => {
            out.insert("sepaMandate".into(), Value::Null);
        }
        Field::Set(mandate) => {
            out.insert("sepaMandate".into(), mandate.clone());
        }
    }
    match &data.br_fiscal {
        Field::Absent => {}
        Field::Null => {
            out.insert("brFiscal".into(), Value::Null);
        }
        Field::Set(fiscal) => {
            out.insert("brFiscal".into(), Value::Object(fiscal.clone()));
        }
    }
    out
}

/// `contactChanges(data, before, after)`, in client field names.
fn contact_changes(data: &ContactPayload, before: &Value, after: &Value) -> Map<String, Value> {
    let mut changes = Map::new();
    for key in PAYLOAD_KEYS {
        if data.value_of(key).is_none() {
            continue;
        }
        let field = if key == "fullName" { "name" } else { key };
        let Some(new_value) = after.get(field) else {
            continue;
        };
        let old_value = before.get(field).cloned().unwrap_or(Value::Null);
        if &old_value != new_value {
            changes.insert(
                field.to_owned(),
                json!({ "old": old_value, "new": new_value }),
            );
        }
    }
    changes
}

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let result: Reply = async {
        let mut data = read_contact_body(&headers, &raw, false)?;
        create_contact(&caller, &state, &mut data)
            .await
            .map_err(|e| contact_refusal(e, "Failed to create contact"))?
    }
    .await;
    reply(result, "Failed to create contact")
}

async fn create_contact(
    caller: &Caller,
    state: &BooksState,
    data: &mut ContactPayload,
) -> Result<Reply, ContactError> {
    let db = &caller.db;
    // Validate (and encrypt) the tax data first, so a bad TIN leaves no orphan identity behind.
    assert_w9_document(db, data).await?;
    check_identifier_formats(data, None)?;
    check_indian_tax_number(caller, data).await?;
    check_brazilian_tax_number(caller, data).await?;
    let tax = build_vendor_tax_change(None, &data.tax, &caller.keyring(state))?;
    let identity = create_identity(caller, state, data).await?;
    if identity.kind == "company"
        && let Some(company_id) = identity.company_id.as_deref()
    {
        sync_contact_person(caller, state, company_id, &data.contact_person).await?;
    }

    let id = generate_id("acn");
    let now = now();
    let mut props = party_columns(data);
    props.extend(tax.columns);
    props.extend(identity.columns());
    props.insert("id".into(), json!(id));
    props.insert(
        "role".into(),
        json!(data.role.clone().unwrap_or_else(|| "customer".to_owned())),
    );
    props.insert("outstandingBalance".into(), json!("0"));
    props.insert("createdAt".into(), json!(now));
    props.insert("updatedAt".into(), json!(now));
    PARTIES.insert_raw(db, PARTIES.values(&props)).await?;

    let Some(contact) = load_contact_view(db, &id).await? else {
        return Ok(Err(Refusal::Internal("the contact vanished".to_owned())));
    };
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: None,
            entity_type: "accounting_contact",
            entity_id: &id,
            action: "created",
            changes: None,
        },
    )
    .await;
    caller.publish(
        state,
        ACCOUNTING_CONTACT_CREATED,
        &id,
        strip_tax_fields_for_event(&contact),
    );
    Ok(Ok(created(contact)))
}

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let result: Reply = async {
        let mut data = read_contact_body(&headers, &raw, true)?;
        update_contact(&caller, &state, &id, &mut data)
            .await
            .map_err(|e| contact_refusal(e, "Failed to update contact"))?
    }
    .await;
    reply(result, "Failed to update contact")
}

async fn update_contact(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    data: &mut ContactPayload,
) -> Result<Reply, ContactError> {
    let db = &caller.db;
    let Some(contact) = find_party(db, id).await? else {
        return Ok(Err(Refusal::not_found("Contact", id)));
    };
    let before = load_contact_view(db, id).await?;

    assert_w9_document(db, data).await?;
    check_identifier_formats(data, contact.get("billingAddress"))?;
    check_indian_tax_number(caller, data).await?;
    check_brazilian_tax_number(caller, data).await?;
    let tax = build_vendor_tax_change(Some(&contact), &data.tax, &caller.keyring(state))?;
    let link: Option<IdentityLink> = sync_identity(caller, state, &contact, data).await?;
    let company_id = match &link {
        Some(link) => (link.kind == "company")
            .then(|| link.company_id.clone())
            .flatten(),
        None => (text(&contact, "kind") == Some("company"))
            .then(|| text(&contact, "companyId").map(str::to_owned))
            .flatten(),
    };
    if let Some(company_id) = company_id.filter(|id| !id.is_empty()) {
        sync_contact_person(caller, state, &company_id, &data.contact_person).await?;
    }

    let mut props = party_columns(data);
    props.extend(tax.columns);
    if let Some(link) = &link {
        props.extend(link.columns());
    }
    props.insert("updatedAt".into(), json!(now()));
    PARTIES
        .patch_raw(db, id, PARTIES.values(&props), false)
        .await?;

    let updated = load_contact_view(db, id).await?;
    let (Some(updated), Some(before)) = (updated, before) else {
        return Ok(Err(Refusal::not_found("Contact", id)));
    };
    let mut changes = contact_changes(data, &before, &updated);
    changes.extend(tax.changes);
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: None,
            entity_type: "accounting_contact",
            entity_id: id,
            action: "updated",
            changes: Some(changes),
        },
    )
    .await;
    caller.publish(
        state,
        ACCOUNTING_CONTACT_UPDATED,
        id,
        strip_tax_fields_for_event(&updated),
    );
    Ok(Ok(ok(updated)))
}

// ── DELETE /:id, archive ────────────────────────────────────────────────────

/// `LABELS` of `services/contact-usage`, in its order.
const USAGE: [(&str, &str, &str); 7] = [
    ("invoices", "invoice", "invoices"),
    ("bills", "bill", "bills"),
    ("payments", "payment", "payments"),
    (
        "recurringInvoices",
        "recurring invoice",
        "recurring invoices",
    ),
    ("paymentRuns", "payment run", "payment runs"),
    ("form1099Lines", "1099 filing line", "1099 filing lines"),
    ("journalLines", "journal entry line", "journal entry lines"),
];

/// `getContactUsage(db, id)`.
async fn contact_usage(
    db: &sqlx::PgPool,
    id: &str,
) -> Result<Vec<(&'static str, i64)>, sqlx::Error> {
    let (invoices, bills, payments, recurring, runs, lines, journal): (i64, i64, i64, i64, i64, i64, i64) =
        sqlx::query_as(
            "select \
               (select count(*) from invoices where contact_id = $1 and deleted_at is null), \
               (select count(*) from bills where contact_id = $1 and deleted_at is null), \
               (select count(*) from payments where contact_id = $1 and deleted_at is null), \
               (select count(*) from recurring_invoices where contact_id = $1 and deleted_at is null), \
               (select count(*) from payment_runs where deleted_at is null and items @> jsonb_build_array(jsonb_build_object('partyId', $1::text))), \
               (select count(*) from form_1099_filing_lines where party_id = $1), \
               (select count(*) from journal_lines where contact_id = $1 and deleted_at is null)",
        )
        .bind(id)
        .fetch_one(db)
        .await?;
    Ok(vec![
        ("invoices", invoices),
        ("bills", bills),
        ("payments", payments),
        ("recurringInvoices", recurring),
        ("paymentRuns", runs),
        ("form1099Lines", lines),
        ("journalLines", journal),
    ])
}

/// `describeUsage(used)`.
fn describe_usage(used: &[(&str, i64)]) -> String {
    let parts: Vec<String> = USAGE
        .iter()
        .filter_map(|(key, one, many)| {
            let n = used.iter().find(|(k, _)| k == key).map_or(0, |(_, n)| *n);
            (n > 0).then(|| format!("{n} {}", if n == 1 { one } else { many }))
        })
        .collect();
    match parts.split_last() {
        None => String::new(),
        Some((last, [])) => last.clone(),
        Some((last, rest)) => format!("{} and {last}", rest.join(", ")),
    }
}

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result: Reply = async {
        let db = &caller.db;
        let Some(contact) = find_party(db, &id).await? else {
            return Err(Refusal::not_found("Contact", &id));
        };
        let used: Vec<(&str, i64)> = contact_usage(db, &id)
            .await?
            .into_iter()
            .filter(|(_, n)| *n > 0)
            .collect();
        let open_balance = text(&contact, "outstandingBalance")
            .map(|t| weldsuite_books_domain::js::numeric_text(Some(t)))
            .is_some_and(|n| n != 0.0);
        if !used.is_empty() || open_balance {
            let reason = if used.is_empty() {
                "an open balance".to_owned()
            } else {
                describe_usage(&used)
            };
            let references: Map<String, Value> =
                used.iter().map(|(k, n)| ((*k).to_owned(), json!(n))).collect();
            return Err(Refusal::conflict_with(
                format!(
                    "This contact can't be deleted because it is used by {reason}. Archive it instead to hide it from lists and pickers."
                ),
                json!({ "code": "CONTACT_IN_USE", "references": references, "openBalance": open_balance, "canArchive": true }),
            ));
        }
        let now = now();
        sqlx::query("update parties set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
            .bind(&id)
            .bind(&now)
            .execute(db)
            .await?;
        write_accounting_audit(
            &caller,
            db,
            AuditInput {
                accounting_entity_id: None,
                entity_type: "accounting_contact",
                entity_id: &id,
                action: "deleted",
                changes: None,
            },
        )
        .await;
        caller.publish(&state, ACCOUNTING_CONTACT_DELETED, &id, json!({ "id": id }));
        Ok(no_content())
    }
    .await;
    reply(result, "Failed to delete contact")
}

async fn archive(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    set_archived(&caller, &state, &id, true).await
}

async fn unarchive(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    set_archived(&caller, &state, &id, false).await
}

/// `setContactArchived(c, archived)`: idempotent.
async fn set_archived(caller: &Caller, state: &BooksState, id: &str, archived: bool) -> Response {
    let result: Reply = async {
        let db = &caller.db;
        let Some(contact) = find_party(db, id).await? else {
            return Err(Refusal::not_found("Contact", id));
        };
        let is_archived = contact.get("archivedAt").is_some_and(|v| !v.is_null());
        if is_archived != archived {
            let now = now();
            sqlx::query(
                "update parties set archived_at = case when $2 then $3::timestamp else null end, \
                 status = $4, updated_at = $3::timestamp where id = $1",
            )
            .bind(id)
            .bind(archived)
            .bind(&now)
            .bind(if archived { "archived" } else { "active" })
            .execute(db)
            .await?;
            write_accounting_audit(
                caller,
                db,
                AuditInput {
                    accounting_entity_id: None,
                    entity_type: "accounting_contact",
                    entity_id: id,
                    action: if archived { "archived" } else { "unarchived" },
                    changes: None,
                },
            )
            .await;
            let event = if archived {
                ACCOUNTING_CONTACT_ARCHIVED
            } else {
                ACCOUNTING_CONTACT_UPDATED
            };
            caller.publish(state, event, id, json!({ "id": id, "archived": archived }));
        }
        match load_contact_view(db, id).await? {
            Some(view) => Ok(ok(view)),
            None => Err(Refusal::not_found("Contact", id)),
        }
    }
    .await;
    reply(
        result,
        if archived {
            "Failed to archive contact"
        } else {
            "Failed to unarchive contact"
        },
    )
}

// ── POST /:id/promote-role ──────────────────────────────────────────────────

async fn promote_role(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let promote_to = match validate(&headers, &raw, |issues, body| {
        issues.one_of(body, "promoteTo", &["customer", "supplier"])
    }) {
        Ok(Some(promote_to)) => promote_to,
        Ok(None) => return Refusal::bad_request("Invalid request body").respond(""),
        Err(refusal) => return refusal.respond(""),
    };
    let result: Reply = async {
        let db = &caller.db;
        let row: Option<(String, Option<String>)> =
            sqlx::query_as("select id, role from parties where id = $1 limit 1")
                .bind(&id)
                .fetch_optional(db)
                .await?;
        let Some((_, role)) = row else {
            return Err(Refusal::not_found("Party", &id));
        };
        let current = role.unwrap_or_else(|| "none".to_owned());
        if current == "both" || current == promote_to {
            return Ok(ok(json!({ "id": id, "role": current, "changed": false })));
        }
        let next = if current == "none" {
            promote_to.as_str()
        } else {
            "both"
        };
        sqlx::query("update parties set role = $2, updated_at = $3::timestamp where id = $1")
            .bind(&id)
            .bind(next)
            .bind(now())
            .execute(db)
            .await?;
        caller.publish(
            &state,
            ACCOUNTING_CONTACT_UPDATED,
            &id,
            json!({ "id": id, "role": next }),
        );
        Ok(ok(json!({ "id": id, "role": next, "changed": true })))
    }
    .await;
    reply(result, "Failed to promote accounting role")
}

// ── reveals and bank-detail verification ────────────────────────────────────

async fn reveal_tin(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    raw: Bytes,
) -> Response {
    reveal(&caller, &state, &id, &raw, SecretField::Tin).await
}

async fn reveal_ach(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    raw: Bytes,
) -> Response {
    reveal(&caller, &state, &id, &raw, SecretField::AchAccountNumber).await
}

/// `revealContactSecret(c, field)`: decrypt one stored secret, the reveal
/// logged in `tax_id_reveals` first.
async fn reveal(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    raw: &Bytes,
    field: SecretField,
) -> Response {
    // `readOptionalJson`: an unreadable body is `{}`.
    let body: Value = serde_json::from_slice(raw).unwrap_or_else(|_| json!({}));
    let mut issues = Issues::default();
    let reason = issues.object(&body).and_then(|fields| {
        issues
            .text_with(
                fields,
                "reason",
                Presence::Optional,
                Text::trimmed(None, Some(255)),
            )
            .into_option()
    });
    if let Err(invalid) = issues.finish() {
        return Refusal::bad_request_with("Invalid request body", invalid.flatten()).respond("");
    }
    let result: Reply = async {
        let db = &caller.db;
        let Some(party) = find_party(db, id).await? else {
            return Err(Refusal::not_found("Contact", id));
        };
        let user = if caller.user_id.is_empty() {
            "unknown"
        } else {
            caller.user_id.as_str()
        };
        let value = match reveal_party_secret(
            db,
            &caller.keyring(state),
            &party,
            field,
            user,
            reason.as_deref(),
            caller.header("x-accounting-entity-id"),
        )
        .await
        {
            Ok(value) => value,
            Err(VendorTaxError::SecretNotFound(field)) => {
                let resource = match field {
                    SecretField::Tin => "TIN of contact",
                    SecretField::AchAccountNumber => "ACH account number of contact",
                };
                return Err(Refusal::not_found(resource, id));
            }
            Err(VendorTaxError::NoKey) => return Err(Refusal::unavailable(NO_KEY_MESSAGE)),
            Err(other) => return Err(Refusal::Internal(other.to_string())),
        };
        write_accounting_audit(
            caller,
            db,
            AuditInput {
                accounting_entity_id: None,
                entity_type: "accounting_contact",
                entity_id: id,
                action: match field {
                    SecretField::Tin => "tin_revealed",
                    SecretField::AchAccountNumber => "ach_account_revealed",
                },
                changes: None,
            },
        )
        .await;
        caller.publish(
            state,
            ACCOUNTING_CONTACT_UPDATED,
            id,
            json!({ "id": id, "taxIdRevealed": field.as_str() }),
        );
        let data = match field {
            SecretField::Tin => {
                let stored = text(&party, "tinType");
                let tin_type = if is_tin_type(stored) {
                    stored.unwrap_or("ssn")
                } else {
                    "ssn"
                };
                json!({ "tin": format_tin(tin_type, &value), "tinType": party.get("tinType").cloned().unwrap_or(Value::Null) })
            }
            SecretField::AchAccountNumber => json!({
                "achAccountNumber": value,
                "achRoutingNumber": party.get("achRoutingNumber").cloned().unwrap_or(Value::Null),
                "achAccountType": party.get("achAccountType").cloned().unwrap_or(Value::Null),
            }),
        };
        let mut response = ok(data);
        response
            .headers_mut()
            .insert(http::header::CACHE_CONTROL, http::HeaderValue::from_static("no-store"));
        Ok(response)
    }
    .await;
    reply(result, "Failed to reveal the value")
}

async fn reveal_log(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Reply = async {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(tax_id_reveals),
            " from tax_id_reveals t where (t.subject_type = 'party' and t.subject_id = $1) \
             or (t.subject_type = 'form_1099_line' and t.subject_id in \
                 (select l.id from form_1099_filing_lines l where l.party_id = $1)) \
             order by t.created_at desc limit 200"
        ))
        .bind(&id)
        .fetch_all(&caller.db)
        .await?;
        let rows = TAX_ID_REVEALS.js_rows(rows);
        let total = i64::try_from(rows.len()).unwrap_or(0);
        Ok(paged(rows, total, false, None))
    }
    .await;
    reply(result, "Failed to fetch the reveal log")
}

async fn verify_bank_details(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result: Reply = async {
        let db = &caller.db;
        let Some(party) = find_party(db, &id).await? else {
            return Err(Refusal::not_found("Contact", &id));
        };
        let filled = |key: &str| text(&party, key).is_some_and(|v| !v.is_empty());
        if !filled("achRoutingNumber") || !filled("achAccountLast4") {
            return Err(Refusal::bad_request("This contact has no bank details to verify"));
        }
        let now = now();
        let user = if caller.user_id.is_empty() {
            "unknown".to_owned()
        } else {
            caller.user_id.clone()
        };
        sqlx::query(
            "update parties set bank_details_verified_at = $2::timestamp, bank_details_verified_by = $3, \
             updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&now)
        .bind(&user)
        .execute(db)
        .await?;
        let Some(updated) = load_contact_view(db, &id).await? else {
            return Err(Refusal::not_found("Contact", &id));
        };
        write_accounting_audit(
            &caller,
            db,
            AuditInput {
                accounting_entity_id: None,
                entity_type: "accounting_contact",
                entity_id: &id,
                action: "bank_verified",
                changes: None,
            },
        )
        .await;
        caller.publish(
            &state,
            ACCOUNTING_CONTACT_UPDATED,
            &id,
            json!({ "id": id, "bankDetailsVerified": true }),
        );
        Ok(ok(updated))
    }
    .await;
    reply(result, "Failed to verify the bank details")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payment_terms() {
        assert_eq!(parse_payment_terms_days(Some("30")), json!(30));
        assert_eq!(parse_payment_terms_days(Some(" Net 14 days ")), json!(14));
        assert_eq!(parse_payment_terms_days(Some("net30day")), json!(30));
        assert_eq!(parse_payment_terms_days(Some("on receipt")), Value::Null);
        assert_eq!(parse_payment_terms_days(Some("12345")), Value::Null);
    }

    #[test]
    fn usage_in_words() {
        assert_eq!(describe_usage(&[("bills", 1)]), "1 bill");
        assert_eq!(
            describe_usage(&[("invoices", 2), ("bills", 1), ("journalLines", 3)]),
            "2 invoices, 1 bill and 3 journal entry lines"
        );
    }
}
