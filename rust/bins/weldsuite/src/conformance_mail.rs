//! Conformance mode's customer mail and outbound ledgers: the
//! [`MailTransport`] as the test's `SEND_EMAIL` stub and the
//! [`OutboundLedger`] / [`PlatformBudget`] as its `OUTBOUND_LEDGER` /
//! `OUTBOUND_PLATFORM` namespaces, through the harness's bridges
//! (`packages/core/worker-kit/src/testing/send-email-bridge.ts`,
//! `ledger-bridge.ts`). Both backends then get the same answers from the same
//! stubs, and the harness compares what each sent (the messages, read back
//! as a mail client reads them) and every ledger call.
//!
//! A test without the binding gets none here either
//! ([`OutboundBindings::default`]): the worker then answers 503 for a send,
//! and the guard runs without a ledger.

use std::collections::HashMap;
use std::sync::Arc;

use reqwest::Client;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use weldsuite_mail_domain::outbound::bindings::OutboundBindings;
use weldsuite_mail_domain::outbound::ledger::Inspection;
use weldsuite_mail_domain::outbound::ledger_core::{DeliveryEventType, StoredVerdict};
use weldsuite_mail_domain::outbound::{
    LedgerError, LedgerResult, LedgerSubject, OutboundLedger, OutboundUsage, PlatformBudget,
    PlatformStatus, ReserveDecision, ReserveRequest,
};
use weldsuite_ports::{BoxFuture, Envelope, MailTransport, TransportFailure};

/// `SEND_EMAIL` through the bridge.
struct BridgedSendEmail {
    bridge: String,
    client: Client,
}

impl MailTransport for BridgedSendEmail {
    fn send<'a>(
        &'a self,
        envelope: &'a Envelope,
        raw: &'a [u8],
    ) -> BoxFuture<'a, Result<(), TransportFailure>> {
        Box::pin(async move {
            let query: String = form_urlencoded::Serializer::new(String::new())
                .append_pair("from", &envelope.from)
                .append_pair("to", &envelope.to)
                .finish();
            let response = self
                .client
                .post(format!("{}/send?{query}", self.bridge))
                .header("content-type", "message/rfc822")
                .body(raw.to_vec())
                .send()
                .await
                .map_err(|error| TransportFailure::new(None, error.to_string()))?;
            if response.status().is_success() {
                return Ok(());
            }
            let text = response.text().await.unwrap_or_default();
            let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            Err(TransportFailure::new(
                body["code"].as_str(),
                body["message"].as_str().unwrap_or("send failed"),
            ))
        })
    }
}

/// One Durable Object namespace through the bridge.
#[derive(Clone)]
struct BridgedNamespace {
    bridge: String,
    binding: &'static str,
    client: Client,
}

impl BridgedNamespace {
    async fn call<T: DeserializeOwned>(
        &self,
        name: &str,
        method: &str,
        args: Value,
    ) -> LedgerResult<T> {
        let response = self
            .client
            .post(format!("{}/rpc", self.bridge))
            .header("content-type", "application/json")
            .body(
                json!({ "binding": self.binding, "name": name, "method": method, "args": args })
                    .to_string(),
            )
            .send()
            .await
            .map_err(|error| LedgerError(error.to_string()))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| LedgerError(error.to_string()))?;
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(LedgerError(
                body["error"]
                    .as_str()
                    .unwrap_or("ledger call failed")
                    .to_owned(),
            ));
        }
        serde_json::from_value(body["result"].clone())
            .map_err(|error| LedgerError(error.to_string()))
    }

    async fn call_unit(&self, name: &str, method: &str, args: Value) -> LedgerResult<()> {
        self.call::<Value>(name, method, args).await.map(|_| ())
    }
}

fn delivery_type(kind: DeliveryEventType) -> Value {
    serde_json::to_value(kind).unwrap_or(Value::Null)
}

