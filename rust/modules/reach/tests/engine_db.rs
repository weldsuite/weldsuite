//! The send consumer step and the warmup pass on the real schema
//! (`WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL`, built by
//! `scripts/rust-test-db.ts`; skipped without them). The tick itself is
//! compared with TypeScript by `reach-domain`'s `send_engine_parity.rs`.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_db::Keyring;
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_ports::{BoxFuture, DefaultFlags, OutboundHttp};
use weldsuite_reach::send::{
    ReachSendMessage, SendEngine, SendOutcome, SendTenant, process_send_message,
};
use weldsuite_reach::warmup::{WarmupEngine, WarmupTenant, run_warmup_sweep};
use weldsuite_reach_domain::smtp::{SmtpConfig, SmtpEnvelope, SmtpSendResult, SmtpTransport};
use weldsuite_reach_domain::{credentials, parse_iso};

const WS: &str = "ws_p8reachng";
const ORG: &str = "org_p8reachng";
const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";

async fn databases() -> Option<(PgPool, PgPool)> {
    let master = std::env::var("WELDSUITE_TEST_MASTER_URL").ok()?;
    let tenant = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
    Some((
        PgPool::connect(&master).await.expect("master"),
        PgPool::connect(&tenant).await.expect("tenant"),
    ))
}

async fn exec(db: &PgPool, sql: &'static str, binds: &[&str]) {
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = query.bind(*bind);
    }
    query
        .execute(db)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

async fn reset(master: &PgPool, tenant: &PgPool) {
    exec(
        master,
        "delete from workspace_due_index where workspace_id = $1",
        &[WS],
    )
    .await;
    exec(
        master,
        "delete from reach_warmup_mailboxes where clerk_org_id = $1",
        &[ORG],
    )
    .await;
    exec(
        master,
        "delete from workspace_app_access where workspace_id = $1",
        &[WS],
    )
    .await;
    exec(master, "delete from workspaces where id = $1", &[WS]).await;
    for sql in [
        "delete from reach_messages",
        "delete from reach_enrollments",
        "delete from reach_campaign_mailboxes",
        "delete from reach_campaign_steps",
        "delete from reach_campaigns",
        "delete from reach_prospects",
        "delete from reach_mailboxes",
        "delete from reach_domains",
        "delete from domains where id = 'dom_e1'",
        "delete from reach_settings",
    ] {
        exec(tenant, sql, &[]).await;
    }
}

async fn workspace(master: &PgPool, access: &str) {
    exec(
        master,
        "insert into workspaces (id, name, slug, clerk_org_id) values ($1, $1, $1, $2)",
        &[WS, ORG],
    )
    .await;
    exec(
        master,
        "insert into workspace_app_access (id, workspace_id, app_code, status) values ('waa_p8reachng', $1, 'weldreach', $2)",
        &[WS, access],
    )
    .await;
}

struct Smtp(Mutex<Vec<String>>);

impl SmtpTransport for Smtp {
    fn send(
        &self,
        _config: SmtpConfig,
        envelope: SmtpEnvelope,
        _raw: String,
    ) -> BoxFuture<'_, Result<SmtpSendResult, String>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .extend(envelope.to);
        Box::pin(async {
            Ok(SmtpSendResult {
                ok: true,
                response: "250 OK".to_owned(),
                stage: String::new(),
                permanent: false,
                recipient_rejected: false,
                auth_failed: false,
                delivery_uncertain: false,
            })
        })
    }
}

fn keyring() -> Keyring {
    Keyring {
        v1: Some(KEY.to_owned()),
        v2: None,
    }
}

fn sealed(email: &str) -> String {
    credentials::seal(
        &keyring(),
        &credentials::MailServerCredentials {
            host: "smtp.mailpool.test".to_owned(),
            port: 465,
            tls: true,
            username: email.to_owned(),
            password: "pw".to_owned(),
        },
    )
    .expect("sealed")
}

fn send_engine(master: &PgPool, tenant: &PgPool, smtp: Arc<Smtp>) -> SendEngine {
    let db = tenant.clone();
    SendEngine {
        master: master.clone(),
        tenants: Arc::new(move |_| {
            let db = db.clone();
            Box::pin(async move {
                Ok(SendTenant {
                    db,
                    clerk_org_id: Some(ORG.to_owned()),
                })
            })
        }),
        keyring: keyring(),
        transport: smtp,
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        flags: Arc::new(DefaultFlags),
    }
}

