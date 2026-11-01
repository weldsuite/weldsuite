//! `/api/sales-tax-agencies` (`routes/sales-tax-agencies/index.ts`,
//! `services/sales-tax/agencies.ts`): the states (and self-administered
//! local agencies) an entity is registered with or monitors.
//!
//! Creating an agency fills in the state's defaults, creates its two child
//! payable accounts (under Sales Tax Payable and Use Tax Payable) and seeds
//! its shipping and handling rules. An agency that carries tax-ledger rows is
//! closed, never deleted.

use std::collections::HashSet;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::Response;
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, no_content, now, ok, paged, reply, validate,
};
use weldsuite_books_domain::jurisdictions::{js_trim, us};
use weldsuite_books_domain::sales_tax::route_helpers::{
    optional_sales_tax_entity, page_params, require_agency, require_sales_tax_entity,
};
use weldsuite_books_domain::tables::{
    ACCOUNTS, SALES_TAX_AGENCIES as T, SALES_TAX_TAXABILITY_RULES,
};
use weldsuite_catalogs::entity_events::{
    SALES_TAX_AGENCY_CREATED, SALES_TAX_AGENCY_DELETED, SALES_TAX_AGENCY_UPDATED,
};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Format, Issues, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::common::{changes, iso_date, keep, merged, refuse, text, today};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("taxes:read")))
        .route("/", post(create).route_layer(need("taxes:create")))
        .route("/{id}", get(detail).route_layer(need("taxes:read")))
        .route(
            "/{id}",
            axum::routing::put(update)
                .patch(update)
                .route_layer(need("taxes:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("taxes:delete")),
        )
        .with_state(state)
}

const STATUSES: [&str; 4] = ["registered", "pending", "monitoring", "closed"];
const FREQUENCIES: [&str; 4] = ["monthly", "quarterly", "semiannual", "annual"];

/// The date a seeded rule takes effect: before any invoice a user would write.
pub(crate) const SEEDED_RULE_START: &str = "2000-01-01";

/// `createAgencySchema` / `updateAgencySchema`, as read.
#[derive(Debug, Default)]
struct AgencyBody {
    state_code: Field<String>,
    level: Field<String>,
    local_jurisdiction_code: Field<String>,
    name: Field<String>,
    registration_number: Field<String>,
    registered_from: Field<String>,
    registered_until: Field<String>,
    status: Field<String>,
    filing_frequency: Field<String>,
    first_period_start: Field<String>,
    due_day: Field<i64>,
    reporting_basis: Field<String>,
    sst_member: Field<bool>,
    portal_url: Field<String>,
    notes: Field<String>,
    provider_registration_ref: Field<String>,
}

fn read_body(issues: &mut Issues, body: &Map<String, Value>, update: bool) -> AgencyBody {
    let mut out = AgencyBody::default();
    let optional = Presence::Optional;
    let nullish = Presence::Nullish;
    if !update {
        out.state_code = issues.text(body, "stateCode", Presence::Required, None, None);
        if let Field::Set(code) = &out.state_code {
            let len = code.encode_utf16().count();
            if len != 2 {
                issues.string_length("stateCode", 2, len);
                out.state_code = Field::Absent;
            }
        }
        out.level = issues.choice(body, "level", optional, &["state", "local"]);
        out.local_jurisdiction_code =
            issues.text(body, "localJurisdictionCode", nullish, None, Some(30));
    }
    out.name = issues.text(body, "name", optional, Some(1), Some(255));
    out.registration_number = issues.text(body, "registrationNumber", nullish, None, Some(100));
    out.registered_from = iso_date(issues, body, "registeredFrom", nullish);
    out.registered_until = iso_date(issues, body, "registeredUntil", nullish);
    out.status = issues.choice(body, "status", optional, &STATUSES);
    out.filing_frequency = issues.choice(body, "filingFrequency", optional, &FREQUENCIES);
    out.first_period_start = iso_date(issues, body, "firstPeriodStart", nullish);
    out.due_day = issues.whole_number(
        body,
        "dueDay",
        optional,
        weldsuite_kit::validation::Number {
            min: Some(1.0),
            max: Some(31.0),
            ..Default::default()
        },
    );
    out.reporting_basis = issues.choice(body, "reportingBasis", optional, &["accrual", "cash"]);
    out.sst_member = issues.boolean(body, "sstMember", optional);
    out.portal_url = issues.text_with(
        body,
        "portalUrl",
        nullish,
        Text {
            format: Some(Format::Url),
            max: Some(500),
            ..Text::default()
        },
    );
    out.notes = issues.text(body, "notes", nullish, None, Some(5000));
    if update {
        out.provider_registration_ref =
            issues.text(body, "providerRegistrationRef", nullish, None, Some(255));
    }
    out
}

/// `AgencyInput`: the fields `resolveAgencyFields` reads.
#[derive(Debug, Clone, Default)]
pub(crate) struct AgencyInput {
    pub state_code: String,
    pub level: Option<String>,
    pub local_jurisdiction_code: Option<String>,
    pub name: Option<String>,
    pub registration_number: Option<String>,
    pub registered_from: Option<String>,
    pub registered_until: Option<String>,
    pub status: Option<String>,
    pub filing_frequency: Option<String>,
    pub first_period_start: Option<String>,
    pub due_day: Option<i64>,
    pub reporting_basis: Option<String>,
    pub sst_member: Option<bool>,
    pub portal_url: Option<String>,
    pub notes: Option<String>,
}

/// The filled-in agency fields (`resolveAgencyFields`'s result).
#[derive(Debug, Clone)]
pub(crate) struct AgencyFields {
    pub state_code: String,
    pub state_name: String,
    pub level: String,
    pub local_jurisdiction_code: Option<String>,
    pub name: String,
    pub registration_number: Option<String>,
    pub registered_from: Option<String>,
    pub registered_until: Option<String>,
    pub status: String,
    pub filing_frequency: String,
    pub first_period_start: String,
    pub due_day: i64,
    pub reporting_basis: String,
    pub sst_member: bool,
    pub portal_url: Option<String>,
    pub notes: Option<String>,
}

/// The state of an agency, validated against the US states (DC included).
pub(crate) fn require_state(code: &str) -> Result<&'static Value, Refusal> {
    let Some(info) = us::state(Some(code)) else {
        return Err(refuse(
            format!("\"{code}\" is not a US state code (use the two-letter USPS code, e.g. TX)"),
            400,
        ));
    };
    if info["hasStateSalesTax"].as_bool() != Some(true)
        && info["hasLocalSalesTax"].as_bool() != Some(true)
    {
        return Err(refuse(
            format!(
                "{} has no state or local sales tax, so there is nothing to register for",
                info["name"].as_str().unwrap_or(code)
            ),
            400,
        ));
    }
    Ok(info)
}

