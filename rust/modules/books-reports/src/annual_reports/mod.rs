//! `/api/annual-reports`: an entity's jaarrekening for the KvK (the
//! publicatiestukken of a micro or small B.V. or N.V.), built from the
//! ledger, reviewed, and deposited through Digipoort. Rust only: Global has
//! no such route and hides the screen (`annual-reports` in
//! `GLOBAL_UNAVAILABLE_FEATURES`).
//!
//! A report starts as a `draft` with the balance sheet of the year end and
//! of the year before ([`figures`]) and the document details from the
//! entity; the user corrects what needs correcting. Filing checks it
//! ([`issues`]), writes the XBRL ([`xbrl`]) and delivers it over the
//! install's Digipoort connection (`kvk-digipoort`): `submitted`, then
//! `accepted` (status 500) or `rejected` (with the KvK's reason, after which
//! it can be corrected and filed again). Without a connection the XBRL is
//! downloaded and deposited elsewhere, and the report is marked as filed.

#![allow(
    clippy::doc_markdown,
    reason = "the docs name Dutch terms (KvK, jaarrekening, publicatiestukken) as words"
)]

pub(crate) mod figures;
pub(crate) mod xbrl;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, HeaderValue, StatusCode, header};
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, Set};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, no_content, ok, reply, validate,
};
use weldsuite_books_domain::reports_basis::{
    Basis, LedgerFilters, create_ledger, fiscal_year_named,
};
use weldsuite_catalogs::entity_events::{
    ANNUAL_REPORT_CREATED, ANNUAL_REPORT_DELETED, ANNUAL_REPORT_SUBMITTED, ANNUAL_REPORT_UPDATED,
    EventName,
};
use weldsuite_db::{orm, utc_timestamp};
use weldsuite_digipoort::status::{delivered_record, failed_record, iso, next_poll, with_statuses};
use weldsuite_digipoort::{
    Delivery, Digipoort, DigipoortError, Identity, Outcome, assess, profile,
};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, generate_id};
use weldsuite_legal_entities::{EntityRecordGuard, EntityTable};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{annual_reports, entities, legal_entity_registrations};

use self::figures::{Item, Lines, balance_sheet, figures_json, is_empty};
use self::xbrl::{Document, Size, instance, supported_years, taxonomy_for};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("reports:read")))
        .route("/", post(create).route_layer(need("reports:create")))
        .route("/{id}", get(detail).route_layer(need("reports:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("reports:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("reports:delete")),
        )
        .route(
            "/{id}/recalculate",
            post(recalculate).route_layer(need("reports:update")),
        )
        .route(
            "/{id}/xbrl",
            get(download).route_layer(need("reports:read")),
        )
        .route("/{id}/file", post(file).route_layer(need("reports:update")))
        .route(
            "/{id}/mark-filed",
            post(mark_filed).route_layer(need("reports:update")),
        )
        .route(
            "/{id}/filing-status",
            get(status).route_layer(need("reports:read")),
        )
        // A report of an entity the request may not touch answers 404
        // (per-entity access, as every WeldBooks record).
        .route_layer(
            EntityRecordGuard::table(EntityTable::new("annual_reports"), "Annual report").layer(),
        )
        .with_state(state)
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "handed to map_err, which passes the error by value"
)]
fn db_error(error: DbErr) -> Refusal {
    Refusal::Internal(error.to_string())
}

// ── Dates ───────────────────────────────────────────────────────────────────

/// `YYYY-MM-DD` as midnight.
fn parse_day(day: &str) -> Option<PrimitiveDateTime> {
    let bytes = day.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i32 = day.get(..4)?.parse().ok()?;
    let month: u8 = day.get(5..7)?.parse().ok()?;
    let date: u8 = day.get(8..10)?.parse().ok()?;
    let date = Date::from_calendar_date(year, Month::try_from(month).ok()?, date).ok()?;
    Some(PrimitiveDateTime::new(date, Time::MIDNIGHT))
}

fn day_of(at: PrimitiveDateTime) -> String {
    let date = at.date();
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

fn today() -> String {
    day_of(utc_timestamp(OffsetDateTime::now_utc()))
}

fn is_day(text: &str) -> bool {
    parse_day(text).is_some()
}

// ── The entity ──────────────────────────────────────────────────────────────

/// The entity row as the API shapes it.
async fn entity_json(db: &PgPool, id: &str) -> Result<Option<Value>, Refusal> {
    let row = entities::Entity::find_by_id(id.to_owned())
        .filter(entities::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await
        .map_err(db_error)?;
    Ok(row.and_then(|row| serde_json::to_value(row).ok()))
}

fn text<'a>(row: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut value = row;
    for key in path {
        value = value.get(*key)?;
    }
    value.as_str().map(str::trim).filter(|v| !v.is_empty())
}

/// The entity's KvK number: its company registration (the primary Dutch one
/// first), else the legacy `taxIdentifiers.registrationNumber`.
async fn kvk_number_of(db: &PgPool, entity: &Value) -> Result<Option<String>, Refusal> {
    let id = text(entity, &["id"]).unwrap_or_default();
    let mut registrations = legal_entity_registrations::Entity::find()
        .filter(legal_entity_registrations::Column::EntityId.eq(id))
        .filter(legal_entity_registrations::Column::Type.eq("company_registration"))
        .filter(legal_entity_registrations::Column::DeletedAt.is_null())
        .all(&orm(db))
        .await
        .map_err(db_error)?;
    registrations.sort_by_key(|r| (!r.is_primary, r.country.as_deref() != Some("NL")));
    Ok(registrations
        .into_iter()
        .map(|r| r.number)
        .next()
        .or_else(|| text(entity, &["taxIdentifiers", "registrationNumber"]).map(str::to_owned)))
}

/// `LegalEntityLegalForm`'s enumeration value of the B.V. and N.V.
fn legal_form_label(code: &str) -> Option<&'static str> {
    match code {
        "bv" => Some("Besloten vennootschap met beperkte aansprakelijkheid"),
        "nv" => Some("Naamloze vennootschap"),
        _ => None,
    }
}