async fn due_at(master: &PgPool, kind: &str) -> Option<String> {
    sqlx::query_scalar(
        "select to_char(next_due_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI') from workspace_due_index where kind = $1 and workspace_id = $2",
    )
    .bind(kind)
    .bind(WS)
    .fetch_optional(master)
    .await
    .expect("due row")
}

#[tokio::test]
#[allow(
    clippy::too_many_lines,
    reason = "one workspace through every step in turn"
)]
async fn the_send_consumer_step_and_the_warmup_pass() {
    let Some((master, tenant)) = databases().await else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / _TENANT_URL not set: skipping");
        return;
    };
    let now = parse_iso("2026-10-12T10:00:00.000Z").expect("now");
    let clock = move || now;
    let message = ReachSendMessage {
        workspace_id: WS.to_owned(),
        enqueued_at: 0,
    };
    let smtp = Arc::new(Smtp(Mutex::new(Vec::new())));

    // No such workspace: skipped, and its due row goes.
    reset(&master, &tenant).await;
    exec(&master, "insert into workspace_due_index (kind, workspace_id, next_due_at, updated_at, version) values ('reach_send', $1, '2026-10-12T09:00:00Z', now(), 1)", &[WS]).await;
    let engine = send_engine(&master, &tenant, Arc::clone(&smtp));
    let outcome = process_send_message(&engine, &message, &clock)
        .await
        .expect("processed");
    assert_eq!(
        outcome,
        SendOutcome::Skipped("unknown_workspace".to_owned())
    );
    assert_eq!(due_at(&master, "reach_send").await, None);

    // Suspended: looked at again in an hour.
    workspace(&master, "suspended").await;
    exec(&master, "insert into workspace_due_index (kind, workspace_id, next_due_at, updated_at, version) values ('reach_send', $1, '2026-10-12T09:00:00Z', now(), 1)", &[WS]).await;
    let outcome = process_send_message(&engine, &message, &clock)
        .await
        .expect("processed");
    assert_eq!(outcome, SendOutcome::Skipped("access_suspended".to_owned()));
    assert_eq!(
        due_at(&master, "reach_send").await.as_deref(),
        Some("2026-10-12T11:00")
    );

    // Approved: the tick sends, and the due row moves to the follow-up.
    exec(
        &master,
        "update workspace_app_access set status = 'approved' where workspace_id = $1",
        &[WS],
    )
    .await;
    let creds = sealed("sam@getacme.com");
    sqlx::query(
        "insert into reach_mailboxes (id, domain_id, email, first_name, last_name, type, status, daily_cap, ramp_current, inbound_token, smtp_credentials)
         values ('rmbx_e1', 'rdom_e1', 'sam@getacme.com', 'Sam', 'Taylor', 'shared', 'active', 30, 30, 'tok_e1', $1)",
    )
    .bind(&creds)
    .execute(&tenant)
    .await
    .expect("mailbox");
    exec(&tenant, "insert into reach_settings (id, sender_company_name, sender_address, default_timezone) values ('rset_e1', 'Acme BV', 'Street 1', 'UTC')", &[]).await;
    exec(&tenant, "insert into reach_campaigns (id, name, status, timezone, send_days, window_start, window_end, daily_limit, min_gap_minutes) values ('rcmp_e1', 'C', 'active', 'UTC', '[1,2,3,4,5,6,7]', '00:00', '23:59', 100, 8)", &[]).await;
    exec(&tenant, "insert into reach_campaign_steps (id, campaign_id, \"order\", subject, body, delay_days, delay_hours, reply_in_thread) values ('rstp_e0', 'rcmp_e1', 0, 'Hi {{firstName}}', 'Hello', 0, 0, true), ('rstp_e1', 'rcmp_e1', 1, 'Again', 'Bump', 2, 0, true)", &[]).await;
    exec(&tenant, "insert into reach_campaign_mailboxes (id, campaign_id, mailbox_id) values ('rcmb_e1', 'rcmp_e1', 'rmbx_e1')", &[]).await;
    exec(&tenant, "insert into reach_prospects (id, email, first_name, company_domain) values ('rpro_e1', 'jane@bigco.io', 'Jane', 'bigco.io')", &[]).await;
    exec(&tenant, "insert into reach_enrollments (id, campaign_id, prospect_id, status, current_step, next_send_at) values ('renr_e1', 'rcmp_e1', 'rpro_e1', 'active', 0, '2026-10-12T09:00:00Z')", &[]).await;
    exec(&master, "update workspace_due_index set next_due_at = '2026-10-12T09:00:00Z' where workspace_id = $1", &[WS]).await;
    let outcome = process_send_message(&engine, &message, &clock)
        .await
        .expect("processed");
    let SendOutcome::Ticked(tick) = outcome else {
        panic!("expected a tick, got {outcome:?}");
    };
    assert_eq!((tick.claimed, tick.sent), (1, 1));
    assert_eq!(
        *smtp.0.lock().expect("calls"),
        vec!["jane@bigco.io".to_owned()]
    );
    assert_eq!(
        due_at(&master, "reach_send").await.as_deref(),
        Some("2026-10-14T10:00")
    );

    // The warmup pass: a warming mailbox the pool has warmed graduates.
    exec(&tenant, "update reach_mailboxes set status = 'warming', warmup_day = 13, ramp_current = 2 where id = 'rmbx_e1'", &[]).await;
    exec(&tenant, "insert into reach_domains (id, host_domain_id, name, status) values ('rdom_e1', 'dom_e1', 'getacme.com', 'active')", &[]).await;
    exec(&tenant, "insert into domains (id, name, tld, full_domain, status, expires_at) values ('dom_e1', 'getacme', 'com', 'getacme.com', 'active', '2027-10-01T00:00:00Z')", &[]).await;
    sqlx::query(
        "insert into reach_warmup_mailboxes (id, workspace_id, clerk_org_id, tenant_mailbox_id, email, domain, first_name, last_name, mailbox_type, status, ramp_day, stats, smtp_credentials, imap_credentials)
         values ('rwm_e1', $1, $2, 'rmbx_e1', 'sam@getacme.com', 'getacme.com', 'Sam', 'Taylor', 'shared', 'warming', 15, $3, 'x', 'x')",
    )
    .bind(WS)
    .bind(ORG)
    .bind(json!({ "inboxRate3d": 0.912_34 }))
    .execute(&master)
    .await
    .expect("pool row");
    exec(&master, "insert into workspace_due_index (kind, workspace_id, next_due_at, updated_at, version) values ('reach_warmup', $1, '2026-10-12T09:00:00Z', now(), 1)", &[WS]).await;
    let db = tenant.clone();
    let warmup = WarmupEngine {
        master: master.clone(),
        tenants: Arc::new(move |_| {
            let db = db.clone();
            Box::pin(async move {
                Ok(WarmupTenant {
                    db,
                    workspace_id: WS.to_owned(),
                    clerk_org_id: Some(ORG.to_owned()),
                })
            })
        }),
        keyring: keyring(),
        warmup_key: None,
        mailpool_key: None,
        mailpool_url: None,
        http: OutboundHttp(Arc::new(NoHttp)),
        events: EntityEventPublisher::new(None, TaskTracker::new()),
    };
    let result = run_warmup_sweep(&warmup, now).await;
    assert_eq!((result.due, result.processed, result.failed), (1, 1, 0));
    let row: Value =
        sqlx::query_scalar("select to_jsonb(t) from reach_mailboxes t where id = 'rmbx_e1'")
            .fetch_one(&tenant)
            .await
            .expect("mailbox");
    assert_eq!(row["status"], json!("active"));
    assert_eq!(row["warmup_day"], json!(15));
    assert_eq!(row["warmup_status"], json!("warming"));
    assert_eq!(row["ramp_current"], json!(10));
    assert_eq!(row["warmup_inbox_rate"], json!(0.9123));
    // Ramping: due again tomorrow.
    assert_eq!(
        due_at(&master, "reach_warmup").await.as_deref(),
        Some("2026-10-13T00:00")
    );
    reset(&master, &tenant).await;
}

struct NoHttp;

impl weldsuite_ports::DynOutboundHttp for NoHttp {
    fn send(
        &self,
        _request: weldsuite_ports::HttpRequest,
    ) -> BoxFuture<'_, Result<weldsuite_ports::HttpResponse, weldsuite_ports::PortError>> {
        Box::pin(std::future::ready(Err(
            weldsuite_ports::PortError::backend("no HTTP"),
        )))
    }
}