/// `input?.trim() || null`.
fn trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(js_trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

/// `resolveAgencyFields(input)`: defaults and checks shared by create and
/// update.
#[allow(
    clippy::too_many_lines,
    reason = "mirrors agencies.ts's resolveAgencyFields()"
)]
pub(crate) fn resolve_agency_fields(
    input: &AgencyInput,
    day: &str,
) -> Result<AgencyFields, Refusal> {
    let info = require_state(&input.state_code)?;
    let state_name = info["name"].as_str().unwrap_or_default().to_owned();
    let level = input.level.clone().unwrap_or_else(|| "state".to_owned());
    if level == "local" {
        let home_rule = info["specialPrograms"].as_array().is_some_and(|p| {
            p.iter()
                .any(|x| x.as_str() == Some("home_rule_local_agencies"))
        });
        if !home_rule {
            return Err(refuse(
                format!(
                    "{state_name} has no self-administered local agencies; local tax is reported to the state"
                ),
                400,
            ));
        }
        if trimmed(input.name.as_deref()).is_none() {
            return Err(refuse(
                "A local agency needs a name (the city or district that administers its own tax)",
                400,
            ));
        }
        if trimmed(input.local_jurisdiction_code.as_deref()).is_none() {
            return Err(refuse("A local agency needs its jurisdiction code", 400));
        }
    }
    let reporting_basis = input
        .reporting_basis
        .clone()
        .unwrap_or_else(|| "accrual".to_owned());
    if reporting_basis == "cash"
        && level == "state"
        && info["cashBasisAllowed"].as_bool() != Some(true)
    {
        return Err(refuse(
            format!("{state_name} requires sales tax to be reported on the accrual basis"),
            400,
        ));
    }
    let due_day = input
        .due_day
        .unwrap_or_else(|| match &info["defaultDueDay"] {
            Value::String(s) if s == "last" => 31,
            other => other.as_i64().unwrap_or(20),
        });
    if !(1..=31).contains(&due_day) {
        return Err(refuse("The due day is a day of the month, 1 to 31", 400));
    }
    let registered_from = input.registered_from.clone();
    let registered_until = input.registered_until.clone();
    if let (Some(from), Some(until)) = (&registered_from, &registered_until)
        && !from.is_empty()
        && !until.is_empty()
        && until < from
    {
        return Err(refuse(
            "The registration end date is before its start date",
            400,
        ));
    }
    let first_period_start = input.first_period_start.clone().unwrap_or_else(|| {
        let base = registered_from.clone().unwrap_or_else(|| day.to_owned());
        format!("{}-01", base.chars().take(7).collect::<String>())
    });
    Ok(AgencyFields {
        state_code: info["code"].as_str().unwrap_or_default().to_owned(),
        state_name: state_name.clone(),
        local_jurisdiction_code: if level == "local" {
            input
                .local_jurisdiction_code
                .as_deref()
                .map(|c| js_trim(c).to_owned())
        } else {
            None
        },
        name: trimmed(input.name.as_deref())
            .or_else(|| {
                info["agencyName"]
                    .as_str()
                    .filter(|n| !n.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| format!("{state_name} Department of Revenue")),
        level,
        registration_number: trimmed(input.registration_number.as_deref()),
        registered_from,
        registered_until,
        status: input
            .status
            .clone()
            .unwrap_or_else(|| "registered".to_owned()),
        filing_frequency: input
            .filing_frequency
            .clone()
            .unwrap_or_else(|| "quarterly".to_owned()),
        first_period_start,
        due_day,
        reporting_basis,
        sst_member: input
            .sst_member
            .unwrap_or_else(|| info["sst"].as_str() != Some("none")),
        portal_url: input
            .portal_url
            .clone()
            .or_else(|| info["portalUrl"].as_str().map(str::to_owned)),
        notes: trimmed(input.notes.as_deref()),
    })
}

/// What events carry: no registration number.
fn event_data(agency: &Value) -> Value {
    json!({
        "id": agency["id"],
        "stateCode": agency["stateCode"],
        "level": agency["level"],
        "name": agency["name"],
        "status": agency["status"],
        "filingFrequency": agency["filingFrequency"],
    })
}

/// `id, code, name, current_balance` of an account.
type Summary = (String, Option<String>, Option<String>, Option<String>);

/// `withAccounts(db, rows)`: each agency with the accounts its liabilities
/// are booked to (a payable reads as what is owed, credit positive).
async fn with_accounts(db: &PgPool, rows: Vec<Value>) -> Result<Vec<Value>, sqlx::Error> {
    let mut ids: Vec<String> = Vec::new();
    for row in &rows {
        for key in ["liabilityAccountId", "useTaxAccountId"] {
            if let Some(id) = text(row, key).filter(|i| !i.is_empty())
                && !ids.iter().any(|x| x == id)
            {
                ids.push(id.to_owned());
            }
        }
    }
    let accounts: Vec<Summary> = if ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "select id, code, name, current_balance::text from accounts where id = any($1)",
        )
        .bind(&ids)
        .fetch_all(db)
        .await?
    };
    let account = |id: Option<&str>| -> Value {
        let Some(id) = id.filter(|i| !i.is_empty()) else {
            return Value::Null;
        };
        accounts
            .iter()
            .find(|a| a.0 == id)
            .map_or(Value::Null, |(id, code, name, balance)| {
                let parsed =
                    -weldsuite_books_domain::js::parse_float(balance.as_deref().unwrap_or("0"));
                let shown = if parsed.is_nan() || parsed == 0.0 {
                    0.0
                } else {
                    parsed
                };
                json!({
                    "id": id,
                    "code": code,
                    "name": name,
                    "balance": weldsuite_books_domain::js::to_fixed(shown, 2),
                })
            })
    };
    Ok(rows
        .into_iter()
        .map(|row| {
            let mut out = row.as_object().cloned().unwrap_or_default();
            out.insert(
                "liabilityAccount".into(),
                account(text(&row, "liabilityAccountId")),
            );
            out.insert(
                "useTaxAccount".into(),
                account(text(&row, "useTaxAccountId")),
            );
            Value::Object(out)
        })
        .collect())
}

