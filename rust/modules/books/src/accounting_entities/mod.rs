//! `/api/accounting-entities` (`routes/accounting-entities/index.ts`): the
//! legal entities a workspace keeps books for. Creating one is
//! jurisdiction-aware: the adapter seeds the chart of accounts, the standard
//! tax rates and the number sequences, and checks the tax identifiers. US
//! entities carry an entity type and tax classification, a write-only SSN and
//! tax lines on their accounts; lock dates and their exceptions are set here
//! (the posting engine enforces them).

mod body;
mod locks;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::address::normalize_postal_address;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, no_content, now, ok, reply, validate,
};
use weldsuite_books_domain::jurisdictions::{self, TaxIdField, br, india, us};
use weldsuite_books_domain::tables::{
    ACCOUNTS, ENTITIES, ENTITY_NUMBER_SEQUENCES, SETTINGS, TAX_RATES,
};
use weldsuite_catalogs::entity_events::{
    ACCOUNTING_ENTITY_CREATED, ACCOUNTING_ENTITY_DELETED, ACCOUNTING_ENTITY_UPDATED,
};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use self::body::EntityBody;
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
        .with_state(state)
}

const SECRET_COLUMNS: [&str; 3] = [
    "ssnEncrypted",
    "salesTaxCredentialsEncrypted",
    "fiscalCredentialsEncrypted",
];

/// `serializeEntity(row)`: the sealed columns out (`hasSsn`, … say whether
/// one is stored), and an SSN typed into the EIN slot masked.
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

/// A live entity, as Drizzle returns it.
pub(crate) async fn find_active(
    caller: &Caller,
    id: &str,
) -> Result<Option<Map<String, Value>>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(entities),
        " from entities t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(|row| object(ENTITIES.js(row))))
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

async fn list(caller: Caller) -> Response {
    let result = async {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(entities),
            " from entities t where t.deleted_at is null order by t.name"
        ))
        .fetch_all(&caller.db)
        .await?;
        let rows: Vec<Value> = rows
            .into_iter()
            .map(|row| serialize(&object(ENTITIES.js(row))))
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

#[allow(clippy::too_many_lines)] // the worker's handler, step by step
async fn create_entity(caller: &Caller, state: &BooksState, data: &EntityBody) -> Reply {
    let db = &caller.db;
    let Some(jurisdiction) = data
        .text("jurisdictionCode")
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
        data.text("timezone").map(str::to_owned),
        true,
    )
    .map_err(Refusal::bad_request)?;
    let touched = touched_tax_identifiers(data.get("taxIdentifiers"), data.get("vatNumber"));
    let tax_identifiers = validate_with_adapter(&jurisdiction, india.ids.clone(), &touched)
        .map_err(Refusal::bad_request)?;

    let kind = resolve_entity_kind(
        &code,
        &given_text(data, "entityType"),
        &given_text(data, "taxClassification"),
        None,
    )?;
    // `newEntityLocation`
    let address = normalize_postal_address(data.get("address"));
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
        Some(data.text("timezone").map_or_else(
            || us::default_time_zone(address.as_ref().and_then(|a| a["state"].as_str())).to_owned(),
            str::to_owned,
        ))
    } else {
        india.timezone.clone()
    };
    if let Some((_, zone)) = &br_settings {
        timezone = Some(
            data.text("timezone")
                .map_or_else(|| zone.clone(), str::to_owned),
        );
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

    let locale = data
        .text("locale")
        .unwrap_or(adapter.default_locale)
        .to_owned();
    let base_currency = data
        .text("baseCurrency")
        .unwrap_or(adapter.default_currency)
        .to_owned();
    let fiscal_year_config = data.get("fiscalYearConfig").cloned().unwrap_or(Value::Null);
    let fiscal_year_start = match data.get("fiscalYearStart").and_then(Value::as_i64) {
        Some(start) => start,
        None => fiscal_year_config["endMonth"]
            .as_i64()
            .map_or(1, |end| end % 12 + 1),
    };
    let at = now();
    let entity_id = generate_id("ent");
    let is_default = data
        .get("isDefault")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    // `newEntity`: a key with an undefined value is left out (JSON drops it).
    let mut entity = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            entity.insert(key.to_owned(), value);
        }
    };
    put("id", Some(json!(entity_id)));
    put("name", data.get("name").cloned());
    put("legalName", data.get("legalName").cloned());
    put("entityType", kind.entity_type.clone().map(Value::String));
    put("taxClassification", Some(json!(kind.tax_classification)));
    put("dba", Some(data.get("dba").cloned().unwrap_or(Value::Null)));
    put(
        "accountingMethod",
        Some(
            data.get("accountingMethod")
                .filter(|m| !m.is_null())
                .cloned()
                .unwrap_or_else(|| if is_us { json!("accrual") } else { Value::Null }),
        ),
    );
    put("jurisdictionCode", Some(json!(code)));
    put("baseCurrency", Some(json!(base_currency)));
    put("locale", Some(json!(locale)));
    put("timezone", timezone.clone().map(Value::String));
    put("taxIdentifiers", tax_identifiers.map(Value::Object));
    put("address", Some(address.unwrap_or(Value::Null)));
    put("contact", data.get("contact").cloned());
    put("bankDetails", data.get("bankDetails").cloned());
    put("branding", data.get("branding").cloned());
    put(
        "jurisdictionSettings",
        jurisdiction_settings.map(Value::Object),
    );
    put("fiscalYearStart", Some(json!(fiscal_year_start)));
    put("fiscalYearConfig", Some(fiscal_year_config));
    put("ssnEncrypted", Some(ssn_encrypted));
    put("ssnLast4", Some(ssn_last4));
    put("isDefault", Some(json!(is_default)));
    put("isActive", Some(json!(true)));
    put("createdAt", Some(json!(at)));
    put("updatedAt", Some(json!(at)));

    ENTITIES.insert_raw(db, ENTITIES.values(&entity)).await?;

    // Numbering sequences: invoice, bill, credit note, journal.
    for (kind_name, prefix) in [
        ("invoice", "INV-"),
        ("bill", "BILL-"),
        ("creditNote", "CN-"),
        ("journal", "JE-"),
    ] {
        let mut sequence = Map::new();
        for (key, value) in [
            ("id", json!(generate_id("seq"))),
            ("entityId", json!(entity_id)),
            ("sequenceType", json!(kind_name)),
            ("prefix", json!(prefix)),
            ("nextValue", json!(1)),
            ("padding", json!(adapter.default_padding)),
            ("createdAt", json!(at)),
            ("updatedAt", json!(at)),
        ] {
            sequence.insert(key.to_owned(), value);
        }
        ENTITY_NUMBER_SEQUENCES
            .insert_raw(db, ENTITY_NUMBER_SEQUENCES.values(&sequence))
            .await?;
    }

    let (accounts_created, rates_created) = if data.seed_defaults {
        seed_defaults(
            db,
            &entity_id,
            &code,
            &base_currency,
            &kind,
            timezone.as_deref(),
            &at,
        )
        .await?
    } else {
        (0, 0)
    };
    if is_default {
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
            "name": entity.get("name"),
            "jurisdictionCode": code,
            "entityType": kind.entity_type,
            "taxClassification": kind.tax_classification,
        }),
    );
    let mut out = object(serialize(&entity));
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

