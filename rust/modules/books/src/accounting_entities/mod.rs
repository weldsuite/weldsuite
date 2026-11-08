//! `/api/accounting-entities` (`routes/accounting-entities/index.ts`): the
//! legal entities a workspace keeps books for. Creating one is
//! jurisdiction-aware: the adapter seeds the chart of accounts, the standard
//! tax rates and the number sequences, and checks the tax identifiers. US
//! entities carry an entity type and tax classification, a write-only SSN and
//! tax lines on their accounts; lock dates and their exceptions are set here
//! (the posting engine enforces them), and so is the documents' numbering.
//!
//! The company itself is a core legal entity (docs/plans/legal-entities.md):
//! the list shows the entities the member sees that WeldBooks is enabled for
//! (an `accounting_entity_settings` row), `POST` with `legalEntityId` enables
//! WeldBooks for an existing one (with `entities:create` in the member's role
//! inside it, leaving the company's identity as it is; else it creates the
//! company through core),
//! `PATCH` splits the write between core, the registrations and the
//! extension (and, release 1, mirrors everything to the old columns), and
//! `DELETE` only switches WeldBooks off, until it holds documents.

mod body;
mod locks;
mod numbering;
mod registrations;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::accounting_entity::{
    load_accounting_entities, load_accounting_entity, upsert_accounting_entity_settings,
};
use weldsuite_books_domain::address::normalize_postal_address;
use weldsuite_books_domain::entity_context::{entity_access, record_in_request_entity};
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, no_content, now, ok, reply, validate,
};
use weldsuite_books_domain::js::locale_compare;
use weldsuite_books_domain::jurisdictions::{self, TaxIdField, br, india, us};
use weldsuite_books_domain::tables::{ACCOUNTS, ENTITIES, SETTINGS, TAX_RATES};
use weldsuite_catalogs::entity_events::{
    ACCOUNTING_ENTITY_CREATED, ACCOUNTING_ENTITY_DELETED, ACCOUNTING_ENTITY_UPDATED,
    LEGAL_ENTITY_CREATED,
};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_legal_entities::service::{
    CreateLegalEntityInput, ListLegalEntitiesOptions, UpdateLegalEntityInput, create_legal_entity,
    list_legal_entities, set_default_legal_entity, update_legal_entity,
};
use weldsuite_legal_entities::{
    EntityAccess, LegalEntityApp, LegalEntityError, can_see_entity, permissions_in_entity,
};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use self::body::EntityBody;
use self::registrations::sync_registrations_from_tax_identifiers;
use crate::entity_setup::{
    EntityKind, Given, SeedArgs, SetupError, apply_tax_lines, build_seed_accounts, check_ssn,
    check_us_address, form_of, lock_state, looks_like_ssn, resolve_entity_kind,
    sync_br_tax_profiles, tax_year_of,
};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("entities:read")))
        .route("/", post(create).route_layer(need("entities:create")))
        .route(
            "/jurisdictions",
            get(jurisdictions_list).route_layer(need("entities:read")),
        )
        .route("/{id}", get(detail).route_layer(need("entities:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("entities:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("entities:delete")),
        )
        .route(
            "/{id}/apply-tax-lines",
            post(apply_lines).route_layer(need("accounts:update")),
        )
        .route(
            "/{id}/reveal-ssn",
            post(reveal_ssn).route_layer(need("tax_ids:reveal")),
        )
        .route(
            "/{id}/lock-dates",
            axum::routing::patch(locks::lock_dates).route_layer(need("entities:update")),
        )
        .route(
            "/{id}/lock-exceptions",
            get(locks::list_exceptions).route_layer(need("entities:read")),
        )
        .route(
            "/{id}/lock-exceptions",
            post(locks::create_exception).route_layer(need("entities:update")),
        )
        .route(
            "/{id}/lock-exceptions/{exception_id}/revoke",
            post(locks::revoke_exception).route_layer(need("entities:update")),
        )
        .route(
            "/{id}/number-sequences",
            get(numbering::list).route_layer(need("entities:read")),
        )
        .route(
            "/{id}/number-sequences",
            axum::routing::patch(numbering::update).route_layer(need("entities:update")),
        )
        .with_state(state)
}

/// The columns that never leave the database, and the loader's flag.
const SECRET_COLUMNS: [&str; 4] = [
    "ssnEncrypted",
    "salesTaxCredentialsEncrypted",
    "fiscalCredentialsEncrypted",
    "weldbooksEnabled",
];