/// `agencyHasTaxLines(db, agencyId)`.
pub(crate) async fn agency_has_tax_lines(
    db: &PgPool,
    agency_id: &str,
) -> Result<bool, sqlx::Error> {
    let row: Option<String> =
        sqlx::query_scalar("select id from tax_lines where agency_id = $1 limit 1")
            .bind(agency_id)
            .fetch_optional(db)
            .await?;
    Ok(row.is_some())
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        list_agencies(&caller, &q).await,
        "Failed to fetch sales tax agencies",
    )
}

async fn list_agencies(caller: &Caller, q: &Query) -> Reply {
    let Some(entity) = optional_sales_tax_entity(caller).await? else {
        return Ok(paged(Vec::new(), 0, false, None));
    };
    let entity_id = text(&entity, "id").unwrap_or_default();
    let (page, page_size, offset) = page_params(q);
    let status = q.present("status");
    let state = q.present("stateCode").map(str::to_uppercase);
    let level = q.present("level");
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(sales_tax_agencies),
        " from sales_tax_agencies t where t.entity_id = $1 and t.deleted_at is null \
         and ($2::text is null or t.status = $2) and ($3::text is null or t.state_code = $3) \
         and ($4::text is null or t.level = $4) \
         order by t.state_code asc, t.level asc, t.name asc limit $5 offset $6"
    ))
    .bind(entity_id)
    .bind(status)
    .bind(&state)
    .bind(level)
    .bind(page_size)
    .bind(offset)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*)::int8 from sales_tax_agencies t where t.entity_id = $1 and t.deleted_at is null \
         and ($2::text is null or t.status = $2) and ($3::text is null or t.state_code = $3) \
         and ($4::text is null or t.level = $4)",
    )
    .bind(entity_id)
    .bind(status)
    .bind(&state)
    .bind(level)
    .fetch_one(&caller.db)
    .await?;
    let rows = with_accounts(&caller.db, T.js_rows(rows)).await?;
    Ok(paged(rows, total, page * page_size < total, None))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(show(&caller, &id).await, "Failed to fetch sales tax agency")
}

