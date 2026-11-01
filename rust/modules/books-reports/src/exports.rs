//! `/api/accounting-exports` (`routes/accounting-exports/index.ts` and
//! `services/accounting-xaf.ts`): the XAF 4.0 auditfile (Auditfile
//! Financieel) of an entity's fiscal year, produced on demand for a
//! Belastingdienst boekenonderzoek or an accountant.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use serde_json::Value;
use weldsuite_books_domain::address::normalize_postal_address;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, Reply, reply};
use weldsuite_books_domain::js::{days_from_civil, number_text, parse_int, to_fixed};
use weldsuite_books_domain::jurisdictions::{is_js_space, js_trim};
use weldsuite_books_domain::reports_basis::{iso, iso_day};
use weldsuite_books_domain::tables::{
    ACCOUNTS, ENTITIES, JOURNAL_ENTRIES, JOURNAL_LINES, TAX_RATES,
};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/xaf",
            get(xaf).route_layer(gate.require(["reports:read".to_owned()])),
        )
        .with_state(state)
}

// ---------------------------------------------------------------------------
// The auditfile
// ---------------------------------------------------------------------------

const XAF_NAMESPACE: &str = "http://www.auditfiles.nl/XAF/4.0";

/// `asText(value ?? '')`.
fn as_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(n)) => number_text(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    as_text(Some(item))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(other) => other.to_string(),
    }
}

fn esc(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// `tag(name, value)`: empty when the trimmed value is.
fn tag(name: &str, value: Option<&Value>) -> String {
    let text = as_text(value);
    let trimmed = js_trim(&text);
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("<{name}>{}</{name}>", esc(trimmed))
    }
}

fn tag_str(name: &str, value: Option<&str>) -> String {
    tag(name, value.map(|v| Value::String(v.to_owned())).as_ref())
}

/// `amount(value)`: `(Number(value) || 0).toFixed(2)`.
fn amount_of(value: f64) -> String {
    to_fixed(if value.is_nan() { 0.0 } else { value }, 2)
}

fn number_of(value: Option<&Value>) -> f64 {
    let n = weldsuite_books_domain::js::js_number_value(value);
    if n.is_nan() { 0.0 } else { n }
}

/// `HOUSE_NUMBER`: `/^\d[\w\-/]*$/`.
fn is_house_number(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/'))
}

/// `splitStreetLine(line)`: street name and house number ("Damrak 1",
/// "12 Linking Road"); a line without a number is all street name.
pub(crate) fn split_street_line(line: Option<&str>) -> (Option<String>, Option<String>) {
    let text = js_trim(line.unwrap_or_default());
    if text.is_empty() {
        return (None, None);
    }
    // Runs of `[\s,]`, as byte ranges.
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in text.char_indices() {
        let separator = is_js_space(c) || c == ',';
        match (separator, start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                runs.push((s, i));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        runs.push((s, text.len()));
    }
    let (Some(&first), Some(&last)) = (runs.first(), runs.last()) else {
        return (Some(text.to_owned()), None);
    };
    let trailing = &text[last.1..];
    if last.0 > 0 && is_house_number(trailing) {
        return (
            Some(js_trim(&text[..last.0]).to_owned()),
            Some(trailing.to_owned()),
        );
    }
    let leading = &text[..first.0];
    let rest = &text[first.1..];
    if !rest.is_empty() && is_house_number(leading) {
        return (Some(js_trim(rest).to_owned()), Some(leading.to_owned()));
    }
    (Some(text.to_owned()), None)
}

/// `streetAddressXml(address)`.
fn street_address_xml(
    line1: Option<&str>,
    line2: Option<&str>,
    city: Option<&str>,
    postal_code: Option<&str>,
    country: Option<&str>,
) -> String {
    let (streetname, number) = split_street_line(line1);
    let parts: Vec<String> = [
        tag_str("streetname", streetname.as_deref()),
        tag_str("number", number.as_deref()),
        tag_str("property", line2),
        tag_str("city", city),
        tag_str("postalCode", postal_code),
        tag_str("country", country),
    ]
    .into_iter()
    .filter(|p| !p.is_empty())
    .collect();
    if parts.is_empty() {
        return String::new();
    }
    format!(
        "<streetAddress>\n      {}\n    </streetAddress>",
        parts.join("\n      ")
    )
}

struct XafContact {
    id: String,
    name: String,
    role: Option<String>,
    tax_number: Option<String>,
    street: Option<String>,
    city: Option<String>,
    postal_code: Option<String>,
    country: Option<String>,
}

struct XafLine {
    account_code: String,
    description: Option<String>,
    debit: Option<Value>,
    credit: Option<Value>,
    contact_id: Option<String>,
    vat_code_id: Option<String>,
    vat_amount: Option<Value>,
}

struct XafTransaction {
    entry_number: String,
    date: String,
    description: Option<String>,
    lines: Vec<XafLine>,
}

struct XafInput<'a> {
    entity: &'a Value,
    fiscal_year: i64,
    start_date: &'a str,
    end_date: &'a str,
    generated_at: String,
    /// Account rows (`code`, `name`, `type`, `openingBalance`).
    accounts: &'a [Value],
    contacts: Vec<XafContact>,
    /// Tax rate rows (`id`, `name`).
    vat_codes: &'a [Value],
    transactions: Vec<XafTransaction>,
}

