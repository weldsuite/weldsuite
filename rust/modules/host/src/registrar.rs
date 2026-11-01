//! `@weldsuite/realtime-registrar`: Realtime Register's REST API
//! (`https://api.yoursrs.com/v2/`, OTE `https://api.yoursrs-ote.com/v2/`)
//! and its ADAC availability checker (`https://adac.api.yoursrs.com/action`),
//! over the outbound HTTP port. Only what host-api calls: checks and search,
//! domain info, auth codes, transfers, updates, the transfer lock and
//! process polling.

use std::fmt;

use futures_util::future::join_all;
use serde_json::{Map, Value, json};
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::js::{encode_uri_component, form_value, truthy};

const ADAC_ACTION_URL: &str = "https://adac.api.yoursrs.com/action";
/// TLDs an OTE search checks when the caller passes none.
pub(crate) const OTE_SEARCH_DEFAULT_TLDS: [&str; 5] = ["com", "net", "org", "eu", "io"];
/// Upper bound on REST checks per OTE search.
const OTE_SEARCH_MAX_NAMES: usize = 10;
/// TLDs whose registries reject `privacyProtect=true`.
const PRIVACY_PROTECT_UNSUPPORTED_TLDS: [&str; 1] = ["de"];

/// `RealtimeRegistrarError`.
#[derive(Debug, Clone)]
pub(crate) struct RtrError {
    pub(crate) status: u16,
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) endpoint: String,
}

impl fmt::Display for RtrError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "RealtimeRegistrarError {} {} on {}: {}",
            self.status, self.code, self.endpoint, self.message
        )
    }
}

impl RtrError {
    fn new(status: u16, code: &str, message: impl Into<String>, endpoint: &str) -> Self {
        Self {
            status,
            code: code.to_owned(),
            message: message.into(),
            endpoint: endpoint.to_owned(),
        }
    }
}

/// `DomainCheckResult`.
#[derive(Debug, Clone, Default)]
pub(crate) struct CheckResult {
    pub(crate) name: String,
    pub(crate) available: bool,
    pub(crate) premium: bool,
    pub(crate) price_cents: Option<f64>,
    pub(crate) currency: Option<String>,
    pub(crate) reason: Option<String>,
}

impl CheckResult {
    fn failed(name: &str) -> Self {
        Self {
            name: name.to_owned(),
            reason: Some("check_failed".to_owned()),
            ..Self::default()
        }
    }
}

/// `RegisteredDomain`.
#[derive(Debug, Clone)]
pub(crate) struct RegisteredDomain {
    pub(crate) id: String,
    pub(crate) status: Vec<String>,
    pub(crate) expires_at: Option<String>,
    pub(crate) auto_renew: bool,
    pub(crate) locked: bool,
    pub(crate) privacy_protect: bool,
    pub(crate) auth_code: Option<String>,
}

/// `TransferResult`, kept as the JSON `registrarResponse` stores.
#[derive(Debug, Clone)]
pub(crate) struct TransferResult {
    pub(crate) status: Option<String>,
    pub(crate) process_id: i64,
    pub(crate) privacy_protect: bool,
    pub(crate) response: Value,
}

/// The process outcome `pollProcess` reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    Completed,
    Pending,
    Failed,
}

/// The platform contact handles (`REALTIME_REGISTER_CONTACT_*`).
#[derive(Debug, Clone, Default)]
pub(crate) struct ContactEnv {
    pub(crate) admin: Option<String>,
    pub(crate) tech: Option<String>,
    pub(crate) billing: Option<String>,
}

/// `resolvePlatformRegistrarContacts`: `None` when the admin handle is
/// missing (`MissingPlatformRegistrantError`).
pub(crate) fn platform_contacts(env: &ContactEnv) -> Option<(String, Value)> {
    let admin = env.admin.as_deref().map(str::trim).unwrap_or_default();
    if admin.is_empty() {
        return None;
    }
    let pick = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(admin)
            .to_owned()
    };
    let contacts = json!([
        { "role": "ADMIN", "handle": admin },
        { "role": "TECH", "handle": pick(&env.tech) },
        { "role": "BILLING", "handle": pick(&env.billing) },
    ]);
    Some((admin.to_owned(), contacts))
}