async fn show(caller: &Caller, id: &str) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let agency = require_agency(&caller.db, text(&entity, "id").unwrap_or_default(), id).await?;
    let has_lines = agency_has_tax_lines(&caller.db, id).await?;
    let mut row = with_accounts(&caller.db, vec![agency]).await?.remove(0);
    if let Some(map) = row.as_object_mut() {
        map.insert("hasTaxLines".into(), json!(has_lines));
    }
    Ok(ok(row))
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |i, b| read_body(i, b, false)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create sales tax agency"),
    };
    reply(
        create_agency(&caller, &state, data).await,
        "Failed to create sales tax agency",
    )
}

async fn create_agency(caller: &Caller, state: &BooksState, data: AgencyBody) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = text(&entity, "id").unwrap_or_default().to_owned();
    let input = AgencyInput {
        state_code: data.state_code.into_option().unwrap_or_default(),
        level: data.level.into_option(),
        local_jurisdiction_code: data.local_jurisdiction_code.into_option(),
        name: data.name.into_option(),
        registration_number: data.registration_number.into_option(),
        registered_from: data.registered_from.into_option(),
        registered_until: data.registered_until.into_option(),
        status: data.status.into_option(),
        filing_frequency: data.filing_frequency.into_option(),
        first_period_start: data.first_period_start.into_option(),
        due_day: data.due_day.into_option(),
        reporting_basis: data.reporting_basis.into_option(),
        sst_member: data.sst_member.into_option(),
        portal_url: data.portal_url.into_option(),
        notes: data.notes.into_option(),
    };
    let (agency, accounts_created, rules_seeded) =
        create_sales_tax_agency(&caller.db, &entity_id, &input, &today(caller, state)).await?;
    let agency_id = text(&agency, "id").unwrap_or_default().to_owned();
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "sales_tax_agency",
            entity_id: &agency_id,
            action: "created",
            changes: None,
        },
    )
    .await;
    caller.publish(
        state,
        SALES_TAX_AGENCY_CREATED,
        &agency_id,
        event_data(&agency),
    );
    let mut row = with_accounts(&caller.db, vec![agency]).await?.remove(0);
    if let Some(map) = row.as_object_mut() {
        map.insert("accountsCreated".into(), json!(accounts_created));
        map.insert("rulesSeeded".into(), json!(rules_seeded));
    }
    Ok(created(row))
}

