//! Hetzner's Cloud DNS (`api.hetzner.cloud/v1`, zones and record sets) as the
//! [`DnsHost`] of a Kubernetes install that keeps customer zones at Hetzner
//! (`WELDHOST_DNS_PROVIDER=hetzner`, ADR HOST-008).
//!
//! - **Zones are addressed by name.** The API takes a zone's id or its name
//!   everywhere, so `dns_zones.external_zone_id` holds the zone's name. A
//!   numeric id still works.
//! - **Branded nameservers.** With `WELDHOST_NAMESERVERS` set (e.g.
//!   `ns1.weldhost.com,…`), a new zone gets those names as extra apex NS
//!   records (Hetzner's own three can't be removed), they are the
//!   nameservers customers are told to use, and a delegation to them counts
//!   as active. The names resolve to Hetzner's nameservers through glue at
//!   their own domain's registrar (rust/deploy/hetzner/README.md, "WeldHost
//!   DNS").
//! - **record sets, not records.** Hetzner keeps one set per name and type. A
//!   record's id here is `{name}/{type}/{hash of its value}`, which the
//!   update and delete resolve against the live set. The apex NS set and the
//!   SOA are the platform's and are not listed.
//! - **Values as the routes give them.** Names arrive and leave as full
//!   domain names (as Cloudflare's), contents in the forms
//!   [`crate::cloudflare`] uses (TXT unquoted, MX without its priority, SRV
//!   and CAA in zone-file form); Hetzner wants zone-file values, so host
//!   names get their final dot and TXT is quoted in 255-byte strings.
//! - **Writes are actions.** Each write answers with an action; the call
//!   waits a few seconds for it, so the re-sync that follows sees the change
//!   and a refused value comes back as an error.
//!
//! - **Zones belong to a workspace.** Every workspace's zones share one
//!   project and token, and a zone's id is its domain name, which anyone can
//!   type into a zone row (`POST /api/dns-zones` takes `externalZoneId`). So
//!   a zone is labelled with the workspace that proved the domain
//!   (`weldhost/workspace`, at [`DnsHost::create_zone`]), and every read or
//!   write first checks the label against the caller's workspace: a zone of
//!   another workspace, or one without the label, is refused.
//!
//! One API token reaches every resource of its Hetzner project, so the
//! customer zones get a project of their own.

use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Map, Value, json};
use weldsuite_ports::{BoxFuture, HttpRequest, HttpResponse, OutboundHttp};

use crate::cloudflare::{is_quoted_txt, unwrap_txt};
use crate::dns_host::{Created, DnsHost, DnsRecord, RecordInput, Zone, ZoneError, ZoneErrorKind};
use crate::js::{as_text, encode_uri_path, js_trim, number_json, number_of};

const API: &str = "https://api.hetzner.cloud/v1";

/// The record types the routes can edit, as [`crate::cloudflare`] lists them.
const EDITABLE: [&str; 8] = ["A", "AAAA", "CNAME", "MX", "TXT", "CAA", "SRV", "NS"];

/// The waits between looks at a running action: five seconds in all, and
/// few looks, since every look counts against the project's 3600 requests an
/// hour.
const ACTION_WAITS_MS: [u64; 4] = [250, 750, 1500, 2500];

/// The most pages of a zone's record sets read (50 sets a page).
const MAX_PAGES: u32 = 200;

/// The zone label naming the workspace that owns the zone (`workspaces.id`).
const WORKSPACE_LABEL: &str = "weldhost/workspace";

