//! `/api/sendcloud`: the workspace's own Sendcloud account (API v3, Basic
//! auth with the public and secret keys), with what the routes need of
//! `@weldsuite/sendcloud` (`client.ts`: sender addresses, shipping options,
//! label documents; `settings.ts`: the connection and its cached catalogue
//! under `workspace_settings.customSettings.sendcloud`, keyed by the Clerk
//! org id, the secret sealed with the workspace keyring).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use base64::Engine;
use http::HeaderMap;
use http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::Keyring;
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{ApiError, Data, NoContent};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp};

use crate::js::{number_text, number_value};
use crate::tables;
use crate::{Caller, CommerceState, now, validate};

const BASE_URL: &str = "https://panel.sendcloud.sc/api/v3";

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::INTEGRATIONS_READ, perm::PICKLISTS_READ]);
    let write = || gate.require([perm::INTEGRATIONS_CREATE, perm::INTEGRATIONS_UPDATE]);
    Router::new()
        .route("/", get(read_settings).route_layer(read()))
        .route("/", axum::routing::patch(patch_settings).delete(disconnect).route_layer(write()))
        .route("/connect", put(connect).route_layer(write()))
        .route("/sync", post(sync).route_layer(write()))
        .route("/labels/{parcel_id}", get(label).route_layer(read()))
}

// ── the client ──────────────────────────────────────────────────────────────

/// `SendcloudError` (and a call that never got an answer).
#[derive(Debug)]
enum SendcloudError {
    Api {
        message: String,
        status: u16,
        details: Option<Value>,
    },
    Network,
    Database(sqlx::Error),
}

impl From<sqlx::Error> for SendcloudError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// `mapSendcloudHttp(c, err, fallback)`.
fn respond(error: SendcloudError, fallback: &str) -> Response {
    let SendcloudError::Api { message, status, details } = error else {
        if let SendcloudError::Database(error) = &error {
            tracing::error!(%error, "[commerce-api/sendcloud] {fallback}");
        }
        return ApiError::internal().with_message(fallback).into_response();
    };
    match status {
        401 | 403 => ApiError::unauthorized().with_message(message).into_response(),
        402 => {
            let mut error = Map::new();
            error.insert("code".to_owned(), json!("PAYMENT_REQUIRED"));
            error.insert("message".to_owned(), json!(message));
            if let Some(details) = details {
                error.insert("details".to_owned(), details);
            }
            (http::StatusCode::PAYMENT_REQUIRED, axum::Json(json!({ "error": error }))).into_response()
        }
        404 => ApiError::not_found("Sendcloud resource", None).into_response(),
        429 => ApiError::internal().with_message(message).into_response(),
        s if (400..500).contains(&s) => match details {
            Some(details) => ApiError::bad_request(message).with_details(details).into_response(),
            None => ApiError::bad_request(message).into_response(),
        },
        _ => ApiError::internal().with_message(message).into_response(),
    }
}