/// `id, code, name, parent_account_id, subtype, currency, tax_line, systemRole`.
type AccountRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// One account row of the chart (what the planning reads).
struct Account {
    id: String,
    code: String,
    name: String,
    parent_account_id: Option<String>,
    subtype: Option<String>,
    currency: Option<String>,
    tax_line: Option<String>,
    system_role: Option<String>,
}

/// `planChild(parent, name, existing, usedCodes, now, entityId)`: the child
/// account for an agency under `parent`, reused when it exists: the first
/// free code after the parent's (2200 → 2201 … 2209), then `<parent>-<n>`.
fn plan_child(
    parent: &Account,
    name: &str,
    existing: &[Account],
    used: &mut HashSet<String>,
    now: &str,
    entity_id: &str,
) -> (String, Option<Map<String, Value>>) {
    if let Some(reusable) = existing
        .iter()
        .find(|a| a.parent_account_id.as_deref() == Some(parent.id.as_str()) && a.name == name)
    {
        return (reusable.id.clone(), None);
    }
    let mut code: Option<String> = None;
    if !parent.code.is_empty()
        && parent.code.bytes().all(|b| b.is_ascii_digit())
        && let Ok(base) = parent.code.parse::<i64>()
    {
        for i in 1..=9 {
            let candidate = (base + i).to_string();
            if !used.contains(&candidate) {
                code = Some(candidate);
                break;
            }
        }
    }
    let mut n = 1;
    while code.is_none() {
        let candidate = format!("{}-{n}", parent.code);
        if !used.contains(&candidate) {
            code = Some(candidate);
        }
        n += 1;
    }
    let code = code.unwrap_or_default();
    used.insert(code.clone());
    let id = generate_id("acc");
    let row = json!({
        "id": id,
        "entityId": entity_id,
        "code": code,
        "name": name,
        "type": "liability",
        "subtype": parent.subtype.clone().unwrap_or_else(|| "tax_payable".to_owned()),
        "normalSide": "credit",
        "parentAccountId": parent.id,
        "currency": parent.currency,
        "isActive": true,
        "isSystemAccount": false,
        "openingBalance": "0",
        "currentBalance": "0",
        "taxLine": parent.tax_line,
        "metadata": { "salesTaxAgencyAccount": true },
        "createdAt": now,
        "updatedAt": now,
    });
    (id, row.as_object().cloned())
}

/// How a state treats a separately stated delivery charge (`shippingTaxability`).
fn shipping_taxability(state_code: &str) -> (&'static str, &'static str) {
    const TAXABLE: [&str; 16] = [
        "AR", "CT", "GA", "IN", "KY", "LA", "MN", "NJ", "NY", "NC", "OH", "PA", "TN", "TX", "WA",
        "WI",
    ];
    const EXEMPT: [&str; 10] = ["AZ", "IA", "KS", "MD", "MI", "MO", "NV", "OK", "UT", "VA"];
    let upper = js_trim(state_code).to_uppercase();
    if TAXABLE.contains(&upper.as_str()) {
        ("taxable", "taxable")
    } else if upper == "CA" {
        ("exempt_if_separate", "taxable")
    } else if EXEMPT.contains(&upper.as_str()) {
        ("exempt_if_separate", "follows_goods")
    } else {
        ("follows_goods", "follows_goods")
    }
}

/// The rules a new agency starts with: shipping and handling.
fn shipping_rules(
    entity_id: &str,
    agency_id: &str,
    state_code: &str,
    now: &str,
) -> Vec<Map<String, Value>> {
    let (shipping, handling) = shipping_taxability(state_code);
    let mut rules = Vec::new();
    for (tax_code, how) in [("shipping", shipping), ("handling", handling)] {
        if how == "follows_goods" {
            continue;
        }
        let taxable = how == "taxable";
        let notes = if taxable {
            format!(
                "{tax_code} is taxable in {state_code} (seeded from the state's usual treatment; confirm before relying on it)"
            )
        } else {
            format!(
                "{tax_code} is not taxable in {state_code} when stated separately (seeded; confirm before relying on it)"
            )
        };
        let row = json!({
            "id": generate_id("str"),
            "entityId": entity_id,
            "agencyId": agency_id,
            "taxCode": tax_code,
            "taxable": taxable,
            "taxablePercent": "100",
            "appliesToUse": "any",
            "effectiveFrom": SEEDED_RULE_START,
            "notes": notes,
            "createdAt": now,
            "updatedAt": now,
        });
        if let Some(row) = row.as_object() {
            rules.push(row.clone());
        }
    }
    rules
}

