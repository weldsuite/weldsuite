//! The warmup network's jobs on the real master schema
//! (`WELDSUITE_TEST_MASTER_URL`, built by `scripts/rust-test-db.ts`; skipped
//! without it), with a scripted SMTP transport and the in-memory IMAP
//! server. The cases mirror reach-warmup-worker's own tests (dispatch,
//! send, engage, login recheck, planner, daily, cleanup). The planner's
//! choices are compared with TypeScript by `warmup_parity.rs`.
//!
//! The pool spans every workspace, so the cases own the pool tables and run
//! one after the other in a single test.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_ports::{
    BoxFuture, DefaultFlags, DynFlagSource, ImapError, ImapErrorKind, MemoryImap, SpecialUse,
    StaticFlags,
};
use weldsuite_reach::warmup_network::WarmupNetwork;
use weldsuite_reach::warmup_network::daily::run_daily;
use weldsuite_reach::warmup_network::dispatch::{
    WarmupQueue, WarmupQueueKind, handle_batch, run_dispatch,
};
use weldsuite_reach::warmup_network::engage::{EngageOutcome, process_engage};
use weldsuite_reach::warmup_network::planner::run_planner;
use weldsuite_reach::warmup_network::send::{SendOutcome, process_send};
use weldsuite_reach_domain::credentials::{MailServerCredentials, seal, warmup_keyring};
use weldsuite_reach_domain::smtp::{SmtpConfig, SmtpEnvelope, SmtpSendResult, SmtpTransport};
use weldsuite_reach_domain::{epoch_ms, iso, parse_iso};

const KEY: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;

fn at(text: &str) -> i64 {
    epoch_ms(parse_iso(text).expect("iso"))
}

/// Tuesday 09:00 UTC.
fn now() -> i64 {
    at("2026-10-13T09:00:00.000Z")
}

fn ts(ms: i64) -> String {
    iso(weldsuite_reach_domain::from_epoch_ms(ms))
}

/// Answers each send with the next scripted result (`ok` when none left)
/// and records what was sent.
#[derive(Default)]
struct ScriptedSmtp {
    results: Mutex<Vec<SmtpSendResult>>,
    sent: Mutex<Vec<(SmtpConfig, SmtpEnvelope, String)>>,
}

fn ok_result() -> SmtpSendResult {
    SmtpSendResult {
        ok: true,
        response: "250 OK".to_owned(),
        stage: String::new(),
        permanent: false,
        recipient_rejected: false,
        auth_failed: false,
        delivery_uncertain: false,
    }
}

impl ScriptedSmtp {
    fn then(&self, result: SmtpSendResult) {
        self.results.lock().expect("lock").push(result);
    }

    fn sent(&self) -> Vec<(SmtpConfig, SmtpEnvelope, String)> {
        self.sent.lock().expect("lock").clone()
    }
}

impl SmtpTransport for ScriptedSmtp {
    fn send(
        &self,
        config: SmtpConfig,
        envelope: SmtpEnvelope,
        raw: String,
    ) -> BoxFuture<'_, Result<SmtpSendResult, String>> {
        self.sent
            .lock()
            .expect("lock")
            .push((config, envelope, raw));
        let mut results = self.results.lock().expect("lock");
        let result = if results.is_empty() {
            ok_result()
        } else {
            results.remove(0)
        };
        Box::pin(std::future::ready(Ok(result)))
    }
}

struct World {
    master: PgPool,
    smtp: Arc<ScriptedSmtp>,
    imap: MemoryImap,
    net: WarmupNetwork,
}

impl World {
    fn with_flags(&self, flags: Arc<dyn DynFlagSource>) -> WarmupNetwork {
        WarmupNetwork {
            flags,
            ..self.net.clone()
        }
    }
}

async fn world() -> Option<World> {
    let url = std::env::var("WELDSUITE_TEST_MASTER_URL").ok()?;
    let master = PgPool::connect(&url).await.expect("master");
    let smtp = Arc::new(ScriptedSmtp::default());
    let imap = MemoryImap::new();
    let net = WarmupNetwork {
        master: master.clone(),
        warmup_key: Some(KEY.to_owned()),
        smtp: Arc::clone(&smtp) as Arc<dyn SmtpTransport>,
        imap: Arc::new(imap.clone()),
        flags: Arc::new(DefaultFlags),
    };
    Some(World {
        master,
        smtp,
        imap,
        net,
    })
}