/// The KvK number as the instance writes it: eight digits, not `00…`.
fn kvk_number(raw: &str) -> Option<String> {
    let digits: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '.')
        .collect();
    (digits.len() == 8 && digits.bytes().all(|b| b.is_ascii_digit()) && !digits.starts_with("00"))
        .then_some(digits)
}

/// A Dutch postal code as `1234AB`.
fn postal_code(raw: &str) -> Option<String> {
    let compact: String = raw
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_uppercase();
    let b = compact.as_bytes();
    (b.len() == 6
        && (b'1'..=b'9').contains(&b[0])
        && b[1..4].iter().all(u8::is_ascii_digit)
        && b[4..].iter().all(u8::is_ascii_uppercase))
    .then_some(compact)
}

fn is_email(raw: &str) -> bool {
    let raw = raw.trim();
    raw.split_once('@').is_some_and(|(local, domain)| {
        !local.is_empty()
            && domain.contains('.')
            && !domain.starts_with('.')
            && !domain.ends_with('.')
    }) && !raw.contains(char::is_whitespace)
}

// ── Disclosures ─────────────────────────────────────────────────────────────

/// What the report states besides the figures (`disclosures`), with the
/// entity's details as the defaults.
#[derive(Debug, Clone, Default, PartialEq)]
struct Disclosures {
    legal_form: Option<String>,
    kvk_number: Option<String>,
    registered_office: Option<String>,
    city: Option<String>,
    postal_code: Option<String>,
    email: Option<String>,
    prepared_on: Option<String>,
    /// `before` (default) or `after` profit appropriation.
    appropriation: String,
    average_employees: Option<f64>,
}

const DISCLOSURE_TEXTS: [&str; 8] = [
    "legalForm",
    "kvkNumber",
    "registeredOffice",
    "city",
    "postalCode",
    "email",
    "preparedOn",
    "appropriation",
];

impl Disclosures {
    fn from_json(value: Option<&Value>) -> Self {
        let get = |key: &str| {
            value
                .and_then(|v| v.get(key))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        };
        Self {
            legal_form: get("legalForm"),
            kvk_number: get("kvkNumber"),
            registered_office: get("registeredOffice"),
            city: get("city"),
            postal_code: get("postalCode"),
            email: get("email"),
            prepared_on: get("preparedOn"),
            appropriation: get("appropriation").unwrap_or_else(|| "before".to_owned()),
            average_employees: value
                .and_then(|v| v.get("averageEmployees"))
                .and_then(Value::as_f64),
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "legalForm": self.legal_form,
            "kvkNumber": self.kvk_number,
            "registeredOffice": self.registered_office,
            "city": self.city,
            "postalCode": self.postal_code,
            "email": self.email,
            "preparedOn": self.prepared_on,
            "appropriation": self.appropriation,
            "averageEmployees": self.average_employees,
        })
    }

    /// The defaults a new report takes from the entity.
    async fn of_entity(db: &PgPool, entity: &Value) -> Result<Self, Refusal> {
        let address =
            weldsuite_books_domain::address::normalize_postal_address(entity.get("address"));
        let city = address
            .as_ref()
            .and_then(|a| text(a, &["city"]))
            .map(str::to_owned);
        Ok(Self {
            legal_form: text(entity, &["entityType"])
                .filter(|code| legal_form_label(code).is_some())
                .map(str::to_owned),
            kvk_number: kvk_number_of(db, entity).await?,
            registered_office: city.clone(),
            postal_code: address
                .as_ref()
                .and_then(|a| text(a, &["postalCode"]))
                .map(str::to_owned),
            city,
            email: text(entity, &["contact", "email"]).map(str::to_owned),
            prepared_on: Some(today()),
            appropriation: "before".to_owned(),
            average_employees: None,
        })
    }
}

// ── Checks ──────────────────────────────────────────────────────────────────

/// What keeps a report from being filed, by field.
#[allow(clippy::too_many_lines, reason = "one check per fact the KvK requires")]
fn issues(report: &annual_reports::Model, today: &str) -> Vec<Value> {
    let d = Disclosures::from_json(report.disclosures.as_ref());
    let mut out = Vec::new();
    let mut issue =
        |field: &str, message: String| out.push(json!({ "field": field, "message": message }));
    let start = day_of(report.period_start);
    let end = day_of(report.period_end);
    let start_year: i32 = start
        .get(..4)
        .and_then(|y| y.parse().ok())
        .unwrap_or_default();
    if taxonomy_for(start_year).is_none() {
        issue(
            "fiscalYear",
            format!(
                "The KvK taxonomy this backend writes covers financial years starting in {}",
                supported_years()
            ),
        );
    }
    if end.as_str() >= today {
        issue(
            "fiscalYear",
            "The financial year hasn't ended yet".to_owned(),
        );
    }
    match d.legal_form.as_deref() {
        Some(code) if legal_form_label(code).is_some() => {}
        _ => issue(
            "legalForm",
            "Choose the legal form: B.V. or N.V.".to_owned(),
        ),
    }
    if d.kvk_number.as_deref().and_then(kvk_number).is_none() {
        issue("kvkNumber", "Enter the eight-digit KvK number".to_owned());
    }
    if d.registered_office.is_none() {
        issue(
            "registeredOffice",
            "Enter the registered office (statutaire zetel)".to_owned(),
        );
    }
    if d.city.is_none() {
        issue("city", "Enter the place of business".to_owned());
    }
    if d.postal_code.as_deref().and_then(postal_code).is_none() {
        issue(
            "postalCode",
            "Enter a Dutch postal code (1234 AB)".to_owned(),
        );
    }
    if !d.email.as_deref().is_some_and(is_email) {
        issue(
            "email",
            "Enter the email address the KvK sends its confirmation to".to_owned(),
        );
    }
    match d.prepared_on.as_deref() {
        Some(day) if is_day(day) && day <= today => {}
        _ => issue(
            "preparedOn",
            "Enter the date the accounts were prepared (not in the future)".to_owned(),
        ),
    }
    if d.appropriation != "before" && d.appropriation != "after" {
        issue(
            "appropriation",
            "Choose before or after profit appropriation".to_owned(),
        );
    }
    if report.adopted {
        match report.adoption_date.map(day_of) {
            Some(day) if day > end && day.as_str() <= today => {}
            _ => issue(
                "adoptionDate",
                "Enter the adoption date: after the year end and not in the future".to_owned(),
            ),
        }
    }
    if report.size_class == "small" && d.average_employees.is_none_or(|n| n < 0.0) {
        issue(
            "averageEmployees",
            "Enter the average number of employees".to_owned(),
        );
    }
    let figures = report.figures.as_ref();
    match figures
        .and_then(|f| f.get("current"))
        .and_then(Lines::from_json)
    {
        Some(current) => {
            let gap = current.assets() - current.equity_and_liabilities();
            if gap.abs() >= 0.5 {
                issue(
                    "figures",
                    format!(
                        "The balance sheet doesn't balance: assets {:.2}, equity and liabilities {:.2}",
                        current.assets(),
                        current.equity_and_liabilities()
                    ),
                );
            }
        }
        None => issue("figures", "The balance sheet is missing".to_owned()),
    }
    if let Some(prior) = figures
        .and_then(|f| f.get("prior"))
        .and_then(Lines::from_json)
        && (prior.assets() - prior.equity_and_liabilities()).abs() >= 0.5
    {
        issue(
            "figures",
            "The comparative balance sheet doesn't balance".to_owned(),
        );
    }
    out
}

