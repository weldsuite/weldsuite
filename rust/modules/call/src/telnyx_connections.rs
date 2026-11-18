//! Telnyx connections for a customer's own phone system (SIP trunk / PBX),
//! and Verified Numbers for showing one of its numbers as caller id
//! (`lib/telnyx-connections.ts`, `lib/sip-trunk-constants.ts`).
//!
//! A trunk is an IP connection (the PBX's public IPs allow-listed) or a
//! credential connection (the PBX signs in). Both are created with
//! `call_parking_enabled`, so a call the PBX sends to Telnyx is parked and
//! driven by Call Control webhooks like any inbound call.

use serde_json::{Map, Value, json};

use crate::js;
use crate::telnyx::{Body, Telnyx, TelnyxError};

/// `DEFAULT_SIP_HOST`.
pub(crate) const DEFAULT_SIP_HOST: &str = "sip.telnyx.com";

/// `TELNYX_SIP_HOSTS`: where a PBX sends calls, per region.
pub(crate) const SIP_HOSTS: [(&str, &str); 2] = [("US", "sip.telnyx.com"), ("EU", "sip.telnyx.eu")];

/// `TELNYX_SIGNALING_IPS`: signalling IPs a PBX may need to allow-list.
/// Source: <https://sip.telnyx.com/voice.json>; last checked 2026-11-10.
pub(crate) const SIGNALING_IPS: [(&str, &str); 4] = [
    ("US", "192.76.120.10"),
    ("US", "64.16.250.10"),
    ("EU", "185.246.41.140"),
    ("EU", "185.246.41.141"),
];

/// `SIP_PORT_PLAIN`.
pub(crate) const SIP_PORT_PLAIN: u16 = 5060;
/// `SIP_PORT_TLS`.
pub(crate) const SIP_PORT_TLS: u16 = 5061;

/// `SIP_TRANSPORT_TO_TELNYX[transport]`.
fn telnyx_transport(transport: &str) -> Option<&'static str> {
    match transport {
        "udp" => Some("UDP"),
        "tcp" => Some("TCP"),
        "tls" => Some("TLS"),
        _ => None,
    }
}

/// What both connection kinds are created with.
pub(crate) struct ConnectionBase<'a> {
    pub(crate) name: &'a str,
    /// `telnyxWebhookUrl(env)`: where Telnyx sends the connection's call
    /// events (call-api's own host).
    pub(crate) webhook_url: &'a str,
    /// `TELNYX_OUTBOUND_VOICE_PROFILE_ID`, when one is configured.
    pub(crate) outbound_voice_profile_id: Option<&'a str>,
}

impl ConnectionBase<'_> {
    /// `connectionBase(env, name, true)`: the webhook and call parking (plus
    /// the optional voice profile).
    fn body(&self) -> Map<String, Value> {
        let mut outbound = Map::new();
        outbound.insert("call_parking_enabled".to_owned(), json!(true));
        if let Some(profile) = self.outbound_voice_profile_id {
            outbound.insert("outbound_voice_profile_id".to_owned(), json!(profile));
        }
        let mut body = Map::new();
        body.insert("connection_name".to_owned(), json!(self.name));
        body.insert("active".to_owned(), json!(true));
        body.insert("webhook_event_url".to_owned(), json!(self.webhook_url));
        body.insert("webhook_api_version".to_owned(), json!("2"));
        body.insert("outbound".to_owned(), Value::Object(outbound));
        body
    }
}

/// `telnyxUpdateIpConnection` / `telnyxUpdateCredentialConnection`'s patch:
/// what is left out is not sent.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ConnectionPatch<'a> {
    pub(crate) name: Option<&'a str>,
    /// An IP connection's transport (`udp`, `tcp`, `tls`).
    pub(crate) transport: Option<&'a str>,
    /// A credential connection's new password.
    pub(crate) password: Option<&'a str>,
    pub(crate) active: Option<bool>,
}