async fn reset(world: &World) {
    for sql in [
        "delete from reach_warmup_messages",
        "delete from reach_warmup_mailboxes",
        "delete from workspace_due_index where kind = 'reach_warmup'",
    ] {
        sqlx::query(sql).execute(&world.master).await.expect(sql);
    }
}

fn login(host: &str, email: &str) -> String {
    seal(
        &warmup_keyring(KEY),
        &MailServerCredentials {
            host: host.to_owned(),
            port: if host.starts_with("imap") { 993 } else { 465 },
            tls: true,
            username: email.to_owned(),
            password: format!("pw-{email}"),
        },
    )
    .expect("sealed")
}

/// A pool mailbox `<id>@<domain>` in workspace `ws_<id>`, with an IMAP
/// account in the memory server.
async fn mailbox(world: &World, id: &str, domain: &str, status: &str, ramp_day: i32) -> String {
    let email = format!("{id}@{domain}");
    world.imap.add_account(&email, &format!("pw-{email}"));
    sqlx::query(
        "insert into reach_warmup_mailboxes (id, workspace_id, clerk_org_id, tenant_mailbox_id, email, domain,
           mailbox_type, first_name, last_name, timezone, status, started_at, ramp_day, smtp_credentials,
           imap_credentials, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, 'shared', $7, 'Tester', 'UTC', $8,
           case when $8 = 'waiting' then null else $9::timestamptz end, $10, $11, $12, $9::timestamptz, $9::timestamptz)",
    )
    .bind(id)
    .bind(format!("ws_{id}"))
    .bind(format!("org_{id}"))
    .bind(format!("rmb_{id}"))
    .bind(&email)
    .bind(domain)
    .bind(id.to_uppercase())
    .bind(status)
    .bind(ts(now() - 5 * DAY))
    .bind(ramp_day)
    .bind(login("smtp.mail.test", &email))
    .bind(login("imap.mail.test", &email))
    .execute(&world.master)
    .await
    .expect("mailbox");
    email
}

struct Msg<'a> {
    id: &'a str,
    from: &'a str,
    to: &'a str,
    status: &'a str,
    step: i32,
    scheduled_at: i64,
    sent_at: Option<i64>,
    engage_at: Option<i64>,
    attempts: i32,
}

impl<'a> Msg<'a> {
    fn scheduled(id: &'a str, from: &'a str, to: &'a str, scheduled_at: i64) -> Self {
        Self {
            id,
            from,
            to,
            status: "scheduled",
            step: 0,
            scheduled_at,
            sent_at: None,
            engage_at: None,
            attempts: 0,
        }
    }

    fn sent(id: &'a str, from: &'a str, to: &'a str, sent_at: i64) -> Self {
        Self {
            status: "sent",
            sent_at: Some(sent_at),
            engage_at: Some(sent_at + 30 * MINUTE),
            ..Self::scheduled(id, from, to, sent_at)
        }
    }
}

async fn message(world: &World, m: &Msg<'_>) {
    sqlx::query(
        "insert into reach_warmup_messages (id, thread_id, step, from_mailbox_id, to_mailbox_id, corpus_thread_id,
           message_id_header, subject, status, scheduled_at, sent_at, engage_at, engage_attempts, created_at)
         values ($1, $2, $3, $4, $5, 'builtin-001', $6, 'Quick question', $7, $8::timestamptz,
           $9::timestamptz, $10::timestamptz, $11, $8::timestamptz)",
    )
    .bind(m.id)
    .bind(format!("rwth_{}", m.id))
    .bind(m.step)
    .bind(m.from)
    .bind(m.to)
    .bind(format!("{}@mail.test", m.id))
    .bind(m.status)
    .bind(ts(m.scheduled_at))
    .bind(m.sent_at.map(ts))
    .bind(m.engage_at.map(ts))
    .bind(m.attempts)
    .execute(&world.master)
    .await
    .expect("message");
}

