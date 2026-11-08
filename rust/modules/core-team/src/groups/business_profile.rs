//! The workspace business profile is the default legal entity
//! (`app-api/src/services/business-profile.ts`; "Workspace business profile"
//! in `docs/plans/legal-entities.md`).
//!
//! During the transition `PUT /api/workspace-settings` writes the legal fields
//! through to the default entity and `GET` reads them back from it, so old
//! clients keep working.
//!
//! ```text
//! legalName -> legal_name        tradingName -> dba
//! contactFirstName/LastName -> contact.contactPerson
//! email, phone, websiteUrl -> contact.email / phone / website
//! addressLine1/2, city, state, postalCode -> address
//! country -> address.country and jurisdiction_code (ISO-2 only)
//! vatNumber -> primary `vat` registration
//! registrationNumber -> primary `company_registration` registration
//! logoUrl, primaryColor, accentColor -> branding
//! ```

use serde_json::{Map, Value};
use sqlx::PgPool;
use weldsuite_kit::validation::{Field, js_trim};
use weldsuite_legal_entities::schemas::{RegistrationType, normalize_registration_number};
use weldsuite_legal_entities::service::{
    self as le, CreateLegalEntityInput, CreateRegistrationInput, EntityRow, UpdateLegalEntityInput,
    UpdateRegistrationInput,
};
use weldsuite_legal_entities::{LegalEntityCoreChange, LegalEntityError, locked_core_change};

/// Currency a new entity gets when the workspace has none: the country's own.
const COUNTRY_CURRENCY: [(&str, &str); 31] = [
    ("NL", "EUR"),
    ("BE", "EUR"),
    ("DE", "EUR"),
    ("FR", "EUR"),
    ("ES", "EUR"),
    ("IT", "EUR"),
    ("PT", "EUR"),
    ("IE", "EUR"),
    ("AT", "EUR"),
    ("FI", "EUR"),
    ("LU", "EUR"),
    ("GR", "EUR"),
    ("SK", "EUR"),
    ("SI", "EUR"),
    ("EE", "EUR"),
    ("LV", "EUR"),
    ("LT", "EUR"),
    ("MT", "EUR"),
    ("CY", "EUR"),
    ("GB", "GBP"),
    ("US", "USD"),
    ("CA", "CAD"),
    ("AU", "AUD"),
    ("IN", "INR"),
    ("BR", "BRL"),
    ("CH", "CHF"),
    ("SE", "SEK"),
    ("NO", "NOK"),
    ("DK", "DKK"),
    ("PL", "PLN"),
    ("CZ", "CZK"),
];

/// `LEGAL_FIELDS`: the settings fields that live on the legal entity.
const LEGAL_FIELDS: [&str; 18] = [
    "legalName",
    "tradingName",
    "contactFirstName",
    "contactLastName",
    "email",
    "phone",
    "addressLine1",
    "addressLine2",
    "city",
    "state",
    "postalCode",
    "country",
    "vatNumber",
    "registrationNumber",
    "logoUrl",
    "websiteUrl",
    "primaryColor",
    "accentColor",
];

/// `touchesLegalFields`: the save carries a field that lives on the entity.
fn touches_legal_fields(data: &Map<String, Value>) -> bool {
    LEGAL_FIELDS.iter().any(|field| data.contains_key(*field))
}

/// `blank(value)`: the trimmed text, `None` when it is empty or not text.
fn blank(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => {
            let trimmed = js_trim(text);
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        }
        _ => None,
    }
}

/// `blank` of a string.
fn blank_str(value: Option<&str>) -> Option<String> {
    let trimmed = js_trim(value?);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// `normalizeCountryCode`: ` nl ` → `NL`; `None` when it is not two letters
/// (or Cloudflare's `XX` / `T1` markers).
fn normalize_country_code(value: Option<&str>) -> Option<String> {
    let code = js_trim(value.unwrap_or_default()).to_uppercase();
    if code == "XX" || code == "T1" {
        return None;
    }
    (code.len() == 2 && code.bytes().all(|b| b.is_ascii_uppercase())).then_some(code)
}

/// `text.slice(0, 2)` in UTF-16 code units.
fn first_two(text: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().take(2).collect();
    String::from_utf16_lossy(&units)
}

/// A stored `jsonb` object (`row.x ?? {}`).
fn object(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(fields)) => fields.clone(),
        _ => Map::new(),
    }
}

