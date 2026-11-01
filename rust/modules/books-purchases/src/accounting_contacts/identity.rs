//! The CRM identity a contact wraps: a company or a person, created, linked
//! or updated through `weldsuite-crm-domain` (books-api writes them through
//! `@weldsuite/crm-domain`), and a company's contact person (its billing
//! contact). Errors are the route's `ContactIdentityError` and the CRM's.

use serde_json::{Map, Value, json};
use weldsuite_books_domain::contacts::{clear_billing_contact, set_billing_contact};
use weldsuite_books_domain::http::{BooksState, Caller};
use weldsuite_books_domain::jurisdictions::js_trim;
use weldsuite_books_domain::vendor_tax::VendorTaxError;
use weldsuite_catalogs::entity_events::{
    COMPANY_CREATED, COMPANY_UPDATED, CONTACT_LINK_CREATED, PERSON_CREATED, PERSON_UPDATED,
};
use weldsuite_crm_domain::DomainError;
use weldsuite_crm_domain::companies::{create_company, update_company};
use weldsuite_crm_domain::people::{create_person_with, update_person};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::Field;

use super::body::{ContactPayload, ContactPersonInput};

/// Why a contact write stopped.
#[derive(Debug)]
pub(crate) enum ContactError {
    /// `ContactIdentityError`: 409 or 400 with the message and details.
    Identity {
        conflict: bool,
        message: String,
        details: Option<Value>,
    },
    /// `PersonDuplicateEmailError` reaching the route's catch.
    DuplicateEmail(String),
    Tax(VendorTaxError),
    Failed(String),
}

