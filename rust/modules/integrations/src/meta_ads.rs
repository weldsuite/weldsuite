//! WeldAds (`index.ts`'s `/webhooks/meta/ads` and integration-sync-worker's
//! `runAdSyncSweep`):
//!
//! - `GET /webhooks/meta/ads`: Meta's subscription handshake
//!   (`FACEBOOK_WEBHOOK_VERIFY_TOKEN`, default `weldsuite-meta-ads`);
//! - `POST /webhooks/meta/ads`: campaign, ad set and ad changes (signed with
//!   `FACEBOOK_APP_SECRET` when it is set), each handed to WeldConnect's
//!   internal `/api/integrations/ad-events` for the workspace the KV entry
//!   `adsconn:<account>` names;
//! - [`run_ad_sync_sweep`]: the master `ad_sync_index` rows whose metrics
//!   sync is due, each synced through WeldConnect's internal
//!   `/api/integrations/ad-connections/:id/sync?scope=full`
//!   (`weldsuite cron ad-sync`).

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use sha2::Sha256;
use weldsuite_core_domain::js::{Js, as_text, js_string};
use weldsuite_db::PgPool;

use crate::connect_internal::{ConnectCall, ConnectInternal};
use crate::crm::webhooks::secret_matches;
use crate::{IntegrationsState, PublicCtx};

/// How many due rows one tick takes (`.limit(100)`).
pub const AD_SYNC_SWEEP_LIMIT: i64 = 100;

pub(crate) fn router<S>(state: IntegrationsState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/webhooks/meta/ads", get(verify).post(receive))
        .with_state(state)
}

/// `c.text(text, status)`.
fn text(status: StatusCode, body: &str) -> Response {
    (
        status,
        [(http::header::CONTENT_TYPE, "text/plain; charset=UTF-8")],
        body.to_owned(),
    )
        .into_response()
}

fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    form_urlencoded::parse(query.unwrap_or_default().as_bytes())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

async fn verify(
    State(state): State<IntegrationsState>,
    ctx: PublicCtx,
    RawQuery(query): RawQuery,
) -> Response {
    let mode = query_param(query.as_deref(), "hub.mode");
    let token = query_param(query.as_deref(), "hub.verify_token");
    let challenge = query_param(query.as_deref(), "hub.challenge");
    let expected = ctx
        .env(&state, "FACEBOOK_WEBHOOK_VERIFY_TOKEN")
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "weldsuite-meta-ads".to_owned());
    match challenge.filter(|c| !c.is_empty()) {
        Some(challenge)
            if mode.as_deref() == Some("subscribe")
                && secret_matches(token.as_deref(), Some(&expected)) =>
        {
            text(StatusCode::OK, &challenge)
        }
        _ => text(StatusCode::FORBIDDEN, "Forbidden"),
    }
}

/// `verifyMetaWebhookSignature(body, header, appSecret)`.
///
/// # Panics
///
/// Never: HMAC takes a key of any length.
pub fn verify_signature(body: &[u8], header: Option<&str>, secret: &str) -> bool {
    use hmac::{KeyInit, Mac};
    let Some(expected) = header.and_then(|h| h.strip_prefix("sha256=")) else {
        return false;
    };
    let expected = expected.to_lowercase();
    let mut mac = hmac::Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("any key");
    mac.update(body);
    let actual = hex::encode(mac.finalize().into_bytes());
    actual.len() == expected.len()
        && actual
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// One `MetaWebhookChangeEvent`, as far as the route uses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdChange {
    pub platform_account_id: String,
    pub object_type: &'static str,
    pub object_id: Option<String>,
}

/// `String(x)` of a string or a number.
fn id_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        number @ Value::Number(_) => Some(js_string(&Js::from_jsonb(number))),
        _ => None,
    }
}