/// `normalizeTld`.
fn normalize_tld(tld: &str) -> String {
    tld.strip_prefix('.').unwrap_or(tld).trim().to_lowercase()
}

/// `tldSupportsPrivacyProtect`.
pub(crate) fn tld_supports_privacy_protect(domain_or_tld: &str) -> bool {
    let normalized = normalize_tld(domain_or_tld);
    if normalized.is_empty() {
        return true;
    }
    let labels: Vec<&str> = normalized.split('.').filter(|l| !l.is_empty()).collect();
    !(0..labels.len()).any(|i| PRIVACY_PROTECT_UNSUPPORTED_TLDS.contains(&labels[i..].join(".").as_str()))
}

/// `privacyProtectForDomain`.
pub(crate) fn privacy_protect_for_domain(domain: &str) -> bool {
    tld_supports_privacy_protect(domain)
}

/// `isPrivacyProtectUnsupportedError`.
fn is_privacy_protect_unsupported(error: &RtrError) -> bool {
    let haystack = format!("{} {}", error.code, error.message).to_lowercase();
    let privacy = regex::Regex::new(r"privacy\s*protect(ion)?")
        .map(|re| re.is_match(&haystack))
        .unwrap_or(false);
    privacy && haystack.contains("not supported")
}

/// `normalizeDomainSearchQuery`.
fn normalize_search(query: &str) -> String {
    let mut text = query.trim().to_lowercase();
    for prefix in ["https://", "http://"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest.to_owned();
            break;
        }
    }
    if let Some(rest) = text.strip_prefix("www.") {
        text = rest.to_owned();
    }
    if let Some(rest) = text.strip_suffix('.') {
        text = rest.to_owned();
    }
    text
}

/// `domainSearchSld`.
fn search_sld(query: &str) -> String {
    let cleaned = normalize_search(query);
    match cleaned.find('.') {
        Some(dot) => cleaned[..dot].to_owned(),
        None => cleaned,
    }
}

/// Realtime Register, configured from the env (`getRealtimeRegistrar`).
#[derive(Clone)]
pub(crate) struct RealtimeRegistrar {
    api_key: String,
    customer: String,
    adac_key: Option<String>,
    adac_tld_set: Option<String>,
    ote: bool,
    base: &'static str,
    http: OutboundHttp,
}

impl fmt::Debug for RealtimeRegistrar {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RealtimeRegistrar")
            .field("ote", &self.ote)
            .finish_non_exhaustive()
    }
}