/// `extractErrorMessage(details)`.
fn error_message(details: Option<&Value>) -> Option<String> {
    match details? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Object(rec) => {
            if let Some(Value::String(e)) = rec.get("error") {
                return Some(e.clone());
            }
            if let Some(Value::String(m)) = rec.get("error").and_then(|e| e.get("message")) {
                return Some(m.clone());
            }
            if let Some(Value::String(m)) = rec.get("message") {
                return Some(m.clone());
            }
            rec.get("errors")
                .and_then(Value::as_array)
                .and_then(|errors| errors.first())
                .and_then(|first| first.get("message"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        }
        _ => None,
    }
}

struct Client {
    auth: String,
    http: Option<OutboundHttp>,
}

impl Client {
    fn new(public_key: &str, secret_key: &str, http: Option<OutboundHttp>) -> Self {
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{public_key}:{secret_key}"));
        Self {
            auth: format!("Basic {token}"),
            http,
        }
    }

    async fn request(&self, method: &str, path: &str, accept: &str, body: Option<&Value>) -> Result<HttpResponse, SendcloudError> {
        let mut request = HttpRequest::empty(method, format!("{BASE_URL}{path}"))
            .header("authorization", self.auth.clone())
            .header("accept", accept);
        if let Some(body) = body {
            request = request.header("content-type", "application/json");
            request.body = Some(body.to_string().into_bytes());
        }
        let Some(http) = &self.http else {
            return Err(SendcloudError::Network);
        };
        let response = http.send(request).await.map_err(|_| SendcloudError::Network)?;
        if response.ok() {
            return Ok(response);
        }
        // `res.json()`, else `res.text()` (which then fails: the body is used).
        let details: Option<Value> = serde_json::from_slice(&response.body).ok();
        let message = error_message(details.as_ref())
            .unwrap_or_else(|| format!("Sendcloud request failed ({})", response.status));
        Err(SendcloudError::Api {
            message,
            status: response.status,
            details,
        })
    }

    async fn json(&self, method: &str, path: &str, body: Option<&Value>) -> Result<(Value, Option<String>), SendcloudError> {
        let response = self.request(method, path, "application/json", body).await?;
        let link = response.header("link").map(str::to_owned);
        let json = serde_json::from_slice(&response.body).map_err(|_| SendcloudError::Network)?;
        Ok((json, link))
    }

    /// `listSenderAddresses()`: every page, by the `Link` header or a cursor.
    async fn senders(&self) -> Result<Vec<Value>, SendcloudError> {
        let mut collected = Vec::new();
        let mut path = Some("/addresses/sender-addresses?page_size=100".to_owned());
        while let Some(current) = path {
            let (json, link) = self.json("GET", &current, None).await?;
            collected.extend(extract_list(&json).iter().map(map_sender));
            path = next_path(link.as_deref(), &json);
        }
        Ok(collected)
    }

    /// `listShippingOptions({ from, to, weightKg })`.
    async fn shipping_options(&self, from: &Value) -> Result<Vec<Value>, SendcloudError> {
        let body = json!({
            "from_address": from,
            "to_address": from,
            "parcels": [{ "weight": { "value": "1", "unit": "kg" } }],
            "calculate_quotes": false,
        });
        let (json, _) = self.json("POST", "/shipping-options", Some(&body)).await?;
        Ok(extract_list(&json)
            .iter()
            .map(map_option)
            .filter(|o| o["code"].as_str().is_some_and(|c| !c.is_empty()))
            .collect())
    }
}

fn extract_list(json: &Value) -> Vec<Value> {
    for key in ["data", "sender_addresses", "shipping_options", "items"] {
        if let Some(list) = json.get(key).and_then(Value::as_array) {
            return list.clone();
        }
    }
    Vec::new()
}

fn next_path(link: Option<&str>, json: &Value) -> Option<String> {
    if let Some(next) = link.and_then(parse_link_next) {
        if next.starts_with("http") {
            let path = next.replacen(BASE_URL, "", 1);
            return Some(if path.is_empty() { "/".to_owned() } else { path });
        }
        return Some(next);
    }
    let cursor = json
        .get("next")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| json.pointer("/pagination/next").and_then(Value::as_str).filter(|s| !s.is_empty()))?;
    if cursor.starts_with("http") {
        return Some(cursor.replacen(BASE_URL, "", 1));
    }
    if cursor.starts_with('/') {
        return Some(cursor.to_owned());
    }
    let encoded: String = url::form_urlencoded::byte_serialize(cursor.as_bytes()).collect();
    Some(format!("/addresses/sender-addresses?cursor={encoded}&page_size=100"))
}

/// `/<([^<>]+)>\s*;\s*rel="?next"?/i` on each part.
fn parse_link_next(header: &str) -> Option<String> {
    for part in header.split(',') {
        let part = part.trim();
        let Some(start) = part.find('<') else { continue };
        let Some(end) = part[start + 1..].find('>') else { continue };
        let url = &part[start + 1..start + 1 + end];
        if url.is_empty() || url.contains('<') {
            continue;
        }
        let rest = part[start + 2 + end..].trim_start();
        let Some(rest) = rest.strip_prefix(';') else { continue };
        let rest = rest.trim_start().to_ascii_lowercase();
        if rest.starts_with("rel=\"next") || rest.starts_with("rel=next") {
            return Some(url.to_owned());
        }
    }
    None
}

fn as_string(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(s)) if !s.is_empty() => json!(s),
        _ => Value::Null,
    }
}

fn first_string(row: &Value, keys: &[&str]) -> Value {
    keys.iter()
        .map(|k| as_string(row.get(*k)))
        .find(|v| !v.is_null())
        .unwrap_or(Value::Null)
}