/// `seedEntityDefaults`: the chart and the standard tax rates.
async fn seed_defaults(
    db: &sqlx::PgPool,
    entity_id: &str,
    code: &str,
    base_currency: &str,
    kind: &EntityKind,
    timezone: Option<&str>,
    at: &str,
) -> Result<(usize, usize), sqlx::Error> {
    let accounts = build_seed_accounts(&SeedArgs {
        entity_id,
        jurisdiction: code,
        base_currency,
        kind,
        tax_year: tax_year_of(timezone),
        now: at,
    });
    let categories = jurisdictions::tax_categories(
        code,
        kind.entity_type.as_deref(),
        kind.tax_classification.as_deref(),
    );
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

#[allow(clippy::too_many_lines)] // the worker's handler, step by step
async fn update_entity(caller: &Caller, state: &BooksState, id: &str, body: EntityBody) -> Reply {
    let db = &caller.db;
    // `jurisdiction` / `vatNumber` are request-shape aliases; `ssn` is sealed before it is stored.
    let jurisdiction_alias = body.text("jurisdiction").map(str::to_owned);
    let vat_alias = body.get("vatNumber").cloned();
    let ssn = body.get("ssn").cloned();
    let mut data = body;
    for alias in ["jurisdiction", "vatNumber", "ssn"] {
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

    ENTITIES
        .patch_raw(db, id, ENTITIES.values(&patch), true)
        .await?;
    let updated: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(entities),
        " from entities t where t.id = $1 limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    let updated = updated
        .map(|row| object(ENTITIES.js(row)))
        .unwrap_or_default();

    let changes: Map<String, Value> = patch
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
    caller.publish(
        state,
        ACCOUNTING_ENTITY_UPDATED,
        id,
        json!({ "id": id, "name": updated.get("name") }),
    );
    if next == "BR"
        && let Some(classification) = patch.get("taxClassification")
        && Some(classification) != existing.get("taxClassification")
    {
        sync_br_tax_profiles(db, id, classification.as_str()).await?;
    }
    let mut out = object(serialize(&updated));
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
        if find_active(&caller, &id).await?.is_none() {
            return Err(Refusal::not_found("Entity", &id));
        }
        let at = now();
        sqlx::query(
            "update entities set deleted_at = $1::timestamp, is_active = false, updated_at = $1::timestamp where id = $2",
        )
        .bind(&at)
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