impl RealtimeRegistrar {
    /// `null` without an API key and customer handle.
    pub(crate) fn from_env(value: &dyn Fn(&str) -> Option<String>, http: OutboundHttp) -> Option<Self> {
        let trimmed = |name: &str| {
            value(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let api_key = trimmed("REALTIME_REGISTER_API_KEY")?;
        let customer = trimmed("REALTIME_REGISTER_CUSTOMER")?;
        let ote = value("REALTIME_REGISTER_OTE")
            .is_some_and(|v| v.trim().to_lowercase() == "true");
        Some(Self {
            api_key,
            customer,
            adac_key: trimmed("REALTIME_REGISTER_ADAC_API_KEY"),
            adac_tld_set: trimmed("REALTIME_REGISTER_ADAC_TLD_SET_TOKEN"),
            ote,
            base: if ote {
                "https://api.yoursrs-ote.com/v2/"
            } else {
                "https://api.yoursrs.com/v2/"
            },
            http,
        })
    }

    pub(crate) fn is_ote(&self) -> bool {
        self.ote
    }

    fn has_adac(&self) -> bool {
        self.adac_key.is_some() && !self.ote
    }

    /// `canSearch`.
    pub(crate) fn can_search(&self) -> bool {
        self.has_adac() || self.ote
    }

    fn url(&self, path: &str, query: &[(&str, &str)]) -> String {
        let mut url = format!("{}{}", self.base, path.trim_start_matches('/'));
        if !query.is_empty() {
            let pairs: Vec<String> = query
                .iter()
                .map(|(k, v)| format!("{}={}", form_value(k), form_value(v)))
                .collect();
            url.push('?');
            url.push_str(&pairs.join("&"));
        }
        url
    }

    /// `request`: the body (JSON, or the text), the status and the
    /// `X-Process-Id` header.
    async fn request(
        &self,
        endpoint: &str,
        method: &str,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<(Value, u16, Option<i64>), RtrError> {
        let mut request = HttpRequest::empty(method, self.url(path, query))
            .header("authorization", format!("ApiKey {}", self.api_key));
        if let Some(body) = body {
            request = request.header("content-type", "application/json");
            request.body = Some(body.to_string().into_bytes());
        }
        let response = self.http.send(request).await.map_err(|error| {
            RtrError::new(
                0,
                "NETWORK_ERROR",
                format!("Realtime Register network error on {endpoint}: {error}"),
                endpoint,
            )
        })?;
        let process_id = response
            .header("x-process-id")
            .and_then(crate::js::parse_int);
        let text = response.text();
        let data = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text.clone()))
        };
        if !response.ok() {
            let code = data
                .get("type")
                .and_then(Value::as_str)
                .map_or_else(|| format!("HTTP_{}", response.status), str::to_owned);
            let message = data
                .get("message")
                .filter(|m| !m.is_null())
                .map(crate::js::as_text)
                .or_else(|| data.get("title").filter(|t| !t.is_null()).map(crate::js::as_text))
                .or_else(|| match &data {
                    Value::String(text) if !text.is_empty() => Some(text.clone()),
                    _ => None,
                })
                .unwrap_or_else(|| format!("Realtime Register {} on {endpoint}", response.status));
            return Err(RtrError::new(response.status, &code, message, endpoint));
        }
        Ok((data, response.status, process_id))
    }

    async fn check_domain(&self, name: &str) -> Result<CheckResult, RtrError> {
        let (data, _, _) = self
            .request(
                "domain-check",
                "GET",
                &format!("domains/{}/check", encode_uri_component(name)),
                &[("renewPrice", "true")],
                None,
            )
            .await?;
        Ok(map_check(name, &data))
    }

    /// `searchDomains(query, tlds, limit)`.
    pub(crate) async fn search_domains(
        &self,
        query: &str,
        tlds: &[String],
        limit: f64,
    ) -> Result<Vec<CheckResult>, RtrError> {
        let cleaned = normalize_search(query);
        if cleaned.is_empty() {
            return Ok(Vec::new());
        }
        if self.ote {
            return self.search_via_rest(&cleaned, tlds, limit).await;
        }
        let events = self
            .adac("input", &cleaned, self.adac_tld_set.as_deref(), true)
            .await?;
        let sld = search_sld(&cleaned);
        let mut results: Vec<CheckResult> = collapse_adac(&events)?
            .into_iter()
            .filter(|r| !sld.is_empty() && r.name.trim().to_lowercase().split('.').next() == Some(sld.as_str()))
            .collect();
        let suffixes: Vec<String> = tlds
            .iter()
            .map(|t| normalize_tld(t))
            .filter(|t| !t.is_empty())
            .collect();
        if !suffixes.is_empty() {
            results.retain(|r| {
                let suffix = r.name.split('.').skip(1).collect::<Vec<_>>().join(".");
                suffixes.contains(&suffix)
            });
        }
        if cleaned.contains('.') {
            // A stable sort: the typed name first.
            results.sort_by_key(|r| usize::from(r.name != cleaned));
        }
        results.truncate(js_slice_end(limit));
        Ok(results)
    }

