//! Entity setup (`services/accounting-entity-setup.ts`,
//! `accounting-entity-lock.ts`, `br-entity-setup.ts`'s rate sync): the kind
//! of an entity (US entity type and tax classification, BR legal form and
//! regime), US address and SSN checks, tax years, the seeded chart with its
//! tax lines, re-mapping tax lines, and what is frozen once the books rest
//! on an entity.

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::jurisdictions::{br, us};
use weldsuite_kit::generate_id;

/// `EntitySetupError`: the route answers 400 with the message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SetupError(pub(crate) String);

impl From<br::SetupError> for SetupError {
    fn from(error: br::SetupError) -> Self {
        Self(error.0)
    }
}

/// `{ entityType, taxClassification }`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct EntityKind {
    pub(crate) entity_type: Option<String>,
    pub(crate) tax_classification: Option<String>,
}

/// A field a PATCH may leave out (`undefined`), set to null, or set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Given<T> {
    Absent,
    Null,
    Set(T),
}

impl<T: Clone> Given<T> {
    /// `value !== undefined ? value : fallback`.
    pub(crate) fn or(&self, fallback: Option<T>) -> Option<T> {
        match self {
            Self::Absent => fallback,
            Self::Null => None,
            Self::Set(value) => Some(value.clone()),
        }
    }
}

/// `resolveEntityKind(jurisdictionCode, input, existing)`.
pub(crate) fn resolve_entity_kind(
    jurisdiction: &str,
    entity_type: &Given<String>,
    tax_classification: &Given<String>,
    existing: Option<&EntityKind>,
) -> Result<EntityKind, SetupError> {
    let entity_type = entity_type.or(existing.and_then(|e| e.entity_type.clone()));
    let code = jurisdiction.to_uppercase();
    if code == "BR" {
        return resolve_br_kind(
            entity_type,
            tax_classification,
            existing.and_then(|e| e.tax_classification.clone()),
        );
    }
    if code != "US" {
        if let Given::Set(classification) = tax_classification
            && !classification.is_empty()
        {
            return Err(SetupError(
                "taxClassification applies to US and Brazilian entities only".to_owned(),
            ));
        }
        return Ok(EntityKind {
            entity_type,
            tax_classification: None,
        });
    }
    resolve_us_kind(
        entity_type,
        tax_classification,
        existing.and_then(|e| e.tax_classification.clone()),
    )
}

fn resolve_us_kind(
    entity_type: Option<String>,
    requested: &Given<String>,
    existing: Option<String>,
) -> Result<EntityKind, SetupError> {
    if let Some(t) = entity_type.as_deref().filter(|t| !t.is_empty())
        && !us::is_entity_type(t)
    {
        return Err(SetupError(format!(
            "entityType must be one of: {}",
            us::entity_types().join(", ")
        )));
    }
    let requested_text = match requested {
        Given::Set(value) if !value.is_empty() => Some(value.clone()),
        _ => None,
    };
    if let Some(c) = requested_text.as_deref()
        && !us::is_tax_classification(c)
    {
        return Err(SetupError(
            "taxClassification must be one of: sole_proprietor, disregarded, partnership, s_corp, c_corp, exempt".to_owned(),
        ));
    }
    let mut classification = requested.or(existing);
    if let Some(t) = entity_type.as_deref().filter(|t| !t.is_empty()) {
        if let Some(c) = classification.as_deref().filter(|c| !c.is_empty())
            && !us::is_valid_tax_classification(Some(t), Some(c))
        {
            // A type change that leaves the old classification invalid falls
            // back to the type's default; an explicit request doesn't.
            if requested_text.is_some() {
                return Err(SetupError(format!(
                    "A {} can't be taxed as {}. Allowed: {}",
                    t.replace('_', " "),
                    c.replace('_', " "),
                    us::allowed_tax_classifications(Some(t)).join(", ")
                )));
            }
            classification = None;
        }
        if classification.is_none() {
            classification = Some(us::default_tax_classification(Some(t)).to_owned());
        }
    }
    Ok(EntityKind {
        entity_type,
        tax_classification: classification,
    })
}