/// `requireId(res, what)`.
fn require_id(response: &Value, missing: &'static str) -> Result<String, TelnyxError> {
    let id = &response["data"]["id"];
    if js::truthy(id) {
        Ok(js::string(id))
    } else {
        Err(TelnyxError::Unexpected(missing))
    }
}

impl Telnyx {
    async fn post(&self, path: &str, body: Value) -> Result<Value, TelnyxError> {
        self.request("POST", path, Some(Body::Json(body))).await
    }

    async fn patch(&self, path: &str, body: Value) -> Result<(), TelnyxError> {
        self.request("PATCH", path, Some(Body::Json(body)))
            .await
            .map(|_| ())
    }

    async fn delete(&self, path: &str) -> Result<(), TelnyxError> {
        self.request("DELETE", path, None).await.map(|_| ())
    }

    // ── IP connection ───────────────────────────────────────────────────────

    /// `telnyxCreateIpConnection(env, { name, transport })`: the new
    /// connection's id.
    pub(crate) async fn create_ip_connection(
        &self,
        base: &ConnectionBase<'_>,
        transport: &str,
    ) -> Result<String, TelnyxError> {
        let mut body = base.body();
        if let Some(protocol) = telnyx_transport(transport) {
            body.insert("transport_protocol".to_owned(), json!(protocol));
        }
        let response = self.post("/ip_connections", Value::Object(body)).await?;
        require_id(
            &response,
            "Telnyx did not return an id for the IP connection",
        )
    }

    /// `telnyxUpdateIpConnection(env, id, { name, transport, active })`.
    pub(crate) async fn update_ip_connection(
        &self,
        id: &str,
        patch: ConnectionPatch<'_>,
    ) -> Result<(), TelnyxError> {
        let mut body = Map::new();
        if let Some(name) = patch.name {
            body.insert("connection_name".to_owned(), json!(name));
        }
        if let Some(protocol) = patch.transport.and_then(telnyx_transport) {
            body.insert("transport_protocol".to_owned(), json!(protocol));
        }
        if let Some(active) = patch.active {
            body.insert("active".to_owned(), json!(active));
        }
        self.patch(
            &format!("/ip_connections/{}", js::encode_uri_component(id)),
            Value::Object(body),
        )
        .await
    }

    /// `telnyxDeleteIpConnection(env, id)`.
    pub(crate) async fn delete_ip_connection(&self, id: &str) -> Result<(), TelnyxError> {
        self.delete(&format!("/ip_connections/{}", js::encode_uri_component(id)))
            .await
    }

    /// `telnyxCreateIp(env, { connectionId, ip, port })`: the id of the
    /// allow-listed address (port 5060 when none is given).
    pub(crate) async fn create_ip(
        &self,
        connection_id: &str,
        ip: &str,
        port: Option<i64>,
    ) -> Result<String, TelnyxError> {
        let body = json!({
            "connection_id": connection_id,
            "ip_address": ip,
            "port": port.unwrap_or(i64::from(SIP_PORT_PLAIN)),
        });
        let response = self.post("/ips", body).await?;
        require_id(&response, "Telnyx did not return an id for the IP address")
    }

    /// `telnyxDeleteIp(env, id)`.
    pub(crate) async fn delete_ip(&self, id: &str) -> Result<(), TelnyxError> {
        self.delete(&format!("/ips/{}", js::encode_uri_component(id)))
            .await
    }

    // ── Credential connection ───────────────────────────────────────────────

    /// `telnyxCreateCredentialConnection(env, { name, username, password })`:
    /// the new connection's id.
    pub(crate) async fn create_credential_connection(
        &self,
        base: &ConnectionBase<'_>,
        username: &str,
        password: &str,
    ) -> Result<String, TelnyxError> {
        let mut body = base.body();
        body.insert("user_name".to_owned(), json!(username));
        body.insert("password".to_owned(), json!(password));
        let response = self
            .post("/credential_connections", Value::Object(body))
            .await?;
        require_id(
            &response,
            "Telnyx did not return an id for the credential connection",
        )
    }

