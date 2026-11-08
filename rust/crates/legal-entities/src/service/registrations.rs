//! Registrations: every number an authority gave the company, with the
//! release 1 mirrors into `entities.tax_identifiers` and the WeldHR employers.

use serde_json::{Map, Value};
use sqlx::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::Field;

use super::entities::{load_entity_row, require_entity_row};
use super::types::{
    CreateRegistrationInput, LegalEntityRegistration, RegistrationRow, UpdateRegistrationInput,
};
use super::{
    Columns, LegalEntityError, Param, insert_returning, js_slice_start, now_iso, read_row,
    update_returning,
};
use crate::schemas::{RegistrationType, normalize_registration_number, registration_number_error};

fn registration_row(value: Value) -> Result<RegistrationRow, LegalEntityError> {
    Ok(read_row::<RegistrationRow>(value)?.0)
}

/// `listRegistrations`: by type, primary first, oldest first.
pub async fn list_registrations(
    db: &PgPool,
    entity_id: &str,
) -> Result<Vec<LegalEntityRegistration>, LegalEntityError> {
    require_entity_row(db, entity_id).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from legal_entity_registrations t
         where t.entity_id = $1 and t.deleted_at is null
         order by t.type asc, t.is_primary desc, t.created_at asc",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    rows.into_iter()
        .map(|row| registration_row(row).map(LegalEntityRegistration::from))
        .collect()
}

/// The primary registration of a type (and region): the lookup apps use
/// (`getRegistration`).
pub async fn get_registration(
    db: &PgPool,
    entity_id: &str,
    registration_type: RegistrationType,
    region: Option<&str>,
) -> Result<Option<LegalEntityRegistration>, LegalEntityError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from legal_entity_registrations t
         where t.entity_id = $1 and t.type = $2 and t.deleted_at is null
           and ($3::text is null or t.region = $3)
         order by t.is_primary desc, t.created_at asc
         limit 1",
    )
    .bind(entity_id)
    .bind(registration_type.as_str())
    .bind(region.filter(|region| !region.is_empty()))
    .fetch_optional(db)
    .await?;
    row.map(|row| registration_row(row).map(LegalEntityRegistration::from))
        .transpose()
}

/// `clearOtherPrimaries`: one primary per type (per region when it has one).
async fn clear_other_primaries(db: &PgPool, row: &RegistrationRow) -> Result<(), LegalEntityError> {
    sqlx::query(
        "update legal_entity_registrations set is_primary = false, updated_at = $1::timestamp
         where entity_id = $2 and type = $3 and id <> $4 and is_primary = true
           and ($5::text is null or region = $5)",
    )
    .bind(now_iso())
    .bind(&row.entity_id)
    .bind(&row.registration_type)
    .bind(&row.id)
    .bind(row.region.as_deref().filter(|region| !region.is_empty()))
    .execute(db)
    .await?;
    Ok(())
}

/// Release 1 mirror of the primaries into `entities.tax_identifiers` (still
/// read by WeldBooks): `vatNumber` (`gstin` for India), `registrationNumber`,
/// and `einOrSsn`, which an SSN keeps unless an EIN registration exists
/// (`mirrorTaxIdentifiers`).
async fn mirror_tax_identifiers(db: &PgPool, entity_id: &str) -> Result<(), LegalEntityError> {
    let Some(entity) = load_entity_row(db, entity_id).await? else {
        return Ok(());
    };
    let primaries: Vec<(String, String)> = sqlx::query_as(
        "select type, number from legal_entity_registrations
         where entity_id = $1 and is_primary = true and deleted_at is null",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let primary = |kind: &str| {
        primaries
            .iter()
            .find(|(registration_type, _)| registration_type == kind)
            .map(|(_, number)| number.clone())
    };
    let mut next = match &entity.tax_identifiers {
        Value::Object(current) => current.clone(),
        _ => Map::new(),
    };
    let vat_type = if entity.jurisdiction_code.to_uppercase().starts_with("IN") {
        "gstin"
    } else {
        "vat"
    };
    for (key, number) in [
        ("vatNumber", primary(vat_type)),
        ("registrationNumber", primary("company_registration")),
    ] {
        match number {
            Some(number) => {
                next.insert(key.to_owned(), Value::String(number));
            }
            None => {
                next.remove(key);
            }
        }
    }
    if let Some(ein) = primary("ein") {
        next.insert("einOrSsn".to_owned(), Value::String(ein));
    }
    sqlx::query(
        "update entities set tax_identifiers = $1::jsonb, updated_at = $2::timestamp where id = $3",
    )
    .bind(Value::Object(next))
    .bind(now_iso())
    .bind(entity_id)
    .execute(db)
    .await?;
    Ok(())
}