/// `parseMetaAdsWebhook(payload)`.
pub fn parse_changes(payload: &Value) -> Vec<AdChange> {
    let mut events = Vec::new();
    let entries = payload.get("entry").and_then(Value::as_array);
    for entry in entries.into_iter().flatten() {
        // `entry.id ? String(entry.id) : ''`
        let account = match entry.get("id") {
            Some(Value::Null | Value::Bool(false)) | None => String::new(),
            Some(Value::String(text)) => text.clone(),
            Some(Value::Number(n)) if n.as_f64() == Some(0.0) => String::new(),
            Some(other) => js_string(&Js::from_jsonb(other)),
        };
        if account.is_empty() {
            continue;
        }
        let changes = entry.get("changes").and_then(Value::as_array);
        for change in changes.into_iter().flatten() {
            let field = change
                .get("field")
                .filter(|f| !f.is_null())
                .map_or_else(|| "unknown".to_owned(), |f| js_string(&Js::from_jsonb(f)));
            let empty = Value::Object(Map::new());
            let value = change
                .get("value")
                .filter(|v| !v.is_null())
                .unwrap_or(&empty);
            let object_type = match field.as_str() {
                "campaigns" | "campaign" => "campaign",
                "adsets" | "adset" => "adset",
                "ads" | "ad" => "ad",
                _ => "unknown",
            };
            let object_id = ["campaign_id", "adset_id", "ad_id", "id"]
                .iter()
                .find_map(|key| id_text(value.get(*key)))
                .or_else(|| {
                    (field == "campaigns")
                        .then(|| value.get("id").filter(|v| !v.is_null()))
                        .flatten()
                        .map(|id| as_text(&Js::from_jsonb(id)))
                });
            events.push(AdChange {
                platform_account_id: account.clone(),
                object_type,
                object_id,
            });
        }
    }
    events
}

async fn receive(
    State(state): State<IntegrationsState>,
    ctx: PublicCtx,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let answer = |status: StatusCode, body: Value| (status, Json(body)).into_response();
    let Some(connect) = ctx.connect_internal(&state) else {
        tracing::error!("[Webhook/meta/ads] CONNECT_INTERNAL / APP_API binding missing");
        return answer(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "Ad ingest unavailable" }),
        );
    };
    if let Some(secret) = ctx
        .env(&state, "FACEBOOK_APP_SECRET")
        .filter(|s| !s.is_empty())
    {
        let header = headers
            .get("x-hub-signature-256")
            .and_then(|v| v.to_str().ok());
        if !verify_signature(&body, header, &secret) {
            return answer(
                StatusCode::UNAUTHORIZED,
                json!({ "error": "Invalid signature" }),
            );
        }
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
        return answer(StatusCode::BAD_REQUEST, json!({ "error": "Invalid JSON" }));
    };
    let cache = ctx.cache(&state);
    let mut responses = Vec::new();
    for event in parse_changes(&payload) {
        let account = event.platform_account_id.clone();
        let cached = match &cache {
            Some(cache) => match cache.get_boxed(&format!("adsconn:{account}")).await {
                Ok(value) => value,
                Err(error) => {
                    tracing::error!(%error, "[Webhook/meta/ads] Handler error");
                    return answer(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        json!({ "error": "Internal Server Error" }),
                    );
                }
            },
            None => None,
        };
        let Some(cached) = cached.filter(|c| !c.is_empty()) else {
            responses.push(json!({ "skipped": true, "platformAccountId": account }));
            continue;
        };
        let Ok(entry) = serde_json::from_str::<Value>(&cached) else {
            responses.push(
                json!({ "error": "Corrupt ad account mapping", "platformAccountId": account }),
            );
            continue;
        };
        let org = entry
            .get("clerkOrgId")
            .map_or_else(|| "undefined".to_owned(), |o| js_string(&Js::from_jsonb(o)));
        // `JSON.stringify({ platformAccountId, platformCampaignId, objectType })`,
        // in that order, without an `undefined` campaign.
        let call = ConnectCall::post(
            "/api/integrations/ad-events".to_owned(),
            "X-Workspace-Id",
            &org,
            Some(format!(
                "{{\"platformAccountId\":{},{}\"objectType\":{}}}",
                json!(account),
                event
                    .object_id
                    .as_ref()
                    .map(|id| format!("\"platformCampaignId\":{},", json!(id)))
                    .unwrap_or_default(),
                json!(event.object_type)
            )),
        );
        match connect.fetch(call).await {
            Ok(response) => responses.push(json!({
                "platformAccountId": account,
                "status": response.status,
            })),
            Err(error) => {
                // `fetchConnectInternal` threw: the app's `onError`.
                tracing::error!(%error, "[Webhook/meta/ads] ad-events forward threw");
                let mut body = Map::new();
                body.insert("error".to_owned(), json!("Internal Server Error"));
                if ctx.env(&state, "ENVIRONMENT").as_deref() != Some("production") {
                    body.insert("message".to_owned(), json!(error));
                }
                return answer(StatusCode::INTERNAL_SERVER_ERROR, Value::Object(body));
            }
        }
    }
    answer(
        StatusCode::OK,
        json!({ "data": { "processed": responses.len(), "responses": responses } }),
    )
}