/// `serializeEntity(row)`: the sealed columns out (`hasSsn`, … say whether
/// one is stored), and an SSN typed into the EIN slot masked. The loader's
/// `weldbooksEnabled` is left out.
pub(crate) fn serialize(row: &Map<String, Value>) -> Value {
    let truthy = |key: &str| weldsuite_books_domain::js::truthy(row.get(key));
    let mut out: Map<String, Value> = row
        .iter()
        .filter(|(key, _)| !SECRET_COLUMNS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if let Some(Value::Object(ids)) = row.get("taxIdentifiers")
        && let Some(ein) = ids
            .get("einOrSsn")
            .and_then(Value::as_str)
            .filter(|e| !e.is_empty())
        && looks_like_ssn(ein)
    {
        let mut masked = ids.clone();
        masked.insert("einOrSsn".to_owned(), json!(us::mask_tin(ein, Some("ssn"))));
        out.insert("taxIdentifiers".to_owned(), Value::Object(masked));
    }
    out.insert("hasSsn".to_owned(), json!(truthy("ssnEncrypted")));
    out.insert(
        "hasSalesTaxCredentials".to_owned(),
        json!(truthy("salesTaxCredentialsEncrypted")),
    );
    out.insert(
        "hasFiscalCredentials".to_owned(),
        json!(truthy("fiscalCredentialsEncrypted")),
    );
    Value::Object(out)
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// `findActiveEntity(c, db, id)`: a live entity as the API returns it
/// (extension values merged in, `loadAccountingEntity`), or `None` when it is
/// unknown, deleted, or not one this request may touch: a member who is not
/// allowed everywhere only reaches the entity the request is scoped to, and a
/// restricted entity they have no row on does not exist.
pub(crate) async fn find_active(
    caller: &Caller,
    id: &str,
) -> Result<Option<Map<String, Value>>, sqlx::Error> {
    let access = entity_access(caller).await?;
    if !can_see_entity(&access, Some(id)) || !record_in_request_entity(caller, Some(id)).await? {
        return Ok(None);
    }
    Ok(load_accounting_entity(&caller.db, id).await?.map(object))
}

/// A `LegalEntityError` the route's `catch` answers itself (`badRequest` on
/// create, `conflict` on update), else the route's 500.
fn legal_entity_refusal(error: LegalEntityError, answer: fn(String) -> Refusal) -> Refusal {
    match error {
        LegalEntityError::Coded { message, .. } => answer(message),
        LegalEntityError::Database(error) => Refusal::Database(error),
        LegalEntityError::Internal(message) => Refusal::Internal(message),
    }
}

/// A `LegalEntityError` the route does not catch on its own: the route's 500.
fn legal_entity_failure(error: LegalEntityError) -> Refusal {
    match error {
        LegalEntityError::Database(error) => Refusal::Database(error),
        other => Refusal::Internal(other.to_string()),
    }
}

fn unsupported(code: &str) -> String {
    format!(
        "Jurisdiction '{code}' is not supported. Supported: {}",
        jurisdictions::codes().join(", ")
    )
}

impl From<SetupError> for Refusal {
    fn from(error: SetupError) -> Self {
        Refusal::bad_request(error.0)
    }
}

// ── tax identifiers ─────────────────────────────────────────────────────────

const VALIDATED: [TaxIdField; 3] = [
    TaxIdField::VatNumber,
    TaxIdField::RegistrationNumber,
    TaxIdField::EinOrSsn,
];

/// `validatedFieldsFor(code)`.
fn validated_fields_for(code: &str) -> Vec<TaxIdField> {
    if code.eq_ignore_ascii_case("US") {
        VALIDATED.to_vec()
    } else {
        vec![TaxIdField::VatNumber, TaxIdField::RegistrationNumber]
    }
}

/// `touchedTaxIdentifiers(taxIdentifiers, vatAlias)`.
fn touched_tax_identifiers(ids: Option<&Value>, vat_alias: Option<&Value>) -> Vec<TaxIdField> {
    let mut touched: Vec<TaxIdField> = VALIDATED
        .into_iter()
        .filter(|field| ids.and_then(|i| i.get(field.key())).is_some())
        .collect();
    if vat_alias.is_some() && !touched.contains(&TaxIdField::VatNumber) {
        touched.push(TaxIdField::VatNumber);
    }
    touched
}

/// `validateTaxIdentifiersWithAdapter(code, taxIdentifiers, touched)`: the
/// identifiers in the adapter's format, or the error.
fn validate_with_adapter(
    code: &str,
    ids: Option<Map<String, Value>>,
    touched: &[TaxIdField],
) -> Result<Option<Map<String, Value>>, String> {
    let Some(ids) = ids else {
        return Ok(None);
    };
    if touched.is_empty() {
        return Ok(Some(ids));
    }
    let mut next = ids;
    for field in validated_fields_for(code) {
        if !touched.contains(&field) {
            continue;
        }
        let Some(value) = next
            .get(field.key())
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };
        if jurisdictions::js_trim(&value).is_empty() {
            next.remove(field.key());
            continue;
        }
        let check = jurisdictions::validate_tax_identifier(code, field, &value);
        if !check.valid {
            return Err(check
                .error
                .unwrap_or_else(|| format!("Invalid {}", field.key())));
        }
        let formatted = check
            .formatted
            .unwrap_or_else(|| jurisdictions::js_trim(&value).to_owned());
        if field == TaxIdField::EinOrSsn && looks_like_ssn(&formatted) {
            return Err(
                "Enter a Social Security number in the ssn field; the EIN field takes an EIN (XX-XXXXXXX)".to_owned(),
            );
        }
        next.insert(field.key().to_owned(), json!(formatted));
    }
    // A US entity has one EIN, kept in both slots.
    let ein_touched = touched.contains(&TaxIdField::EinOrSsn);
    let vat_touched = touched.contains(&TaxIdField::VatNumber);
    if code.eq_ignore_ascii_case("US") && (ein_touched || vat_touched) {
        let pick = |touched: bool, key: &str| {
            touched
                .then(|| next.get(key).and_then(Value::as_str).map(str::to_owned))
                .flatten()
                .filter(|v| !v.is_empty())
        };
        let given: Vec<String> = [
            pick(ein_touched, "einOrSsn"),
            pick(vat_touched, "vatNumber"),
        ]
        .into_iter()
        .flatten()
        .collect();
        if given.len() == 2 && given[0] != given[1] {
            return Err("vatNumber and einOrSsn hold the same EIN for a US entity".to_owned());
        }
        if let Some(ein) = given.first() {
            next.insert("einOrSsn".to_owned(), json!(ein));
            next.insert("vatNumber".to_owned(), json!(ein));
        } else {
            next.remove("einOrSsn");
            next.remove("vatNumber");
        }
    }
    Ok(Some(next))
}

/// `applyIndiaTaxIdentifiers(...)`'s result.
#[derive(Debug, Clone, Default)]
struct India {
    ids: Option<Map<String, Value>>,
    settings: Option<Map<String, Value>>,
    timezone: Option<String>,
}

/// `applyIndiaTaxIdentifiers`: for an Indian entity, the GSTIN checked (or
/// only mined for its state code) and `jurisdictionSettings.stateCode` set.
fn apply_india(
    code: &str,
    ids: Option<Map<String, Value>>,
    settings: Option<Map<String, Value>>,
    timezone: Option<String>,
    check: bool,
) -> Result<India, String> {
    if !code.eq_ignore_ascii_case("IN") {
        return Ok(India {
            ids,
            settings,
            timezone,
        });
    }
    let mut settings = settings.unwrap_or_default();
    let mut ids = ids;
    let timezone = timezone.unwrap_or_else(|| "Asia/Kolkata".to_owned());
    if let Some(ids) = ids.as_mut()
        && let Some(gstin) = ids
            .get("vatNumber")
            .and_then(Value::as_str)
            .map(str::to_owned)
    {
        if check {
            let pan = ids.get("registrationNumber").and_then(Value::as_str);
            let result = india::validate_gstin(&gstin, pan);
            if !result.valid {
                return Err(result.error.unwrap_or_else(|| "Invalid GSTIN".to_owned()));
            }
            let formatted = result.formatted.unwrap_or_default();
            ids.insert("vatNumber".to_owned(), json!(formatted));
            if let Some(state) = india::extract_state_code_from_gstin(&formatted) {
                settings.insert("stateCode".to_owned(), json!(state));
            }
        } else if let Some(state) = (!gstin.is_empty())
            .then(|| india::extract_state_code_from_gstin(&gstin))
            .flatten()
            .filter(|s| india::is_valid_gst_state_code(s))
        {
            settings.insert("stateCode".to_owned(), json!(state));
        }
    }
    Ok(India {
        ids,
        settings: (!settings.is_empty()).then_some(settings),
        timezone: Some(timezone),
    })
}

fn map_of(value: Option<&Value>) -> Option<Map<String, Value>> {
    value.and_then(Value::as_object).cloned()
}

// ── GET / and /jurisdictions ────────────────────────────────────────────────

/// `GET /`: the entities the member sees that WeldBooks is enabled for
/// (archived ones with `?includeArchived=true`), by name.
async fn list(caller: Caller) -> Response {
    let result = async {
        let access = entity_access(&caller).await?;
        let options = ListLegalEntitiesOptions {
            app: Some(LegalEntityApp::Weldbooks),
            include_archived: caller.query().get("includeArchived") == Some("true"),
        };
        let visible = list_legal_entities(&caller.db, Some(&access), options)
            .await
            .map_err(legal_entity_failure)?;
        let ids: Vec<String> = visible.into_iter().map(|entity| entity.id).collect();
        let mut rows = load_accounting_entities(&caller.db, &ids, false).await?;
        let text = |row: &Value, key: &str| row[key].as_str().unwrap_or_default().to_owned();
        rows.sort_by(|a, b| {
            locale_compare(&text(a, "name"), &text(b, "name"))
                .then_with(|| locale_compare(&text(a, "id"), &text(b, "id")))
        });
        let rows: Vec<Value> = rows
            .into_iter()
            .map(|row| serialize(&object(row)))
            .collect();
        Ok(ok(Value::Array(rows)))
    }
    .await;
    reply(result, "Failed to fetch entities")
}

async fn jurisdictions_list() -> Response {
    let list: Vec<Value> = jurisdictions::summaries()
        .iter()
        .map(|summary| {
            if summary["code"].as_str() != Some("US") {
                return summary.clone();
            }
            let types: Vec<Value> = us::entity_types()
                .into_iter()
                .filter_map(|t| {
                    let info = us::entity_type_info(t)?;
                    let classifications: Vec<Value> = info["classifications"]
                        .as_array()
                        .map(|cs| {
                            cs.iter()
                                .filter_map(Value::as_str)
                                .map(|c| {
                                    let form = us::tax_form_for_classification(c);
                                    json!({ "value": c, "form": form, "formLabel": us::form_label(form) })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(json!({
                        "type": t,
                        "label": info["label"],
                        "description": info["description"],
                        "minOwners": info["minOwners"],
                        "defaultClassification": info["classifications"][0],
                        "classifications": classifications,
                    }))
                })
                .collect();
            let mut extended = summary.clone();
            extended["entityTypes"] = Value::Array(types);
            extended
        })
        .collect();
    ok(Value::Array(list))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(entity) = find_active(&caller, &id).await? else {
            return Err(Refusal::not_found("Entity", &id));
        };
        let mut out = object(serialize(&entity));
        out.extend(object(lock_state(&caller.db, &id).await?));
        Ok(ok(Value::Object(out)))
    }
    .await;
    reply(result, "Failed to fetch entity")
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        body::read(issues, body, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create entity"),
    };
    reply(
        create_entity(&caller, &state, &data).await,
        "Failed to create entity",
    )
}

/// The company a `POST /` is about: an existing legal entity the member sees
/// and holds `entities:create` in (`legalEntityId`, WeldBooks not yet
/// enabled), or none, when the route creates one (which also needs
/// `legal_entities:create`).
async fn existing_company(
    caller: &Caller,
    data: &EntityBody,
) -> Result<Option<Map<String, Value>>, Refusal> {
    let Some(legal_entity_id) = data.text("legalEntityId") else {
        if !caller.can("legal_entities:create") {
            return Err(Refusal::forbidden(
                "Creating a company needs the legal_entities:create permission",
            ));
        }
        return Ok(None);
    };
    let access = entity_access(caller).await?;
    let core = if can_see_entity(&access, Some(legal_entity_id)) {
        load_accounting_entity(&caller.db, legal_entity_id)
            .await?
            .map(object)
    } else {
        None
    };
    let Some(core) = core else {
        return Err(Refusal::not_found("Legal entity", legal_entity_id));
    };
    // The entity layer skips this route, so the member's role inside that
    // entity is checked here.
    if !can_in_entity(caller, &access, legal_entity_id, "entities:create").await? {
        return Err(permission_refused());
    }
    if core.get("weldbooksEnabled") == Some(&Value::Bool(true)) {
        return Err(Refusal::conflict(
            "WeldBooks is already enabled for this legal entity",
        ));
    }
    Ok(Some(core))
}

/// `canInEntity(c, access, entityId, key)`: whether the member holds `key`
/// inside one entity, with their role there (an entity role swapped in, as the
/// entity layer does for the scoped routes), checked the way the permission
/// gate checks it.
async fn can_in_entity(
    caller: &Caller,
    access: &EntityAccess,
    entity_id: &str,
    key: &str,
) -> Result<bool, sqlx::Error> {
    let resolved = permissions_in_entity(&caller.db, access, entity_id).await?;
    Ok(caller.permissions.with_resolved(resolved).has_any(&[key]))
}

/// The 403 the permission gate answers (`requirePermission`), `success: false`
/// included.
fn permission_refused() -> Refusal {
    let body = json!({
        "success": false,
        "error": {
            "code": "FORBIDDEN",
            "message": "You do not have permission to perform this action",
        },
    });
    Refusal::Response(Box::new(
        (http::StatusCode::FORBIDDEN, axum::Json(body)).into_response(),
    ))
}

/// `weldbooksPartOf(data)`: what `POST /` takes from the body when it enables
/// WeldBooks for an existing legal entity, only what WeldBooks adds
/// (accounting method, jurisdiction settings, the owner's SSN, seeding, the
/// default). The company's identity (name, legal form, address, contact, tax
/// identifiers, branding, bank details, currency, locale, time zone, fiscal
/// year) is edited in Settings → Legal entities and stays as it is. The
/// document texts are WeldBooks' too; the route reads them from the body
/// itself.
fn weldbooks_part_of(body: &EntityBody) -> EntityBody {
    let data = [
        "accountingMethod",
        "jurisdictionSettings",
        "ssn",
        "isDefault",
    ]
    .into_iter()
    .filter_map(|key| Some((key.to_owned(), body.get(key)?.clone())))
    .collect();
    EntityBody {
        data,
        seed_defaults: body.seed_defaults,
    }
}

/// A text column of an existing company (`core?.x`), `None` when null.
fn core_text<'a>(core: Option<&'a Map<String, Value>>, key: &str) -> Option<&'a str> {
    core.and_then(|core| core.get(key)).and_then(Value::as_str)
}

/// `{ logoUrl, primaryColor, accentColor }` of a branding body
/// (`coreBrandingOf`): the core part, shared with the other apps.
fn core_branding_of(branding: Option<&Value>) -> Option<Map<String, Value>> {
    let branding = branding?.as_object()?;
    Some(
        ["logoUrl", "primaryColor", "accentColor"]
            .into_iter()
            .filter_map(|key| Some((key.to_owned(), branding.get(key)?.clone())))
            .collect(),
    )
}

/// The document texts WeldBooks prints (`documentTextsOf`), which live in
/// `accounting_entity_settings.document_texts`.
fn document_texts_of(branding: Option<&Value>) -> Option<Map<String, Value>> {
    let branding = branding?.as_object()?;
    Some(
        ["footerText", "paymentInstructions", "termsAndConditions"]
            .into_iter()
            .filter_map(|key| Some((key.to_owned(), branding.get(key)?.clone())))
            .collect(),
    )
}

/// A [`Field`] of an optional JSON value: absent, null or set.
fn field_of(value: Option<&Value>) -> Field<Value> {
    match value {
        None => Field::Absent,
        Some(Value::Null) => Field::Null,
        Some(value) => Field::Set(value.clone()),
    }
}

/// A [`Field`] of an optional text: absent, null or set.
fn text_field_of(value: Option<&Value>) -> Field<String> {
    match value {
        None => Field::Absent,
        Some(Value::Null) => Field::Null,
        Some(value) => Field::Set(value.as_str().unwrap_or_default().to_owned()),
    }
}

#[allow(clippy::too_many_lines)] // the worker's handler, step by step
async fn create_entity(caller: &Caller, state: &BooksState, body: &EntityBody) -> Reply {
    let db = &caller.db;
    // The company: an existing legal entity the member sees, or a new one.
    let company = existing_company(caller, body).await?;
    let company = company.as_ref();
    // An existing company keeps its identity: only what WeldBooks adds is read from the body.
    let weldbooks_part;
    let data = if company.is_some() {
        weldbooks_part = weldbooks_part_of(body);
        &weldbooks_part
    } else {
        body
    };
    let document_texts = document_texts_of(body.get("branding"));
    if company.is_none() && data.text("name").is_none() {
        return Err(Refusal::bad_request("name is required"));
    }
    let Some(jurisdiction) = core_text(company, "jurisdictionCode")
        .or_else(|| data.text("jurisdictionCode"))
        .or_else(|| data.text("jurisdiction"))
        .map(str::to_owned)
    else {
        return Err(Refusal::bad_request("jurisdictionCode is required"));
    };
    if !jurisdictions::has_adapter(&jurisdiction) {
        return Err(Refusal::bad_request(unsupported(&jurisdiction)));
    }
    let adapter = jurisdictions::adapter(&jurisdiction)
        .ok_or_else(|| Refusal::Internal("adapter".to_owned()))?;
    let code = jurisdiction.to_uppercase();
    let is_us = code == "US";
    let body_ids = map_of(data.get("taxIdentifiers"));
    // `data.vatNumber !== undefined ? { ...ids, vatNumber: ids?.vatNumber ?? data.vatNumber } : ids`
    let merged = match data.get("vatNumber") {
        Some(alias) => {
            let mut merged = body_ids.clone().unwrap_or_default();
            let own = merged.get("vatNumber").filter(|v| !v.is_null()).cloned();
            merged.insert("vatNumber".to_owned(), own.unwrap_or_else(|| alias.clone()));
            Some(merged)
        }
        None => body_ids.clone(),
    };
    let india = apply_india(
        &jurisdiction,
        merged,
        map_of(data.get("jurisdictionSettings")),
        data.text("timezone")
            .or_else(|| core_text(company, "timezone"))
            .map(str::to_owned),
        true,
    )
    .map_err(Refusal::bad_request)?;
    let touched = touched_tax_identifiers(data.get("taxIdentifiers"), data.get("vatNumber"));
    let tax_identifiers = validate_with_adapter(&jurisdiction, india.ids.clone(), &touched)
        .map_err(Refusal::bad_request)?;

    // An existing company keeps its own identity; the body only supplies what WeldBooks adds.
    let kind_given = |key: &str| match core_text(company, key) {
        Some(own) => Given::Set(own.to_owned()),
        None => given_text(data, key),
    };
    let kind = resolve_entity_kind(
        &code,
        &kind_given("entityType"),
        &kind_given("taxClassification"),
        None,
    )?;
    // `newEntityLocation`, with the company's own address and time zone first.
    let given_address = company
        .and_then(|company| company.get("address"))
        .filter(|a| !a.is_null())
        .or_else(|| data.get("address"));
    let given_timezone = core_text(company, "timezone").or_else(|| data.text("timezone"));
    let address = normalize_postal_address(given_address);
    let mut address = if is_us {
        check_us_address(address)?
    } else {
        address
    };
    let br_settings = if code == "BR" {
        Some(br::normalize_settings(
            map_of(data.get("jurisdictionSettings")).as_ref(),
            address.as_ref(),
        )?)
    } else {
        None
    };
    if code == "BR" {
        address = br::normalize_address(address)?;
    }
    let jurisdiction_settings = match &br_settings {
        Some((settings, _)) => Some(settings.clone()),
        None => india.settings.clone(),
    };
    let mut timezone = if is_us {
        Some(given_timezone.map_or_else(
            || us::default_time_zone(address.as_ref().and_then(|a| a["state"].as_str())).to_owned(),
            str::to_owned,
        ))
    } else {
        india.timezone.clone()
    };
    if let Some((_, zone)) = &br_settings {
        timezone = Some(given_timezone.map_or_else(|| zone.clone(), str::to_owned));
    }

    // `newEntitySsn`
    let (ssn_encrypted, ssn_last4) = match data.text("ssn").filter(|s| !s.is_empty()) {
        None => (Value::Null, Value::Null),
        Some(_) if !is_us => {
            return Err(Refusal::bad_request(
                "An SSN can only be stored on a US entity",
            ));
        }
        Some(input) => {
            let ssn = check_ssn(input)?;
            let keyring = caller.keyring(state);
            if keyring.is_empty() {
                return Err(Refusal::unavailable(
                    "Encryption is not configured, so an SSN can not be stored",
                ));
            }
            let sealed = weldsuite_db::encrypt_field(&ssn, &keyring)
                .map_err(|error| Refusal::Internal(error.to_string()))?;
            (json!(sealed), json!(us::tin_last4(&ssn)))
        }
    };

    let locale = core_text(company, "locale")
        .or_else(|| data.text("locale"))
        .unwrap_or(adapter.default_locale)
        .to_owned();
    let base_currency = core_text(company, "baseCurrency")
        .or_else(|| data.text("baseCurrency"))
        .unwrap_or(adapter.default_currency)
        .to_owned();
    let at = now();
    let accounting_method = data
        .get("accountingMethod")
        .filter(|m| !m.is_null())
        .cloned()
        .unwrap_or_else(|| if is_us { json!("accrual") } else { Value::Null });

    // 1. The company: the existing one, created here only when none was named.
    let (entity_id, is_default, entity_name) = if let Some(company) = company {
        (
            core_text(Some(company), "id")
                .unwrap_or_default()
                .to_owned(),
            company
                .get("isDefault")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            company.get("name").cloned().unwrap_or(Value::Null),
        )
    } else {
        let fiscal_year_config = data.get("fiscalYearConfig").cloned().unwrap_or(Value::Null);
        let fiscal_year_start = match data.get("fiscalYearStart").and_then(Value::as_i64) {
            Some(start) => start,
            None => fiscal_year_config["endMonth"]
                .as_i64()
                .map_or(1, |end| end % 12 + 1),
        };
        let input = CreateLegalEntityInput {
            name: data.text("name").unwrap_or_default().to_owned(),
            legal_name: text_field_of(data.get("legalName")),
            // `data.dba ?? null`
            dba: match data.get("dba") {
                Some(Value::String(dba)) => Field::Set(dba.clone()),
                _ => Field::Null,
            },
            // `kind.entityType ?? undefined`
            entity_type: kind.entity_type.clone().map_or(Field::Absent, Field::Set),
            jurisdiction_code: code.clone(),
            base_currency: base_currency.clone(),
            locale: Some(locale.clone()),
            timezone: timezone.clone(),
            address: address.clone().map_or(Field::Null, Field::Set),
            contact: field_of(data.get("contact")),
            branding: core_branding_of(data.get("branding")).map_or(Field::Absent, |branding| {
                Field::Set(Value::Object(branding))
            }),
            fiscal_year_start: i32::try_from(fiscal_year_start).ok(),
            fiscal_year_config: field_of(Some(&fiscal_year_config)),
            tax_classification: kind
                .tax_classification
                .clone()
                .map_or(Field::Null, Field::Set),
            is_default: data.get("isDefault").and_then(Value::as_bool),
        };
        let created = create_legal_entity(db, &input)
            .await
            .map_err(|error| legal_entity_refusal(error, Refusal::bad_request))?;
        caller.publish(
            state,
            LEGAL_ENTITY_CREATED,
            &created.id,
            json!({
                "id": created.id,
                "name": created.name,
                "jurisdictionCode": created.jurisdiction_code,
            }),
        );
        (
            created.id.clone(),
            created.is_default.unwrap_or(false),
            Value::String(created.name.clone()),
        )
    };

    // 2. The tax identifiers are the company's registrations.
    sync_registrations_from_tax_identifiers(
        db,
        &entity_id,
        &code,
        tax_identifiers.as_ref(),
        &touched,
    )
    .await?;

    // 3. WeldBooks' extension, and (release 1 mirror) the same values on the old entity columns.
    let mut extension = Map::new();
    extension.insert("accountingMethod".to_owned(), accounting_method.clone());
    extension.insert(
        "jurisdictionSettings".to_owned(),
        jurisdiction_settings
            .clone()
            .map_or(Value::Null, Value::Object),
    );
    extension.insert("ssnEncrypted".to_owned(), ssn_encrypted.clone());
    extension.insert("ssnLast4".to_owned(), ssn_last4.clone());
    if let Some(texts) = document_texts.filter(|t| !t.is_empty()) {
        extension.insert("documentTexts".to_owned(), Value::Object(texts));
    }
    upsert_accounting_entity_settings(db, &entity_id, &extension).await?;
    let mut mirror = Map::new();
    mirror.insert("accountingMethod".to_owned(), accounting_method);
    if let Some(ids) = &tax_identifiers {
        mirror.insert("taxIdentifiers".to_owned(), Value::Object(ids.clone()));
    }
    if let Some(settings) = &jurisdiction_settings {
        mirror.insert(
            "jurisdictionSettings".to_owned(),
            Value::Object(settings.clone()),
        );
    }
    mirror.insert("ssnEncrypted".to_owned(), ssn_encrypted);
    mirror.insert("ssnLast4".to_owned(), ssn_last4);
    for key in ["bankDetails", "branding"] {
        if let Some(value) = data.get(key) {
            mirror.insert(key.to_owned(), value.clone());
        }
    }
    mirror.insert("updatedAt".to_owned(), json!(at));
    ENTITIES
        .patch_raw(db, &entity_id, ENTITIES.values(&mirror), false)
        .await?;

    // 4. Numbering, chart of accounts and tax rates.
    let (accounts_created, rates_created) = seed_weldbooks_defaults(
        db,
        &SeedDefaults {
            entity_id: &entity_id,
            code: &code,
            base_currency: &base_currency,
            padding: adapter.default_padding,
            kind: &kind,
            timezone: timezone.as_deref(),
            seed_chart: data.seed_defaults,
            at: &at,
        },
    )
    .await?;

    // The default entity: the first company, or the one asked for. Making an
    // existing company the workspace default is a company change
    // (`legal_entities:update`); without it only WeldBooks' own default moves
    // (`settings.default_entity_id`, which `defaultEntityIdFor('weldbooks')`
    // falls back to).
    let default_asked = company.is_some()
        && data.get("isDefault").and_then(Value::as_bool) == Some(true)
        && !is_default;
    if default_asked && caller.can("legal_entities:update") {
        set_default_legal_entity(db, &entity_id)
            .await
            .map_err(|error| legal_entity_refusal(error, Refusal::bad_request))?;
    } else if default_asked || is_default {
        make_default_entity(db, &entity_id, &at).await?;
    }
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "accounting_entity",
            entity_id: &entity_id,
            action: "created",
            changes: None,
        },
    )
    .await;
    caller.publish(
        state,
        ACCOUNTING_ENTITY_CREATED,
        &entity_id,
        json!({
            "id": entity_id,
            "name": entity_name,
            "jurisdictionCode": code,
            "entityType": kind.entity_type,
            "taxClassification": kind.tax_classification,
        }),
    );
    let Some(entity) = load_accounting_entity(db, &entity_id).await? else {
        return Err(Refusal::Internal("the new entity is gone".to_owned()));
    };
    let mut out = object(serialize(&object(entity)));
    out.insert("accountsCreated".to_owned(), json!(accounts_created));
    out.insert("taxRatesCreated".to_owned(), json!(rates_created));
    Ok(created(Value::Object(out)))
}

