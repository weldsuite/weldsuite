//! The meeting-AI job (`MeetingAiJob`, the Rust twin of meet-domain's
//! `MeetingAiWorkflow`) end to end on the real schema, as meet-api's
//! `workflows.test.ts` runs the Workflow: a session with stored MP3 parts in
//! a fake recordings bucket, the model faked at the HTTP port
//! (`weldsuite_ai::FakeProvider`), the transcript and summary written to the
//! tenant database and charged per meeting minute in the master wallet.
//!
//! Runs when `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL` are
//! set (databases built from the journaled migrations by
//! `scripts/rust-test-db.ts`); otherwise every test returns early.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use weldsuite_ai::config::Endpoint;
use weldsuite_ai::{Ai, AiConfig, FakeProvider, ProviderId};
use weldsuite_db::PgPool;
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::generate_id;
use weldsuite_mail_domain::outbound::OutboundBindings;
use weldsuite_meet::{
    Listed, MeetState, MeetWorkflows, MeetingAiJob, RecordingsBucket, TenantDatabases,
};
use weldsuite_ports::{
    BoxFuture, Job, JobContext, JobError, ObjectInfo, PortError, StepFn, StepRetry,
};

/// MPEG-1 Layer III, 128 kbps, 44.1 kHz: 417 bytes and 1152 samples a frame.
const FRAME: usize = 417;
const CHUNK_BYTES: usize = 4 * 1024 * 1024;

fn mp3(frames: usize) -> Vec<u8> {
    let mut out = vec![0; frames * FRAME];
    for i in 0..frames {
        out[i * FRAME..i * FRAME + 4].copy_from_slice(&[0xff, 0xfb, 0x90, 0x00]);
    }
    out
}

fn seconds_of(frames: usize) -> f64 {
    #[allow(clippy::cast_precision_loss)]
    let frames = frames as f64;
    frames * 1152.0 / 44_100.0
}

struct Databases {
    tenant: PgPool,
    master: PgPool,
}

/// One connection with unnamed statements: also right for a local run
/// against pglite over pglite-socket, which is one Postgres session for
/// every connection (as the conformance harness serves it).
fn pool(url: &str) -> PgPool {
    let options: PgConnectOptions = url.parse().expect("a Postgres URL");
    PgPoolOptions::new()
        .max_connections(1)
        .connect_lazy_with(options.statement_cache_capacity(0))
}

fn databases() -> Option<Databases> {
    let master = std::env::var("WELDSUITE_TEST_MASTER_URL").ok()?;
    let tenant = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
    Some(Databases {
        tenant: pool(&tenant),
        master: pool(&master),
    })
}

/// A recordings bucket over a map.
#[derive(Default)]
struct Bucket(HashMap<String, Vec<u8>>);

impl RecordingsBucket for Bucket {
    fn head<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<ObjectInfo>, PortError>> {
        let info = self.0.get(key).map(|bytes| ObjectInfo {
            size: bytes.len() as u64,
            ..ObjectInfo::default()
        });
        Box::pin(std::future::ready(Ok(info)))
    }

    fn get<'a>(
        &'a self,
        key: &'a str,
        range: Option<(u64, u64)>,
    ) -> BoxFuture<'a, Result<Option<Vec<u8>>, PortError>> {
        let bytes = self.0.get(key).map(|bytes| match range {
            Some((offset, length)) => {
                let start = usize::try_from(offset).expect("offset").min(bytes.len());
                let end = (start + usize::try_from(length).expect("length")).min(bytes.len());
                bytes[start..end].to_vec()
            }
            None => bytes.clone(),
        });
        Box::pin(std::future::ready(Ok(bytes)))
    }

    fn list<'a>(
        &'a self,
        _prefix: &'a str,
        _cursor: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Listed, PortError>> {
        Box::pin(std::future::ready(Ok(Listed::default())))
    }

    fn delete_many<'a>(&'a self, _keys: &'a [String]) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(std::future::ready(Ok(())))
    }
}

/// Runs every step inline, once (`step.do` without retries).
struct Inline;

impl JobContext for Inline {
    fn key(&self) -> &'static str {
        "test"
    }

    fn run_step<'s>(
        &'s self,
        _name: &'s str,
        _retry: StepRetry,
        step: &'s StepFn<'s>,
    ) -> BoxFuture<'s, Result<Value, JobError>> {
        step()
    }
}

