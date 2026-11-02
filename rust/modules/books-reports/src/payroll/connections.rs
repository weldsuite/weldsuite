//! `/api/payroll/connections` (`routes/payroll/connections.ts`,
//! `services/payroll/{connections,gusto}.ts`): the Gusto connection and the
//! sync that turns each processed payroll into one journal entry.
//!
//! The access token is stored encrypted (`credentialsEncrypted`, as
//! `{ accessToken, environment }`) and never returned or put on an event.
//! Gusto is called through the request's outbound HTTP (the test's `fetch`
//! in conformance).

use std::fmt::Write as _;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, created, no_content, now, ok, paged, validate,
};
use weldsuite_books_domain::payroll::{
    AccountMapping, PayrollError, PostPayrollArgs, find_import_by_external_id, post_payroll_import,
};
use weldsuite_books_domain::posting::{PostError, load_entity_accounts};
use weldsuite_books_domain::tables::PAYROLL_CONNECTIONS;
use weldsuite_catalogs::entity_events::{
    PAYROLL_CONNECTION_CREATED, PAYROLL_CONNECTION_DELETED, PAYROLL_CONNECTION_UPDATED,
    PAYROLL_IMPORT_CREATED,
};
use weldsuite_db::{Keyring, decrypt_field, encrypt_field};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_ports::{HttpRequest, OutboundHttp};

use super::journal::{Totals, build_payroll_lines, payroll_error};
use super::mapping::{Deferred, read_account_record};
use super::{Fail, fail};

const GUSTO_API_VERSION: &str = "2024-04-01";

/// `GustoCredentials`.
struct Credentials {
    access_token: String,
    environment: &'static str,
}

fn base_url(environment: &str) -> &'static str {
    if environment == "demo" {
        "https://api.gusto-demo.com"
    } else {
        "https://api.gusto.com"
    }
}

/// `parseCredentials(plain)`.
fn parse_credentials(plain: &str) -> Result<Credentials, Fail> {
    let parsed: Value = serde_json::from_str(plain)
        .map_err(|error| Fail::Refusal(Refusal::Internal(error.to_string())))?;
    let token = parsed
        .get("accessToken")
        .filter(|t| weldsuite_books_domain::js::truthy(Some(t)))
        .ok_or_else(|| {
            Fail::Post(payroll_error(
                "The stored Gusto credentials are unreadable; reconnect Gusto",
            ))
        })?;
    Ok(Credentials {
        access_token: token
            .as_str()
            .map_or_else(|| token.to_string(), str::to_owned),
        environment: if parsed.get("environment").and_then(Value::as_str) == Some("demo") {
            "demo"
        } else {
            "production"
        },
    })
}