    async fn search_via_rest(
        &self,
        cleaned: &str,
        tlds: &[String],
        limit: f64,
    ) -> Result<Vec<CheckResult>, RtrError> {
        let sld = search_sld(cleaned);
        if sld.is_empty() {
            return Ok(Vec::new());
        }
        let suffixes: Vec<String> = tlds
            .iter()
            .map(|t| t.strip_prefix('.').unwrap_or(t).to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        let mut candidates: Vec<String> = Vec::new();
        if cleaned.contains('.') {
            candidates.push(cleaned.to_owned());
        }
        if suffixes.is_empty() {
            candidates.extend(OTE_SEARCH_DEFAULT_TLDS.iter().map(|t| format!("{sld}.{t}")));
        } else {
            candidates.extend(suffixes.iter().map(|t| format!("{sld}.{t}")));
        }
        let mut names: Vec<String> = Vec::new();
        for name in candidates {
            if !names.contains(&name) {
                names.push(name);
            }
        }
        names.truncate(js_slice_end(limit.min(OTE_SEARCH_MAX_NAMES as f64)));
        Ok(self.check_via_rest(&names).await)
    }

    /// `checkDomains`: ADAC per name, or the registrar REST check.
    pub(crate) async fn check_domains(&self, domains: &[String]) -> Vec<CheckResult> {
        let names: Vec<String> = domains
            .iter()
            .map(|d| d.trim().to_lowercase())
            .filter(|d| !d.is_empty())
            .collect();
        if names.is_empty() {
            return Vec::new();
        }
        if !self.has_adac() {
            return self.check_via_rest(&names).await;
        }
        let mut out = Vec::with_capacity(names.len());
        for batch in names.chunks(5) {
            let settled = join_all(batch.iter().map(|name| self.adac_check(name))).await;
            for (name, result) in batch.iter().zip(settled) {
                out.push(result.unwrap_or_else(|_| CheckResult::failed(name)));
            }
        }
        out
    }

    async fn check_via_rest(&self, names: &[String]) -> Vec<CheckResult> {
        let mut out = Vec::with_capacity(names.len());
        for batch in names.chunks(5) {
            let settled = join_all(batch.iter().map(|name| self.check_domain(name))).await;
            for (name, result) in batch.iter().zip(settled) {
                out.push(result.unwrap_or_else(|_| CheckResult::failed(name)));
            }
        }
        out
    }

    async fn adac_check(&self, name: &str) -> Result<CheckResult, RtrError> {
        let events = self.adac("check", name, None, false).await?;
        collapse_adac(&events)?.into_iter().next().ok_or_else(|| {
            RtrError::new(502, "ADAC_EMPTY", format!("ADAC returned no status for {name}"), "adac")
        })
    }

    /// `postAdacAction`.
    async fn adac(
        &self,
        action: &str,
        input: &str,
        tld_set: Option<&str>,
        hints: bool,
    ) -> Result<Vec<Value>, RtrError> {
        let Some(api_key) = self.adac_key.as_deref() else {
            return Err(RtrError::new(
                503,
                "ADAC_NOT_CONFIGURED",
                "Realtime Register ADAC is not configured",
                "adac",
            ));
        };
        let mut data = Map::new();
        data.insert("input".to_owned(), json!(input));
        if let Some(token) = tld_set {
            data.insert("tld_set_token".to_owned(), json!(token));
        }
        if hints {
            data.insert(
                "hints".to_owned(),
                json!({
                    "domainsbot": false,
                    "sidn": false,
                    "rns": false,
                    "prefixes-suffixes": false,
                    "namesuggestion": false,
                }),
            );
        }
        let body = json!({ "action": action, "api_key": api_key, "data": data });
        let response = self
            .http
            .send(HttpRequest::json("POST", ADAC_ACTION_URL, &body))
            .await
            .map_err(|error| {
                RtrError::new(0, "NETWORK_ERROR", format!("ADAC network error: {error}"), "adac")
            })?;
        let text = response.text();
        if !response.ok() {
            let mut message = format!("ADAC returned {}", response.status);
            match serde_json::from_str::<Value>(&text) {
                Ok(parsed) => {
                    if let Some(m) = parsed.get("message").and_then(Value::as_str) {
                        m.clone_into(&mut message);
                    } else if let Some(d) = parsed.get("data").and_then(Value::as_str) {
                        d.clone_into(&mut message);
                    }
                }
                Err(_) => {
                    if !text.is_empty() {
                        message = crate::js::slice_utf16(&text, 300);
                    }
                }
            }
            return Err(RtrError::new(
                response.status,
                &format!("HTTP_{}", response.status),
                message,
                "adac",
            ));
        }
        Ok(parse_adac_events(&text))
    }

    /// `getDomain`.
    pub(crate) async fn get_domain(&self, name: &str) -> Result<RegisteredDomain, RtrError> {
        let (data, _, _) = self
            .request(
                "domain-get",
                "GET",
                &format!("domains/{}", encode_uri_component(name)),
                &[],
                None,
            )
            .await?;
        Ok(map_domain(&data))
    }

    /// `getAuthCode`.
    pub(crate) async fn get_auth_code(&self, name: &str) -> Result<Option<String>, RtrError> {
        let domain = self.get_domain(name).await?;
        if let Some(code) = domain.auth_code.filter(|c| !c.is_empty()) {
            return Ok(Some(code));
        }
        match self
            .request(
                "domain-info-authcode",
                "GET",
                &format!("domains/{}/info", encode_uri_component(name)),
                &[("type", "AUTHCODE")],
                None,
            )
            .await
        {
            Ok((data, _, _)) => Ok(data
                .get("authcode")
                .filter(|c| !c.is_null())
                .map(crate::js::as_text)),
            Err(error) if error.status == 404 || error.status == 400 => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// `updateDomain(name, update)`: the update, then (unless the registrar
    /// answered asynchronously) the domain read back.
    pub(crate) async fn update_domain(&self, name: &str, body: &Value) -> Result<(), RtrError> {
        let (_, status, process_id) = self
            .request(
                "domain-update",
                "POST",
                &format!("domains/{}/update", encode_uri_component(name)),
                &[],
                Some(body),
            )
            .await?;
        if status == 202 || process_id.is_some_and(|id| id != 0) {
            return Ok(());
        }
        self.get_domain(name).await.map(|_| ())
    }

    /// `setTransferLock`.
    pub(crate) async fn set_transfer_lock(&self, name: &str, locked: bool) -> Result<(), RtrError> {
        let current = self.get_domain(name).await?;
        let mut next: Vec<String> = current
            .status
            .into_iter()
            .filter(|s| s != "CLIENT_TRANSFER_PROHIBITED")
            .collect();
        if locked {
            next.push("CLIENT_TRANSFER_PROHIBITED".to_owned());
        }
        self.update_domain(name, &json!({ "status": next })).await
    }

    /// `transfer`: once, and again without privacy protection when the
    /// registry refuses it.
    pub(crate) async fn transfer(&self, input: &Value) -> Result<TransferResult, RtrError> {
        match self.transfer_once(input).await {
            Ok(result) => Ok(result),
            Err(error)
                if truthy(input.get("privacyProtect")) && is_privacy_protect_unsupported(&error) =>
            {
                let mut retry = input.clone();
                retry["privacyProtect"] = json!(false);
                self.transfer_once(&retry).await
            }
            Err(error) => Err(error),
        }
    }

    async fn transfer_once(&self, input: &Value) -> Result<TransferResult, RtrError> {
        let name = input["name"].as_str().unwrap_or_default();
        let privacy = truthy(input.get("privacyProtect"));
        let mut body = Map::new();
        body.insert("customer".to_owned(), json!(self.customer));
        for (key, field) in [
            ("registrant", "registrant"),
            ("contacts", "contacts"),
            ("period", "periodMonths"),
            ("ns", "nameservers"),
            ("authcode", "authCode"),
            ("designatedAgent", "designatedAgent"),
        ] {
            if let Some(value) = input.get(field) {
                body.insert(key.to_owned(), value.clone());
            }
        }
        if privacy {
            body.insert("privacyProtect".to_owned(), json!(true));
        }
        let (data, _, header_id) = self
            .request(
                "domain-transfer",
                "POST",
                &format!("domains/{}/transfer", encode_uri_component(name)),
                &[],
                Some(&Value::Object(body)),
            )
            .await?;
        #[allow(clippy::cast_possible_truncation)]
        let process_id = match data.get("processId") {
            Some(Value::Number(n)) => n.as_f64().map(|n| n as i64),
            Some(Value::Null) | None => header_id,
            Some(_) => None,
        }
        .filter(|id| *id > 0)
        .ok_or_else(|| {
            RtrError::new(
                502,
                "MISSING_PROCESS_ID",
                "Realtime Register transfer response did not include a process id",
                "domain-transfer",
            )
        })?;
        let mut response = Map::new();
        response.insert(
            "domainName".to_owned(),
            data.get("domainName")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| json!(name)),
        );
        if let Some(status) = data.get("status") {
            response.insert("status".to_owned(), status.clone());
        }
        response.insert("processId".to_owned(), json!(process_id));
        response.insert(
            "type".to_owned(),
            data.get("type")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| json!("IN")),
        );
        for key in ["requestedDate", "expiryDate"] {
            if let Some(value) = data.get(key) {
                response.insert(key.to_owned(), value.clone());
            }
        }
        response.insert("privacyProtect".to_owned(), json!(privacy));
        Ok(TransferResult {
            status: data.get("status").and_then(Value::as_str).map(str::to_owned),
            process_id,
            privacy_protect: privacy,
            response: Value::Object(response),
        })
    }

    /// `pollProcess`.
    pub(crate) async fn poll_process(&self, process_id: i64) -> Result<Outcome, RtrError> {
        let (data, _, _) = self
            .request(
                "process-get",
                "GET",
                &format!("processes/{process_id}"),
                &[],
                None,
            )
            .await?;
        let status = data
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_uppercase();
        Ok(match status.as_str() {
            "COMPLETED" => Outcome::Completed,
            "FAILED" | "INVALID" | "CANCELLED" | "IN_DOUBT" => Outcome::Failed,
            _ => Outcome::Pending,
        })
    }
}

/// `slice(0, n)` with a JavaScript number bound.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub(crate) fn js_slice_end(limit: f64) -> usize {
    if limit.is_nan() || limit <= 0.0 {
        0
    } else {
        limit.trunc().min(1e9) as usize
    }
}