fn job(dbs: &Databases, bucket: Bucket, fake: &FakeProvider) -> MeetingAiJob {
    let tenant = dbs.tenant.clone();
    let tenants: TenantDatabases = Arc::new(move |_org: String| {
        let tenant = tenant.clone();
        Box::pin(async move { Ok(tenant) })
    });
    let ai = Ai::fake(
        AiConfig {
            default_provider: Some(ProviderId::Mistral),
            mistral: Endpoint {
                base_url: "https://api.mistral.ai/v1".to_owned(),
                api_key: Some("key".to_owned()),
            },
            ..AiConfig::default()
        },
        fake.clone(),
    );
    MeetingAiJob {
        state: MeetState {
            events: EntityEventPublisher::new(None, TaskTracker::new()),
            cache: None,
            master: Some(dbs.master.clone()),
            realtime: None,
            video: None,
            http: None,
            outbound: OutboundBindings::default(),
            files: None,
            recordings: Some(Arc::new(bucket)),
            workflows: MeetWorkflows::default(),
            tenants: Some(tenants),
            livekit: None,
            ai: Some(ai),
        },
    }
}

/// A workspace whose Clerk org is `org`, with `balance` credits.
async fn workspace(master: &PgPool, org: &str, balance: i32) -> String {
    let id = generate_id("ws");
    sqlx::query("insert into workspaces (id, name, slug, clerk_org_id) values ($1, $1, $1, $2)")
        .bind(&id)
        .bind(org)
        .execute(master)
        .await
        .expect("workspace");
    sqlx::query(
        "insert into workspace_credits (id, workspace_id, current_balance, plan_credits, \
         subscribed_credits, monthly_allocation, rolled_over_credits, period_start, period_end) \
         values ($1, $2, $3, 0, 0, 0, 0, now(), now() + interval '30 days')",
    )
    .bind(generate_id("wcr"))
    .bind(&id)
    .bind(balance)
    .execute(master)
    .await
    .expect("wallet");
    id
}

/// An ended session of `duration` seconds (`seedMeetingWithSession`).
async fn session(tenant: &PgPool, duration: i32) -> String {
    let meeting = generate_id("meet");
    let session = generate_id("msess");
    sqlx::query(
        "insert into meetings (id, title, organizer_id) values ($1, 'Weekly sync', 'user_1')",
    )
    .bind(&meeting)
    .execute(tenant)
    .await
    .expect("meeting");
    sqlx::query(
        "insert into meeting_sessions (id, meeting_id, started_by, started_by_name, status, \
         duration) values ($1, $2, 'user_1', 'Host', 'ended', $3)",
    )
    .bind(&session)
    .bind(&meeting)
    .bind(duration)
    .execute(tenant)
    .await
    .expect("session");
    session
}

/// The session's stored recording: `parts` ready, the last one's audio.
async fn recorded(tenant: &PgPool, session: &str, parts: &Value, audio_key: &str) {
    sqlx::query(
        "update meeting_sessions set recording_status = 'ready', recording_parts = $2::jsonb, \
         recording_audio_key = $3 where id = $1",
    )
    .bind(session)
    .bind(parts)
    .bind(audio_key)
    .execute(tenant)
    .await
    .expect("recording");
}

async fn session_value(tenant: &PgPool, id: &str) -> Value {
    sqlx::query_scalar("select to_jsonb(s) from meeting_sessions s where id = $1")
        .bind(id)
        .fetch_one(tenant)
        .await
        .expect("session row")
}

async fn transcription(tenant: &PgPool, session: &str) -> Value {
    sqlx::query_scalar("select to_jsonb(t) from crm_transcriptions t where activity_id = $1")
        .bind(session)
        .fetch_one(tenant)
        .await
        .expect("transcription row")
}

async fn ledger(master: &PgPool, key: &str) -> Option<(String, i32)> {
    sqlx::query_as("select type, amount from credit_transactions where idempotency_key = $1")
        .bind(key)
        .fetch_optional(master)
        .await
        .expect("ledger")
}

fn part(org: &str, session: &str, id: &str, duration: i32) -> Value {
    json!({
        "rtkRecordingId": id,
        "videoKey": null,
        "audioKey": format!("{org}/{session}/{id}.mp3"),
        "sizeBytes": 1,
        "durationSeconds": duration,
        "startedAt": "2026-11-02T10:00:00.000Z",
        "stoppedAt": null,
        "status": "ready",
    })
}