/// `target[key] = value`, a value of `undefined` leaving the key out (it
/// would be dropped when stored).
fn set_or_drop(target: &mut Map<String, Value>, key: &str, value: Option<String>) {
    match value {
        Some(value) => {
            target.insert(key.to_owned(), Value::String(value));
        }
        None => {
            target.remove(key);
        }
    }
}

/// `entityPatch(data, existing)`: the core columns of an entity update from
/// the fields a save carries, merged over what the entity holds. `None` when
/// the save touches none of them.
fn entity_patch(data: &Map<String, Value>, existing: &EntityRow) -> Option<UpdateLegalEntityInput> {
    let mut patch = UpdateLegalEntityInput::default();
    let mut touched = false;
    let has = |keys: &[&str]| keys.iter().any(|key| data.contains_key(*key));
    let present = |key: &str| data.get(key);

    if let Some(value) = present("legalName") {
        patch.legal_name = blank(Some(value)).map_or(Field::Null, Field::Set);
        touched = true;
    }
    if let Some(value) = present("tradingName") {
        patch.dba = blank(Some(value)).map_or(Field::Null, Field::Set);
        touched = true;
    }

    if has(&[
        "addressLine1",
        "addressLine2",
        "city",
        "state",
        "postalCode",
        "country",
    ]) {
        let mut address = object(Some(&existing.address));
        for (key, field) in [
            ("addressLine1", "line1"),
            ("addressLine2", "line2"),
            ("city", "city"),
            ("state", "state"),
            ("postalCode", "postalCode"),
        ] {
            if let Some(value) = present(key) {
                set_or_drop(&mut address, field, blank(Some(value)));
            }
        }
        if let Some(value) = present("country") {
            let iso = normalize_country_code(value.as_str());
            let country = iso
                .clone()
                .or_else(|| blank(Some(value)).map(|text| first_two(&text)));
            set_or_drop(&mut address, "country", country);
            if iso.is_some() {
                patch.jurisdiction_code = iso;
            }
        }
        patch.address = Field::Set(Value::Object(address));
        touched = true;
    }

    if has(&[
        "email",
        "phone",
        "websiteUrl",
        "contactFirstName",
        "contactLastName",
    ]) {
        let mut contact = object(Some(&existing.contact));
        for (key, field) in [
            ("email", "email"),
            ("phone", "phone"),
            ("websiteUrl", "website"),
        ] {
            if let Some(value) = present(key) {
                set_or_drop(&mut contact, field, blank(Some(value)));
            }
        }
        if has(&["contactFirstName", "contactLastName"]) {
            let mut person = object(contact.get("contactPerson"));
            for (key, field) in [
                ("contactFirstName", "firstName"),
                ("contactLastName", "lastName"),
            ] {
                if let Some(value) = present(key) {
                    set_or_drop(&mut person, field, blank(Some(value)));
                }
            }
            contact.insert("contactPerson".to_owned(), Value::Object(person));
        }
        patch.contact = Field::Set(Value::Object(contact));
        touched = true;
    }

    if has(&["logoUrl", "primaryColor", "accentColor"]) {
        let mut branding = object(Some(&existing.branding));
        for key in ["logoUrl", "primaryColor", "accentColor"] {
            if let Some(value) = present(key) {
                set_or_drop(&mut branding, key, blank(Some(value)));
            }
        }
        patch.branding = Field::Set(Value::Object(branding));
        touched = true;
    }
    touched.then_some(patch)
}

/// An object of the keys whose value is set (`Object.fromEntries(… .filter(([, v]) => v !== undefined))`).
fn defined(entries: &[(&str, Option<String>)]) -> Map<String, Value> {
    entries
        .iter()
        .filter_map(|(key, value)| {
            value
                .clone()
                .map(|value| ((*key).to_owned(), Value::String(value)))
        })
        .collect()
}