fn as_number(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => Value::Number(n.clone()),
        Some(Value::String(s)) if !weldsuite_kit::validation::js_trim(s).is_empty() => {
            let n = weldsuite_kit::validation::js_number(s);
            if n.is_finite() { number_value(n) } else { Value::Null }
        }
        _ => Value::Null,
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `mapSender(row)`.
fn map_sender(row: &Value) -> Value {
    let country = first_string(row, &["country", "country_code"]);
    let country = match country.as_str() {
        Some(c) if c.len() == 2 && c.chars().all(|ch| ch.is_ascii_alphabetic()) => json!(c.to_ascii_uppercase()),
        _ => country,
    };
    let is_default = match row.get("is_default").filter(|v| !v.is_null()) {
        Some(value) => truthy(Some(value)),
        None => truthy(row.get("default")),
    };
    json!({
        "id": number_value(weldsuite_kit::validation::js_number_of(row.get("id"))),
        "companyName": as_string(row.get("company_name")),
        "contactName": first_string(row, &["contact_name", "name"]),
        "email": as_string(row.get("email")),
        "phone": first_string(row, &["phone_number", "telephone"]),
        "addressLine1": first_string(row, &["address_line_1", "street"]),
        "addressLine2": as_string(row.get("address_line_2")),
        "houseNumber": as_string(row.get("house_number")),
        "postalCode": as_string(row.get("postal_code")),
        "city": as_string(row.get("city")),
        "countryCode": country,
        "isDefault": is_default,
    })
}

/// `mapShippingOption(row)`.
fn map_option(row: &Value) -> Value {
    let code = as_string(row.get("code"));
    let code = code.as_str().unwrap_or_default().to_owned();
    let name = [as_string(row.pointer("/product/name")), as_string(row.get("name"))]
        .into_iter()
        .find(|v| !v.is_null())
        .unwrap_or_else(|| json!(code));
    json!({
        "code": code,
        "name": name,
        "carrierCode": as_string(row.pointer("/carrier/code")),
        "carrierName": as_string(row.pointer("/carrier/name")),
        "minWeightKg": as_number(row.pointer("/weight/min/value")),
        "maxWeightKg": as_number(row.pointer("/weight/max/value")),
        "servicePointRequired": truthy(row.pointer("/requirements/is_service_point_required")),
        "isReturn": truthy(row.pointer("/functionalities/returns")),
    })
}

// ── settings ────────────────────────────────────────────────────────────────

/// `getSendcloudSettings(db, workspaceId)`: the stored connection, or an
/// empty one.
struct Stored {
    settings: Map<String, Value>,
}

impl Stored {
    fn text(&self, key: &str) -> Option<&str> {
        self.settings.get(key).and_then(Value::as_str)
    }

    fn list(&self, key: &str) -> Vec<Value> {
        self.settings.get(key).and_then(Value::as_array).cloned().unwrap_or_default()
    }
}

async fn load(caller: &Caller) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Option<Value>> =
        sqlx::query_scalar("select custom_settings from workspace_settings where id = $1 limit 1")
            .bind(&caller.clerk_org_id)
            .fetch_optional(&caller.db)
            .await?;
    Ok(row.map(|custom| custom.unwrap_or_else(|| json!({}))))
}

async fn get_settings(caller: &Caller) -> Result<Stored, sqlx::Error> {
    let custom = load(caller).await?;
    let raw = custom.as_ref().and_then(|c| c.get("sendcloud")).filter(|r| r.is_object() || r.is_array());
    let mut settings = Map::new();
    if let Some(raw) = raw {
        for key in ["publicKey", "secretKey"] {
            if let Some(Value::String(s)) = raw.get(key) {
                settings.insert(key.to_owned(), json!(s));
            }
        }
        settings.insert("accountName".to_owned(), raw.get("accountName").cloned().unwrap_or(Value::Null));
        settings.insert("lastSyncedAt".to_owned(), raw.get("lastSyncedAt").cloned().unwrap_or(Value::Null));
        for key in ["senders", "methods"] {
            let list = raw.get(key).filter(|v| v.is_array()).cloned().unwrap_or_else(|| json!([]));
            settings.insert(key.to_owned(), list);
        }
    } else {
        settings.insert("senders".to_owned(), json!([]));
        settings.insert("methods".to_owned(), json!([]));
    }
    Ok(Stored { settings })
}

