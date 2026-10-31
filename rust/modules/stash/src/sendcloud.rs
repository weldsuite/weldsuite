//! What the pick-list ship action needs from `@weldsuite/sendcloud`: the
//! workspace's stored connection (`workspace_settings.custom_settings
//! .sendcloud`, the secret sealed with the workspace keyring), the recipient
//! address mapping (`toSendcloudToAddress`), and the v3 API's shipment
//! announcement, sent through the outbound HTTP port (the test's fetch stub
//! in conformance).

use base64::Engine;
use serde_json::{Map, Value, json};
use weldsuite_db::{Keyring, PgPool, decrypt_workspace_database_url};
use weldsuite_ports::{HttpRequest, OutboundHttp};

const BASE_URL: &str = "https://panel.sendcloud.sc/api/v3";

/// `getSendcloudSettings`: the stored connection, or an empty one.
#[derive(Debug, Default)]
pub(crate) struct Stored {
    pub(crate) public_key: Option<String>,
    pub(crate) secret_key: Option<String>,
    pub(crate) senders: Vec<Value>,
    pub(crate) methods: Vec<Value>,
}

pub(crate) async fn settings(db: &PgPool, clerk_org_id: &str) -> Result<Stored, sqlx::Error> {
    let row: Option<Option<Value>> =
        sqlx::query_scalar("select custom_settings from workspace_settings where id = $1 limit 1")
            .bind(clerk_org_id)
            .fetch_optional(db)
            .await?;
    let raw = row
        .flatten()
        .and_then(|custom| custom.get("sendcloud").cloned());
    let Some(raw) = raw.filter(|raw| raw.is_object() || raw.is_array()) else {
        return Ok(Stored::default());
    };
    let text = |key: &str| raw.get(key).and_then(Value::as_str).map(str::to_owned);
    let list = |key: &str| {
        raw.get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    Ok(Stored {
        public_key: text("publicKey"),
        secret_key: text("secretKey"),
        senders: list("senders"),
        methods: list("methods"),
    })
}

fn hex_pair(value: &str) -> bool {
    let is_hex = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit());
    matches!(value.split_once(':'), Some((a, b)) if is_hex(a) && is_hex(b))
}

/// `decryptSecret` (`maybeDecryptField`): the plaintext of a sealed v1/v2
/// value the keyring opens; anything else (plain text, v3, a value the
/// keyring has no key for or can't open) as it is. `None` for no secret.
pub(crate) fn decrypt_secret(secret: Option<&str>, keyring: &Keyring) -> Option<String> {
    let secret = secret.filter(|secret| !secret.is_empty())?;
    let v2 = secret.strip_prefix("v2:").is_some_and(hex_pair);
    let v1 = hex_pair(secret);
    if !(v1 || v2) {
        return Some(secret.to_owned());
    }
    if (v2 && keyring.v2.is_none()) || (v1 && keyring.v1.is_none()) {
        return Some(secret.to_owned());
    }
    Some(decrypt_workspace_database_url(secret, "", keyring).unwrap_or_else(|_| secret.to_owned()))
}

/// JavaScript's `\s`.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `String.prototype.trim`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

/// `splitStreet`: the house number after the last separator run, when the
/// line ends in one (`/(?<![\s,])[\s,]+(\d+\s*[a-zA-Z]?)$/`).
fn split_street(line: &str) -> (String, String) {
    let value = js_trim(line);
    if value.is_empty() {
        return (String::new(), "1".to_owned());
    }
    let chars: Vec<(usize, char)> = value.char_indices().collect();
    let mut end = chars.len();
    // `[a-zA-Z]?`
    if end > 0 && chars[end - 1].1.is_ascii_alphabetic() {
        end -= 1;
    }
    // `\s*`
    while end > 0 && js_space(chars[end - 1].1) {
        end -= 1;
    }
    // `\d+`
    let digits_end = end;
    while end > 0 && chars[end - 1].1.is_ascii_digit() {
        end -= 1;
    }
    let separator = |c: char| js_space(c) || c == ',';
    let number_start = end;
    if number_start < digits_end && number_start > 0 && separator(chars[number_start - 1].1) {
        // `[\s,]+`, from where the run starts (`(?<![\s,])`).
        let mut start = number_start;
        while start > 0 && separator(chars[start - 1].1) {
            start -= 1;
        }
        let byte = |i: usize| chars.get(i).map_or(value.len(), |(at, _)| *at);
        let street = js_trim(&value[..byte(start)]).to_owned();
        let number = js_trim(&value[byte(number_start)..]).to_owned();
        return (street, number);
    }
    (value.to_owned(), "1".to_owned())
}