fn acc_type(account_type: &str) -> &'static str {
    match account_type {
        "asset" | "liability" | "equity" => "B",
        _ => "P",
    }
}

fn cust_sup_type(role: Option<&str>) -> &'static str {
    match role {
        Some("customer") => "C",
        Some("supplier") => "S",
        Some("both") => "B",
        _ => "O",
    }
}

/// `generateXaf(input)`.
#[allow(clippy::too_many_lines)] // one template, as TypeScript writes it
fn generate_xaf(input: &XafInput<'_>) -> String {
    let entity = input.entity;
    let text = |key: &str| entity.get(key).and_then(Value::as_str);
    let currency = text("baseCurrency")
        .filter(|c| !c.is_empty())
        .unwrap_or("EUR");

    let lines = || input.transactions.iter().flat_map(|t| &t.lines);
    let total_debit = lines().fold(0.0, |sum, l| sum + number_of(l.debit.as_ref()));
    let total_credit = lines().fold(0.0, |sum, l| sum + number_of(l.credit.as_ref()));
    let lines_count: usize = input.transactions.iter().map(|t| t.lines.len()).sum();

    let company_address =
        normalize_postal_address(entity.get("address")).map_or_else(String::new, |a| {
            let field = |key: &str| a.get(key).and_then(Value::as_str);
            street_address_xml(
                field("line1"),
                field("line2"),
                field("city"),
                field("postalCode"),
                field("country").or_else(|| text("jurisdictionCode")),
            )
        });

    let customers_suppliers: String = input
        .contacts
        .iter()
        .map(|contact| {
            format!(
                "\n      <customerSupplier>\n        {}\n        {}\n        {}\n        {}\n        {}\n      </customerSupplier>",
                tag_str("custSupID", Some(&contact.id)),
                tag_str("custSupName", Some(&contact.name)),
                tag_str("custSupTp", Some(cust_sup_type(contact.role.as_deref()))),
                tag_str("taxRegIdent", contact.tax_number.as_deref()),
                street_address_xml(
                    contact.street.as_deref(),
                    None,
                    contact.city.as_deref(),
                    contact.postal_code.as_deref(),
                    contact.country.as_deref(),
                ),
            )
        })
        .collect::<Vec<_>>()
        .concat();

    let account_text = |a: &Value, key: &str| a.get(key).and_then(Value::as_str).map(str::to_owned);
    let ledger_accounts: String = input
        .accounts
        .iter()
        .map(|a| {
            format!(
                "\n      <ledgerAccount>\n        {}\n        {}\n        {}\n      </ledgerAccount>",
                tag("accID", a.get("code")),
                tag("accDesc", a.get("name")),
                tag_str(
                    "accTp",
                    Some(acc_type(account_text(a, "type").as_deref().unwrap_or_default()))
                ),
            )
        })
        .collect::<Vec<_>>()
        .concat();

    let vat_codes: String = input
        .vat_codes
        .iter()
        .map(|v| {
            format!(
                "\n      <vatCode>\n        {}\n        {}\n      </vatCode>",
                tag("vatID", v.get("id")),
                tag("vatDesc", v.get("name")),
            )
        })
        .collect::<Vec<_>>()
        .concat();

    let opening = |a: &Value| weldsuite_books_domain::js::js_number_value(a.get("openingBalance"));
    let opening_balance_lines: String = input
        .accounts
        .iter()
        .filter(|a| opening(a) != 0.0 && !a.get("openingBalance").is_none_or(Value::is_null))
        .map(|a| {
            let balance = number_of(a.get("openingBalance"));
            let amount = if balance >= 0.0 {
                tag_str("debAmnt", Some(&amount_of(balance)))
            } else {
                tag_str("credAmnt", Some(&amount_of(-balance)))
            };
            format!(
                "\n      <obLine>\n        {}\n        {}\n        {}\n      </obLine>",
                tag("nr", a.get("code")),
                tag("accID", a.get("code")),
                amount,
            )
        })
        .collect::<Vec<_>>()
        .concat();
    let opening_count = input.accounts.iter().filter(|a| opening(a) != 0.0).count();

    let journal_transactions: String = input
        .transactions
        .iter()
        .enumerate()
        .map(|(tr_index, tr)| {
            let lines: String = tr
                .lines
                .iter()
                .enumerate()
                .map(|(line_index, line)| {
                    let debit = number_of(line.debit.as_ref());
                    let credit = number_of(line.credit.as_ref());
                    let vat = match line.vat_code_id.as_deref().filter(|id| !id.is_empty()) {
                        Some(id) => format!(
                            "\n            <vat>\n              {}\n              {}\n            </vat>",
                            tag_str("vatID", Some(id)),
                            tag_str("vatAmnt", Some(&amount_of(number_of(line.vat_amount.as_ref())))),
                        ),
                        None => String::new(),
                    };
                    format!(
                        "\n          <trLine>\n            {}\n            {}\n            {}\n            {}\n            {}\n            {}\n            {}\n            {}\n            {}\n          </trLine>",
                        tag_str("nr", Some(&(line_index + 1).to_string())),
                        tag_str("accID", Some(&line.account_code)),
                        tag_str("docRef", Some(&tr.entry_number)),
                        tag_str("effDate", Some(&tr.date)),
                        tag_str("desc", line.description.as_deref().or(tr.description.as_deref())),
                        if debit > 0.0 { tag_str("debAmnt", Some(&amount_of(debit))) } else { String::new() },
                        if credit > 0.0 { tag_str("credAmnt", Some(&amount_of(credit))) } else { String::new() },
                        match line.contact_id.as_deref().filter(|id| !id.is_empty()) {
                            Some(id) => tag_str("custSupID", Some(id)),
                            None => String::new(),
                        },
                        vat,
                    )
                })
                .collect::<Vec<_>>()
                .concat();
            format!(
                "\n        <transaction>\n          {}\n          {}\n          {}\n          {}\n        </transaction>",
                tag_str("nr", Some(&(tr_index + 1).to_string())),
                tag_str("desc", tr.description.as_deref()),
                tag_str("trDt", Some(&tr.date)),
                lines,
            )
        })
        .collect::<Vec<_>>()
        .concat();

    let ids = entity.get("taxIdentifiers");
    let fiscal_year = input.fiscal_year.to_string();
    let company_name = entity
        .get("legalName")
        .filter(|v| !v.is_null())
        .or_else(|| entity.get("name"));
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<auditfile xmlns=\"{XAF_NAMESPACE}\">
  <header>
    {}
    {}
    {}
    {}
    {}
    {}
    {}
  </header>
  <company>
    {}
    {}
    {}
    {}
    {company_address}
    <customersSuppliers>{customers_suppliers}
    </customersSuppliers>
    <generalLedger>{ledger_accounts}
    </generalLedger>
    <vatCodes>{vat_codes}
    </vatCodes>
    <periods>
      <period>
        {}
        {}
        {}
        {}
      </period>
    </periods>
    <openingBalance>
      {}
      {}
      {opening_balance_lines}
    </openingBalance>
    <transactions>
      {}
      {}
      {}
      <journal>
        {}
        {}
        {}
        {journal_transactions}
      </journal>
    </transactions>
  </company>
</auditfile>",
        tag_str("fiscalYear", Some(&fiscal_year)),
        tag_str("startDate", Some(input.start_date)),
        tag_str("endDate", Some(input.end_date)),
        tag_str("curCode", Some(currency)),
        tag_str("dateCreated", Some(&input.generated_at)),
        tag_str("softwareDesc", Some("WeldBooks (WeldSuite)")),
        tag_str("softwareVersion", Some("1.0")),
        tag(
            "companyIdent",
            ids.and_then(|ids| ids.get("registrationNumber"))
        ),
        tag("companyName", company_name),
        tag("taxRegistrationCountry", entity.get("jurisdictionCode")),
        tag("taxRegIdent", ids.and_then(|ids| ids.get("vatNumber"))),
        tag_str("periodNumber", Some("1")),
        tag_str("periodDesc", Some(&format!("Boekjaar {fiscal_year}"))),
        tag_str("startDatePeriod", Some(input.start_date)),
        tag_str("endDatePeriod", Some(input.end_date)),
        tag_str("opBalDate", Some(input.start_date)),
        tag_str("linesCount", Some(&opening_count.to_string())),
        tag_str("linesCount", Some(&lines_count.to_string())),
        tag_str("totalDebit", Some(&amount_of(total_debit))),
        tag_str("totalCredit", Some(&amount_of(total_credit))),
        tag_str("jrnID", Some("MEMO")),
        tag_str("desc", Some("WeldBooks journal")),
        tag_str("jrnTp", Some("Z")),
    )
}

