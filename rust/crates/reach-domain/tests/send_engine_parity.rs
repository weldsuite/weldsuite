//! Parity with reach-api's send engine. Its `src/testing/rust-fixtures.test.ts`
//! ran the TypeScript scheduler and whole send ticks on pglite and wrote
//! what they did into `tests/fixtures/send_*.json`. These tests run the Rust
//! port on the same input and compare: the scheduler's answers, and for each
//! tick its result, the rows it left, its entity events and its SMTP sends.
//!
//! The tick tests need `WELDSUITE_TEST_TENANT_URL` (a tenant database built
//! by `scripts/rust-test-db.ts`) and skip without it. Regenerate the
//! fixtures with `pnpm rust:reach-engine-fixtures`.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::Keyring;
use weldsuite_ports::BoxFuture;
use weldsuite_reach_domain::engine::scheduler::{
    CampaignGate, PlanCampaign, PlanContext, PlanEnrollment, PlanMailbox, assess_mailboxes,
    evaluate_campaign_gate, gap_ends_at, jitter_fraction, mailbox_capacity, next_step_due_at,
    plan_sends,
};
use weldsuite_reach_domain::engine::tick::{TickDeps, run_send_tick};
use weldsuite_reach_domain::schemas::resolve_limits;
use weldsuite_reach_domain::send_window::SendSchedule;
use weldsuite_reach_domain::smtp::{SmtpConfig, SmtpEnvelope, SmtpSendResult, SmtpTransport};
use weldsuite_reach_domain::{EventSink, ReachEvent, epoch_ms, from_epoch_ms, iso, parse_iso};

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).expect("the fixture exists");
    serde_json::from_str(&text).expect("the fixture is JSON")
}

// ---------------------------------------------------------------------------
// Normalisation (the generator's `Placeholders`)
// ---------------------------------------------------------------------------

/// `^(rmsg|rsup)_[0-9a-z]{12,}$`: an id `generateId` made.
fn is_generated_id(text: &str) -> bool {
    let Some((prefix, rest)) = text.split_once('_') else {
        return false;
    };
    matches!(prefix, "rmsg" | "rsup")
        && rest.len() >= 12
        && rest
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
}

/// `^[0-9a-f]{32}\.[0-9a-z]+@(.+)$`: a generated Message-ID; its domain.
fn generated_message_id(text: &str) -> Option<&str> {
    let (local, domain) = text.split_once('@')?;
    let (hex, time) = local.split_once('.')?;
    (hex.len() == 32
        && hex
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && !time.is_empty()
        && time
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
        && !domain.is_empty())
    .then_some(domain)
}

fn is_iso(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() >= 20
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && text.ends_with('Z')
}

#[derive(Default)]
struct Placeholders {
    ids: HashMap<String, String>,
    counters: HashMap<String, usize>,
}

impl Placeholders {
    fn of(&mut self, prefix: &str, value: &str) -> String {
        if let Some(known) = self.ids.get(value) {
            return known.clone();
        }
        let n = self.counters.entry(prefix.to_owned()).or_default();
        *n += 1;
        let placeholder = format!("<{prefix}:{n}>");
        self.ids.insert(value.to_owned(), placeholder.clone());
        placeholder
    }

    fn text(&mut self, value: &str, key: &str) -> Value {
        if is_generated_id(value) {
            return Value::String(self.of(&value[..4], value));
        }
        if key == "references" {
            let parts: Vec<String> = value
                .split(' ')
                .map(|v| self.text(v, "").as_str().unwrap_or_default().to_owned())
                .collect();
            return Value::String(parts.join(" "));
        }
        if let Some(domain) = generated_message_id(value) {
            return Value::String(format!("{}@{domain}", self.of("mid", value)));
        }
        if is_iso(value) {
            if value >= "2026-11" {
                return Value::String("<ts>".to_owned());
            }
            return Value::String(parse_iso(value).map_or_else(|| value.to_owned(), iso));
        }
        Value::String(value.to_owned())
    }

