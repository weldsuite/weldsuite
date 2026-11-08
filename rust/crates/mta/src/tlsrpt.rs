//! TLS-RPT (RFC 8460) as a sender: once a day, one node (the first to claim
//! the day's job) reports yesterday's TLS results to every destination
//! domain that publishes `_smtp._tls.<domain>` TXT `v=TLSRPTv1; rua=…`:
//! gzipped JSON, by mail (`mailto:`, queued in the `system` pool from
//! `MTA_TLSRPT_FROM`) or HTTPS POST.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::crypto::new_id;
use crate::dns::Resolver;
use crate::store::{Store, TlsResultRow};

/// The report addresses (`rua`) of a TLSRPT record set.
pub fn rua(records: &[String]) -> Vec<String> {
    records
        .iter()
        .filter(|r| r.trim_start().starts_with("v=TLSRPTv1"))
        .flat_map(|record| {
            record
                .split(';')
                .filter_map(|field| field.trim().strip_prefix("rua="))
                .flat_map(|list| list.split(','))
                .map(|uri| uri.trim().to_owned())
                .collect::<Vec<_>>()
        })
        .filter(|uri| uri.starts_with("mailto:") || uri.starts_with("https://"))
        .collect()
}

/// The JSON report for one policy domain and day (`YYYY-MM-DD`).
pub fn report(
    domain: &str,
    day: &str,
    submitter: &str,
    contact: &str,
    rows: &[&TlsResultRow],
) -> Value {
    let policies: Vec<Value> = rows
        .iter()
        .map(|row| {
            let failures: BTreeMap<String, i64> = row
                .failures
                .as_object()
                .map(|map| {
                    map.iter()
                        .map(|(k, v)| {
                            (
                                k.clone(),
                                v.as_i64().or_else(|| v.as_str()?.parse().ok()).unwrap_or(0),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            let total_failures: i64 = failures.values().sum();
            let mut policy = json!({
                "policy-type": row.policy_type,
                "policy-domain": domain,
            });
            if !row.policy_strings.is_empty() {
                policy["policy-string"] = json!(row.policy_strings);
            }
            if !row.mx_host.is_empty() {
                policy["mx-host"] = json!([row.mx_host]);
            }
            json!({
                "policy": policy,
                "summary": {
                    "total-successful-session-count": row.successes,
                    "total-failure-session-count": total_failures,
                },
                "failure-details": failures.iter().map(|(kind, count)| json!({
                    "result-type": kind,
                    "failed-session-count": count,
                    "receiving-mx-hostname": row.mx_host,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({
        "organization-name": "WeldSuite",
        "date-range": {
            "start-datetime": format!("{day}T00:00:00Z"),
            "end-datetime": format!("{day}T23:59:59Z"),
        },
        "contact-info": contact,
        "report-id": format!("{day}_{domain}@{submitter}"),
        "policies": policies,
    })
}

fn gzip(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes)?;
    encoder.finish()
}

/// The report mail (RFC 8460 §5.3).
pub fn report_mail(
    from: &str,
    to: &str,
    domain: &str,
    submitter: &str,
    day: &str,
    gz: &[u8],
) -> Vec<u8> {
    let boundary = format!("tlsrpt-{}", new_id(""));
    let report_id = format!("{day}_{domain}@{submitter}");
    let filename = format!("{submitter}!{domain}!{day}T00:00:00Z!{day}T23:59:59Z.json.gz");
    let encoded = base64::engine::general_purpose::STANDARD.encode(gz);
    let mut wrapped = String::with_capacity(encoded.len() + encoded.len() / 76 * 2);
    for chunk in encoded.as_bytes().chunks(76) {
        wrapped.push_str(&String::from_utf8_lossy(chunk));
        wrapped.push_str("\r\n");
    }
    let date = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc2822)
        .unwrap_or_default();
    format!(
        "From: {from}\r\nTo: {to}\r\nDate: {date}\r\nMessage-ID: <{id}@{submitter}>\r\n\
Subject: Report Domain: {domain} Submitter: {submitter} Report-ID: <{report_id}>\r\n\
TLS-Report-Domain: {domain}\r\nTLS-Report-Submitter: {submitter}\r\nMIME-Version: 1.0\r\n\
Content-Type: multipart/report; report-type=\"tlsrpt\"; boundary=\"{boundary}\"\r\n\r\n\
--{boundary}\r\nContent-Type: text/plain; charset=us-ascii\r\n\r\n\
This is an aggregate TLS report from {submitter}.\r\n\r\n\
--{boundary}\r\nContent-Type: application/tlsrpt+gzip\r\nContent-Transfer-Encoding: base64\r\n\
Content-Disposition: attachment; filename=\"{filename}\"\r\n\r\n{wrapped}\r\n--{boundary}--\r\n",
        id = new_id(""),
    )
    .into_bytes()
}

pub struct Reporter {
    pub store: Store,
    pub resolver: Arc<Resolver>,
    pub http: reqwest::Client,
    pub from: String,
    pub submitter: String,
}

impl Reporter {
    /// Checks hourly whether today's run is due (after 01:00 UTC) and
    /// unclaimed.
    pub async fn run(self, shutdown: CancellationToken) {
        loop {
            tokio::select! {
                () = shutdown.cancelled() => return,
                () = tokio::time::sleep(Duration::from_secs(3600)) => {}
            }
            if time::OffsetDateTime::now_utc().hour() < 1 {
                continue;
            }
            match self.store.claim_daily("tlsrpt").await {
                Ok(true) => {
                    if let Err(error) = self.send_reports().await {
                        tracing::warn!(%error, "TLS-RPT run failed");
                    }
                }
                Ok(false) => {}
                Err(error) => tracing::warn!(%error, "TLS-RPT claim failed"),
            }
        }
    }

    pub async fn send_reports(&self) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let rows = self.store.tls_results_yesterday().await?;
        let day = (time::OffsetDateTime::now_utc() - time::Duration::days(1))
            .date()
            .to_string();
        let mut by_domain: BTreeMap<&str, Vec<&TlsResultRow>> = BTreeMap::new();
        for row in &rows {
            by_domain
                .entry(row.policy_domain.as_str())
                .or_default()
                .push(row);
        }
        let contact = self.from.clone();
        let mut sent = 0;
        for (domain, rows) in by_domain {
            let targets = rua(&self
                .resolver
                .txt(&format!("_smtp._tls.{domain}"))
                .await
                .unwrap_or_default());
            if targets.is_empty() {
                continue;
            }
            let json = serde_json::to_vec(&report(domain, &day, &self.submitter, &contact, &rows))?;
            let gz = gzip(&json)?;
            for target in targets {
                if let Some(address) = target.strip_prefix("mailto:") {
                    let address = address.split('!').next().unwrap_or(address).to_owned();
                    let mail =
                        report_mail(&self.from, &address, domain, &self.submitter, &day, &gz);
                    self.store
                        .enqueue("system", &self.from, &self.from, &mail, &[address])
                        .await?;
                } else {
                    let response = self
                        .http
                        .post(&target)
                        .header("content-type", "application/tlsrpt+gzip")
                        .body(gz.clone())
                        .send()
                        .await;
                    if let Err(error) = response {
                        tracing::warn!(%error, %domain, "TLS-RPT POST failed");
                        continue;
                    }
                }
                sent += 1;
            }
        }
        tracing::info!(sent, "TLS-RPT reports sent");
        Ok(sent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_rua_and_builds_a_report() {
        let records = vec![
            "v=TLSRPTv1; rua=mailto:tlsrpt@example.com,https://reports.example.com/v1".to_owned(),
            "v=spf1 -all".to_owned(),
        ];
        assert_eq!(
            rua(&records),
            vec![
                "mailto:tlsrpt@example.com",
                "https://reports.example.com/v1"
            ]
        );
        let row = TlsResultRow {
            policy_domain: "example.com".into(),
            policy_type: "sts".into(),
            policy_strings: vec!["version: STSv1".into(), "mode: enforce".into()],
            mx_host: "mx.example.com".into(),
            successes: 9,
            failures: json!({ "certificate-expired": 2 }),
        };
        let value = report(
            "example.com",
            "2026-11-06",
            "mail1-customer.eu.test",
            "tlsrpt@x",
            &[&row],
        );
        assert_eq!(
            value["policies"][0]["summary"]["total-successful-session-count"],
            9
        );
        assert_eq!(
            value["policies"][0]["summary"]["total-failure-session-count"],
            2
        );
        assert_eq!(
            value["policies"][0]["failure-details"][0]["result-type"],
            "certificate-expired"
        );
        assert_eq!(
            value["date-range"]["start-datetime"],
            "2026-11-06T00:00:00Z"
        );
        let mail = report_mail(
            "tlsrpt@b.test",
            "r@example.com",
            "example.com",
            "s.test",
            "2026-11-06",
            &gzip(b"{}").expect("gz"),
        );
        let text = String::from_utf8(mail).expect("ascii");
        assert!(text.contains("report-type=\"tlsrpt\""));
        assert!(text.contains("TLS-Report-Domain: example.com\r\n"));
    }
}
