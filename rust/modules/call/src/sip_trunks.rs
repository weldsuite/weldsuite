//! A customer's own phone system (SIP trunk / PBX) connected to WeldDesk
//! (`services/sip-trunks.ts`): the trunk (one Telnyx connection, by IP
//! address or by SIP login), its numbers (ordinary WeldDesk numbers with
//! provider `sip_trunk`, registered in the master `phone_number_registry`)
//! and verifying one for outbound caller id.
//!
//! Functions over the tenant database and Telnyx; they answer a
//! [`Failure`], which the routes (`sip_trunk_routes`) turn into the answer.
//! The password of a `credentials` trunk is made here, shown once and kept
//! only at Telnyx.

use http::StatusCode;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_schema::master::phone_number_registry as registry_rows;
use weldsuite_schema::tenant::{voip_phone_numbers as numbers, voip_sip_trunks as trunks};

use crate::registry::{self, OwnRow};
use crate::sip_trunk_number::{country_of_e164, to_trunk_e164};
use crate::sip_verification_limits::{
    CONFIRMS_PER_NUMBER, SENDS_PER_NUMBER, SENDS_PER_WORKSPACE, count_attempt,
};
use crate::telnyx::{Telnyx, TelnyxError};
use crate::telnyx_connections::{
    ConnectionBase, ConnectionPatch, DEFAULT_SIP_HOST, SIGNALING_IPS, SIP_HOSTS, SIP_PORT_PLAIN,
    SIP_PORT_TLS,
};
use crate::{CallState, Caller, js};

/// `DESK_SIP_TRUNK_MAX_IP_ADDRESSES`.
pub(crate) const MAX_IP_ADDRESSES: usize = 10;

/// The `provider` of a number on a customer's own phone system.
pub(crate) const TRUNK_PROVIDER: &str = "sip_trunk";

/// What the other number routes (`/api/telephony`, `/api/call-intelligence`)
/// answer when asked to delete such a number: it is removed from its phone
/// system instead (409).
pub(crate) const TRUNK_NUMBER_REFUSAL: &str =
    "This number belongs to a connected phone system: remove it there";

const WEBHOOK_PATH: &str = "/public/webhooks/telnyx";

/// `SipTrunkError`: a refusal the member can read (400, 404, 409 or 429).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Refusal {
    pub(crate) status: StatusCode,
    pub(crate) code: &'static str,
    pub(crate) message: String,
    /// Seconds until a 429 may be tried again (the `Retry-After` header).
    pub(crate) retry_after: Option<u64>,
}

/// Why a trunk operation stopped: a [`Refusal`], or anything else the
/// worker's service throws (its route answers 500).
#[derive(Debug)]
pub(crate) enum Failure {
    Refused(Refusal),
    Internal(String),
}

impl From<DbErr> for Failure {
    fn from(error: DbErr) -> Self {
        Self::Internal(error.to_string())
    }
}

/// A trunk's row as Drizzle returned it: the entity serializes to its JSON.
fn trunk_row(model: trunks::Model) -> Value {
    serde_json::to_value(model).unwrap_or(Value::Null)
}

/// A number's row as Drizzle returned it.
fn number_row(model: numbers::Model) -> Value {
    serde_json::to_value(model).unwrap_or(Value::Null)
}

/// `update … returning *` that expected its row (`fetch_one`): no row is
/// the query's error.
fn the_row<T>(rows: Vec<T>) -> Result<T, DbErr> {
    rows.into_iter()
        .next()
        .ok_or_else(|| DbErr::RecordNotFound("no rows returned by the update".to_owned()))
}

fn refusal(status: StatusCode, code: &'static str, message: impl Into<String>) -> Failure {
    Failure::Refused(Refusal {
        status,
        code,
        message: message.into(),
        retry_after: None,
    })
}

fn bad_request(code: &'static str, message: impl Into<String>) -> Failure {
    refusal(StatusCode::BAD_REQUEST, code, message)
}

fn conflict(code: &'static str, message: impl Into<String>) -> Failure {
    refusal(StatusCode::CONFLICT, code, message)
}

fn too_many_attempts(retry_after: u64) -> Failure {
    Failure::Refused(Refusal {
        status: StatusCode::TOO_MANY_REQUESTS,
        code: "too_many_attempts",
        message: "Too many attempts, try again later".to_owned(),
        retry_after: Some(retry_after),
    })
}

/// 409 `caller_id_unverified`: a number of a customer's own phone system may
/// not be a caller id before Telnyx verified it (`PATCH
/// /api/call-intelligence/phone-numbers/:id`, `POST /api/calls`).
pub(crate) fn caller_id_unverified() -> axum::response::Response {
    use axum::response::IntoResponse;
    weldsuite_kit::ApiError::new(
        StatusCode::CONFLICT,
        "caller_id_unverified",
        "Verify this number before using it for outgoing calls",
    )
    .with_details(json!({ "reason": "caller_id_unverified" }))
    .into_response()
}

fn number_taken() -> Failure {
    conflict("number_taken", "This number is already in use")
}

fn not_found(message: String) -> Failure {
    refusal(StatusCode::NOT_FOUND, "not_found", message)
}

/// `telnyxFailure(action, err)`: a Telnyx refusal as a 400 the member can
/// read.
fn telnyx_failure(action: &str, error: &TelnyxError) -> Failure {
    tracing::error!(%error, "[sip-trunks] {action} failed");
    bad_request(
        "telnyx_failed",
        format!("{action} failed at the phone provider"),
    )
}

/// `ignoreNotFound(run)`: a Telnyx 404 counts as done.
fn ignore_not_found(result: Result<(), TelnyxError>) -> Result<(), TelnyxError> {
    match result {
        Err(error) if error.status() == Some(404) => Ok(()),
        other => other,
    }
}

/// `bestEffort(label, run)`: a failure is logged and the work goes on.
fn best_effort(label: &str, result: Result<(), TelnyxError>) {
    if let Err(error) = ignore_not_found(result) {
        tracing::error!(%error, "[sip-trunks] {label} failed (continuing)");
    }
}

// ── JSON ────────────────────────────────────────────────────────────────────

/// `toNumberJson(row)` of a `js_row` number.
pub(crate) fn number_json(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "phoneNumber": row["phoneNumber"],
        "displayName": row["displayName"],
        "status": row["status"],
        "allowOutbound": row["allowOutbound"].as_bool().unwrap_or(false),
        "callerIdVerifiedAt": row["callerIdVerifiedAt"],
    })
}