/// The row as the API answers it, with what keeps it from being filed.
fn row_json(report: &annual_reports::Model) -> Value {
    let mut row = serde_json::to_value(report).unwrap_or(Value::Null);
    if let Value::Object(map) = &mut row {
        map.insert("issues".into(), Value::Array(issues(report, &today())));
        map.insert(
            "disclosures".into(),
            Disclosures::from_json(report.disclosures.as_ref()).to_json(),
        );
    }
    row
}

fn label(report: &annual_reports::Model) -> String {
    format!("Jaarrekening {}", report.fiscal_year)
}

fn event_data(report: &annual_reports::Model, status: &str) -> Value {
    json!({
        "id": report.id,
        "entityId": report.entity_id,
        "fiscalYear": report.fiscal_year,
        "status": status,
        "label": label(report),
    })
}

/// A live report, or the 404.
async fn find(db: &PgPool, id: &str) -> Result<annual_reports::Model, Refusal> {
    annual_reports::Entity::find_by_id(id.to_owned())
        .filter(annual_reports::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await
        .map_err(db_error)?
        .ok_or_else(|| Refusal::not_found("Annual report", id))
}

/// A report can be changed while it is a draft or after a rejection.
fn editable(report: &annual_reports::Model) -> Result<(), Refusal> {
    if report.status == "draft" || report.status == "rejected" {
        Ok(())
    } else {
        Err(Refusal::conflict(format!(
            "This annual report is {} and can no longer be changed",
            report.status
        )))
    }
}

// ── The balance sheet from the ledger ───────────────────────────────────────

/// The financial year named `year` (the calendar year it ends in), and the
/// one before.
/// A financial year's first and last day.
type Span = (String, String);

fn years_of(entity: &Value, year: i64) -> Result<(Span, Span), Refusal> {
    let current = fiscal_year_named(entity, year).map_err(|e| Refusal::bad_request(e.0))?;
    let prior = fiscal_year_named(entity, year - 1).map_err(|e| Refusal::bad_request(e.0))?;
    Ok(((current.from, current.to), (prior.from, prior.to)))
}

/// `figures` for the year from `start` to `end`, with the year before.
async fn compute_figures(
    db: &PgPool,
    entity_id: &str,
    current: (&str, &str),
    prior: (&str, &str),
) -> Result<Value, Refusal> {
    let up_to = weldsuite_books_domain::reports_basis::parse_report_date(
        current.1,
        weldsuite_books_domain::reports_basis::Edge::End,
    )
    .map_err(|e| Refusal::bad_request(e.0))?;
    let ledger = create_ledger(
        db,
        entity_id,
        Basis::Accrual,
        LedgerFilters::default(),
        up_to,
    )
    .await?;
    let read = |error: figures::BalanceError| match error {
        figures::BalanceError::Input(e) => Refusal::bad_request(e.0),
        figures::BalanceError::Database(e) => Refusal::Database(e),
    };
    let (this_year, this_accounts) = balance_sheet(&ledger, current.0, current.1)
        .await
        .map_err(read)?;
    let (last_year, last_accounts) = balance_sheet(&ledger, prior.0, prior.1)
        .await
        .map_err(read)?;
    let prior_lines = (!is_empty(&last_year)).then_some(&last_year);
    Ok(figures_json(
        &this_year,
        prior_lines,
        &this_accounts,
        if prior_lines.is_some() {
            &last_accounts
        } else {
            &[]
        },
        &iso(OffsetDateTime::now_utc()),
    ))
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller) -> Response {
    reply(
        async {
            let Some(entity_id) = resolve_entity_id(&caller).await? else {
                return Err(Refusal::bad_request("No accounting entity resolved"));
            };
            let rows = annual_reports::Entity::find()
                .filter(annual_reports::Column::EntityId.eq(&entity_id))
                .filter(annual_reports::Column::DeletedAt.is_null())
                .order_by_desc(annual_reports::Column::FiscalYear)
                .all(&orm(&caller.db))
                .await
                .map_err(db_error)?;
            Ok(ok(Value::Array(rows.iter().map(row_json).collect())))
        }
        .await,
        "Failed to fetch annual reports",
    )
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async { Ok(ok(row_json(&find(&caller.db, &id).await?))) }.await,
        "Failed to fetch annual report",
    )
}

// ── POST / ──────────────────────────────────────────────────────────────────

fn read_size(issues: &mut Issues, body: &Map<String, Value>, presence: Presence) -> Field<String> {
    let size = issues.text(body, "sizeClass", presence, None, None);
    if let Field::Set(value) = &size
        && Size::parse(value).is_none()
    {
        issues.custom("sizeClass", "sizeClass must be micro or small");
        return Field::Absent;
    }
    size
}

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    reply(
        create_report(&caller, &state, &headers, &body).await,
        "Failed to create annual report",
    )
}

