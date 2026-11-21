//! `POST /internal/panel/usage/settle` (`src/internal.ts`): a workspace's
//! counts for a month in, the quota state out ([`settle_usage`]). On Global
//! the `PanelUsage` Durable Objects call it about every five minutes over a
//! service binding, on panel-api's `PanelApiInternal` entrypoint, which no
//! URL on the public host reaches.
//!
//! Here the job that does what those objects do settles in process
//! (`weldsuite cron panel-usage`, [`crate::usage_sweep`]), so the server
//! keeps the route off its listener, as it does the read API
//! ([`crate::internal_v1_router`]); conformance builds mount it for
//! panel-api's tests.
//!
//! Answers as `internalApp` does: 400 `VALIDATION_ERROR` for anything that
//! isn't a settlement, 404 for an unknown workspace,
//! `{ month, events, recordings, quota }` otherwise, and 500
//! `INTERNAL_ERROR` "Something went wrong" for a failure.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::StatusCode;
use serde_json::{Value, json};
use weldsuite_db::MasterDb;
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_panel_domain::js;
use weldsuite_ports::RequestCache;

use crate::PanelState;
use crate::public_share::RequestWorkspaceTenants;
use crate::usage_mail::{MailNotices, NoticeSender};
use crate::usage_settlement::{Settlement, SettlementInput, settle_usage};

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
/// More than any settlement needs.
const BODY_LIMIT: usize = 64 * 1024;

/// `/internal/panel/usage`, relative to its prefix.
pub fn internal_usage_router<S>(state: PanelState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/settle", post(settle))
        .with_state(state)
}

/// `MONTH`: `^\d{4}-(0[1-9]|1[0-2])$`.
fn is_month(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 7
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && matches!(
            (bytes[5], bytes[6]),
            (b'0', b'1'..=b'9') | (b'1', b'0'..=b'2')
        )
}

/// `z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)`.
#[allow(
    clippy::cast_possible_truncation,
    reason = "a whole number inside the safe integers"
)]
fn whole_count(value: Option<&Value>) -> Option<i64> {
    let n = value?.as_f64()?;
    (n.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&n)).then_some(n as i64)
}

/// `settleSchema.safeParse(body)`: the settlement, or `None` for anything
/// else (bad JSON included).
fn parse_settlement(body: &[u8]) -> Option<SettlementInput> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let fields = value.as_object()?;
    let workspace_id = fields.get("workspaceId")?.as_str()?;
    let length = js::utf16_len(workspace_id);
    if !(1..=255).contains(&length) {
        return None;
    }
    let month = fields.get("month")?.as_str()?;
    if !is_month(month) {
        return None;
    }
    Some(SettlementInput {
        workspace_id: workspace_id.to_owned(),
        month: month.to_owned(),
        events: whole_count(fields.get("events"))?,
        recordings: whole_count(fields.get("recordings"))?,
    })
}

/// `internalApp.onError`.
fn failed(error: &dyn std::fmt::Display) -> Response {
    tracing::error!(%error, "[panel-api] internal POST /internal/panel/usage/settle failed");
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL_ERROR",
        "Something went wrong",
    )
    .into_response()
}

async fn settle(State(state): State<PanelState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let extensions = &parts.extensions;
    // The test's bindings in conformance builds, else the server's.
    let env = extensions.get::<RequestEnv>().cloned();
    let conformance = env.is_some();
    let master = match extensions.get::<MasterDb>() {
        Some(master) => Some(master.0.clone()),
        None if conformance => None,
        None => state.master.clone(),
    };
    let cache = match extensions.get::<RequestCache>() {
        Some(cache) => Some(Arc::clone(&cache.0)),
        None if conformance => None,
        None => state.cache.clone(),
    };
    let tenants = extensions
        .get::<RequestWorkspaceTenants>()
        .map(|tenants| Arc::clone(&tenants.0))
        .or_else(|| state.tenants.clone());

    let input = match axum::body::to_bytes(body, BODY_LIMIT).await {
        Ok(bytes) => parse_settlement(&bytes),
        Err(_) => None,
    };
    let Some(input) = input else {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            "VALIDATION_ERROR",
            "Invalid settlement",
        )
        .into_response();
    };
    let Some(master) = master else {
        return failed(&"no master database");
    };
    // The test's clock when it fakes one (`CONFORMANCE_NOW`), else the real one.
    let now = env
        .as_ref()
        .and_then(|env| env.get("CONFORMANCE_NOW"))
        .and_then(js::parse_iso)
        .unwrap_or_else(js::now_millis);
    let settlement = Settlement {
        master: &master,
        cache: cache.as_ref(),
        now,
        bill: state.bill_overage,
    };
    let settled = match settle_usage(&settlement, &input).await {
        Ok(Some(settled)) => settled,
        Ok(None) => {
            return ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Unknown workspace")
                .into_response();
        }
        Err(error) => return failed(&error),
    };
    // `notify`: the owners are mailed where the server has mail (conformance
    // builds have none, as the worker's tests bind no `SEND_EMAIL`).
    if let (Some(notice), Some(transport), Some(tenants)) =
        (&settled.notice, state.mail.clone(), tenants)
    {
        let sender = MailNotices {
            transport,
            tenants,
            platform_url: std::env::var("PLATFORM_URL").ok(),
        };
        sender.send(notice).await;
    }
    axum::Json(json!({
        "month": settled.month,
        "events": settled.usage.events,
        "recordings": settled.usage.recordings,
        "quota": settled.quota,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn months_are_checked_like_the_schema() {
        for month in ["2026-01", "2026-09", "2026-10", "2026-12", "0000-11"] {
            assert!(is_month(month), "{month}");
        }
        for month in [
            "2026-00",
            "2026-13",
            "2026-1",
            "26-11",
            "2026/11",
            "2026-11-01",
            "٢٠٢٦-11",
        ] {
            assert!(!is_month(month), "{month}");
        }
    }

    #[test]
    fn only_a_settlement_passes() {
        let ok = parse_settlement(
            br#"{"workspaceId":"ws_1","month":"2026-11","events":55001,"recordings":4.0,"extra":true}"#,
        )
        .expect("a settlement");
        assert_eq!((ok.events, ok.recordings), (55_001, 4));
        for body in [
            &b"{}"[..],
            br#"{"workspaceId":"ws_1","month":"2026-13","events":1,"recordings":1}"#,
            br#"{"workspaceId":"ws_1","month":"2026-11","events":-1,"recordings":1}"#,
            br#"{"workspaceId":"ws_1","month":"2026-11","events":1.5,"recordings":1}"#,
            br#"{"workspaceId":"","month":"2026-11","events":1,"recordings":1}"#,
            br#"{"workspaceId":"ws_1","month":"2026-11","events":9007199254740993,"recordings":1}"#,
            br#"{"workspaceId":"ws_1","month":"2026-11","events":"1","recordings":1}"#,
            b"[]",
            b"not json",
        ] {
            assert!(
                parse_settlement(body).is_none(),
                "{}",
                String::from_utf8_lossy(body)
            );
        }
        let long = format!(
            r#"{{"workspaceId":"{}","month":"2026-11","events":1,"recordings":1}}"#,
            "w".repeat(256)
        );
        assert!(parse_settlement(long.as_bytes()).is_none());
    }
}