/// An error answer of the API, or a connection failure.
#[derive(Debug, Clone)]
struct ApiError {
    /// `None` for a connection failure.
    status: Option<u16>,
    /// `error.code` (`not_found`, `uniqueness_error`, `invalid_input`, …).
    code: String,
    message: String,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

impl ApiError {
    fn not_found(&self) -> bool {
        self.status == Some(404) || self.code == "not_found"
    }
}

fn to_zone_error(error: &ApiError) -> ZoneError {
    let (kind, message) = match (error.status, error.code.as_str()) {
        (Some(401), _) | (_, "unauthorized" | "forbidden" | "token_readonly") => (
            ZoneErrorKind::AuthFailed,
            "Hetzner API token is missing or lacks read and write access".to_owned(),
        ),
        (_, "uniqueness_error") => (
            ZoneErrorKind::InAnotherAccount,
            "A DNS zone for this domain already exists at Hetzner".to_owned(),
        ),
        (_, "invalid_input" | "json_error") => {
            (ZoneErrorKind::InvalidDomain, error.message.clone())
        }
        _ => {
            let status = error
                .status
                .map_or_else(|| "(no status)".to_owned(), |s| s.to_string());
            (
                ZoneErrorKind::Unknown,
                format!("Hetzner API error {status}: {}", error.message),
            )
        }
    };
    ZoneError {
        kind,
        message,
        codes: Vec::new(),
        status: error.status,
    }
}

fn unknown(message: impl Into<String>) -> ZoneError {
    ZoneError {
        kind: ZoneErrorKind::Unknown,
        message: message.into(),
        codes: Vec::new(),
        status: None,
    }
}

/// Retry a call that failed this way: a connection failure, a rate limit
/// or the server's trouble.
fn retryable(error: &ApiError) -> bool {
    matches!(error.status, None | Some(429 | 502 | 503 | 504))
}

// ── Names and values ────────────────────────────────────────────────────────

/// A host name lower case, without its final dot.
fn bare(name: &str) -> String {
    js_trim(name).trim_end_matches('.').to_lowercase()
}

/// A record's name relative to the zone (`@` for the apex), as Hetzner
/// names record sets: from a full name, a relative one or `@`.
fn relative_name(name: &str, zone: &str) -> String {
    let name = bare(name);
    if name.is_empty() || name == "@" || name == zone {
        return "@".to_owned();
    }
    name.strip_suffix(&format!(".{zone}"))
        .map_or(name.clone(), str::to_owned)
}

/// The full name of a relative record set name.
fn full_name(name: &str, zone: &str) -> String {
    if name == "@" {
        zone.to_owned()
    } else {
        format!("{name}.{zone}")
    }
}

/// A host name as an absolute zone-file name (`mail.example.com.`).
fn absolute(host: &str, zone: &str) -> String {
    let host = js_trim(host);
    if host == "@" {
        return format!("{zone}.");
    }
    let host = host.to_lowercase();
    if host.ends_with('.') {
        host
    } else {
        format!("{host}.")
    }
}

/// An integer as the zone file writes it (`10`, not `10.0`).
fn integer(value: f64) -> String {
    match number_json(value) {
        Value::Number(n) => n.to_string(),
        _ => "0".to_owned(),
    }
}

/// TXT content as zone-file strings: quoted as it is when it already is,
/// else escaped and cut into strings of at most 255 bytes.
fn quote_txt(content: &str) -> String {
    let trimmed = js_trim(content);
    if !trimmed.is_empty() && is_quoted_txt(trimmed) {
        return trimmed.to_owned();
    }
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut length = 0;
    for c in content.chars() {
        if length + c.len_utf8() > 255 {
            chunks.push(std::mem::take(&mut current));
            length = 0;
        }
        length += c.len_utf8();
        current.push(c);
    }
    if !current.is_empty() || chunks.is_empty() {
        chunks.push(current);
    }
    chunks
        .iter()
        .map(|chunk| format!("\"{}\"", chunk.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The route's record as Hetzner's value for its type.
fn hetzner_value(record: &RecordInput, zone: &str) -> String {
    let content = js_trim(&record.content);
    let parts: Vec<&str> = content.split_whitespace().collect();
    match record.kind.as_str() {
        "CNAME" | "NS" | "PTR" => absolute(content, zone),
        "MX" => {
            // The priority comes apart (`priority`), as Cloudflare's does; a
            // value typed as `10 mail.example.com` keeps its own.
            let (priority, host) = match parts.as_slice() {
                [first, host] if record.priority.is_none() && number_of(first).is_some() => {
                    (number_of(first).unwrap_or(0.0), *host)
                }
                _ => (record.priority.unwrap_or(0.0), content),
            };
            format!("{} {}", integer(priority), absolute(host, zone))
        }
        "SRV" => {
            // `createDnsRecordInZone`'s reading: priority (or `priority`),
            // weight, port, target.
            let number = |i: usize| parts.get(i).and_then(|p| number_of(p)).unwrap_or(0.0);
            let priority = record.priority.unwrap_or_else(|| number(0));
            let target = parts
                .get(3..)
                .map(|rest| rest.join(" "))
                .unwrap_or_default();
            format!(
                "{} {} {} {}",
                integer(priority),
                integer(number(1)),
                integer(number(2)),
                absolute(&target, zone)
            )
        }
        "CAA" => {
            let flags = parts.first().and_then(|p| number_of(p)).unwrap_or(0.0);
            let tag = parts.get(1).copied().unwrap_or("issue");
            let value = parts
                .get(2..)
                .map(|rest| rest.join(" "))
                .unwrap_or_default();
            let value = value.strip_prefix('"').unwrap_or(&value);
            let value = value.strip_suffix('"').unwrap_or(value);
            format!("{} {tag} \"{value}\"", integer(flags))
        }
        "TXT" => quote_txt(&record.content),
        _ => content.to_owned(),
    }
}

/// The TTL Hetzner gets: Cloudflare's 1 (automatic) is the zone's default
/// (`null`), nothing is an hour as on Cloudflare, and less than a minute is
/// a minute (Hetzner's least).
fn hetzner_ttl(ttl: Option<f64>) -> Value {
    match ttl {
        None => json!(3600),
        Some(ttl) if ttl <= 1.0 => Value::Null,
        Some(ttl) => number_json(ttl.max(60.0)),
    }
}

/// A value compared for duplicates: TXT by its text, the rest without case,
/// final dots and extra spaces.
fn comparable(kind: &str, value: &str) -> String {
    if kind == "TXT" {
        return unwrap_txt(value);
    }
    value
        .split_whitespace()
        .map(|part| part.trim_end_matches('.').to_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

/// FNV-1a: a short, stable hash of a value for the record ids.
fn fnv(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// A record's id: `{name}/{type}/{hash}`, or `*/{type}/{hashes}` when the
/// name would make it longer than the column (255).
fn record_id(name: &str, kind: &str, value: &str) -> String {
    let id = format!("{name}/{kind}/{}", fnv(value));
    if id.len() <= 255 {
        id
    } else {
        format!("*/{kind}/{}{}", fnv(name), fnv(value))
    }
}

/// The parts of a record id: the name (`None` for the long form), the type
/// and the hash.
fn parse_record_id(id: &str) -> Option<(Option<String>, String, String)> {
    let mut parts = id.rsplitn(3, '/');
    let hash = parts.next()?.to_owned();
    let kind = parts.next()?.to_owned();
    let name = parts.next()?;
    if name.is_empty() || kind.is_empty() || hash.is_empty() {
        return None;
    }
    Some(((name != "*").then(|| name.to_owned()), kind, hash))
}

/// Whether an record set record (`name`, `value`) is the one a hash names.
fn is_record(name: &str, value: &str, hash: &str) -> bool {
    hash == fnv(value) || hash == format!("{}{}", fnv(name), fnv(value))
}

/// An record set's records as `(value, comment)`.
fn records_of(rrset: &Value) -> Vec<(String, Value)> {
    rrset
        .get("records")
        .and_then(Value::as_array)
        .map(|records| {
            records
                .iter()
                .map(|r| {
                    (
                        r.get("value").map(as_text).unwrap_or_default(),
                        r.get("comment").cloned().unwrap_or(Value::Null),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A record body: `{ value, comment? }`.
fn record_body(value: &str, comment: &Value) -> Value {
    let mut body = Map::new();
    body.insert("value".to_owned(), json!(value));
    if let Some(comment) = comment.as_str().filter(|c| !c.is_empty()) {
        body.insert("comment".to_owned(), json!(comment));
    }
    Value::Object(body)
}

/// One record set record as the port's [`DnsRecord`].
fn dns_record(rrset: &Value, zone: &str, value: &str, comment: &Value) -> DnsRecord {
    let name = rrset.get("name").map(as_text).unwrap_or_default();
    let kind = rrset.get("type").map(as_text).unwrap_or_default();
    let parts: Vec<&str> = value.split_whitespace().collect();
    let number = |i: usize| {
        parts
            .get(i)
            .and_then(|p| number_of(p))
            .map_or(Value::Null, number_json)
    };
    let host = |text: &str| text.trim_end_matches('.').to_owned();
    let mut priority = Value::Null;
    let mut data = Value::Null;
    let content = match kind.as_str() {
        "TXT" => unwrap_txt(value),
        "MX" => {
            priority = number(0);
            host(parts.get(1).copied().unwrap_or_default())
        }
        "SRV" => {
            let target = host(
                &parts
                    .get(3..)
                    .map(|rest| rest.join(" "))
                    .unwrap_or_default(),
            );
            data = json!({ "priority": number(0), "weight": number(1), "port": number(2), "target": target });
            format!(
                "{} {} {} {target}",
                parts.first().copied().unwrap_or("0"),
                parts.get(1).copied().unwrap_or("0"),
                parts.get(2).copied().unwrap_or("0"),
            )
        }
        "CAA" => {
            let caa = parts
                .get(2..)
                .map(|rest| rest.join(" "))
                .unwrap_or_default();
            let caa = caa.strip_prefix('"').unwrap_or(&caa);
            let caa = caa.strip_suffix('"').unwrap_or(caa);
            data = json!({ "flags": number(0), "tag": parts.get(1).copied().unwrap_or_default(), "value": caa });
            value.to_owned()
        }
        "CNAME" | "NS" | "PTR" => host(value),
        _ => value.to_owned(),
    };
    DnsRecord {
        id: record_id(&name, &kind, value),
        editable_type: EDITABLE.contains(&kind.as_str()).then(|| kind.clone()),
        name: full_name(&name, zone),
        content,
        ttl: match rrset.get("ttl") {
            Some(ttl @ Value::Number(_)) => ttl.clone(),
            _ => json!(1),
        },
        priority,
        comment: comment.clone(),
        data,
    }
}

/// Whether a delegation is to WeldHost: some nameservers, every one of them
/// a name customers may use (the branded ones or Hetzner's).
fn delegated_to(delegated: &[String], accepted: &BTreeSet<String>) -> bool {
    !delegated.is_empty() && delegated.iter().all(|ns| accepted.contains(&bare(ns)))
}

fn names(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().map(|v| bare(&as_text(v))).collect())
        .unwrap_or_default()
}

// ── The client ──────────────────────────────────────────────────────────────

/// Hetzner's Cloud DNS as the DNS host, for one workspace.
pub(crate) struct HetznerDns {
    http: OutboundHttp,
    token: String,
    /// The branded nameservers, lower case without the final dot; empty:
    /// Hetzner's own are the ones customers use.
    nameservers: Vec<String>,
    /// The caller's workspace (`workspaces.id`): the only one whose zones
    /// this client touches. `None` touches none.
    workspace: Option<String>,
    /// The zones already checked to be the workspace's, by the id they were
    /// asked for, with their names: one check a request.
    owned: Mutex<HashMap<String, String>>,
}

impl HetznerDns {
    pub(crate) fn new(
        http: OutboundHttp,
        token: &str,
        nameservers: &[String],
        workspace: Option<&str>,
    ) -> Self {
        Self {
            http,
            token: token.to_owned(),
            nameservers: nameservers.iter().map(|ns| bare(ns)).collect(),
            workspace: workspace.filter(|w| !w.is_empty()).map(str::to_owned),
            owned: Mutex::new(HashMap::new()),
        }
    }

    /// `Ok` when a zone (the API's zone object) carries the caller's
    /// workspace label.
    fn check_owner(&self, zone: &Value) -> Result<(), ZoneError> {
        let label = zone["labels"][WORKSPACE_LABEL].as_str();
        match (self.workspace.as_deref(), label) {
            (Some(workspace), Some(label)) if workspace == label => Ok(()),
            _ => {
                tracing::warn!(
                    zone = zone["name"].as_str().unwrap_or_default(),
                    "[hetzner-dns] refused a zone of another workspace"
                );
                Err(ZoneError {
                    kind: ZoneErrorKind::Unknown,
                    message: "This DNS zone belongs to another workspace.".to_owned(),
                    codes: Vec::new(),
                    status: Some(403),
                })
            }
        }
    }

    fn remember(&self, zone_id: &str, name: &str) {
        if let Ok(mut owned) = self.owned.lock() {
            owned.insert(zone_id.to_owned(), name.to_owned());
        }
    }

    /// The name of a zone the caller's workspace owns, by its id or name:
    /// read once a request and checked against the workspace label.
    async fn owned_zone(&self, zone_id: &str) -> Result<String, ZoneError> {
        if let Some(name) = self
            .owned
            .lock()
            .ok()
            .and_then(|owned| owned.get(zone_id).cloned())
        {
            return Ok(name);
        }
        let path = format!("/zones/{}", encode_uri_path(zone_id));
        let body = match self.call("GET", &path, None, 2).await {
            Ok(body) => body,
            Err(error) if error.not_found() => {
                return Err(ZoneError {
                    kind: ZoneErrorKind::Unknown,
                    message: "This DNS zone no longer exists at Hetzner.".to_owned(),
                    codes: Vec::new(),
                    status: Some(404),
                });
            }
            Err(error) => return Err(to_zone_error(&error)),
        };
        self.check_owner(&body["zone"])?;
        let name = bare(body["zone"]["name"].as_str().unwrap_or(zone_id));
        self.remember(zone_id, &name);
        Ok(name)
    }

    /// One call; `retries` more after a connection failure, a rate limit or
    /// a gateway error.
    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        retries: u32,
    ) -> Result<Value, ApiError> {
        let mut attempt = 0;
        loop {
            let mut request = HttpRequest::empty(method, format!("{API}{path}"))
                .header("authorization", format!("Bearer {}", self.token))
                .header("accept", "application/json");
            if let Some(body) = body {
                request = request.header("content-type", "application/json");
                request.body = Some(body.to_string().into_bytes());
            }
            let result = match self.http.send(request).await {
                Ok(response) => answer(&response),
                Err(error) => Err(ApiError {
                    status: None,
                    code: "connection_error".to_owned(),
                    message: error.to_string(),
                }),
            };
            match result {
                Err(error) if attempt < retries && retryable(&error) => {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(1000 * u64::from(attempt))).await;
                }
                other => return other,
            }
        }
    }

    /// Wait for the action a write answered with: `Err` when it failed, `Ok`
    /// when it succeeded or is still running after the last look.
    async fn settle(&self, body: &Value) -> Result<(), ApiError> {
        let Some(mut action) = body.get("action").cloned() else {
            return Ok(());
        };
        for wait in ACTION_WAITS_MS {
            match action.get("status").and_then(Value::as_str) {
                Some("success") | None => return Ok(()),
                Some("error") => {
                    let error = action.get("error").cloned().unwrap_or(Value::Null);
                    return Err(ApiError {
                        status: Some(422),
                        code: error
                            .get("code")
                            .map_or_else(|| "action_failed".to_owned(), as_text),
                        message: error
                            .get("message")
                            .map_or_else(|| "The DNS change failed".to_owned(), as_text),
                    });
                }
                Some(_) => {}
            }
            let Some(id) = action.get("id").filter(|id| !id.is_null()).map(as_text) else {
                return Ok(());
            };
            tokio::time::sleep(Duration::from_millis(wait)).await;
            match self
                .call(
                    "GET",
                    &format!("/zones/actions/{}", encode_uri_path(&id)),
                    None,
                    2,
                )
                .await
            {
                Ok(next) => action = next.get("action").cloned().unwrap_or(Value::Null),
                Err(error) => {
                    tracing::warn!(%error, action = id, "[hetzner-dns] could not read the action");
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    /// A write and its action.
    async fn write(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        retries: u32,
    ) -> Result<(), ApiError> {
        let answer = self.call(method, path, body, retries).await?;
        self.settle(&answer).await
    }

    fn rrset_path(zone: &str, name: &str, kind: &str) -> String {
        format!(
            "/zones/{}/rrsets/{}/{}",
            encode_uri_path(zone),
            encode_uri_path(name),
            encode_uri_path(kind)
        )
    }

    /// One record set, `None` when there is none.
    async fn rrset(&self, zone: &str, name: &str, kind: &str) -> Result<Option<Value>, ApiError> {
        match self
            .call("GET", &Self::rrset_path(zone, name, kind), None, 2)
            .await
        {
            Ok(body) => Ok(body.get("rrset").cloned().filter(|r| !r.is_null())),
            Err(error) if error.not_found() => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Every record set of the zone (of one type when given), every page.
    async fn rrsets(&self, zone: &str, kind: Option<&str>) -> Result<Vec<Value>, ApiError> {
        let mut out = Vec::new();
        let mut page: u32 = 1;
        while page <= MAX_PAGES {
            let mut query = format!("per_page=50&page={page}");
            if let Some(kind) = kind {
                query.push_str("&type=");
                query.push_str(kind);
            }
            let body = self
                .call(
                    "GET",
                    &format!("/zones/{}/rrsets?{query}", encode_uri_path(zone)),
                    None,
                    2,
                )
                .await?;
            out.extend(
                body.get("rrsets")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            );
            match body["meta"]["pagination"]["next_page"].as_u64() {
                Some(next) if next > u64::from(page) => {
                    page = u32::try_from(next).unwrap_or(MAX_PAGES + 1);
                }
                _ => break,
            }
        }
        Ok(out)
    }

    /// The record set and value a record id names, `None` when it's gone.
    async fn find(
        &self,
        zone: &str,
        record_id: &str,
    ) -> Result<Option<(Value, String)>, ZoneError> {
        let Some((name, kind, hash)) = parse_record_id(record_id) else {
            return Ok(None);
        };
        let sets = match name {
            Some(name) => self
                .rrset(zone, &name, &kind)
                .await
                .map_err(|e| to_zone_error(&e))?
                .into_iter()
                .collect(),
            None => self
                .rrsets(zone, Some(&kind))
                .await
                .map_err(|e| to_zone_error(&e))?,
        };
        for rrset in sets {
            let name = rrset.get("name").map(as_text).unwrap_or_default();
            if let Some((value, _)) = records_of(&rrset)
                .into_iter()
                .find(|(value, _)| is_record(&name, value, &hash))
            {
                return Ok(Some((rrset, value)));
            }
        }
        Ok(None)
    }

    /// The nameservers customers are told to use: the branded ones, else
    /// the zone's assigned Hetzner ones.
    fn public_nameservers(&self, assigned: &[String]) -> Vec<String> {
        if self.nameservers.is_empty() {
            assigned.to_vec()
        } else {
            self.nameservers.clone()
        }
    }

    /// Whether a zone is delegated to WeldHost: Hetzner's last delegation
    /// check, else a lookup now (Hetzner checks only now and then).
    async fn is_delegated(&self, name: &str, delegated: &[String], assigned: &[String]) -> bool {
        let accepted: BTreeSet<String> = self.nameservers.iter().chain(assigned).cloned().collect();
        if delegated_to(delegated, &accepted) {
            return true;
        }
        match crate::doh::lookup_record(&self.http, name, "NS").await {
            Ok(records) => {
                let found: Vec<String> = records
                    .iter()
                    .map(|r| r["value"].as_str().unwrap_or_default().to_owned())
                    .collect();
                delegated_to(&found, &accepted)
            }
            Err(error) => {
                tracing::warn!(%error, zone = name, "[hetzner-dns] NS lookup failed");
                false
            }
        }
    }
}

/// A response as the API's body, or its error.
fn answer(response: &HttpResponse) -> Result<Value, ApiError> {
    let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    if response.ok() {
        return Ok(body);
    }
    let error = body.get("error").cloned().unwrap_or(Value::Null);
    Err(ApiError {
        status: Some(response.status),
        code: error
            .get("code")
            .map_or_else(|| format!("http_{}", response.status), as_text),
        message: error
            .get("message")
            .map(as_text)
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| format!("{} status code", response.status)),
    })
}

impl DnsHost for HetznerDns {
    fn create_zone<'a>(
        &'a self,
        _account: &'a str,
        domain: &'a str,
    ) -> BoxFuture<'a, Result<Zone, ZoneError>> {
        Box::pin(async move {
            let name = bare(domain);
            let Some(workspace) = self.workspace.as_deref() else {
                return Err(unknown("A DNS zone needs the workspace it belongs to."));
            };
            let body = json!({
                "name": name,
                "mode": "primary",
                "labels": { "managed-by": "weldhost", WORKSPACE_LABEL: workspace },
            });
            // Not idempotent: one attempt.
            let created = self
                .call("POST", "/zones", Some(&body), 0)
                .await
                .map_err(|e| to_zone_error(&e))?;
            if let Err(error) = self.settle(&created).await {
                tracing::error!(%error, zone = name, "[hetzner-dns] zone creation failed");
                self.delete_zone(&name).await;
                return Err(to_zone_error(&error));
            }
            let assigned = names(created["zone"]["authoritative_nameservers"].get("assigned"));
            if !self.nameservers.is_empty() {
                let records: Vec<Value> = self
                    .nameservers
                    .iter()
                    .map(|ns| json!({ "value": format!("{ns}.") }))
                    .collect();
                let added = self
                    .write(
                        "POST",
                        &format!("{}/actions/add_records", Self::rrset_path(&name, "@", "NS")),
                        Some(&json!({ "records": records })),
                        0,
                    )
                    .await;
                if let Err(error) = added {
                    tracing::error!(%error, zone = name, "[hetzner-dns] the branded NS records failed, rolling the zone back");
                    self.delete_zone(&name).await;
                    return Err(to_zone_error(&error));
                }
            }
            self.remember(&name, &name);
            Ok(Zone {
                id: name,
                nameservers: self.public_nameservers(&assigned),
                status: "pending".to_owned(),
            })
        })
    }

    fn get_zone<'a>(&'a self, zone_id: &'a str) -> BoxFuture<'a, Result<Option<Zone>, ZoneError>> {
        Box::pin(async move {
            let path = format!("/zones/{}", encode_uri_path(zone_id));
            let body = match self.call("GET", &path, None, 2).await {
                Ok(body) => body,
                Err(error) if error.not_found() => return Ok(None),
                Err(error) => return Err(to_zone_error(&error)),
            };
            let zone = &body["zone"];
            self.check_owner(zone)?;
            let name = bare(zone["name"].as_str().unwrap_or(zone_id));
            self.remember(zone_id, &name);
            let servers = &zone["authoritative_nameservers"];
            let assigned = names(servers.get("assigned"));
            let delegated = names(servers.get("delegated"));
            // Cloudflare's words, which the routes map: `active` once the
            // registry points at WeldHost, `pending` before.
            let status = if zone["status"].as_str() == Some("error") {
                "error"
            } else if self.is_delegated(&name, &delegated, &assigned).await {
                "active"
            } else {
                "pending"
            };
            Ok(Some(Zone {
                id: name,
                nameservers: self.public_nameservers(&assigned),
                status: status.to_owned(),
            }))
        })
    }

    fn delete_zone<'a>(&'a self, zone_id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let path = format!("/zones/{}", encode_uri_path(zone_id));
            if let Err(error) = self.call("DELETE", &path, None, 2).await
                && !error.not_found()
            {
                tracing::error!(zone_id, %error, "[hetzner-dns] Rollback delete failed for zone");
            }
        })
    }

    fn list_records<'a>(
        &'a self,
        zone_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<DnsRecord>, ZoneError>> {
        Box::pin(async move {
            let zone = self.owned_zone(zone_id).await?;
            let sets = self
                .rrsets(&zone, None)
                .await
                .map_err(|e| to_zone_error(&e))?;
            let mut out = Vec::new();
            for rrset in &sets {
                let name = rrset.get("name").map(as_text).unwrap_or_default();
                let kind = rrset.get("type").map(as_text).unwrap_or_default();
                // The platform's: the SOA and the apex NS set.
                if kind == "SOA" || (kind == "NS" && name == "@") {
                    continue;
                }
                for (value, comment) in records_of(rrset) {
                    out.push(dns_record(rrset, &zone, &value, &comment));
                }
            }
            Ok(out)
        })
    }

    fn create_record<'a>(
        &'a self,
        zone_id: &'a str,
        record: &'a RecordInput,
    ) -> BoxFuture<'a, Result<Created, ZoneError>> {
        Box::pin(async move {
            let zone = self.owned_zone(zone_id).await?;
            let name = relative_name(&record.name, &zone);
            let value = hetzner_value(record, &zone);
            let existing = self
                .rrset(&zone, &name, &record.kind)
                .await
                .map_err(|e| to_zone_error(&e))?;
            let wanted = comparable(&record.kind, &value);
            if existing.as_ref().is_some_and(|rrset| {
                records_of(rrset)
                    .iter()
                    .any(|(v, _)| comparable(&record.kind, v) == wanted)
            }) {
                return Ok(Created::Duplicate);
            }
            let comment = record.comment.clone().map_or(Value::Null, Value::String);
            let body = json!({
                "ttl": hetzner_ttl(record.ttl),
                "records": [record_body(&value, &comment)],
            });
            self.write(
                "POST",
                &format!(
                    "{}/actions/add_records",
                    Self::rrset_path(&zone, &name, &record.kind)
                ),
                Some(&body),
                0,
            )
            .await
            .map_err(|e| to_zone_error(&e))?;
            Ok(Created::Created)
        })
    }

    fn update_record<'a>(
        &'a self,
        zone_id: &'a str,
        record_id: &'a str,
        record: &'a RecordInput,
    ) -> BoxFuture<'a, Result<(), ZoneError>> {
        Box::pin(async move {
            let zone = self.owned_zone(zone_id).await?;
            let Some((rrset, old)) = self.find(&zone, record_id).await? else {
                return Err(unknown(
                    "DNS record not found at Hetzner. Sync the zone and try again.",
                ));
            };
            let old_name = rrset.get("name").map(as_text).unwrap_or_default();
            let old_kind = rrset.get("type").map(as_text).unwrap_or_default();
            let name = relative_name(&record.name, &zone);
            let value = hetzner_value(record, &zone);
            let ttl = hetzner_ttl(record.ttl);
            let comment = record.comment.clone().map_or(Value::Null, Value::String);
            if name == old_name && record.kind == old_kind {
                // The same set: its records with this one replaced.
                let wanted = comparable(&old_kind, &value);
                let mut records = vec![record_body(&value, &comment)];
                for (v, c) in records_of(&rrset) {
                    if v != old && comparable(&old_kind, &v) != wanted {
                        records.push(record_body(&v, &c));
                    }
                }
                let path = Self::rrset_path(&zone, &name, &old_kind);
                self.write(
                    "POST",
                    &format!("{path}/actions/set_records"),
                    Some(&json!({ "records": records })),
                    2,
                )
                .await
                .map_err(|e| to_zone_error(&e))?;
                if rrset.get("ttl").unwrap_or(&Value::Null) != &ttl {
                    self.write(
                        "POST",
                        &format!("{path}/actions/change_ttl"),
                        Some(&json!({ "ttl": ttl })),
                        2,
                    )
                    .await
                    .map_err(|e| to_zone_error(&e))?;
                }
                return Ok(());
            }
            // Another set: add the new record first, so a refusal keeps the old.
            self.write(
                "POST",
                &format!(
                    "{}/actions/add_records",
                    Self::rrset_path(&zone, &name, &record.kind)
                ),
                Some(&json!({ "ttl": ttl, "records": [record_body(&value, &comment)] })),
                0,
            )
            .await
            .map_err(|e| to_zone_error(&e))?;
            self.write(
                "POST",
                &format!(
                    "{}/actions/remove_records",
                    Self::rrset_path(&zone, &old_name, &old_kind)
                ),
                Some(&json!({ "records": [{ "value": old }] })),
                2,
            )
            .await
            .map_err(|e| to_zone_error(&e))
        })
    }

    fn delete_record<'a>(
        &'a self,
        zone_id: &'a str,
        record_id: &'a str,
    ) -> BoxFuture<'a, Result<(), ZoneError>> {
        Box::pin(async move {
            let zone = self.owned_zone(zone_id).await?;
            let Some((rrset, value)) = self.find(&zone, record_id).await? else {
                return Ok(());
            };
            let name = rrset.get("name").map(as_text).unwrap_or_default();
            let kind = rrset.get("type").map(as_text).unwrap_or_default();
            match self
                .write(
                    "POST",
                    &format!(
                        "{}/actions/remove_records",
                        Self::rrset_path(&zone, &name, &kind)
                    ),
                    Some(&json!({ "records": [{ "value": value }] })),
                    2,
                )
                .await
            {
                Err(error) if !error.not_found() => Err(to_zone_error(&error)),
                _ => Ok(()),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use weldsuite_ports::{DynOutboundHttp, PortError};

    use super::*;

    type Route = (&'static str, &'static str, u16, Value);

    /// Answers each request with the first route whose method and path match
    /// (a path ending in `$` exactly, without the query; any other as a
    /// prefix), and keeps every request.
    struct Stub {
        routes: Vec<Route>,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl DynOutboundHttp for Stub {
        fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
            self.seen.lock().expect("lock").push(request.clone());
            let path = request
                .url
                .strip_prefix(API)
                .unwrap_or(&request.url)
                .to_owned();
            let bare_path = path.split('?').next().unwrap_or_default();
            let found = self
                .routes
                .iter()
                .find(|(method, route, _, _)| {
                    *method == request.method
                        && route
                            .strip_suffix('$')
                            .map_or_else(|| path.starts_with(route), |exact| bare_path == exact)
                })
                .map(|(_, _, status, body)| {
                    HttpResponse::new(*status, body.to_string().into_bytes())
                });
            Box::pin(std::future::ready(Ok(found.unwrap_or_else(|| {
                HttpResponse::new(
                    404,
                    json!({ "error": { "code": "not_found", "message": "not found" } })
                        .to_string()
                        .into_bytes(),
                )
            }))))
        }
    }

    const WORKSPACE: &str = "ws_a";

    fn done() -> Value {
        json!({ "action": { "id": 1, "status": "success" } })
    }

    /// `GET /zones/example.com`: the zone, labelled with `owner` (none for
    /// `None`), delegated to `delegated`.
    fn zone_of(owner: Option<&str>, delegated: &Value) -> Value {
        let labels = owner.map_or_else(|| json!({}), |o| json!({ WORKSPACE_LABEL: o }));
        json!({ "zone": { "id": 7, "name": "example.com", "status": "ok", "labels": labels,
            "authoritative_nameservers": { "assigned": ["hydrogen.ns.hetzner.com."], "delegated": delegated } } })
    }

    /// The caller's own zone.
    fn own_zone() -> Route {
        (
            "GET",
            "/zones/example.com$",
            200,
            zone_of(Some(WORKSPACE), &json!([])),
        )
    }

    fn dns_as(
        routes: Vec<Route>,
        nameservers: &[&str],
        workspace: Option<&str>,
    ) -> (HetznerDns, Arc<Stub>) {
        let stub = Arc::new(Stub {
            routes,
            seen: Mutex::new(Vec::new()),
        });
        let nameservers: Vec<String> = nameservers.iter().map(|s| (*s).to_owned()).collect();
        let http = OutboundHttp(Arc::clone(&stub) as Arc<dyn DynOutboundHttp>);
        (
            HetznerDns::new(http, "token", &nameservers, workspace),
            stub,
        )
    }

    fn dns(routes: Vec<Route>, nameservers: &[&str]) -> (HetznerDns, Arc<Stub>) {
        dns_as(routes, nameservers, Some(WORKSPACE))
    }

    fn input(kind: &str, name: &str, content: &str) -> RecordInput {
        RecordInput {
            kind: kind.to_owned(),
            name: name.to_owned(),
            content: content.to_owned(),
            ttl: None,
            priority: None,
            comment: None,
        }
    }

    fn sent(stub: &Stub) -> Vec<(String, String, Value)> {
        stub.seen
            .lock()
            .expect("lock")
            .iter()
            .map(|r| {
                (
                    r.method.clone(),
                    r.url.strip_prefix(API).unwrap_or(&r.url).to_owned(),
                    r.body
                        .as_ref()
                        .and_then(|b| serde_json::from_slice(b).ok())
                        .unwrap_or(Value::Null),
                )
            })
            .collect()
    }

    #[test]
    fn names_relative_and_full() {
        assert_eq!(relative_name("example.com", "example.com"), "@");
        assert_eq!(relative_name("@", "example.com"), "@");
        assert_eq!(relative_name("WWW.Example.com.", "example.com"), "www");
        assert_eq!(relative_name("_dmarc", "example.com"), "_dmarc");
        assert_eq!(full_name("@", "example.com"), "example.com");
        assert_eq!(full_name("mail", "example.com"), "mail.example.com");
    }

    #[test]
    fn values_in_zone_file_form() {
        let zone = "example.com";
        assert_eq!(
            hetzner_value(&input("CNAME", "www", "Target.example.net"), zone),
            "target.example.net."
        );
        assert_eq!(
            hetzner_value(&input("NS", "sub", "@"), zone),
            "example.com."
        );
        let mut mx = input("MX", "@", "mail.example.com");
        mx.priority = Some(10.0);
        assert_eq!(hetzner_value(&mx, zone), "10 mail.example.com.");
        assert_eq!(
            hetzner_value(&input("MX", "@", "20 mx2.example.com"), zone),
            "20 mx2.example.com."
        );
        let mut srv = input("SRV", "_sip._tcp", "0 5 5060 sip.example.com.");
        srv.priority = Some(10.0);
        assert_eq!(hetzner_value(&srv, zone), "10 5 5060 sip.example.com.");
        assert_eq!(
            hetzner_value(
                &input("SRV", "_sip._tcp", "10 5 5060 sip.example.com"),
                zone
            ),
            "10 5 5060 sip.example.com."
        );
        assert_eq!(
            hetzner_value(&input("CAA", "@", "0 issue \"letsencrypt.org\""), zone),
            "0 issue \"letsencrypt.org\""
        );
        assert_eq!(
            hetzner_value(&input("CAA", "@", "128 iodef mailto:dns@example.com"), zone),
            "128 iodef \"mailto:dns@example.com\""
        );
        assert_eq!(
            hetzner_value(&input("TXT", "@", "v=spf1 -all"), zone),
            "\"v=spf1 -all\""
        );
        assert_eq!(
            hetzner_value(&input("TXT", "@", "\"already\" \"quoted\""), zone),
            "\"already\" \"quoted\""
        );
        assert_eq!(
            hetzner_value(&input("A", "@", " 192.0.2.1 "), zone),
            "192.0.2.1"
        );
        assert_eq!(hetzner_ttl(None), json!(3600));
        assert_eq!(hetzner_ttl(Some(1.0)), Value::Null);
        assert_eq!(hetzner_ttl(Some(30.0)), json!(60));
        assert_eq!(hetzner_ttl(Some(7200.0)), json!(7200));
    }

    #[test]
    fn long_txt_is_split_in_255_byte_strings() {
        let key = "k".repeat(600);
        let quoted = quote_txt(&key);
        assert_eq!(quoted.matches('"').count(), 6);
        assert_eq!(unwrap_txt(&quoted), key);
        assert_eq!(quote_txt("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(unwrap_txt(&quote_txt("say \"hi\"")), "say \"hi\"");
        assert_eq!(quote_txt(""), "\"\"");
    }

    #[test]
    fn duplicates_compare_without_case_dots_or_quotes() {
        assert_eq!(
            comparable("MX", "10  Mail.Example.com."),
            comparable("MX", "10 mail.example.com")
        );
        assert_eq!(
            comparable("TXT", "\"v=spf1 \" \"-all\""),
            comparable("TXT", "\"v=spf1 -all\"")
        );
    }

    #[test]
    fn record_ids_round_trip() {
        let id = record_id("www", "A", "192.0.2.1");
        let (name, kind, hash) = parse_record_id(&id).expect("parses");
        assert_eq!(name.as_deref(), Some("www"));
        assert_eq!(kind, "A");
        assert!(is_record("www", "192.0.2.1", &hash));
        assert!(!is_record("www", "192.0.2.2", &hash));
        let long = "a".repeat(250);
        let id = record_id(&long, "TXT", "\"x\"");
        assert!(id.len() <= 255 && id.starts_with("*/TXT/"));
        let (name, _, hash) = parse_record_id(&id).expect("parses");
        assert!(name.is_none());
        assert!(is_record(&long, "\"x\"", &hash));
        assert!(parse_record_id("not-an-id").is_none());
        assert!(parse_record_id("/A/abc").is_none());
    }

    #[test]
    fn delegation_needs_only_weldhost_nameservers() {
        let accepted: BTreeSet<String> = ["ns1.weldhost.com", "hydrogen.ns.hetzner.com"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        assert!(delegated_to(&["NS1.weldhost.com.".to_owned()], &accepted));
        assert!(!delegated_to(&[], &accepted));
        assert!(!delegated_to(
            &["ns1.weldhost.com".to_owned(), "ns1.other.net".to_owned()],
            &accepted
        ));
    }

    #[test]
    fn errors_map_to_the_routes_kinds() {
        let error = |status: Option<u16>, code: &str| ApiError {
            status,
            code: code.to_owned(),
            message: "boom".to_owned(),
        };
        assert_eq!(
            to_zone_error(&error(Some(401), "unauthorized")).kind,
            ZoneErrorKind::AuthFailed
        );
        assert_eq!(
            to_zone_error(&error(Some(403), "token_readonly")).kind,
            ZoneErrorKind::AuthFailed
        );
        assert_eq!(
            to_zone_error(&error(Some(409), "uniqueness_error")).kind,
            ZoneErrorKind::InAnotherAccount
        );
        let invalid = to_zone_error(&error(Some(400), "invalid_input"));
        assert_eq!(
            (invalid.kind, invalid.message.as_str()),
            (ZoneErrorKind::InvalidDomain, "boom")
        );
        let other = to_zone_error(&error(None, "connection_error"));
        assert_eq!(other.kind, ZoneErrorKind::Unknown);
        assert_eq!(other.message, "Hetzner API error (no status): boom");
        assert!(retryable(&error(None, "connection_error")));
        assert!(retryable(&error(Some(429), "rate_limit_exceeded")));
        assert!(!retryable(&error(Some(422), "invalid_input")));
        assert_eq!(error(Some(404), "x").to_string(), "boom (x)");
        let unparsable = answer(&HttpResponse::new(502, b"<html>".to_vec())).expect_err("fails");
        assert_eq!(
            (unparsable.code.as_str(), unparsable.message.as_str()),
            ("http_502", "502 status code")
        );
    }

    #[tokio::test]
    async fn lists_records_as_cloudflare_shapes_them() {
        let (dns, _) = dns(
            vec![
                own_zone(),
                (
                    "GET",
                    "/zones/example.com/rrsets",
                    200,
                    json!({
                        "rrsets": [
                            { "id": "@/SOA", "name": "@", "type": "SOA", "ttl": null, "records": [{ "value": "hydrogen.ns.hetzner.com. dns.hetzner.com. 1 2 3 4 5" }] },
                            { "id": "@/NS", "name": "@", "type": "NS", "ttl": null, "records": [{ "value": "hydrogen.ns.hetzner.com." }] },
                            { "id": "@/MX", "name": "@", "type": "MX", "ttl": 3600, "records": [{ "value": "10 mail.example.com.", "comment": "primary" }] },
                            { "id": "@/TXT", "name": "@", "type": "TXT", "ttl": null, "records": [{ "value": "\"v=spf1 \" \"-all\"" }] },
                            { "id": "_sip._tcp/SRV", "name": "_sip._tcp", "type": "SRV", "ttl": 300, "records": [{ "value": "10 5 5060 sip.example.com." }] },
                            { "id": "www/CNAME", "name": "www", "type": "CNAME", "ttl": 300, "records": [{ "value": "example.com." }] },
                            { "id": "@/CAA", "name": "@", "type": "CAA", "ttl": 300, "records": [{ "value": "0 issue \"letsencrypt.org\"" }] },
                            { "id": "@/HTTPS", "name": "@", "type": "HTTPS", "ttl": 300, "records": [{ "value": "1 . alpn=h2" }] },
                        ],
                        "meta": { "pagination": { "page": 1, "per_page": 50, "next_page": null } },
                    }),
                ),
            ],
            &[],
        );
        let records = dns.list_records("example.com").await.expect("lists");
        assert_eq!(records.len(), 6);
        let mx = &records[0];
        assert_eq!(
            (mx.name.as_str(), mx.content.as_str()),
            ("example.com", "mail.example.com")
        );
        assert_eq!(
            (mx.priority.clone(), mx.comment.clone()),
            (json!(10), json!("primary"))
        );
        assert_eq!(records[1].content, "v=spf1 -all");
        assert_eq!(records[1].ttl, json!(1));
        assert_eq!(records[2].content, "10 5 5060 sip.example.com");
        assert_eq!(records[2].data["port"], json!(5060));
        assert_eq!(records[3].name, "www.example.com");
        assert_eq!(records[3].content, "example.com");
        assert_eq!(records[4].data["tag"], json!("issue"));
        assert_eq!(records[4].data["value"], json!("letsencrypt.org"));
        assert_eq!(records[5].editable_type, None);
    }

    #[tokio::test]
    async fn reads_every_page() {
        let page = |sets: Value, next: Value| json!({ "rrsets": sets, "meta": { "pagination": { "page": 1, "per_page": 50, "next_page": next } } });
        let (dns, stub) = dns(
            vec![
                own_zone(),
                (
                    "GET",
                    "/zones/example.com/rrsets?per_page=50&page=2",
                    200,
                    page(
                        json!([{ "name": "b", "type": "A", "ttl": 60, "records": [{ "value": "192.0.2.2" }] }]),
                        Value::Null,
                    ),
                ),
                (
                    "GET",
                    "/zones/example.com/rrsets?per_page=50&page=1",
                    200,
                    page(
                        json!([{ "name": "a", "type": "A", "ttl": 60, "records": [{ "value": "192.0.2.1" }] }]),
                        json!(2),
                    ),
                ),
            ],
            &[],
        );
        let records = dns.list_records("example.com").await.expect("lists");
        let names: Vec<&str> = records.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["a.example.com", "b.example.com"]);
        assert_eq!(sent(&stub).len(), 3);
    }

    #[tokio::test]
    async fn creates_a_zone_with_the_branded_nameservers() {
        let (dns, stub) = dns(
            vec![
                (
                    "POST",
                    "/zones/example.com/rrsets/@/NS/actions/add_records",
                    201,
                    done(),
                ),
                (
                    "POST",
                    "/zones",
                    201,
                    json!({
                        "zone": { "id": 7, "name": "example.com", "status": "updating",
                            "authoritative_nameservers": { "assigned": ["hydrogen.ns.hetzner.com.", "oxygen.ns.hetzner.com.", "helium.ns.hetzner.de."], "delegated": [] } },
                        "action": { "id": 2, "status": "success" },
                    }),
                ),
            ],
            &["ns1.weldhost.com", "ns2.weldhost.com", "ns3.weldhost.com"],
        );
        let zone = dns.create_zone("", "Example.com").await.expect("created");
        assert_eq!(zone.id, "example.com");
        assert_eq!(
            zone.nameservers,
            ["ns1.weldhost.com", "ns2.weldhost.com", "ns3.weldhost.com"]
        );
        let calls = sent(&stub);
        assert_eq!(calls[0].2["name"], json!("example.com"));
        assert_eq!(calls[0].2["labels"][WORKSPACE_LABEL], json!(WORKSPACE));
        assert_eq!(
            calls[1].2,
            json!({ "records": [{ "value": "ns1.weldhost.com." }, { "value": "ns2.weldhost.com." }, { "value": "ns3.weldhost.com." }] })
        );
    }

    #[tokio::test]
    async fn a_zone_whose_branded_nameservers_fail_is_rolled_back() {
        let (dns, stub) = dns(
            vec![
                (
                    "POST",
                    "/zones/example.com/rrsets/@/NS/actions/add_records",
                    422,
                    json!({ "error": { "code": "invalid_input", "message": "bad NS" } }),
                ),
                (
                    "POST",
                    "/zones",
                    201,
                    json!({ "zone": { "id": 7, "name": "example.com" }, "action": { "id": 2, "status": "success" } }),
                ),
                ("DELETE", "/zones/example.com$", 201, done()),
            ],
            &["ns1.weldhost.com"],
        );
        let error = dns.create_zone("", "example.com").await.expect_err("fails");
        assert_eq!(error.message, "bad NS");
        let calls = sent(&stub);
        assert_eq!(calls.last().map(|c| c.0.as_str()), Some("DELETE"));
    }

    #[tokio::test]
    async fn without_branded_nameservers_hetzners_are_given() {
        let (dns, _) = dns(
            vec![(
                "POST",
                "/zones",
                201,
                json!({
                    "zone": { "id": 7, "name": "example.com",
                        "authoritative_nameservers": { "assigned": ["hydrogen.ns.hetzner.com.", "helium.ns.hetzner.de."] } },
                    "action": { "id": 2, "status": "success" },
                }),
            )],
            &[],
        );
        let zone = dns.create_zone("", "example.com").await.expect("created");
        assert_eq!(
            zone.nameservers,
            ["hydrogen.ns.hetzner.com", "helium.ns.hetzner.de"]
        );
    }

    #[tokio::test]
    async fn no_zone_is_made_without_a_workspace() {
        let (dns, stub) = dns_as(vec![], &[], None);
        assert!(dns.create_zone("", "example.com").await.is_err());
        assert_eq!(sent(&stub), Vec::new());
    }

    #[tokio::test]
    async fn a_taken_zone_is_in_another_account() {
        let (dns, _) = dns(
            vec![(
                "POST",
                "/zones",
                409,
                json!({ "error": { "code": "uniqueness_error", "message": "zone already exists" } }),
            )],
            &[],
        );
        let error = dns
            .create_zone("", "example.com")
            .await
            .expect_err("refused");
        assert_eq!(error.kind, ZoneErrorKind::InAnotherAccount);
    }

    #[tokio::test]
    async fn a_zone_is_active_once_delegated_to_the_branded_names() {
        let (active, _) = dns(
            vec![(
                "GET",
                "/zones/example.com$",
                200,
                zone_of(
                    Some(WORKSPACE),
                    &json!(["ns1.weldhost.com.", "ns2.weldhost.com."]),
                ),
            )],
            &["ns1.weldhost.com", "ns2.weldhost.com"],
        );
        let found = active
            .get_zone("example.com")
            .await
            .expect("read")
            .expect("exists");
        assert_eq!(found.status, "active");
        assert_eq!(found.nameservers, ["ns1.weldhost.com", "ns2.weldhost.com"]);
        // Delegated elsewhere, and the NS lookup (no answer here) agrees.
        let (pending, _) = dns(
            vec![(
                "GET",
                "/zones/example.com$",
                200,
                zone_of(Some(WORKSPACE), &json!(["ns1.registrar.example."])),
            )],
            &["ns1.weldhost.com"],
        );
        let found = pending
            .get_zone("example.com")
            .await
            .expect("read")
            .expect("exists");
        assert_eq!(found.status, "pending");
        let (gone, _) = dns(vec![], &[]);
        assert!(gone.get_zone("example.com").await.expect("read").is_none());
    }

    #[tokio::test]
    async fn a_zone_of_another_workspace_is_refused() {
        for owner in [Some("ws_b"), None] {
            let (dns, stub) = dns(
                vec![
                    (
                        "GET",
                        "/zones/example.com$",
                        200,
                        zone_of(owner, &json!([])),
                    ),
                    (
                        "POST",
                        "/zones/example.com/rrsets/www/A/actions/add_records",
                        201,
                        done(),
                    ),
                ],
                &[],
            );
            let error = dns.list_records("example.com").await.expect_err("refused");
            assert_eq!(error.message, "This DNS zone belongs to another workspace.");
            assert!(
                dns.create_record("example.com", &input("A", "www", "192.0.2.1"))
                    .await
                    .is_err()
            );
            assert!(dns.get_zone("example.com").await.is_err());
            // Only the zone reads went out: nothing was listed or written.
            assert!(
                sent(&stub)
                    .iter()
                    .all(|(method, path, _)| method == "GET" && path == "/zones/example.com")
            );
        }
    }

    #[tokio::test]
    async fn the_owner_is_checked_once_a_request() {
        let (dns, stub) = dns(
            vec![
                own_zone(),
                (
                    "POST",
                    "/zones/example.com/rrsets/www/A/actions/add_records",
                    201,
                    done(),
                ),
                (
                    "GET",
                    "/zones/example.com/rrsets",
                    200,
                    json!({ "rrsets": [], "meta": { "pagination": { "next_page": null } } }),
                ),
            ],
            &[],
        );
        dns.create_record("example.com", &input("A", "www", "192.0.2.1"))
            .await
            .expect("created");
        dns.list_records("example.com").await.expect("lists");
        let zone_reads = sent(&stub)
            .iter()
            .filter(|(_, path, _)| path == "/zones/example.com")
            .count();
        assert_eq!(zone_reads, 1);
    }

    #[tokio::test]
    async fn a_duplicate_create_writes_nothing() {
        let (dns, stub) = dns(
            vec![
                own_zone(),
                (
                    "GET",
                    "/zones/example.com/rrsets/www/A",
                    200,
                    json!({ "rrset": { "name": "www", "type": "A", "ttl": 3600, "records": [{ "value": "192.0.2.1" }] } }),
                ),
            ],
            &[],
        );
        let created = dns
            .create_record("example.com", &input("A", "www.example.com", "192.0.2.1"))
            .await
            .expect("answers");
        assert_eq!(created, Created::Duplicate);
        assert_eq!(sent(&stub).len(), 2);
    }

    #[tokio::test]
    async fn creates_a_record_by_adding_to_its_set() {
        let (dns, stub) = dns(
            vec![
                own_zone(),
                (
                    "POST",
                    "/zones/example.com/rrsets/@/TXT/actions/add_records",
                    201,
                    done(),
                ),
            ],
            &[],
        );
        let mut record = input("TXT", "example.com", "v=spf1 -all");
        record.comment = Some("spf".to_owned());
        let created = dns
            .create_record("example.com", &record)
            .await
            .expect("created");
        assert_eq!(created, Created::Created);
        let calls = sent(&stub);
        assert_eq!(
            calls[2].2,
            json!({ "ttl": 3600, "records": [{ "value": "\"v=spf1 -all\"", "comment": "spf" }] })
        );
    }

    #[tokio::test]
    async fn waits_for_a_running_action() {
        let (dns, stub) = dns(
            vec![
                own_zone(),
                (
                    "POST",
                    "/zones/example.com/rrsets/www/A/actions/add_records",
                    201,
                    json!({ "action": { "id": 9, "status": "running" } }),
                ),
                ("GET", "/zones/actions/9", 200, done()),
            ],
            &[],
        );
        dns.create_record("example.com", &input("A", "www", "192.0.2.1"))
            .await
            .expect("created");
        assert!(
            sent(&stub)
                .iter()
                .any(|(_, path, _)| path == "/zones/actions/9")
        );
    }

    #[tokio::test]
    async fn updates_a_record_inside_its_set() {
        let id = record_id("www", "A", "192.0.2.1");
        let (dns, stub) = dns(
            vec![
                own_zone(),
                (
                    "POST",
                    "/zones/example.com/rrsets/www/A/actions/set_records",
                    201,
                    done(),
                ),
                (
                    "POST",
                    "/zones/example.com/rrsets/www/A/actions/change_ttl",
                    201,
                    done(),
                ),
                (
                    "GET",
                    "/zones/example.com/rrsets/www/A",
                    200,
                    json!({ "rrset": { "name": "www", "type": "A", "ttl": 3600, "records": [{ "value": "192.0.2.1" }, { "value": "192.0.2.9" }] } }),
                ),
            ],
            &[],
        );
        dns.update_record("example.com", &id, &input("A", "www", "192.0.2.2"))
            .await
            .expect("updated");
        let calls = sent(&stub);
        assert_eq!(calls.len(), 3);
        assert_eq!(
            calls[2].2,
            json!({ "records": [{ "value": "192.0.2.2" }, { "value": "192.0.2.9" }] })
        );
        // A new TTL is the set's.
        let mut longer = input("A", "www", "192.0.2.2");
        longer.ttl = Some(7200.0);
        dns.update_record("example.com", &id, &longer)
            .await
            .expect("updated");
        let calls = sent(&stub);
        assert_eq!(
            calls.last().map(|c| c.2.clone()),
            Some(json!({ "ttl": 7200 }))
        );
    }

    #[tokio::test]
    async fn moves_a_record_to_another_set() {
        let id = record_id("www", "A", "192.0.2.1");
        let (dns, stub) = dns(
            vec![
                own_zone(),
                (
                    "POST",
                    "/zones/example.com/rrsets/web/A/actions/add_records",
                    201,
                    done(),
                ),
                (
                    "POST",
                    "/zones/example.com/rrsets/www/A/actions/remove_records",
                    201,
                    done(),
                ),
                (
                    "GET",
                    "/zones/example.com/rrsets/www/A",
                    200,
                    json!({ "rrset": { "name": "www", "type": "A", "ttl": 3600, "records": [{ "value": "192.0.2.1" }] } }),
                ),
            ],
            &[],
        );
        dns.update_record("example.com", &id, &input("A", "web", "192.0.2.1"))
            .await
            .expect("moved");
        let paths: Vec<String> = sent(&stub).into_iter().map(|c| c.1).collect();
        assert_eq!(
            paths[2..],
            [
                "/zones/example.com/rrsets/web/A/actions/add_records".to_owned(),
                "/zones/example.com/rrsets/www/A/actions/remove_records".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn updating_a_gone_record_is_an_error() {
        let (dns, _) = dns(vec![own_zone()], &[]);
        let error = dns
            .update_record(
                "example.com",
                &record_id("www", "A", "192.0.2.1"),
                &input("A", "www", "192.0.2.2"),
            )
            .await
            .expect_err("gone");
        assert!(error.message.contains("not found"));
    }

    #[tokio::test]
    async fn deletes_a_record_from_its_set() {
        let (dns, stub) = dns(
            vec![
                own_zone(),
                (
                    "POST",
                    "/zones/example.com/rrsets/www/A/actions/remove_records",
                    201,
                    done(),
                ),
                (
                    "GET",
                    "/zones/example.com/rrsets/www/A",
                    200,
                    json!({ "rrset": { "name": "www", "type": "A", "ttl": 3600, "records": [{ "value": "192.0.2.1" }] } }),
                ),
            ],
            &[],
        );
        dns.delete_record("example.com", &record_id("www", "A", "192.0.2.1"))
            .await
            .expect("deleted");
        let calls = sent(&stub);
        assert_eq!(calls[2].2, json!({ "records": [{ "value": "192.0.2.1" }] }));
    }

    #[tokio::test]
    async fn deleting_a_gone_record_is_no_error() {
        let (dns, stub) = dns(vec![own_zone()], &[]);
        dns.delete_record("example.com", &record_id("www", "A", "192.0.2.1"))
            .await
            .expect("no error");
        assert_eq!(sent(&stub).len(), 2);
    }

    #[tokio::test]
    async fn a_failed_action_is_an_error() {
        let (dns, _) = dns(
            vec![
                own_zone(),
                (
                    "POST",
                    "/zones/example.com/rrsets/www/CNAME/actions/add_records",
                    201,
                    json!({ "action": { "id": 3, "status": "error", "error": { "code": "invalid_input", "message": "CNAME conflicts with A" } } }),
                ),
            ],
            &[],
        );
        let error = dns
            .create_record("example.com", &input("CNAME", "www", "example.net"))
            .await
            .expect_err("refused");
        assert_eq!(error.message, "CNAME conflicts with A");
    }
}