impl OutboundLedger for BridgedNamespace {
    fn reserve<'a>(
        &'a self,
        key: &'a str,
        subject: &'a LedgerSubject,
        request: &'a ReserveRequest,
    ) -> BoxFuture<'a, LedgerResult<ReserveDecision>> {
        Box::pin(self.call(key, "reserve", json!([subject, request])))
    }

    fn commit<'a>(
        &'a self,
        key: &'a str,
        reservation_id: &'a str,
        sent_recipients: Option<&'a [String]>,
    ) -> BoxFuture<'a, LedgerResult<()>> {
        Box::pin(self.call_unit(key, "commit", json!([reservation_id, sent_recipients])))
    }

    fn release<'a>(
        &'a self,
        key: &'a str,
        reservation_id: &'a str,
    ) -> BoxFuture<'a, LedgerResult<()>> {
        Box::pin(self.call_unit(key, "release", json!([reservation_id])))
    }

    fn record_delivery<'a>(
        &'a self,
        key: &'a str,
        subject: &'a LedgerSubject,
        kind: DeliveryEventType,
        at_ms: i64,
    ) -> BoxFuture<'a, LedgerResult<()>> {
        Box::pin(self.call_unit(
            key,
            "recordDelivery",
            json!([subject, delivery_type(kind), at_ms]),
        ))
    }

    fn record_verdict<'a>(
        &'a self,
        key: &'a str,
        verdict: &'a StoredVerdict,
        staff_requested: bool,
    ) -> BoxFuture<'a, LedgerResult<()>> {
        Box::pin(self.call_unit(
            key,
            "recordVerdict",
            json!([verdict, { "staffRequested": staff_requested }]),
        ))
    }

    fn usage<'a>(
        &'a self,
        key: &'a str,
        subject: &'a LedgerSubject,
    ) -> BoxFuture<'a, LedgerResult<OutboundUsage>> {
        Box::pin(self.call(key, "usage", json!([subject])))
    }

    fn inspect<'a>(
        &'a self,
        key: &'a str,
        subject: &'a LedgerSubject,
    ) -> BoxFuture<'a, LedgerResult<Inspection>> {
        Box::pin(self.call(key, "inspect", json!([subject])))
    }

    fn request_review<'a>(
        &'a self,
        key: &'a str,
        subject: &'a LedgerSubject,
    ) -> BoxFuture<'a, LedgerResult<bool>> {
        Box::pin(self.call(key, "requestReview", json!([subject])))
    }

    fn refresh_policy<'a>(&'a self, key: &'a str) -> BoxFuture<'a, LedgerResult<()>> {
        Box::pin(self.call_unit(key, "refreshPolicy", json!([])))
    }
}

impl PlatformBudget for BridgedNamespace {
    fn status(&self) -> BoxFuture<'_, LedgerResult<PlatformStatus>> {
        Box::pin(self.call("platform", "status", json!([])))
    }

    fn trip<'a>(&'a self, reason: &'a str) -> BoxFuture<'a, LedgerResult<()>> {
        Box::pin(self.call_unit("platform", "trip", json!([reason])))
    }

    fn add(&self, day: i64, delta: i64) -> BoxFuture<'_, LedgerResult<()>> {
        Box::pin(self.call_unit("platform", "add", json!([day, delta])))
    }
}

/// The bridged bindings, one HTTP client per process.
#[derive(Default)]
pub(crate) struct MailBridges {
    client: Client,
}

impl MailBridges {
    /// The test's bindings: its `SEND_EMAIL` bridge and its ledger
    /// namespaces (`{ OUTBOUND_LEDGER: url, OUTBOUND_PLATFORM: url }`).
    pub(crate) fn bindings(
        &self,
        send_email: Option<&str>,
        ledgers: &HashMap<String, String>,
    ) -> OutboundBindings {
        let namespace = |binding: &'static str| {
            ledgers.get(binding).map(|bridge| BridgedNamespace {
                bridge: bridge.trim_end_matches('/').to_owned(),
                binding,
                client: self.client.clone(),
            })
        };
        OutboundBindings {
            transport: send_email.map(|bridge| {
                Arc::new(BridgedSendEmail {
                    bridge: bridge.trim_end_matches('/').to_owned(),
                    client: self.client.clone(),
                }) as Arc<dyn MailTransport>
            }),
            ledger: namespace("OUTBOUND_LEDGER").map(|ns| Arc::new(ns) as Arc<dyn OutboundLedger>),
            platform: namespace("OUTBOUND_PLATFORM")
                .map(|ns| Arc::new(ns) as Arc<dyn PlatformBudget>),
            backstop: None,
        }
    }
}