/// A string field of the body as a [`Given`].
fn given_text(data: &EntityBody, key: &str) -> Given<String> {
    match data.get(key) {
        None => Given::Absent,
        Some(Value::Null) => Given::Null,
        Some(value) => Given::Set(value.as_str().unwrap_or_default().to_owned()),
    }
}

/// What `seedWeldbooksDefaults` needs.
struct SeedDefaults<'a> {
    entity_id: &'a str,
    code: &'a str,
    base_currency: &'a str,
    /// `adapter.getInvoiceRequirements(locale).defaultPadding`.
    padding: i64,
    kind: &'a EntityKind,
    timezone: Option<&'a str>,
    seed_chart: bool,
    at: &'a str,
}

/// `seedWeldbooksDefaults`: the number sequences (invoice, bill, credit
/// note, journal), then, with `seedDefaults`, the chart of accounts and the
/// tax rates; once per entity, so enabling WeldBooks again after it was
/// switched off keeps what is already there.
async fn seed_weldbooks_defaults(
    db: &sqlx::PgPool,
    args: &SeedDefaults<'_>,
) -> Result<(usize, usize), sqlx::Error> {
    let mut ids = Vec::new();
    let mut types = Vec::new();
    let mut prefixes = Vec::new();
    for (kind_name, prefix) in [
        ("invoice", "INV-"),
        ("bill", "BILL-"),
        ("creditNote", "CN-"),
        ("journal", "JE-"),
    ] {
        ids.push(generate_id("seq"));
        types.push(kind_name);
        prefixes.push(prefix);
    }
    sqlx::query(
        "insert into entity_number_sequences \
           (id, entity_id, sequence_type, prefix, next_value, padding, created_at, updated_at) \
         select s.id, $2, s.sequence_type, s.prefix, 1, $5, $6::timestamp, $6::timestamp \
         from unnest($1::text[], $3::text[], $4::text[]) as s(id, sequence_type, prefix) \
         on conflict do nothing",
    )
    .bind(&ids)
    .bind(args.entity_id)
    .bind(&types)
    .bind(&prefixes)
    .bind(i32::try_from(args.padding).unwrap_or(4))
    .bind(args.at)
    .execute(db)
    .await?;
    if !args.seed_chart {
        return Ok((0, 0));
    }
    seed_defaults(db, args).await
}