/// `connectionDetails(env, trunk)`: what the customer's phone system needs
/// to reach Telnyx.
fn connection_details(sip_host: Option<&str>, trunk: &Value) -> Value {
    // `env.TELNYX_SIP_HOST?.trim() || DEFAULT_SIP_HOST`.
    let primary_host = sip_host
        .map(weldsuite_kit::validation::js_trim)
        .filter(|host| !host.is_empty())
        .unwrap_or(DEFAULT_SIP_HOST);
    let port = if trunk["transport"] == "tls" {
        SIP_PORT_TLS
    } else {
        SIP_PORT_PLAIN
    };
    json!({
        "sipHosts": SIP_HOSTS
            .iter()
            .map(|(region, host)| json!({ "region": region, "host": host }))
            .collect::<Vec<_>>(),
        "primaryHost": primary_host,
        "port": port,
        "transport": trunk["transport"],
        "username": trunk["sipUsername"],
        "signalingIps": SIGNALING_IPS
            .iter()
            .map(|(region, ip)| json!({ "region": region, "ip": ip }))
            .collect::<Vec<_>>(),
    })
}

/// `toTrunkJson(env, trunk, numbers)` of `js_row` rows.
fn trunk_json(sip_host: Option<&str>, trunk: &Value, numbers: &[Value]) -> Value {
    let ip_addresses: Vec<Value> = stored_addresses(trunk)
        .iter()
        .map(|address| {
            // `{ ip: a.ip, ...(a.port !== undefined ? { port: a.port } : {}) }`.
            let mut out = Map::new();
            if let Some(ip) = address.get("ip") {
                out.insert("ip".to_owned(), ip.clone());
            }
            if let Some(port) = address.get("port") {
                out.insert("port".to_owned(), port.clone());
            }
            Value::Object(out)
        })
        .collect();
    json!({
        "id": trunk["id"],
        "createdAt": trunk["createdAt"],
        "updatedAt": trunk["updatedAt"],
        "name": trunk["name"],
        "provider": trunk["provider"],
        "authMode": trunk["authMode"],
        "transport": trunk["transport"],
        "status": trunk["status"],
        "ipAddresses": ip_addresses,
        "lastInboundAt": trunk["lastInboundAt"],
        "lastError": trunk["lastError"],
        "numbers": numbers.iter().map(number_json).collect::<Vec<_>>(),
        "connection": connection_details(sip_host, trunk),
    })
}

/// `trunk.ipAddresses`: the stored allow-list (`{ ip, port?, providerIpId? }`).
fn stored_addresses(trunk: &Value) -> Vec<Value> {
    trunk["ipAddresses"].as_array().cloned().unwrap_or_default()
}

// ── Validation and credentials ──────────────────────────────────────────────

/// One address of the request (`deskSipTrunkIpAddressInputSchema`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IpInput {
    pub(crate) ip: String,
    pub(crate) port: Option<i64>,
}

impl IpInput {
    /// `` `${a.ip}:${a.port ?? 5060}` ``.
    fn key(&self) -> String {
        format!(
            "{}:{}",
            self.ip,
            self.port.unwrap_or(i64::from(SIP_PORT_PLAIN))
        )
    }

    /// `{ ...ip, providerIpId }`: the address as it is stored.
    fn stored(&self, provider_ip_id: &str) -> Value {
        let mut out = Map::new();
        out.insert("ip".to_owned(), json!(self.ip));
        if let Some(port) = self.port {
            out.insert("port".to_owned(), json!(port));
        }
        out.insert("providerIpId".to_owned(), json!(provider_ip_id));
        Value::Object(out)
    }
}

/// `keyOf(a)` of a stored address.
fn stored_key(address: &Value) -> String {
    let ip = address
        .get("ip")
        .map_or_else(|| "undefined".to_owned(), js::string);
    let port = match address.get("port") {
        None | Some(Value::Null) => SIP_PORT_PLAIN.to_string(),
        Some(port) => js::string(port),
    };
    format!("{ip}:{port}")
}

/// `isBlockedHost(ip)` for a dotted IPv4 address (what the request schema
/// lets through): loopback, private, link-local, CGNAT, benchmarking,
/// documentation, multicast and reserved ranges. Anything that is not a
/// dotted quad is refused too.
fn is_blocked_ip(ip: &str) -> bool {
    let parts: Vec<u16> = ip
        .split('.')
        .filter_map(|part| {
            ((1..=3).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit()))
                .then(|| part.parse::<u16>().ok())
                .flatten()
        })
        .collect();
    let [a, b, c, d] = parts[..] else {
        return true;
    };
    if ip.split('.').count() != 4 || [a, b, c, d].iter().any(|part| *part > 255) {
        return true;
    }
    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224
}

/// `validateIpAddresses(input)`: public IPv4 only, no duplicates; the limit
/// is 1 to 10.
pub(crate) fn validate_ip_addresses(input: &[IpInput]) -> Result<Vec<IpInput>, Failure> {
    if input.is_empty() {
        return Err(bad_request("ip_required", "Add at least one IP address"));
    }
    if input.len() > MAX_IP_ADDRESSES {
        return Err(bad_request(
            "too_many_ips",
            format!("At most {MAX_IP_ADDRESSES} IP addresses"),
        ));
    }
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::with_capacity(input.len());
    for entry in input {
        if is_blocked_ip(&entry.ip) {
            return Err(bad_request(
                "invalid_ip",
                format!("{} is not a public IP address", entry.ip),
            ));
        }
        let key = entry.key();
        if seen.contains(&key) {
            return Err(bad_request(
                "duplicate_ip",
                format!("{} is listed twice", entry.ip),
            ));
        }
        seen.push(key);
        out.push(entry.clone());
    }
    Ok(out)
}

/// Upper case, lower case and digits, without the characters that are hard
/// to read aloud.
const PASSWORD_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/// `generateSipPassword()`: 24 random characters with upper case, lower
/// case and digits.
fn generate_sip_password() -> String {
    loop {
        let text = weldsuite_kit::random_string(24, PASSWORD_ALPHABET);
        if text.bytes().any(|b| b.is_ascii_lowercase())
            && text.bytes().any(|b| b.is_ascii_uppercase())
            && text.bytes().any(|b| b.is_ascii_digit())
        {
            return text;
        }
    }
}