async fn transcribe_afterwards_hears_every_part_in_chunks_and_bills_the_capped_minutes(
    dbs: &Databases,
) {
    let org = generate_id("org");
    let wallet = workspace(&dbs.master, &org, 100).await;
    // Part 1 spans two chunks, part 2 is one short chunk.
    let frames_1 = CHUNK_BYTES / FRAME + 2000;
    let (audio_1, audio_2) = (mp3(frames_1), mp3(400));
    let sid = session(&dbs.tenant, 310).await;
    let parts = json!([
        part(&org, &sid, "rec_a", 300),
        part(&org, &sid, "rec_b", 20)
    ]);
    let key = |id: &str| format!("{org}/{sid}/{id}.mp3");
    recorded(&dbs.tenant, &sid, &parts, &key("rec_b")).await;
    let tid = generate_id("trans");
    sqlx::query(
        "insert into crm_transcriptions (id, activity_id, status, language) values ($1, $2, 'pending', 'nl')",
    )
    .bind(&tid)
    .bind(&sid)
    .execute(&dbs.tenant)
    .await
    .expect("pending transcription");

    let bucket = Bucket(HashMap::from([
        (key("rec_a"), audio_1),
        (key("rec_b"), audio_2),
    ]));
    let fake = FakeProvider::new()
        .reply_text("chunk 1")
        .reply_text("chunk 2")
        .reply_text("chunk 3");
    let payload = json!({
        "kind": "whisper-transcribe", "orgId": org, "sessionId": sid,
        "transcriptionId": tid, "userId": "user_1", "language": "nl-NL",
    });
    job(dbs, bucket, &fake)
        .run(&Inline, payload)
        .await
        .expect("run");

    let calls = fake.calls();
    assert_eq!(calls.len(), 3, "two chunks of part 1, one of part 2");
    assert!(
        calls
            .iter()
            .all(|c| c.url.ends_with("/audio/transcriptions"))
    );

    let row = transcription(&dbs.tenant, &sid).await;
    assert_eq!(row["id"], json!(tid));
    assert_eq!(row["status"], json!("completed"));
    assert_eq!(row["provider"], json!("mistral"));
    assert_eq!(row["model"], json!("mistral/voxtral-mini-transcribe-3-0"));
    assert_eq!(row["language"], json!("nl"));
    assert_eq!(row["full_text"], json!("chunk 1 chunk 2 chunk 3"));
    assert_eq!(row["word_count"], json!(6));
    assert_eq!(row["speaker_count"], json!(1));
    assert_eq!(row["metadata"]["source"], json!("whisper"));
    assert_eq!(row["metadata"]["billedSeconds"].as_f64(), Some(310.0));

    let segments: Vec<(String, f32, i32, String)> = sqlx::query_as(
        "select text, start_time, speaker_id, timestamp from crm_transcript_segments \
         where transcription_id = $1 order by sequence_number",
    )
    .bind(&tid)
    .fetch_all(&dbs.tenant)
    .await
    .expect("segments");
    assert_eq!(
        segments.iter().map(|s| s.0.as_str()).collect::<Vec<_>>(),
        ["chunk 1", "chunk 2", "chunk 3"]
    );
    assert!(segments.iter().all(|s| s.2 == 0));
    assert!(f64::from(segments[0].1).abs() < 1e-3);
    // Part 2 starts where part 1's audio ended.
    assert!((f64::from(segments[2].1) - seconds_of(frames_1)).abs() < 1e-2);

    // 300 + 20 s of parts capped at the 310 s session: 6 minutes at 2.
    let session = session_value(&dbs.tenant, &sid).await;
    assert_eq!(session["transcription_credits_charged"], json!(12));
    let charged = ledger(&dbs.master, &format!("meet-transcription:{sid}:{tid}")).await;
    assert_eq!(charged, Some(("consumption".to_owned(), -12)));
    let balance: i32 =
        sqlx::query_scalar("select current_balance from workspace_credits where workspace_id = $1")
            .bind(&wallet)
            .fetch_one(&dbs.master)
            .await
            .expect("balance");
    assert_eq!(balance, 88);
}