/// `seedEntityDefaults`: the chart and the standard tax rates, each only
/// when the entity has none yet.
async fn seed_defaults(
    db: &sqlx::PgPool,
    args: &SeedDefaults<'_>,
) -> Result<(usize, usize), sqlx::Error> {
    let (has_accounts, has_rates): (bool, bool) = sqlx::query_as(
        "select exists (select 1 from accounts where entity_id = $1), \
                exists (select 1 from tax_rates where entity_id = $1)",
    )
    .bind(args.entity_id)
    .fetch_one(db)
    .await?;
    let accounts = if has_accounts {
        Vec::new()
    } else {
        build_seed_accounts(&SeedArgs {
            entity_id: args.entity_id,
            jurisdiction: args.code,
            base_currency: args.base_currency,
            kind: args.kind,
            tax_year: tax_year_of(args.timezone),
            now: args.at,
        })
    };
    let categories: &[Value] = if has_rates {
        &[]
    } else {
        jurisdictions::tax_categories(
            args.code,
            args.kind.entity_type.as_deref(),
            args.kind.tax_classification.as_deref(),
        )
    };
    let entity_id = args.entity_id;
    let code = args.code;
    let at = args.at;
    let rates: Vec<Map<String, Value>> = categories
        .iter()
        .map(|t| {
            let mut rate = Map::new();
            for (key, value) in [
                ("id", json!(generate_id("txr"))),
                ("entityId", json!(entity_id)),
                ("jurisdictionCode", json!(code)),
                ("name", t["name"].clone()),
                ("rate", t["rate"].clone()),
                ("type", t["type"].clone()),
                ("taxCategoryCode", t["taxCategoryCode"].clone()),
                (
                    "isDefault",
                    json!(t["isDefault"].as_bool().unwrap_or(false)),
                ),
                ("isActive", json!(t["isActive"].as_bool().unwrap_or(true))),
                ("createdAt", json!(at)),
                ("updatedAt", json!(at)),
            ] {
                rate.insert(key.to_owned(), value);
            }
            if let Some(meta) = t.get("jurisdictionMetadata") {
                rate.insert("jurisdictionMetadata".to_owned(), meta.clone());
            }
            rate
        })
        .collect();
    let counts = (accounts.len(), rates.len());
    weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            for account in accounts {
                ACCOUNTS
                    .insert_raw(&mut *conn, ACCOUNTS.values(&account))
                    .await?;
            }
            for rate in rates {
                TAX_RATES
                    .insert_raw(&mut *conn, TAX_RATES.values(&rate))
                    .await?;
            }
            Ok::<_, sqlx::Error>(())
        })
    })
    .await?;
    Ok(counts)
}