/// `saveSendcloudSettings(db, workspaceId, settings)`.
async fn save(caller: &Caller, settings: Map<String, Value>) -> Result<(), sqlx::Error> {
    let existing = load(caller).await?;
    let now = now();
    let mut custom = match existing.clone() {
        Some(Value::Object(custom)) => custom,
        _ => Map::new(),
    };
    custom.insert("sendcloud".to_owned(), Value::Object(settings));
    if existing.is_some() {
        sqlx::query("update workspace_settings set custom_settings = $1, updated_at = $2::timestamptz where id = $3")
            .bind(Value::Object(custom))
            .bind(&now)
            .bind(&caller.clerk_org_id)
            .execute(&caller.db)
            .await?;
        return Ok(());
    }
    let t = &tables::WORKSPACE_SETTINGS;
    let mut values = Map::new();
    t.set(&mut values, "id", json!(caller.clerk_org_id));
    t.set(&mut values, "customSettings", Value::Object(custom));
    t.set(&mut values, "createdAt", json!(now));
    t.set(&mut values, "updatedAt", json!(now));
    t.insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
        .map(|_| ())
        .map_err(|error| match error {
            crate::table::WriteError::Database(error) => error,
            crate::table::WriteError::NotADate(prop) => sqlx::Error::Protocol(prop.to_owned()),
        })
}

/// `maskPublicKey(publicKey)`, in UTF-16 units.
fn mask(public_key: Option<&str>) -> Value {
    let Some(key) = public_key.filter(|k| !k.is_empty()) else {
        return Value::Null;
    };
    let units: Vec<u16> = key.encode_utf16().collect();
    let text = |slice: &[u16]| String::from_utf16_lossy(slice);
    if units.len() <= 8 {
        return json!(format!("{}\u{2026}", text(&units[..2.min(units.len())])));
    }
    json!(format!("{}\u{2026}{}", text(&units[..4]), text(&units[units.len() - 4..])))
}

/// `toPublicSettings(stored)`.
fn public(stored: &Stored) -> Value {
    json!({
        "connected": stored.text("publicKey").is_some_and(|k| !k.is_empty())
            && stored.text("secretKey").is_some_and(|k| !k.is_empty()),
        "publicKeyMasked": mask(stored.text("publicKey")),
        "accountName": stored.settings.get("accountName").cloned().unwrap_or(Value::Null),
        "lastSyncedAt": stored.settings.get("lastSyncedAt").cloned().unwrap_or(Value::Null),
        "senders": stored.list("senders"),
        "methods": stored.list("methods"),
    })
}

fn flag(row: &Value, key: &str) -> Option<bool> {
    row.get(key).and_then(Value::as_bool)
}

/// `mapSyncedSenders(incoming, previous)`.
fn map_senders(incoming: &[Value], previous: &[Value]) -> Vec<Value> {
    let had_enabled = previous.iter().any(|r| truthy(r.get("enabled")));
    let mut mapped: Vec<Map<String, Value>> = incoming
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let prev = previous.iter().rev().find(|p| p.get("id") == row.get("id"));
            let id = row.get("id").cloned().unwrap_or(Value::Null);
            let name = [row.get("companyName"), row.get("contactName")]
                .into_iter()
                .flatten()
                .find(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                .cloned()
                .unwrap_or_else(|| {
                    let shown = match &id {
                        Value::Number(n) => number_text(n.as_f64().unwrap_or(f64::NAN)),
                        Value::Null => "NaN".to_owned(),
                        other => other.to_string(),
                    };
                    json!(format!("Sender {shown}"))
                });
            let is_default = truthy(row.get("isDefault"));
            let mut out = Map::new();
            out.insert("id".to_owned(), id);
            out.insert("name".to_owned(), name);
            for key in [
                "companyName",
                "contactName",
                "email",
                "phone",
                "addressLine1",
                "addressLine2",
                "houseNumber",
                "postalCode",
                "city",
                "countryCode",
            ] {
                out.insert(key.to_owned(), row.get(key).cloned().unwrap_or(Value::Null));
            }
            let enabled = prev
                .and_then(|p| p.get("enabled").filter(|v| !v.is_null()).cloned())
                .unwrap_or_else(|| json!(!had_enabled && (is_default || index == 0)));
            let default = prev
                .and_then(|p| p.get("isDefault").filter(|v| !v.is_null()).cloned())
                .unwrap_or_else(|| json!(is_default || index == 0));
            out.insert("enabled".to_owned(), enabled);
            out.insert("isDefault".to_owned(), default);
            out
        })
        .collect();
    if !mapped.iter().any(|r| truthy(r.get("isDefault")))
        && let Some(first) = mapped.first_mut()
    {
        first.insert("isDefault".to_owned(), json!(true));
    }
    let default_id = mapped
        .iter()
        .find(|r| truthy(r.get("isDefault")))
        .and_then(|r| r.get("id").cloned());
    mapped
        .into_iter()
        .map(|mut row| {
            let is = default_id.is_some() && row.get("id") == default_id.as_ref();
            row.insert("isDefault".to_owned(), json!(is));
            Value::Object(row)
        })
        .collect()
}