async fn create_report(
    caller: &Caller,
    state: &BooksState,
    headers: &HeaderMap,
    body: &Bytes,
) -> Reply {
    let (year, size) = validate(headers, body, |issues, body| {
        let year = issues.number(
            body,
            "fiscalYear",
            Presence::Required,
            Number {
                coerce: false,
                int: true,
                min: Some(2000.0),
                max: Some(2100.0),
            },
        );
        let size = read_size(issues, body, Presence::Required);
        (year.into_option(), size.into_option())
    })?;
    #[allow(clippy::cast_possible_truncation, reason = "checked to 2000..=2100")]
    let year = year.unwrap_or_default() as i32;
    let size = size.unwrap_or_default();
    let db = &caller.db;
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let Some(entity) = entity_json(db, &entity_id).await? else {
        return Err(Refusal::not_found("Entity", &entity_id));
    };
    if text(&entity, &["jurisdictionCode"]) != Some("NL") {
        return Err(Refusal::bad_request(
            "Annual reports for the KvK are for Dutch entities",
        ));
    }
    if let Some(existing) = annual_reports::Entity::find()
        .filter(annual_reports::Column::EntityId.eq(&entity_id))
        .filter(annual_reports::Column::FiscalYear.eq(year))
        .filter(annual_reports::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await
        .map_err(db_error)?
    {
        return Err(Refusal::conflict_with(
            format!("There is already an annual report for {year}"),
            json!({ "id": existing.id }),
        ));
    }
    let ((start, end), (prior_start, prior_end)) = years_of(&entity, i64::from(year))?;
    let figures =
        compute_figures(db, &entity_id, (&start, &end), (&prior_start, &prior_end)).await?;
    let disclosures = Disclosures::of_entity(db, &entity).await?;
    let (Some(period_start), Some(period_end)) = (parse_day(&start), parse_day(&end)) else {
        return Err(Refusal::Internal(format!("fiscal year {start}..{end}")));
    };
    let now = utc_timestamp(OffsetDateTime::now_utc());
    let report = annual_reports::ActiveModel {
        id: Set(generate_id("anr")),
        created_at: Set(now),
        updated_at: Set(now),
        entity_id: Set(entity_id.clone()),
        fiscal_year: Set(year),
        period_start: Set(period_start),
        period_end: Set(period_end),
        size_class: Set(size),
        status: Set("draft".to_owned()),
        figures: Set(Some(figures)),
        disclosures: Set(Some(disclosures.to_json())),
        adopted: Set(false),
        created_by: Set(caller.user().map(str::to_owned)),
        ..Default::default()
    }
    .insert(&orm(db))
    .await
    .map_err(db_error)?;
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "annual_report",
            entity_id: &report.id,
            action: "created",
            changes: None,
        },
    )
    .await;
    caller.publish(
        state,
        ANNUAL_REPORT_CREATED,
        &report.id,
        event_data(&report, "draft"),
    );
    Ok(created(row_json(&report)))
}

// ── POST /:id/recalculate ───────────────────────────────────────────────────

async fn recalculate(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let db = &caller.db;
            let report = find(db, &id).await?;
            editable(&report)?;
            let Some(entity) = entity_json(db, &report.entity_id).await? else {
                return Err(Refusal::not_found("Entity", &report.entity_id));
            };
            let ((start, end), (prior_start, prior_end)) =
                years_of(&entity, i64::from(report.fiscal_year))?;
            let figures = compute_figures(
                db,
                &report.entity_id,
                (&start, &end),
                (&prior_start, &prior_end),
            )
            .await?;
            let mut active: annual_reports::ActiveModel = report.into();
            active.figures = Set(Some(figures));
            active.updated_at = Set(utc_timestamp(OffsetDateTime::now_utc()));
            let report = active.update(&orm(db)).await.map_err(db_error)?;
            caller.publish(
                &state,
                ANNUAL_REPORT_UPDATED,
                &id,
                event_data(&report, &report.status),
            );
            Ok(ok(row_json(&report)))
        }
        .await,
        "Failed to recalculate annual report",
    )
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

/// A PATCH body.
#[derive(Default)]
struct Patch {
    size: Option<String>,
    current: Option<Map<String, Value>>,
    /// `Null`: no comparative figures.
    prior: Field<Map<String, Value>>,
    disclosures: Map<String, Value>,
    adopted: Option<bool>,
    adoption_date: Field<String>,
    notes: Field<String>,
}

/// The lines of a figures column: known keys, finite numbers.
fn read_lines(issues: &mut Issues, value: Option<&Value>, key: &str) -> Option<Map<String, Value>> {
    let object = value?.as_object();
    let Some(object) = object else {
        issues.custom(key, &format!("{key} must be an object of amounts"));
        return None;
    };
    let mut lines = Map::new();
    for (line, amount) in object {
        match (Item::from_key(line), amount.as_f64()) {
            (Some(_), Some(amount)) if amount.is_finite() && amount.abs() < 1e13 => {
                lines.insert(line.clone(), json!(amount));
            }
            (None, _) => issues.custom(key, &format!("{line} is not a balance sheet line")),
            _ => issues.custom(key, &format!("{line} must be an amount")),
        }
    }
    Some(lines)
}

fn read_patch(issues: &mut Issues, body: &Map<String, Value>) -> Patch {
    let mut patch = Patch {
        size: read_size(issues, body, Presence::Optional).into_option(),
        ..Patch::default()
    };
    if let Some(figures) = body.get("figures") {
        match figures.as_object() {
            Some(figures) => {
                patch.current = read_lines(issues, figures.get("current"), "figures.current");
                match figures.get("prior") {
                    Some(Value::Null) => patch.prior = Field::Null,
                    Some(prior) => {
                        if let Some(lines) = read_lines(issues, Some(prior), "figures.prior") {
                            patch.prior = Field::Set(lines);
                        }
                    }
                    None => {}
                }
            }
            None => issues.custom("figures", "figures must be an object"),
        }
    }
    if let Some(disclosures) = body.get("disclosures") {
        match disclosures.as_object() {
            Some(fields) => {
                for (key, value) in fields {
                    let known =
                        DISCLOSURE_TEXTS.contains(&key.as_str()) || key == "averageEmployees";
                    let fits = match (key.as_str(), value) {
                        (_, Value::Null) => true,
                        ("averageEmployees", Value::Number(n)) => {
                            n.as_f64().is_some_and(|n| (0.0..1e7).contains(&n))
                        }
                        ("averageEmployees", _) => false,
                        (_, Value::String(s)) => s.chars().count() <= 255,
                        _ => false,
                    };
                    if !known {
                        issues.custom("disclosures", &format!("{key} is not a disclosure"));
                    } else if fits {
                        patch.disclosures.insert(key.clone(), value.clone());
                    } else {
                        issues.custom("disclosures", &format!("{key} has the wrong type"));
                    }
                }
            }
            None => issues.custom("disclosures", "disclosures must be an object"),
        }
    }
    patch.adopted = issues
        .boolean(body, "adopted", Presence::Optional)
        .into_option();
    match body.get("adoptionDate") {
        Some(Value::Null) => patch.adoption_date = Field::Null,
        Some(Value::String(day)) if is_day(day) => patch.adoption_date = Field::Set(day.clone()),
        Some(_) => issues.custom("adoptionDate", "adoptionDate must be YYYY-MM-DD"),
        None => {}
    }
    patch.notes = issues.text_with(
        body,
        "notes",
        Presence::Nullish,
        Text::length(None, Some(5000)),
    );
    patch
}