/// `makeDefaultEntity`: `settings.defaultEntityId` (the settings row made if
/// there is none).
async fn make_default_entity(
    db: &sqlx::PgPool,
    entity_id: &str,
    at: &str,
) -> Result<(), sqlx::Error> {
    let existing: Option<String> = sqlx::query_scalar("select id from settings limit 1")
        .fetch_optional(db)
        .await?;
    if let Some(id) = existing {
        sqlx::query(
            "update settings set default_entity_id = $1, updated_at = $2::timestamp where id = $3",
        )
        .bind(entity_id)
        .bind(at)
        .bind(id)
        .execute(db)
        .await?;
    } else {
        let mut row = Map::new();
        for (key, value) in [
            ("id", json!(generate_id("acs"))),
            ("defaultEntityId", json!(entity_id)),
            ("createdAt", json!(at)),
            ("updatedAt", json!(at)),
        ] {
            row.insert(key.to_owned(), value);
        }
        SETTINGS.insert_raw(db, SETTINGS.values(&row)).await?;
    }
    Ok(())
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        body::read(issues, body, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update entity"),
    };
    reply(
        update_entity(&caller, &state, &id, data).await,
        "Failed to update entity",
    )
}

/// `JSON.stringify` of a value whose object keys come in `order` first.
fn stringify_ordered(value: &Value, order: &[&str]) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by_key(|k| order.iter().position(|o| o == k).unwrap_or(usize::MAX));
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| format!("{}:{}", Value::String(k.clone()), map[k]))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        other => other.to_string(),
    }
}

/// `JSON.stringify` of a `jsonb` value: shorter keys first, then bytewise.
fn stringify_jsonb(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| format!("{}:{}", Value::String(k.clone()), map[k]))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        other => other.to_string(),
    }
}