fn map_check(name: &str, data: &Value) -> CheckResult {
    let available = truthy(data.get("available"));
    let premium = truthy(data.get("premium"));
    let fallback = if premium {
        "domain_premium"
    } else {
        "domain_unavailable"
    };
    CheckResult {
        name: name.to_owned(),
        available,
        premium,
        price_cents: data.get("price").and_then(Value::as_f64),
        currency: data
            .get("currency")
            .and_then(Value::as_str)
            .map(str::to_owned),
        reason: if available {
            None
        } else {
            Some(
                data.get("reason")
                    .filter(|r| !r.is_null())
                    .map_or_else(|| fallback.to_owned(), crate::js::as_text),
            )
        },
    }
}

fn map_domain(data: &Value) -> RegisteredDomain {
    let status: Vec<String> = data
        .get("status")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(crate::js::as_text).collect())
        .unwrap_or_default();
    let locked = status.iter().any(|s| {
        matches!(
            s.as_str(),
            "CLIENT_TRANSFER_PROHIBITED" | "SERVER_TRANSFER_PROHIBITED" | "REGISTRAR_TRANSFER_PROHIBITED"
        )
    });
    RegisteredDomain {
        id: data
            .get("domainName")
            .map(crate::js::as_text)
            .unwrap_or_default(),
        status,
        expires_at: data
            .get("expiryDate")
            .filter(|v| !v.is_null())
            .map(crate::js::as_text),
        auto_renew: data
            .get("autoRenew")
            .filter(|v| !v.is_null())
            .is_none_or(|v| truthy(Some(v))),
        locked,
        privacy_protect: truthy(data.get("privacyProtect")),
        auth_code: data
            .get("authcode")
            .filter(|v| !v.is_null())
            .map(crate::js::as_text),
    }
}