async fn audio_that_is_not_mp3_fails_the_transcription_and_charges_nothing(dbs: &Databases) {
    let org = generate_id("org");
    workspace(&dbs.master, &org, 100).await;
    let sid = session(&dbs.tenant, 60).await;
    let audio_key = format!("{org}/{sid}/rec.mp3");
    recorded(
        &dbs.tenant,
        &sid,
        &json!([part(&org, &sid, "rec", 60)]),
        &audio_key,
    )
    .await;
    let tid = generate_id("trans");
    sqlx::query(
        "insert into crm_transcriptions (id, activity_id, status) values ($1, $2, 'pending')",
    )
    .bind(&tid)
    .bind(&sid)
    .execute(&dbs.tenant)
    .await
    .expect("pending transcription");
    let fake = FakeProvider::new();
    let error = job(dbs, Bucket(HashMap::from([(audio_key, vec![0; 2048])])), &fake)
        .run(
            &Inline,
            json!({ "kind": "whisper-transcribe", "orgId": org, "sessionId": sid, "transcriptionId": tid, "userId": "u" }),
        )
        .await
        .expect_err("not MP3");
    assert!(error.to_string().contains("not MP3"), "{error}");
    let row = transcription(&dbs.tenant, &sid).await;
    assert_eq!(row["status"], json!("failed"));
    assert!(fake.calls().is_empty(), "no model call");
    assert_eq!(
        ledger(&dbs.master, &format!("meet-transcription:{sid}:{tid}")).await,
        None
    );
}

async fn a_stored_transcript_is_summarized_and_charged_with_the_run_id(dbs: &Databases) {
    let org = generate_id("org");
    // An empty wallet: the summary is delivered and booked as debt.
    workspace(&dbs.master, &org, 0).await;
    let sid = session(&dbs.tenant, 900).await;
    let tid = generate_id("trans");
    sqlx::query(
        "insert into crm_transcriptions (id, activity_id, status, full_text) values ($1, $2, 'completed', 'x')",
    )
    .bind(&tid)
    .bind(&sid)
    .execute(&dbs.tenant)
    .await
    .expect("transcription");
    sqlx::query(
        "insert into crm_transcript_segments (id, transcription_id, speaker_id, speaker_label, text, \
         start_time, end_time, sequence_number) values ($1, $2, 0, 'Alice', 'We ship on Friday', 5, 8, 0)",
    )
    .bind(generate_id("seg"))
    .bind(&tid)
    .execute(&dbs.tenant)
    .await
    .expect("segment");

    let fake = FakeProvider::new().reply_text("  ## Summary\nShip Friday.  ");
    job(dbs, Bucket::default(), &fake)
        .run(
            &Inline,
            json!({ "kind": "summarize", "orgId": org, "sessionId": sid, "userId": "user_1", "runId": "run1" }),
        )
        .await
        .expect("run");

    let request = &fake.calls()[0];
    assert!(request.url.ends_with("/chat/completions"));
    let prompt = request.body["messages"][1]["content"]
        .as_str()
        .expect("prompt");
    assert!(
        prompt.contains("[00:00:05] Alice: We ship on Friday"),
        "{prompt}"
    );

    let session = session_value(&dbs.tenant, &sid).await;
    assert_eq!(session["summary_status"], json!("completed"));
    assert_eq!(session["summary_text"], json!("## Summary\nShip Friday."));
    assert_eq!(session["summary_source"], json!("workers_ai"));
    assert_eq!(session["summary_format"], json!("markdown"));
    assert_eq!(session["summary_credits_charged"], json!(15));
    assert_eq!(
        ledger(&dbs.master, &format!("meet-summary:{sid}:run1:settle")).await,
        Some(("adjustment".to_owned(), -15))
    );
}

async fn a_summary_without_a_completed_transcript_fails(dbs: &Databases) {
    let org = generate_id("org");
    workspace(&dbs.master, &org, 100).await;
    let sid = session(&dbs.tenant, 900).await;
    let fake = FakeProvider::new();
    let error = job(dbs, Bucket::default(), &fake)
        .run(
            &Inline,
            json!({ "kind": "summarize", "orgId": org, "sessionId": sid, "userId": "u", "runId": "r" }),
        )
        .await
        .expect_err("no transcript");
    assert!(
        error.to_string().contains("no completed transcript"),
        "{error}"
    );
    let session = session_value(&dbs.tenant, &sid).await;
    assert_eq!(session["summary_status"], json!("failed"));
    assert!(fake.calls().is_empty());
}

/// One test, one connection per database: the scenarios run in order.
#[tokio::test]
async fn the_meeting_ai_job_on_the_migrated_schema() {
    let Some(dbs) = databases() else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    transcribe_afterwards_hears_every_part_in_chunks_and_bills_the_capped_minutes(&dbs).await;
    audio_that_is_not_mp3_fails_the_transcription_and_charges_nothing(&dbs).await;
    a_stored_transcript_is_summarized_and_charged_with_the_run_id(&dbs).await;
    a_summary_without_a_completed_transcript_fails(&dbs).await;
}