impl From<sqlx::Error> for ContactError {
    fn from(error: sqlx::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<DomainError> for ContactError {
    fn from(error: DomainError) -> Self {
        match error {
            DomainError::DuplicateEmail {
                existing_person_id, ..
            } => Self::DuplicateEmail(existing_person_id),
            other => Self::Failed(other.message()),
        }
    }
}

impl From<VendorTaxError> for ContactError {
    fn from(error: VendorTaxError) -> Self {
        Self::Tax(error)
    }
}

pub(crate) fn bad_request(message: impl Into<String>, details: Option<Value>) -> ContactError {
    ContactError::Identity {
        conflict: false,
        message: message.into(),
        details,
    }
}

fn conflict(message: impl Into<String>, details: Value) -> ContactError {
    ContactError::Identity {
        conflict: true,
        message: message.into(),
        details: Some(details),
    }
}

/// `IdentityLink`: what the party stores about its identity.
#[derive(Debug, Clone)]
pub(crate) struct IdentityLink {
    pub kind: &'static str,
    pub company_id: Option<String>,
    pub person_id: Option<String>,
    pub display_name: Value,
}

impl IdentityLink {
    /// `...(link ?? {})` on the party.
    pub(crate) fn columns(&self) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("kind".into(), json!(self.kind));
        out.insert("companyId".into(), json!(self.company_id));
        out.insert("personId".into(), json!(self.person_id));
        out.insert("displayName".into(), self.display_name.clone());
        out
    }
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

fn truthy(value: Option<&str>) -> bool {
    value.is_some_and(|v| !v.is_empty())
}

/// `personPhone(person)`.
pub(crate) fn person_phone(person: &Value) -> Option<String> {
    [text(person, "directPhone"), text(person, "mobilePhone")]
        .into_iter()
        .flatten()
        .find(|v| !v.is_empty())
        .map(str::to_owned)
}

/// `publishIdentityEvent(c, kind, action, row)`.
fn publish_identity(
    caller: &Caller,
    state: &BooksState,
    company: bool,
    created: bool,
    row: &Value,
) {
    let id = text(row, "id").unwrap_or_default();
    let pick = |keys: &[&str]| -> Value {
        let mut data = Map::new();
        for key in keys {
            data.insert(
                (*key).to_owned(),
                row.get(*key).cloned().unwrap_or(Value::Null),
            );
        }
        Value::Object(data)
    };
    if company {
        let data = pick(&[
            "id", "name", "email", "phone", "website", "industry", "status",
        ]);
        let event = if created {
            COMPANY_CREATED
        } else {
            COMPANY_UPDATED
        };
        caller.publish(state, event, id, data);
    } else {
        let data = pick(&[
            "id",
            "firstName",
            "lastName",
            "fullName",
            "displayName",
            "email",
            "title",
        ]);
        let event = if created {
            PERSON_CREATED
        } else {
            PERSON_UPDATED
        };
        caller.publish(state, event, id, data);
    }
}

/// `touchesIdentity(data)`.
pub(crate) fn touches_identity(data: &ContactPayload) -> bool {
    [
        "fullName",
        "companyName",
        "firstName",
        "lastName",
        "email",
        "phone",
        "vatNumber",
        "registrationNumber",
        "notes",
        "tags",
    ]
    .iter()
    .any(|key| data.value_of(key).is_some())
}

fn set_text(field: &Field<String>) -> Option<&str> {
    field.as_set().map(String::as_str).filter(|v| !v.is_empty())
}

/// `resolveIdentityKind(data)`.
fn resolve_identity_kind(data: &ContactPayload) -> &'static str {
    match data.kind.as_deref() {
        Some("company") => return "company",
        Some("person") => return "person",
        _ => {}
    }
    if data.company_id.is_some() {
        return "company";
    }
    if data.person_id.is_some() {
        return "person";
    }
    if truthy(data.company_name.as_deref())
        || set_text(&data.vat_number).is_some()
        || set_text(&data.registration_number).is_some()
    {
        return "company";
    }
    if truthy(data.first_name.as_deref()) || truthy(data.last_name.as_deref()) {
        return "person";
    }
    "company"
}

const PERSON_TAX_ID_MESSAGE: &str = "This contact is a person, and VAT and registration numbers are stored on a company. Create the contact as a company to record them.";

/// `assertFitsKind(kind, data)`.
fn assert_fits_kind(kind: &str, data: &ContactPayload) -> Result<(), ContactError> {
    if kind == "company" {
        if truthy(data.person_id.as_deref()) {
            return Err(bad_request(
                "personId: a company contact links a CRM company (companyId), not a person.",
                None,
            ));
        }
        return Ok(());
    }
    if truthy(data.company_id.as_deref()) {
        return Err(bad_request(
            "companyId: a person contact links a CRM person (personId), not a company.",
            None,
        ));
    }
    if set_text(&data.vat_number).is_some() || set_text(&data.registration_number).is_some() {
        return Err(bad_request(PERSON_TAX_ID_MESSAGE, None));
    }
    if matches!(data.contact_person, Field::Set(_)) {
        return Err(bad_request(
            "contactPerson: only a company contact has a contact person.",
            None,
        ));
    }
    Ok(())
}

/// `splitFullName(fullName)`.
fn split_full_name(full_name: Option<&str>) -> (Option<String>, Option<String>) {
    let parts: Vec<&str> = full_name
        .map(js_trim)
        .unwrap_or_default()
        .split(weldsuite_books_domain::jurisdictions::is_js_space)
        .filter(|p| !p.is_empty())
        .collect();
    match parts.split_first() {
        None => (None, None),
        Some((first, rest)) => (
            Some((*first).to_owned()),
            (!rest.is_empty()).then(|| rest.join(" ")),
        ),
    }
}

/// `personNames(data)`.
pub(crate) fn person_names(data: &ContactPayload) -> (Option<String>, Option<String>) {
    let full_name = data.full_name.as_deref().map(js_trim);
    if data.first_name.is_none() && data.last_name.is_none() {
        return split_full_name(full_name);
    }
    let mut first = data.first_name.clone();
    let mut last = data.last_name.clone();
    if let Some(full) = full_name.filter(|f| !f.is_empty()) {
        if first.is_none()
            && let Some(l) = last.as_deref().filter(|l| !l.is_empty())
            && full.ends_with(l)
        {
            first =
                Some(js_trim(&full[..full.len() - l.len()]).to_owned()).filter(|f| !f.is_empty());
        }
        if last.is_none()
            && let Some(f) = first.as_deref().filter(|f| !f.is_empty())
            && full.starts_with(f)
        {
            last = Some(js_trim(&full[f.len()..]).to_owned()).filter(|l| !l.is_empty());
        }
    }
    (first, last)
}

/// `clearable(value)`: `''` for a cleared text column.
fn clearable(field: &Field<String>) -> Option<Value> {
    match field {
        Field::Absent => None,
        Field::Null => Some(json!("")),
        Field::Set(value) => Some(json!(value)),
    }
}

fn insert(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), value);
    }
}