/// `fiscalYearChanged(data, existing)`.
fn fiscal_year_changed(data: &EntityBody, existing: &Map<String, Value>) -> bool {
    if let Some(start) = data.get("fiscalYearStart")
        && existing.get("fiscalYearStart") != Some(start)
    {
        return true;
    }
    data.get("fiscalYearConfig").is_some_and(|config| {
        stringify_ordered(config, &["type", "endMonth", "weekday", "rule"])
            != stringify_jsonb(existing.get("fiscalYearConfig").unwrap_or(&Value::Null))
    })
}

/// `entityLockConflict`: base currency, jurisdiction and fiscal year are
/// frozen once the books rest on them.
async fn lock_conflict(
    caller: &Caller,
    existing: &Map<String, Value>,
    data: &EntityBody,
    next_jurisdiction: &str,
) -> Result<Option<(String, Value)>, sqlx::Error> {
    let upper = |key: &str| {
        existing
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_uppercase()
    };
    let currency_changes = data
        .text("baseCurrency")
        .is_some_and(|c| c.to_uppercase() != upper("baseCurrency"));
    let jurisdiction_changes = next_jurisdiction != upper("jurisdictionCode");
    let fiscal_changes = fiscal_year_changed(data, existing);
    if !currency_changes && !jurisdiction_changes && !fiscal_changes {
        return Ok(None);
    }
    let id = existing["id"].as_str().unwrap_or_default();
    let lock = lock_state(&caller.db, id).await?;
    let has_postings = lock["hasPostings"].as_bool().unwrap_or(false);
    if (currency_changes || jurisdiction_changes)
        && lock["baseSettingsLocked"].as_bool().unwrap_or(false)
    {
        let mut names = Vec::new();
        let mut fields = Vec::new();
        if currency_changes {
            names.push("base currency");
            fields.push("baseCurrency");
        }
        if jurisdiction_changes {
            names.push("jurisdiction");
            fields.push("jurisdictionCode");
        }
        return Ok(Some((
            format!(
                "The {} of this entity can no longer be changed because it already has posted transactions. Create a new entity instead.",
                names.join(" and ")
            ),
            json!({ "code": "ENTITY_HAS_POSTINGS", "fields": fields }),
        )));
    }
    if fiscal_changes && lock["fiscalYearLocked"].as_bool().unwrap_or(false) {
        let message = if has_postings {
            "The fiscal year of this entity can no longer be changed because it already has posted transactions."
        } else {
            "The fiscal year of this entity can no longer be changed because fiscal periods have been generated for it."
        };
        let code = if has_postings {
            "ENTITY_HAS_POSTINGS"
        } else {
            "ENTITY_HAS_FISCAL_PERIODS"
        };
        return Ok(Some((
            message.to_owned(),
            json!({ "code": code, "fields": ["fiscalYearStart"] }),
        )));
    }
    Ok(None)
}