/// `encodeURIComponent` of a path segment.
fn encode_segment(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `URLSearchParams` encoding of a query value.
fn encode_query(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"*-._".contains(&byte) {
            out.push(char::from(byte));
        } else if byte == b' ' {
            out.push('+');
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `gustoGet(credentials, path, params)`.
async fn gusto_get(
    http: Option<&OutboundHttp>,
    credentials: &Credentials,
    path: &str,
    params: &[(&str, String)],
) -> Result<Value, Fail> {
    let Some(http) = http else {
        return Err(Fail::Refusal(Refusal::Internal(
            "no outbound HTTP client".to_owned(),
        )));
    };
    let mut url = format!("{}{path}", base_url(credentials.environment));
    if !params.is_empty() {
        let query: Vec<String> = params
            .iter()
            .map(|(k, v)| format!("{}={}", encode_query(k), encode_query(v)))
            .collect();
        url = format!("{url}?{}", query.join("&"));
    }
    let request = HttpRequest::empty("GET", url)
        .header(
            "Authorization",
            format!("Bearer {}", credentials.access_token),
        )
        .header("Accept", "application/json")
        .header("X-Gusto-API-Version", GUSTO_API_VERSION);
    let response = http
        .send(request)
        .await
        .map_err(|error| Fail::Refusal(Refusal::Internal(error.to_string())))?;
    if !response.ok() {
        let body = weldsuite_books_domain::js::slice_utf16(&response.text(), 300);
        let (status, message) = match response.status {
            401 => (
                401,
                "Gusto rejected the access token (expired or revoked)".to_owned(),
            ),
            403 => (
                403,
                "The Gusto access token does not allow reading this company or its payrolls"
                    .to_owned(),
            ),
            404 => (404, "Gusto does not know this company id".to_owned()),
            status => (
                status,
                if body.is_empty() {
                    format!("Gusto answered {status}")
                } else {
                    format!("Gusto answered {status}: {body}")
                },
            ),
        };
        return Err(Fail::Gusto { status, message });
    }
    serde_json::from_slice(&response.body)
        .map_err(|error| Fail::Refusal(Refusal::Internal(error.to_string())))
}

/// `payrollIdOf(payroll)`.
fn payroll_id_of(payroll: &Value) -> Option<String> {
    let record = payroll.as_object()?;
    let id = ["payroll_uuid", "uuid", "payroll_id", "id"]
        .iter()
        .find_map(|key| record.get(*key).filter(|v| !v.is_null()))?;
    match id {
        Value::String(text) if text.is_empty() => None,
        Value::String(text) => Some(text.clone()),
        Value::Number(n) => Some(weldsuite_books_domain::js::number_text(
            n.as_f64().unwrap_or(f64::NAN),
        )),
        other => Some(other.to_string()),
    }
}

/// `fetchProcessedPayrolls(credentials, companyId, range)`.
async fn fetch_processed_payrolls(
    http: Option<&OutboundHttp>,
    credentials: &Credentials,
    company_id: &str,
    from: &str,
    to: &str,
) -> Result<Vec<Value>, Fail> {
    let path = format!("/v1/companies/{}/payrolls", encode_segment(company_id));
    let mut all = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let per_page = 100;
    for page in 1..=50 {
        let body = gusto_get(
            http,
            credentials,
            &path,
            &[
                ("processed", "true".to_owned()),
                ("processing_statuses", "processed".to_owned()),
                ("include_off_cycle", "true".to_owned()),
                ("start_date", from.to_owned()),
                ("end_date", to.to_owned()),
                ("include", "totals".to_owned()),
                ("page", page.to_string()),
                ("per", per_page.to_string()),
            ],
        )
        .await?;
        let items = body.as_array().cloned().unwrap_or_default();
        let mut fresh = 0;
        for item in &items {
            let id = payroll_id_of(item).unwrap_or_else(|| item.to_string());
            if seen.contains(&id) {
                continue;
            }
            seen.push(id);
            all.push(item.clone());
            fresh += 1;
        }
        if items.len() < per_page || fresh == 0 {
            break;
        }
    }
    Ok(all)
}

/// `toNumber(value)`.
fn to_number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().filter(|n| n.is_finite()).unwrap_or(0.0),
        Some(Value::String(text))
            if !weldsuite_books_domain::jurisdictions::js_trim(text).is_empty() =>
        {
            let parsed = weldsuite_kit::validation::js_number(text);
            if parsed.is_finite() { parsed } else { 0.0 }
        }
        _ => 0.0,
    }
}

/// `/^\d{4}-\d{2}-\d{2}/`
fn starts_with_day(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() >= 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[..10]
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// A Gusto payroll as WeldBooks totals (`normalizeGustoPayroll`).
enum Normalized {
    Skip {
        reason: &'static str,
        external_id: Option<String>,
    },
    Payroll {
        external_id: String,
        pay_date: String,
        period_start: Option<String>,
        period_end: Option<String>,
        off_cycle: bool,
        totals: Totals,
    },
}

/// `String(value)` of a JSON value.
fn js_string_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(n) => weldsuite_books_domain::js::number_text(n.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".to_owned(),
        Value::Array(items) => items
            .iter()
            .map(|i| {
                if i.is_null() {
                    String::new()
                } else {
                    js_string_of(i)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn normalize_gusto_payroll(payroll: &Value) -> Normalized {
    let external_id = payroll_id_of(payroll);
    let (Some(external_id), Some(record)) = (external_id.clone(), payroll.as_object()) else {
        return Normalized::Skip {
            reason: "The payroll has no id",
            external_id,
        };
    };
    if record.get("processed") == Some(&Value::Bool(false)) {
        return Normalized::Skip {
            reason: "The payroll is not processed yet",
            external_id: Some(external_id),
        };
    }
    let Some(totals) = record
        .get("totals")
        .filter(|t| t.is_object() || t.is_array())
    else {
        return Normalized::Skip {
            reason: "The payroll has no totals",
            external_id: Some(external_id),
        };
    };
    let check_date = record
        .get("check_date")
        .filter(|v| !v.is_null())
        .or_else(|| record.get("pay_date").filter(|v| !v.is_null()))
        .map_or_else(String::new, js_string_of);
    if !starts_with_day(&check_date) {
        return Normalized::Skip {
            reason: "The payroll has no check date",
            external_id: Some(external_id),
        };
    }
    let period = record.get("pay_period").filter(|v| !v.is_null());
    let day = |key: &str| {
        period
            .and_then(|p| p.get(key))
            .and_then(Value::as_str)
            .filter(|v| starts_with_day(v))
            .map(|v| v[..10].to_owned())
    };
    let total = |key: &str| to_number(totals.get(key));
    Normalized::Payroll {
        pay_date: check_date[..10].to_owned(),
        period_start: day("start_date"),
        period_end: day("end_date"),
        off_cycle: record.get("off_cycle") == Some(&Value::Bool(true)),
        totals: Totals {
            gross_wages: total("gross_pay"),
            employer_taxes: total("employer_taxes"),
            employer_benefits: total("benefits"),
            reimbursements: total("reimbursements"),
            owners_draw: total("owners_draw"),
            employee_taxes: total("employee_taxes"),
            employee_deductions: total("employee_benefits_deductions") + total("other_deductions"),
            net_pay: total("net_pay"),
        },
        external_id,
    }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/// `publicConnection(row, keyring)`: no ciphertext; whether there are
/// credentials and for which environment.
fn public_connection(row: &Value, keyring: &Keyring) -> Value {
    let encrypted = row
        .get("credentialsEncrypted")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty());
    let environment = encrypted.and_then(|sealed| {
        let plain = decrypt_field(sealed, keyring).ok()?;
        parse_credentials(&plain).ok().map(|c| c.environment)
    });
    let mut public = row.clone();
    if let Some(object) = public.as_object_mut() {
        object.remove("credentialsEncrypted");
        object.insert("hasCredentials".to_owned(), json!(encrypted.is_some()));
        object.insert("environment".to_owned(), json!(environment));
    }
    public
}

/// What events and audit see of a connection: no credentials, no mapping.
fn event_data(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "entityId": row["entityId"],
        "provider": row["provider"],
        "providerCompanyId": row["providerCompanyId"],
        "status": row["status"],
    })
}

/// `loadConnection(db, id)`: a connection that isn't deleted.
async fn load_connection(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payroll_connections),
        " from payroll_connections t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(|row| PAYROLL_CONNECTIONS.js(row)))
}

/// A provider connection this route serves (`csv` is the saved mapping's).
async fn provider_connection(caller: &Caller, id: &str) -> Result<Value, Fail> {
    match load_connection(caller, id).await? {
        Some(row) if row["provider"].as_str() != Some("csv") => Ok(row),
        _ => Err(Fail::Refusal(Refusal::not_found("Payroll connection", id))),
    }
}

/// `assertMappingAccounts(db, entityId, mapping)`.
async fn assert_mapping_accounts(
    caller: &Caller,
    entity_id: &str,
    mapping: &AccountMapping,
) -> Result<(), PostError> {
    let accounts = load_entity_accounts(&caller.db, entity_id).await?;
    for (category, account_id) in mapping {
        if accounts.by_id(Some(account_id)).is_none() {
            return Err(payroll_error(format!(
                "The account mapped to {category} does not belong to this accounting entity"
            )));
        }
    }
    Ok(())
}

fn mapping_json(mapping: &AccountMapping) -> Value {
    Value::Object(mapping.iter().map(|(k, v)| (k.clone(), json!(v))).collect())
}

fn mapping_of(value: Option<&Value>) -> AccountMapping {
    value
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        v.as_str().map_or_else(|| v.to_string(), str::to_owned),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

fn keyring_or_none(caller: &Caller, state: &BooksState) -> Option<Keyring> {
    let keyring = caller.keyring(state);
    (keyring.v1.is_some() || keyring.v2.is_some()).then_some(keyring)
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

pub(super) async fn list(caller: Caller, State(state): State<BooksState>) -> Response {
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Ok(paged(Vec::new(), 0, false, None));
        };
        let keyring = caller.keyring(&state);
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(payroll_connections),
            " from payroll_connections t where t.entity_id = $1 and t.deleted_at is null \
             and t.provider <> 'csv' order by t.created_at desc, t.id desc"
        ))
        .bind(&entity_id)
        .fetch_all(&caller.db)
        .await?;
        let data: Vec<Value> = PAYROLL_CONNECTIONS
            .js_rows(rows)
            .iter()
            .map(|row| public_connection(row, &keyring))
            .collect();
        let total = i64::try_from(data.len()).unwrap_or(0);
        Ok(paged(data, total, false, None))
    }
    .await;
    fail(result, "list payroll connections")
}

/// `createSchema`.
struct CreateBody {
    access_token: String,
    company_id: String,
    environment: String,
    account_mapping: Option<AccountMapping>,
}

fn read_create(issues: &mut Issues, body: &Map<String, Value>) -> Option<CreateBody> {
    let provider = match body.get("provider") {
        Some(Value::String(p)) if p == "gusto" => Some(()),
        value => {
            // `z.literal('gusto')`: undefined is just another wrong value.
            let mut issue = json!({ "code": "invalid_literal", "expected": "gusto", "message": "Invalid literal value, expected \"gusto\"" });
            if let Some(value) = value {
                issue["received"] = value.clone();
            }
            issues.issue_at("provider", issue);
            None
        }
    };
    let access_token = issues
        .text_with(
            body,
            "accessToken",
            Presence::Required,
            Text::trimmed(Some(10), Some(4000)),
        )
        .into_option();
    let company_id = issues
        .text_with(
            body,
            "companyId",
            Presence::Required,
            Text::trimmed(Some(1), Some(100)),
        )
        .into_option();
    let environment = match issues.choice(
        body,
        "environment",
        Presence::Optional,
        &["production", "demo"],
    ) {
        weldsuite_kit::validation::Field::Set(e) => Some(e),
        weldsuite_kit::validation::Field::Absent if !body.contains_key("environment") => {
            Some("production".to_owned())
        }
        _ => None,
    };
    let mut deferred = Deferred::new();
    let account_mapping = if body.contains_key("accountMapping") {
        read_account_record(
            issues,
            body,
            "accountMapping",
            Presence::Optional,
            true,
            &mut deferred,
        )
        .map(Some)
    } else {
        Some(None)
    };
    for (path, message) in &deferred {
        issues.custom_at(path, message);
    }
    provider?;
    Some(CreateBody {
        access_token: access_token?,
        company_id: company_id?,
        environment: environment?,
        account_mapping: account_mapping?,
    })
}

pub(super) async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_create) {
        Ok(Some(data)) => data,
        Ok(None) => {
            return Refusal::Internal("unreadable body".to_owned())
                .respond("Failed to connect Gusto");
        }
        Err(refusal) => return refusal.respond("Failed to connect Gusto"),
    };
    let result = async {
        let Some(keyring) = keyring_or_none(&caller, &state) else {
            return Err(Fail::Refusal(Refusal::unavailable(
                "No encryption key is configured, so credentials cannot be stored",
            )));
        };
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(Fail::Refusal(Refusal::bad_request(
                "No accounting entity resolved",
            )));
        };
        let existing: Option<String> = sqlx::query_scalar(
            "select id from payroll_connections where entity_id = $1 and provider = 'gusto' \
             and provider_company_id = $2 and deleted_at is null limit 1",
        )
        .bind(&entity_id)
        .bind(&data.company_id)
        .fetch_optional(&caller.db)
        .await?;
        if existing.is_some() {
            return Err(Fail::Post(payroll_error(
                "This Gusto company is already connected to this accounting entity",
            )));
        }
        let credentials = Credentials {
            access_token: data.access_token.clone(),
            environment: if data.environment == "demo" {
                "demo"
            } else {
                "production"
            },
        };
        // Verifies the token and the company id before anything is stored.
        let http = caller.http(&state);
        gusto_get(
            http.as_ref(),
            &credentials,
            &format!("/v1/companies/{}", encode_segment(&data.company_id)),
            &[],
        )
        .await?;
        if let Some(mapping) = &data.account_mapping {
            assert_mapping_accounts(&caller, &entity_id, mapping).await?;
        }
        let plain = format!(
            "{{\"accessToken\":{},\"environment\":{}}}",
            Value::String(credentials.access_token.clone()),
            Value::String(credentials.environment.to_owned())
        );
        let sealed = encrypt_field(&plain, &keyring)
            .map_err(|error| Fail::Refusal(Refusal::Internal(error.to_string())))?;
        let at = now();
        let row = json!({
            "id": weldsuite_kit::generate_id("prc"),
            "createdAt": at,
            "updatedAt": at,
            "deletedAt": null,
            "entityId": entity_id,
            "provider": "gusto",
            "providerCompanyId": data.company_id,
            "credentialsEncrypted": sealed,
            "accountMapping": data.account_mapping.as_ref().map(mapping_json),
            "status": "active",
            "lastSyncedAt": null,
            "lastError": null,
        });
        PAYROLL_CONNECTIONS
            .insert_raw(
                &caller.db,
                PAYROLL_CONNECTIONS.values(row.as_object().expect("an object")),
            )
            .await
            .map_err(Refusal::from)?;
        let id = row["id"].as_str().unwrap_or_default().to_owned();
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&entity_id),
                entity_type: "payroll_connection",
                entity_id: &id,
                action: "created",
                changes: None,
            },
        )
        .await;
        caller.publish(&state, PAYROLL_CONNECTION_CREATED, &id, event_data(&row));
        Ok(created(public_connection(&row, &keyring)))
    }
    .await;
    fail(result, "connect Gusto")
}