/// `companyNameFields(data, existing)`.
fn company_name_fields(data: &ContactPayload, existing: Option<&Value>) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(company_name) = data.company_name.as_deref().filter(|n| !n.is_empty()) {
        out.insert("name".into(), json!(company_name));
        if let Some(full) = &data.full_name {
            out.insert(
                "tradingName".into(),
                json!(if full == company_name {
                    ""
                } else {
                    full.as_str()
                }),
            );
        }
        return out;
    }
    let Some(full) = &data.full_name else {
        return out;
    };
    if let Some(existing) = existing
        && truthy(text(existing, "tradingName"))
    {
        let trading = if Some(full.as_str()) == text(existing, "name") {
            ""
        } else {
            full.as_str()
        };
        out.insert("tradingName".into(), json!(trading));
        return out;
    }
    out.insert("name".into(), json!(full));
    out
}

fn tags_value(data: &ContactPayload) -> Option<Value> {
    data.tags.clone().map(|tags| json!(tags))
}

/// `companyIdentityInput(data, existing)` with `undefined` keys left out.
fn company_identity_input(data: &ContactPayload, existing: Option<&Value>) -> Map<String, Value> {
    let mut out = company_name_fields(data, existing);
    insert(&mut out, "email", clearable(&data.email));
    insert(&mut out, "phone", clearable(&data.phone));
    insert(&mut out, "vatNumber", clearable(&data.vat_number));
    insert(
        &mut out,
        "registrationNumber",
        clearable(&data.registration_number),
    );
    insert(&mut out, "notes", clearable(&data.notes));
    insert(&mut out, "tags", tags_value(data));
    out
}

/// `personIdentityInput(data)` with `undefined` keys left out.
fn person_identity_input(data: &ContactPayload) -> Map<String, Value> {
    let (first, last) = person_names(data);
    let mut out = Map::new();
    insert(&mut out, "firstName", first.map(Value::String));
    insert(&mut out, "lastName", last.map(Value::String));
    insert(
        &mut out,
        "fullName",
        data.full_name.clone().map(Value::String),
    );
    insert(&mut out, "email", clearable(&data.email));
    insert(&mut out, "directPhone", clearable(&data.phone));
    insert(&mut out, "notes", clearable(&data.notes));
    insert(&mut out, "tags", tags_value(data));
    out
}

/// `presentOnly(input)`: without blank strings.
fn present_only(mut input: Map<String, Value>) -> Map<String, Value> {
    input.retain(|_, v| v.as_str() != Some(""));
    input
}