fn resolve_br_kind(
    entity_type: Option<String>,
    requested: &Given<String>,
    existing: Option<String>,
) -> Result<EntityKind, SetupError> {
    if let Some(t) = entity_type.as_deref().filter(|t| !t.is_empty())
        && !br::is_entity_type(t)
    {
        return Err(SetupError(format!(
            "entityType must be one of: {}",
            br::entity_types().join(", ")
        )));
    }
    let requested_text = match requested {
        Given::Set(value) if !value.is_empty() => Some(value.clone()),
        _ => None,
    };
    if let Some(c) = requested_text.as_deref()
        && !br::is_tax_regime(c)
    {
        return Err(SetupError(format!(
            "taxClassification (the regime) must be one of: {}",
            br::tax_regimes().join(", ")
        )));
    }
    let allowed = br::allowed_regimes(entity_type.as_deref().filter(|t| !t.is_empty()));
    // `input.taxClassification ?? existingRegime`
    let requested_value = match requested {
        Given::Set(value) => Some(value.clone()),
        _ => existing,
    };
    if let Some(c) = requested_text.as_deref()
        && !allowed.contains(&c)
    {
        return Err(SetupError(format!(
            "This legal form can't be in that regime. Allowed: {}",
            allowed.join(", ")
        )));
    }
    let regime = match requested_value {
        Some(r) if !r.is_empty() && allowed.contains(&r.as_str()) => r,
        _ => allowed[0].to_owned(),
    };
    Ok(EntityKind {
        entity_type,
        tax_classification: Some(regime),
    })
}

/// `checkUsAddress(address)`: a real state code and a ZIP (canonical form),
/// `US` as the country when none is given; other countries pass as they are.
pub(crate) fn check_us_address(address: Option<Value>) -> Result<Option<Value>, SetupError> {
    let Some(address) = address else {
        return Ok(None);
    };
    let mut next = address.clone();
    let country = address["country"].as_str().map(str::to_uppercase);
    if let Some(country) = country.as_deref().filter(|c| !c.is_empty())
        && country != "US"
        && country != "USA"
    {
        return Ok(Some(address));
    }
    if let Some(state) = address["state"].as_str().filter(|s| !s.is_empty()) {
        let upper = weldsuite_books_domain::jurisdictions::js_trim(state).to_uppercase();
        if !us::is_address_state_code(&upper) {
            return Err(SetupError(format!(
                "'{state}' is not a US state or territory code"
            )));
        }
        next["state"] = json!(upper);
    }
    if let Some(zip) = address["postalCode"].as_str().filter(|z| !z.is_empty()) {
        let checked = us::validate_zip(zip);
        if !checked.valid {
            return Err(SetupError(
                checked
                    .error
                    .unwrap_or_else(|| "Invalid ZIP code".to_owned()),
            ));
        }
        next["postalCode"] = json!(checked.formatted);
    }
    if address["country"].as_str().is_none_or(str::is_empty) {
        next["country"] = json!("US");
    }
    Ok(Some(next))
}

/// `checkSsn(value)`: the formatted SSN.
pub(crate) fn check_ssn(value: &str) -> Result<String, SetupError> {
    let check = us::validate_ssn(value);
    match (check.valid, check.formatted) {
        (true, Some(formatted)) => Ok(formatted),
        _ => Err(SetupError(
            check.error.unwrap_or_else(|| "Invalid SSN".to_owned()),
        )),
    }
}

/// `looksLikeSsn(value)`: `/^\d{3}-?\d{2}-?\d{4}$/` on the trimmed value.
pub(crate) fn looks_like_ssn(value: &str) -> bool {
    let trimmed = weldsuite_books_domain::jurisdictions::js_trim(value);
    let compact: String = trimmed.chars().filter(|c| *c != '-').collect();
    if compact.len() != 9 || !compact.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let b = trimmed.as_bytes();
    match b.len() {
        9 => true,
        10 => b[3] == b'-' || b[5] == b'-',
        11 => b[3] == b'-' && b[6] == b'-',
        _ => false,
    }
}

/// The current date in a time zone (UTC when unset or unknown).
fn now_in(zone: Option<&str>) -> jiff::civil::DateTime {
    let tz = zone
        .filter(|z| !z.is_empty())
        .map_or(Ok(jiff::tz::TimeZone::UTC), jiff::tz::TimeZone::get)
        .unwrap_or(jiff::tz::TimeZone::UTC);
    jiff::Timestamp::now().to_zoned(tz).datetime()
}