/// `{ ...existing, ...patch }` of two maps (missing = `{}`).
fn spread(base: Option<&Value>, over: Option<&Map<String, Value>>) -> Map<String, Value> {
    let mut out = base.and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(over) = over {
        for (key, value) in over {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

/// `auditValue(column, value)`: tax IDs masked.
fn audit_value(column: &str, value: Option<&Value>) -> Value {
    let value = value.cloned().unwrap_or(Value::Null);
    if column == "taxIdentifiers"
        && let Value::Object(ids) = &value
        && let Some(ein) = ids
            .get("einOrSsn")
            .and_then(Value::as_str)
            .filter(|e| !e.is_empty())
    {
        let mut masked = ids.clone();
        masked.insert("einOrSsn".to_owned(), json!(us::mask_tin(ein, None)));
        return Value::Object(masked);
    }
    value
}

/// The core fields of a PATCH patch (`CORE_PATCH_KEYS`, everything else stays
/// WeldBooks' own or a mirror), with the core part of the body's branding;
/// `None` when the patch touches none of them.
fn core_patch_of(
    patch: &Map<String, Value>,
    branding: Option<&Value>,
) -> Option<UpdateLegalEntityInput> {
    let text = |key: &str| patch.get(key).and_then(Value::as_str).map(str::to_owned);
    let mut input = UpdateLegalEntityInput {
        name: text("name"),
        legal_name: text_field_of(patch.get("legalName")),
        dba: text_field_of(patch.get("dba")),
        entity_type: text_field_of(patch.get("entityType")),
        jurisdiction_code: text("jurisdictionCode"),
        base_currency: text("baseCurrency"),
        locale: text("locale"),
        timezone: text("timezone"),
        address: field_of(patch.get("address")),
        contact: field_of(patch.get("contact")),
        fiscal_year_start: patch
            .get("fiscalYearStart")
            .and_then(Value::as_i64)
            .and_then(|start| i32::try_from(start).ok()),
        fiscal_year_config: field_of(patch.get("fiscalYearConfig")),
        tax_classification: text_field_of(patch.get("taxClassification")),
        branding: Field::Absent,
    };
    if let Some(core) = core_branding_of(branding) {
        input.branding = Field::Set(Value::Object(core));
    }
    (input != UpdateLegalEntityInput::default()).then_some(input)
}

#[allow(clippy::too_many_lines)] // the worker's handler, step by step
async fn update_entity(caller: &Caller, state: &BooksState, id: &str, body: EntityBody) -> Reply {
    let db = &caller.db;
    // `jurisdiction` / `vatNumber` are request-shape aliases; `ssn` is sealed before it is stored.
    // `isDefault` goes through core (`setDefaultLegalEntity`), `invoiceBankAccountId`
    // to the WeldBooks extension.
    let jurisdiction_alias = body.text("jurisdiction").map(str::to_owned);
    let vat_alias = body.get("vatNumber").cloned();
    let ssn = body.get("ssn").cloned();
    let is_default = body.get("isDefault").and_then(Value::as_bool);
    let invoice_bank_account_id = body.get("invoiceBankAccountId").cloned();
    let mut data = body;
    for alias in [
        "jurisdiction",
        "vatNumber",
        "ssn",
        "isDefault",
        "invoiceBankAccountId",
    ] {
        data.data.remove(alias);
    }
    let Some(existing) = find_active(caller, id).await? else {
        return Err(Refusal::not_found("Entity", id));
    };
    let next = data
        .text("jurisdictionCode")
        .map(str::to_owned)
        .or_else(|| jurisdiction_alias.clone())
        .unwrap_or_else(|| {
            existing["jurisdictionCode"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        })
        .to_uppercase();
    let jurisdiction_given = data.text("jurisdictionCode").is_some_and(|c| !c.is_empty())
        || jurisdiction_alias.as_deref().is_some_and(|c| !c.is_empty());
    if jurisdiction_given && !jurisdictions::has_adapter(&next) {
        return Err(Refusal::bad_request(unsupported(&next)));
    }
    let is_us = next == "US";
    if let Some((message, details)) = lock_conflict(caller, &existing, &data, &next).await? {
        return Err(Refusal::conflict_with(message, details));
    }

    // `validateUpdatedTaxIdentifiers`
    let body_ids = map_of(data.get("taxIdentifiers"));
    let merged = match &vat_alias {
        Some(alias) => {
            let mut merged = spread(existing.get("taxIdentifiers"), body_ids.as_ref());
            merged.insert("vatNumber".to_owned(), alias.clone());
            Some(merged)
        }
        None if body_ids.is_some() => {
            Some(spread(existing.get("taxIdentifiers"), body_ids.as_ref()))
        }
        None => map_of(existing.get("taxIdentifiers")),
    };
    let touched = touched_tax_identifiers(data.get("taxIdentifiers"), vat_alias.as_ref());
    let india = apply_india(
        &next,
        merged,
        map_of(data.get("jurisdictionSettings"))
            .or_else(|| map_of(existing.get("jurisdictionSettings"))),
        data.text("timezone").map(str::to_owned).or_else(|| {
            existing
                .get("timezone")
                .and_then(Value::as_str)
                .map(str::to_owned)
        }),
        !touched.is_empty(),
    )
    .map_err(Refusal::bad_request)?;
    let tax_identifiers = if jurisdictions::has_adapter(&next) {
        validate_with_adapter(&next, india.ids.clone(), &touched).map_err(Refusal::bad_request)?
    } else {
        india.ids.clone()
    };

    // `buildEntityPatch`
    let mut patch = data.data.clone();
    patch.insert("updatedAt".to_owned(), json!(now()));
    if jurisdiction_given {
        patch.insert("jurisdictionCode".to_owned(), json!(next));
    }
    if vat_alias.is_some() || data.get("taxIdentifiers").is_some_and(|v| !v.is_null()) {
        match &tax_identifiers {
            Some(ids) => {
                patch.insert("taxIdentifiers".to_owned(), Value::Object(ids.clone()));
            }
            None => {
                patch.remove("taxIdentifiers");
            }
        }
    }
    if data.get("address").is_some() {
        let normalized = normalize_postal_address(data.get("address"));
        let address = if is_us {
            check_us_address(normalized)?
        } else {
            normalized
        };
        patch.insert("address".to_owned(), address.unwrap_or(Value::Null));
    }
    let existing_tz = existing
        .get("timezone")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty());
    let given_tz = data.text("timezone").filter(|t| !t.is_empty());
    if next == "IN" {
        let settings = india
            .settings
            .clone()
            .map(Value::Object)
            .or_else(|| existing.get("jurisdictionSettings").cloned())
            .unwrap_or(Value::Null);
        patch.insert("jurisdictionSettings".to_owned(), settings);
        if given_tz.is_none() && existing_tz.is_none() {
            patch.insert("timezone".to_owned(), json!(india.timezone));
        }
    }
    if next == "BR" {
        if data.get("address").is_some() {
            let address =
                br::normalize_address(patch.get("address").filter(|a| !a.is_null()).cloned())?;
            patch.insert("address".to_owned(), address.unwrap_or(Value::Null));
        }
        if data.get("jurisdictionSettings").is_some() || data.get("address").is_some() {
            let merged = spread(
                existing.get("jurisdictionSettings"),
                map_of(data.get("jurisdictionSettings")).as_ref(),
            );
            let address = patch
                .get("address")
                .filter(|a| !a.is_null())
                .cloned()
                .or_else(|| existing.get("address").filter(|a| !a.is_null()).cloned());
            let (settings, zone) = br::normalize_settings(Some(&merged), address.as_ref())?;
            patch.insert("jurisdictionSettings".to_owned(), Value::Object(settings));
            if given_tz.is_none() && existing_tz.is_none() {
                patch.insert("timezone".to_owned(), json!(zone));
            }
        }
    }
    // `applyEntityKindToPatch`
    let existing_kind = EntityKind {
        entity_type: existing
            .get("entityType")
            .and_then(Value::as_str)
            .map(str::to_owned),
        tax_classification: existing
            .get("taxClassification")
            .and_then(Value::as_str)
            .map(str::to_owned),
    };
    let kind_given = data.get("entityType").is_some() || data.get("taxClassification").is_some();
    let existing_code = existing.get("jurisdictionCode").and_then(Value::as_str);
    let mut form_changed = false;
    if kind_given || (is_us && existing_code != Some("US")) {
        let kind = resolve_entity_kind(
            &next,
            &given_text(&data, "entityType"),
            &given_text(&data, "taxClassification"),
            Some(&existing_kind),
        )?;
        match &kind.entity_type {
            Some(t) => {
                patch.insert("entityType".to_owned(), json!(t));
            }
            None => {
                patch.remove("entityType");
            }
        }
        patch.insert(
            "taxClassification".to_owned(),
            json!(kind.tax_classification),
        );
        if is_us {
            form_changed = existing_code != Some("US")
                || form_of(
                    existing_kind.entity_type.as_deref(),
                    existing_kind.tax_classification.as_deref(),
                ) != form_of(
                    kind.entity_type.as_deref(),
                    kind.tax_classification.as_deref(),
                );
        }
    }
    // `applyFiscalYearToPatch`
    if let Some(config) = data.get("fiscalYearConfig") {
        patch.insert("fiscalYearConfig".to_owned(), config.clone());
        if let Some(end) = config.get("endMonth").and_then(Value::as_i64)
            && data.get("fiscalYearStart").is_none()
        {
            patch.insert("fiscalYearStart".to_owned(), json!(end % 12 + 1));
        }
    } else if data.get("fiscalYearStart").is_some() {
        patch.insert("fiscalYearConfig".to_owned(), Value::Null);
    }
    // `applySsnToPatch`
    match &ssn {
        None => {}
        Some(Value::Null) => {
            patch.insert("ssnEncrypted".to_owned(), Value::Null);
            patch.insert("ssnLast4".to_owned(), Value::Null);
        }
        Some(Value::String(text)) if text.is_empty() => {
            patch.insert("ssnEncrypted".to_owned(), Value::Null);
            patch.insert("ssnLast4".to_owned(), Value::Null);
        }
        Some(value) => {
            if !is_us {
                return Err(Refusal::bad_request(
                    "An SSN can only be stored on a US entity",
                ));
            }
            let formatted = check_ssn(value.as_str().unwrap_or_default())?;
            let keyring = caller.keyring(state);
            if keyring.is_empty() {
                return Err(Refusal::unavailable(
                    "Encryption is not configured, so an SSN can not be stored",
                ));
            }
            let sealed = weldsuite_db::encrypt_field(&formatted, &keyring)
                .map_err(|error| Refusal::Internal(error.to_string()))?;
            patch.insert("ssnEncrypted".to_owned(), json!(sealed));
            patch.insert("ssnLast4".to_owned(), json!(us::tin_last4(&formatted)));
        }
    }

    if let Some(account) = invoice_bank_account_id
        .as_ref()
        .and_then(Value::as_str)
        .filter(|account| !account.is_empty())
    {
        let found: Option<String> = sqlx::query_scalar(
            "select id from bank_accounts where id = $1 and entity_id = $2 and deleted_at is null limit 1",
        )
        .bind(account)
        .bind(id)
        .fetch_optional(db)
        .await?;
        if found.is_none() {
            return Err(Refusal::bad_request(
                "That bank account does not belong to this entity",
            ));
        }
    }

    // 1. The company's own fields go through core.
    if let Some(core_patch) = core_patch_of(&patch, data.get("branding")) {
        update_legal_entity(db, id, &core_patch)
            .await
            .map_err(|error| legal_entity_refusal(error, Refusal::conflict))?;
    }

    // 2. The tax identifiers are the company's registrations.
    if let Some(Value::Object(ids)) = patch.get("taxIdentifiers") {
        sync_registrations_from_tax_identifiers(db, id, &next, Some(ids), &touched).await?;
    }

    // 3. What WeldBooks adds on top: the extension row.
    let mut extension = Map::new();
    for key in ["accountingMethod", "ssnEncrypted", "ssnLast4"] {
        if let Some(value) = patch.get(key) {
            extension.insert(key.to_owned(), value.clone());
        }
    }
    if let Some(settings) = patch.get("jurisdictionSettings") {
        extension.insert("jurisdictionSettings".to_owned(), settings.clone());
    }
    if data.get("branding").is_some() {
        let texts = document_texts_of(data.get("branding")).unwrap_or_default();
        extension.insert("documentTexts".to_owned(), Value::Object(texts));
    }
    if let Some(account) = &invoice_bank_account_id {
        extension.insert("invoiceBankAccountId".to_owned(), account.clone());
    }
    upsert_accounting_entity_settings(db, id, &extension).await?;

    // 4. Release 1 mirror: the old entity columns keep every value too
    // (readers outside the loader, old workers).
    ENTITIES
        .patch_raw(db, id, ENTITIES.values(&patch), true)
        .await?;

    // 5. Making it the workspace default is core's call (it also keeps
    // settings.default_entity_id in step).
    if is_default == Some(true) && existing.get("isDefault").and_then(Value::as_bool) != Some(true)
    {
        set_default_legal_entity(db, id)
            .await
            .map_err(|error| legal_entity_refusal(error, Refusal::conflict))?;
    }

    let updated = load_accounting_entity(db, id).await?.map(object);

    let mut changes: Map<String, Value> = patch
        .iter()
        .filter(|(key, _)| {
            key.as_str() != "updatedAt" && !weldsuite_events::SENSITIVE_KEYS.contains(&key.as_str())
        })
        .map(|(key, value)| {
            (
                key.clone(),
                change(
                    audit_value(key, existing.get(key)),
                    audit_value(key, Some(value)),
                ),
            )
        })
        .collect();
    if let Some(account) = &invoice_bank_account_id {
        changes.insert(
            "invoiceBankAccountId".to_owned(),
            change(
                existing
                    .get("invoiceBankAccountId")
                    .cloned()
                    .unwrap_or(Value::Null),
                account.clone(),
            ),
        );
    }
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(id),
            entity_type: "accounting_entity",
            entity_id: id,
            action: "updated",
            changes: Some(changes),
        },
    )
    .await;
    // `{ id, name: updated?.name }`: no name when the entity is gone.
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    if let Some(name) = updated.as_ref().and_then(|row| row.get("name")) {
        event.insert("name".to_owned(), name.clone());
    }
    caller.publish(state, ACCOUNTING_ENTITY_UPDATED, id, Value::Object(event));
    if next == "BR"
        && let Some(classification) = patch.get("taxClassification")
        && Some(classification) != existing.get("taxClassification")
    {
        sync_br_tax_profiles(db, id, classification.as_str()).await?;
    }
    let mut out = object(serialize(updated.as_ref().unwrap_or(&existing)));
    out.extend(object(lock_state(db, id).await?));
    out.insert("taxLineRemapNeeded".to_owned(), json!(form_changed));
    Ok(ok(Value::Object(out)))
}

// ── POST /:id/apply-tax-lines, /:id/reveal-ssn ──────────────────────────────

/// `readOptionalJson(c)`: the body as JSON, `{}` when it isn't.
pub(crate) fn optional_json(body: &Bytes) -> Value {
    serde_json::from_slice(body).unwrap_or_else(|_| json!({}))
}

/// `schema.safeParse(body)` failing: `error.badRequest(c, 'Invalid request body', flatten())`.
fn safe_parse<T>(
    body: &Value,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Refusal> {
    let mut issues = Issues::default();
    let value = issues.object(body).map(|fields| read(&mut issues, fields));
    if let Err(invalid) = issues.finish() {
        return Err(Refusal::bad_request_with(
            "Invalid request body",
            invalid.flatten(),
        ));
    }
    value.ok_or_else(|| Refusal::Internal("unreadable body".to_owned()))
}

async fn apply_lines(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let input = match safe_parse(&optional_json(&body), |issues, fields| {
        let overwrite = issues.boolean(fields, "overwrite", Presence::Optional);
        let year = issues.whole_number(
            fields,
            "taxYear",
            Presence::Optional,
            Number {
                min: Some(2023.0),
                max: Some(2100.0),
                ..Number::default()
            },
        );
        (matches!(overwrite, Field::Set(true)), year.into_option())
    }) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond("Failed to apply tax lines"),
    };
    let result = async {
        let Some(entity) = find_active(&caller, &id).await? else {
            return Err(Refusal::not_found("Entity", &id));
        };
        if entity.get("jurisdictionCode").and_then(Value::as_str) != Some("US") {
            return Err(Refusal::bad_request("Tax lines are only available for US entities"));
        }
        let entity = Value::Object(entity);
        let year = input
            .1
            .unwrap_or_else(|| tax_year_of(entity["timezone"].as_str()));
        let result = apply_tax_lines(&caller.db, &entity, input.0, year).await?;
        let updated = result["updated"].as_i64().unwrap_or(0);
        if updated > 0 {
            let mut changes = Map::new();
            changes.insert(
                "taxLines".to_owned(),
                change(Value::Null, json!({ "form": result["form"], "updated": updated })),
            );
            write_accounting_audit(
                &caller,
                &caller.db,
                AuditInput {
                    accounting_entity_id: Some(&id),
                    entity_type: "accounting_entity",
                    entity_id: &id,
                    action: "tax_lines_applied",
                    changes: Some(changes),
                },
            )
            .await;
            caller.publish(
                &state,
                ACCOUNTING_ENTITY_UPDATED,
                &id,
                json!({ "id": id, "name": entity["name"], "taxLinesApplied": updated, "taxForm": result["form"] }),
            );
        }
        Ok(ok(result))
    }
    .await;
    reply(result, "Failed to apply tax lines")
}

async fn reveal_ssn(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let reason = match safe_parse(&optional_json(&body), |issues, fields| {
        issues
            .text_with(
                fields,
                "reason",
                Presence::Optional,
                Text::trimmed(None, Some(255)),
            )
            .into_option()
    }) {
        Ok(reason) => reason,
        Err(refusal) => return refusal.respond("Failed to reveal the SSN"),
    };
    let result = async {
        let Some(entity) = find_active(&caller, &id).await? else {
            return Err(Refusal::not_found("Entity", &id));
        };
        let Some(sealed) = entity
            .get("ssnEncrypted")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            return Err(Refusal::not_found("SSN of entity", &id));
        };
        let plaintext = weldsuite_db::decrypt_field(sealed, &caller.keyring(&state))
            .map_err(|error| Refusal::Internal(error.to_string()))?;
        // No log row, no reveal.
        sqlx::query(
            "insert into tax_id_reveals (id, entity_id, subject_type, subject_id, field, revealed_by, reason) \
             values ($1, $2, 'entity', $2, 'ssn', $3, $4)",
        )
        .bind(generate_id("tir"))
        .bind(&id)
        .bind(&caller.user_id)
        .bind(&reason)
        .execute(&caller.db)
        .await?;
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&id),
                entity_type: "accounting_entity",
                entity_id: &id,
                action: "ssn_revealed",
                changes: None,
            },
        )
        .await;
        caller.publish(
            &state,
            ACCOUNTING_ENTITY_UPDATED,
            &id,
            json!({ "id": id, "name": entity.get("name"), "taxIdRevealed": "ssn" }),
        );
        let mut response = ok(json!({ "ssn": plaintext }));
        response.headers_mut().insert(
            http::header::CACHE_CONTROL,
            http::HeaderValue::from_static("no-store"),
        );
        Ok(response)
    }
    .await;
    reply(result, "Failed to reveal the SSN")
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let enabled = find_active(&caller, &id)
            .await?
            .is_some_and(|entity| entity.get("weldbooksEnabled") == Some(&Value::Bool(true)));
        if !enabled {
            return Err(Refusal::not_found("Entity", &id));
        }
        let has_data = LegalEntityApp::Weldbooks.has_data(&caller.db, &id).await?;
        if has_data || lock_state(&caller.db, &id).await?["hasPostings"] == true {
            return Err(Refusal::conflict_with(
                "WeldBooks already holds invoices, bills or journal entries for this entity. Archive or delete the company in Settings → Legal entities instead.",
                json!({ "code": "ENTITY_HAS_POSTINGS" }),
            ));
        }
        sqlx::query("delete from accounting_entity_settings where entity_id = $1")
            .bind(&id)
            .execute(&caller.db)
            .await?;
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&id),
                entity_type: "accounting_entity",
                entity_id: &id,
                action: "deleted",
                changes: None,
            },
        )
        .await;
        caller.publish(&state, ACCOUNTING_ENTITY_DELETED, &id, json!({ "id": id }));
        Ok(no_content())
    }
    .await;
    reply(result, "Failed to delete entity")
}

/// A 200 with headers kept (for handlers that add some).
#[allow(dead_code)]
fn plain(response: impl IntoResponse) -> Response {
    response.into_response()
}