/// `createSalesTaxAgency(db, entityId, input)`: the agency with its two
/// child accounts and its seeded rules, in one transaction.
#[allow(
    clippy::too_many_lines,
    reason = "mirrors agencies.ts's createSalesTaxAgency()"
)]
pub(crate) async fn create_sales_tax_agency(
    db: &PgPool,
    entity_id: &str,
    input: &AgencyInput,
    day: &str,
) -> Result<(Value, usize, usize), Refusal> {
    let fields = resolve_agency_fields(input, day)?;
    let duplicate: Option<String> = sqlx::query_scalar(
        "select id from sales_tax_agencies where entity_id = $1 and state_code = $2 and level = $3 \
         and (not $4 or local_jurisdiction_code = $5) and deleted_at is null limit 1",
    )
    .bind(entity_id)
    .bind(&fields.state_code)
    .bind(&fields.level)
    .bind(fields.level == "local")
    .bind(fields.local_jurisdiction_code.as_deref().unwrap_or(""))
    .fetch_optional(db)
    .await?;
    if duplicate.is_some() {
        return Err(refuse(
            if fields.level == "local" {
                format!("This entity already has an agency for {}", fields.name)
            } else {
                format!(
                    "This entity already has a {} agency. Edit it instead of adding another.",
                    fields.state_name
                )
            },
            409,
        ));
    }
    let rows: Vec<AccountRow> = sqlx::query_as(
        "select id, code, name, parent_account_id, subtype, currency, tax_line, metadata->>'systemRole' \
         from accounts where entity_id = $1 and deleted_at is null",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let accounts: Vec<Account> = rows
        .into_iter()
        .map(
            |(id, code, name, parent_account_id, subtype, currency, tax_line, system_role)| {
                Account {
                    id,
                    code,
                    name,
                    parent_account_id,
                    subtype,
                    currency,
                    tax_line,
                    system_role,
                }
            },
        )
        .collect();
    let parent = |role: &str, code: &str| {
        accounts
            .iter()
            .find(|a| a.system_role.as_deref() == Some(role))
            .or_else(|| accounts.iter().find(|a| a.code == code))
    };
    let (Some(sales_parent), Some(use_parent)) = (
        parent("sales_tax_payable", "2200"),
        parent("use_tax_payable", "2210"),
    ) else {
        return Err(refuse(
            "This accounting entity has no Sales Tax Payable and Use Tax Payable accounts. Create the entity from the US chart of accounts first.",
            400,
        ));
    };
    let at = now();
    let mut used: HashSet<String> = accounts.iter().map(|a| a.code.clone()).collect();
    let (liability_id, liability_row) = plan_child(
        sales_parent,
        &format!("Sales Tax Payable \u{2013} {}", fields.name),
        &accounts,
        &mut used,
        &at,
        entity_id,
    );
    let (use_id, use_row) = plan_child(
        use_parent,
        &format!("Use Tax Payable \u{2013} {}", fields.name),
        &accounts,
        &mut used,
        &at,
        entity_id,
    );
    let agency_id = generate_id("sta");
    let agency = json!({
        "id": agency_id,
        "entityId": entity_id,
        "stateCode": fields.state_code,
        "level": fields.level,
        "localJurisdictionCode": fields.local_jurisdiction_code,
        "name": fields.name,
        "registrationNumber": fields.registration_number,
        "registeredFrom": fields.registered_from,
        "registeredUntil": fields.registered_until,
        "status": fields.status,
        "filingFrequency": fields.filing_frequency,
        "firstPeriodStart": fields.first_period_start,
        "dueDay": fields.due_day,
        "reportingBasis": fields.reporting_basis,
        "sstMember": fields.sst_member,
        "portalUrl": fields.portal_url,
        "notes": fields.notes,
        "liabilityAccountId": liability_id,
        "useTaxAccountId": use_id,
        "createdAt": at,
        "updatedAt": at,
    });
    let rules = shipping_rules(entity_id, &agency_id, &fields.state_code, &at);
    let new_accounts: Vec<Map<String, Value>> =
        [liability_row, use_row].into_iter().flatten().collect();
    let mut tx = db.begin().await?;
    for account in &new_accounts {
        ACCOUNTS
            .insert_raw(&mut *tx, ACCOUNTS.values(account))
            .await?;
    }
    T.insert_raw(
        &mut *tx,
        T.values(agency.as_object().unwrap_or(&Map::new())),
    )
    .await?;
    for rule in &rules {
        SALES_TAX_TAXABILITY_RULES
            .insert_raw(&mut *tx, SALES_TAX_TAXABILITY_RULES.values(rule))
            .await?;
    }
    tx.commit().await?;
    let row = T.find_live(db, &agency_id).await?.unwrap_or(Value::Null);
    Ok((row, new_accounts.len(), rules.len()))
}

// ── PUT/PATCH /:id ──────────────────────────────────────────────────────────

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |i, b| read_body(i, b, true)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update sales tax agency"),
    };
    reply(
        update_agency(&caller, &state, &id, data).await,
        "Failed to update sales tax agency",
    )
}