    fn json(&mut self, value: &Value, key: &str) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(|v| self.json(v, "")).collect()),
            Value::Object(map) => {
                // serde_json keeps keys sorted, as the generator sorts them.
                let mut out = Map::new();
                for (k, v) in map {
                    if (k == "smtpCredentials" || k == "imapCredentials") && !v.is_null() {
                        out.insert(k.clone(), Value::String("<sealed>".to_owned()));
                        continue;
                    }
                    out.insert(k.clone(), self.json(v, k));
                }
                Value::Object(out)
            }
            Value::String(text) => self.text(text, key),
            other => other.clone(),
        }
    }
}

/// The generator writes integral numbers as JSON integers; compare numbers
/// by value.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|other| same(v, other)))
        }
        _ => a == b,
    }
}

fn assert_same(label: &str, actual: &Value, expected: &Value) {
    assert!(
        same(actual, expected),
        "{label}: differs\n--- rust\n{}\n--- typescript\n{}",
        serde_json::to_string_pretty(actual).unwrap_or_default(),
        serde_json::to_string_pretty(expected).unwrap_or_default()
    );
}

fn ms(value: &Value) -> Option<i64> {
    value.as_str().and_then(parse_iso).map(epoch_ms)
}

fn date(ms: Option<i64>) -> Value {
    ms.map_or(Value::Null, |ms| Value::String(iso(from_epoch_ms(ms))))
}

// ---------------------------------------------------------------------------
// The scheduler rules
// ---------------------------------------------------------------------------

fn schedule(value: &Value) -> SendSchedule {
    SendSchedule {
        timezone: value["timezone"].as_str().unwrap_or_default().to_owned(),
        send_days: value["sendDays"]
            .as_array()
            .map(|d| d.iter().filter_map(Value::as_i64).collect())
            .unwrap_or_default(),
        window_start: value["windowStart"].as_str().unwrap_or_default().to_owned(),
        window_end: value["windowEnd"].as_str().unwrap_or_default().to_owned(),
    }
}

fn plan_mailbox(value: &Value) -> PlanMailbox {
    PlanMailbox {
        id: value["id"].as_str().unwrap_or_default().to_owned(),
        status: value["status"].as_str().unwrap_or_default().to_owned(),
        daily_cap: value["dailyCap"].as_i64().unwrap_or_default(),
        ramp_current: value["rampCurrent"].as_i64().unwrap_or_default(),
        last_sent_at: ms(&value["lastSentAt"]),
        sent_today: value["sentToday"].as_i64().unwrap_or_default(),
    }
}