/// `mapSyncedMethods(incoming, previous)`.
fn map_methods(incoming: &[Value], previous: &[Value]) -> Vec<Value> {
    let had_enabled = previous.iter().any(|r| truthy(r.get("enabled")));
    let usable = incoming.iter().filter(|r| {
        r["code"].as_str().is_some_and(|c| !c.is_empty())
            && !truthy(r.get("servicePointRequired"))
            && !truthy(r.get("isReturn"))
    });
    let mut mapped: Vec<Map<String, Value>> = usable
        .enumerate()
        .map(|(index, row)| {
            let prev = previous.iter().rev().find(|p| p.get("code") == row.get("code"));
            let mut out = Map::new();
            for key in ["code", "name", "carrierCode", "carrierName", "minWeightKg", "maxWeightKg"] {
                out.insert(key.to_owned(), row.get(key).cloned().unwrap_or(Value::Null));
            }
            let pick = |key: &str| prev.and_then(|p| p.get(key).filter(|v| !v.is_null()).cloned());
            out.insert("enabled".to_owned(), pick("enabled").unwrap_or_else(|| json!(!had_enabled && index == 0)));
            out.insert("isDefault".to_owned(), pick("isDefault").unwrap_or_else(|| json!(!had_enabled && index == 0)));
            out
        })
        .collect();
    if !mapped.iter().any(|r| truthy(r.get("isDefault")))
        && let Some(first) = mapped.first_mut()
    {
        first.insert("isDefault".to_owned(), json!(true));
    }
    mapped.into_iter().map(Value::Object).collect()
}