/// `createInputFromSettings(row, fallbackName)`: the default entity from a
/// saved settings row, or `None` when there is not enough to create it.
fn create_input_from_settings(
    row: &Map<String, Value>,
    fallback_name: Option<&str>,
) -> Option<CreateLegalEntityInput> {
    let text = |key: &str| blank(row.get(key));
    let country = normalize_country_code(row.get("country").and_then(Value::as_str))?;
    let raw_currency = row
        .get("currency")
        .and_then(Value::as_str)
        .map(js_trim)
        .unwrap_or_default();
    let currency =
        if raw_currency.len() == 3 && raw_currency.bytes().all(|b| b.is_ascii_alphabetic()) {
            Some(raw_currency.to_uppercase())
        } else {
            COUNTRY_CURRENCY
                .iter()
                .find(|(code, _)| *code == country)
                .map(|(_, currency)| (*currency).to_owned())
        };
    let name = text("tradingName")
        .or_else(|| text("legalName"))
        .or_else(|| blank_str(fallback_name));
    let (Some(currency), Some(name)) = (currency, name) else {
        return None;
    };
    let address = defined(&[
        ("line1", text("addressLine1")),
        ("line2", text("addressLine2")),
        ("city", text("city")),
        ("state", text("state")),
        ("postalCode", text("postalCode")),
        ("country", Some(country.clone())),
    ]);
    let first_name = text("contactFirstName");
    let last_name = text("contactLastName");
    let mut contact = defined(&[
        ("email", text("email")),
        ("phone", text("phone")),
        ("website", text("websiteUrl")),
    ]);
    if first_name.is_some() || last_name.is_some() {
        contact.insert(
            "contactPerson".to_owned(),
            Value::Object(defined(&[
                ("firstName", first_name),
                ("lastName", last_name),
            ])),
        );
    }
    let branding = defined(&[
        ("logoUrl", text("logoUrl")),
        ("primaryColor", text("primaryColor")),
        ("accentColor", text("accentColor")),
    ]);
    let non_empty = |fields: Map<String, Value>| {
        if fields.is_empty() {
            Field::Absent
        } else {
            Field::Set(Value::Object(fields))
        }
    };
    Some(CreateLegalEntityInput {
        name,
        legal_name: text("legalName").map_or(Field::Null, Field::Set),
        dba: text("tradingName").map_or(Field::Null, Field::Set),
        jurisdiction_code: country,
        base_currency: currency,
        address: Field::Set(Value::Object(address)),
        contact: non_empty(contact),
        branding: non_empty(branding),
        is_default: Some(true),
        ..CreateLegalEntityInput::default()
    })
}