/// `data.x === undefined ? row.x : data.x` for a nullish field.
fn or_row(field: &Field<String>, row: &Value, key: &str) -> Option<String> {
    match field {
        Field::Absent => text(row, key).map(str::to_owned),
        Field::Null => None,
        Field::Set(value) => Some(value.clone()),
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "mirrors the route's field-by-field update"
)]
async fn update_agency(caller: &Caller, state: &BooksState, id: &str, data: AgencyBody) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = text(&entity, "id").unwrap_or_default().to_owned();
    let agency = require_agency(&caller.db, &entity_id, id).await?;
    let day = today(caller, state);
    let fields = resolve_agency_fields(
        &AgencyInput {
            state_code: text(&agency, "stateCode").unwrap_or_default().to_owned(),
            level: Some(if text(&agency, "level") == Some("local") {
                "local".into()
            } else {
                "state".into()
            }),
            local_jurisdiction_code: text(&agency, "localJurisdictionCode").map(str::to_owned),
            name: data
                .name
                .as_set()
                .cloned()
                .or_else(|| text(&agency, "name").map(str::to_owned)),
            registration_number: or_row(&data.registration_number, &agency, "registrationNumber"),
            registered_from: or_row(&data.registered_from, &agency, "registeredFrom"),
            registered_until: or_row(&data.registered_until, &agency, "registeredUntil"),
            status: data
                .status
                .as_set()
                .cloned()
                .or_else(|| text(&agency, "status").map(str::to_owned)),
            filing_frequency: data
                .filing_frequency
                .as_set()
                .cloned()
                .or_else(|| text(&agency, "filingFrequency").map(str::to_owned)),
            first_period_start: or_row(&data.first_period_start, &agency, "firstPeriodStart"),
            due_day: data
                .due_day
                .as_set()
                .copied()
                .or_else(|| agency["dueDay"].as_i64()),
            reporting_basis: data
                .reporting_basis
                .as_set()
                .cloned()
                .or_else(|| text(&agency, "reportingBasis").map(str::to_owned)),
            sst_member: data
                .sst_member
                .as_set()
                .copied()
                .or_else(|| agency["sstMember"].as_bool()),
            portal_url: or_row(&data.portal_url, &agency, "portalUrl"),
            notes: or_row(&data.notes, &agency, "notes"),
        },
        &day,
    )?;

    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now()));
    let mut put = |key: &str, given: bool, value: Value| {
        if given {
            update.insert(key.to_owned(), value);
        }
    };
    put("name", !data.name.is_absent(), json!(fields.name));
    put(
        "registrationNumber",
        !data.registration_number.is_absent(),
        json!(fields.registration_number),
    );
    put(
        "registeredFrom",
        !data.registered_from.is_absent(),
        json!(fields.registered_from),
    );
    put(
        "registeredUntil",
        !data.registered_until.is_absent(),
        json!(fields.registered_until),
    );
    put("status", !data.status.is_absent(), json!(fields.status));
    put(
        "filingFrequency",
        !data.filing_frequency.is_absent(),
        json!(fields.filing_frequency),
    );
    put(
        "firstPeriodStart",
        !data.first_period_start.is_absent(),
        json!(fields.first_period_start),
    );
    put("dueDay", !data.due_day.is_absent(), json!(fields.due_day));
    put(
        "reportingBasis",
        !data.reporting_basis.is_absent(),
        json!(fields.reporting_basis),
    );
    put(
        "sstMember",
        !data.sst_member.is_absent(),
        json!(fields.sst_member),
    );
    put(
        "portalUrl",
        !data.portal_url.is_absent(),
        json!(fields.portal_url),
    );
    put("notes", !data.notes.is_absent(), json!(fields.notes));
    if !data.provider_registration_ref.is_absent() {
        keep(
            &mut update,
            "providerRegistrationRef",
            &data.provider_registration_ref,
        );
    }
    // Closing an agency ends its registration (today, unless a date was given).
    let status = data.status.as_set().map(String::as_str);
    if status == Some("closed")
        && data.registered_until.is_absent()
        && text(&agency, "registeredUntil").is_none_or(str::is_empty)
    {
        update.insert("registeredUntil".into(), json!(day));
    }
    // Registering again after a close: the old end date no longer applies.
    if status == Some("registered")
        && text(&agency, "status") == Some("closed")
        && data.registered_until.is_absent()
    {
        update.insert("registeredUntil".into(), Value::Null);
    }
    T.patch_raw(&caller.db, id, T.values(&update), false)
        .await?;
    let updated = merged(&agency, &update);
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "sales_tax_agency",
            entity_id: id,
            action: "updated",
            changes: Some(changes(&update, &agency)),
        },
    )
    .await;
    caller.publish(state, SALES_TAX_AGENCY_UPDATED, id, event_data(&updated));
    let row = with_accounts(&caller.db, vec![updated]).await?.remove(0);
    Ok(ok(row))
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        delete_agency(&caller, &state, &id).await,
        "Failed to delete sales tax agency",
    )
}