    /// `telnyxUpdateCredentialConnection(env, id, { name, password, active })`.
    pub(crate) async fn update_credential_connection(
        &self,
        id: &str,
        patch: ConnectionPatch<'_>,
    ) -> Result<(), TelnyxError> {
        let mut body = Map::new();
        if let Some(name) = patch.name {
            body.insert("connection_name".to_owned(), json!(name));
        }
        if let Some(password) = patch.password {
            body.insert("password".to_owned(), json!(password));
        }
        if let Some(active) = patch.active {
            body.insert("active".to_owned(), json!(active));
        }
        self.patch(
            &format!("/credential_connections/{}", js::encode_uri_component(id)),
            Value::Object(body),
        )
        .await
    }

    /// `telnyxDeleteCredentialConnection(env, id)`.
    pub(crate) async fn delete_credential_connection(&self, id: &str) -> Result<(), TelnyxError> {
        self.delete(&format!(
            "/credential_connections/{}",
            js::encode_uri_component(id)
        ))
        .await
    }

    // ── Verified numbers (caller id) ────────────────────────────────────────

    /// `telnyxRequestNumberVerification(env, phoneNumber, method)`: Telnyx
    /// sends a code to the number by `sms` or `call`.
    pub(crate) async fn request_number_verification(
        &self,
        phone_number: &str,
        method: &str,
    ) -> Result<(), TelnyxError> {
        self.post(
            "/verified_numbers",
            json!({ "phone_number": phone_number, "verification_method": method }),
        )
        .await
        .map(|_| ())
    }

    /// `telnyxConfirmNumberVerification(env, phoneNumber, code)`.
    pub(crate) async fn confirm_number_verification(
        &self,
        phone_number: &str,
        code: &str,
    ) -> Result<(), TelnyxError> {
        self.post(
            &format!(
                "/verified_numbers/{}/actions/verify",
                js::encode_uri_component(phone_number)
            ),
            json!({ "verification_code": code }),
        )
        .await
        .map(|_| ())
    }

    /// `telnyxDeleteVerifiedNumber(env, phoneNumber)`.
    pub(crate) async fn delete_verified_number(
        &self,
        phone_number: &str,
    ) -> Result<(), TelnyxError> {
        self.delete(&format!(
            "/verified_numbers/{}",
            js::encode_uri_component(phone_number)
        ))
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connection_is_created_parked_with_the_webhook() {
        let base = ConnectionBase {
            name: "Xelion",
            webhook_url: "https://call-api-test.weldsuite.org/public/webhooks/telnyx",
            outbound_voice_profile_id: None,
        };
        assert_eq!(
            Value::Object(base.body()),
            json!({
                "connection_name": "Xelion",
                "active": true,
                "webhook_event_url": "https://call-api-test.weldsuite.org/public/webhooks/telnyx",
                "webhook_api_version": "2",
                "outbound": { "call_parking_enabled": true },
            })
        );
        let with_profile = ConnectionBase {
            outbound_voice_profile_id: Some("ovp-1"),
            ..base
        };
        assert_eq!(
            with_profile.body()["outbound"],
            json!({ "call_parking_enabled": true, "outbound_voice_profile_id": "ovp-1" })
        );
        assert_eq!(telnyx_transport("tls"), Some("TLS"));
        assert_eq!(telnyx_transport("ws"), None);
    }

    #[test]
    fn an_answer_without_an_id_is_refused() {
        assert_eq!(
            require_id(&json!({ "data": { "id": "ipc-1" } }), "none").expect("id"),
            "ipc-1"
        );
        assert!(require_id(&json!({ "data": {} }), "none").is_err());
        assert!(require_id(&json!({}), "none").is_err());
    }
}