/// `writeRegistration`: set, change or (an empty value) remove one primary
/// registration. `value` is the save's (`None`: not in it). Formats the
/// registration catalog refuses are skipped, never thrown: the settings form
/// accepts looser formats, and the legacy column keeps the value.
async fn write_registration(
    db: &PgPool,
    entity_id: &str,
    kind: RegistrationType,
    value: Option<&Value>,
) -> Result<bool, LegalEntityError> {
    let Some(value) = value else {
        return Ok(false);
    };
    let existing = le::get_registration(db, entity_id, kind, None).await?;
    let written = match (blank(Some(value)), existing) {
        (None, None) => return Ok(false),
        (None, Some(existing)) => le::delete_registration(db, entity_id, &existing.id).await,
        (Some(number), Some(existing)) => {
            let input = UpdateRegistrationInput {
                number: Some(number),
                is_primary: Some(true),
                ..UpdateRegistrationInput::default()
            };
            le::update_registration(db, entity_id, &existing.id, &input)
                .await
                .map(drop)
        }
        (Some(number), None) => {
            let input = CreateRegistrationInput {
                is_primary: Some(true),
                ..CreateRegistrationInput::new(kind, number)
            };
            le::create_registration(db, entity_id, &input)
                .await
                .map(drop)
        }
    };
    match written {
        Ok(()) => Ok(true),
        Err(error @ LegalEntityError::Coded { .. }) => {
            tracing::warn!(
                registration = kind.as_str(),
                "business profile: registration not written: {}",
                error.message()
            );
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

/// What a save wrote to the default entity.
pub(crate) struct WriteThrough {
    pub(crate) entity: EntityRow,
    /// The default entity was created by this save.
    pub(crate) created: bool,
}

/// `lockedBusinessProfileChange`: why a save may not change the default
/// entity's country (WeldBooks has postings or WeldHR has pay runs for it),
/// or `None`. Checked before the save, so the member gets the same 409 as in
/// Settings → Legal entities instead of a save whose country silently does
/// not stick.
pub(crate) async fn locked_business_profile_change(
    db: &PgPool,
    data: &Map<String, Value>,
) -> Result<Option<String>, LegalEntityError> {
    let Some(country) = data.get("country") else {
        return Ok(None);
    };
    let Some(iso) = normalize_country_code(country.as_str()) else {
        return Ok(None);
    };
    let Some(existing) = le::get_default_legal_entity_row(db).await? else {
        return Ok(None);
    };
    if existing.jurisdiction_code.to_uppercase() == iso {
        return Ok(None);
    }
    Ok(locked_core_change(
        db,
        &existing.id,
        LegalEntityCoreChange {
            jurisdiction_code: true,
            base_currency: false,
            fiscal_year: false,
        },
    )
    .await?)
}

/// `writeThroughToDefaultEntity`: write a settings save through to the
/// default legal entity. Updates it when it exists; otherwise creates it
/// when the country is an ISO-2 code (and a currency and a name can be
/// found). `None` when nothing was written. `settings` is the row after the
/// upsert; the workspace name (from the master database, by `org`) is asked
/// only when an entity has to be created without a business name.
pub(crate) async fn write_through_to_default_entity(
    db: &PgPool,
    data: &Map<String, Value>,
    settings: &Value,
    master: &PgPool,
    org: &str,
) -> Result<Option<WriteThrough>, LegalEntityError> {
    if !touches_legal_fields(data) {
        return Ok(None);
    }
    if let Some(existing) = le::get_default_legal_entity_row(db).await? {
        let patch = entity_patch(data, &existing);
        let entity = match &patch {
            Some(patch) => le::update_legal_entity(db, &existing.id, patch).await?,
            None => existing.clone(),
        };
        let vat = write_registration(
            db,
            &existing.id,
            RegistrationType::Vat,
            data.get("vatNumber"),
        )
        .await?;
        let registration = write_registration(
            db,
            &existing.id,
            RegistrationType::CompanyRegistration,
            data.get("registrationNumber"),
        )
        .await?;
        if patch.is_none() && !vat && !registration {
            return Ok(None);
        }
        let entity = if vat || registration {
            le::get_default_legal_entity_row(db)
                .await?
                .unwrap_or(entity)
        } else {
            entity
        };
        return Ok(Some(WriteThrough {
            entity,
            created: false,
        }));
    }

    let settings = object(Some(settings));
    let needs_name =
        blank(settings.get("tradingName")).is_none() && blank(settings.get("legalName")).is_none();
    let fallback = if needs_name {
        workspace_name(master, org).await
    } else {
        None
    };
    let Some(input) = create_input_from_settings(&settings, fallback.as_deref()) else {
        return Ok(None);
    };
    let entity = le::create_legal_entity(db, &input).await?;
    write_registration(
        db,
        &entity.id,
        RegistrationType::Vat,
        settings.get("vatNumber"),
    )
    .await?;
    write_registration(
        db,
        &entity.id,
        RegistrationType::CompanyRegistration,
        settings.get("registrationNumber"),
    )
    .await?;
    let entity = le::get_default_legal_entity_row(db)
        .await?
        .unwrap_or(entity);
    Ok(Some(WriteThrough {
        entity,
        created: true,
    }))
}

/// The workspace's name, the default entity's name of last resort; `None`
/// when it cannot be read.
async fn workspace_name(master: &PgPool, org: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>(
        "select name from workspaces where id = $1 or clerk_org_id = $1 limit 1",
    )
    .bind(org)
    .fetch_optional(master)
    .await
    .ok()
    .flatten()
}

/// `overlayDefaultEntity`: the settings row with the legal fields read from
/// the default entity. The entity wins; a field it leaves empty falls back
/// to the row (a save writes both, so a cleared field is empty in both).
pub(crate) async fn overlay_default_entity(
    db: &PgPool,
    row: Value,
) -> Result<Value, LegalEntityError> {
    let Some(entity) = le::get_default_legal_entity_row(db).await? else {
        return Ok(row);
    };
    let Value::Object(mut out) = row else {
        return Ok(row);
    };
    let registrations = le::list_registrations(db, &entity.id).await?;
    let primary = |kind: RegistrationType| {
        registrations
            .iter()
            .find(|r| r.registration_type == kind.as_str() && r.is_primary)
            .or_else(|| {
                registrations
                    .iter()
                    .find(|r| r.registration_type == kind.as_str())
            })
            .map(|r| r.number.clone())
    };
    let from_row = |key: &str| out.get(key).cloned().unwrap_or(Value::Null);
    // `blank(fromEntity) ?? fromRow`.
    let pick = |from_entity: Option<&Value>, key: &str| {
        blank(from_entity).map_or_else(|| from_row(key), Value::String)
    };
    // Registrations are stored normalised; keep the member's own spelling
    // (spaces, dots, case) while it is still the same number.
    let pick_number = |kind: RegistrationType, key: &str| {
        let row_value = from_row(key);
        let from_entity = blank_str(primary(kind).as_deref());
        if let (Some(entity_number), Some(row_number)) = (
            &from_entity,
            row_value.as_str().filter(|text| !text.is_empty()),
        ) && normalize_registration_number(kind, row_number)
            == normalize_registration_number(kind, entity_number)
        {
            return row_value;
        }
        from_entity.map_or(row_value, Value::String)
    };
    let address = object(Some(&entity.address));
    let contact = object(Some(&entity.contact));
    let person = object(contact.get("contactPerson"));
    let branding = object(Some(&entity.branding));
    // `address.country ?? entity.jurisdictionCode`.
    let jurisdiction = Value::String(entity.jurisdiction_code.clone());
    let country = match address.get("country") {
        None | Some(Value::Null) => Some(&jurisdiction),
        Some(value) => Some(value),
    };
    let legal_name = entity.legal_name.clone().map(Value::String);
    let dba = entity.dba.clone().map(Value::String);
    let fields = [
        ("legalName", pick(legal_name.as_ref(), "legalName")),
        ("tradingName", pick(dba.as_ref(), "tradingName")),
        (
            "contactFirstName",
            pick(person.get("firstName"), "contactFirstName"),
        ),
        (
            "contactLastName",
            pick(person.get("lastName"), "contactLastName"),
        ),
        ("email", pick(contact.get("email"), "email")),
        ("phone", pick(contact.get("phone"), "phone")),
        ("websiteUrl", pick(contact.get("website"), "websiteUrl")),
        ("addressLine1", pick(address.get("line1"), "addressLine1")),
        ("addressLine2", pick(address.get("line2"), "addressLine2")),
        ("city", pick(address.get("city"), "city")),
        ("state", pick(address.get("state"), "state")),
        ("postalCode", pick(address.get("postalCode"), "postalCode")),
        ("country", pick(country, "country")),
        ("vatNumber", pick_number(RegistrationType::Vat, "vatNumber")),
        (
            "registrationNumber",
            pick_number(RegistrationType::CompanyRegistration, "registrationNumber"),
        ),
        ("logoUrl", pick(branding.get("logoUrl"), "logoUrl")),
        (
            "primaryColor",
            pick(branding.get("primaryColor"), "primaryColor"),
        ),
        (
            "accentColor",
            pick(branding.get("accentColor"), "accentColor"),
        ),
    ];
    for (key, value) in fields {
        out.insert(key.to_owned(), value);
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn data(value: &Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    fn entity(address: Value, contact: Value, branding: Value) -> EntityRow {
        EntityRow {
            id: "ent_1".into(),
            name: "Acme".into(),
            legal_name: None,
            dba: None,
            entity_type: None,
            jurisdiction_code: "NL".into(),
            base_currency: "EUR".into(),
            locale: "nl-NL".into(),
            timezone: None,
            address,
            contact,
            branding,
            tax_identifiers: Value::Null,
            fiscal_year_start: Some(1),
            fiscal_year_config: Value::Null,
            tax_classification: None,
            is_default: Some(true),
            is_active: Some(true),
            access_restricted: false,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
            deleted_at: None,
            row: Value::Null,
        }
    }

    #[test]
    fn country_codes_normalise_like_normalize_country_code() {
        assert_eq!(normalize_country_code(Some(" nl ")).as_deref(), Some("NL"));
        assert_eq!(normalize_country_code(Some("xx")), None);
        assert_eq!(normalize_country_code(Some("Netherlands")), None);
        assert_eq!(normalize_country_code(None), None);
    }

    #[test]
    fn a_save_without_legal_fields_touches_nothing() {
        assert!(!touches_legal_fields(&data(
            &json!({ "timezone": "Europe/Amsterdam", "theme": "dark" })
        )));
        assert!(touches_legal_fields(&data(&json!({ "phone": null }))));
        let existing = entity(Value::Null, Value::Null, Value::Null);
        assert!(entity_patch(&data(&json!({ "theme": "dark" })), &existing).is_none());
    }

    #[test]
    fn the_patch_merges_over_the_entity_and_drops_cleared_fields() {
        let existing = entity(
            json!({ "line1": "A 1", "city": "Amsterdam" }),
            json!({ "email": "a@x.nl", "phone": "1", "contactPerson": { "firstName": "Ada" } }),
            json!({ "logoUrl": "https://x/l.png", "footerText": "keep" }),
        );
        let patch = entity_patch(
            &data(&json!({
                "city": " Utrecht ",
                "country": "Netherlands",
                "phone": null,
                "contactLastName": "Lovelace",
                "accentColor": "",
                "legalName": "  ",
            })),
            &existing,
        )
        .expect("touched");
        assert_eq!(
            patch.address,
            Field::Set(json!({ "line1": "A 1", "city": "Utrecht", "country": "Ne" }))
        );
        assert_eq!(patch.jurisdiction_code, None);
        assert_eq!(
            patch.contact,
            Field::Set(json!({
                "email": "a@x.nl",
                "contactPerson": { "firstName": "Ada", "lastName": "Lovelace" },
            }))
        );
        assert_eq!(
            patch.branding,
            Field::Set(json!({ "logoUrl": "https://x/l.png", "footerText": "keep" }))
        );
        assert_eq!(patch.legal_name, Field::Null);
        assert!(patch.dba.is_absent());

        let iso = entity_patch(&data(&json!({ "country": "be" })), &existing).expect("touched");
        assert_eq!(iso.jurisdiction_code.as_deref(), Some("BE"));
    }

    #[test]
    fn a_new_entity_takes_the_workspace_currency_else_the_countrys() {
        let row = data(&json!({
            "legalName": "Fresh Ltd",
            "tradingName": null,
            "country": "GB",
            "currency": null,
            "city": "London",
            "email": "",
        }));
        let input = create_input_from_settings(&row, None).expect("created");
        assert_eq!(
            (input.name.as_str(), input.base_currency.as_str()),
            ("Fresh Ltd", "GBP")
        );
        assert_eq!(
            input.address,
            Field::Set(json!({ "city": "London", "country": "GB" }))
        );
        assert!(input.contact.is_absent());
        assert_eq!(input.dba, Field::Null);

        let usd = data(&json!({ "country": "US", "currency": " usd " }));
        let input = create_input_from_settings(&usd, Some("Acme Workspace")).expect("created");
        assert_eq!(
            (input.name.as_str(), input.base_currency.as_str()),
            ("Acme Workspace", "USD")
        );
        assert!(create_input_from_settings(&usd, None).is_none());
        let unknown = data(&json!({ "country": "Netherlands", "legalName": "X" }));
        assert!(create_input_from_settings(&unknown, None).is_none());
        let no_currency = data(&json!({ "country": "JP", "legalName": "X" }));
        assert!(create_input_from_settings(&no_currency, None).is_none());
    }
}