#[allow(clippy::too_many_lines, reason = "one branch per patchable field")]
async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    reply(
        async {
            let patch = validate(&headers, &body, read_patch)?;
            let db = &caller.db;
            let report = find(db, &id).await?;
            editable(&report)?;
            let mut changes = Map::new();
            let mut active: annual_reports::ActiveModel = report.clone().into();
            if let Some(size) = patch.size {
                changes.insert(
                    "sizeClass".into(),
                    change(json!(report.size_class), json!(size)),
                );
                active.size_class = Set(size);
            }
            if patch.current.is_some() || !patch.prior.is_absent() {
                let mut figures = report.figures.clone().unwrap_or_else(|| json!({}));
                if let Value::Object(map) = &mut figures {
                    if let Some(current) = patch.current {
                        let mut lines = map
                            .get("current")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        lines.extend(current);
                        map.insert("current".into(), Value::Object(lines));
                    }
                    match patch.prior {
                        Field::Null => {
                            map.insert("prior".into(), Value::Null);
                        }
                        Field::Set(prior) => {
                            let mut lines = map
                                .get("prior")
                                .and_then(Value::as_object)
                                .cloned()
                                .unwrap_or_default();
                            lines.extend(prior);
                            map.insert("prior".into(), Value::Object(lines));
                        }
                        Field::Absent => {}
                    }
                    map.insert("edited".into(), json!(true));
                }
                changes.insert("figures".into(), change(json!("…"), json!("edited")));
                active.figures = Set(Some(figures));
            }
            if !patch.disclosures.is_empty() {
                let mut disclosures = Disclosures::from_json(report.disclosures.as_ref()).to_json();
                if let Value::Object(map) = &mut disclosures {
                    map.extend(patch.disclosures);
                }
                active.disclosures = Set(Some(disclosures));
            }
            if let Some(adopted) = patch.adopted {
                changes.insert(
                    "adopted".into(),
                    change(json!(report.adopted), json!(adopted)),
                );
                active.adopted = Set(adopted);
                if !adopted {
                    active.adoption_date = Set(None);
                }
            }
            match patch.adoption_date {
                Field::Set(day) => active.adoption_date = Set(parse_day(&day)),
                Field::Null => active.adoption_date = Set(None),
                Field::Absent => {}
            }
            match patch.notes {
                Field::Set(notes) => active.notes = Set(Some(notes)),
                Field::Null => active.notes = Set(None),
                Field::Absent => {}
            }
            active.updated_at = Set(utc_timestamp(OffsetDateTime::now_utc()));
            let updated = active.update(&orm(db)).await.map_err(db_error)?;
            write_accounting_audit(
                &caller,
                db,
                AuditInput {
                    accounting_entity_id: Some(&updated.entity_id),
                    entity_type: "annual_report",
                    entity_id: &id,
                    action: "updated",
                    changes: (!changes.is_empty()).then_some(changes),
                },
            )
            .await;
            caller.publish(
                &state,
                ANNUAL_REPORT_UPDATED,
                &id,
                event_data(&updated, &updated.status),
            );
            Ok(ok(row_json(&updated)))
        }
        .await,
        "Failed to update annual report",
    )
}

// ── The instance ────────────────────────────────────────────────────────────

/// The XBRL of a report that passes its checks, or the 400 with the issues.
async fn instance_of(db: &PgPool, report: &annual_reports::Model) -> Result<String, Refusal> {
    let found = issues(report, &today());
    if !found.is_empty() {
        return Err(Refusal::bad_request_with(
            "The annual report isn't complete yet",
            json!({ "issues": found }),
        ));
    }
    let Some(entity) = entity_json(db, &report.entity_id).await? else {
        return Err(Refusal::not_found("Entity", &report.entity_id));
    };
    let d = Disclosures::from_json(report.disclosures.as_ref());
    let name = text(&entity, &["legalName"])
        .or_else(|| text(&entity, &["name"]))
        .unwrap_or_default()
        .to_owned();
    let start = day_of(report.period_start);
    let end = day_of(report.period_end);
    let start_year: i32 = start
        .get(..4)
        .and_then(|y| y.parse().ok())
        .unwrap_or_default();
    let (Some(taxonomy), Some(size)) = (taxonomy_for(start_year), Size::parse(&report.size_class))
    else {
        return Err(Refusal::bad_request("No KvK taxonomy for this report"));
    };
    let figures = report.figures.as_ref();
    let current = figures
        .and_then(|f| f.get("current"))
        .and_then(Lines::from_json)
        .unwrap_or_default()
        .rounded();
    let prior = figures
        .and_then(|f| f.get("prior"))
        .and_then(Lines::from_json)
        .map(|lines| lines.rounded());
    let previous = match &prior {
        Some(_) => Some(years_of(&entity, i64::from(report.fiscal_year))?.1),
        None => None,
    };
    let adoption = report.adoption_date.filter(|_| report.adopted).map(day_of);
    let kvk = d
        .kvk_number
        .as_deref()
        .and_then(kvk_number)
        .unwrap_or_default();
    let postal = d
        .postal_code
        .as_deref()
        .and_then(postal_code)
        .unwrap_or_default();
    Ok(instance(&Document {
        taxonomy,
        size,
        kvk_number: &kvk,
        name: &name,
        legal_form: d
            .legal_form
            .as_deref()
            .and_then(legal_form_label)
            .unwrap_or_default(),
        registered_office: d.registered_office.as_deref().unwrap_or_default(),
        city: d.city.as_deref().unwrap_or_default(),
        postal_code: &postal,
        email: d.email.as_deref().unwrap_or_default(),
        start: &start,
        end: &end,
        previous: previous.as_ref().map(|(s, e)| (s.as_str(), e.as_str())),
        prepared_on: d.prepared_on.as_deref().unwrap_or_default(),
        adopted_on: adoption.as_deref(),
        before_appropriation: d.appropriation != "after",
        current: &current,
        prior: prior.as_ref(),
        average_employees: d.average_employees,
    }))
}