/// `sipUsernameFor(workspaceId, trunkId)`: the SIP login of a trunk, derived
/// from its workspace and id: lower case letters and digits only.
fn sip_username_for(workspace_id: &str, trunk_id: &str) -> String {
    // `.replace(/[^a-z0-9]/gi, '').toLowerCase()`.
    let plain = |text: &str| -> String {
        text.chars()
            .filter(char::is_ascii_alphanumeric)
            .map(|c| c.to_ascii_lowercase())
            .collect()
    };
    let workspace = plain(workspace_id);
    let workspace = &workspace[workspace.len().saturating_sub(8)..];
    let mut username = format!("wd{workspace}{}", plain(trunk_id));
    username.truncate(64);
    username
}

// ── Requests ────────────────────────────────────────────────────────────────

/// `CreateDeskSipTrunkInput`.
#[derive(Debug, Clone)]
pub(crate) struct CreateInput {
    pub(crate) name: String,
    pub(crate) provider: String,
    pub(crate) auth_mode: String,
    pub(crate) transport: Option<String>,
    pub(crate) ip_addresses: Option<Vec<IpInput>>,
}

/// `UpdateDeskSipTrunkInput`.
#[derive(Debug, Clone, Default)]
pub(crate) struct UpdateInput {
    pub(crate) name: Option<String>,
    pub(crate) provider: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) transport: Option<String>,
    pub(crate) ip_addresses: Option<Vec<IpInput>>,
}

/// A trunk's SIP login, shown once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Credentials {
    pub(crate) username: String,
    pub(crate) password: String,
}

impl Credentials {
    pub(crate) fn json(&self) -> Value {
        json!({ "username": self.username, "password": self.password })
    }
}

/// What creating a trunk answers: its JSON, its row and its login.
pub(crate) struct CreatedTrunk {
    pub(crate) trunk: Value,
    pub(crate) row: Value,
    pub(crate) credentials: Option<Credentials>,
}

/// `SipTrunkContext`: the request's tenant database, Telnyx and env.
pub(crate) struct Trunks<'a> {
    caller: &'a Caller,
    state: &'a CallState,
    telnyx: Telnyx,
}

impl<'a> Trunks<'a> {
    pub(crate) fn new(caller: &'a Caller, state: &'a CallState) -> Self {
        Self {
            caller,
            state,
            telnyx: caller.telnyx(state),
        }
    }

    fn db(&self) -> DatabaseConnection {
        orm(&self.caller.db)
    }

    fn sip_host(&self) -> Option<String> {
        self.caller.env("TELNYX_SIP_HOST")
    }

    /// `requireTelnyx(env)`.
    fn require_telnyx(&self) -> Result<(), Failure> {
        if self.telnyx.configured() {
            Ok(())
        } else {
            Err(bad_request(
                "not_configured",
                "Phone service is not activated",
            ))
        }
    }

    // ── Loading ─────────────────────────────────────────────────────────────