/// `ownerIdFor(c, db)`: the caller when they are a live workspace member.
async fn owner_id_for(caller: &Caller) -> Result<Option<String>, sqlx::Error> {
    let Some(user) = caller.user() else {
        return Ok(None);
    };
    let member: Option<String> = sqlx::query_scalar(
        "select user_id from workspace_members where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user)
    .fetch_optional(&caller.db)
    .await?;
    Ok(member)
}

async fn live_row(db: &PgPool, table: &str, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let sql = match table {
        "companies" => concat!(
            "select ",
            weldsuite_books_domain::books_row!(companies),
            " from companies t where t.id = $1 and t.deleted_at is null limit 1"
        ),
        _ => concat!(
            "select ",
            weldsuite_books_domain::books_row!(people),
            " from people t where t.id = $1 and t.deleted_at is null limit 1"
        ),
    };
    let row: Option<Value> = sqlx::query_scalar(sql).bind(id).fetch_optional(db).await?;
    let table = if table == "companies" {
        weldsuite_books_domain::tables::COMPANIES
    } else {
        weldsuite_books_domain::tables::PEOPLE
    };
    Ok(row.map(|row| table.js(row)))
}

/// `assertNotWrapped(db, kind, id)` / `assertPersonNotWrapped`: a CRM
/// record is the identity of one contact at most.
async fn wrapped_by(
    db: &PgPool,
    company: bool,
    identity_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    let sql = if company {
        "select id from parties where company_id = $1 and deleted_at is null limit 1"
    } else {
        "select id from parties where person_id = $1 and deleted_at is null limit 1"
    };
    sqlx::query_scalar(sql)
        .bind(identity_id)
        .fetch_optional(db)
        .await
}

async fn assert_not_wrapped(
    db: &PgPool,
    company: bool,
    identity_id: &str,
) -> Result<(), ContactError> {
    if let Some(contact_id) = wrapped_by(db, company, identity_id).await? {
        let message = if company {
            "This company is already a customer or supplier."
        } else {
            "This person is already a customer or supplier."
        };
        return Err(conflict(message, json!({ "contactId": contact_id })));
    }
    Ok(())
}

async fn assert_person_not_wrapped(db: &PgPool, person_id: &str) -> Result<(), ContactError> {
    if let Some(contact_id) = wrapped_by(db, false, person_id).await? {
        return Err(conflict(
            "A contact with this email address already exists.",
            json!({ "contactId": contact_id }),
        ));
    }
    Ok(())
}

fn display_of(row: &Value) -> Value {
    row.get("displayName").cloned().unwrap_or(Value::Null)
}

/// `linkCompany(c, db, companyId, data)`.
async fn link_company(
    caller: &Caller,
    state: &BooksState,
    company_id: &str,
    data: &ContactPayload,
) -> Result<IdentityLink, ContactError> {
    let db = &caller.db;
    let Some(existing) = live_row(db, "companies", company_id).await? else {
        return Err(bad_request(
            format!("companyId: company {company_id} not found"),
            None,
        ));
    };
    assert_not_wrapped(db, true, company_id).await?;
    let mut company = existing.clone();
    if touches_identity(data) {
        let input = company_identity_input(data, Some(&existing));
        if let Some((row, changes)) = update_company(db, company_id, &input, None, None).await? {
            company = row;
            if changes.is_some() {
                publish_identity(caller, state, true, false, &company);
            }
        }
    }
    Ok(IdentityLink {
        kind: "company",
        company_id: Some(company_id.to_owned()),
        person_id: None,
        display_name: display_of(&company),
    })
}

/// `linkPerson(c, db, personId, data)`.
async fn link_person(
    caller: &Caller,
    state: &BooksState,
    person_id: &str,
    data: &ContactPayload,
) -> Result<IdentityLink, ContactError> {
    let db = &caller.db;
    let Some(existing) = live_row(db, "people", person_id).await? else {
        return Err(bad_request(
            format!("personId: person {person_id} not found"),
            None,
        ));
    };
    assert_not_wrapped(db, false, person_id).await?;
    let mut input = person_identity_input(data);
    if existing.get("inCrm") != Some(&Value::Bool(true)) {
        input.insert("inCrm".into(), json!(true));
    }
    let result = update_person(db, person_id, &input, None).await?;
    let person = result.as_ref().map_or(&existing, |(row, _)| row).clone();
    if result
        .as_ref()
        .is_some_and(|(_, changes)| changes.is_some())
    {
        publish_identity(caller, state, false, false, &person);
    }
    Ok(IdentityLink {
        kind: "person",
        company_id: None,
        person_id: Some(person_id.to_owned()),
        display_name: display_of(&person),
    })
}

/// `createIdentity(c, db, data)`: create the identity, or link the one the
/// payload names.
pub(crate) async fn create_identity(
    caller: &Caller,
    state: &BooksState,
    data: &ContactPayload,
) -> Result<IdentityLink, ContactError> {
    let kind = resolve_identity_kind(data);
    assert_fits_kind(kind, data)?;
    if kind == "company"
        && let Some(id) = data.company_id.as_deref().filter(|id| !id.is_empty())
    {
        return link_company(caller, state, id, data).await;
    }
    if kind == "person"
        && let Some(id) = data.person_id.as_deref().filter(|id| !id.is_empty())
    {
        return link_person(caller, state, id, data).await;
    }
    let owner = owner_id_for(caller).await?;
    // Seeds the CRM primary address.
    let primary =
        weldsuite_books_domain::address::normalize_postal_address(data.billing_address.as_set());
    if kind == "company" {
        let mut input = present_only(company_identity_input(data, None));
        if !input.contains_key("name") {
            input.insert("name".into(), json!(data.full_name));
        }
        input.insert("status".into(), json!("active"));
        insert(&mut input, "primaryAddress", primary);
        insert(&mut input, "ownerId", owner.map(Value::String));
        let company = create_company(&caller.db, &input, None).await?;
        publish_identity(caller, state, true, true, &company);
        return Ok(IdentityLink {
            kind: "company",
            company_id: text(&company, "id").map(str::to_owned),
            person_id: None,
            display_name: display_of(&company),
        });
    }
    create_person_identity(caller, state, data, primary, owner).await
}

async fn create_person_identity(
    caller: &Caller,
    state: &BooksState,
    data: &ContactPayload,
    primary: Option<Value>,
    owner: Option<String>,
) -> Result<IdentityLink, ContactError> {
    let db = &caller.db;
    let input = present_only(person_identity_input(data));
    if let Some(link_id) = data.link_person_id.as_deref().filter(|id| !id.is_empty()) {
        return link_existing_person(caller, state, link_id, &input, primary).await;
    }
    let mut create = input.clone();
    insert(&mut create, "primaryAddress", primary.clone());
    insert(&mut create, "ownerId", owner.map(Value::String));
    let separate = data.create_separate_person == Some(true);
    match create_person_with(db, &create, separate).await {
        Ok((person, _)) => {
            publish_identity(caller, state, false, true, &person);
            Ok(IdentityLink {
                kind: "person",
                company_id: None,
                person_id: text(&person, "id").map(str::to_owned),
                display_name: display_of(&person),
            })
        }
        Err(DomainError::DuplicateEmail {
            existing_person_id, ..
        }) => {
            let existing: Option<Value> = sqlx::query_scalar(concat!(
                "select ",
                weldsuite_books_domain::books_row!(people),
                " from people t where t.id = $1 limit 1"
            ))
            .bind(&existing_person_id)
            .fetch_optional(db)
            .await?;
            let Some(existing) = existing.map(|row| weldsuite_books_domain::tables::PEOPLE.js(row))
            else {
                return Err(ContactError::DuplicateEmail(existing_person_id));
            };
            let existing_id = text(&existing, "id").unwrap_or_default().to_owned();
            assert_person_not_wrapped(db, &existing_id).await?;
            if is_same_person(&existing, &person_names(data), data.full_name.as_deref()) {
                return link_existing_person(caller, state, &existing_id, &input, primary).await;
            }
            let name = [text(&existing, "displayName"), text(&existing, "fullName")]
                .into_iter()
                .flatten()
                .find(|n| !n.is_empty())
                .unwrap_or_default()
                .to_owned();
            let suffix = if name.is_empty() {
                String::new()
            } else {
                format!(": {name}")
            };
            Err(conflict(
                format!(
                    "A person with this email already exists{suffix}. Link the contact to them or create a separate person."
                ),
                json!({
                    "code": "PERSON_EMAIL_EXISTS",
                    "existingPerson": { "id": existing_id, "name": name, "email": existing.get("email").cloned().unwrap_or(Value::Null) },
                }),
            ))
        }
        Err(other) => Err(other.into()),
    }
}

/// `normalizeName(value)`.
fn normalize_name(value: Option<&str>) -> String {
    js_trim(value.unwrap_or_default())
        .split(weldsuite_books_domain::jurisdictions::is_js_space)
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// `isSamePerson(existing, typed, typedFullName)`.
fn is_same_person(
    existing: &Value,
    typed: &(Option<String>, Option<String>),
    typed_full_name: Option<&str>,
) -> bool {
    let joined = |a: Option<&str>, b: Option<&str>| -> String {
        [a, b]
            .into_iter()
            .flatten()
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let own = {
        let names = normalize_name(Some(&joined(
            text(existing, "firstName"),
            text(existing, "lastName"),
        )));
        if names.is_empty() {
            normalize_name(text(existing, "fullName"))
        } else {
            names
        }
    };
    let display = normalize_name(text(existing, "displayName"));
    if own.is_empty() && (display.is_empty() || display == normalize_name(text(existing, "email")))
    {
        return true;
    }
    let known: Vec<String> = [own, display, normalize_name(text(existing, "fullName"))]
        .into_iter()
        .filter(|n| !n.is_empty())
        .collect();
    let typed_names = [
        normalize_name(Some(&joined(typed.0.as_deref(), typed.1.as_deref()))),
        normalize_name(typed_full_name),
    ];
    typed_names
        .iter()
        .filter(|n| !n.is_empty())
        .any(|name| known.contains(name))
}

async fn link_existing_person(
    caller: &Caller,
    state: &BooksState,
    person_id: &str,
    input: &Map<String, Value>,
    primary: Option<Value>,
) -> Result<IdentityLink, ContactError> {
    assert_person_not_wrapped(&caller.db, person_id).await?;
    let mut candidates = input.clone();
    insert(&mut candidates, "primaryAddress", primary);
    let person = fill_person_gaps(caller, state, person_id, &candidates).await?;
    Ok(IdentityLink {
        kind: "person",
        company_id: None,
        person_id: Some(person_id.to_owned()),
        display_name: display_of(&person),
    })
}

/// `fillPersonGaps(c, db, personId, candidates)`.
async fn fill_person_gaps(
    caller: &Caller,
    state: &BooksState,
    person_id: &str,
    candidates: &Map<String, Value>,
) -> Result<Value, ContactError> {
    let db = &caller.db;
    let existing: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(people),
        " from people t where t.id = $1 limit 1"
    ))
    .bind(person_id)
    .fetch_optional(db)
    .await?;
    let existing = existing.map(|row| weldsuite_books_domain::tables::PEOPLE.js(row));
    let Some(existing) = existing.filter(|row| row.get("deletedAt").is_none_or(Value::is_null))
    else {
        return Err(bad_request(
            "The person to link to no longer exists.",
            Some(json!({ "code": "PERSON_NOT_FOUND" })),
        ));
    };
    let mut fill = Map::new();
    fill.insert("inCrm".into(), json!(true));
    for (key, value) in candidates {
        if value.as_str() == Some("") || key == "email" {
            continue;
        }
        let current = existing.get(key);
        let empty = match current {
            None | Some(Value::Null) => true,
            Some(Value::String(s)) => s.is_empty(),
            Some(Value::Array(items)) => items.is_empty(),
            Some(_) => false,
        };
        if empty {
            fill.insert(key.clone(), value.clone());
        }
    }
    let result = update_person(db, person_id, &fill, None).await?;
    let person = result.map_or(existing, |(row, _)| row);
    publish_identity(caller, state, false, false, &person);
    Ok(person)
}

// ── contact person ──────────────────────────────────────────────────────────

/// `contactPersonIdentityInput(input)` with `undefined` keys left out.
fn contact_person_fields(input: &ContactPersonInput) -> Map<String, Value> {
    let mut out = Map::new();
    insert(&mut out, "firstName", clearable(&input.first_name));
    insert(&mut out, "lastName", clearable(&input.last_name));
    insert(&mut out, "email", clearable(&input.email));
    insert(&mut out, "directPhone", clearable(&input.phone));
    out
}

/// `publishLinkEvents(c, companyId, personIds, created)`.
fn publish_link_events(
    caller: &Caller,
    state: &BooksState,
    company_id: &str,
    person_ids: &[String],
    created: Option<(&str, &str)>,
) {
    if let Some((link_id, person_id)) = created {
        caller.publish(
            state,
            CONTACT_LINK_CREATED,
            link_id,
            json!({ "id": link_id, "personId": person_id, "companyId": company_id }),
        );
    }
    let mut seen: Vec<&String> = Vec::new();
    for person_id in person_ids {
        if seen.contains(&person_id) {
            continue;
        }
        seen.push(person_id);
        caller.publish(state, PERSON_UPDATED, person_id, json!({ "id": person_id }));
    }
    if created.is_some() || !person_ids.is_empty() {
        caller.publish(
            state,
            COMPANY_UPDATED,
            company_id,
            json!({ "id": company_id }),
        );
    }
}

async fn update_chosen_contact_person(
    caller: &Caller,
    state: &BooksState,
    person_id: &str,
    fields: &Map<String, Value>,
) -> Result<Value, ContactError> {
    let db = &caller.db;
    let Some(existing) = live_row(db, "people", person_id).await? else {
        return Err(bad_request(
            format!("contactPerson.personId: person {person_id} not found"),
            None,
        ));
    };
    let current = |key: &str| -> String {
        match key {
            "directPhone" => person_phone(&existing).unwrap_or_default(),
            _ => text(&existing, key).unwrap_or_default().to_owned(),
        }
    };
    let mut changes = Map::new();
    if existing.get("inCrm") != Some(&Value::Bool(true)) {
        changes.insert("inCrm".into(), json!(true));
    }
    for (key, value) in fields {
        if value.as_str() != Some(current(key).as_str()) {
            changes.insert(key.clone(), value.clone());
        }
    }
    if changes.is_empty() {
        return Ok(existing);
    }
    let result = update_person(db, person_id, &changes, None).await?;
    let person = result.as_ref().map_or(&existing, |(row, _)| row).clone();
    if result
        .as_ref()
        .is_some_and(|(_, changes)| changes.is_some())
    {
        publish_identity(caller, state, false, false, &person);
    }
    Ok(person)
}

async fn create_contact_person(
    caller: &Caller,
    state: &BooksState,
    fields: &Map<String, Value>,
) -> Result<Option<Value>, ContactError> {
    let present = present_only(fields.clone());
    let has = |key: &str| {
        present
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty())
    };
    if !has("firstName") && !has("lastName") && !has("email") {
        return Ok(None);
    }
    let mut input = present.clone();
    insert(
        &mut input,
        "ownerId",
        owner_id_for(caller).await?.map(Value::String),
    );
    match create_person_with(&caller.db, &input, false).await {
        Ok((person, _)) => {
            publish_identity(caller, state, false, true, &person);
            Ok(Some(person))
        }
        Err(DomainError::DuplicateEmail {
            existing_person_id, ..
        }) => Ok(Some(
            fill_person_gaps(caller, state, &existing_person_id, &present).await?,
        )),
        Err(other) => Err(other.into()),
    }
}