/// What one tick of the ad sweep did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AdSweepResult {
    pub due: usize,
    pub triggered: usize,
}

/// `runAdSyncSweep(env, masterDb, now)`: the enabled `ad_sync_index` rows
/// whose metrics sync is due, synced through WeldConnect (which moves
/// `next_metrics_sync_at` on). Rows without a Clerk org are left alone.
pub async fn run_ad_sync_sweep(
    master: &PgPool,
    connect: &dyn ConnectInternal,
    now: time::OffsetDateTime,
) -> Result<AdSweepResult, sqlx::Error> {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "select connection_id, clerk_org_id from ad_sync_index
         where is_enabled = true and next_metrics_sync_at <= $1::timestamptz
         limit $2",
    )
    .bind(weldsuite_events::iso_timestamp(now))
    .bind(AD_SYNC_SWEEP_LIMIT)
    .fetch_all(master)
    .await?;
    let mut result = AdSweepResult {
        due: rows.len(),
        triggered: 0,
    };
    for (connection_id, org) in rows {
        let Some(org) = org.filter(|o| !o.is_empty()) else {
            continue;
        };
        let call = ConnectCall::post(
            format!("/api/integrations/ad-connections/{connection_id}/sync?scope=full"),
            "X-Workspace-Id",
            &org,
            None,
        );
        match connect.fetch(call).await {
            Ok(response) if response.ok() => {
                result.triggered += 1;
                tracing::info!(
                    "[IntegrationScheduler] Triggered WeldAds sync for connection {connection_id}"
                );
            }
            Ok(response) => tracing::error!(
                "[IntegrationScheduler] WeldAds sync failed for {connection_id}: {}",
                response.status
            ),
            Err(error) => tracing::error!(
                "[IntegrationScheduler] WeldAds sync error for {connection_id}: {error}"
            ),
        }
    }
    tracing::info!(
        "[IntegrationScheduler] WeldAds sweep done. Triggered: {}",
        result.triggered
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_parse_by_field() {
        let payload = json!({ "object": "ad_account", "entry": [
            { "id": "act_1", "changes": [
                { "field": "campaigns", "value": { "campaign_id": 42, "status": "PAUSED" } },
                { "field": "ads", "value": { "ad_id": "9" } },
                { "field": "other" },
            ]},
            { "changes": [{ "field": "ads" }] },
        ]});
        let events = parse_changes(&payload);
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].object_id.as_deref(), Some("42"));
        assert_eq!(events[0].object_type, "campaign");
        assert_eq!(events[1].object_type, "ad");
        assert_eq!(events[2].object_type, "unknown");
        assert_eq!(events[2].object_id, None);
    }

    #[test]
    fn signatures_are_lowercase_hex_hmacs() {
        use hmac::{KeyInit, Mac};
        let mut mac = hmac::Hmac::<Sha256>::new_from_slice(b"s").expect("key");
        mac.update(b"{}");
        let sum = hex::encode(mac.finalize().into_bytes()).to_uppercase();
        assert!(verify_signature(b"{}", Some(&format!("sha256={sum}")), "s"));
        assert!(!verify_signature(b"{}", Some(&sum), "s"));
    }
}