fn plan_campaign(value: &Value) -> PlanCampaign {
    PlanCampaign {
        id: value["id"].as_str().unwrap_or_default().to_owned(),
        schedule: schedule(&value["schedule"]),
        daily_limit: value["dailyLimit"].as_i64().unwrap_or_default(),
        min_gap_minutes: value["minGapMinutes"].as_i64().unwrap_or_default(),
        sent_today: value["sentToday"].as_i64().unwrap_or_default(),
        mailbox_ids: value["mailboxIds"]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn gate_json(gate: &CampaignGate) -> Value {
    match gate {
        CampaignGate::Open => json!({ "open": true }),
        CampaignGate::Closed { reason, reopens_at } => {
            json!({ "open": false, "reason": reason, "reopensAt": date(Some(*reopens_at)) })
        }
    }
}

#[test]
#[allow(clippy::too_many_lines, reason = "one fixture, every rule in turn")]
fn the_scheduler_rules() {
    let f = fixture("send_scheduler");
    let t0 = epoch_ms(parse_iso("2026-10-12T10:00:00.000Z").expect("T0"));
    for case in f["jitter"].as_array().expect("jitter") {
        let seed = case["seed"].as_str().unwrap_or_default();
        assert_eq!(
            jitter_fraction(seed),
            case["value"].as_f64().unwrap_or(-1.0),
            "jitter {seed}"
        );
    }
    let mailboxes: Vec<PlanMailbox> = f["mailboxes"]
        .as_array()
        .expect("mailboxes")
        .iter()
        .map(plan_mailbox)
        .collect();
    let campaigns: Vec<PlanCampaign> = f["campaigns"]
        .as_array()
        .expect("campaigns")
        .iter()
        .map(plan_campaign)
        .collect();
    let gaps: Vec<Value> = mailboxes
        .iter()
        .map(|m| json!({ "capacity": mailbox_capacity(m), "gapEndsAt": date(gap_ends_at(m, 8)), "id": m.id }))
        .collect();
    assert_same("gaps", &Value::Array(gaps), &f["gaps"]);
    let ctx = |overrides: &Value| PlanContext {
        now: ms(&overrides["now"]).unwrap_or(t0),
        day_timezone: "Europe/Amsterdam".to_owned(),
        max_daily_sends: overrides["maxDailySends"].as_i64().unwrap_or(300),
        workspace_sent_today: overrides["workspaceSentToday"].as_i64().unwrap_or(10),
    };
    for case in f["gates"].as_array().expect("gates") {
        let campaign = campaigns
            .iter()
            .find(|c| c.id == case["campaign"].as_str().unwrap_or_default())
            .expect("the campaign");
        let gate = evaluate_campaign_gate(campaign, &ctx(case));
        assert_same(&format!("gate {case}"), &gate_json(&gate), &case["gate"]);
    }
    let open: Vec<&PlanCampaign> = campaigns.iter().take(2).collect();
    let readiness = assess_mailboxes(&mailboxes, &open, t0);
    let sorted = |set: &std::collections::HashSet<String>| {
        let mut v: Vec<&String> = set.iter().collect();
        v.sort();
        json!(v)
    };
    assert_same(
        "readiness",
        &json!({
            "ready": sorted(&readiness.ready),
            "gapBlockedUntil": date(readiness.gap_blocked_until),
            "unusable": sorted(&readiness.unusable),
            "capped": sorted(&readiness.capped),
        }),
        &f["readiness"],
    );
    let claimed: Vec<PlanEnrollment> = f["claimed"]
        .as_array()
        .expect("claimed")
        .iter()
        .map(|e| PlanEnrollment {
            id: e["id"].as_str().unwrap_or_default().to_owned(),
            campaign_id: e["campaignId"].as_str().unwrap_or_default().to_owned(),
            mailbox_id: e["mailboxId"].as_str().map(str::to_owned),
        })
        .collect();
    let by_id: HashMap<String, PlanCampaign> = campaigns
        .iter()
        .map(|c| (c.id.clone(), c.clone()))
        .collect();
    let mailbox_map: HashMap<String, PlanMailbox> = mailboxes
        .iter()
        .map(|m| (m.id.clone(), m.clone()))
        .collect();
    for case in f["plans"].as_array().expect("plans") {
        let plan = plan_sends(&ctx(case), &by_id, &mailbox_map, &claimed);
        let actual = json!({
            "sends": plan.sends.iter().map(|s| json!({ "campaignId": s.campaign_id, "enrollmentId": s.enrollment_id, "mailboxId": s.mailbox_id })).collect::<Vec<_>>(),
            "deferrals": plan.deferrals.iter().map(|d| json!({ "enrollmentId": d.enrollment_id, "reason": d.reason, "until": date(d.until) })).collect::<Vec<_>>(),
            "retryAt": date(plan.retry_at),
        });
        assert_same(
            &format!("plan {}", case["workspaceSentToday"]),
            &actual,
            &case["plan"],
        );
    }
    let window = schedule(&f["schedule"]);
    for case in f["nextSteps"].as_array().expect("nextSteps") {
        let due = next_step_due_at(
            ms(&case["sentAt"]).expect("sentAt"),
            case["delayDays"].as_i64().unwrap_or_default(),
            case["delayHours"].as_i64().unwrap_or_default(),
            &window,
        );
        assert_same(
            &format!("next step {case}"),
            &date(Some(due)),
            &case["dueAt"],
        );
    }
}

// ---------------------------------------------------------------------------
// Whole ticks
// ---------------------------------------------------------------------------

/// SMTP answering by recipient, as the generator's `sendMail` stub.
struct FakeSmtp {
    answers: Map<String, Value>,
    calls: Mutex<Vec<Value>>,
}

impl SmtpTransport for FakeSmtp {
    fn send(
        &self,
        config: SmtpConfig,
        envelope: SmtpEnvelope,
        _raw: String,
    ) -> BoxFuture<'_, Result<SmtpSendResult, String>> {
        self.calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(json!({
                "from": envelope.from,
                "host": config.host,
                "port": config.port,
                "secure": config.secure,
                "to": envelope.to,
                "username": config.username,
            }));
        let answer = self
            .answers
            .get(envelope.to.first().map_or("", String::as_str))
            .cloned();
        Box::pin(async move {
            match answer {
                Some(Value::String(s)) if s == "throw" => Err("socket closed".to_owned()),
                Some(answer) => Ok(SmtpSendResult::from_json(&answer)),
                None => Ok(SmtpSendResult {
                    ok: true,
                    response: "250 2.0.0 OK".to_owned(),
                    stage: String::new(),
                    permanent: false,
                    recipient_rejected: false,
                    auth_failed: false,
                    delivery_uncertain: false,
                }),
            }
        })
    }
}

#[derive(Default)]
struct RecordingEvents(Mutex<Vec<Value>>);

impl EventSink for RecordingEvents {
    fn emit(&self, event: ReachEvent) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(json!({ "data": event.data, "entityId": event.entity_id, "event": event.event.wire() }));
    }
}