const COUNTRY_NAMES: &[(&str, &str)] = &[
    ("netherlands", "NL"),
    ("nederland", "NL"),
    ("belgium", "BE"),
    ("belgie", "BE"),
    ("belgië", "BE"),
    ("germany", "DE"),
    ("deutschland", "DE"),
    ("duitsland", "DE"),
    ("france", "FR"),
    ("frankrijk", "FR"),
    ("united kingdom", "GB"),
    ("great britain", "GB"),
    ("uk", "GB"),
    ("united states", "US"),
    ("usa", "US"),
    ("spain", "ES"),
    ("spanje", "ES"),
    ("italy", "IT"),
    ("italië", "IT"),
    ("austria", "AT"),
    ("oostenrijk", "AT"),
    ("poland", "PL"),
    ("polen", "PL"),
];

/// `toCountryCode`.
fn country_code(value: Option<&str>) -> Option<String> {
    let value = value.filter(|value| !value.is_empty())?;
    let trimmed = js_trim(value);
    if trimmed.chars().count() == 2 && trimmed.chars().all(|c| c.is_ascii_alphabetic()) {
        return Some(trimmed.to_ascii_uppercase());
    }
    let lower = trimmed.to_lowercase();
    COUNTRY_NAMES
        .iter()
        .find(|(name, _)| *name == lower)
        .map(|(_, code)| (*code).to_owned())
}

/// A JSON value as JavaScript's `value || fallback` reads it, for strings.
fn truthy_text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        Some(Value::Number(number)) if number.as_f64().is_some_and(|n| n != 0.0) => {
            Some(number.to_string())
        }
        _ => None,
    }
}

/// `toSendcloudToAddress`: the recipient, or the message of the error it
/// throws for an incomplete address.
pub(crate) fn to_address(order: Option<&Value>) -> Result<Value, String> {
    let empty = Value::Object(Map::new());
    let address = order
        .and_then(|order| order.get("shippingAddress"))
        .filter(|address| !address.is_null())
        .unwrap_or(&empty);
    let field = |key: &str| address.get(key);
    let order_text = |key: &str| order.and_then(|order| order.get(key));
    let (street, house) = split_street(&truthy_text(field("line1")).unwrap_or_default());
    let country = country_code(truthy_text(field("country")).as_deref());
    let name = js_trim(
        &truthy_text(field("name"))
            .or_else(|| truthy_text(order_text("customerName")))
            .unwrap_or_default(),
    )
    .to_owned();
    let postal = js_trim(&truthy_text(field("postalCode")).unwrap_or_default()).to_owned();
    let city = js_trim(&truthy_text(field("city")).unwrap_or_default()).to_owned();
    if name.is_empty()
        || street.is_empty()
        || postal.is_empty()
        || city.is_empty()
        || country.is_none()
    {
        let missing: Vec<&str> = [
            (name.is_empty(), "name"),
            (street.is_empty(), "street"),
            (postal.is_empty(), "postal code"),
            (city.is_empty(), "city"),
            (country.is_none(), "country"),
        ]
        .iter()
        .filter(|(missing, _)| *missing)
        .map(|(_, label)| *label)
        .collect();
        return Err(format!(
            "Recipient address is incomplete ({})",
            missing.join(", ")
        ));
    }
    let optional = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .map(js_trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let mut out = Map::new();
    out.insert("name".to_owned(), json!(name));
    out.insert("address_line_1".to_owned(), json!(street));
    if let Some(line2) = optional(field("line2")) {
        out.insert("address_line_2".to_owned(), json!(line2));
    }
    out.insert("house_number".to_owned(), json!(house));
    out.insert("postal_code".to_owned(), json!(postal));
    out.insert("city".to_owned(), json!(city));
    out.insert("country_code".to_owned(), json!(country));
    if let Some(email) = optional(order_text("customerEmail")) {
        out.insert("email".to_owned(), json!(email));
    }
    let phone = truthy_text(field("phone")).or_else(|| truthy_text(order_text("customerPhone")));
    if let Some(phone) = phone
        .as_deref()
        .map(js_trim)
        .filter(|phone| !phone.is_empty())
    {
        out.insert("phone_number".to_owned(), json!(phone));
    }
    if let Some(state) = optional(field("state")) {
        out.insert("state_province_code".to_owned(), json!(state));
    }
    Ok(Value::Object(out))
}

/// Why the announcement failed.
#[derive(Debug)]
pub(crate) enum AnnounceError {
    /// A `SendcloudError` (a non-2xx answer), with its message.
    Sendcloud(String),
    /// The call itself failed, or the answer was unreadable: the route's 500.
    Transport(String),
}

/// `announceShipment`'s answer.
#[derive(Debug, Clone)]
pub(crate) struct Announced {
    pub(crate) id: Value,
    pub(crate) carrier_name: Option<String>,
    pub(crate) shipping_option_code: Value,
    pub(crate) errors: Vec<Value>,
    pub(crate) parcel: Option<Parcel>,
}

#[derive(Debug, Clone)]
pub(crate) struct Parcel {
    /// `Number(first.id)`: `null` in JSON when it is `NaN`.
    pub(crate) id: Value,
    pub(crate) tracking_number: Option<String>,
    pub(crate) tracking_url: Option<String>,
    pub(crate) label_pdf_base64: Option<String>,
    pub(crate) label_document_url: Value,
}

/// The shipment to announce.
pub(crate) struct Shipment<'a> {
    pub(crate) sender_address_id: f64,
    pub(crate) to_address: Value,
    pub(crate) shipping_option_code: &'a str,
    pub(crate) weight_kg: f64,
    pub(crate) order_number: Option<&'a str>,
}