async fn row(world: &World, table: &str, id: &str) -> Value {
    let sql = match table {
        "messages" => "select to_jsonb(t) from reach_warmup_messages t where id = $1",
        _ => "select to_jsonb(t) from reach_warmup_mailboxes t where id = $1",
    };
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_optional(&world.master)
        .await
        .expect("row")
        .unwrap_or(Value::Null)
}

fn text<'v>(row: &'v Value, key: &str) -> &'v str {
    row[key].as_str().unwrap_or_default()
}

fn time(row: &Value, key: &str) -> i64 {
    row[key]
        .as_str()
        .and_then(parse_iso)
        .map(epoch_ms)
        .unwrap_or_default()
}

async fn due_workspaces(world: &World) -> Vec<String> {
    sqlx::query_scalar(
        "select workspace_id from workspace_due_index where kind = 'reach_warmup' order by workspace_id",
    )
    .fetch_all(&world.master)
    .await
    .expect("due")
}

/// A fixed value for every draw.
fn constant(value: f64) -> impl FnMut() -> f64 + Send {
    move || value
}

async fn dispatch_and_send(world: &World) {
    reset(world).await;
    mailbox(world, "a1", "alpha.test", "warming", 3).await;
    mailbox(world, "b1", "beta.test", "warming", 3).await;
    message(world, &Msg::scheduled("m1", "a1", "b1", now() - MINUTE)).await;
    message(world, &Msg::scheduled("m2", "a1", "b1", now() - 7 * HOUR)).await;
    message(world, &Msg::scheduled("m3", "a1", "b1", now() + HOUR)).await;

    let mut rng = constant(0.5);
    let result = run_dispatch(&world.net, &WarmupQueue::Inline, &now, &mut rng)
        .await
        .expect("dispatched");
    assert_eq!((result.expired, result.send_queued), (1, 1));

    let m1 = row(world, "messages", "m1").await;
    assert_eq!(text(&m1, "status"), "sent");
    assert_eq!(time(&m1, "sent_at"), now());
    // 10 + 0.5 * 110 minutes later.
    assert_eq!(time(&m1, "engage_at"), now() + 65 * MINUTE);
    assert_eq!(m1["claimed_at"], Value::Null);
    assert_eq!(
        text(&row(world, "messages", "m2").await, "error"),
        "expired"
    );
    assert_eq!(
        text(&row(world, "messages", "m3").await, "status"),
        "scheduled"
    );

    let sent = world.smtp.sent();
    let (config, envelope, raw) = sent.last().expect("sent");
    assert_eq!(
        (config.host.as_str(), config.port, config.secure),
        ("smtp.mail.test", 465, true)
    );
    assert_eq!(envelope.from, "a1@alpha.test");
    assert_eq!(envelope.to, ["b1@beta.test"]);
    assert!(raw.contains("Message-ID: <m1@mail.test>"), "{raw}");
    assert!(raw.contains("Subject: Quick question"), "{raw}");
    assert!(!raw.to_lowercase().contains("warmup"), "{raw}");

    // A second run finds nothing due.
    let again = run_dispatch(&world.net, &WarmupQueue::Inline, &now, &mut rng)
        .await
        .expect("dispatched");
    assert_eq!(
        (again.expired, again.send_queued, again.engage_queued),
        (0, 0, 0)
    );
}

