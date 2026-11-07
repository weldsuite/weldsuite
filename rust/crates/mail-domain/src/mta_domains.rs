//! WeldSuite's own MTA as the sending service behind [`RelayDomains`] on the
//! EU edition (ADR MAIL-011; the contract is `docs/plans/eu-mail-service.md`,
//! "HTTP API"). Global has no counterpart: there `@weldsuite/worker-email`
//! calls the Cloudflare Email Sending API.
//!
//! A customer domain is registered for the `customer` pool, which makes the
//! MTA mint its DKIM key (`POST /v1/domains`, idempotent). The MTA keeps no
//! verification state, so [`RelayDomains`] checks SPF and DKIM over DNS as it
//! does the MX. Calls go through the [`OutboundHttp`] port with the bearer
//! `MTA_API_SECRET`.
//!
//! [`RelayDomains`]: crate::domains::RelayDomains

use serde::Deserialize;
use serde_json::{Value, json};
use weldsuite_ports::{BoxFuture, HttpRequest, HttpResponse, OutboundHttp};

use crate::domains::{DomainError, RelayDomainApi, encode};

/// The pool the server registers customer domains for.
pub const CUSTOMER_POOL: &str = "customer";

/// The MTA's domain API (`MTA_API_URL`, `MTA_API_SECRET`).
pub struct MtaDomainApi {
    http: OutboundHttp,
    /// `http://<release>-mta.<ns>.svc:8025`, without a trailing slash.
    base_url: String,
    secret: String,
    pools: Vec<String>,
}

impl std::fmt::Debug for MtaDomainApi {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MtaDomainApi")
            .field("base_url", &self.base_url)
            .field("pools", &self.pools)
            .finish_non_exhaustive()
    }
}

/// The MTA's `Domain`, the fields read here.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MtaDomain {
    selector: String,
    #[serde(default)]
    public_key: Option<String>,
    #[serde(default)]
    dkim: Option<MtaDkim>,
}

#[derive(Debug, Deserialize)]
struct MtaDkim {
    value: String,
}

impl MtaDomainApi {
    /// A client for customer domains (pool [`CUSTOMER_POOL`]).
    pub fn new(http: OutboundHttp, base_url: &str, secret: impl Into<String>) -> Self {
        Self {
            http,
            base_url: base_url.trim().trim_end_matches('/').to_owned(),
            secret: secret.into(),
            pools: vec![CUSTOMER_POOL.to_owned()],
        }
    }

    fn domain_url(&self, domain: &str) -> String {
        format!("{}/v1/domains/{}", self.base_url, encode(domain))
    }

    async fn send(&self, request: HttpRequest, what: &str) -> Result<HttpResponse, DomainError> {
        let request = request.header("authorization", format!("Bearer {}", self.secret));
        self.http
            .send(request)
            .await
            .map_err(|error| DomainError::Provider(format!("MTA API {what} failed: {error}")))
    }
}

/// The domain as the MTA spells it.
fn normalise(domain: &str) -> String {
    domain.trim().trim_end_matches('.').to_ascii_lowercase()
}

/// A non-2xx answer as a [`DomainError`], with the MTA's message when it
/// sent one (`{ "error": { "message" } }` or `{ "error": "…" }`).
fn refusal(what: &str, response: &HttpResponse) -> DomainError {
    if matches!(response.status, 401 | 403) {
        return DomainError::Provider(format!(
            "MTA API {what}: the MTA refused MTA_API_SECRET ({})",
            response.status
        ));
    }
    let message = serde_json::from_slice::<Value>(&response.body)
        .ok()
        .and_then(|body| {
            let error = body.get("error")?;
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
                .map(str::to_owned)
        });
    DomainError::Provider(match message {
        Some(message) => format!("MTA API {what} answered {}: {message}", response.status),
        None => format!("MTA API {what} answered {}", response.status),
    })
}

