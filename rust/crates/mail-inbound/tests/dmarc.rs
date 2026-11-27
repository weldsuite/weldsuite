//! DMARC aggregate reports end to end on the real schema (ADR MAIL-015): a
//! report for a verified domain is filed in the workspace's database once,
//! a resent one changes nothing, WeldSuite's own address is rolled up for the
//! operator, and a report for nobody's domain is dropped.
//!
//! Needs `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL`
//! (`scripts/rust-test-db.ts`); skipped without them.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::collections::HashMap;
use std::io::Write as _;
use std::sync::Arc;

use base64::Engine as _;
use sqlx::PgPool;
use weldsuite_mail_inbound::StaticDbs;
use weldsuite_mail_inbound::dmarc::{DmarcReports, NoNames, Outcome, SendingAddresses};
use weldsuite_ports::BoxFuture;

const WS: &str = "ws_mailin_dmarc";
const DOMAIN: &str = "dmarc-test.test";
const MAIL_DOMAIN: &str = "mdom_dmarc_test";

async fn pool(var: &str) -> Option<PgPool> {
    let url = std::env::var(var).ok()?;
    Some(
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("the test database"),
    )
}

async fn exec(db: &PgPool, statements: &[&str]) {
    for statement in statements {
        sqlx::raw_sql(sqlx::AssertSqlSafe((*statement).to_owned()))
            .execute(db)
            .await
            .expect("the statement runs");
    }
}

async fn count(db: &PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .fetch_one(db)
        .await
        .expect("the count runs")
}

struct OnePool;

impl SendingAddresses for OnePool {
    fn pools(&self) -> BoxFuture<'_, HashMap<String, String>> {
        Box::pin(async { HashMap::from([("198.51.100.7".to_owned(), "customer".to_owned())]) })
    }
}

fn report(domain: &str, id: &str) -> Vec<u8> {
    let xml = format!(
        r#"<?xml version="1.0"?>
<feedback>
  <report_metadata><org_name>google.com</org_name><email>noreply-dmarc-support@google.com</email>
    <report_id>{id}</report_id><date_range><begin>1764028800</begin><end>1764115199</end></date_range></report_metadata>
  <policy_published><domain>{domain}</domain><p>none</p></policy_published>
  <record><row><source_ip>198.51.100.7</source_ip><count>12</count>
    <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated></row>
    <identifiers><header_from>{domain}</header_from></identifiers>
    <auth_results><dkim><domain>{domain}</domain><selector>ws1</selector><result>pass</result></dkim></auth_results></record>
  <record><row><source_ip>203.0.113.9</source_ip><count>3</count>
    <policy_evaluated><disposition>none</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated></row>
    <identifiers><header_from>news.{domain}</header_from></identifiers><auth_results/></record>
</feedback>"#
    );
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(xml.as_bytes()).expect("gzip");
    let encoded = base64::engine::general_purpose::STANDARD.encode(gz.finish().expect("gzip"));
    format!(
        "From: noreply-dmarc-support@google.com\r\nTo: dmarc@reports.weldsuite.test\r\nSubject: Report domain: {domain}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b1\"\r\n\r\n--b1\r\nContent-Type: text/plain\r\n\r\nAggregate report.\r\n--b1\r\nContent-Type: application/gzip; name=\"r.xml.gz\"\r\nContent-Disposition: attachment; filename=\"r.xml.gz\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{encoded}\r\n--b1--\r\n"
    )
    .into_bytes()
}

#[tokio::test]
async fn reports_are_filed_once_for_the_workspace_that_verified_the_domain() {
    let (Some(master), Some(tenant)) = (
        pool("WELDSUITE_TEST_MASTER_URL").await,
        pool("WELDSUITE_TEST_TENANT_URL").await,
    ) else {
        return;
    };
    exec(
        &master,
        &[
            "delete from mail_dmarc_report_log where policy_domain in ('dmarc-test.test', 'nobody-dmarc.test')",
            "delete from mail_dmarc_pool_daily where header_from_domain = 'dmarc-test.test'",
            "delete from mail_domain_registry where workspace_id = 'ws_mailin_dmarc'",
            "delete from workspaces where id = 'ws_mailin_dmarc'",
            "insert into workspaces (id, name, slug, clerk_org_id) values ('ws_mailin_dmarc', 'DMARC', 'mailin-dmarc', 'org_mailin_dmarc')",
            "insert into mail_domain_registry (id, domain, workspace_id, mail_domain_id, verified_at) values ('mdreg_dmarc_test', 'dmarc-test.test', 'ws_mailin_dmarc', 'mdom_dmarc_test', now())",
        ],
    )
    .await;
    exec(
        &tenant,
        &["delete from mail_dmarc_reports where mail_domain_id = 'mdom_dmarc_test'"],
    )
    .await;
    let dmarc = DmarcReports {
        address: "dmarc@reports.weldsuite.test".to_owned(),
        operator_domains: Vec::new(),
        master: master.clone(),
        tenants: Arc::new(StaticDbs(HashMap::from([(WS.to_owned(), tenant.clone())]))),
        events: weldsuite_events::EntityEventPublisher::new(
            None,
            tokio_util::task::TaskTracker::new(),
        ),
        notifier: weldsuite_notifications::Notifier::default(),
        addresses: Arc::new(OnePool),
        names: Arc::new(NoNames),
    };
    assert!(dmarc.claims("DMARC@reports.weldsuite.test"));

    let first = dmarc.ingest(&report(DOMAIN, "r-1")).await.expect("filed");
    assert_eq!(first, Outcome::Stored(1));
    let reports =
        format!("select count(*) from mail_dmarc_reports where mail_domain_id = '{MAIL_DOMAIN}'");
    assert_eq!(count(&tenant, &reports).await, 1);
    // Both rows, the subdomain's too, under the verified parent.
    assert_eq!(
        count(
            &tenant,
            &format!(
                "select count(*) from mail_dmarc_records where mail_domain_id = '{MAIL_DOMAIN}'"
            )
        )
        .await,
        2
    );
    assert_eq!(
        count(
            &tenant,
            &format!("select count(*) from mail_dmarc_records where mail_domain_id = '{MAIL_DOMAIN}' and weldsuite_pool = 'customer'")
        )
        .await,
        1
    );
    let rollup = "select coalesce(sum(messages), 0)::bigint from mail_dmarc_pool_daily where header_from_domain = 'dmarc-test.test'";
    assert_eq!(count(&master, rollup).await, 12);

    // Resent: nothing changes, the rollup counts it once.
    let again = dmarc.ingest(&report(DOMAIN, "r-1")).await.expect("filed");
    assert_eq!(again, Outcome::Duplicate);
    assert_eq!(count(&tenant, &reports).await, 1);
    assert_eq!(count(&master, rollup).await, 12);

    // Nobody's domain: logged as such, nothing stored.
    let unknown = dmarc
        .ingest(&report("nobody-dmarc.test", "r-2"))
        .await
        .expect("filed");
    assert_eq!(unknown, Outcome::UnknownDomain);
}