async fn delete_agency(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = text(&entity, "id").unwrap_or_default().to_owned();
    let agency = require_agency(&caller.db, &entity_id, id).await?;
    let at = now();
    if agency_has_tax_lines(&caller.db, id).await? {
        // Tax-ledger rows point at it: the history stays, and so does the agency.
        let until = text(&agency, "registeredUntil")
            .filter(|u| !u.is_empty())
            .map_or_else(|| today(caller, state), str::to_owned);
        let mut closed = Map::new();
        closed.insert("status".into(), json!("closed"));
        closed.insert("registeredUntil".into(), json!(until));
        closed.insert("updatedAt".into(), json!(at));
        T.patch_raw(&caller.db, id, T.values(&closed), false)
            .await?;
        let mut audit = Map::new();
        audit.insert(
            "status".into(),
            change(agency["status"].clone(), json!("closed")),
        );
        write_accounting_audit(
            caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&entity_id),
                entity_type: "sales_tax_agency",
                entity_id: id,
                action: "closed",
                changes: Some(audit),
            },
        )
        .await;
        caller.publish(
            state,
            SALES_TAX_AGENCY_UPDATED,
            id,
            event_data(&merged(&agency, &closed)),
        );
        return Ok(ok(json!({
            "id": id,
            "deleted": false,
            "closed": true,
            "status": "closed",
            "registeredUntil": until,
        })));
    }
    // Its rates, zones and rules go with it; its payable accounts stay.
    let mut tx = caller.db.begin().await?;
    sqlx::query(
        "update sales_tax_jurisdiction_rates set deleted_at = $1::timestamp where entity_id = $2 \
         and jurisdiction_id in (select id from sales_tax_jurisdictions where agency_id = $3)",
    )
    .bind(&at)
    .bind(&entity_id)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    for statement in [
        "update sales_tax_jurisdictions set deleted_at = $1::timestamp where agency_id = $2",
        "update sales_tax_zones set deleted_at = $1::timestamp where agency_id = $2",
        "update sales_tax_taxability_rules set deleted_at = $1::timestamp where agency_id = $2",
        "update sales_tax_agencies set deleted_at = $1::timestamp, updated_at = $1::timestamp where id = $2",
    ] {
        sqlx::query(statement)
            .bind(&at)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "sales_tax_agency",
            entity_id: id,
            action: "deleted",
            changes: None,
        },
    )
    .await;
    caller.publish(state, SALES_TAX_AGENCY_DELETED, id, event_data(&agency));
    Ok(no_content())
}
