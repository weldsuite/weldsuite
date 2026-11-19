//! The Odoo client: Odoo's external API over the outbound HTTP port.
//!
//! Odoo has two JSON APIs, and which one a server speaks depends on its
//! version, so the client asks first ([`Odoo::session`]):
//!
//! - **JSON-2** (Odoo 19 and later): `POST {url}/json/2/{model}/{method}`
//!   with `Authorization: bearer <api key>` and `X-Odoo-Database`, a body of
//!   named arguments only (`ids`, `context` and the method's parameters),
//!   and the method's return value as the body. Errors are a 4xx/5xx with
//!   `{ name, message, arguments, context, debug }` (401 for a bad key).
//!   Verified against Odoo 19's "External JSON-2 API" page.
//! - **JSON-RPC** (Odoo 16 to 18): `POST {url}/jsonrpc` with
//!   `{"jsonrpc":"2.0","method":"call","params":{"service":"object","method":"execute_kw","args":[db, uid, key, model, method, args, kwargs]}}`,
//!   the uid from `common.authenticate(db, login, key, {})`. Errors come back
//!   as HTTP 200 with `error: { code, message, data: { name, message, … } }`.
//!   Odoo deprecated it (removal planned for Odoo 22 and Odoo Online 21.1).
//!
//! The version comes from `common.version()` over JSON-RPC (16 and later
//! answer it, 19 included), else `GET /web/version` (the JSON-2 era's
//! replacement): `server_version_info[0]` / `version_info[0]` is the major
//! version, `"saas~18"` on Odoo Online's in-between releases.
//!
//! Field names differ between versions (`product_uom` on 16–18 order
//! lines, `product_uom_id` on 19; `is_storable` from 18; …), and asking
//! `read` for a field the model lacks fails the whole call, so every field
//! list goes through [`Odoo::pick_fields`] (`fields_get` once per model).

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, PoisonError};

use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp};

use crate::clients::{
    Attempt, ConnectorError, Kind, classify, parse_retry_after, send, slice500, with_retries,
};
use crate::stripe::Tested;

const USER_AGENT: &str = "WeldSuite Odoo Connector (weldsuite.com)";
/// Appended to an authentication failure on an Odoo Online host.
pub const ONLINE_PLAN_HINT: &str = "On Odoo Online, external API access needs the Custom plan.";

/// How the client talks to the server, decided on the first call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    /// Odoo 19+: `/json/2`, bearer API key.
    Json2,
    /// Odoo 16–18: `/jsonrpc` `execute_kw` as `uid`.
    JsonRpc { uid: i64 },
}

/// The server's major version and the protocol it is spoken with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Session {
    pub major: u32,
    pub protocol: Protocol,
}

#[derive(Default)]
struct State {
    session: Option<Session>,
    fields: HashMap<String, HashSet<String>>,
    request_id: u64,
}

/// An Odoo connection's client (`url`, `database`, `login`, `apiKey`).
pub struct Odoo {
    base: String,
    database: String,
    login: String,
    api_key: String,
    state: Mutex<State>,
}

impl std::fmt::Debug for Odoo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Odoo")
            .field("base", &self.base)
            .field("database", &self.database)
            .finish_non_exhaustive()
    }
}

/// The method's arguments: named, as JSON-2 takes them. Over JSON-RPC the
/// ones listed in `positional` go into `args` (after `ids`), in that order,
/// since some methods' first parameter is named differently per version
/// (`search(args, …)` on 16, `search(domain, …)` on 17+) or is not a
/// keyword at all (`create`'s `vals_list` wrapper).
#[derive(Debug, Default, Clone)]
pub struct Call {
    pub ids: Option<Vec<i64>>,
    pub named: Vec<(&'static str, Value)>,
    pub positional: &'static [&'static str],
    pub context: Option<Value>,
}

/// One answer: the method's result and the server's clock (`Date`).
#[derive(Debug, Clone)]
pub struct Answer {
    pub result: Value,
    pub server_time: Option<OffsetDateTime>,
}

fn text<'a>(credentials: &'a Map<String, Value>, key: &str) -> &'a str {
    credentials
        .get(key)
        .and_then(Value::as_str)
        .map(weldsuite_kit::validation::js_trim)
        .unwrap_or_default()
}

/// The Odoo URL as an origin (`https://acme.odoo.com`): a pasted web client
/// address (`…/odoo/action-…`, `…/web#…`) keeps only its scheme, host and
/// port; without a scheme, https.
///
/// # Errors
///
/// An empty or unusable URL.
pub fn normalize_odoo_url(raw: &str) -> Result<String, ConnectorError> {
    let trimmed = weldsuite_kit::validation::js_trim(raw);
    if trimmed.is_empty() {
        return Err(ConnectorError::new(
            "Odoo URL is required",
            400,
            Kind::Permanent,
        ));
    }
    let lower = trimmed.to_ascii_lowercase();
    let invalid = || ConnectorError::new("Odoo URL is not valid", 400, Kind::Permanent);
    let with_scheme = if lower.starts_with("http://") || lower.starts_with("https://") {
        trimmed.to_owned()
    } else if lower.contains("://") {
        return Err(invalid());
    } else {
        format!("https://{trimmed}")
    };
    let url = url::Url::parse(&with_scheme).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err(invalid());
    }
    Ok(url.origin().ascii_serialization())
}

