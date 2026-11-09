//! Release 1: the tax identifiers a WeldBooks entity request carries are
//! also the entity's primary registrations in core
//! (`services/accounting-entity-registrations.ts`). `entities.tax_identifiers`
//! stays written by the route (the mirror); this keeps the registrations in
//! step.
//!
//! - `vatNumber` → `vat` (`gstin` for an Indian entity); a US entity's EIN
//!   lives in `ein`;
//! - `registrationNumber` → `company_registration`;
//! - `einOrSsn` → `ein`, only when it is an EIN (an SSN never becomes a
//!   registration).

use serde_json::{Map, Value};
use sqlx::PgPool;
use weldsuite_books_domain::http::Refusal;
use weldsuite_books_domain::jurisdictions::{TaxIdField, js_trim};
use weldsuite_legal_entities::LegalEntityError;
use weldsuite_legal_entities::schemas::{RegistrationType, normalize_registration_number};
use weldsuite_legal_entities::service::{
    CreateRegistrationInput, UpdateRegistrationInput, create_registration, delete_registration,
    get_registration, update_registration,
};

/// `/^\d{2}-\d{7}$/`.
fn is_ein(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[2] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(at, byte)| at == 2 || byte.is_ascii_digit())
}

/// A failure that is not a `LegalEntityError` (a statement): the route's 500.
fn thrown(error: LegalEntityError) -> Result<(), Refusal> {
    match error {
        LegalEntityError::Coded { .. } => Ok(()),
        LegalEntityError::Database(error) => Err(Refusal::Database(error)),
        LegalEntityError::Internal(message) => Err(Refusal::Internal(message)),
    }
}

/// `syncPrimary`: set (or, for a blank number, retire) the primary
/// registration of a type. A number core's format check (or a payroll link)
/// refuses stays on the old column only: it must not fail the WeldBooks save.
async fn sync_primary(
    db: &PgPool,
    entity_id: &str,
    kind: RegistrationType,
    number: &str,
) -> Result<(), Refusal> {
    let result: Result<(), LegalEntityError> = async {
        let current = get_registration(db, entity_id, kind, None).await?;
        let value = js_trim(number);
        if value.is_empty() {
            if let Some(current) = current.filter(|current| current.is_primary) {
                delete_registration(db, entity_id, &current.id).await?;
            }
            return Ok(());
        }
        if current
            .as_ref()
            .is_some_and(|current| current.number == normalize_registration_number(kind, value))
        {
            return Ok(());
        }
        if let Some(current) = current.filter(|current| current.is_primary) {
            let input = UpdateRegistrationInput {
                number: Some(value.to_owned()),
                ..UpdateRegistrationInput::default()
            };
            update_registration(db, entity_id, &current.id, &input).await?;
        } else {
            let input = CreateRegistrationInput {
                is_primary: Some(true),
                ..CreateRegistrationInput::new(kind, value)
            };
            create_registration(db, entity_id, &input).await?;
        }
        Ok(())
    }
    .await;
    match result {
        Ok(()) => Ok(()),
        Err(error) => thrown(error),
    }
}

/// `syncRegistrationsFromTaxIdentifiers(db, entity, identifiers, touched)`:
/// mirror the identifiers a request touched into the entity's primary
/// registrations. A touched identifier that is missing (or blank) in the
/// validated result was cleared.
pub(crate) async fn sync_registrations_from_tax_identifiers(
    db: &PgPool,
    entity_id: &str,
    jurisdiction_code: &str,
    identifiers: Option<&Map<String, Value>>,
    touched: &[TaxIdField],
) -> Result<(), Refusal> {
    let Some(identifiers) = identifiers else {
        return Ok(());
    };
    if touched.is_empty() {
        return Ok(());
    }
    let code = jurisdiction_code.to_uppercase();
    let text = |key: &str| identifiers.get(key).and_then(Value::as_str);
    let has = |field: TaxIdField| touched.contains(&field);
    if has(TaxIdField::VatNumber) && code != "US" {
        let kind = if code.starts_with("IN") {
            RegistrationType::Gstin
        } else {
            RegistrationType::Vat
        };
        sync_primary(db, entity_id, kind, text("vatNumber").unwrap_or_default()).await?;
    }
    if has(TaxIdField::RegistrationNumber) {
        sync_primary(
            db,
            entity_id,
            RegistrationType::CompanyRegistration,
            text("registrationNumber").unwrap_or_default(),
        )
        .await?;
    }
    if has(TaxIdField::EinOrSsn) || (code == "US" && has(TaxIdField::VatNumber)) {
        let given: Vec<&str> = [
            text("einOrSsn"),
            if code == "US" {
                text("vatNumber")
            } else {
                None
            },
        ]
        .into_iter()
        .flatten()
        .filter(|value| !js_trim(value).is_empty())
        .collect();
        if let Some(ein) = given.iter().find(|value| is_ein(js_trim(value))) {
            sync_primary(db, entity_id, RegistrationType::Ein, ein).await?;
        } else if given.is_empty() {
            // Nothing left in the slots clears the EIN; an SSN there is not a
            // registration and leaves a registered EIN alone.
            sync_primary(db, entity_id, RegistrationType::Ein, "").await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_ein_is_an_ein() {
        assert!(is_ein("12-3456789"));
        assert!(!is_ein("123-45-6789"));
        assert!(!is_ein("123456789"));
        assert!(!is_ein("1a-3456789"));
    }
}