/// `taxYearOf(timeZone)`: the year it is now in the entity's time zone.
pub(crate) fn tax_year_of(zone: Option<&str>) -> i64 {
    i64::from(now_in(zone).year())
}

/// `todayInTimeZone(timeZone)`: `YYYY-MM-DD` in the entity's time zone.
pub(crate) fn today_in(zone: Option<&str>) -> String {
    let now = now_in(zone);
    format!("{:04}-{:02}-{:02}", now.year(), now.month(), now.day())
}

/// `formOfEntity(entity)`.
pub(crate) fn form_of(entity_type: Option<&str>, classification: Option<&str>) -> &'static str {
    us::tax_form_for_entity(entity_type, classification)
}

/// `taxLineError(entity, code, taxYear)`.
pub(crate) fn tax_line_error(entity: &Value, code: &str, tax_year: i64) -> Option<String> {
    if entity["jurisdictionCode"].as_str() != Some("US") {
        return Some("Tax lines are only available for US entities".to_owned());
    }
    let form = form_of(
        entity["entityType"].as_str(),
        entity["taxClassification"].as_str(),
    );
    match us::tax_line(code, tax_year) {
        Some(line) if line["form"].as_str() == Some(form) => None,
        _ => Some(format!(
            "'{code}' is not a line of {}",
            us::form_label(form)
        )),
    }
}

/// `form1099BoxError(code)`.
pub(crate) fn form_1099_box_error(code: &str) -> Option<String> {
    (code != us::form_1099_omit() && !us::is_form_1099_box_code(code))
        .then(|| format!("'{code}' is not a 1099 box code (use nec_1, misc_1, ... or omit)"))
}

/// What [`build_seed_accounts`] needs.
pub(crate) struct SeedArgs<'a> {
    pub(crate) entity_id: &'a str,
    pub(crate) jurisdiction: &'a str,
    pub(crate) base_currency: &'a str,
    pub(crate) kind: &'a EntityKind,
    pub(crate) tax_year: i64,
    pub(crate) now: &'a str,
}

/// `buildSeedAccounts(args)`: the chart template as `accounts` rows (by
/// property), parents linked by code, US tax lines and 1099 boxes mapped.
pub(crate) fn build_seed_accounts(args: &SeedArgs<'_>) -> Vec<Map<String, Value>> {
    let template = weldsuite_books_domain::jurisdictions::chart_template(
        args.jurisdiction,
        args.kind.entity_type.as_deref(),
        args.kind.tax_classification.as_deref(),
    );
    let ids: Vec<(String, String)> = template
        .iter()
        .map(|row| {
            (
                row["code"].as_str().unwrap_or_default().to_owned(),
                generate_id("acc"),
            )
        })
        .collect();
    let id_of = |code: &str| {
        // `new Map(rows.map(...))`: a duplicate code keeps the last id.
        ids.iter()
            .rev()
            .find(|(c, _)| c == code)
            .map(|(_, id)| id.clone())
    };
    let is_us = args.jurisdiction.eq_ignore_ascii_case("US");
    let form = is_us.then(|| {
        us::tax_form_for_entity(
            args.kind.entity_type.as_deref(),
            args.kind.tax_classification.as_deref(),
        )
    });
    template
        .iter()
        .map(|row| {
            let code = row["code"].as_str().unwrap_or_default();
            let tax_line = match (form, row["taxLine"].as_str().filter(|l| !l.is_empty())) {
                (Some(form), Some(category)) => us::resolve_tax_line(category, form, args.tax_year)
                    .map_or(Value::Null, |line| line["code"].clone()),
                _ => Value::Null,
            };
            let mut values = Map::new();
            for (key, value) in [
                ("id", json!(id_of(code))),
                ("entityId", json!(args.entity_id)),
                ("code", json!(code)),
                ("name", row["name"].clone()),
                ("type", row["type"].clone()),
                (
                    "subtype",
                    row.get("subtype").cloned().unwrap_or(Value::Null),
                ),
                ("normalSide", row["normalSide"].clone()),
                (
                    "parentAccountId",
                    row["parentCode"]
                        .as_str()
                        .filter(|p| !p.is_empty())
                        .and_then(id_of)
                        .map_or(Value::Null, Value::String),
                ),
                ("currency", json!(args.base_currency)),
                ("isActive", json!(true)),
                (
                    "isSystemAccount",
                    json!(row["isSystemAccount"].as_bool().unwrap_or(false)),
                ),
                ("openingBalance", json!("0")),
                ("currentBalance", json!("0")),
                ("taxLine", tax_line),
                (
                    "form1099Box",
                    if is_us {
                        row.get("form1099Box").cloned().unwrap_or(Value::Null)
                    } else {
                        Value::Null
                    },
                ),
                ("createdAt", json!(args.now)),
                ("updatedAt", json!(args.now)),
            ] {
                values.insert(key.to_owned(), value);
            }
            // `metadata: row.systemRole ? { systemRole } : undefined` (left out).
            if let Some(role) = row["systemRole"].as_str().filter(|r| !r.is_empty()) {
                values.insert("metadata".to_owned(), json!({ "systemRole": role }));
            }
            values
        })
        .collect()
}