    /// `loadNumbers(db, trunkIds)`: the live numbers of these trunks, oldest
    /// first.
    async fn load_numbers(&self, trunk_ids: &[String]) -> Result<Vec<Value>, sqlx::Error> {
        if trunk_ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(n) from voip_phone_numbers n
             where n.sip_trunk_id = any($1) and n.deleted_at is null
             order by n.created_at asc, n.id asc",
        )
        .bind(trunk_ids)
        .fetch_all(self.db())
        .await?;
        Ok(crate::rows(rows))
    }

    /// `loadTrunk(db, id)`.
    async fn load_trunk(&self, id: &str) -> Result<Value, Failure> {
        let row: Option<Value> =
            sqlx::query_scalar("select to_jsonb(t) from voip_sip_trunks t where t.id = $1 limit 1")
                .bind(id)
                .fetch_optional(self.db())
                .await?;
        row.map(weldsuite_db::js_row)
            .ok_or_else(|| not_found(format!("Phone system '{id}' not found")))
    }

    /// `loadTrunkNumber(db, trunkId, numberId)`: a live number of this trunk.
    async fn load_trunk_number(&self, trunk_id: &str, number_id: &str) -> Result<Value, Failure> {
        let row: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(n) from voip_phone_numbers n
             where n.id = $1 and n.sip_trunk_id = $2 and n.deleted_at is null limit 1",
        )
        .bind(number_id)
        .bind(trunk_id)
        .fetch_optional(self.db())
        .await?;
        row.map(weldsuite_db::js_row).ok_or_else(|| {
            not_found(format!(
                "Number '{number_id}' not found on this phone system"
            ))
        })
    }

    /// `listSipTrunks(ctx)`: every trunk with its numbers and connection
    /// details, oldest first.
    pub(crate) async fn list(&self) -> Result<Vec<Value>, Failure> {
        let trunks: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from voip_sip_trunks t order by t.created_at asc, t.id asc",
        )
        .fetch_all(self.db())
        .await?;
        let trunks = crate::rows(trunks);
        let ids: Vec<String> = trunks
            .iter()
            .map(|trunk| js::string(&trunk["id"]))
            .collect();
        let numbers = self.load_numbers(&ids).await?;
        let sip_host = self.sip_host();
        Ok(trunks
            .iter()
            .map(|trunk| {
                let own: Vec<Value> = numbers
                    .iter()
                    .filter(|number| number["sipTrunkId"] == trunk["id"])
                    .cloned()
                    .collect();
                trunk_json(sip_host.as_deref(), trunk, &own)
            })
            .collect())
    }

    // ── Trunks ──────────────────────────────────────────────────────────────

    /// Delete a connection made a moment ago, so nothing is left behind.
    async fn roll_back_connection(&self, credentials: bool, connection_id: &str) {
        let deleted = if credentials {
            self.telnyx
                .delete_credential_connection(connection_id)
                .await
        } else {
            self.telnyx.delete_ip_connection(connection_id).await
        };
        best_effort("rolling back the connection", deleted);
    }

    /// `createSipTrunk(ctx, input)`: the Telnyx connection (with its
    /// addresses), then the row. A failure on the way leaves nothing behind.
    pub(crate) async fn create(&self, input: &CreateInput) -> Result<CreatedTrunk, Failure> {
        self.require_telnyx()?;
        let transport = input.transport.as_deref().unwrap_or("udp");
        let credentials_mode = input.auth_mode == "credentials";
        let requested = input.ip_addresses.as_deref().unwrap_or_default();
        let ips = if input.auth_mode == "ip" {
            validate_ip_addresses(requested)?
        } else {
            Vec::new()
        };
        if credentials_mode && !requested.is_empty() {
            return Err(bad_request(
                "ip_not_applicable",
                "IP addresses only apply to an IP-authenticated trunk",
            ));
        }

        let id = weldsuite_kit::generate_id("strk");
        let credentials = credentials_mode.then(|| Credentials {
            username: sip_username_for(&self.caller.org(), &id),
            password: generate_sip_password(),
        });

        let webhook_url = crate::desk_phone::call_api_url(self.caller.request_env(), WEBHOOK_PATH);
        let voice_profile = self.caller.env("TELNYX_OUTBOUND_VOICE_PROFILE_ID");
        let base = ConnectionBase {
            name: &input.name,
            webhook_url: &webhook_url,
            outbound_voice_profile_id: voice_profile.as_deref(),
        };
        let mut connection_id: Option<String> = None;
        let mut ip_addresses: Vec<Value> = Vec::new();
        let made: Result<(), TelnyxError> = async {
            if let Some(login) = &credentials {
                connection_id = Some(
                    self.telnyx
                        .create_credential_connection(&base, &login.username, &login.password)
                        .await?,
                );
            } else {
                let connection = self.telnyx.create_ip_connection(&base, transport).await?;
                connection_id = Some(connection.clone());
                for ip in &ips {
                    let provider_ip_id =
                        self.telnyx.create_ip(&connection, &ip.ip, ip.port).await?;
                    ip_addresses.push(ip.stored(&provider_ip_id));
                }
            }
            Ok(())
        }
        .await;
        if let Err(error) = made {
            // Nothing is left behind: the connection (and with it its
            // addresses) goes.
            if let Some(created) = &connection_id {
                self.roll_back_connection(credentials_mode, created).await;
            }
            return Err(telnyx_failure("Creating the connection", &error));
        }

        let inserted: Result<Value, sqlx::Error> = sqlx::query_scalar(
            "insert into voip_sip_trunks (id, created_at, updated_at, name, provider, auth_mode,
                 ip_addresses, sip_username, transport, provider_connection_id, status, created_by_id)
             values ($1, $2::timestamp, $2::timestamp, $3, $4, $5, $6, $7, $8, $9, 'active', $10)
             returning to_jsonb(voip_sip_trunks)",
        )
        .bind(&id)
        .bind(now())
        .bind(&input.name)
        .bind(&input.provider)
        .bind(&input.auth_mode)
        .bind(Value::Array(ip_addresses))
        .bind(credentials.as_ref().map(|login| login.username.as_str()))
        .bind(transport)
        .bind(&connection_id)
        .bind(&self.caller.user_id)
        .fetch_one(self.db())
        .await;
        match inserted {
            Ok(row) => {
                let row = weldsuite_db::js_row(row);
                Ok(CreatedTrunk {
                    trunk: trunk_json(self.sip_host().as_deref(), &row, &[]),
                    row,
                    credentials,
                })
            }
            Err(error) => {
                if let Some(created) = &connection_id {
                    self.roll_back_connection(credentials_mode, created).await;
                }
                Err(error.into())
            }
        }
    }

    /// The addresses of an update by diff: the new ones are added first,
    /// then the gone ones removed. Answers the list to store and, when
    /// removing one failed, that failure.
    async fn sync_addresses(
        &self,
        connection_id: &str,
        stored: &[Value],
        wanted: &[IpInput],
    ) -> Result<(Vec<Value>, Option<Failure>), Failure> {
        // `new Map(entries)`: a repeated key keeps its first place and its
        // last value.
        let mut current: Vec<(String, &Value)> = Vec::new();
        for address in stored {
            let key = stored_key(address);
            match current.iter_mut().find(|(existing, _)| *existing == key) {
                Some(entry) => entry.1 = address,
                None => current.push((key, address)),
            }
        }
        let wanted_keys: Vec<String> = wanted.iter().map(IpInput::key).collect();
        let kept: Vec<Value> = stored
            .iter()
            .filter(|address| wanted_keys.contains(&stored_key(address)))
            .cloned()
            .collect();

        let mut added: Vec<(Value, String)> = Vec::new();
        for (ip, key) in wanted.iter().zip(&wanted_keys) {
            if current.iter().any(|(existing, _)| existing == key) {
                continue;
            }
            match self.telnyx.create_ip(connection_id, &ip.ip, ip.port).await {
                Ok(provider_ip_id) => added.push((ip.stored(&provider_ip_id), provider_ip_id)),
                Err(error) => {
                    for (_, provider_ip_id) in &added {
                        if !provider_ip_id.is_empty() {
                            best_effort(
                                "rolling back an address",
                                self.telnyx.delete_ip(provider_ip_id).await,
                            );
                        }
                    }
                    return Err(telnyx_failure("Adding an IP address", &error));
                }
            }
        }

        let mut still_there: Vec<Value> = Vec::new();
        let mut failure = None;
        for (key, old) in &current {
            if wanted_keys.contains(key) {
                continue;
            }
            let provider_ip_id = &old["providerIpId"];
            if !js::truthy(provider_ip_id) {
                continue;
            }
            let removed = self.telnyx.delete_ip(&js::string(provider_ip_id)).await;
            if let Err(error) = ignore_not_found(removed) {
                still_there.push((*old).clone());
                failure = Some(telnyx_failure("Removing an IP address", &error));
            }
        }
        let mut addresses = kept;
        addresses.extend(added.into_iter().map(|(address, _)| address));
        addresses.extend(still_there);
        Ok((addresses, failure))
    }

    /// `updateSipTrunk(ctx, id, input)`: the trunk's name, phone system,
    /// status, transport and addresses, at Telnyx and in the row. The
    /// addresses already changed at Telnyx are kept in the row even when a
    /// later step failed.
    pub(crate) async fn update(
        &self,
        id: &str,
        input: &UpdateInput,
    ) -> Result<(Value, Value), Failure> {
        let trunk = self.load_trunk(id).await?;
        let connection_id = trunk["providerConnectionId"]
            .as_str()
            .filter(|connection| !connection.is_empty());
        let is_ip = trunk["authMode"] == "ip";

        if input.ip_addresses.is_some() && !is_ip {
            return Err(bad_request(
                "ip_not_applicable",
                "IP addresses only apply to an IP-authenticated trunk",
            ));
        }
        let wanted = match &input.ip_addresses {
            Some(addresses) => Some(validate_ip_addresses(addresses)?),
            None => None,
        };

        let differs = |field: &Option<String>, key: &str| {
            field
                .as_deref()
                .is_some_and(|value| trunk[key].as_str() != Some(value))
        };
        let connection_change = differs(&input.name, "name")
            || differs(&input.status, "status")
            || (differs(&input.transport, "transport") && is_ip);
        if (connection_change || wanted.is_some()) && connection_id.is_some() {
            self.require_telnyx()?;
        }

        let stored = stored_addresses(&trunk);
        let mut addresses = stored.clone();
        let mut failure: Option<Failure> = None;
        if let (Some(wanted), Some(connection_id)) = (&wanted, connection_id) {
            (addresses, failure) = self.sync_addresses(connection_id, &stored, wanted).await?;
        }

        if let Some(connection_id) = connection_id
            && connection_change
            && failure.is_none()
        {
            let active = input.status.as_deref().map(|status| status == "active");
            let patched = if is_ip {
                self.telnyx
                    .update_ip_connection(
                        connection_id,
                        ConnectionPatch {
                            name: input.name.as_deref(),
                            transport: input.transport.as_deref(),
                            active,
                            ..ConnectionPatch::default()
                        },
                    )
                    .await
            } else {
                self.telnyx
                    .update_credential_connection(
                        connection_id,
                        ConnectionPatch {
                            name: input.name.as_deref(),
                            active,
                            ..ConnectionPatch::default()
                        },
                    )
                    .await
            };
            if let Err(error) = patched {
                failure = Some(telnyx_failure("Updating the connection", &error));
            }
        }

        // A failed step keeps the trunk's own fields as they were.
        let field = |value: &Option<String>| {
            if failure.is_some() {
                None
            } else {
                value.clone()
            }
        };
        let row: Option<Value> = sqlx::query_scalar(
            "update voip_sip_trunks set ip_addresses = $2, updated_at = $3::timestamp,
                 name = coalesce($4, name), provider = coalesce($5, provider),
                 status = coalesce($6, status), transport = coalesce($7, transport)
             where id = $1
             returning to_jsonb(voip_sip_trunks)",
        )
        .bind(id)
        .bind(Value::Array(addresses))
        .bind(now())
        .bind(field(&input.name))
        .bind(field(&input.provider))
        .bind(field(&input.status))
        .bind(field(&input.transport))
        .fetch_optional(self.db())
        .await?;
        if let Some(failure) = failure {
            return Err(failure);
        }
        let row = row
            .map(weldsuite_db::js_row)
            .ok_or_else(|| Failure::Internal("the phone system is gone".to_owned()))?;
        let numbers = self.load_numbers(&[id.to_owned()]).await?;
        Ok((trunk_json(self.sip_host().as_deref(), &row, &numbers), row))
    }

    /// `rotateSipTrunkPassword(ctx, id)`: a new password at Telnyx, shown
    /// once. Answers the trunk as it was read and its new login.
    pub(crate) async fn rotate_password(&self, id: &str) -> Result<(Value, Credentials), Failure> {
        let trunk = self.load_trunk(id).await?;
        let text = |key: &str| trunk[key].as_str().filter(|value| !value.is_empty());
        let (Some(username), Some(connection_id)) =
            (text("sipUsername"), text("providerConnectionId"))
        else {
            return Err(credentials_only());
        };
        if trunk["authMode"] != "credentials" {
            return Err(credentials_only());
        }
        self.require_telnyx()?;
        let password = generate_sip_password();
        self.telnyx
            .update_credential_connection(
                connection_id,
                ConnectionPatch {
                    password: Some(&password),
                    ..ConnectionPatch::default()
                },
            )
            .await
            .map_err(|error| telnyx_failure("Changing the password", &error))?;
        sqlx::query("update voip_sip_trunks set updated_at = $2::timestamp where id = $1")
            .bind(id)
            .bind(now())
            .execute(self.db())
            .await?;
        let credentials = Credentials {
            username: username.to_owned(),
            password,
        };
        Ok((trunk, credentials))
    }

    /// `releaseNumber(ctx, number)`: free a retired number. This
    /// workspace's own registry entry goes (never one another workspace holds
    /// for the number by now), and the verified caller id at Telnyx when
    /// there was one.
    async fn release_number(&self, number: &Value) {
        let id = js::string(&number["id"]);
        let phone = js::string(&number["phoneNumber"]);
        let org = self.caller.org();
        let master = self.caller.master(self.state);
        let own = OwnRow {
            phone_number: &phone,
            clerk_org_id: &org,
            voip_phone_number_id: &id,
        };
        if let Err(error) = registry::release(master.as_ref(), own).await {
            tracing::error!(%error, "[sip-trunks] releasing the registry entry failed (continuing)");
        }
        if js::truthy(&number["callerIdVerifiedAt"]) && self.telnyx.configured() {
            best_effort(
                "removing the verified number",
                self.telnyx.delete_verified_number(&phone).await,
            );
        }
    }

    /// `retireNumber(ctx, number)`: soft-delete one number of a trunk and
    /// free it in the registry (and at Telnyx when it was verified).
    async fn retire_number(&self, number: &Value) -> Result<(), Failure> {
        sqlx::query(
            "update voip_phone_numbers set deleted_at = $2::timestamp, updated_at = $2::timestamp,
                 status = 'inactive'
             where id = $1",
        )
        .bind(js::string(&number["id"]))
        .bind(now())
        .execute(self.db())
        .await?;
        self.release_number(number).await;
        Ok(())
    }

    /// `deleteSipTrunk(ctx, id)`: the connection first, then the row, then
    /// its numbers by trunk id (and their verified caller ids, best effort).
    /// A number added while the trunk is being deleted is then either seen
    /// here, or undone by `add_number`, which looks for the trunk again after
    /// its own writes: no live number is left on a deleted trunk. Answers the
    /// trunk and its numbers as they were.
    pub(crate) async fn delete(&self, id: &str) -> Result<(Value, Vec<Value>), Failure> {
        let trunk = self.load_trunk(id).await?;
        if let Some(connection) = trunk["providerConnectionId"]
            .as_str()
            .filter(|connection| !connection.is_empty())
        {
            self.require_telnyx()?;
            let deleted = if trunk["authMode"] == "credentials" {
                self.telnyx.delete_credential_connection(connection).await
            } else {
                self.telnyx.delete_ip_connection(connection).await
            };
            ignore_not_found(deleted)
                .map_err(|error| telnyx_failure("Deleting the connection", &error))?;
        }
        sqlx::query("delete from voip_sip_trunks where id = $1")
            .bind(id)
            .execute(self.db())
            .await?;
        let numbers = self.load_numbers(&[id.to_owned()]).await?;
        sqlx::query(
            "update voip_phone_numbers set deleted_at = $2::timestamp, updated_at = $2::timestamp,
                 status = 'inactive'
             where sip_trunk_id = $1 and deleted_at is null",
        )
        .bind(id)
        .bind(now())
        .execute(self.db())
        .await?;
        for number in &numbers {
            self.release_number(number).await;
        }
        Ok((trunk, numbers))
    }

    // ── Numbers ─────────────────────────────────────────────────────────────

    /// The row of a trunk's number: a new one, or the row `existing` (a
    /// number removed earlier) brought back. It takes inbound calls, and is
    /// not shown as caller id until verified with Telnyx.
    async fn store_number(
        &self,
        existing: Option<&str>,
        e164: &str,
        trunk: &Value,
        display_name: Option<&str>,
    ) -> Result<Value, sqlx::Error> {
        let connection_id = trunk["providerConnectionId"].as_str();
        let trunk_id = trunk["id"].as_str();
        let now = now();
        let row: Value = if let Some(existing) = existing {
            sqlx::query_scalar(
                "update voip_phone_numbers set provider = 'sip_trunk', phone_number = $2,
                     formatted_number = $2, country_code = $3, number_type = 'local',
                     provider_phone_number_id = null, provider_connection_id = $4, status = 'active',
                     assigned_user_id = null, assigned_at = null, is_default = false,
                     allow_inbound = true, allow_outbound = false, enable_recording = true,
                     display_name = $5, sip_trunk_id = $6, caller_id_verified_at = null,
                     deleted_at = null, updated_at = $7::timestamp
                 where id = $1
                 returning to_jsonb(voip_phone_numbers)",
            )
            .bind(existing)
            .bind(e164)
            .bind(country_of_e164(e164))
            .bind(connection_id)
            .bind(display_name)
            .bind(trunk_id)
            .bind(&now)
            .fetch_one(self.db())
            .await?
        } else {
            sqlx::query_scalar(
                "insert into voip_phone_numbers (id, created_at, provider, phone_number,
                     formatted_number, country_code, number_type, provider_phone_number_id,
                     provider_connection_id, status, assigned_user_id, assigned_at, is_default,
                     allow_inbound, allow_outbound, enable_recording, display_name, sip_trunk_id,
                     caller_id_verified_at, deleted_at, updated_at)
                 values ($1, $7::timestamp, 'sip_trunk', $2, $2, $3, 'local', null, $4, 'active',
                     null, null, false, true, false, true, $5, $6, null, null, $7::timestamp)
                 returning to_jsonb(voip_phone_numbers)",
            )
            .bind(weldsuite_kit::generate_id("vpn"))
            .bind(e164)
            .bind(country_of_e164(e164))
            .bind(connection_id)
            .bind(display_name)
            .bind(trunk_id)
            .bind(&now)
            .fetch_one(self.db())
            .await?
        };
        Ok(weldsuite_db::js_row(row))
    }

    /// `reclaimableRegistryIds(ctx, e164, ownRowId)`: the registry entries
    /// this workspace may take over when it claims `e164`: its own entry
    /// that names a row of this workspace which is soft-deleted or gone (a
    /// clean-up that did not finish). Its own entry for `own_row_id` (the
    /// number's row here, known to be soft-deleted) needs no naming: the claim
    /// accepts the row it writes. Anything else holds the number, and so does
    /// every entry of another workspace, active or not.
    async fn reclaimable_registry_ids(
        &self,
        master: &PgPool,
        e164: &str,
        own_row_id: Option<&str>,
    ) -> Result<Vec<String>, Failure> {
        let registered: Option<(String, String)> = sqlx::query_as(
            "select clerk_org_id, voip_phone_number_id from phone_number_registry
             where phone_number = $1 limit 1",
        )
        .bind(e164)
        .fetch_optional(master)
        .await?;
        let Some((org, row_id)) = registered else {
            return Ok(Vec::new());
        };
        if org != self.caller.org() {
            return Err(number_taken());
        }
        if Some(row_id.as_str()) == own_row_id {
            return Ok(Vec::new());
        }
        let named: Option<bool> = sqlx::query_scalar(
            "select deleted_at is null from voip_phone_numbers where id = $1 limit 1",
        )
        .bind(&row_id)
        .fetch_optional(self.db())
        .await?;
        if named == Some(true) {
            return Err(number_taken());
        }
        Ok(vec![row_id])
    }

    /// `shelveNumber(db, numberId)`: take back a number's row whose claim did
    /// not go through.
    async fn shelve_number(&self, number_id: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "update voip_phone_numbers set deleted_at = $2::timestamp, status = 'inactive'
             where id = $1",
        )
        .bind(number_id)
        .bind(crate::now())
        .execute(self.db())
        .await?;
        Ok(())
    }

    /// `claimNumber(ctx, row, reclaimIds)`: claim the number in the registry
    /// for the row, in one conditional write. A claim that fails or is lost
    /// (another workspace took the number between the look and the write)
    /// takes the row back.
    async fn claim_number(
        &self,
        master: &PgPool,
        e164: &str,
        number_id: &str,
        reclaim_ids: &[String],
    ) -> Result<(), Failure> {
        let org = self.caller.org();
        let own = OwnRow {
            phone_number: e164,
            clerk_org_id: &org,
            voip_phone_number_id: number_id,
        };
        match registry::claim(Some(master), own, reclaim_ids).await {
            Ok(true) => Ok(()),
            Ok(false) => {
                self.shelve_number(number_id).await?;
                Err(number_taken())
            }
            Err(error) => {
                tracing::error!(%error, "[sip-trunks] registering the number failed");
                self.shelve_number(number_id).await?;
                Err(bad_request(
                    "registry_failed",
                    "The number could not be registered, try again",
                ))
            }
        }
    }

    /// `addTrunkNumber(ctx, trunkId, input)`: a number of the phone system,
    /// registered for inbound routing and kept from outbound caller id until
    /// it is verified. A number removed earlier comes back as its old row.
    pub(crate) async fn add_number(
        &self,
        trunk_id: &str,
        phone_number: &str,
        display_name: Option<&str>,
    ) -> Result<Value, Failure> {
        let trunk = self.load_trunk(trunk_id).await?;
        let Some(e164) = to_trunk_e164(phone_number) else {
            return Err(bad_request(
                "invalid_number",
                "Enter the number in international format, like +31201234567",
            ));
        };

        let existing: Option<(String, bool)> = sqlx::query_as(
            "select id, deleted_at is null from voip_phone_numbers where phone_number = $1 limit 1",
        )
        .bind(&e164)
        .fetch_optional(self.db())
        .await?;
        if matches!(existing, Some((_, true))) {
            return Err(number_taken());
        }

        // The registry is the arbiter between workspaces. This look only
        // spares a write that cannot succeed: the claim below is what decides.
        let master = self
            .caller
            .master(self.state)
            .ok_or_else(|| Failure::Internal("no master database".to_owned()))?;
        let reclaim_ids = self
            .reclaimable_registry_ids(&master, &e164, existing.as_ref().map(|(id, _)| id.as_str()))
            .await?;

        let row = self
            .store_number(
                existing.as_ref().map(|(id, _)| id.as_str()),
                &e164,
                &trunk,
                display_name,
            )
            .await?;
        let number_id = js::string(&row["id"]);

        self.claim_number(&master, &e164, &number_id, &reclaim_ids)
            .await?;

        // The trunk may have been deleted while this ran. Its delete takes the
        // numbers it finds after the trunk's row is gone; one written too late
        // for that is taken back here.
        let still: Option<String> =
            sqlx::query_scalar("select id from voip_sip_trunks where id = $1 limit 1")
                .bind(js::string(&trunk["id"]))
                .fetch_optional(self.db())
                .await?;
        if still.is_none() {
            self.retire_number(&row).await?;
            return Err(not_found(format!("Phone system '{trunk_id}' not found")));
        }
        Ok(row)
    }

    /// `removeTrunkNumber(ctx, trunkId, numberId)`: the number as it was.
    pub(crate) async fn remove_number(
        &self,
        trunk_id: &str,
        number_id: &str,
    ) -> Result<Value, Failure> {
        self.load_trunk(trunk_id).await?;
        let number = self.load_trunk_number(trunk_id, number_id).await?;
        self.retire_number(&number).await?;
        Ok(number)
    }

    // ── Caller id verification ──────────────────────────────────────────────

    /// `limitAttempts(ctx, scope, max)`: count one attempt in `scope`; over
    /// `max` in the hour it is refused (429, with when to try again).
    async fn limit_attempts(&self, scope: &str, max: i64) -> Result<(), Failure> {
        let cache = self.caller.cache(self.state);
        match count_attempt(cache.as_ref(), scope, max).await {
            Some(retry_after) => Err(too_many_attempts(retry_after)),
            None => Ok(()),
        }
    }

    /// The number to verify, unless it already is.
    async fn unverified_number(&self, trunk_id: &str, number_id: &str) -> Result<Value, Failure> {
        self.require_telnyx()?;
        self.load_trunk(trunk_id).await?;
        let number = self.load_trunk_number(trunk_id, number_id).await?;
        if js::truthy(&number["callerIdVerifiedAt"]) {
            return Err(conflict(
                "already_verified",
                "This number is already verified",
            ));
        }
        Ok(number)
    }

    /// `startNumberVerification(ctx, trunkId, numberId, method)`: Telnyx
    /// sends the number a code by call or SMS.
    pub(crate) async fn start_verification(
        &self,
        trunk_id: &str,
        number_id: &str,
        method: &str,
    ) -> Result<Value, Failure> {
        let number = self.unverified_number(trunk_id, number_id).await?;
        let phone = js::string(&number["phoneNumber"]);
        // Every send makes Telnyx call or text the number: a few an hour are plenty.
        let org = self.caller.org();
        let own = js::string(&number["id"]);
        self.limit_attempts(&format!("send-number:{org}:{own}"), SENDS_PER_NUMBER)
            .await?;
        self.limit_attempts(&format!("send-workspace:{org}"), SENDS_PER_WORKSPACE)
            .await?;
        if let Err(error) = self
            .telnyx
            .request_number_verification(&phone, method)
            .await
        {
            if error
                .status()
                .is_some_and(|status| (400..500).contains(&status))
            {
                tracing::error!(%error, "[sip-trunks] verification request refused");
                return Err(bad_request(
                    "verification_refused",
                    "The phone provider could not send a code to this number",
                ));
            }
            return Err(telnyx_failure("Sending the code", &error));
        }
        Ok(json!({ "method": method, "phoneNumber": phone }))
    }

    /// `confirmNumberVerification(ctx, trunkId, numberId, code)`: the code
    /// checked at Telnyx; the number may then be shown as caller id.
    pub(crate) async fn confirm_verification(
        &self,
        trunk_id: &str,
        number_id: &str,
        code: &str,
    ) -> Result<Value, Failure> {
        let number = self.unverified_number(trunk_id, number_id).await?;
        let phone = js::string(&number["phoneNumber"]);
        // A code is a few digits: it must not be guessed.
        let org = self.caller.org();
        let own = js::string(&number["id"]);
        self.limit_attempts(&format!("confirm-number:{org}:{own}"), CONFIRMS_PER_NUMBER)
            .await?;
        if let Err(error) = self.telnyx.confirm_number_verification(&phone, code).await {
            return Err(match confirmation_refusal(&error) {
                Some(refusal) => refusal,
                None => telnyx_failure("Checking the code", &error),
            });
        }
        let row: Value = sqlx::query_scalar(
            "update voip_phone_numbers set caller_id_verified_at = $2::timestamp,
                 allow_outbound = true, updated_at = $2::timestamp
             where id = $1
             returning to_jsonb(voip_phone_numbers)",
        )
        .bind(js::string(&number["id"]))
        .bind(now())
        .fetch_one(self.db())
        .await?;
        Ok(weldsuite_db::js_row(row))
    }
}