/// `syncSendcloudCatalog(stored, client)`.
async fn sync_catalog(mut settings: Map<String, Value>, client: &Client) -> Result<Map<String, Value>, SendcloudError> {
    let previous = |key: &str, settings: &Map<String, Value>| {
        settings.get(key).and_then(Value::as_array).cloned().unwrap_or_default()
    };
    let incoming = client.senders().await?;
    let senders = map_senders(&incoming, &previous("senders", &settings));
    let default = senders
        .iter()
        .find(|r| truthy(r.get("isDefault")))
        .or_else(|| senders.first())
        .cloned();
    let mut methods = settings.get("methods").cloned().unwrap_or_else(|| json!([]));
    if let Some(default) = &default
        && let Some(country) = default.get("countryCode").and_then(Value::as_str).filter(|c| !c.is_empty())
    {
        let mut from = Map::new();
        from.insert("country_code".to_owned(), json!(country));
        for (key, prop) in [
            ("postal_code", "postalCode"),
            ("city", "city"),
            ("address_line_1", "addressLine1"),
            ("house_number", "houseNumber"),
        ] {
            if let Some(value) = default.get(prop).filter(|v| !v.is_null()) {
                from.insert(key.to_owned(), value.clone());
            }
        }
        let options = client.shipping_options(&Value::Object(from)).await?;
        methods = Value::Array(map_methods(&options, &previous("methods", &settings)));
    }
    let account = default
        .as_ref()
        .and_then(|d| {
            [d.get("companyName"), d.get("contactName")]
                .into_iter()
                .flatten()
                .find(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                .cloned()
        })
        .or_else(|| settings.get("accountName").filter(|a| truthy(Some(a))).cloned())
        .unwrap_or(Value::Null);
    settings.insert("accountName".to_owned(), account);
    settings.insert("senders".to_owned(), Value::Array(senders));
    settings.insert("methods".to_owned(), methods);
    settings.insert("lastSyncedAt".to_owned(), json!(now()));
    Ok(settings)
}

/// `encryptSecret(secret, keyring)`.
fn encrypt_secret(secret: &str, keyring: &Keyring) -> String {
    if keyring.v1.is_none() && keyring.v2.is_none() {
        return secret.to_owned();
    }
    weldsuite_db::encrypt_field(secret, keyring).unwrap_or_else(|_| secret.to_owned())
}

/// `buildClient(stored, keyring)`.
fn build_client(stored: &Stored, keyring: &Keyring, http: Option<OutboundHttp>) -> Option<Client> {
    let public_key = stored.text("publicKey").filter(|k| !k.is_empty())?;
    let secret = stored
        .text("secretKey")
        .filter(|k| !k.is_empty())
        .map(|s| crate::crypto::maybe_decrypt_field(s, keyring))
        .filter(|s| !s.is_empty())?;
    Some(Client::new(public_key, &secret, http))
}

// ── routes ──────────────────────────────────────────────────────────────────

async fn read_settings(State(_state): State<CommerceState>, caller: Caller) -> Response {
    match get_settings(&caller).await {
        Ok(stored) => Data(public(&stored)).into_response(),
        Err(error) => respond(error.into(), "Failed to load Sendcloud settings"),
    }
}

async fn connect(State(state): State<CommerceState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to connect Sendcloud";
    let keys = validate(&headers, &body, |issues, fields| {
        let public_key = issues
            .text_with(fields, "publicKey", Presence::Required, Text::length(Some(1), None))
            .into_option();
        let secret = issues
            .text_with(fields, "secretKey", Presence::Required, Text::length(Some(1), None))
            .into_option();
        (public_key.unwrap_or_default(), secret.unwrap_or_default())
    });
    let (public_key, secret) = match keys {
        Ok(keys) => keys,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let client = Client::new(&public_key, &secret, caller.overrides.http(&state));
    let keyring = caller.overrides.keyring(&state);
    let result = async {
        let mut current = get_settings(&caller).await?.settings;
        current.insert("publicKey".to_owned(), json!(public_key));
        current.insert("secretKey".to_owned(), json!(encrypt_secret(&secret, &keyring)));
        let synced = sync_catalog(current, &client).await?;
        save(&caller, synced.clone()).await?;
        Ok::<_, SendcloudError>(Stored { settings: synced })
    }
    .await;
    match result {
        Ok(stored) => Data(public(&stored)).into_response(),
        Err(error) => respond(error, FAILED),
    }
}

async fn sync(State(state): State<CommerceState>, caller: Caller) -> Response {
    const FAILED: &str = "Failed to sync Sendcloud catalog";
    let keyring = caller.overrides.keyring(&state);
    let result = async {
        let stored = get_settings(&caller).await?;
        let Some(client) = build_client(&stored, &keyring, caller.overrides.http(&state)) else {
            return Ok(None);
        };
        let synced = sync_catalog(stored.settings, &client).await?;
        save(&caller, synced.clone()).await?;
        Ok::<_, SendcloudError>(Some(Stored { settings: synced }))
    }
    .await;
    match result {
        Ok(Some(stored)) => Data(public(&stored)).into_response(),
        Ok(None) => ApiError::bad_request("Sendcloud is not connected").into_response(),
        Err(error) => respond(error, FAILED),
    }
}

fn read_patches(issues: &mut Issues, fields: &Map<String, Value>) -> (Option<Vec<Value>>, Option<Vec<Value>>) {
    let read = |issues: &mut Issues, key: &str, id: &str| {
        issues
            .list(fields, key, Presence::Optional, None, None, |issues, item| {
                let row = issues.object(item)?;
                let before = issues.count();
                let mut out = Map::new();
                if id == "id" {
                    if let Some(n) = issues.integer(row, "id", Presence::Required, None).into_option() {
                        out.insert("id".to_owned(), json!(n));
                    }
                } else if let Some(code) = issues
                    .text_with(row, "code", Presence::Required, Text::length(Some(1), None))
                    .into_option()
                {
                    out.insert("code".to_owned(), json!(code));
                }
                for flag in ["enabled", "isDefault"] {
                    if let Some(value) = issues.boolean(row, flag, Presence::Optional).into_option() {
                        out.insert(flag.to_owned(), json!(value));
                    }
                }
                (issues.count() == before).then_some(Value::Object(out))
            })
            .into_option()
    };
    let senders = read(issues, "senders", "id");
    let methods = read(issues, "methods", "code");
    (senders, methods)
}

/// `applySendcloudPatches(stored, patch)` on one list.
fn apply(list: &[Value], patch: &[Value], key: &str) -> Vec<Value> {
    let default = patch
        .iter()
        .find(|p| flag(p, "isDefault") == Some(true))
        .and_then(|p| p.get(key).cloned());
    list.iter()
        .map(|row| {
            let mut out = row.as_object().cloned().unwrap_or_default();
            let next = patch.iter().rev().find(|p| p.get(key) == row.get(key));
            match next {
                None => {
                    if let Some(default) = &default {
                        out.insert("isDefault".to_owned(), json!(row.get(key) == Some(default)));
                    }
                }
                Some(next) => {
                    let enabled = flag(next, "enabled")
                        .map_or_else(|| row.get("enabled").cloned().unwrap_or(Value::Null), |b| json!(b));
                    out.insert("enabled".to_owned(), enabled);
                    let is = match &default {
                        Some(default) => json!(row.get(key) == Some(default)),
                        None => flag(next, "isDefault")
                            .map_or_else(|| row.get("isDefault").cloned().unwrap_or(Value::Null), |b| json!(b)),
                    };
                    out.insert("isDefault".to_owned(), is);
                }
            }
            Value::Object(out)
        })
        .collect()
}

async fn patch_settings(State(_state): State<CommerceState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to update Sendcloud settings";
    let (senders, methods) = match validate(&headers, &body, read_patches) {
        Ok(patches) => patches,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result = async {
        let mut stored = get_settings(&caller).await?;
        let connected = stored.text("publicKey").is_some_and(|k| !k.is_empty())
            && stored.text("secretKey").is_some_and(|k| !k.is_empty());
        if !connected {
            return Ok(None);
        }
        if let Some(senders) = &senders {
            let next = apply(&stored.list("senders"), senders, "id");
            stored.settings.insert("senders".to_owned(), Value::Array(next));
        }
        if let Some(methods) = &methods {
            let next = apply(&stored.list("methods"), methods, "code");
            stored.settings.insert("methods".to_owned(), Value::Array(next));
        }
        save(&caller, stored.settings.clone()).await?;
        Ok::<_, SendcloudError>(Some(stored))
    }
    .await;
    match result {
        Ok(Some(stored)) => Data(public(&stored)).into_response(),
        Ok(None) => ApiError::bad_request("Sendcloud is not connected").into_response(),
        Err(error) => respond(error, FAILED),
    }
}

async fn disconnect(State(_state): State<CommerceState>, caller: Caller) -> Response {
    let mut empty = Map::new();
    empty.insert("senders".to_owned(), json!([]));
    empty.insert("methods".to_owned(), json!([]));
    match save(&caller, empty).await {
        Ok(()) => NoContent.into_response(),
        Err(error) => respond(error.into(), "Failed to disconnect Sendcloud"),
    }
}

async fn label(State(state): State<CommerceState>, caller: Caller, Path(raw): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch shipping label";
    let parcel = weldsuite_kit::validation::js_number(&raw);
    if !parcel.is_finite() {
        return ApiError::bad_request("Invalid parcel id").into_response();
    }
    let parcel = number_text(parcel);
    let keyring = caller.overrides.keyring(&state);
    let result = async {
        let stored = get_settings(&caller).await?;
        let Some(client) = build_client(&stored, &keyring, caller.overrides.http(&state)) else {
            return Ok(None);
        };
        let response = client
            .request("GET", &format!("/parcels/{parcel}/documents/label"), "application/pdf", None)
            .await?;
        Ok::<_, SendcloudError>(Some(response))
    }
    .await;
    match result {
        Ok(Some(document)) => {
            let content_type = document
                .header("content-type")
                .filter(|t| !t.is_empty())
                .unwrap_or("application/pdf")
                .to_owned();
            (
                [
                    (CONTENT_TYPE, content_type),
                    (CONTENT_DISPOSITION, format!("inline; filename=\"sendcloud-label-{parcel}.pdf\"")),
                ],
                document.body,
            )
                .into_response()
        }
        Ok(None) => ApiError::bad_request("Sendcloud is not connected").into_response(),
        Err(error) => respond(error, FAILED),
    }
}
