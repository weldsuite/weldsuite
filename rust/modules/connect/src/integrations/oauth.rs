//! `services/integrations/oauth-providers.ts`: the OAuth and
//! webhook-registration side of the CRM sync providers (Attio, `HubSpot`,
//! Google Calendar). The record sync itself is the `CRM_SYNC` Workflow
//! (integration-webhook-worker's `CrmSyncWorkflow`), which these routes only
//! start. Every call goes out through the outbound HTTP port.

use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp};

const ATTIO_AUTHORIZE_URL: &str = "https://app.attio.com/authorize";
const ATTIO_TOKEN_URL: &str = "https://app.attio.com/oauth/token";
const ATTIO_API_BASE: &str = "https://api.attio.com/v2";
const HUBSPOT_AUTHORIZE_URL: &str = "https://app.hubspot.com/oauth/authorize";
const HUBSPOT_TOKEN_URL: &str = "https://api.hubapi.com/oauth/v1/token";
const GOOGLE_AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const CALENDAR_API_BASE: &str = "https://www.googleapis.com/calendar/v3";
const GOOGLE_SCOPES: &str =
    "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email";
const HUBSPOT_SCOPES: &str = "crm.objects.contacts.read crm.objects.contacts.write crm.objects.companies.read crm.objects.companies.write crm.objects.deals.read crm.objects.deals.write crm.schemas.deals.read";

/// A provider with an OAuth adapter (`getOAuthAdapter`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Provider {
    Attio,
    Hubspot,
    GoogleCalendar,
}

/// `OAuthTokens`: absent fields stay out of the stored JSON.
#[derive(Debug, Clone, Default)]
pub(crate) struct Tokens {
    pub(crate) access_token: Option<String>,
    pub(crate) refresh_token: Option<String>,
    pub(crate) expires_at: Option<String>,
    pub(crate) token_type: Option<String>,
}

impl Tokens {
    pub(crate) fn to_json(&self) -> Value {
        let mut out = serde_json::Map::new();
        let mut put = |key: &str, value: &Option<String>| {
            if let Some(value) = value {
                out.insert(key.to_owned(), json!(value));
            }
        };
        put("accessToken", &self.access_token);
        put("refreshToken", &self.refresh_token);
        put("expiresAt", &self.expires_at);
        put("tokenType", &self.token_type);
        Value::Object(out)
    }

    /// `tokens.accessToken` where a header interpolates it.
    pub(crate) fn bearer(&self) -> &str {
        self.access_token.as_deref().unwrap_or("undefined")
    }
}

/// `WebhookRegistration`.
#[derive(Debug, Clone)]
pub(crate) struct Registration {
    pub(crate) webhook_id: String,
    pub(crate) secret: String,
}

/// A failed provider call: the message `err.message` carries.
pub(crate) type CallError = String;

impl Provider {
    /// `getOAuthAdapter(provider)` / `hasOAuthAdapter(provider)`.
    pub(crate) fn of(provider: &str) -> Option<Self> {
        match provider {
            "attio" => Some(Self::Attio),
            "hubspot" => Some(Self::Hubspot),
            "google_calendar" => Some(Self::GoogleCalendar),
            _ => None,
        }
    }

