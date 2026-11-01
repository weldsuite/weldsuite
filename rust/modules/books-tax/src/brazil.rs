//! `/api/br-tax` (`routes/br-tax/index.ts`): the apuração of a month
//! (`GET /apuracao`, `POST /apuracao/book`), the SPED ECD of a fiscal year
//! (`POST /ecd`) and the federal withholdings a service sale suggests
//! (`GET /withholdings/suggest`). Brazilian entities only.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::response::Response;
use axum::routing::{get, post};
use http::{HeaderMap, HeaderValue, StatusCode, header};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::compliance::get_contact_vat_number;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, Reply, created, ok, reply, validate};
use weldsuite_books_domain::js;
use weldsuite_books_domain::jurisdictions::br::regime_of;
use weldsuite_books_domain::jurisdictions::br_tax::suggest_withholdings;
use weldsuite_books_domain::posting::PostError;
use weldsuite_catalogs::entity_events::TAX_RETURN_CREATED;
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::apuracao::{ApuracaoError, book_apuracao, compute_entity_apuracao, month_range, stored_apuracao};
use crate::ecd::{EcdError, Signatory, build_entity_ecd, encode_latin1};
use crate::vat_returns::{entity_row, has_feature};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/apuracao", get(apuracao).route_layer(need("taxes:read")))
        .route(
            "/apuracao/book",
            post(book).route_layer(need("taxes:file")),
        )
        .route("/ecd", post(ecd).route_layer(need("taxes:read")))
        .route(
            "/withholdings/suggest",
            get(suggest).route_layer(need("taxes:read")),
        )
        .with_state(state)
}

const PERIOD_MESSAGE: &str = "Use a YYYY-MM period";

/// `brEntity(c, feature)`: the request's entity, which must have `feature`.
async fn br_entity(caller: &Caller, feature: &str) -> Result<Value, Refusal> {
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let Some(entity) = entity_row(&caller.db, &entity_id, false).await? else {
        return Err(Refusal::not_found("Entity", &entity_id));
    };
    if !has_feature(entity["jurisdictionCode"].as_str(), feature) {
        return Err(Refusal::bad_request(
            "This is only available for Brazilian entities",
        ));
    }
    Ok(entity)
}

fn apuracao_refusal(error: ApuracaoError) -> Refusal {
    match error {
        ApuracaoError::User(message) => Refusal::bad_request(message),
        ApuracaoError::Post(PostError::Posting(message)) => Refusal::bad_request(message),
        ApuracaoError::Post(other) => Refusal::Internal(other.to_string()),
        ApuracaoError::Database(error) => Refusal::Database(error),
    }
}

// ── GET /apuracao ───────────────────────────────────────────────────────────

async fn apuracao(caller: Caller) -> Response {
    let q = caller.query();
    let message = match q.get("period") {
        None => Some("Required"),
        Some(period) if month_range(period).is_none() => Some(PERIOD_MESSAGE),
        Some(_) => None,
    };
    if let Some(message) = message {
        return Refusal::bad_request(message).respond("");
    }
    let period = q.get("period").unwrap_or_default().to_owned();
    reply(
        async {
            let entity = br_entity(&caller, "brTaxReturn").await?;
            let entity_id = entity["id"].as_str().unwrap_or_default();
            let (stored, summary) = stored_apuracao(&caller.db, entity_id, &period)
                .await
                .map_err(apuracao_refusal)?;
            if stored.tax_return_id.is_some()
                && let Some(Value::Object(mut summary)) = summary
            {
                // A booked month shows what was booked.
                summary.extend(stored.fields());
                return Ok(ok(Value::Object(summary)));
            }
            let mut body = compute_entity_apuracao(&caller.db, &entity, &period)
                .await
                .map_err(apuracao_refusal)?;
            body.extend(stored.fields());
            Ok(ok(Value::Object(body)))
        }
        .await,
        "Failed to work out the apuração",
    )
}

// ── POST /apuracao/book ─────────────────────────────────────────────────────

fn read_book(issues: &mut Issues, body: &Map<String, Value>) -> String {
    issues
        .pattern(
            body,
            "period",
            Presence::Required,
            None,
            None,
            |p| month_range(p).is_some(),
            PERIOD_MESSAGE,
        )
        .into_option()
        .unwrap_or_default()
}

async fn book(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let period = match validate(&headers, &body, read_book) {
        Ok(period) => period,
        Err(refusal) => return refusal.respond("Failed to book the apuração"),
    };
    reply(book_month(&caller, &state, &period).await, "Failed to book the apuração")
}

async fn book_month(caller: &Caller, state: &BooksState, period: &str) -> Reply {
    let entity = br_entity(caller, "brTaxReturn").await?;
    let entity_id = entity["id"].as_str().unwrap_or_default().to_owned();
    let booked = book_apuracao(&caller.db, &entity, period, caller.user())
        .await
        .map_err(apuracao_refusal)?;
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "tax_return",
            entity_id: &booked.tax_return_id,
            action: "created",
            changes: None,
        },
    )
    .await;
    caller.publish(
        state,
        TAX_RETURN_CREATED,
        &booked.tax_return_id,
        json!({
            "id": booked.tax_return_id,
            "entityId": entity_id,
            "jurisdictionCode": "BR",
            "period": period,
            "totalDue": js::number_value(booked.total),
        }),
    );
    Ok(created(json!({
        "taxReturnId": booked.tax_return_id,
        "journalEntryId": booked.journal_entry_id,
    })))
}

// ── POST /ecd ───────────────────────────────────────────────────────────────

fn only(pattern: &str, value: &str) -> bool {
    regex::Regex::new(pattern).is_ok_and(|re| re.is_match(value))
}