/// `syncContactPerson(c, db, companyId, input)`.
pub(crate) async fn sync_contact_person(
    caller: &Caller,
    state: &BooksState,
    company_id: &str,
    input: &Field<ContactPersonInput>,
) -> Result<(), ContactError> {
    let input = match input {
        Field::Absent => return Ok(()),
        Field::Null => {
            let demoted = clear_billing_contact(&caller.db, company_id).await?;
            publish_link_events(caller, state, company_id, &demoted, None);
            return Ok(());
        }
        Field::Set(input) => input,
    };
    let fields = contact_person_fields(input);
    let person = match input.person_id.as_deref() {
        Some(id) if !id.is_empty() => {
            Some(update_chosen_contact_person(caller, state, id, &fields).await?)
        }
        _ => create_contact_person(caller, state, &fields).await?,
    };
    let Some(person) = person else {
        return Ok(());
    };
    let person_id = text(&person, "id").unwrap_or_default().to_owned();
    let link = set_billing_contact(&caller.db, company_id, &person_id).await?;
    if !link.changed {
        return Ok(());
    }
    let mut people = vec![person_id.clone()];
    people.extend(link.demoted_person_ids.iter().cloned());
    let created = link
        .created
        .then_some((link.link_id.as_str(), person_id.as_str()));
    publish_link_events(caller, state, company_id, &people, created);
    Ok(())
}