    /// `adapter.supportedEntities`.
    pub(crate) fn supported_entities(self) -> &'static [&'static str] {
        match self {
            Self::Attio => &["customer", "contact"],
            Self::Hubspot => &["contact", "customer", "opportunity"],
            Self::GoogleCalendar => &["calendar_event"],
        }
    }

    /// `adapter.getDefaultFieldMappings(entityType)`.
    pub(crate) fn default_field_mappings(self, entity_type: &str) -> Vec<Value> {
        let direct = |external: &str, internal: &str, direction: &str| {
            json!({
                "externalFieldPath": external,
                "internalFieldPath": internal,
                "direction": direction,
                "transformType": "direct",
            })
        };
        let required = |mut mapping: Value| {
            mapping["isRequired"] = json!(true);
            mapping
        };
        match (self, entity_type) {
            (Self::Attio, "customer") => vec![
                direct("companyName", "companyName", "inbound"),
                required(direct("email", "email", "inbound")),
                direct("website", "website", "inbound"),
                direct("phone", "phone", "inbound"),
                direct("notes", "notes", "inbound"),
                direct("tags", "tags", "inbound"),
                direct("type", "type", "inbound"),
                direct("status", "status", "inbound"),
                direct("source", "source", "inbound"),
            ],
            (Self::Attio, "contact") => vec![
                direct("firstName", "firstName", "inbound"),
                direct("lastName", "lastName", "inbound"),
                direct("fullName", "fullName", "inbound"),
                required(direct("email", "email", "inbound")),
                direct("phone", "directPhone", "inbound"),
                direct("title", "title", "inbound"),
                direct("status", "status", "inbound"),
            ],
            (Self::Hubspot, "contact") => vec![
                direct("properties.firstname", "firstName", "bidirectional"),
                direct("properties.lastname", "lastName", "bidirectional"),
                required(direct("properties.email", "email", "bidirectional")),
                direct("properties.phone", "directPhone", "bidirectional"),
                direct("properties.mobilephone", "mobile", "bidirectional"),
                direct("properties.jobtitle", "title", "bidirectional"),
                json!({
                    "externalFieldPath": "properties.lifecyclestage",
                    "internalFieldPath": "status",
                    "direction": "inbound",
                    "transformType": "lookup",
                    "transformConfig": { "lookupTable": {
                        "subscriber": "active",
                        "lead": "active",
                        "marketingqualifiedlead": "active",
                        "salesqualifiedlead": "active",
                        "opportunity": "active",
                        "customer": "active",
                        "evangelist": "active",
                        "other": "active",
                    } },
                }),
            ],
            (Self::Hubspot, "customer") => vec![
                required(direct("properties.name", "companyName", "bidirectional")),
                direct("properties.domain", "website", "bidirectional"),
                direct("properties.phone", "phone", "bidirectional"),
                direct("properties.industry", "industry", "bidirectional"),
                direct("properties.description", "notes", "bidirectional"),
                direct("properties.address", "billingAddress", "inbound"),
                direct("properties.city", "billingCity", "inbound"),
                direct("properties.country", "billingCountry", "inbound"),
            ],
            (Self::Hubspot, "opportunity") => vec![
                required(direct("properties.dealname", "name", "bidirectional")),
                direct("properties.amount", "amount", "bidirectional"),
                direct("properties.deal_currency_code", "currency", "bidirectional"),
                json!({
                    "externalFieldPath": "properties.closedate",
                    "internalFieldPath": "closeDate",
                    "direction": "bidirectional",
                    "transformType": "format_date",
                }),
                json!({
                    "externalFieldPath": "properties.dealstage",
                    "internalFieldPath": "stage",
                    "direction": "bidirectional",
                    "transformType": "lookup",
                    "transformConfig": { "lookupTable": {
                        "appointmentscheduled": "prospecting",
                        "qualifiedtobuy": "qualification",
                        "presentationscheduled": "needs_analysis",
                        "decisionmakerboughtin": "proposal",
                        "contractsent": "negotiation",
                        "closedwon": "closed_won",
                        "closedlost": "closed_lost",
                    } },
                }),
                direct("properties.description", "description", "bidirectional"),
                direct("properties.pipeline", "pipeline", "inbound"),
            ],
            _ => Vec::new(),
        }
    }

    /// `adapter.getAuthorizeUrl(clientId, redirectUri, state)`.
    pub(crate) fn authorize_url(self, client_id: &str, redirect_uri: &str, state: &str) -> String {
        let mut params = url::form_urlencoded::Serializer::new(String::new());
        let base = match self {
            // Attio's scopes live on the OAuth app, never in the URL.
            Self::Attio => {
                params
                    .append_pair("client_id", client_id)
                    .append_pair("response_type", "code")
                    .append_pair("redirect_uri", redirect_uri)
                    .append_pair("state", state);
                ATTIO_AUTHORIZE_URL
            }
            Self::Hubspot => {
                params
                    .append_pair("client_id", client_id)
                    .append_pair("redirect_uri", redirect_uri)
                    .append_pair("scope", HUBSPOT_SCOPES)
                    .append_pair("state", state);
                HUBSPOT_AUTHORIZE_URL
            }
            Self::GoogleCalendar => {
                params
                    .append_pair("client_id", client_id)
                    .append_pair("response_type", "code")
                    .append_pair("redirect_uri", redirect_uri)
                    .append_pair("state", state)
                    .append_pair("scope", GOOGLE_SCOPES)
                    .append_pair("access_type", "offline")
                    .append_pair("prompt", "consent");
                GOOGLE_AUTHORIZE_URL
            }
        };
        format!("{base}?{}", params.finish())
    }

    fn token_url(self) -> &'static str {
        match self {
            Self::Attio => ATTIO_TOKEN_URL,
            Self::Hubspot => HUBSPOT_TOKEN_URL,
            Self::GoogleCalendar => GOOGLE_TOKEN_URL,
        }
    }

    /// The name a failed token call reports.
    fn label(self) -> &'static str {
        match self {
            Self::Attio => "Attio",
            Self::Hubspot => "HubSpot",
            Self::GoogleCalendar => "Google",
        }
    }

    /// `adapter.exchangeCodeForTokens(clientId, clientSecret, code, redirectUri)`.
    pub(crate) async fn exchange_code(
        self,
        http: &OutboundHttp,
        client_id: &str,
        client_secret: &str,
        code: &str,
        redirect_uri: &str,
    ) -> Result<Tokens, CallError> {
        let form = {
            let mut form = url::form_urlencoded::Serializer::new(String::new());
            match self {
                Self::Hubspot => form
                    .append_pair("grant_type", "authorization_code")
                    .append_pair("client_id", client_id)
                    .append_pair("client_secret", client_secret)
                    .append_pair("redirect_uri", redirect_uri)
                    .append_pair("code", code),
                Self::Attio | Self::GoogleCalendar => form
                    .append_pair("client_id", client_id)
                    .append_pair("client_secret", client_secret)
                    .append_pair("code", code)
                    .append_pair("redirect_uri", redirect_uri)
                    .append_pair("grant_type", "authorization_code"),
            };
            form.finish()
        };
        let response = post_form(http, self.token_url(), form).await?;
        if !response.ok() {
            return Err(self.token_failure("token exchange", &response));
        }
        let data = parse_json(&response)?;
        let now = OffsetDateTime::now_utc();
        Ok(Tokens {
            access_token: text(&data, "access_token"),
            refresh_token: text(&data, "refresh_token"),
            expires_at: match self {
                // `new Date(Date.now() + expires_in * 1000)`, whatever expires_in is.
                Self::Hubspot => Some(expiry(now, data.get("expires_in"))?),
                _ => optional_expiry(now, data.get("expires_in"))?,
            },
            token_type: Some(token_type(&data)),
        })
    }

    /// `adapter.refreshAccessToken(clientId, clientSecret, refreshToken)`.
    pub(crate) async fn refresh(
        self,
        http: &OutboundHttp,
        client_id: &str,
        client_secret: &str,
        refresh_token: &str,
    ) -> Result<Tokens, CallError> {
        let form = {
            let mut form = url::form_urlencoded::Serializer::new(String::new());
            match self {
                Self::Hubspot => form
                    .append_pair("grant_type", "refresh_token")
                    .append_pair("client_id", client_id)
                    .append_pair("client_secret", client_secret)
                    .append_pair("refresh_token", refresh_token),
                Self::Attio | Self::GoogleCalendar => form
                    .append_pair("client_id", client_id)
                    .append_pair("client_secret", client_secret)
                    .append_pair("refresh_token", refresh_token)
                    .append_pair("grant_type", "refresh_token"),
            };
            form.finish()
        };
        let response = post_form(http, self.token_url(), form).await?;
        if !response.ok() {
            return Err(self.token_failure("token refresh", &response));
        }
        let data = parse_json(&response)?;
        let now = OffsetDateTime::now_utc();
        let refreshed = match self {
            // Google keeps the refresh token it was given.
            Self::GoogleCalendar => Some(refresh_token.to_owned()),
            _ => text(&data, "refresh_token")
                .filter(|t| !t.is_empty())
                .or_else(|| Some(refresh_token.to_owned())),
        };
        Ok(Tokens {
            access_token: text(&data, "access_token"),
            refresh_token: refreshed,
            expires_at: match self {
                Self::Hubspot => Some(expiry(now, data.get("expires_in"))?),
                _ => optional_expiry(now, data.get("expires_in"))?,
            },
            token_type: Some(token_type(&data)),
        })
    }

    /// `Attio token exchange failed (400): …` / `Google token exchange failed: 400 …`.
    fn token_failure(self, what: &str, response: &HttpResponse) -> CallError {
        match self {
            Self::GoogleCalendar => format!(
                "{} {what} failed: {} {}",
                self.label(),
                response.status,
                response.text()
            ),
            _ => format!(
                "{} {what} failed ({}): {}",
                self.label(),
                response.status,
                response.text()
            ),
        }
    }

    /// `adapter.registerWebhooks(accessToken, targetUrl, supportedEntities)`.
    pub(crate) async fn register_webhooks(
        self,
        http: &OutboundHttp,
        access_token: &str,
        target_url: &str,
    ) -> Result<Registration, CallError> {
        match self {
            Self::Attio => {
                let subscriptions: Vec<Value> = [
                    "record.created",
                    "record.updated",
                    "record.deleted",
                    "record.merged",
                    "note.created",
                    "note.updated",
                    "note.deleted",
                    "task.created",
                    "task.updated",
                    "task.deleted",
                    "list-entry.created",
                    "list-entry.updated",
                    "list-entry.deleted",
                ]
                .iter()
                .map(|event| json!({ "event_type": event, "filter": null }))
                .collect();
                let request = HttpRequest::json(
                    "POST",
                    format!("{ATTIO_API_BASE}/webhooks"),
                    &json!({ "data": { "target_url": target_url, "subscriptions": subscriptions } }),
                )
                .header("Authorization", format!("Bearer {access_token}"));
                let response = send(http, request).await?;
                if !response.ok() {
                    return Err(format!(
                        "Attio webhook registration failed ({}): {}",
                        response.status,
                        response.text()
                    ));
                }
                let data = parse_json(&response)?;
                Ok(Registration {
                    webhook_id: crate::js::js_string(data["data"]["id"].get("webhook_id")),
                    secret: crate::js::js_string(data["data"].get("secret")),
                })
            }
            // Configured in HubSpot's app dashboard; the connection keeps the
            // client secret for signature checks instead.
            Self::Hubspot => Ok(Registration {
                webhook_id: "hubspot-app-webhook".to_owned(),
                secret: String::new(),
            }),
            Self::GoogleCalendar => {
                let channel_id = super::uuid();
                let token = super::uuid();
                let request = HttpRequest::json(
                    "POST",
                    format!("{CALENDAR_API_BASE}/calendars/primary/events/watch"),
                    &json!({
                        "id": channel_id,
                        "type": "web_hook",
                        "address": target_url,
                        "token": token,
                        "params": { "ttl": "604800" },
                    }),
                )
                .header("Authorization", format!("Bearer {access_token}"));
                let response = send(http, request).await?;
                if !response.ok() {
                    return Err(format!(
                        "Google watch registration failed: {} {}",
                        response.status,
                        response.text()
                    ));
                }
                let data = parse_json(&response)?;
                // `JSON.stringify({ token, resourceId, expiration })`.
                let mut secret = format!("{{\"token\":{}", json!(token));
                for key in ["resourceId", "expiration"] {
                    if let Some(value) = data.get(key) {
                        secret.push(',');
                        secret.push_str(&json!(key).to_string());
                        secret.push(':');
                        secret.push_str(&value.to_string());
                    }
                }
                secret.push('}');
                Ok(Registration {
                    webhook_id: crate::js::js_string(data.get("id")),
                    secret,
                })
            }
        }
    }

    /// `adapter.deleteWebhooks(accessToken, webhookId, webhookSecret)`.
    pub(crate) async fn delete_webhooks(
        self,
        http: &OutboundHttp,
        access_token: &str,
        webhook_id: &str,
        webhook_secret: Option<&str>,
    ) -> Result<(), CallError> {
        match self {
            Self::Attio => {
                let request =
                    HttpRequest::empty("DELETE", format!("{ATTIO_API_BASE}/webhooks/{webhook_id}"))
                        .header("Authorization", format!("Bearer {access_token}"));
                let response = send(http, request).await?;
                if !response.ok() && response.status != 404 {
                    return Err(format!(
                        "Attio webhook deletion failed ({}): {}",
                        response.status,
                        response.text()
                    ));
                }
                Ok(())
            }
            Self::Hubspot => Ok(()),
            Self::GoogleCalendar => {
                let resource_id = webhook_secret
                    .filter(|s| !s.is_empty())
                    .and_then(|s| serde_json::from_str::<Value>(s).ok())
                    .map_or_else(
                        || json!(webhook_id),
                        |parsed| parsed.get("resourceId").cloned().unwrap_or(Value::Null),
                    );
                let mut body = serde_json::Map::new();
                body.insert("id".to_owned(), json!(webhook_id));
                if !resource_id.is_null() || webhook_secret.is_none() {
                    body.insert("resourceId".to_owned(), resource_id);
                }
                let request = HttpRequest::json(
                    "POST",
                    format!("{CALENDAR_API_BASE}/channels/stop"),
                    &Value::Object(body),
                )
                .header("Authorization", format!("Bearer {access_token}"));
                let response = send(http, request).await?;
                if !response.ok() && response.status != 404 {
                    tracing::error!(
                        status = response.status,
                        "[Integrations/GoogleCalendar] Failed to stop watch channel"
                    );
                }
                Ok(())
            }
        }
    }
}