/// The file name the filing rules allow (`[0-9A-Za-z_-]`, `.xbrl`).
fn file_name(report: &annual_reports::Model) -> String {
    let kvk = Disclosures::from_json(report.disclosures.as_ref())
        .kvk_number
        .as_deref()
        .and_then(kvk_number)
        .unwrap_or_default();
    format!("jaarrekening-{kvk}-{}.xbrl", report.fiscal_year)
}

// ── GET /:id/xbrl ───────────────────────────────────────────────────────────

async fn download(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let report = find(&caller.db, &id).await?;
            // A filed report answers the message it was filed with.
            let xml = match report
                .xml_content
                .clone()
                .filter(|_| report.status != "draft" && report.status != "rejected")
            {
                Some(xml) => xml,
                None => instance_of(&caller.db, &report).await?,
            };
            let mut response = (StatusCode::OK, xml).into_response();
            let headers = response.headers_mut();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/xml"),
            );
            if let Ok(value) =
                HeaderValue::from_str(&format!("attachment; filename=\"{}\"", file_name(&report)))
            {
                headers.insert(header::CONTENT_DISPOSITION, value);
            }
            Ok(response)
        }
        .await,
        "Failed to build the annual report XBRL",
    )
}

// ── POST /:id/file ──────────────────────────────────────────────────────────

async fn file(caller: Caller, State(state): State<BooksState>, Path(id): Path<String>) -> Response {
    reply(
        file_report(&caller, &state, &id).await,
        "Failed to file annual report",
    )
}

#[allow(
    clippy::too_many_lines,
    reason = "deliver, record a refusal or the delivery, audit, publish, watch"
)]
async fn file_report(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let db = &caller.db;
    let report = find(db, id).await?;
    editable(&report)?;
    let Some(digipoort) = &state.digipoort else {
        return Err(Refusal::unavailable(
            "Filing with the KvK through Digipoort isn't set up on this installation. Download the XBRL, deposit it yourself, then mark the report as filed.",
        ));
    };
    let xml = instance_of(db, &report).await?;
    let kvk = Disclosures::from_json(report.disclosures.as_ref())
        .kvk_number
        .as_deref()
        .and_then(kvk_number)
        .unwrap_or_default();
    let delivery = Delivery {
        berichtsoort: profile::BERICHTSOORT_KVK.to_owned(),
        aanleverkenmerk: format!("JR-{id}").chars().take(40).collect(),
        belanghebbende: Identity {
            number: kvk,
            kind: profile::IDENTITY_KVK.to_owned(),
        },
        role: profile::ROLE_COMPANY.to_owned(),
        file_name: file_name(&report),
        mime_type: "application/xml".to_owned(),
        content: xml.as_bytes().to_vec(),
    };
    let at = OffsetDateTime::now_utc();
    let now = utc_timestamp(at);
    let delivered = match digipoort.deliver(&delivery).await {
        Ok(delivered) => delivered,
        Err(error) => {
            tracing::warn!(%error, report = id, "annual-reports: Digipoort refused the deposit");
            let mut active: annual_reports::ActiveModel = report.into();
            active.digipoort_response = Set(Some(failed_record(
                digipoort.mode(),
                profile::BERICHTSOORT_KVK,
                &error,
                at,
            )));
            active.xml_content = Set(Some(xml));
            active.updated_at = Set(now);
            active.update(&orm(db)).await.map_err(db_error)?;
            let mut refusal = ApiError::bad_gateway()
                .with_message(format!("The annual report was not filed: {error}"));
            if let DigipoortError::Fault {
                code: Some(code), ..
            } = &error
            {
                refusal = refusal.with_details(json!({ "digipoortCode": code }));
            }
            return Err(refusal.into());
        }
    };
    let record = delivered_record(
        digipoort.mode(),
        profile::BERICHTSOORT_KVK,
        &delivery.aanleverkenmerk,
        &delivered,
        at,
    );
    let previous_status = report.status.clone();
    let mut active: annual_reports::ActiveModel = report.into();
    active.status = Set("submitted".to_owned());
    active.xml_content = Set(Some(xml));
    active.filing_reference = Set(Some(delivered.kenmerk.clone()));
    active.digipoort_response = Set(Some(record));
    active.filed_at = Set(Some(now));
    active.filed_by = Set(caller.user().map(str::to_owned));
    active.rejected_at = Set(None);
    active.rejection_reason = Set(None);
    active.updated_at = Set(now);
    let report = active.update(&orm(db)).await.map_err(db_error)?;
    let mut changes = Map::new();
    changes.insert(
        "status".into(),
        change(json!(previous_status), json!("submitted")),
    );
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&report.entity_id),
            entity_type: "annual_report",
            entity_id: id,
            action: "submitted",
            changes: Some(changes),
        },
    )
    .await;
    caller.publish(
        state,
        ANNUAL_REPORT_SUBMITTED,
        id,
        event_data(&report, "submitted"),
    );
    if let Some(master) = caller.master(state) {
        weldsuite_db::due_index::mark_due(
            &master,
            weldsuite_digipoort::SWEEP_KIND,
            &caller.workspace_id,
            at + time::Duration::minutes(5),
        )
        .await;
    }
    Ok(ok(json!({
        "id": id,
        "status": "submitted",
        "kenmerk": delivered.kenmerk,
        "environment": digipoort.mode().as_str(),
        "message": "Annual report submitted to the KvK through Digipoort",
    })))
}