async fn send_failures(world: &World) {
    reset(world).await;
    mailbox(world, "a1", "alpha.test", "warming", 3).await;
    mailbox(world, "b1", "beta.test", "warming", 3).await;
    mailbox(world, "c1", "gamma.test", "warming", 3).await;
    message(world, &Msg::scheduled("m1", "a1", "b1", now() - MINUTE)).await;
    message(world, &Msg::scheduled("m2", "c1", "b1", now() - MINUTE)).await;
    message(world, &Msg::scheduled("m3", "b1", "a1", now() - MINUTE)).await;
    let mut rng = constant(0.5);

    // A rejected login takes the sender out of the network.
    world.smtp.then(SmtpSendResult {
        ok: false,
        response: "535 5.7.8 Authentication failed".to_owned(),
        stage: "auth".to_owned(),
        permanent: true,
        recipient_rejected: false,
        auth_failed: true,
        delivery_uncertain: false,
    });
    let outcome = process_send(&world.net, "m1", now(), &mut rng).await;
    assert!(matches!(outcome, Ok(SendOutcome::Failed(_))), "{outcome:?}");
    let a1 = row(world, "mailboxes", "a1").await;
    assert_eq!(
        (text(&a1, "status"), text(&a1, "paused_reason")),
        ("error", "login_failed")
    );
    assert_eq!(
        text(&a1, "last_login_error"),
        "smtp: 535 5.7.8 Authentication failed"
    );
    assert_eq!(
        text(&row(world, "messages", "m1").await, "error"),
        "smtp auth: 535 5.7.8 Authentication failed"
    );
    assert_eq!(due_workspaces(world).await, ["ws_a1"]);

    // A login that cannot be opened parks the sender.
    sqlx::query("update reach_warmup_mailboxes set smtp_credentials = 'garbage' where id = 'c1'")
        .execute(&world.master)
        .await
        .expect("update");
    let outcome = process_send(&world.net, "m2", now(), &mut rng).await;
    assert_eq!(
        outcome,
        Ok(SendOutcome::Paused("credentials_unavailable".to_owned()))
    );
    let c1 = row(world, "mailboxes", "c1").await;
    assert_eq!(
        (text(&c1, "status"), text(&c1, "paused_reason")),
        ("paused", "credentials_unavailable")
    );

    // To a mailbox that is out of the network: failed, not sent.
    let outcome = process_send(&world.net, "m3", now(), &mut rng).await;
    assert_eq!(
        outcome,
        Ok(SendOutcome::Failed("mailbox_inactive".to_owned()))
    );

    // Delivery uncertain counts as sent.
    message(world, &Msg::scheduled("m4", "b1", "a1", now() - MINUTE)).await;
    sqlx::query("update reach_warmup_mailboxes set status = 'warming', paused_reason = null where id = 'a1'")
        .execute(&world.master)
        .await
        .expect("update");
    world.smtp.then(SmtpSendResult {
        ok: false,
        response: "timed out".to_owned(),
        stage: "timeout".to_owned(),
        permanent: true,
        recipient_rejected: false,
        auth_failed: false,
        delivery_uncertain: true,
    });
    let outcome = process_send(&world.net, "m4", now(), &mut rng).await;
    assert_eq!(outcome, Ok(SendOutcome::Uncertain));
    let m4 = row(world, "messages", "m4").await;
    assert_eq!(
        (text(&m4, "status"), text(&m4, "error")),
        ("sent", "delivery_uncertain")
    );

    // A message already taken is skipped.
    let outcome = process_send(&world.net, "m4", now(), &mut rng).await;
    assert_eq!(
        outcome,
        Ok(SendOutcome::Skipped("not_scheduled".to_owned()))
    );
}