/// `extractErrorMessage`.
fn error_message(details: Option<&Value>) -> Option<String> {
    let details = details?;
    match details {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Object(record) => {
            let text_of = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
            if let Some(error) = text_of(record.get("error")) {
                return Some(error);
            }
            if let Some(message) = record
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
            {
                return Some(message.to_owned());
            }
            if let Some(message) = text_of(record.get("message")) {
                return Some(message);
            }
            record
                .get("errors")
                .and_then(Value::as_array)
                .and_then(|errors| errors.first())
                .filter(|first| !first.is_null())
                .and_then(|first| first.get("message"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        }
        _ => None,
    }
}

/// `Number(value)` as JSON (`null` for `NaN`).
fn js_number(value: Option<&Value>) -> Value {
    let number = weldsuite_kit::validation::js_number_of(value);
    if number.is_finite() {
        serde_json::Number::from_f64(number).map_or(Value::Null, |number| {
            #[allow(clippy::cast_possible_truncation)]
            if number
                .as_f64()
                .is_some_and(|n| n.fract() == 0.0 && n.abs() < 9.0e15)
            {
                json!(number.as_f64().unwrap_or_default() as i64)
            } else {
                Value::Number(number)
            }
        })
    } else {
        Value::Null
    }
}

/// `client.announceShipment(input)` with the merchant's keys.
#[allow(clippy::too_many_lines)] // one statement per step, as the TypeScript
pub(crate) async fn announce(
    http: Option<&OutboundHttp>,
    public_key: &str,
    secret_key: &str,
    shipment: &Shipment<'_>,
) -> Result<Announced, AnnounceError> {
    let Some(http) = http else {
        return Err(AnnounceError::Transport(
            "no outbound HTTP client".to_owned(),
        ));
    };
    let mut body = Map::new();
    body.insert(
        "label_details".to_owned(),
        json!({ "mime_type": "application/pdf", "dpi": 72 }),
    );
    body.insert(
        "from_address".to_owned(),
        json!({ "sender_address_id": number_json(shipment.sender_address_id) }),
    );
    body.insert("to_address".to_owned(), shipment.to_address.clone());
    body.insert(
        "ship_with".to_owned(),
        json!({
            "type": "shipping_option_code",
            "properties": { "shipping_option_code": shipment.shipping_option_code },
        }),
    );
    if let Some(order_number) = shipment.order_number {
        body.insert("order_number".to_owned(), json!(order_number));
    }
    body.insert(
        "parcels".to_owned(),
        json!([{ "weight": { "value": crate::js::number_text(shipment.weight_kg), "unit": "kg" } }]),
    );
    let auth =
        base64::engine::general_purpose::STANDARD.encode(format!("{public_key}:{secret_key}"));
    let request = HttpRequest {
        method: "POST".to_owned(),
        url: format!("{BASE_URL}/shipments/announce"),
        headers: vec![
            ("Authorization".to_owned(), format!("Basic {auth}")),
            ("Accept".to_owned(), "application/json".to_owned()),
            ("Content-Type".to_owned(), "application/json".to_owned()),
        ],
        body: Some(Value::Object(body).to_string().into_bytes()),
    };
    let response = http
        .send(request)
        .await
        .map_err(|error| AnnounceError::Transport(error.to_string()))?;
    if !response.ok() {
        let details: Option<Value> = serde_json::from_slice(&response.body).ok();
        let message = error_message(details.as_ref())
            .unwrap_or_else(|| format!("Sendcloud request failed ({})", response.status));
        return Err(AnnounceError::Sendcloud(message));
    }
    let json: Value = serde_json::from_slice(&response.body)
        .map_err(|error| AnnounceError::Transport(error.to_string()))?;
    let data = match json.get("data") {
        Some(data) if !data.is_null() => data.clone(),
        _ => json.clone(),
    };
    let parcels = data
        .get("parcels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let first = parcels.first().filter(|first| !first.is_null());
    let string_of = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
    let parcel = first.map(|first| {
        let documents = first
            .get("documents")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let label = documents
            .iter()
            .find(|document| document.get("type").and_then(Value::as_str) == Some("label"));
        Parcel {
            id: js_number(first.get("id")),
            tracking_number: string_of(first.get("tracking_number")),
            tracking_url: string_of(first.get("tracking_url")),
            label_pdf_base64: string_of(first.get("label_file")),
            label_document_url: label
                .and_then(|label| label.get("link"))
                .filter(|link| !link.is_null())
                .cloned()
                .unwrap_or(Value::Null),
        }
    });
    let shipping_option_code = data
        .get("ship_with")
        .and_then(|ship_with| ship_with.get("properties"))
        .and_then(|properties| properties.get("shipping_option_code"))
        .filter(|code| !code.is_null())
        .cloned()
        .unwrap_or_else(|| json!(shipment.shipping_option_code));
    Ok(Announced {
        id: data
            .get("id")
            .filter(|id| !id.is_null())
            .cloned()
            .unwrap_or_else(|| json!("")),
        carrier_name: string_of(data.get("carrier").and_then(|carrier| carrier.get("name"))),
        shipping_option_code,
        errors: data
            .get("errors")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        parcel,
    })
}

/// A JavaScript number as JSON: integral values as integers.
pub(crate) fn number_json(number: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() < 9.0e15 {
        json!(number as i64)
    } else {
        serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_the_house_number_off_the_street() {
        let split = |line: &str| split_street(line);
        assert_eq!(
            split("Insulindelaan 115"),
            ("Insulindelaan".to_owned(), "115".to_owned())
        );
        assert_eq!(
            split("Main St 12 B"),
            ("Main St".to_owned(), "12 B".to_owned())
        );
        assert_eq!(split("Street 12B"), ("Street".to_owned(), "12B".to_owned()));
        assert_eq!(split("Street, 7"), ("Street".to_owned(), "7".to_owned()));
        assert_eq!(split("Street 1 2"), ("Street 1".to_owned(), "2".to_owned()));
        assert_eq!(split("Somewhere"), ("Somewhere".to_owned(), "1".to_owned()));
        assert_eq!(split("12"), ("12".to_owned(), "1".to_owned()));
        assert_eq!(split(""), (String::new(), "1".to_owned()));
        assert_eq!(
            split("Street 12a3"),
            ("Street 12a3".to_owned(), "1".to_owned())
        );
    }

    #[test]
    fn reads_country_names_and_codes() {
        assert_eq!(country_code(Some("nl")).as_deref(), Some("NL"));
        assert_eq!(country_code(Some(" Netherlands ")).as_deref(), Some("NL"));
        assert_eq!(country_code(Some("België")).as_deref(), Some("BE"));
        assert_eq!(country_code(Some("Narnia")), None);
        assert_eq!(country_code(None), None);
    }

    #[test]
    fn opens_only_what_the_keyring_can() {
        let keyring = Keyring::default();
        assert_eq!(
            decrypt_secret(Some("sk_plain"), &keyring).as_deref(),
            Some("sk_plain")
        );
        assert_eq!(
            decrypt_secret(Some("abcd:ef01"), &keyring).as_deref(),
            Some("abcd:ef01")
        );
        assert_eq!(decrypt_secret(Some(""), &keyring), None);
        assert_eq!(decrypt_secret(None, &keyring), None);
        let keyring = Keyring {
            v1: Some("a".repeat(64)),
            v2: None,
        };
        assert_eq!(
            decrypt_secret(Some("abcd:ef01"), &keyring).as_deref(),
            Some("abcd:ef01")
        );
        let sealed = weldsuite_db::encrypt_field("sk_secret", &keyring).expect("seals");
        assert_eq!(
            decrypt_secret(Some(&sealed), &keyring).as_deref(),
            Some("sk_secret")
        );
    }

    #[test]
    fn reads_sendcloud_error_messages() {
        assert_eq!(
            error_message(Some(&json!({ "error": { "message": "Bad" } }))).as_deref(),
            Some("Bad")
        );
        assert_eq!(
            error_message(Some(&json!({ "errors": [{ "message": "No" }] }))).as_deref(),
            Some("No")
        );
        assert_eq!(
            error_message(Some(&json!({ "message": "M" }))).as_deref(),
            Some("M")
        );
        assert_eq!(
            error_message(Some(&json!("plain"))).as_deref(),
            Some("plain")
        );
        assert_eq!(error_message(None), None);
    }
}