/// DNS over HTTPS through the outbound bridge: the test's `fetch` stub
/// answers the lookups the worker sends to `cloudflare-dns.com`.
struct BridgedDoh {
    bridge: String,
    client: Client,
}

impl weldsuite_mail_domain::recipients::DnsOverHttps for BridgedDoh {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<(u16, String), String>> {
        Box::pin(async move {
            let encoded: String = form_urlencoded::byte_serialize(url.as_bytes()).collect();
            let response = self
                .client
                .get(format!("{}/fetch?url={encoded}", self.bridge))
                .header("accept", "application/dns-json")
                .send()
                .await
                .map_err(|error| error.to_string())?;
            if response.headers().contains_key("x-outbound-error") {
                return Err("the test's fetch stub threw".to_owned());
            }
            let status = response.status().as_u16();
            let text = response.text().await.map_err(|error| error.to_string())?;
            Ok((status, text))
        })
    }
}

impl MailBridges {
    /// WeldMail's MX lookups through the test's outbound bridge.
    pub(crate) fn doh(&self, bridge: &str) -> weldsuite_mail::send::RequestDoh {
        weldsuite_mail::send::RequestDoh(Arc::new(BridgedDoh {
            bridge: bridge.trim_end_matches('/').to_owned(),
            client: self.client.clone(),
        }))
    }
}

/// WeldCommerce's portal rate limits (`PORTAL_RATE_LIMITER`): one counter
/// object per limiter key, its `hit(max, windowSeconds)` and `release()`
/// through the ledger bridge, so both backends count on the test's
/// in-memory namespace.
impl weldsuite_commerce_domain::rate_limit::RateLimitCounters for BridgedNamespace {
    fn hit<'a>(
        &'a self,
        name: &'a str,
        max: u32,
        window_seconds: u64,
    ) -> BoxFuture<'a, Result<weldsuite_commerce_domain::rate_limit::RateLimitVerdict, weldsuite_ports::PortError>>
    {
        Box::pin(async move {
            #[derive(serde::Deserialize)]
            struct Verdict {
                allowed: bool,
                count: u32,
                remaining: u32,
            }
            let verdict: Verdict = self
                .call(name, "hit", json!([max, window_seconds]))
                .await
                .map_err(|error| weldsuite_ports::PortError::backend(error.0))?;
            Ok(weldsuite_commerce_domain::rate_limit::RateLimitVerdict {
                allowed: verdict.allowed,
                count: verdict.count,
                remaining: verdict.remaining,
            })
        })
    }

    fn release<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<(), weldsuite_ports::PortError>> {
        Box::pin(async move {
            self.call_unit(name, "release", json!([]))
                .await
                .map_err(|error| weldsuite_ports::PortError::backend(error.0))
        })
    }
}

impl MailBridges {
    /// The test's `PORTAL_RATE_LIMITER` namespace, or none when it has none
    /// (the worker then answers as without the binding).
    pub(crate) fn portal_rate_limiter(
        &self,
        ledgers: &HashMap<String, String>,
    ) -> weldsuite_commerce_domain::rate_limit::RequestRateLimiter {
        weldsuite_commerce_domain::rate_limit::RequestRateLimiter(ledgers.get("PORTAL_RATE_LIMITER").map(
            |bridge| {
                Arc::new(BridgedNamespace {
                    bridge: bridge.trim_end_matches('/').to_owned(),
                    binding: "PORTAL_RATE_LIMITER",
                    client: self.client.clone(),
                }) as Arc<dyn weldsuite_commerce_domain::rate_limit::RateLimitCounters>
            },
        ))
    }
}