/// integration-webhook-worker's public host per environment
/// (`getWebhookWorkerUrl`), where providers deliver their webhooks.
pub(crate) fn webhook_worker_url(environment: Option<&str>) -> &'static str {
    match environment {
        Some("test") => "https://integration-webhooks-test.weldsuite.org",
        Some("preview") => "https://integration-webhooks-preview.weldsuite.org",
        Some("production") => "https://integration-webhooks.weldsuite.org",
        _ => "http://localhost:8790",
    }
}

/// `HubSpot`'s portal id for webhook routing (`fetchHubspotPortalId`): `None`
/// when it can't be read.
pub(crate) async fn hubspot_portal_id(http: &OutboundHttp, access_token: &str) -> Option<String> {
    let request = HttpRequest::empty(
        "GET",
        format!("https://api.hubapi.com/oauth/v1/access-tokens/{access_token}"),
    );
    let response = match http.send(request).await {
        Ok(response) if response.ok() => response,
        Ok(_) => return None,
        Err(error) => {
            tracing::warn!(%error, "[app-api/integrations] failed to get HubSpot portal ID");
            return None;
        }
    };
    let data = serde_json::from_slice::<Value>(&response.body).ok()?;
    match data.get("hub_id") {
        Some(Value::Number(n)) if n.as_f64() != Some(0.0) => {
            Some(crate::js::js_string(Some(&Value::Number(n.clone()))))
        }
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Bool(true)) => Some("true".to_owned()),
        _ => None,
    }
}