async fn tenant() -> Option<PgPool> {
    let url = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
    Some(PgPool::connect(&url).await.expect("the tenant database"))
}

async fn reset(db: &PgPool) {
    for sql in [
        "delete from reach_messages",
        "delete from reach_enrollments",
        "delete from reach_campaign_mailboxes",
        "delete from reach_campaign_steps",
        "delete from reach_campaigns",
        "delete from reach_prospect_list_members",
        "delete from reach_prospect_lists",
        "delete from reach_prospects",
        "delete from reach_suppressions",
        "delete from reach_mailboxes",
        "delete from reach_settings",
    ] {
        sqlx::query(sql).execute(db).await.expect(sql);
    }
}

async fn seed(db: &PgPool, seed: &Value) {
    let tables: [(&str, &str); 9] = [
        (
            "reach_settings",
            "insert into reach_settings select * from jsonb_populate_record(null::reach_settings, $1)",
        ),
        (
            "reach_mailboxes",
            "insert into reach_mailboxes select * from jsonb_populate_record(null::reach_mailboxes, $1)",
        ),
        (
            "reach_campaigns",
            "insert into reach_campaigns select * from jsonb_populate_record(null::reach_campaigns, $1)",
        ),
        (
            "reach_campaign_steps",
            "insert into reach_campaign_steps select * from jsonb_populate_record(null::reach_campaign_steps, $1)",
        ),
        (
            "reach_campaign_mailboxes",
            "insert into reach_campaign_mailboxes select * from jsonb_populate_record(null::reach_campaign_mailboxes, $1)",
        ),
        (
            "reach_prospects",
            "insert into reach_prospects select * from jsonb_populate_record(null::reach_prospects, $1)",
        ),
        (
            "reach_enrollments",
            "insert into reach_enrollments select * from jsonb_populate_record(null::reach_enrollments, $1)",
        ),
        (
            "reach_messages",
            "insert into reach_messages select * from jsonb_populate_record(null::reach_messages, $1)",
        ),
        (
            "reach_suppressions",
            "insert into reach_suppressions select * from jsonb_populate_record(null::reach_suppressions, $1)",
        ),
    ];
    for (table, sql) in tables {
        for row in seed[table].as_array().into_iter().flatten() {
            sqlx::query(sql)
                .bind(row)
                .execute(db)
                .await
                .unwrap_or_else(|e| panic!("seeding {table}: {e}"));
        }
    }
}