/// `server_version_info[0]` (`17`, `"saas~18"`) or the version text
/// (`"17.0"`, `"saas~18.2+e"`) as a major version.
pub fn major_version(info: &Value, text: Option<&str>) -> Option<u32> {
    let from_text = |s: &str| -> Option<u32> {
        let rest = s.rsplit('~').next().unwrap_or(s);
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    };
    match info.get(0) {
        Some(Value::Number(n)) => n.as_u64().and_then(|n| u32::try_from(n).ok()),
        Some(Value::String(s)) => from_text(s),
        _ => None,
    }
    .or_else(|| text.and_then(from_text))
}

/// The `Date` header as a UTC instant (`Tue, 18 Nov 2026 10:00:00 GMT`).
pub fn http_date(value: Option<&str>) -> Option<OffsetDateTime> {
    let value = weldsuite_kit::validation::js_trim(value?);
    let rfc = time::format_description::well_known::Rfc2822;
    OffsetDateTime::parse(value, &rfc)
        .or_else(|_| {
            let fixed = value
                .strip_suffix(" GMT")
                .or_else(|| value.strip_suffix(" UTC"))
                .map(|head| format!("{head} +0000"))
                .unwrap_or_default();
            OffsetDateTime::parse(&fixed, &rfc)
        })
        .ok()
        .map(|at| at.to_offset(time::UtcOffset::UTC))
}

/// Which app a model belongs to, for the access-rights message.
fn app_of(model: &str) -> &'static str {
    if model.starts_with("purchase.") {
        "Purchase"
    } else if model.starts_with("sale.") {
        "Sales"
    } else if model.starts_with("stock.") {
        "Inventory"
    } else if model.starts_with("product.") || model.starts_with("uom.") {
        "Inventory or Sales"
    } else if model.starts_with("res.partner") {
        "Contacts"
    } else {
        "the matching"
    }
}

/// An Odoo error (a JSON-2 error body, or a JSON-RPC `error.data`) as a
/// connector error: bad credentials and an unknown database are
/// authentication failures (the connection's `auth_error`), missing access
/// rights and a missing app are permanent, a 429 a rate limit, a 5xx
/// transient.
pub fn odoo_error(
    status: u16,
    name: &str,
    message: &str,
    model: Option<&str>,
    host: &str,
    database: &str,
) -> ConnectorError {
    let lower = message.to_lowercase();
    let online = host.ends_with(".odoo.com");
    let original = format!("{name}: {message}");
    let error = |shown: String, status: u16, kind: Kind| ConnectorError {
        message: shown,
        status,
        kind,
        body: Some(slice500(&original)),
        retry_after: None,
    };
    if lower.contains("custom plan")
        || lower.contains("external api")
        || lower.contains("api access")
    {
        return error(
            format!("Odoo refused external API access. {ONLINE_PLAN_HINT}"),
            403,
            Kind::Auth,
        );
    }
    if lower.contains("database")
        && (lower.contains("does not exist") || lower.contains("not found"))
    {
        return error(
            format!("Odoo has no database named '{database}'"),
            401,
            Kind::Auth,
        );
    }
    if status == 401
        || name.ends_with("AccessDenied")
        || name.ends_with("Unauthorized")
        || lower.contains("invalid apikey")
        || lower.contains("session expired")
    {
        let hint = if online {
            format!(" {ONLINE_PLAN_HINT}")
        } else {
            String::new()
        };
        return error(
            format!("Odoo rejected the login or API key.{hint}"),
            401,
            Kind::Auth,
        );
    }
    if name.ends_with("AccessError") || status == 403 {
        let model = model.unwrap_or("this data");
        return error(
            format!(
                "The Odoo user has no access to {model}: give it {} access rights. Odoo said: {message}",
                app_of(model)
            ),
            403,
            Kind::Permanent,
        );
    }
    if let Some(model) = model
        && (status == 404 || name.ends_with("KeyError"))
    {
        return error(
            format!(
                "Odoo has no {model} model: install the {} app, or turn this sync off",
                app_of(model)
            ),
            404,
            Kind::Permanent,
        );
    }
    let kind = if status == 200 {
        Kind::Permanent
    } else {
        classify(status)
    };
    let status = if status == 200 { 400 } else { status };
    let detail = if message.is_empty() {
        format!("Odoo request failed ({status})")
    } else {
        format!("Odoo refused the request: {message}")
    };
    error(detail, status, kind)
}