/// Release 1 mirror into the WeldHR employers that run payroll under this
/// registration (`mirrorRegistrationToEmployers`): the loonheffingennummer
/// into `nl_settings`, the EIN into `us_settings`.
async fn mirror_registration_to_employers(
    db: &PgPool,
    row: &RegistrationRow,
) -> Result<(), LegalEntityError> {
    let (column, key) = match row.registration_type.as_str() {
        "nl_payroll_tax" => ("nl_settings", "loonheffingennummer"),
        "ein" => ("us_settings", "ein"),
        _ => return Ok(()),
    };
    let employers: Vec<(String, Value, Value)> = sqlx::query_as(
        "select id, nl_settings, us_settings from hr_payroll_employers where registration_id = $1",
    )
    .bind(&row.id)
    .fetch_all(db)
    .await?;
    for (id, nl, us) in employers {
        let current = if column == "nl_settings" { nl } else { us };
        let mut settings = match current {
            Value::Object(fields) => fields,
            _ => Map::new(),
        };
        settings.insert(key.to_owned(), Value::String(row.number.clone()));
        let sql = if column == "nl_settings" {
            "update hr_payroll_employers set nl_settings = $1::jsonb, updated_at = $2::timestamp where id = $3"
        } else {
            "update hr_payroll_employers set us_settings = $1::jsonb, updated_at = $2::timestamp where id = $3"
        };
        sqlx::query(sql)
            .bind(Value::Object(settings))
            .bind(now_iso())
            .bind(&id)
            .execute(db)
            .await?;
    }
    Ok(())
}

fn text_param(field: &Field<String>) -> Param {
    Param::Text(field.as_set().cloned())
}

fn date_param(field: &Field<String>) -> Param {
    Param::Date(field.as_set().cloned())
}

/// `createRegistration`: `BAD_REQUEST` when the number does not fit its type.
/// The first of a primary type becomes the primary.
pub async fn create_registration(
    db: &PgPool,
    entity_id: &str,
    input: &CreateRegistrationInput,
) -> Result<LegalEntityRegistration, LegalEntityError> {
    let entity = require_entity_row(db, entity_id).await?;
    let kind = input.registration_type;
    let number = normalize_registration_number(kind, &input.number);
    if let Some(problem) = registration_number_error(kind, &number) {
        return Err(LegalEntityError::bad_request(problem));
    }
    let existing = get_registration(
        db,
        entity_id,
        kind,
        input.region.as_set().map(String::as_str),
    )
    .await?;
    let is_primary = if kind.is_primary_type() {
        input.is_primary.unwrap_or(existing.is_none())
    } else {
        false
    };
    let country = input
        .country
        .as_set()
        .cloned()
        .unwrap_or_else(|| js_slice_start(&entity.jurisdiction_code, 2).to_uppercase());
    let mut columns = Columns::default();
    columns.set("id", Param::Text(Some(generate_id("ler"))));
    columns.set("entity_id", Param::Text(Some(entity_id.to_owned())));
    columns.set("type", Param::Text(Some(kind.as_str().to_owned())));
    columns.set("number", Param::Text(Some(number)));
    columns.set("country", Param::Text(Some(country)));
    columns.set("region", text_param(&input.region));
    columns.set("label", text_param(&input.label));
    columns.set("valid_from", date_param(&input.valid_from));
    columns.set("valid_to", date_param(&input.valid_to));
    columns.set("is_primary", Param::Bool(Some(is_primary)));
    let row = registration_row(insert_returning(db, "legal_entity_registrations", columns).await?)?;
    if row.is_primary {
        clear_other_primaries(db, &row).await?;
    }
    mirror_tax_identifiers(db, entity_id).await?;
    Ok(row.into())
}