fn read_mapping_body(issues: &mut Issues, body: &Map<String, Value>) -> Option<AccountMapping> {
    let mut deferred = Deferred::new();
    let mapping = read_account_record(
        issues,
        body,
        "accountMapping",
        Presence::Required,
        true,
        &mut deferred,
    );
    for (path, message) in &deferred {
        issues.custom_at(path, message);
    }
    mapping
}

pub(super) async fn set_mapping(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let what = "save the payroll account mapping";
    let mapping = match validate(&headers, &body, read_mapping_body) {
        Ok(Some(mapping)) => mapping,
        Ok(None) => {
            return Refusal::Internal("unreadable body".to_owned())
                .respond(&format!("Failed to {what}"));
        }
        Err(refusal) => return refusal.respond(&format!("Failed to {what}")),
    };
    let result = async {
        let connection = provider_connection(&caller, &id).await?;
        let entity_id = connection["entityId"].as_str().unwrap_or_default().to_owned();
        assert_mapping_accounts(&caller, &entity_id, &mapping).await?;
        let at = now();
        let new_mapping = mapping_json(&mapping);
        sqlx::query(
            "update payroll_connections set account_mapping = $1, updated_at = $2::timestamp where id = $3",
        )
        .bind(&new_mapping)
        .bind(&at)
        .bind(&id)
        .execute(&caller.db)
        .await?;
        let mut row = connection.clone();
        row["accountMapping"] = new_mapping.clone();
        row["updatedAt"] = json!(at);
        let mut changes = Map::new();
        changes.insert(
            "accountMapping".to_owned(),
            change(connection["accountMapping"].clone(), new_mapping),
        );
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&entity_id),
                entity_type: "payroll_connection",
                entity_id: &id,
                action: "updated",
                changes: Some(changes),
            },
        )
        .await;
        caller.publish(&state, PAYROLL_CONNECTION_UPDATED, &id, event_data(&row));
        Ok(ok(public_connection(&row, &caller.keyring(&state))))
    }
    .await;
    fail(result, what)
}