async fn engagement(world: &World) {
    reset(world).await;
    mailbox(world, "b1", "beta.test", "warming", 3).await;
    let c1 = mailbox(world, "c1", "gamma.test", "warming", 3).await;
    world.imap.add_folder(&c1, "Junk", Some(SpecialUse::Junk));
    world
        .imap
        .deliver(&c1, "Junk", "m1@mail.test")
        .expect("delivered");
    message(world, &Msg::sent("m1", "b1", "c1", now() - HOUR)).await;
    // Engaged at 0.1: flagged (< 0.2), and a reply (0.1 < 0.3 + 0.1 * 0.15).
    let mut rng = constant(0.1);
    let outcome = process_engage(&world.net, "m1", now(), &mut rng).await;
    assert_eq!(
        outcome,
        Ok(EngageOutcome::Engaged {
            placement: "spam",
            reply_scheduled: true
        })
    );
    let m1 = row(world, "messages", "m1").await;
    assert_eq!(
        (text(&m1, "status"), text(&m1, "placement")),
        ("engaged", "spam")
    );
    assert_eq!(
        m1["actions"],
        json!({ "seen": true, "flagged": true, "movedFromSpam": true, "replyScheduled": true })
    );
    assert_eq!(world.imap.messages(&c1, "Junk"), Vec::new());
    let inbox = world.imap.messages(&c1, "INBOX");
    assert_eq!(inbox.len(), 1);
    assert!(inbox[0].flags.contains("\\Seen") && inbox[0].flags.contains("\\Flagged"));

    let reply: Value = sqlx::query_scalar(
        "select to_jsonb(t) from reach_warmup_messages t where in_reply_to = 'm1@mail.test'",
    )
    .fetch_one(&world.master)
    .await
    .expect("reply");
    assert_eq!(text(&reply, "from_mailbox_id"), "c1");
    assert_eq!(text(&reply, "to_mailbox_id"), "b1");
    assert_eq!(reply["step"], json!(1));
    assert_eq!(text(&reply, "thread_id"), "rwth_m1");
    assert_eq!(text(&reply, "references"), "m1@mail.test");
    assert!(text(&reply, "message_id_header").ends_with("@gamma.test"));
    // 20 + 0.1 * 220 minutes: 09:42 UTC, inside the replier's hours.
    assert_eq!(time(&reply, "scheduled_at"), now() + 42 * MINUTE);

    // Retried: the reply is found, none added.
    sqlx::query(
        "update reach_warmup_messages set status = 'sent', claimed_at = null where id = 'm1'",
    )
    .execute(&world.master)
    .await
    .expect("update");
    world.imap.deliver(&c1, "INBOX", "m1@mail.test");
    process_engage(&world.net, "m1", now(), &mut rng)
        .await
        .expect("engaged");
    let replies: i64 = sqlx::query_scalar(
        "select count(*) from reach_warmup_messages where in_reply_to = 'm1@mail.test'",
    )
    .fetch_one(&world.master)
    .await
    .expect("count");
    assert_eq!(replies, 1);
}

async fn engagement_failures(world: &World) {
    reset(world).await;
    mailbox(world, "b1", "beta.test", "warming", 3).await;
    let c1 = mailbox(world, "c1", "gamma.test", "warming", 3).await;
    message(world, &Msg::sent("m1", "b1", "c1", now() - HOUR)).await;
    message(
        world,
        &Msg {
            attempts: 2,
            ..Msg::sent("m2", "b1", "c1", now() - HOUR)
        },
    )
    .await;
    message(world, &Msg::sent("m3", "b1", "c1", now() - HOUR)).await;
    message(world, &Msg::sent("m4", "b1", "c1", now() - HOUR)).await;
    let mut rng = constant(0.9);

    // Not there: again in two hours, and missing after the third miss.
    let outcome = process_engage(&world.net, "m1", now(), &mut rng).await;
    assert_eq!(outcome, Ok(EngageOutcome::Deferred("not_found".to_owned())));
    let m1 = row(world, "messages", "m1").await;
    assert_eq!(
        (m1["engage_attempts"].clone(), time(&m1, "engage_at")),
        (json!(1), now() + 2 * HOUR)
    );
    assert_eq!(
        process_engage(&world.net, "m2", now(), &mut rng).await,
        Ok(EngageOutcome::Missing)
    );
    assert_eq!(
        text(&row(world, "messages", "m2").await, "placement"),
        "missing"
    );

    // A dropped connection: counted, again in 30 minutes.
    world.imap.fail_connect(
        &c1,
        ImapError::new(ImapErrorKind::Connect, "connection reset"),
    );
    let outcome = process_engage(&world.net, "m3", now(), &mut rng).await;
    assert_eq!(
        outcome,
        Ok(EngageOutcome::Deferred("imap_connect".to_owned()))
    );
    assert_eq!(
        time(&row(world, "messages", "m3").await, "engage_at"),
        now() + 30 * MINUTE
    );

    // A rejected login: the recipient leaves the network, the message waits
    // six hours without counting.
    world.imap.add_account(&c1, "changed");
    let outcome = process_engage(&world.net, "m4", now(), &mut rng).await;
    assert_eq!(
        outcome,
        Ok(EngageOutcome::Deferred("login_failed".to_owned()))
    );
    let m4 = row(world, "messages", "m4").await;
    assert_eq!(
        (m4["engage_attempts"].clone(), time(&m4, "engage_at")),
        (json!(0), now() + 6 * HOUR)
    );
    let recipient = row(world, "mailboxes", "c1").await;
    assert_eq!(text(&recipient, "status"), "error");
    assert!(text(&recipient, "last_login_error").starts_with("imap: [AUTHENTICATIONFAILED]"));
    assert_eq!(due_workspaces(world).await, ["ws_c1"]);

    // The kill switch: the claims go back, nothing is worked.
    sqlx::query("update reach_warmup_messages set claimed_at = $1::timestamptz where id = 'm1'")
        .bind(ts(now()))
        .execute(&world.master)
        .await
        .expect("claim");
    let off = world.with_flags(Arc::new(
        StaticFlags::new().with("weldreach-warmup", json!(false)),
    ));
    let body = br#"{"messageId":"m1"}"#;
    let dispositions = handle_batch(
        &off,
        WarmupQueueKind::Engage,
        &[&body[..], &b"junk"[..]],
        now(),
        &mut rng,
    )
    .await;
    assert_eq!(dispositions.len(), 2);
    assert_eq!(
        row(world, "messages", "m1").await["claimed_at"],
        Value::Null
    );
}