/// `requireRegistration`: a live registration of the entity, else `NOT_FOUND`
/// "Registration not found".
async fn require_registration(
    db: &PgPool,
    entity_id: &str,
    registration_id: &str,
) -> Result<RegistrationRow, LegalEntityError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from legal_entity_registrations t
         where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1",
    )
    .bind(registration_id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    match row {
        Some(row) => registration_row(row),
        None => Err(LegalEntityError::not_found("Registration not found")),
    }
}

/// `updateRegistration`: the number is checked against the stored type; a
/// new number clears the verification.
pub async fn update_registration(
    db: &PgPool,
    entity_id: &str,
    registration_id: &str,
    input: &UpdateRegistrationInput,
) -> Result<LegalEntityRegistration, LegalEntityError> {
    let existing = require_registration(db, entity_id, registration_id).await?;
    // A type outside the catalog reads like `other`: no format, never primary.
    let kind =
        RegistrationType::parse(&existing.registration_type).unwrap_or(RegistrationType::Other);
    let mut patch = Columns::default();
    patch.set("updated_at", Param::Timestamp(Some(now_iso())));
    if let Some(raw) = &input.number {
        let number = normalize_registration_number(kind, raw);
        if let Some(problem) = registration_number_error(kind, &number) {
            return Err(LegalEntityError::bad_request(problem));
        }
        if number != existing.number {
            patch.set("verified_at", Param::Timestamp(None));
            patch.set("verification", Param::Json(None));
        }
        patch.set("number", Param::Text(Some(number)));
    }
    if !input.country.is_absent() {
        patch.set("country", text_param(&input.country));
    }
    if !input.region.is_absent() {
        patch.set("region", text_param(&input.region));
    }
    if !input.label.is_absent() {
        patch.set("label", text_param(&input.label));
    }
    if !input.valid_from.is_absent() {
        patch.set("valid_from", date_param(&input.valid_from));
    }
    if !input.valid_to.is_absent() {
        patch.set("valid_to", date_param(&input.valid_to));
    }
    if let Some(is_primary) = input.is_primary
        && kind.is_primary_type()
    {
        patch.set("is_primary", Param::Bool(Some(is_primary)));
    }
    let row = update_returning(db, "legal_entity_registrations", patch, registration_id)
        .await?
        .ok_or_else(|| LegalEntityError::not_found("Registration not found"))?;
    let row = registration_row(row)?;
    if row.is_primary {
        clear_other_primaries(db, &row).await?;
    }
    mirror_tax_identifiers(db, entity_id).await?;
    mirror_registration_to_employers(db, &row).await?;
    Ok(row.into())
}

/// `deleteRegistration`: soft delete; CONFLICT while a WeldHR employer runs
/// payroll under it.
pub async fn delete_registration(
    db: &PgPool,
    entity_id: &str,
    registration_id: &str,
) -> Result<(), LegalEntityError> {
    let row = require_registration(db, entity_id, registration_id).await?;
    let employer: Option<String> = sqlx::query_scalar(
        "select id from hr_payroll_employers
         where registration_id = $1 and deleted_at is null limit 1",
    )
    .bind(&row.id)
    .fetch_optional(db)
    .await?;
    if employer.is_some() {
        return Err(LegalEntityError::conflict(
            "WeldHR payroll runs under this registration; change the payroll setup first",
        ));
    }
    let now = now_iso();
    let mut columns = Columns::default();
    columns.set("deleted_at", Param::Timestamp(Some(now.clone())));
    columns.set("is_primary", Param::Bool(Some(false)));
    columns.set("updated_at", Param::Timestamp(Some(now)));
    update_returning(db, "legal_entity_registrations", columns, &row.id).await?;
    mirror_tax_identifiers(db, entity_id).await?;
    Ok(())
}