/// `parseAdacEvents`: a JSON array or object, else one JSON value per line.
fn parse_adac_events(text: &str) -> Vec<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::Array(items)) => return items,
        Ok(value @ Value::Object(_)) => return vec![value],
        _ => {}
    }
    let mut events = Vec::new();
    for line in trimmed.split('\n') {
        let row = line.trim();
        if row.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(row) {
            Ok(Value::Array(items)) => events.extend(items),
            Ok(value @ Value::Object(_)) => events.push(value),
            _ => {}
        }
    }
    events
}

/// `collapseAdacResults`: an error event fails; the last non-waiting status
/// per name wins, in first-seen order.
fn collapse_adac(events: &[Value]) -> Result<Vec<CheckResult>, RtrError> {
    if let Some(error) = events
        .iter()
        .find(|e| e.get("action").and_then(Value::as_str) == Some("error"))
    {
        let message = error
            .get("data")
            .and_then(Value::as_str)
            .unwrap_or("ADAC error");
        return Err(RtrError::new(400, "ADAC_ERROR", message, "adac"));
    }
    let mut order: Vec<String> = Vec::new();
    let mut by_name: Vec<(String, CheckResult)> = Vec::new();
    for event in events {
        if event.get("action").and_then(Value::as_str) != Some("domain_status") {
            continue;
        }
        let data = &event["data"];
        let (Some(name), Some(status)) = (
            data.get("domain_name").and_then(Value::as_str),
            data.get("status").and_then(Value::as_f64),
        ) else {
            continue;
        };
        if status == 0.0 {
            continue;
        }
        let available = status == 1.0;
        let reason = if available {
            None
        } else if status == 2.0 {
            Some("domain_unavailable")
        } else if status == 4.0 {
            Some("check_failed")
        } else {
            Some("unknown")
        };
        let name = name.to_lowercase();
        let mapped = CheckResult {
            name: name.clone(),
            available,
            premium: data.get("type").and_then(Value::as_str) == Some("premium"),
            price_cents: data.get("price").and_then(Value::as_f64),
            currency: data
                .get("currency")
                .and_then(Value::as_str)
                .map(str::to_owned),
            reason: reason.map(str::to_owned),
        };
        if let Some(slot) = by_name.iter_mut().find(|(n, _)| *n == name) {
            slot.1 = mapped;
        } else {
            order.push(name.clone());
            by_name.push((name, mapped));
        }
    }
    Ok(by_name.into_iter().map(|(_, result)| result).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privacy_and_contacts() {
        assert!(!tld_supports_privacy_protect("example.de"));
        assert!(tld_supports_privacy_protect("example.com"));
        assert!(platform_contacts(&ContactEnv::default()).is_none());
        let (registrant, contacts) = platform_contacts(&ContactEnv {
            admin: Some(" adm ".to_owned()),
            tech: None,
            billing: Some("bill".to_owned()),
        })
        .unwrap_or_default();
        assert_eq!(registrant, "adm");
        assert_eq!(contacts[1]["handle"], "adm");
        assert_eq!(contacts[2]["handle"], "bill");
        assert!(is_privacy_protect_unsupported(&RtrError::new(
            400,
            "x",
            "Privacy protect is not supported",
            "e"
        )));
    }

    #[test]
    fn adac_events_collapse() {
        let events = parse_adac_events(
            r#"[{"action":"domain_status","data":{"domain_name":"A.com","status":0}},
                {"action":"domain_status","data":{"domain_name":"a.com","status":2}},
                {"action":"domain_status","data":{"domain_name":"a.net","status":1,"type":"premium","price":1200}}]"#,
        );
        let results = collapse_adac(&events).unwrap_or_default();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].reason.as_deref(), Some("domain_unavailable"));
        assert!(results[1].premium);
        assert_eq!(normalize_search(" https://www.Example.com. "), "example.com");
        assert_eq!(search_sld("weldsuite.com"), "weldsuite");
    }
}