async fn login_recheck_and_planner(world: &World) {
    reset(world).await;
    mailbox(world, "a1", "alpha.test", "warming", 3).await;
    mailbox(world, "b1", "beta.test", "warming", 3).await;
    let mut rng = constant(0.3);

    // Two domains: too small a pool.
    let result = run_planner(&world.net, now(), &mut rng)
        .await
        .expect("planned");
    assert_eq!((result.status, result.pool_domains), ("pool_too_small", 2));

    // A third domain, and a mailbox back from a login error.
    mailbox(world, "c1", "gamma.test", "waiting", 0).await;
    mailbox(world, "d1", "delta.test", "error", 5).await;
    sqlx::query("update reach_warmup_mailboxes set paused_reason = 'login_failed' where id = 'd1'")
        .execute(&world.master)
        .await
        .expect("update");
    let result = run_planner(&world.net, now(), &mut rng)
        .await
        .expect("planned");
    assert_eq!(result.status, "ok");
    assert_eq!((result.logins_restored, result.started), (1, 1));
    assert_eq!(result.pool_mailboxes, 4);
    assert_eq!(result.mailboxes_planned, 4);
    let d1 = row(world, "mailboxes", "d1").await;
    assert_eq!(
        (text(&d1, "status"), d1["paused_reason"].clone()),
        ("warming", Value::Null)
    );
    let c1 = row(world, "mailboxes", "c1").await;
    assert_eq!(
        (text(&c1, "status"), c1["ramp_day"].clone()),
        ("warming", json!(1))
    );
    assert_eq!(text(&c1, "planned_for"), "2026-10-13");

    let planned: Vec<(String, String, i32)> = sqlx::query_as(
        "select from_mailbox_id, to_mailbox_id, step from reach_warmup_messages where status = 'scheduled'",
    )
    .fetch_all(&world.master)
    .await
    .expect("planned");
    assert_eq!(planned.len(), result.messages_planned);
    assert_ne!(planned.len(), 0);
    for (from, to, step) in &planned {
        assert_ne!(from, to);
        assert_eq!(*step, 0);
    }

    // The same local day again: nobody is planned twice.
    let again = run_planner(&world.net, now() + 30 * MINUTE, &mut rng)
        .await
        .expect("planned");
    assert_eq!((again.mailboxes_planned, again.messages_planned), (0, 0));
}