impl Odoo {
    /// The client of a connection's credentials.
    ///
    /// # Errors
    ///
    /// A missing or unusable URL, database, login or API key.
    pub fn from_credentials(credentials: &Map<String, Value>) -> Result<Self, ConnectorError> {
        let base = normalize_odoo_url(text(credentials, "url"))?;
        let required = |key: &str, label: &str| {
            let value = text(credentials, key);
            if value.is_empty() {
                Err(ConnectorError::new(
                    format!("{label} is required"),
                    400,
                    Kind::Permanent,
                ))
            } else {
                Ok(value.to_owned())
            }
        };
        Ok(Self {
            database: required("database", "Database")?,
            login: required("login", "User login")?,
            api_key: required("apiKey", "API key")?,
            base,
            state: Mutex::new(State::default()),
        })
    }

    /// The server's origin.
    pub fn store_url(&self) -> String {
        self.base.clone()
    }

    pub fn database(&self) -> &str {
        &self.database
    }

    fn host(&self) -> String {
        url::Url::parse(&self.base)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn next_id(&self) -> u64 {
        let mut state = self.lock();
        state.request_id += 1;
        state.request_id
    }

    fn headers(&self, bearer: bool) -> Vec<(String, String)> {
        let mut headers = vec![
            (
                "Content-Type".to_owned(),
                "application/json; charset=utf-8".to_owned(),
            ),
            ("Accept".to_owned(), "application/json".to_owned()),
        ];
        if bearer {
            headers.push((
                "Authorization".to_owned(),
                format!("bearer {}", self.api_key),
            ));
            headers.push(("X-Odoo-Database".to_owned(), self.database.clone()));
        }
        headers.push(("User-Agent".to_owned(), USER_AGENT.to_owned()));
        headers
    }

    fn unreachable(&self) -> String {
        format!("Could not reach Odoo at {}: check the URL", self.base)
    }

    /// One request with the connector retries: transport failures, 429 and
    /// 5xx are retried; any other answer (errors included) is returned.
    async fn exchange(
        &self,
        http: Option<&OutboundHttp>,
        request: HttpRequest,
    ) -> Result<HttpResponse, ConnectorError> {
        with_retries(&self.unreachable(), || {
            let request = request.clone();
            async move {
                let response = send(http, request).await?;
                if response.status == 429 || response.status >= 500 {
                    let mut error = ConnectorError::new(
                        format!("Odoo request failed ({})", response.status),
                        response.status,
                        classify(response.status),
                    );
                    error.body = Some(slice500(&response.text()));
                    error.retry_after = parse_retry_after(response.header("retry-after"))
                        .or((response.status == 429).then_some(10.0));
                    return Err(Attempt::Api(error));
                }
                Ok(response)
            }
        })
        .await
    }

    fn rpc_body(&self, service: &str, method: &str, args: Vec<Value>) -> Value {
        let mut params = serde_json::Map::new();
        params.insert("service".to_owned(), json!(service));
        params.insert("method".to_owned(), json!(method));
        params.insert("args".to_owned(), Value::Array(args));
        json!({
            "jsonrpc": "2.0",
            "method": "call",
            "params": params,
            "id": self.next_id(),
        })
    }

    async fn rpc(
        &self,
        http: Option<&OutboundHttp>,
        service: &str,
        method: &str,
        args: Vec<Value>,
        model: Option<&str>,
    ) -> Result<Answer, ConnectorError> {
        let body = self.rpc_body(service, method, args);
        let request = HttpRequest {
            method: "POST".to_owned(),
            url: format!("{}/jsonrpc", self.base),
            headers: self.headers(false),
            body: Some(body.to_string().into_bytes()),
        };
        let response = self.exchange(http, request).await?;
        let server_time = http_date(response.header("date"));
        let payload = response.json();
        if !response.ok() || !payload.is_object() {
            return Err(self.http_failure(&response, model));
        }
        if let Some(error) = payload.get("error").filter(|e| !e.is_null()) {
            let data = &error["data"];
            let name = data["name"].as_str().unwrap_or_default();
            let message = data["message"]
                .as_str()
                .or_else(|| error["message"].as_str())
                .unwrap_or_default();
            // Code 100 is an expired session: on execute_kw, a bad key.
            let status = if error["code"].as_i64() == Some(100) {
                401
            } else {
                200
            };
            return Err(odoo_error(
                status,
                name,
                message,
                model,
                &self.host(),
                &self.database,
            ));
        }
        Ok(Answer {
            result: payload.get("result").cloned().unwrap_or(Value::Null),
            server_time,
        })
    }

    /// A non-JSON or failed answer: no Odoo at that URL, or the server's
    /// error body.
    fn http_failure(&self, response: &HttpResponse, model: Option<&str>) -> ConnectorError {
        let payload = response.json();
        if let Some(name) = payload.get("name").and_then(Value::as_str) {
            return odoo_error(
                response.status,
                name,
                payload["message"].as_str().unwrap_or_default(),
                model,
                &self.host(),
                &self.database,
            );
        }
        if response.status == 401 || response.status == 403 {
            return odoo_error(response.status, "", "", model, &self.host(), &self.database);
        }
        let mut error = ConnectorError::new(
            format!("No Odoo server answered at {}: check the URL", self.base),
            if response.status == 200 {
                502
            } else {
                response.status
            },
            Kind::Permanent,
        );
        error.body = Some(slice500(&response.text()));
        error
    }

    /// The server's version: `common.version()`, else `GET /web/version`.
    ///
    /// # Errors
    ///
    /// Nothing answered, or not as Odoo does.
    pub async fn version(&self, http: Option<&OutboundHttp>) -> Result<u32, ConnectorError> {
        match self.rpc(http, "common", "version", Vec::new(), None).await {
            Ok(answer) => {
                if let Some(major) = major_version(
                    &answer.result["server_version_info"],
                    answer.result["server_version"].as_str(),
                ) {
                    return Ok(major);
                }
            }
            Err(error) if error.kind == Kind::Transient && error.status == 503 => {
                return Err(error);
            }
            Err(_) => {}
        }
        let request = HttpRequest {
            method: "GET".to_owned(),
            url: format!("{}/web/version", self.base),
            headers: vec![
                ("Accept".to_owned(), "application/json".to_owned()),
                ("User-Agent".to_owned(), USER_AGENT.to_owned()),
            ],
            body: None,
        };
        let response = self.exchange(http, request).await?;
        let payload = response.json();
        match major_version(&payload["version_info"], payload["version"].as_str()) {
            Some(major) if response.ok() => Ok(major),
            _ => Err(ConnectorError::new(
                format!("No Odoo server answered at {}: check the URL", self.base),
                502,
                Kind::Permanent,
            )),
        }
    }

    /// The protocol, detected (and over JSON-RPC, authenticated) once.
    ///
    /// # Errors
    ///
    /// The version check's error, or rejected credentials.
    pub async fn session(&self, http: Option<&OutboundHttp>) -> Result<Session, ConnectorError> {
        if let Some(session) = self.lock().session {
            return Ok(session);
        }
        let major = self.version(http).await?;
        let protocol = if major >= 19 {
            Protocol::Json2
        } else {
            let answer = self
                .rpc(
                    http,
                    "common",
                    "authenticate",
                    vec![
                        json!(self.database),
                        json!(self.login),
                        json!(self.api_key),
                        json!({}),
                    ],
                    None,
                )
                .await?;
            match answer.result.as_i64() {
                Some(uid) if uid > 0 => Protocol::JsonRpc { uid },
                _ => {
                    return Err(odoo_error(
                        401,
                        "odoo.exceptions.AccessDenied",
                        "",
                        None,
                        &self.host(),
                        &self.database,
                    ));
                }
            }
        };
        let session = Session { major, protocol };
        self.lock().session = Some(session);
        Ok(session)
    }

    /// Calls `model.method` with `call`'s arguments.
    ///
    /// # Errors
    ///
    /// The connector error of the failure (see [`odoo_error`]).
    pub async fn call(
        &self,
        http: Option<&OutboundHttp>,
        model: &str,
        method: &str,
        call: Call,
    ) -> Result<Answer, ConnectorError> {
        let session = self.session(http).await?;
        match session.protocol {
            Protocol::Json2 => {
                let mut body = Map::new();
                if let Some(ids) = &call.ids {
                    body.insert("ids".to_owned(), json!(ids));
                }
                for (key, value) in call.named {
                    body.insert(key.to_owned(), value);
                }
                if let Some(context) = call.context {
                    body.insert("context".to_owned(), context);
                }
                let request = HttpRequest {
                    method: "POST".to_owned(),
                    url: format!("{}/json/2/{model}/{method}", self.base),
                    headers: self.headers(true),
                    body: Some(Value::Object(body).to_string().into_bytes()),
                };
                let response = self.exchange(http, request).await?;
                let server_time = http_date(response.header("date"));
                if !response.ok() {
                    return Err(self.http_failure(&response, Some(model)));
                }
                let text = response.text();
                let result = if text.trim().is_empty() {
                    Value::Null
                } else {
                    serde_json::from_str(&text)
                        .map_err(|_| self.http_failure(&response, Some(model)))?
                };
                Ok(Answer {
                    result,
                    server_time,
                })
            }
            Protocol::JsonRpc { uid } => {
                let mut args = Vec::new();
                if let Some(ids) = &call.ids {
                    args.push(json!(ids));
                }
                let mut kwargs = Map::new();
                for key in call.positional {
                    if let Some((_, value)) = call.named.iter().find(|(k, _)| k == key) {
                        args.push(value.clone());
                    }
                }
                for (key, value) in call.named {
                    if !call.positional.contains(&key) {
                        kwargs.insert(key.to_owned(), value);
                    }
                }
                if let Some(context) = call.context {
                    kwargs.insert("context".to_owned(), context);
                }
                self.rpc(
                    http,
                    "object",
                    "execute_kw",
                    vec![
                        json!(self.database),
                        json!(uid),
                        json!(self.api_key),
                        json!(model),
                        json!(method),
                        Value::Array(args),
                        Value::Object(kwargs),
                    ],
                    Some(model),
                )
                .await
            }
        }
    }

    /// The model's field names (`fields_get`), cached per client.
    ///
    /// # Errors
    ///
    /// The call's error.
    pub async fn fields(
        &self,
        http: Option<&OutboundHttp>,
        model: &str,
    ) -> Result<HashSet<String>, ConnectorError> {
        if let Some(fields) = self.lock().fields.get(model) {
            return Ok(fields.clone());
        }
        let answer = self
            .call(
                http,
                model,
                "fields_get",
                Call {
                    named: vec![("attributes", json!(["type"]))],
                    ..Call::default()
                },
            )
            .await?;
        let fields: HashSet<String> = answer
            .result
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        self.lock().fields.insert(model.to_owned(), fields.clone());
        Ok(fields)
    }

    /// `wanted` minus the fields this server's model lacks.
    ///
    /// # Errors
    ///
    /// The `fields_get` call's error.
    pub async fn pick_fields(
        &self,
        http: Option<&OutboundHttp>,
        model: &str,
        wanted: &[&str],
    ) -> Result<Vec<String>, ConnectorError> {
        let available = self.fields(http, model).await?;
        Ok(wanted
            .iter()
            .filter(|f| available.contains(**f))
            .map(|f| (*f).to_owned())
            .collect())
    }

    /// `search_read(domain, fields, limit, order)`.
    ///
    /// # Errors
    ///
    /// The call's error.
    pub async fn search_read(
        &self,
        http: Option<&OutboundHttp>,
        model: &str,
        domain: Value,
        fields: &[String],
        limit: Option<u32>,
        order: Option<&str>,
        context: Option<Value>,
    ) -> Result<(Vec<Value>, Option<OffsetDateTime>), ConnectorError> {
        let mut named = vec![("domain", domain), ("fields", json!(fields))];
        if let Some(limit) = limit {
            named.push(("limit", json!(limit)));
        }
        if let Some(order) = order {
            named.push(("order", json!(order)));
        }
        let answer = self
            .call(
                http,
                model,
                "search_read",
                Call {
                    named,
                    positional: &["domain"],
                    context,
                    ..Call::default()
                },
            )
            .await?;
        Ok((
            answer.result.as_array().cloned().unwrap_or_default(),
            answer.server_time,
        ))
    }

    /// `search(domain, limit, order)`: ids.
    ///
    /// # Errors
    ///
    /// The call's error.
    pub async fn search(
        &self,
        http: Option<&OutboundHttp>,
        model: &str,
        domain: Value,
        limit: Option<u32>,
        order: Option<&str>,
        context: Option<Value>,
    ) -> Result<Vec<i64>, ConnectorError> {
        let mut named = vec![("domain", domain)];
        if let Some(limit) = limit {
            named.push(("limit", json!(limit)));
        }
        if let Some(order) = order {
            named.push(("order", json!(order)));
        }
        let answer = self
            .call(
                http,
                model,
                "search",
                Call {
                    named,
                    positional: &["domain"],
                    context,
                    ..Call::default()
                },
            )
            .await?;
        Ok(answer
            .result
            .as_array()
            .map(|ids| ids.iter().filter_map(Value::as_i64).collect())
            .unwrap_or_default())
    }

    /// `search_count(domain)`.
    ///
    /// # Errors
    ///
    /// The call's error.
    pub async fn search_count(
        &self,
        http: Option<&OutboundHttp>,
        model: &str,
        domain: Value,
        context: Option<Value>,
    ) -> Result<u64, ConnectorError> {
        let answer = self
            .call(
                http,
                model,
                "search_count",
                Call {
                    named: vec![("domain", domain)],
                    positional: &["domain"],
                    context,
                    ..Call::default()
                },
            )
            .await?;
        Ok(answer.result.as_u64().unwrap_or(0))
    }

    /// `read(ids, fields)`.
    ///
    /// # Errors
    ///
    /// The call's error.
    pub async fn read(
        &self,
        http: Option<&OutboundHttp>,
        model: &str,
        ids: &[i64],
        fields: &[String],
        context: Option<Value>,
    ) -> Result<Vec<Value>, ConnectorError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let answer = self
            .call(
                http,
                model,
                "read",
                Call {
                    ids: Some(ids.to_vec()),
                    named: vec![("fields", json!(fields))],
                    context,
                    ..Call::default()
                },
            )
            .await?;
        Ok(answer.result.as_array().cloned().unwrap_or_default())
    }