/// The category of a stored line code (`categoryOfLine`).
fn category_of_line(code: &str, tax_year: i64) -> Option<&'static str> {
    let line = us::tax_line(code, tax_year)?;
    let form = line["form"].as_str()?;
    us::tax_line_categories().into_iter().find(|category| {
        us::resolve_tax_line(category, form, tax_year).and_then(|l| l["code"].as_str())
            == Some(code)
    })
}

/// `applyTaxLines(db, entity, adapter, opts)`: every account on the line
/// of the entity's current return; the `TaxLineRemapResult`.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub(crate) async fn apply_tax_lines(
    db: &PgPool,
    entity: &Value,
    overwrite: bool,
    tax_year: i64,
) -> Result<Value, sqlx::Error> {
    let entity_type = entity["entityType"].as_str();
    let classification = entity["taxClassification"].as_str();
    let form = form_of(entity_type, classification);
    let template =
        weldsuite_books_domain::jurisdictions::chart_template("US", entity_type, classification);
    let category_by_code = |code: &str| {
        template
            .iter()
            .filter(|r| r["taxLine"].as_str().is_some_and(|l| !l.is_empty()))
            .rev()
            .find(|r| r["code"].as_str() == Some(code))
            .and_then(|r| r["taxLine"].as_str())
    };
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(accounts),
        " from accounts t where t.entity_id = $1 and t.deleted_at is null"
    ))
    .bind(entity["id"].as_str().unwrap_or_default())
    .fetch_all(db)
    .await?;
    let accounts = weldsuite_books_domain::tables::ACCOUNTS.js_rows(rows);

    let (mut updated, mut unchanged, mut kept) = (0_i64, 0_i64, 0_i64);
    let mut changes: Vec<Value> = Vec::new();
    let mut unmapped: Vec<Value> = Vec::new();
    let mut remaps: Vec<(String, Option<String>)> = Vec::new();
    for account in &accounts {
        let current = account["taxLine"]
            .as_str()
            .filter(|l| !l.is_empty())
            .map(str::to_owned);
        let current_line = current.as_deref().and_then(|c| us::tax_line(c, tax_year));
        let on_this_form = current_line.is_some_and(|l| l["form"].as_str() == Some(form));
        let code = account["code"].as_str().unwrap_or_default();
        let template_category = category_by_code(code);
        let category = template_category.or_else(|| {
            current
                .as_deref()
                .and_then(|c| category_of_line(c, tax_year))
        });
        let default_line = category
            .and_then(|c| us::resolve_tax_line(c, form, tax_year))
            .and_then(|l| l["code"].as_str())
            .map(str::to_owned);
        // `account.taxLine` may be '' in the row; `current` reads it as unset.
        let raw_current = account["taxLine"].as_str().map(str::to_owned);
        let mut next = raw_current.clone();
        if on_this_form {
            if let Some(default_line) = &default_line
                && current.as_ref() != Some(default_line)
            {
                if overwrite && template_category.is_some() {
                    next = Some(default_line.clone());
                } else {
                    kept += 1;
                }
            }
        } else {
            next.clone_from(&default_line);
        }
        let reference =
            json!({ "accountId": account["id"], "code": account["code"], "name": account["name"] });
        if next == raw_current {
            unchanged += 1;
            let kind = account["type"].as_str().unwrap_or_default();
            if next.as_deref().is_none_or(str::is_empty)
                && kind != "asset"
                && kind != "liability"
                && kind != "equity"
            {
                unmapped.push(reference);
            }
            continue;
        }
        remaps.push((
            account["id"].as_str().unwrap_or_default().to_owned(),
            next.clone(),
        ));
        updated += 1;
        changes.push(json!({
            "accountId": account["id"],
            "code": account["code"],
            "name": account["name"],
            "from": raw_current,
            "to": next,
        }));
        if next.as_deref().is_none_or(str::is_empty) {
            unmapped.push(reference);
        }
    }
    let at = weldsuite_books_domain::http::now();
    for batch in remaps.chunks(100) {
        let batch = batch.to_vec();
        let at = at.clone();
        weldsuite_db::atomically_with(db, move |conn| {
            Box::pin(async move {
                for (id, tax_line) in batch {
                    sqlx::query("update accounts set tax_line = $1, updated_at = $2::timestamp where id = $3")
                        .bind(tax_line)
                        .bind(&at)
                        .bind(id)
                        .execute(&mut *conn)
                        .await?;
                }
                Ok::<_, sqlx::Error>(())
            })
        })
        .await?;
    }
    Ok(json!({
        "form": form,
        "formLabel": us::form_label(form),
        "taxYear": tax_year,
        "updated": updated,
        "unchanged": unchanged,
        "keptOverrides": kept,
        "changes": changes,
        "unmapped": unmapped,
    }))
}