async fn daily_and_cleanup(world: &World) {
    reset(world).await;
    let a1 = mailbox(world, "a1", "alpha.test", "warming", 13).await;
    let b1 = mailbox(world, "b1", "beta.test", "maintaining", 20).await;
    mailbox(world, "c1", "gamma.test", "warming", 4).await;
    mailbox(world, "p1", "pi.test", "paused", 20).await;
    sqlx::query(
        "update reach_warmup_mailboxes set paused_reason = 'low_inbox_rate', updated_at = $1::timestamptz where id = 'p1'",
    )
    .bind(ts(now() - 4 * DAY))
    .execute(&world.master)
    .await
    .expect("update");
    let daily_now = at("2026-10-13T02:30:00.000Z");
    // a1 sent yesterday (UTC); c1 did not.
    message(world, &Msg::sent("y1", "a1", "b1", daily_now - 10 * HOUR)).await;
    // b1's mail landed in spam: twelve judged, none in the inbox.
    for n in 0..12 {
        let id = format!("s{n}");
        message(world, &Msg::sent(&id, "b1", "c1", daily_now - 2 * DAY)).await;
        sqlx::query(
            "update reach_warmup_messages set status = 'engaged', placement = 'spam' where id = $1",
        )
        .bind(&id)
        .execute(&world.master)
        .await
        .expect("update");
    }
    // An engaged message old enough to clean, in both mailboxes.
    message(world, &Msg::sent("old", "a1", "b1", daily_now - 15 * DAY)).await;
    sqlx::query(
        "update reach_warmup_messages set status = 'engaged', placement = 'inbox' where id = 'old'",
    )
    .execute(&world.master)
    .await
    .expect("update");
    for (email, folder, special) in [
        (&b1, "Trash", SpecialUse::Trash),
        (&a1, "Trash", SpecialUse::Trash),
        (&a1, "Sent", SpecialUse::Sent),
    ] {
        world.imap.add_folder(email, folder, Some(special));
    }
    world.imap.deliver(&b1, "INBOX", "old@mail.test");
    world.imap.deliver(&a1, "Sent", "old@mail.test");
    // A row past its retention.
    message(
        world,
        &Msg::sent("ancient", "a1", "b1", daily_now - 31 * DAY),
    )
    .await;

    let result = run_daily(&world.net, daily_now).await;
    assert_eq!((result.advanced, result.graduated), (1, 1));
    assert_eq!(result.auto_paused, ["b1"]);
    assert_eq!(result.resumed, ["p1"]);
    let cleanup = result.cleanup.expect("cleanup");
    assert_eq!(
        (
            cleanup.cleaned,
            cleanup.mailboxes_visited,
            cleanup.rows_deleted
        ),
        (1, 2, 1)
    );

    let a1_row = row(world, "mailboxes", "a1").await;
    assert_eq!(
        (text(&a1_row, "status"), a1_row["ramp_day"].clone()),
        ("maintaining", json!(14))
    );
    assert_eq!(row(world, "mailboxes", "c1").await["ramp_day"], json!(4));
    let b1_row = row(world, "mailboxes", "b1").await;
    assert_eq!(
        (text(&b1_row, "status"), text(&b1_row, "paused_reason")),
        ("paused", "low_inbox_rate")
    );
    assert_eq!(b1_row["stats"]["spam3d"], json!(12));
    assert_eq!(b1_row["stats"]["inboxRate3d"], json!(0));
    assert_eq!(
        text(&row(world, "mailboxes", "p1").await, "status"),
        "maintaining"
    );
    assert_eq!(world.imap.messages(&b1, "INBOX"), Vec::new());
    assert_eq!(world.imap.messages(&b1, "Trash"), Vec::new());
    assert_eq!(world.imap.messages(&a1, "Sent"), Vec::new());
    assert_ne!(
        row(world, "messages", "old").await["cleaned_at"],
        Value::Null
    );
    assert_eq!(row(world, "messages", "ancient").await, Value::Null);
    let mut due = due_workspaces(world).await;
    due.sort();
    assert_eq!(due, ["ws_b1", "ws_p1"]);

    // A second run the same day advances nobody.
    let again = run_daily(&world.net, daily_now + HOUR).await;
    assert_eq!(again.advanced, 0);
}

#[tokio::test]
async fn the_warmup_network_on_the_master_schema() {
    let Some(world) = world().await else {
        eprintln!("skipped: WELDSUITE_TEST_MASTER_URL is not set");
        return;
    };
    dispatch_and_send(&world).await;
    send_failures(&world).await;
    engagement(&world).await;
    engagement_failures(&world).await;
    login_recheck_and_planner(&world).await;
    daily_and_cleanup(&world).await;
    reset(&world).await;
}