/// `syncSchema`: `{ from?, to? }`, each `YYYY-MM-DD`.
fn read_sync(issues: &mut Issues, body: &Map<String, Value>) -> (Option<String>, Option<String>) {
    let day = |issues: &mut Issues, key: &str| {
        issues
            .pattern(
                body,
                key,
                Presence::Optional,
                None,
                None,
                is_day,
                "Use YYYY-MM-DD",
            )
            .into_option()
    };
    let from = day(issues, "from");
    let to = day(issues, "to");
    (from, to)
}

fn is_day(text: &str) -> bool {
    text.len() == 10 && starts_with_day(text)
}

/// `daysBefore(day, days)`.
fn days_before(day: &str, days: i64) -> String {
    let millis = weldsuite_books_domain::js::js_date_millis(&format!("{day}T00:00:00.000Z"));
    millis
        .and_then(|m| weldsuite_books_domain::js::iso_from_millis(m - days * 86_400_000))
        .map(|iso| iso[..10].to_owned())
        .unwrap_or_default()
}

/// `windows(from, to)`: at most one year each.
fn windows(from: &str, to: &str) -> Vec<(String, String)> {
    let mut result = Vec::new();
    let mut start = from.to_owned();
    while start.as_str() <= to && result.len() < 1000 {
        let year: i64 = start.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(0);
        let next = days_before(
            &format!("{}{}", year + 1, start.get(4..).unwrap_or_default()),
            1,
        );
        let end = if next.as_str() < to {
            next
        } else {
            to.to_owned()
        };
        result.push((start.clone(), end.clone()));
        start = days_before(&end, -1);
        if start.is_empty() {
            break;
        }
    }
    result
}

