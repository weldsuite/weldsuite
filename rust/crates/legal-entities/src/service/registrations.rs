//! Registrations: every number an authority gave the company, with the
//! release 1 mirrors into `entities.tax_identifiers` and the WeldHR employers.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value};
use sqlx::PgPool;
use time::Date;
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::Field;
use weldsuite_schema::tenant::{entities, hr_payroll_employers, legal_entity_registrations};

use super::entities::{load_entity_row, require_entity_row};
use super::types::{
    CreateRegistrationInput, LegalEntityRegistration, RegistrationRow, UpdateRegistrationInput,
};
use super::{LegalEntityError, js_slice_start, read_model};
use crate::schemas::{RegistrationType, normalize_registration_number, registration_number_error};

fn registration_row(
    model: &legal_entity_registrations::Model,
) -> Result<RegistrationRow, LegalEntityError> {
    Ok(read_model::<_, RegistrationRow>(model)?.0)
}

/// `update legal_entity_registrations set … where id = $id returning *`;
/// `None` when no row has the id.
async fn update_registration_row(
    db: &PgPool,
    id: &str,
    patch: legal_entity_registrations::ActiveModel,
) -> Result<Option<legal_entity_registrations::Model>, DbErr> {
    Ok(legal_entity_registrations::Entity::update_many()
        .set(patch)
        .filter(legal_entity_registrations::Column::Id.eq(id))
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next())
}

/// `region = $region` when the registration has one (`$5::text is null or
/// region = $5`).
fn in_region(region: Option<&str>) -> Condition {
    match region.filter(|region| !region.is_empty()) {
        Some(region) => Condition::all().add(legal_entity_registrations::Column::Region.eq(region)),
        None => Condition::all(),
    }
}

/// `listRegistrations`: by type, primary first, oldest first.
pub async fn list_registrations(
    db: &PgPool,
    entity_id: &str,
) -> Result<Vec<LegalEntityRegistration>, LegalEntityError> {
    require_entity_row(db, entity_id).await?;
    let rows = legal_entity_registrations::Entity::find()
        .filter(legal_entity_registrations::Column::EntityId.eq(entity_id))
        .filter(legal_entity_registrations::Column::DeletedAt.is_null())
        .order_by_asc(legal_entity_registrations::Column::Type)
        .order_by_desc(legal_entity_registrations::Column::IsPrimary)
        .order_by_asc(legal_entity_registrations::Column::CreatedAt)
        .all(&orm(db))
        .await?;
    rows.iter()
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
    let row = legal_entity_registrations::Entity::find()
        .filter(
            Condition::all()
                .add(legal_entity_registrations::Column::EntityId.eq(entity_id))
                .add(legal_entity_registrations::Column::Type.eq(registration_type.as_str()))
                .add(legal_entity_registrations::Column::DeletedAt.is_null())
                .add(in_region(region)),
        )
        .order_by_desc(legal_entity_registrations::Column::IsPrimary)
        .order_by_asc(legal_entity_registrations::Column::CreatedAt)
        .one(&orm(db))
        .await?;
    row.as_ref()
        .map(|row| registration_row(row).map(LegalEntityRegistration::from))
        .transpose()
}