/// `syncBrTaxProfiles(db, entityId, regime)`: the seeded Brazilian rates of
/// the regime on, the others off (and not default).
pub(crate) async fn sync_br_tax_profiles(
    db: &PgPool,
    entity_id: &str,
    classification: Option<&str>,
) -> Result<(), sqlx::Error> {
    let regime = br::regime_of(classification).to_owned();
    let rates: Vec<(String, Option<Value>)> = sqlx::query_as(
        "select id, jurisdiction_metadata from tax_rates where entity_id = $1 and deleted_at is null",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let at = weldsuite_books_domain::http::now();
    for (id, metadata) in rates {
        let Some(profile) = br::profile_of(metadata.as_ref()) else {
            continue;
        };
        let active = profile["regimes"]
            .as_array()
            .is_some_and(|r| r.iter().any(|v| v.as_str() == Some(regime.as_str())));
        sqlx::query(
            "update tax_rates set is_active = $1, is_default = case when $1 then is_default else false end, \
             updated_at = $2::timestamp where id = $3",
        )
        .bind(active)
        .bind(&at)
        .bind(id)
        .execute(db)
        .await?;
    }
    Ok(())
}

/// `EntityLockState`: `hasPostings`, `hasFiscalPeriods`, and what that freezes.
pub(crate) async fn lock_state(db: &PgPool, entity_id: &str) -> Result<Value, sqlx::Error> {
    let (has_postings, has_periods): (bool, bool) = sqlx::query_as(
        "select \
           exists (select 1 from journal_entries where entity_id = $1 and status <> 'draft' and deleted_at is null) \
           or exists (select 1 from invoices where entity_id = $1 and status <> 'draft' and deleted_at is null) \
           or exists (select 1 from bills where entity_id = $1 and status <> 'draft' and deleted_at is null) \
           or exists (select 1 from payments where entity_id = $1 and deleted_at is null) \
           or exists (select 1 from vat_returns where entity_id = $1 and status <> 'draft' and deleted_at is null), \
           exists (select 1 from fiscal_periods where entity_id = $1 and deleted_at is null)",
    )
    .bind(entity_id)
    .fetch_one(db)
    .await?;
    Ok(json!({
        "hasPostings": has_postings,
        "hasFiscalPeriods": has_periods,
        "baseSettingsLocked": has_postings,
        "fiscalYearLocked": has_postings || has_periods,
    }))
}