/// `signatorySchema`.
fn read_signatory(issues: &mut Issues, fields: &Map<String, Value>) -> Signatory {
    let name = issues.text_with(fields, "name", Presence::Required, Text::trimmed(Some(1), Some(255)));
    let tax_id = issues.text_with(fields, "taxId", Presence::Required, Text::trimmed(None, None));
    if let Some(tax_id) = tax_id.as_set()
        && !only(r"^[0-9./-]{11,18}$", tax_id)
    {
        issues.issue_at(
            "taxId",
            json!({ "validation": "regex", "code": "invalid_string", "message": "CPF or CNPJ" }),
        );
    }
    let code = issues.pattern(
        fields,
        "code",
        Presence::Required,
        None,
        None,
        |c| only(r"^[0-9]{3}$", c),
        "The qualification code has 3 digits (900 = contador)",
    );
    let qualification = issues.text_with(
        fields,
        "qualification",
        Presence::Required,
        Text::trimmed(Some(1), Some(100)),
    );
    let crc = issues.text_with(fields, "crc", Presence::Optional, Text::trimmed(None, Some(20)));
    let crc_uf = issues.text_with(fields, "crcUf", Presence::Optional, Text::trimmed(None, None));
    if let Some(uf) = crc_uf.as_set() {
        issues.string_length("crcUf", 2, js::utf16_len(uf));
    }
    let email = issues.text_with(
        fields,
        "email",
        Presence::Optional,
        Text {
            format: Some(Format::Email),
            max: Some(60),
            ..Text::default()
        },
    );
    let phone = issues.text_with(fields, "phone", Presence::Optional, Text::trimmed(None, Some(14)));
    let legal = issues.boolean(fields, "legalRepresentative", Presence::Required);
    Signatory {
        name: name.into_option().unwrap_or_default(),
        tax_id: tax_id.into_option().unwrap_or_default(),
        code: code.into_option().unwrap_or_default(),
        qualification: qualification.into_option().unwrap_or_default(),
        crc: crc.into_option(),
        crc_uf: crc_uf.into_option(),
        email: email.into_option(),
        phone: phone.into_option(),
        legal_representative: legal.into_option().unwrap_or(false),
    }
}

/// `ecdSchema`.
fn read_ecd(issues: &mut Issues, body: &Map<String, Value>) -> (i64, Vec<Signatory>) {
    let year = issues.whole_number(
        body,
        "year",
        Presence::Required,
        Number {
            min: Some(2000.0),
            max: Some(2100.0),
            ..Number::default()
        },
    );
    let signatories = issues.list(
        body,
        "signatories",
        Presence::Required,
        Some(1),
        Some(10),
        |issues, item| {
            let fields = issues.object(item)?;
            Some(read_signatory(issues, fields))
        },
    );
    (
        year.into_option().unwrap_or(0),
        signatories.into_option().unwrap_or_default(),
    )
}

async fn ecd(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let (year, signatories) = match validate(&headers, &body, read_ecd) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to build the ECD"),
    };
    reply(
        async {
            let entity = br_entity(&caller, "spedEcd").await?;
            let ecd = build_entity_ecd(&caller.db, &entity, year, signatories)
                .await
                .map_err(|error| match error {
                    EcdError::User(message) => Refusal::bad_request(message),
                    EcdError::Database(error) => Refusal::Database(error),
                })?;
            let cnpj: String = entity
                .get("taxIdentifiers")
                .and_then(|t| t.get("vatNumber"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .collect();
            let warnings = serde_json::to_string(&ecd.warnings).unwrap_or_default();
            let mut response = Response::new(Body::from(encode_latin1(&ecd.content)));
            *response.status_mut() = StatusCode::OK;
            let headers = response.headers_mut();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/plain; charset=ISO-8859-1"),
            );
            if let Ok(value) =
                HeaderValue::from_str(&format!("attachment; filename=\"ECD-{cnpj}-{year}.txt\""))
            {
                headers.insert(header::CONTENT_DISPOSITION, value);
            }
            if let Ok(value) = HeaderValue::from_str(&encode_uri_component(&warnings)) {
                headers.insert("x-warnings", value);
            }
            headers.insert(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                HeaderValue::from_static("X-Warnings, Content-Disposition"),
            );
            Ok(response)
        }
        .await,
        "Failed to build the ECD",
    )
}

/// `encodeURIComponent(text)`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')')
        {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

// ── GET /withholdings/suggest ───────────────────────────────────────────────

async fn suggest(caller: Caller) -> Response {
    let q = caller.query();
    let kind = q.get("serviceKind").filter(|k| !k.is_empty()).map(str::to_owned);
    if kind
        .as_deref()
        .is_some_and(|k| !matches!(k, "professional" | "cleaning_security" | "other"))
    {
        return Refusal::bad_request(
            "serviceKind must be professional, cleaning_security or other",
        )
        .respond("");
    }
    let contact_id = q.get("contactId").map(str::to_owned);
    reply(
        async {
            let entity = br_entity(&caller, "brTaxReturn").await?;
            let tax_id = get_contact_vat_number(&caller.db, contact_id.as_deref())
                .await?
                .unwrap_or_default();
            let company = tax_id.chars().filter(char::is_ascii_alphanumeric).count() == 14;
            Ok(ok(suggest_withholdings(
                regime_of(entity["taxClassification"].as_str()),
                company,
                kind.as_deref(),
            )))
        }
        .await,
        "Failed to suggest withholdings",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_component() {
        assert_eq!(encode_uri_component("[\"a b\"]"), "%5B%22a%20b%22%5D");
        assert_eq!(encode_uri_component("é"), "%C3%A9");
    }
}