fn credentials_only() -> Failure {
    bad_request(
        "credentials_only",
        "Only a trunk that signs in with a username has a password",
    )
}

/// What a Telnyx answer to a verification code means: an expired code (a
/// 404, or a message that says so), a wrong one (any other 4xx), or `None`
/// for a failure that is Telnyx's own.
fn confirmation_refusal(error: &TelnyxError) -> Option<Failure> {
    let status = error.status()?;
    // `/expire/i.test(err.message)`.
    if status == 404 || error.to_string().to_ascii_lowercase().contains("expire") {
        return Some(bad_request(
            "code_expired",
            "The code has expired, ask for a new one",
        ));
    }
    (400..500)
        .contains(&status)
        .then(|| bad_request("wrong_code", "That code is not right"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(ip: &str, port: Option<i64>) -> IpInput {
        IpInput {
            ip: ip.to_owned(),
            port,
        }
    }

    fn code_of(failure: &Failure) -> &'static str {
        match failure {
            Failure::Refused(refusal) => refusal.code,
            Failure::Internal(_) => "internal",
        }
    }

    #[test]
    fn only_public_addresses_are_allow_listed() {
        for blocked in [
            "0.1.2.3",
            "10.0.0.1",
            "127.0.0.1",
            "100.64.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.5",
            "192.0.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.7",
            "203.0.113.9",
            "224.0.0.1",
            "255.255.255.255",
            "not-an-ip",
            "1.2.3",
        ] {
            assert!(is_blocked_ip(blocked), "{blocked}");
        }
        for public in [
            "8.8.8.8",
            "1.1.1.1",
            "100.63.0.1",
            "172.32.0.1",
            "192.0.1.1",
            "198.20.0.1",
            "008.008.008.008",
        ] {
            assert!(!is_blocked_ip(public), "{public}");
        }
    }

    #[test]
    fn address_lists_are_checked_like_the_worker() {
        let none = validate_ip_addresses(&[]).expect_err("empty");
        assert_eq!(code_of(&none), "ip_required");
        let many: Vec<IpInput> = (0..11).map(|n| ip(&format!("8.8.8.{n}"), None)).collect();
        assert_eq!(
            code_of(&validate_ip_addresses(&many).expect_err("eleven")),
            "too_many_ips"
        );
        let private = validate_ip_addresses(&[ip("192.168.1.5", None)]).expect_err("private");
        assert!(matches!(
            &private,
            Failure::Refused(refusal)
                if refusal.code == "invalid_ip"
                    && refusal.message == "192.168.1.5 is not a public IP address"
                    && refusal.status == StatusCode::BAD_REQUEST
        ));
        // No port is port 5060.
        let twice = validate_ip_addresses(&[ip("8.8.8.8", None), ip("8.8.8.8", Some(5060))])
            .expect_err("twice");
        assert!(matches!(
            &twice,
            Failure::Refused(refusal)
                if refusal.code == "duplicate_ip" && refusal.message == "8.8.8.8 is listed twice"
        ));
        let fine = validate_ip_addresses(&[ip("8.8.8.8", None), ip("8.8.8.8", Some(5070))])
            .expect("two ports");
        assert_eq!(fine.len(), 2);
    }

    #[test]
    fn logins_and_passwords_have_the_workers_shape() {
        assert_eq!(
            sip_username_for("org_test_default", "strk_m1x2k3l4a8b9c0d1"),
            "wdtdefaultstrkm1x2k3l4a8b9c0d1"
        );
        assert_eq!(sip_username_for("ws", "STRK_é1"), "wdwsstrk1");
        assert_eq!(sip_username_for(&"a".repeat(40), &"b".repeat(80)).len(), 64);
        for _ in 0..20 {
            let password = generate_sip_password();
            assert_eq!(password.len(), 24);
            assert!(
                password
                    .bytes()
                    .all(|b| PASSWORD_ALPHABET.as_bytes().contains(&b))
            );
            assert!(password.bytes().any(|b| b.is_ascii_lowercase()));
            assert!(password.bytes().any(|b| b.is_ascii_uppercase()));
            assert!(password.bytes().any(|b| b.is_ascii_digit()));
        }
    }

    #[test]
    fn stored_addresses_key_on_ip_and_port() {
        assert_eq!(stored_key(&json!({ "ip": "8.8.8.8" })), "8.8.8.8:5060");
        assert_eq!(
            stored_key(&json!({ "ip": "8.8.8.8", "port": 5070, "providerIpId": "ip-1" })),
            "8.8.8.8:5070"
        );
        assert_eq!(
            stored_key(&json!({ "ip": "8.8.8.8", "port": null })),
            "8.8.8.8:5060"
        );
        assert_eq!(ip("8.8.8.8", None).key(), "8.8.8.8:5060");
        assert_eq!(
            ip("1.1.1.1", Some(5070)).stored("ip-9"),
            json!({ "ip": "1.1.1.1", "port": 5070, "providerIpId": "ip-9" })
        );
        assert_eq!(
            ip("1.1.1.1", None).stored("ip-9"),
            json!({ "ip": "1.1.1.1", "providerIpId": "ip-9" })
        );
    }

    #[test]
    fn a_trunk_reads_like_the_workers_json() {
        let trunk = json!({
            "id": "strk_1",
            "createdAt": "2026-11-10T10:00:00.000Z",
            "updatedAt": "2026-11-10T10:00:00.000Z",
            "name": "Xelion",
            "provider": "xelion",
            "authMode": "ip",
            "transport": "tls",
            "status": "active",
            "ipAddresses": [
                { "ip": "8.8.8.8", "providerIpId": "ip-1" },
                { "ip": "1.1.1.1", "port": 5070, "providerIpId": "ip-2" },
            ],
            "sipUsername": null,
            "providerConnectionId": "ipc-1",
            "lastInboundAt": null,
            "lastError": null,
            "createdById": "user_1",
        });
        let number = json!({
            "id": "vpn_1",
            "phoneNumber": "+31201300001",
            "displayName": null,
            "status": "active",
            "allowOutbound": null,
            "callerIdVerifiedAt": null,
            "sipTrunkId": "strk_1",
        });
        let shown = trunk_json(Some(" sip.telnyx.eu "), &trunk, &[number]);
        assert_eq!(
            shown["ipAddresses"],
            json!([{ "ip": "8.8.8.8" }, { "ip": "1.1.1.1", "port": 5070 }])
        );
        assert_eq!(shown["connection"]["primaryHost"], "sip.telnyx.eu");
        assert_eq!(shown["connection"]["port"], 5061);
        assert_eq!(shown["connection"]["username"], Value::Null);
        assert_eq!(shown["connection"]["sipHosts"][1]["host"], "sip.telnyx.eu");
        assert_eq!(
            shown["connection"]["signalingIps"].as_array().map(Vec::len),
            Some(4)
        );
        assert_eq!(shown["numbers"][0]["allowOutbound"], false);
        assert!(shown.get("providerConnectionId").is_none());
        assert_eq!(
            trunk_json(Some("  "), &trunk, &[])["connection"]["primaryHost"],
            "sip.telnyx.com"
        );
    }

    #[test]
    fn a_refused_code_is_expired_or_wrong() {
        let api = |status: u16, detail: &str| TelnyxError::Api {
            message: format!("Telnyx API error: {status} - {detail}"),
            status,
        };
        let code = |error: &TelnyxError| confirmation_refusal(error).map(|f| code_of(&f));
        assert_eq!(
            code(&api(404, "No pending verification")),
            Some("code_expired")
        );
        assert_eq!(
            code(&api(422, "The code has EXPIRED")),
            Some("code_expired")
        );
        assert_eq!(
            code(&api(422, "Invalid verification code")),
            Some("wrong_code")
        );
        assert_eq!(code(&api(500, "Server error")), None);
        assert_eq!(code(&TelnyxError::Network("fetch failed".to_owned())), None);
    }
}