/// id, display name, role, billing address and the company VAT number of a party.
type PartyRow = (
    String,
    Option<String>,
    Option<String>,
    Option<Value>,
    Option<String>,
);

// ---------------------------------------------------------------------------
// GET /xaf
// ---------------------------------------------------------------------------

async fn xaf(caller: Caller) -> Response {
    // `Number.parseInt(c.req.query('fiscalYear') || '', 10)`
    let fiscal_year = caller
        .query()
        .get("fiscalYear")
        .and_then(parse_int)
        .filter(|year| *year != 0 && (2000..=2100).contains(year));
    let Some(fiscal_year) = fiscal_year else {
        return Refusal::bad_request(
            "fiscalYear query parameter is required (e.g. ?fiscalYear=2026)",
        )
        .respond("");
    };
    reply(
        export_xaf(&caller, fiscal_year).await,
        "Failed to generate XAF auditfile",
    )
}

#[allow(clippy::too_many_lines)] // the route's one handler
async fn export_xaf(caller: &Caller, fiscal_year: i64) -> Reply {
    let db = &caller.db;
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let entity: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(entities),
        " from entities t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(&entity_id)
    .fetch_optional(db)
    .await?;
    let Some(entity) = entity.map(|row| ENTITIES.js(row)) else {
        return Err(Refusal::not_found("Entity", &entity_id));
    };

    // The fiscal year from the entity's start month.
    let start_month = entity
        .get("fiscalYearStart")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        - 1;
    let utc = |year: i64, month_index: i64| {
        let index = year * 12 + month_index;
        days_from_civil(index.div_euclid(12), index.rem_euclid(12) + 1, 1) * 86_400_000
    };
    let start = utc(fiscal_year, start_month);
    let end = utc(fiscal_year + 1, start_month) - 86_400_000;
    let start_date = iso_day(start);
    let end_date = iso_day(end);

    // The relations of this entity: customers and suppliers on one of its
    // invoices, bills, payments or journal lines.
    let mut contact_ids: Vec<String> = Vec::new();
    for sql in [
        "select contact_id from invoices where entity_id = $1 and deleted_at is null",
        "select contact_id from bills where entity_id = $1 and deleted_at is null",
        "select contact_id from payments where entity_id = $1 and deleted_at is null",
        "select contact_id from journal_lines where entity_id = $1 and deleted_at is null",
    ] {
        let ids: Vec<Option<String>> = sqlx::query_scalar(sql)
            .bind(&entity_id)
            .fetch_all(db)
            .await?;
        for id in ids.into_iter().flatten().filter(|id| !id.is_empty()) {
            if !contact_ids.contains(&id) {
                contact_ids.push(id);
            }
        }
    }

    let accounts: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(accounts),
        " from accounts t where t.entity_id = $1 and t.deleted_at is null order by t.code asc"
    ))
    .bind(&entity_id)
    .fetch_all(db)
    .await?;
    let accounts = ACCOUNTS.js_rows(accounts);
    let parties: Vec<PartyRow> = if contact_ids.is_empty() {
        Vec::new()
    } else {
        // Only what the auditfile prints: the party row also holds ciphertext.
        sqlx::query_as(
            "select p.id, p.display_name, p.role, p.billing_address, c.vat_number \
             from parties p left join companies c on p.company_id = c.id \
             where p.id = any($1::text[]) and p.deleted_at is null order by p.display_name asc",
        )
        .bind(&contact_ids)
        .fetch_all(db)
        .await?
    };
    let tax_rates: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(tax_rates),
        " from tax_rates t where t.entity_id = $1 and t.deleted_at is null"
    ))
    .bind(&entity_id)
    .fetch_all(db)
    .await?;
    let tax_rates = TAX_RATES.js_rows(tax_rates);
    let entries: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(journal_entries),
        " from journal_entries t where t.entity_id = $1 and t.status in ('posted', 'reversed') \
         and t.deleted_at is null and t.date >= $2::timestamp and t.date <= $3::timestamp \
         order by t.date asc"
    ))
    .bind(&entity_id)
    .bind(iso(start))
    .bind(iso(end))
    .fetch_all(db)
    .await?;

    let code_by_id: HashMap<String, String> = accounts
        .iter()
        .filter_map(|a| Some((a["id"].as_str()?.to_owned(), a["code"].as_str()?.to_owned())))
        .collect();
    let mut transactions = Vec::with_capacity(entries.len());
    for entry in entries {
        let entry = JOURNAL_ENTRIES.js(entry);
        let entry_id = entry["id"].as_str().unwrap_or_default().to_owned();
        let lines: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(journal_lines),
            " from journal_lines t where t.journal_entry_id = $1 and t.deleted_at is null \
             order by t.sort_order asc"
        ))
        .bind(&entry_id)
        .fetch_all(db)
        .await?;
        let text = |row: &Value, key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
        transactions.push(XafTransaction {
            entry_number: text(&entry, "entryNumber").unwrap_or_else(|| entry_id.clone()),
            date: entry["date"]
                .as_str()
                .map(|d| d.chars().take(10).collect())
                .unwrap_or_default(),
            description: text(&entry, "description"),
            lines: JOURNAL_LINES
                .js_rows(lines)
                .iter()
                .map(|line| {
                    let account_id = text(line, "accountId").unwrap_or_default();
                    XafLine {
                        account_code: code_by_id.get(&account_id).cloned().unwrap_or(account_id),
                        description: text(line, "description"),
                        debit: line.get("debit").cloned(),
                        credit: line.get("credit").cloned(),
                        contact_id: text(line, "contactId"),
                        vat_code_id: text(line, "taxRateId"),
                        vat_amount: line.get("taxAmount").cloned(),
                    }
                })
                .collect(),
        });
    }

    let contacts = parties
        .into_iter()
        .map(|(id, name, role, billing_address, vat_number)| {
            let address = normalize_postal_address(billing_address.as_ref());
            let field = |key: &str| {
                address
                    .as_ref()
                    .and_then(|a| a.get(key))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            };
            XafContact {
                name: name.unwrap_or_else(|| id.clone()),
                id,
                role,
                tax_number: vat_number,
                street: field("line1"),
                city: field("city"),
                postal_code: field("postalCode"),
                country: field("country"),
            }
        })
        .collect();

    let xml = generate_xaf(&XafInput {
        entity: &entity,
        fiscal_year,
        start_date: &start_date,
        end_date: &end_date,
        generated_at: weldsuite_books_domain::http::now()
            .chars()
            .take(10)
            .collect(),
        accounts: &accounts,
        contacts,
        vat_codes: &tax_rates,
        transactions,
    });

    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "accounting_export",
            entity_id: &format!("xaf-{fiscal_year}"),
            action: "exported",
            changes: None,
        },
    )
    .await;

    let name: String = entity
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .flat_map(|c| {
            let keep = c.is_ascii_alphanumeric() || c == '-';
            std::iter::repeat_n(
                if keep { c } else { '_' },
                if keep { 1 } else { c.len_utf16() },
            )
        })
        .collect();
    Ok((
        [
            (CONTENT_TYPE, "application/xml".to_owned()),
            (
                CONTENT_DISPOSITION,
                format!("attachment; filename=\"auditfile-{fiscal_year}-{name}.xaf\""),
            ),
        ],
        xml,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn street_lines_split_into_name_and_number() {
        assert_eq!(
            split_street_line(Some("Damrak 1")),
            (Some("Damrak".to_owned()), Some("1".to_owned()))
        );
        assert_eq!(
            split_street_line(Some("12 Linking Road")),
            (Some("Linking Road".to_owned()), Some("12".to_owned()))
        );
        assert_eq!(
            split_street_line(Some("Main Street")),
            (Some("Main Street".to_owned()), None)
        );
        assert_eq!(split_street_line(Some("  ")), (None, None));
    }

    #[test]
    fn tags_escape_and_drop_empty_values() {
        assert_eq!(tag_str("a", Some(" x & y ")), "<a>x &amp; y</a>");
        assert_eq!(tag_str("a", Some("  ")), "");
        assert_eq!(tag("a", None), "");
    }
}