async fn set_connection_error(caller: &Caller, id: &str, message: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update payroll_connections set status = 'error', last_error = $1, updated_at = $2::timestamp where id = $3",
    )
    .bind(message)
    .bind(now())
    .bind(id)
    .execute(&caller.db)
    .await?;
    Ok(())
}

#[allow(clippy::too_many_lines)] // `syncGustoConnection` and the route, step for step
pub(super) async fn sync(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let what = "sync Gusto payrolls";
    let (from_arg, to_arg) = match validate(&headers, &body, read_sync) {
        Ok(range) => range,
        Err(refusal) => return refusal.respond(&format!("Failed to {what}")),
    };
    let result = async {
        let Some(keyring) = keyring_or_none(&caller, &state) else {
            return Err(Fail::Refusal(Refusal::unavailable(
                "No encryption key is configured, so credentials cannot be read",
            )));
        };
        let connection = provider_connection(&caller, &id).await?;
        let entity_id = connection["entityId"].as_str().unwrap_or_default().to_owned();

        if connection["provider"].as_str() != Some("gusto") {
            return Err(Fail::Post(payroll_error("Only Gusto connections can sync")));
        }
        let sealed = connection["credentialsEncrypted"].as_str().filter(|c| !c.is_empty());
        let company_id = connection["providerCompanyId"].as_str().filter(|c| !c.is_empty());
        let (Some(sealed), Some(company_id)) = (sealed, company_id) else {
            return Err(Fail::Post(payroll_error(
                "The Gusto connection has no credentials; reconnect it",
            )));
        };
        let mapping = mapping_of(connection.get("accountMapping"));
        if !mapping.iter().any(|(k, v)| k == "net_pay" && !v.is_empty()) {
            return Err(Fail::Post(payroll_error(
                "Map the net pay account first (PUT /api/payroll/connections/:id/mapping with at least net_pay)",
            )));
        }
        let plain = decrypt_field(sealed, &keyring)
            .map_err(|error| Fail::Refusal(Refusal::Internal(error.to_string())))?;
        let credentials = parse_credentials(&plain)?;
        let today: String = now().chars().take(10).collect();
        let to = to_arg.clone().unwrap_or_else(|| today.clone());
        let from = from_arg.clone().unwrap_or_else(|| {
            connection["lastSyncedAt"]
                .as_str()
                .map_or_else(|| format!("{}-01-01", &today[..4]), |at| days_before(&at[..10], 30))
        });
        if from > to {
            return Err(Fail::Post(payroll_error("from must not be after to")));
        }
        let accounts = load_entity_accounts(&caller.db, &entity_id).await?;

        let http = caller.http(&state);
        let mut payrolls: Vec<Value> = Vec::new();
        for (start, end) in windows(&from, &to) {
            match fetch_processed_payrolls(http.as_ref(), &credentials, company_id, &start, &end).await {
                Ok(batch) => payrolls.extend(batch),
                Err(error) => {
                    let message = match &error {
                        Fail::Gusto { message, .. } => message.clone(),
                        Fail::Post(error) => error.to_string(),
                        Fail::Rows(_) => "invalid rows".to_owned(),
                        Fail::Refusal(refusal) => format!("{refusal:?}"),
                    };
                    set_connection_error(&caller, &id, &message).await?;
                    return Err(error);
                }
            }
        }

        let mut imported: Vec<(String, String, String, String)> = Vec::new();
        let mut skipped: Vec<Value> = Vec::new();
        let mut failed: Vec<(String, String, String)> = Vec::new();
        for raw in &payrolls {
            let (external_id, pay_date, period_start, period_end, off_cycle, totals) =
                match normalize_gusto_payroll(raw) {
                    Normalized::Skip { reason, external_id } => {
                        skipped.push(json!({ "externalId": external_id, "payDate": null, "reason": reason }));
                        continue;
                    }
                    Normalized::Payroll {
                        external_id,
                        pay_date,
                        period_start,
                        period_end,
                        off_cycle,
                        totals,
                    } => (external_id, pay_date, period_start, period_end, off_cycle, totals),
                };
            if let Some(existing) =
                find_import_by_external_id(&caller.db, &entity_id, "gusto", &external_id).await?
            {
                skipped.push(json!({
                    "externalId": external_id,
                    "payDate": pay_date,
                    "reason": if existing["status"].as_str() == Some("reversed") { "Already imported and reversed" } else { "Already imported" },
                }));
                continue;
            }
            let posted = match build_payroll_lines(
                &totals,
                &accounts,
                &mapping,
                &format!("Gusto payroll {pay_date}"),
            ) {
                Ok(lines) => {
                    post_payroll_import(
                        &caller.db,
                        PostPayrollArgs {
                            entity_id: entity_id.clone(),
                            user_id: Some(caller.user_id.clone()),
                            source: "gusto".to_owned(),
                            connection_id: Some(id.clone()),
                            external_id: external_id.clone(),
                            pay_date: pay_date.clone(),
                            period_start,
                            period_end,
                            lines,
                            summary: totals.summary_json(),
                            source_file_name: None,
                            description: format!(
                                "Gusto payroll {pay_date}{}",
                                if off_cycle { " (off-cycle)" } else { "" }
                            ),
                            reference: None,
                        },
                    )
                    .await
                }
                Err(error) => Err(PayrollError::Post(error)),
            };
            match posted {
                Ok(posted) => imported.push((
                    external_id,
                    pay_date,
                    posted.import_id,
                    posted.journal_entry_id,
                )),
                Err(PayrollError::Duplicate { .. }) => skipped.push(json!({
                    "externalId": external_id,
                    "payDate": pay_date,
                    "reason": "Already imported",
                })),
                Err(PayrollError::Post(error)) => match error.user_message() {
                    Some(message) => failed.push((external_id, pay_date, message)),
                    None => return Err(Fail::Post(error)),
                },
            }
        }

        let status = if !failed.is_empty() && imported.is_empty() {
            "error"
        } else {
            "active"
        };
        let last_error = failed.first().map(|(_, _, error)| {
            format!(
                "{} payroll(s) could not be imported: {error}",
                failed.len()
            )
        });
        let at = now();
        sqlx::query(
            "update payroll_connections set status = $1, last_synced_at = $2::timestamp, \
             last_error = $3, updated_at = $2::timestamp where id = $4",
        )
        .bind(status)
        .bind(&at)
        .bind(&last_error)
        .bind(&id)
        .execute(&caller.db)
        .await?;

        for (external_id, pay_date, import_id, journal_entry_id) in &imported {
            write_accounting_audit(
                &caller,
                &caller.db,
                AuditInput {
                    accounting_entity_id: Some(&entity_id),
                    entity_type: "payroll_import",
                    entity_id: import_id,
                    action: "created",
                    changes: None,
                },
            )
            .await;
            caller.publish(
                &state,
                PAYROLL_IMPORT_CREATED,
                import_id,
                json!({
                    "id": import_id,
                    "entityId": entity_id,
                    "source": "gusto",
                    "payDate": pay_date,
                    "status": "posted",
                    "journalEntryId": journal_entry_id,
                }),
            );
            let _ = external_id;
        }
        Ok(ok(json!({
            "from": from,
            "to": to,
            "fetched": payrolls.len(),
            "imported": imported.iter().map(|(external_id, pay_date, import_id, journal_entry_id)| json!({
                "externalId": external_id,
                "payDate": pay_date,
                "importId": import_id,
                "journalEntryId": journal_entry_id,
            })).collect::<Vec<_>>(),
            "skipped": skipped,
            "failed": failed.iter().map(|(external_id, pay_date, error)| json!({
                "externalId": external_id,
                "payDate": pay_date,
                "error": error,
            })).collect::<Vec<_>>(),
        })))
    }
    .await;
    fail(result, what)
}