// ── POST /:id/mark-filed ────────────────────────────────────────────────────

async fn mark_filed(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    reply(
        async {
            let (reference, filed_on) = validate(&headers, &body, |issues, body| {
                let reference = issues
                    .text_with(
                        body,
                        "filingReference",
                        Presence::Optional,
                        Text::trimmed(None, Some(255)),
                    )
                    .into_option();
                let filed_on = match body.get("filedAt") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(day)) if is_day(day) => Some(day.clone()),
                    Some(_) => {
                        issues.custom("filedAt", "filedAt must be YYYY-MM-DD");
                        None
                    }
                };
                (reference, filed_on)
            })?;
            let db = &caller.db;
            let report = find(db, &id).await?;
            editable(&report)?;
            let filed_at = filed_on
                .as_deref()
                .and_then(parse_day)
                .unwrap_or_else(|| utc_timestamp(OffsetDateTime::now_utc()));
            let previous_status = report.status.clone();
            let mut active: annual_reports::ActiveModel = report.into();
            active.status = Set("filed".to_owned());
            active.filing_reference = Set(reference.filter(|r| !r.is_empty()));
            active.filed_at = Set(Some(filed_at));
            active.filed_by = Set(caller.user().map(str::to_owned));
            active.updated_at = Set(utc_timestamp(OffsetDateTime::now_utc()));
            let report = active.update(&orm(db)).await.map_err(db_error)?;
            let mut changes = Map::new();
            changes.insert(
                "status".into(),
                change(json!(previous_status), json!("filed")),
            );
            write_accounting_audit(
                &caller,
                db,
                AuditInput {
                    accounting_entity_id: Some(&report.entity_id),
                    entity_type: "annual_report",
                    entity_id: &id,
                    action: "filed",
                    changes: Some(changes),
                },
            )
            .await;
            caller.publish(
                &state,
                ANNUAL_REPORT_UPDATED,
                &id,
                event_data(&report, "filed"),
            );
            Ok(ok(row_json(&report)))
        }
        .await,
        "Failed to mark annual report as filed",
    )
}

// ── GET /:id/filing-status ──────────────────────────────────────────────────

/// Whether the stored record is a real delivery.
fn is_delivery(record: Option<&Value>) -> bool {
    record.is_some_and(|r| {
        r.get("simulated") == Some(&Value::Bool(false))
            && r.get("success") == Some(&Value::Bool(true))
    })
}

/// The statuses read once and stored; `accepted` / `rejected` once final.
async fn refresh(
    db: &PgPool,
    digipoort: &Digipoort,
    report: &annual_reports::Model,
    now: OffsetDateTime,
) -> Result<
    Result<(weldsuite_digipoort::Assessment, Value, Option<&'static str>), DigipoortError>,
    DbErr,
> {
    let kenmerk = report.filing_reference.clone().unwrap_or_default();
    let statuses = match digipoort.statuses(&kenmerk).await {
        Ok(statuses) => statuses,
        Err(error) => return Ok(Err(error)),
    };
    let assessment = assess(&statuses);
    let record = with_statuses(
        report.digipoort_response.as_ref().unwrap_or(&Value::Null),
        &statuses,
        &assessment,
        now,
    );
    let settled = match assessment.outcome {
        Outcome::Accepted => Some("accepted"),
        Outcome::Rejected => Some("rejected"),
        _ => None,
    };
    let at = utc_timestamp(now);
    let mut update = annual_reports::Entity::update_many()
        .col_expr(
            annual_reports::Column::DigipoortResponse,
            Expr::value(record.clone()),
        )
        .col_expr(annual_reports::Column::UpdatedAt, Expr::value(at));
    if let Some(status) = settled {
        update = update.col_expr(annual_reports::Column::Status, Expr::value(status));
        update = if status == "accepted" {
            update.col_expr(annual_reports::Column::AcceptedAt, Expr::value(at))
        } else {
            update
                .col_expr(annual_reports::Column::RejectedAt, Expr::value(at))
                .col_expr(
                    annual_reports::Column::RejectionReason,
                    Expr::value(assessment.reason.clone()),
                )
        };
    }
    update
        .filter(annual_reports::Column::Id.eq(&report.id))
        .filter(annual_reports::Column::Status.eq("submitted"))
        .exec(&orm(db))
        .await?;
    Ok(Ok((assessment, record, settled)))
}

async fn status(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let report = find(&caller.db, &id).await?;
            let kenmerk = report.filing_reference.clone().unwrap_or_default();
            let at = OffsetDateTime::now_utc();
            let (Some(digipoort), true) = (&state.digipoort, is_delivery(report.digipoort_response.as_ref())) else {
                return Err(Refusal::bad_request(
                    "This annual report was not sent through Digipoort",
                ));
            };
            let body = match refresh(&caller.db, digipoort, &report, at).await.map_err(db_error)? {
                Ok((assessment, record, settled)) => {
                    if let Some(settled) = settled {
                        caller.publish(&state, ANNUAL_REPORT_UPDATED, &id, event_data(&report, settled));
                    }
                    json!({
                        "id": id,
                        "kenmerk": kenmerk,
                        "success": true,
                        "simulated": false,
                        "status": assessment.outcome.as_str(),
                        "statusCode": assessment.code,
                        "statusDescription": assessment.description,
                        "reason": assessment.reason,
                        "statuses": record.get("statuses").cloned().unwrap_or(Value::Array(Vec::new())),
                        "timestamp": iso(at),
                    })
                }
                Err(error) => json!({
                    "id": id,
                    "kenmerk": kenmerk,
                    "success": false,
                    "simulated": false,
                    "status": "unknown",
                    "error": error.to_string(),
                    "timestamp": iso(at),
                }),
            };
            Ok(ok(body))
        }
        .await,
        "Failed to check filing status",
    )
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let db = &caller.db;
            let report = find(db, &id).await?;
            editable(&report)?;
            let now = utc_timestamp(OffsetDateTime::now_utc());
            let mut active: annual_reports::ActiveModel = report.clone().into();
            active.deleted_at = Set(Some(now));
            active.updated_at = Set(now);
            active.update(&orm(db)).await.map_err(db_error)?;
            write_accounting_audit(
                &caller,
                db,
                AuditInput {
                    accounting_entity_id: Some(&report.entity_id),
                    entity_type: "annual_report",
                    entity_id: &id,
                    action: "deleted",
                    changes: None,
                },
            )
            .await;
            caller.publish(
                &state,
                ANNUAL_REPORT_DELETED,
                &id,
                event_data(&report, &report.status),
            );
            Ok(no_content())
        }
        .await,
        "Failed to delete annual report",
    )
}