async fn rows(db: &PgPool, sql: &'static str) -> Vec<Value> {
    let rows: Vec<Value> = sqlx::query_scalar(sql).fetch_all(db).await.expect(sql);
    rows.into_iter().map(weldsuite_db::js_row).collect()
}

/// The generator's `snapshot()`.
async fn snapshot(db: &PgPool) -> Value {
    let text = |row: &Value, key: &str| row[key].as_str().unwrap_or_default().to_owned();
    let by_id = |mut rows: Vec<Value>| {
        rows.sort_by_key(|r| text(r, "id"));
        Value::Array(rows)
    };
    let mut messages = rows(db, "select to_jsonb(t) from reach_messages t").await;
    messages.sort_by_key(|m| {
        let id = text(m, "id");
        let tail = if is_generated_id(&id) {
            "~".to_owned()
        } else {
            id
        };
        format!("{}|{}|{tail}", text(m, "enrollmentId"), text(m, "stepId"))
    });
    let mut suppressions = rows(db, "select to_jsonb(t) from reach_suppressions t").await;
    suppressions.sort_by_key(|s| text(s, "value"));
    json!({
        "reach_campaigns": by_id(rows(db, "select to_jsonb(t) from reach_campaigns t").await),
        "reach_enrollments": by_id(rows(db, "select to_jsonb(t) from reach_enrollments t").await),
        "reach_mailboxes": by_id(rows(db, "select to_jsonb(t) from reach_mailboxes t").await),
        "reach_messages": messages,
        "reach_suppressions": suppressions,
    })
}

#[tokio::test]
async fn whole_send_ticks() {
    let Some(db) = tenant().await else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set: skipping the send-tick parity");
        return;
    };
    let f = fixture("send_ticks");
    let keyring = Keyring {
        v1: Some(format!("{}1", "0".repeat(63))),
        v2: None,
    };
    for scenario in f["scenarios"].as_array().expect("scenarios") {
        let name = scenario["name"].as_str().unwrap_or_default();
        reset(&db).await;
        seed(&db, &scenario["seed"]).await;
        let smtp = FakeSmtp {
            answers: scenario["answers"].as_object().cloned().unwrap_or_default(),
            calls: Mutex::new(Vec::new()),
        };
        let events = RecordingEvents::default();
        let limits = resolve_limits(Some(&scenario["limits"]));
        let now: OffsetDateTime =
            parse_iso(scenario["now"].as_str().unwrap_or_default()).expect("now");
        let clock = move || now;
        let result = run_send_tick(&TickDeps {
            db: &db,
            keyring: &keyring,
            transport: &smtp,
            events: &events,
            limits: &limits,
            clock: &clock,
        })
        .await
        .unwrap_or_else(|e| panic!("{name}: the tick failed: {}", e.message));
        let mut events = events.0.into_inner().unwrap_or_default();
        events.sort_by_key(|e| {
            format!(
                "{}|{}",
                e["event"].as_str().unwrap_or_default(),
                e["entityId"].as_str().unwrap_or_default()
            )
        });
        let mut sends = smtp.calls.into_inner().unwrap_or_default();
        sends.sort_by_key(|s| s["to"][0].as_str().unwrap_or_default().to_owned());
        let actual = json!({
            "events": events,
            "result": result.to_json(),
            "rows": snapshot(&db).await,
            "smtp": sends,
        });
        let actual = Placeholders::default().json(&actual, "");
        assert_same(name, &actual, &scenario["expected"]);
    }
    reset(&db).await;
}