async fn send(http: &OutboundHttp, request: HttpRequest) -> Result<HttpResponse, CallError> {
    http.send(request).await.map_err(|error| error.to_string())
}

async fn post_form(
    http: &OutboundHttp,
    url: &str,
    form: String,
) -> Result<HttpResponse, CallError> {
    let mut request =
        HttpRequest::empty("POST", url).header("Content-Type", "application/x-www-form-urlencoded");
    request.body = Some(form.into_bytes());
    send(http, request).await
}

/// `await response.json()`.
fn parse_json(response: &HttpResponse) -> Result<Value, CallError> {
    serde_json::from_slice(&response.body).map_err(|error| error.to_string())
}

fn text(data: &Value, key: &str) -> Option<String> {
    match data.get(key) {
        None | Some(Value::Null) => None,
        Some(value) => Some(crate::js::js_string(Some(value))),
    }
}

/// `data.token_type || 'Bearer'`.
fn token_type(data: &Value) -> String {
    data.get("token_type")
        .filter(|value| crate::js::truthy(value))
        .map_or_else(
            || "Bearer".to_owned(),
            |value| crate::js::js_string(Some(value)),
        )
}

/// `data.expires_in ? new Date(Date.now() + expires_in * 1000).toISOString() : undefined`.
fn optional_expiry(
    now: OffsetDateTime,
    expires_in: Option<&Value>,
) -> Result<Option<String>, CallError> {
    match expires_in {
        Some(value) if crate::js::truthy(value) => expiry(now, Some(value)).map(Some),
        _ => Ok(None),
    }
}