// ── update ──────────────────────────────────────────────────────────────────

async fn update_wrapped_company(
    caller: &Caller,
    state: &BooksState,
    company_id: &str,
    data: &ContactPayload,
) -> Result<Option<IdentityLink>, ContactError> {
    let db = &caller.db;
    let Some(existing) = live_row(db, "companies", company_id).await? else {
        return Ok(None);
    };
    let input = company_identity_input(data, Some(&existing));
    let Some((row, changes)) = update_company(db, company_id, &input, None, None).await? else {
        return Ok(None);
    };
    if changes.is_some() {
        publish_identity(caller, state, true, false, &row);
    }
    Ok(Some(IdentityLink {
        kind: "company",
        company_id: text(&row, "id").map(str::to_owned),
        person_id: None,
        display_name: display_of(&row),
    }))
}

async fn update_wrapped_person(
    caller: &Caller,
    state: &BooksState,
    person_id: &str,
    data: &ContactPayload,
) -> Result<Option<IdentityLink>, ContactError> {
    if set_text(&data.vat_number).is_some() || set_text(&data.registration_number).is_some() {
        return Err(bad_request(PERSON_TAX_ID_MESSAGE, None));
    }
    let input = person_identity_input(data);
    let result = match update_person(&caller.db, person_id, &input, None).await {
        Ok(result) => result,
        Err(DomainError::DuplicateEmail {
            existing_person_id, ..
        }) => {
            return Err(conflict(
                "Another person in the CRM already has this email address.",
                json!({ "code": "PERSON_EMAIL_EXISTS", "existingPersonId": existing_person_id }),
            ));
        }
        Err(other) => return Err(other.into()),
    };
    let Some((row, changes)) = result else {
        return Ok(None);
    };
    if changes.is_some() {
        publish_identity(caller, state, false, false, &row);
    }
    Ok(Some(IdentityLink {
        kind: "person",
        company_id: None,
        person_id: text(&row, "id").map(str::to_owned),
        display_name: display_of(&row),
    }))
}