// ── weldsuite cron digipoort-status ─────────────────────────────────────────

/// What one workspace's poll of its open deposits did.
#[derive(Debug, Default)]
pub struct AnnualReportPoll {
    pub checked: usize,
    /// The events to publish for the reports that settled.
    pub settled: Vec<(EventName, String, Value)>,
    pub failed: usize,
    /// When the earliest open deposit is due again.
    pub next_due: Option<OffsetDateTime>,
}

/// The workspace's open KvK deposits, each read once.
pub async fn poll_open_annual_reports(
    db: &PgPool,
    digipoort: &Digipoort,
    now: OffsetDateTime,
) -> Result<AnnualReportPoll, DbErr> {
    let open = annual_reports::Entity::find()
        .filter(annual_reports::Column::Status.eq("submitted"))
        .filter(annual_reports::Column::DeletedAt.is_null())
        .all(&orm(db))
        .await?;
    let mut poll = AnnualReportPoll::default();
    for report in open
        .iter()
        .filter(|r| is_delivery(r.digipoort_response.as_ref()))
    {
        let filed_at = report.filed_at.map_or(now, PrimitiveDateTime::assume_utc);
        let Some(next) = next_poll(filed_at, now) else {
            continue;
        };
        poll.checked += 1;
        match refresh(db, digipoort, report, now).await? {
            Ok((_, _, Some(settled))) => {
                poll.settled.push((
                    ANNUAL_REPORT_UPDATED,
                    report.id.clone(),
                    event_data(report, settled),
                ));
                continue;
            }
            Ok(_) => {}
            Err(error) => {
                poll.failed += 1;
                tracing::warn!(%error, report = report.id, "digipoort-status: statuses not read");
            }
        }
        poll.next_due = Some(poll.next_due.map_or(next, |due| due.min(next)));
    }
    Ok(poll)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(disclosures: Value, figures: Value) -> annual_reports::Model {
        let at = parse_day("2026-01-10").expect("day");
        annual_reports::Model {
            id: "anr_1".to_owned(),
            created_at: at,
            updated_at: at,
            deleted_at: None,
            entity_id: "ent_1".to_owned(),
            fiscal_year: 2025,
            period_start: parse_day("2025-01-01").expect("day"),
            period_end: parse_day("2025-12-31").expect("day"),
            size_class: "micro".to_owned(),
            status: "draft".to_owned(),
            figures: Some(figures),
            disclosures: Some(disclosures),
            adopted: false,
            adoption_date: None,
            xml_content: None,
            filing_reference: None,
            digipoort_response: None,
            filed_at: None,
            filed_by: None,
            accepted_at: None,
            rejected_at: None,
            rejection_reason: None,
            created_by: None,
            notes: None,
        }
    }

    fn complete() -> Value {
        json!({
            "legalForm": "bv",
            "kvkNumber": "1234 5678",
            "registeredOffice": "Den Haag",
            "city": "Den Haag",
            "postalCode": "2514 gl",
            "email": "info@voorbeeld.nl",
            "preparedOn": "2026-03-01",
        })
    }

    fn balanced() -> Value {
        json!({ "current": { "cash": 100.0, "shareCapital": 100.0 }, "prior": null })
    }

    #[test]
    fn reads_the_details_the_kvk_needs() {
        assert_eq!(kvk_number("1234 5678").as_deref(), Some("12345678"));
        assert_eq!(kvk_number("01234567").as_deref(), Some("01234567"));
        assert_eq!(kvk_number("00123456"), None);
        assert_eq!(kvk_number("1234567"), None);
        assert_eq!(postal_code("2514 gl").as_deref(), Some("2514GL"));
        assert_eq!(postal_code("0514GL"), None);
        assert!(is_email("info@voorbeeld.nl"));
        assert!(!is_email("info@voorbeeld"));
        assert_eq!(legal_form_label("vof"), None);
        assert_eq!(day_of(parse_day("2025-02-28").expect("day")), "2025-02-28");
        assert!(parse_day("2025-02-30").is_none());
    }

    #[test]
    fn checks_a_report_before_it_is_filed() {
        let ok = report(complete(), balanced());
        assert_eq!(issues(&ok, "2026-04-01"), Vec::<Value>::new());

        // Not ended yet, and nothing filled in.
        let empty = report(json!({}), json!({ "current": { "cash": 100.0 } }));
        let found = issues(&empty, "2025-06-01");
        let fields: Vec<&str> = found.iter().filter_map(|i| i["field"].as_str()).collect();
        for field in [
            "fiscalYear",
            "legalForm",
            "kvkNumber",
            "registeredOffice",
            "city",
            "postalCode",
            "email",
            "preparedOn",
            "figures",
        ] {
            assert!(fields.contains(&field), "{field}: {fields:?}");
        }

        let mut small = report(complete(), balanced());
        small.size_class = "small".to_owned();
        small.adopted = true;
        small.adoption_date = parse_day("2025-12-01");
        let fields: Vec<String> = issues(&small, "2026-04-01")
            .iter()
            .filter_map(|i| i["field"].as_str().map(str::to_owned))
            .collect();
        assert_eq!(fields, vec!["adoptionDate", "averageEmployees"]);

        let mut old = report(complete(), balanced());
        old.period_start = parse_day("2024-01-01").expect("day");
        old.period_end = parse_day("2024-12-31").expect("day");
        assert_eq!(issues(&old, "2026-04-01")[0]["field"], "fiscalYear");
    }

    #[test]
    fn names_the_file_as_the_filing_rules_allow() {
        assert_eq!(
            file_name(&report(complete(), balanced())),
            "jaarrekening-12345678-2025.xbrl"
        );
        let row = row_json(&report(complete(), balanced()));
        assert_eq!(row["disclosures"]["appropriation"], "before");
        assert!(row["issues"].is_array());
    }
}