    /// `create([values])`: the new record's id.
    ///
    /// # Errors
    ///
    /// The call's error, or an answer without an id.
    pub async fn create(
        &self,
        http: Option<&OutboundHttp>,
        model: &str,
        values: Value,
    ) -> Result<i64, ConnectorError> {
        let answer = self
            .call(
                http,
                model,
                "create",
                Call {
                    named: vec![("vals_list", json!([values]))],
                    positional: &["vals_list"],
                    ..Call::default()
                },
            )
            .await?;
        let id = match &answer.result {
            Value::Array(ids) => ids.first().and_then(Value::as_i64),
            other => other.as_i64(),
        };
        id.ok_or_else(|| {
            ConnectorError::new(
                format!("Odoo created no {model} record"),
                502,
                Kind::Transient,
            )
        })
    }

    /// `client.test()`: the server answers, the credentials work, and the
    /// user may read warehouses (every sync starts there).
    ///
    /// # Errors
    ///
    /// Why the test failed, as the message to show.
    pub async fn test(&self, http: Option<&OutboundHttp>) -> Result<Tested, String> {
        let check = async {
            self.session(http).await?;
            self.search(http, "stock.warehouse", json!([]), Some(1), None, None)
                .await
        };
        check.await.map_err(|error| error.message)?;
        Ok(Tested {
            store_url: self.store_url(),
            account_name: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_become_origins() {
        assert_eq!(
            normalize_odoo_url(" acme.odoo.com/odoo/action-12 ").expect("url"),
            "https://acme.odoo.com"
        );
        assert_eq!(
            normalize_odoo_url("http://erp.local:8069/web#id=3").expect("url"),
            "http://erp.local:8069"
        );
        assert_eq!(
            normalize_odoo_url("").expect_err("empty").message,
            "Odoo URL is required"
        );
        assert_eq!(
            normalize_odoo_url("ftp://x").expect_err("scheme").message,
            "Odoo URL is not valid"
        );
    }

    #[test]
    fn versions_read_as_majors() {
        assert_eq!(
            major_version(&json!([17, 0, 0, "final", 0, ""]), None),
            Some(17)
        );
        assert_eq!(
            major_version(&json!(["saas~18", 2, 0, "final", 0, "e"]), None),
            Some(18)
        );
        assert_eq!(major_version(&Value::Null, Some("19.0")), Some(19));
        assert_eq!(major_version(&Value::Null, Some("saas~18.3+e")), Some(18));
        assert_eq!(major_version(&Value::Null, None), None);
    }

    #[test]
    fn http_dates_parse() {
        let at = http_date(Some("Tue, 17 Nov 2026 10:00:05 GMT")).expect("date");
        assert_eq!(at.unix_timestamp(), 1_794_909_605);
        assert!(http_date(Some("nope")).is_none());
        assert!(http_date(None).is_none());
    }

    #[test]
    fn errors_are_classified() {
        let auth = odoo_error(
            401,
            "werkzeug.exceptions.Unauthorized",
            "Invalid apikey",
            None,
            "acme.odoo.com",
            "acme",
        );
        assert_eq!(auth.kind, Kind::Auth);
        assert_eq!(
            auth.message,
            "Odoo rejected the login or API key. On Odoo Online, external API access needs the Custom plan."
        );
        let self_hosted = odoo_error(
            200,
            "odoo.exceptions.AccessDenied",
            "Access Denied",
            None,
            "erp.local",
            "x",
        );
        assert_eq!(self_hosted.message, "Odoo rejected the login or API key.");
        let access = odoo_error(
            200,
            "odoo.exceptions.AccessError",
            "You are not allowed to access 'Purchase Order' (purchase.order) records.",
            Some("purchase.order"),
            "erp.local",
            "x",
        );
        assert_eq!(access.kind, Kind::Permanent);
        assert!(access.message.starts_with(
            "The Odoo user has no access to purchase.order: give it Purchase access rights."
        ));
        let database = odoo_error(
            200,
            "psycopg2.OperationalError",
            "FATAL:  database \"nope\" does not exist",
            None,
            "erp.local",
            "nope",
        );
        assert_eq!(database.kind, Kind::Auth);
        assert_eq!(database.message, "Odoo has no database named 'nope'");
        let missing = odoo_error(
            200,
            "builtins.KeyError",
            "'sale.order.line'",
            Some("sale.order.line"),
            "h",
            "d",
        );
        assert_eq!(
            missing.message,
            "Odoo has no sale.order.line model: install the Sales app, or turn this sync off"
        );
        let plan = odoo_error(
            403,
            "",
            "External API access is not available on your plan",
            None,
            "a.odoo.com",
            "a",
        );
        assert_eq!(plan.kind, Kind::Auth);
        assert!(plan.message.contains("Custom plan"));
        let validation = odoo_error(
            422,
            "odoo.exceptions.ValidationError",
            "Bad value",
            Some("purchase.order"),
            "h",
            "d",
        );
        assert_eq!(validation.kind, Kind::Permanent);
        assert_eq!(validation.message, "Odoo refused the request: Bad value");
        assert_eq!(
            odoo_error(503, "", "", None, "h", "d").kind,
            Kind::Transient
        );
    }

    #[test]
    fn credentials_are_required() {
        let mut creds = Map::new();
        creds.insert("url".to_owned(), json!("acme.odoo.com"));
        creds.insert("database".to_owned(), json!("acme"));
        creds.insert("login".to_owned(), json!("api@acme.test"));
        assert_eq!(
            Odoo::from_credentials(&creds).expect_err("key").message,
            "API key is required"
        );
        creds.insert("apiKey".to_owned(), json!(" k "));
        let client = Odoo::from_credentials(&creds).expect("client");
        assert_eq!(client.store_url(), "https://acme.odoo.com");
        assert_eq!(client.api_key, "k");
    }

    // ── recorded exchanges, in the shapes Odoo documents ──────────────────

    use std::sync::Arc;

    use crate::odoo::fake::FakeOdoo;

    fn client() -> Odoo {
        let creds: Map<String, Value> = serde_json::from_value(json!({
            "url": "https://acme.odoo.com/odoo",
            "database": "acme",
            "login": "api@acme.test",
            "apiKey": "secret",
        }))
        .expect("creds");
        Odoo::from_credentials(&creds).expect("client")
    }

    fn body(request: &HttpRequest) -> Value {
        serde_json::from_slice(request.body.as_deref().expect("body")).expect("json")
    }

    fn header<'a>(request: &'a HttpRequest, name: &str) -> Option<&'a str> {
        request
            .headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    fn warehouses(fake: &FakeOdoo) {
        fake.add(
            "stock.warehouse",
            vec![json!({ "id": 1, "name": "San Francisco", "code": "WH", "write_date": "2026-11-01 10:00:00" })],
        );
    }

    #[tokio::test]
    async fn odoo_17_speaks_json_rpc() {
        let fake = Arc::new(FakeOdoo::new(17));
        warehouses(&fake);
        let http = fake.http();
        let client = client();
        let (rows, at) = client
            .search_read(
                Some(&http),
                "stock.warehouse",
                json!([["id", ">", 0]]),
                &["name".to_owned()],
                Some(500),
                Some("id asc"),
                Some(json!({ "active_test": false })),
            )
            .await
            .expect("rows");
        assert_eq!(rows, vec![json!({ "id": 1, "name": "San Francisco" })]);
        assert_eq!(
            at.map(time::OffsetDateTime::unix_timestamp),
            Some(1_795_003_200)
        );
        assert_eq!(
            client.session(Some(&http)).await.expect("session"),
            Session {
                major: 17,
                protocol: Protocol::JsonRpc { uid: 2 }
            }
        );
        let requests = fake.requests.lock().expect("lock").clone();
        assert_eq!(requests.len(), 3);
        assert!(
            requests
                .iter()
                .all(|r| r.url == "https://acme.odoo.com/jsonrpc")
        );
        assert!(
            requests
                .iter()
                .all(|r| header(r, "authorization").is_none())
        );
        assert_eq!(
            body(&requests[0])["params"],
            json!({ "service": "common", "method": "version", "args": [] })
        );
        assert_eq!(
            body(&requests[1])["params"],
            json!({ "service": "common", "method": "authenticate", "args": ["acme", "api@acme.test", "secret", {}] })
        );
        assert_eq!(
            body(&requests[2]),
            json!({
                "jsonrpc": "2.0",
                "method": "call",
                "id": 3,
                "params": {
                    "service": "object",
                    "method": "execute_kw",
                    "args": [
                        "acme", 2, "secret", "stock.warehouse", "search_read",
                        [[["id", ">", 0]]],
                        { "fields": ["name"], "limit": 500, "order": "id asc", "context": { "active_test": false } },
                    ],
                },
            })
        );

        // `create` passes its list positionally; `read` its ids.
        let id = client
            .create(
                Some(&http),
                "stock.warehouse",
                json!({ "name": "Ghent", "code": "GH" }),
            )
            .await
            .expect("create");
        assert_eq!(id, 2);
        let read = client
            .read(
                Some(&http),
                "stock.warehouse",
                &[2],
                &["code".to_owned()],
                None,
            )
            .await
            .expect("read");
        assert_eq!(read, vec![json!({ "id": 2, "code": "GH" })]);
        let requests = fake.requests.lock().expect("lock").clone();
        assert_eq!(
            body(&requests[3])["params"]["args"],
            json!(["acme", 2, "secret", "stock.warehouse", "create", [[{ "name": "Ghent", "code": "GH" }]], {}])
        );
        assert_eq!(
            body(&requests[4])["params"]["args"],
            json!(["acme", 2, "secret", "stock.warehouse", "read", [[2]], { "fields": ["code"] }])
        );
    }

    #[tokio::test]
    async fn odoo_19_speaks_json_2() {
        let fake = Arc::new(FakeOdoo::new(19));
        warehouses(&fake);
        let http = fake.http();
        let client = client();
        let ids = client
            .search(
                Some(&http),
                "stock.warehouse",
                json!([]),
                Some(1),
                None,
                None,
            )
            .await
            .expect("ids");
        assert_eq!(ids, vec![1]);
        let id = client
            .create(Some(&http), "stock.warehouse", json!({ "name": "Ghent" }))
            .await
            .expect("create");
        assert_eq!(id, 2);
        let requests = fake.requests.lock().expect("lock").clone();
        // The version over JSON-RPC, then JSON-2 only.
        assert_eq!(requests.len(), 3);
        let search = &requests[1];
        assert_eq!(
            search.url,
            "https://acme.odoo.com/json/2/stock.warehouse/search"
        );
        assert_eq!(search.method, "POST");
        assert_eq!(header(search, "authorization"), Some("bearer secret"));
        assert_eq!(header(search, "x-odoo-database"), Some("acme"));
        assert_eq!(
            header(search, "content-type"),
            Some("application/json; charset=utf-8")
        );
        assert_eq!(body(search), json!({ "domain": [], "limit": 1 }));
        assert_eq!(
            requests[2].url,
            "https://acme.odoo.com/json/2/stock.warehouse/create"
        );
        assert_eq!(
            body(&requests[2]),
            json!({ "vals_list": [{ "name": "Ghent" }] })
        );
        let read = client
            .read(
                Some(&http),
                "stock.warehouse",
                &[1],
                &["code".to_owned()],
                Some(json!({ "lang": "en_US" })),
            )
            .await
            .expect("read");
        assert_eq!(read, vec![json!({ "id": 1, "code": "WH" })]);
        let requests = fake.requests.lock().expect("lock").clone();
        assert_eq!(
            body(&requests[3]),
            json!({ "ids": [1], "fields": ["code"], "context": { "lang": "en_US" } })
        );
    }

    #[tokio::test]
    async fn without_json_rpc_the_version_comes_from_web_version() {
        let fake = Arc::new(FakeOdoo {
            no_jsonrpc: true,
            ..FakeOdoo::new(22)
        });
        let http = fake.http();
        let session = client().session(Some(&http)).await.expect("session");
        assert_eq!(
            session,
            Session {
                major: 22,
                protocol: Protocol::Json2
            }
        );
        let requests = fake.requests.lock().expect("lock").clone();
        assert_eq!(requests[1].method, "GET");
        assert_eq!(requests[1].url, "https://acme.odoo.com/web/version");
    }

    #[tokio::test]
    async fn rejected_keys_are_authentication_failures() {
        for major in [17, 19] {
            let fake = Arc::new(FakeOdoo {
                reject_key: true,
                ..FakeOdoo::new(major)
            });
            warehouses(&fake);
            let http = fake.http();
            let error = client().test(Some(&http)).await.expect_err("rejected");
            assert_eq!(
                error,
                "Odoo rejected the login or API key. On Odoo Online, external API access needs the Custom plan.",
                "Odoo {major}"
            );
            let kind = client()
                .search(Some(&http), "stock.warehouse", json!([]), None, None, None)
                .await
                .expect_err("rejected")
                .kind;
            assert_eq!(kind, Kind::Auth);
        }
    }

    #[tokio::test]
    async fn missing_rights_and_apps_say_which() {
        let fake = Arc::new(FakeOdoo {
            forbidden: vec!["purchase.order".to_owned()],
            ..FakeOdoo::new(18)
        });
        warehouses(&fake);
        let http = fake.http();
        let client = client();
        assert!(client.test(Some(&http)).await.is_ok());
        let error = client
            .fields(Some(&http), "purchase.order")
            .await
            .expect_err("forbidden");
        assert_eq!(error.kind, Kind::Permanent);
        assert!(error.message.starts_with(
            "The Odoo user has no access to purchase.order: give it Purchase access rights."
        ));
        let missing = client
            .fields(Some(&http), "sale.order.line")
            .await
            .expect_err("missing");
        assert_eq!(
            missing.message,
            "Odoo has no sale.order.line model: install the Sales app, or turn this sync off"
        );
    }

    #[tokio::test]
    async fn fields_a_version_lacks_are_left_out() {
        let fake = Arc::new(FakeOdoo::new(17));
        fake.add(
            "sale.order.line",
            vec![json!({ "id": 1, "product_uom": [1, "Units"] })],
        );
        let http = fake.http();
        let picked = client()
            .pick_fields(
                Some(&http),
                "sale.order.line",
                &["product_uom", "product_uom_id", "write_date"],
            )
            .await
            .expect("fields");
        assert_eq!(
            picked,
            vec!["product_uom".to_owned(), "write_date".to_owned()]
        );
    }

    #[tokio::test]
    async fn a_web_page_is_not_odoo() {
        struct Website;
        impl weldsuite_ports::DynOutboundHttp for Website {
            fn send(
                &self,
                _request: HttpRequest,
            ) -> weldsuite_ports::BoxFuture<'_, Result<HttpResponse, weldsuite_ports::PortError>>
            {
                Box::pin(std::future::ready(Ok(HttpResponse::new(
                    200,
                    b"<html>Welcome</html>".to_vec(),
                ))))
            }
        }
        let http = OutboundHttp(Arc::new(Website));
        let error = client().test(Some(&http)).await.expect_err("not odoo");
        assert_eq!(
            error,
            "No Odoo server answered at https://acme.odoo.com: check the URL"
        );
    }
}