/// `new Date(Date.now() + expires_in * 1000).toISOString()`; a value that
/// isn't a number is an invalid date, which `toISOString` throws on.
fn expiry(now: OffsetDateTime, expires_in: Option<&Value>) -> Result<String, CallError> {
    let seconds = weldsuite_kit::validation::js_number_of(expires_in);
    if !seconds.is_finite() {
        return Err("Invalid time value".to_owned());
    }
    #[allow(clippy::cast_possible_truncation)]
    let millis = (seconds * 1000.0) as i64;
    Ok(weldsuite_events::iso_timestamp(
        now + time::Duration::milliseconds(millis),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attio_authorize_url_has_no_scope() {
        let url = Provider::Attio.authorize_url("cid", "https://app.example.com/cb", "st");
        assert_eq!(
            url,
            "https://app.attio.com/authorize?client_id=cid&response_type=code&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb&state=st"
        );
    }

    #[test]
    fn hubspot_scopes_are_space_separated() {
        let url = Provider::Hubspot.authorize_url("cid", "https://x/cb", "st");
        assert!(url.contains("scope=crm.objects.contacts.read+crm.objects.contacts.write"));
    }

    #[test]
    fn default_mappings() {
        assert_eq!(Provider::Attio.default_field_mappings("customer").len(), 9);
        assert_eq!(
            Provider::Hubspot
                .default_field_mappings("opportunity")
                .len(),
            7
        );
        assert_eq!(
            Provider::GoogleCalendar
                .default_field_mappings("calendar_event")
                .len(),
            0
        );
    }
}