/// The DKIM selector and TXT value of an MTA `Domain`.
fn dkim_of(what: &str, body: &[u8]) -> Result<(String, String), DomainError> {
    let domain: MtaDomain = serde_json::from_slice(body)
        .map_err(|error| DomainError::Provider(format!("MTA API {what}: not a Domain: {error}")))?;
    let value = match (domain.dkim, domain.public_key) {
        (Some(dkim), _) => dkim.value,
        (None, Some(key)) => format!("v=DKIM1; k=rsa; p={key}"),
        (None, None) => {
            return Err(DomainError::Provider(format!(
                "MTA API {what}: the domain has no DKIM key"
            )));
        }
    };
    Ok((domain.selector, value))
}

impl RelayDomainApi for MtaDomainApi {
    fn name(&self) -> &'static str {
        "mta"
    }

    /// `POST /v1/domains` `{ domain, pools: ["customer"] }`: 200 for a known
    /// domain, 201 for a new one, either with its `Domain`.
    fn create_domain<'a>(
        &'a self,
        domain: &'a str,
    ) -> BoxFuture<'a, Result<(String, String), DomainError>> {
        Box::pin(async move {
            let what = "register";
            let body = json!({ "domain": normalise(domain), "pools": self.pools });
            let request = HttpRequest::json("POST", format!("{}/v1/domains", self.base_url), &body);
            let response = self.send(request, what).await?;
            if !(200..300).contains(&response.status) {
                return Err(refusal(what, &response));
            }
            dkim_of(what, &response.body)
        })
    }

    /// `GET /v1/domains/{domain}`: the MTA still has the domain's key. It
    /// verifies nothing, so the records are left to the DNS lookups.
    fn domain_status<'a>(
        &'a self,
        domain: &'a str,
    ) -> BoxFuture<'a, Result<Option<(bool, bool)>, DomainError>> {
        Box::pin(async move {
            let what = "lookup";
            let domain = normalise(domain);
            let request = HttpRequest::empty("GET", self.domain_url(&domain));
            let response = self.send(request, what).await?;
            if response.status == 404 {
                return Err(DomainError::Provider(format!(
                    "{domain} is not registered at the MTA"
                )));
            }
            if !(200..300).contains(&response.status) {
                return Err(refusal(what, &response));
            }
            Ok(None)
        })
    }

    /// `DELETE /v1/domains/{domain}`: 204; a domain the MTA doesn't know is
    /// gone already.
    fn delete_domain<'a>(&'a self, domain: &'a str) -> BoxFuture<'a, Result<(), DomainError>> {
        Box::pin(async move {
            let what = "removal";
            let request = HttpRequest::empty("DELETE", self.domain_url(&normalise(domain)));
            let response = self.send(request, what).await?;
            if response.status == 404 || (200..300).contains(&response.status) {
                return Ok(());
            }
            Err(refusal(what, &response))
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, VecDeque};
    use std::sync::{Arc, Mutex};

    use weldsuite_ports::{DynOutboundHttp, PortError};

    use super::*;
    use crate::domains::{DomainRecordsConfig, MailDomains, ManualDomains, RelayDomains};
    use crate::recipients::DnsOverHttps;

    /// Answers each request with the next queued response, and keeps the
    /// requests.
    #[derive(Default)]
    struct FakeMta {
        answers: Mutex<VecDeque<HttpResponse>>,
        requests: Mutex<Vec<HttpRequest>>,
    }

    impl FakeMta {
        fn answering(answers: Vec<(u16, Value)>) -> Arc<Self> {
            Arc::new(Self {
                answers: Mutex::new(
                    answers
                        .into_iter()
                        .map(|(status, body)| {
                            let body = if body.is_null() {
                                Vec::new()
                            } else {
                                body.to_string().into_bytes()
                            };
                            HttpResponse::new(status, body)
                        })
                        .collect(),
                ),
                requests: Mutex::default(),
            })
        }

        fn requests(&self) -> Vec<HttpRequest> {
            self.requests.lock().expect("lock").clone()
        }
    }

    impl DynOutboundHttp for FakeMta {
        fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
            self.requests.lock().expect("lock").push(request);
            let answer = self.answers.lock().expect("lock").pop_front();
            Box::pin(async move { answer.ok_or_else(|| PortError::backend("connection refused")) })
        }
    }

    fn api(fake: &Arc<FakeMta>) -> MtaDomainApi {
        MtaDomainApi::new(
            OutboundHttp(Arc::clone(fake) as Arc<dyn DynOutboundHttp>),
            "http://weldsuite-mta.weldsuite.svc:8025/",
            "s3cret",
        )
    }

    fn domain() -> Value {
        json!({
            "domain": "acme.eu",
            "selector": "ws202611",
            "algorithm": "rsa-sha256",
            "publicKey": "MIIBIjANBg",
            "dkim": {
                "name": "ws202611._domainkey.acme.eu",
                "type": "TXT",
                "value": "v=DKIM1; k=rsa; p=MIIBIjANBg",
            },
            "pools": ["customer"],
            "createdAt": "2026-11-07T12:00:00.000Z",
        })
    }

    fn header<'a>(request: &'a HttpRequest, name: &str) -> Option<&'a str> {
        request
            .headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    #[tokio::test]
    async fn registers_the_domain_for_the_customer_pool() {
        let fake = FakeMta::answering(vec![(201, domain())]);
        let dkim = api(&fake)
            .create_domain(" Acme.EU ")
            .await
            .expect("registered");
        assert_eq!(
            dkim,
            (
                "ws202611".to_owned(),
                "v=DKIM1; k=rsa; p=MIIBIjANBg".to_owned()
            )
        );
        let requests = fake.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "POST");
        assert_eq!(
            request.url,
            "http://weldsuite-mta.weldsuite.svc:8025/v1/domains"
        );
        assert_eq!(header(request, "authorization"), Some("Bearer s3cret"));
        assert_eq!(header(request, "content-type"), Some("application/json"));
        let body: Value =
            serde_json::from_slice(request.body.as_deref().unwrap_or_default()).expect("json");
        assert_eq!(body, json!({ "domain": "acme.eu", "pools": ["customer"] }));
    }

    #[tokio::test]
    async fn builds_the_record_from_the_key_when_the_mta_sends_no_dkim() {
        let mut known = domain();
        known.as_object_mut().expect("object").remove("dkim");
        let fake = FakeMta::answering(vec![(200, known)]);
        let (selector, value) = api(&fake).create_domain("acme.eu").await.expect("known");
        assert_eq!(selector, "ws202611");
        assert_eq!(value, "v=DKIM1; k=rsa; p=MIIBIjANBg");
    }

    #[tokio::test]
    async fn refusals_are_provider_errors() {
        let fake = FakeMta::answering(vec![
            (401, json!({ "error": { "message": "unauthorised" } })),
            (
                422,
                json!({ "error": { "code": "INVALID", "message": "not a domain" } }),
            ),
            (200, json!({ "selector": "ws1" })),
        ]);
        let api = api(&fake);
        let Err(DomainError::Provider(message)) = api.create_domain("acme.eu").await else {
            panic!("a refused secret is an error");
        };
        assert!(message.contains("MTA_API_SECRET"), "{message}");
        let Err(DomainError::Provider(message)) = api.create_domain("acme").await else {
            panic!("a refusal is an error");
        };
        assert!(message.ends_with("422: not a domain"), "{message}");
        assert!(matches!(
            api.create_domain("acme.eu").await,
            Err(DomainError::Provider(_))
        ));
        assert!(matches!(
            api.create_domain("acme.eu").await,
            Err(DomainError::Provider(message)) if message.contains("connection refused")
        ));
    }

    #[tokio::test]
    async fn status_reads_the_domain_and_leaves_the_records_to_dns() {
        let fake = FakeMta::answering(vec![(200, domain()), (404, Value::Null)]);
        let api = api(&fake);
        assert_eq!(api.domain_status("acme.eu").await, Ok(None));
        assert!(matches!(
            api.domain_status("gone.eu").await,
            Err(DomainError::Provider(message)) if message.contains("not registered")
        ));
        let requests = fake.requests();
        assert_eq!(requests[0].method, "GET");
        assert_eq!(
            requests[0].url,
            "http://weldsuite-mta.weldsuite.svc:8025/v1/domains/acme.eu"
        );
        assert_eq!(header(&requests[0], "authorization"), Some("Bearer s3cret"));
        assert!(requests[0].body.is_none());
    }

    #[tokio::test]
    async fn removal_is_idempotent() {
        let fake = FakeMta::answering(vec![
            (204, Value::Null),
            (404, Value::Null),
            (500, Value::Null),
        ]);
        let api = api(&fake);
        assert_eq!(api.delete_domain("acme.eu").await, Ok(()));
        assert_eq!(api.delete_domain("acme.eu").await, Ok(()));
        assert!(api.delete_domain("acme.eu").await.is_err());
        let request = &fake.requests()[0];
        assert_eq!(request.method, "DELETE");
        assert_eq!(
            request.url,
            "http://weldsuite-mta.weldsuite.svc:8025/v1/domains/acme.eu"
        );
    }

    /// Answers DNS-over-HTTPS lookups by URL.
    #[derive(Default)]
    struct FakeDoh(HashMap<String, Vec<&'static str>>);

    impl DnsOverHttps for FakeDoh {
        fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<(u16, String), String>> {
            let answers = self.0.get(url).cloned().unwrap_or_default();
            let body = json!({
                "Status": 0,
                "Answer": answers.iter().map(|d| json!({ "data": d })).collect::<Vec<_>>(),
            });
            Box::pin(async move { Ok((200, body.to_string())) })
        }
    }

    #[tokio::test]
    async fn relay_domains_verify_the_mta_record_over_dns() {
        let lookup = |name: &str, kind: &str| {
            format!("https://resolver.test/dns-query?name={name}&type={kind}")
        };
        let doh = FakeDoh(HashMap::from([
            (lookup("acme.eu", "MX"), vec!["10 mx.eu.weldsuite.test."]),
            (
                lookup("acme.eu", "TXT"),
                vec!["\"v=spf1 include:_spf.eu.weldsuite.test -all\""],
            ),
            (
                lookup("ws202611._domainkey.acme.eu", "TXT"),
                vec!["\"v=DKIM1; k=rsa; \" \"p=MIIBIjANBg\""],
            ),
        ]));
        let manual = ManualDomains::new(
            DomainRecordsConfig {
                mx_host: "mx.eu.weldsuite.test".to_owned(),
                spf_include: Some("_spf.eu.weldsuite.test".to_owned()),
                dkim: None,
                dmarc: "v=DMARC1; p=none".to_owned(),
            },
            Arc::new(doh),
            "https://resolver.test/dns-query".to_owned(),
        );
        let fake = FakeMta::answering(vec![(200, domain()), (200, domain())]);
        let relay = RelayDomains::new(Some(Arc::new(api(&fake))), manual);
        assert_eq!(relay.provider(), "mta");
        let setup = relay.verify("acme.eu").await.expect("domain setup");
        assert!(setup.verified, "{:?}", setup.records);
        assert!(setup.spf_verified() && setup.dkim_verified());
        assert_eq!(setup.dkim_selector.as_deref(), Some("ws202611"));
        let dkim = setup.dkim_record().expect("dkim record");
        assert_eq!(dkim.name, "ws202611._domainkey.acme.eu");
        assert_eq!(dkim.value, "v=DKIM1; k=rsa; p=MIIBIjANBg");
    }
}