/// `assertKindUnchanged(currentKind, contact, data)`.
fn assert_kind_unchanged(
    current: &str,
    contact: &Value,
    data: &ContactPayload,
) -> Result<(), ContactError> {
    if let Some(kind) = data.kind.as_deref().filter(|k| !k.is_empty())
        && kind != current
    {
        return Err(bad_request(
            format!("kind: this contact is a {current}, and a contact's type can't be changed."),
            None,
        ));
    }
    let (linked, asked) = if current == "company" {
        (text(contact, "companyId"), data.company_id.as_deref())
    } else {
        (text(contact, "personId"), data.person_id.as_deref())
    };
    if let Some(asked) = asked.filter(|a| !a.is_empty())
        && Some(asked) != linked
    {
        return Err(bad_request(
            format!("{current}Id: this contact already wraps another CRM {current}."),
            None,
        ));
    }
    assert_fits_kind(current, data)
}

/// `syncIdentity(c, db, contact, data)`: the link to store on the party,
/// `None` when nothing about the identity changed.
pub(crate) async fn sync_identity(
    caller: &Caller,
    state: &BooksState,
    contact: &Value,
    data: &ContactPayload,
) -> Result<Option<IdentityLink>, ContactError> {
    let current = match text(contact, "kind") {
        Some("company") => Some("company"),
        Some("person") => Some("person"),
        _ => None,
    };
    if let Some(kind) = current {
        assert_kind_unchanged(kind, contact, data)?;
    }
    let wrapped_company = (current == Some("company"))
        .then(|| text(contact, "companyId"))
        .flatten()
        .filter(|id| !id.is_empty());
    let wrapped_person = (current == Some("person"))
        .then(|| text(contact, "personId"))
        .flatten()
        .filter(|id| !id.is_empty());
    if wrapped_company.is_some() || wrapped_person.is_some() {
        if !touches_identity(data) {
            return Ok(None);
        }
        let updated = match (wrapped_company, wrapped_person) {
            (Some(company), _) => update_wrapped_company(caller, state, company, data).await?,
            (_, Some(person)) => update_wrapped_person(caller, state, person, data).await?,
            _ => None,
        };
        if updated.is_some() {
            return Ok(updated);
        }
    }
    // No (live) identity yet: build one from the payload and the party's name.
    let mut fresh = data.clone();
    if let Some(kind) = current {
        fresh.kind = Some(kind.to_owned());
        fresh.company_id = None;
        fresh.person_id = None;
    }
    if fresh.full_name.is_none() {
        fresh.full_name = Some(
            text(contact, "displayName")
                .unwrap_or("Unnamed contact")
                .to_owned(),
        );
    }
    if fresh.billing_address.is_absent() {
        fresh.billing_address = match contact.get("billingAddress") {
            Some(Value::Null) | None => Field::Null,
            Some(stored) => Field::Set(stored.clone()),
        };
    }
    create_identity(caller, state, &fresh).await.map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(full: Option<&str>, first: Option<&str>, last: Option<&str>) -> ContactPayload {
        ContactPayload {
            full_name: full.map(str::to_owned),
            first_name: first.map(str::to_owned),
            last_name: last.map(str::to_owned),
            ..ContactPayload::default()
        }
    }

    #[test]
    fn names_of_a_person_contact() {
        assert_eq!(
            person_names(&payload(Some(" Mary Ann  Smith "), None, None)),
            (Some("Mary".to_owned()), Some("Ann Smith".to_owned()))
        );
        assert_eq!(
            person_names(&payload(Some("Mary Ann Smith"), None, Some("Smith"))),
            (Some("Mary Ann".to_owned()), Some("Smith".to_owned()))
        );
        assert_eq!(
            person_names(&payload(Some("Mary Ann Smith"), Some("Mary"), None)),
            (Some("Mary".to_owned()), Some("Ann Smith".to_owned()))
        );
    }

    #[test]
    fn same_person() {
        let mail_only = json!({ "displayName": "ann@x.test", "email": "ann@x.test" });
        assert!(is_same_person(&mail_only, &(None, None), Some("Anyone")));
        let ann = json!({ "firstName": "Ann", "lastName": "Lee", "displayName": "Ann Lee" });
        assert!(is_same_person(
            &ann,
            &(Some("ann".to_owned()), Some("LEE".to_owned())),
            None
        ));
        assert!(!is_same_person(&ann, &(None, None), Some("Bob Lee")));
    }
}