pub(super) async fn disconnect(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let connection = provider_connection(&caller, &id).await?;
        let at = now();
        sqlx::query(
            "update payroll_connections set deleted_at = $1::timestamp, status = 'disconnected', \
             credentials_encrypted = null, updated_at = $1::timestamp where id = $2",
        )
        .bind(&at)
        .bind(&id)
        .execute(&caller.db)
        .await?;
        let entity_id = connection["entityId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&entity_id),
                entity_type: "payroll_connection",
                entity_id: &id,
                action: "deleted",
                changes: None,
            },
        )
        .await;
        let mut data = event_data(&connection);
        data["status"] = json!("disconnected");
        caller.publish(&state, PAYROLL_CONNECTION_DELETED, &id, data);
        Ok(no_content())
    }
    .await;
    fail(result, "disconnect the payroll connection")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_windows_are_at_most_a_year() {
        assert_eq!(
            windows("2025-03-01", "2026-06-30"),
            vec![
                ("2025-03-01".to_owned(), "2026-02-28".to_owned()),
                ("2026-03-01".to_owned(), "2026-06-30".to_owned()),
            ]
        );
    }

    #[test]
    fn gusto_payrolls_become_totals() {
        let payroll = json!({ "payroll_uuid": "p1", "check_date": "2026-02-13", "totals": { "gross_pay": "100.00", "net_pay": 80, "employee_taxes": "20" } });
        match normalize_gusto_payroll(&payroll) {
            Normalized::Payroll {
                totals, pay_date, ..
            } => {
                assert_eq!(pay_date, "2026-02-13");
                assert!((totals.gross_wages - 100.0).abs() < f64::EPSILON);
                assert!((totals.net_pay - 80.0).abs() < f64::EPSILON);
            }
            Normalized::Skip { reason, .. } => panic!("skipped: {reason}"),
        }
    }
}