/// `clearOtherPrimaries`: one primary per type (per region when it has one).
async fn clear_other_primaries(db: &PgPool, row: &RegistrationRow) -> Result<(), LegalEntityError> {
    legal_entity_registrations::Entity::update_many()
        .col_expr(
            legal_entity_registrations::Column::IsPrimary,
            Expr::value(false),
        )
        .col_expr(
            legal_entity_registrations::Column::UpdatedAt,
            Expr::value(utc_now()),
        )
        .filter(
            Condition::all()
                .add(legal_entity_registrations::Column::EntityId.eq(row.entity_id.as_str()))
                .add(legal_entity_registrations::Column::Type.eq(row.registration_type.as_str()))
                .add(legal_entity_registrations::Column::Id.ne(row.id.as_str()))
                .add(legal_entity_registrations::Column::IsPrimary.eq(true))
                .add(in_region(row.region.as_deref())),
        )
        .exec(&orm(db))
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
    let primaries: Vec<(String, String)> = legal_entity_registrations::Entity::find()
        .select_only()
        .columns([
            legal_entity_registrations::Column::Type,
            legal_entity_registrations::Column::Number,
        ])
        .filter(legal_entity_registrations::Column::EntityId.eq(entity_id))
        .filter(legal_entity_registrations::Column::IsPrimary.eq(true))
        .filter(legal_entity_registrations::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
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
    entities::Entity::update_many()
        .col_expr(
            entities::Column::TaxIdentifiers,
            Expr::value(Value::Object(next)),
        )
        .col_expr(entities::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(entities::Column::Id.eq(entity_id))
        .exec(&orm(db))
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
        "nl_payroll_tax" => (
            hr_payroll_employers::Column::NlSettings,
            "loonheffingennummer",
        ),
        "ein" => (hr_payroll_employers::Column::UsSettings, "ein"),
        _ => return Ok(()),
    };
    let employers: Vec<(String, Value)> = hr_payroll_employers::Entity::find()
        .select_only()
        .columns([hr_payroll_employers::Column::Id, column])
        .filter(hr_payroll_employers::Column::RegistrationId.eq(row.id.as_str()))
        .into_tuple()
        .all(&orm(db))
        .await?;
    for (id, current) in employers {
        let mut settings = match current {
            Value::Object(fields) => fields,
            _ => Map::new(),
        };
        settings.insert(key.to_owned(), Value::String(row.number.clone()));
        hr_payroll_employers::Entity::update_many()
            .col_expr(column, Expr::value(Value::Object(settings)))
            .col_expr(
                hr_payroll_employers::Column::UpdatedAt,
                Expr::value(utc_now()),
            )
            .filter(hr_payroll_employers::Column::Id.eq(id))
            .exec(&orm(db))
            .await?;
    }
    Ok(())
}

/// A `YYYY-MM-DD` the schema checked, as Postgres reads `$n::date`.
fn date_param(field: &Field<String>) -> Result<Option<Date>, LegalEntityError> {
    let Some(text) = field.as_set() else {
        return Ok(None);
    };
    let format = time::macros::format_description!("[year]-[month]-[day]");
    Date::parse(text, &format)
        .ok()
        // Postgres has no year 0.
        .filter(|day| day.year() > 0)
        .map(Some)
        .ok_or_else(|| {
            LegalEntityError::Internal(format!("invalid input syntax for type date: \"{text}\""))
        })
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
    let row = legal_entity_registrations::ActiveModel {
        id: Set(generate_id("ler")),
        entity_id: Set(entity_id.to_owned()),
        type_: Set(kind.as_str().to_owned()),
        number: Set(number),
        country: Set(Some(country)),
        region: Set(input.region.as_set().cloned()),
        label: Set(input.label.as_set().cloned()),
        valid_from: Set(date_param(&input.valid_from)?),
        valid_to: Set(date_param(&input.valid_to)?),
        is_primary: Set(is_primary),
        ..Default::default()
    };
    let row = legal_entity_registrations::Entity::insert(row)
        .exec_with_returning(&orm(db))
        .await?;
    let row = registration_row(&row)?;
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
    let row = legal_entity_registrations::Entity::find()
        .filter(legal_entity_registrations::Column::Id.eq(registration_id))
        .filter(legal_entity_registrations::Column::EntityId.eq(entity_id))
        .filter(legal_entity_registrations::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    match row {
        Some(row) => registration_row(&row),
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
    let mut patch = legal_entity_registrations::ActiveModel {
        updated_at: Set(utc_now()),
        ..Default::default()
    };
    if let Some(raw) = &input.number {
        let number = normalize_registration_number(kind, raw);
        if let Some(problem) = registration_number_error(kind, &number) {
            return Err(LegalEntityError::bad_request(problem));
        }
        if number != existing.number {
            patch.verified_at = Set(None);
            patch.verification = Set(None);
        }
        patch.number = Set(number);
    }
    let text = |field: &Field<String>| {
        if field.is_absent() {
            NotSet
        } else {
            Set(field.as_set().cloned())
        }
    };
    patch.country = text(&input.country);
    patch.region = text(&input.region);
    patch.label = text(&input.label);
    if !input.valid_from.is_absent() {
        patch.valid_from = Set(date_param(&input.valid_from)?);
    }
    if !input.valid_to.is_absent() {
        patch.valid_to = Set(date_param(&input.valid_to)?);
    }
    if let Some(is_primary) = input.is_primary
        && kind.is_primary_type()
    {
        patch.is_primary = Set(is_primary);
    }
    let row = update_registration_row(db, registration_id, patch)
        .await?
        .ok_or_else(|| LegalEntityError::not_found("Registration not found"))?;
    let row = registration_row(&row)?;
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
    let employer: Option<String> = hr_payroll_employers::Entity::find()
        .select_only()
        .column(hr_payroll_employers::Column::Id)
        .filter(hr_payroll_employers::Column::RegistrationId.eq(row.id.as_str()))
        .filter(hr_payroll_employers::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    if employer.is_some() {
        return Err(LegalEntityError::conflict(
            "WeldHR payroll runs under this registration; change the payroll setup first",
        ));
    }
    let now = utc_now();
    update_registration_row(
        db,
        &row.id,
        legal_entity_registrations::ActiveModel {
            deleted_at: Set(Some(now)),
            is_primary: Set(false),
            updated_at: Set(now),
            ..Default::default()
        },
    )
    .await?;
    mirror_tax_identifiers(db, entity_id).await?;
    Ok(())
}
