//! What meet-api's `MEETING_AI` Workflow does after a call
//! (`@weldsuite/meet-domain/workflows/meeting-ai.ts`), on the Kubernetes
//! editions: the "transcribe afterwards" pass over a session's stored audio
//! and the summary of a stored transcript, run as the durable job
//! [`MEETING_AI_JOB`] through `weldsuite_ai` under the `meet` feature (ADR
//! AI-012). Global runs Whisper and a Workers AI model; here transcription
//! is the install provider's (Voxtral on EU) and the summary follows the
//! workspace policy (`Task::Summarize`).
//!
//! The routes start it exactly as they start the Workflow
//! (`MEETING_AI.create({ id, params })`, [`JobsMeetingAi`]): instance ids
//! `whisper-<transcriptionId>` and `summarize-<sessionId>-<runId>`. The steps,
//! the stored rows (`crm_transcriptions` and its segments, the session's
//! `summary*` columns), the statuses, the `meeting_session:updated` events
//! and the charge per meeting minute (`weldmeet.ai_pricing`, booked after
//! the result is stored, never failing the run) are the Workflow's. The
//! model calls themselves are not metered by the crate: the meeting minute
//! is the price, as on Global.
//!
//! `RealtimeKit`'s own transcript and summary (`ingest-rtk-*`) have no
//! recorder to come from here and are refused.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use weldsuite_ai::{Ai, AiCall, Audio, ChatRequest, Feature, Task, Tier};
use weldsuite_catalogs::entity_events::MEETING_SESSION_UPDATED;
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_ports::{BoxFuture, DynJobs, Job, JobContext, JobError, JobRequest, StepRetry, step};

use crate::billing::{self, AiKind, Charge};
use crate::js::text;
use crate::recording::{find_transcription, patch_session, ready_parts, whisper_language};
use crate::{MeetState, MeetWorkflow, RecordingsBucket, lifecycle, mp3, now, publish_system};

/// The job the `MEETING_AI` binding starts on the Kubernetes editions.
pub const MEETING_AI_JOB: &str = "meet.meeting-ai";

/// `WHISPER_CHUNK_BYTES`: nominal bytes per transcription request (about 4
/// to 8 minutes of MP3).
pub(crate) const CHUNK_BYTES: u64 = 4 * 1024 * 1024;

/// `SUMMARY_MAX_TRANSCRIPT_CHARS`: the transcript handed to the summarizer.
const SUMMARY_MAX_TRANSCRIPT_CHARS: usize = 140_000;

/// `SUMMARY_SYSTEM_PROMPT`, verbatim.
const SUMMARY_SYSTEM_PROMPT: &str = "You write meeting summaries from a transcript.
Write in the language the transcript is spoken in.
Use Markdown with these sections when there is something to say: a short overview (2-3 sentences), \"Key points\", \"Decisions\", \"Action items\" (with the owner when a speaker names one).
Only state what the transcript supports. Do not invent names, numbers or decisions.";

/// The first bytes of a stored audio file the plan reads to tell MP3.
const SAMPLE_BYTES: u64 = 64 * 1024;

/// `DB_RETRIES`.
const DB_RETRIES: StepRetry = StepRetry::exponential(3, Duration::from_secs(5));
/// One transcription request's retries.
const CHUNK_RETRIES: StepRetry = StepRetry::exponential(3, Duration::from_secs(20));
/// The summary request's retries.
const SUMMARY_RETRIES: StepRetry = StepRetry::exponential(2, Duration::from_secs(30));

/// `MeetingAiParams`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    kind: String,
    /// The org id the tenant database is found by (`getTenantDbForWorkspace`).
    org_id: String,
    session_id: String,
    transcription_id: Option<String>,
    user_id: Option<String>,
    /// A RealtimeKit-style language code (`nl`, `en-US`); none to detect.
    language: Option<String>,
    run_id: Option<String>,
}

impl Params {
    fn user(&self) -> &str {
        self.user_id
            .as_deref()
            .filter(|user| !user.is_empty())
            .unwrap_or("system")
    }
}

/// `MeetingAiWorkflow`, as a job.
#[derive(Clone)]
pub struct MeetingAiJob {
    /// The module's state: the install's AI, the recordings bucket, the
    /// tenant databases, the master database (prices, wallet) and events.
    pub state: MeetState,
}

impl std::fmt::Debug for MeetingAiJob {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MeetingAiJob").finish_non_exhaustive()
    }
}

/// The `MEETING_AI` binding on the Kubernetes editions: starts a
/// [`MeetingAiJob`] under the Workflow's instance id.
pub struct JobsMeetingAi(pub Arc<dyn DynJobs>);

impl MeetWorkflow for JobsMeetingAi {
    fn create<'a>(&'a self, id: &'a str, params: &'a Value) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let request = JobRequest {
                name: MEETING_AI_JOB.to_owned(),
                key: id.to_owned(),
                payload: params.clone(),
                delay: None,
            };
            self.0
                .start_boxed(request)
                .await
                .map_err(|error| error.to_string())
        })
    }
}

impl Job for MeetingAiJob {
    fn name(&self) -> &'static str {
        MEETING_AI_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let params: Params = serde_json::from_value(payload)?;
            match params.kind.as_str() {
                "whisper-transcribe" => self.transcribe(ctx, &params).await,
                "summarize" => self.summarize(ctx, &params).await,
                other => Err(JobError::failed(format!(
                    "meeting AI: {other} needs RealtimeKit's recorder, which this edition doesn't run"
                ))),
            }
        })
    }
}

/// `errorMessage(error)`: what a failure is recorded as.
fn message(error: &JobError) -> String {
    match error {
        JobError::Failed(message) | JobError::StepFailed { message, .. } => message.clone(),
        other => other.to_string(),
    }
}

fn failed(error: impl std::fmt::Display) -> JobError {
    JobError::failed(error)
}

/// One stored audio file to transcribe, in order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlannedAudio {
    key: String,
    size: u64,
    duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    audios: Vec<PlannedAudio>,
    session_duration: Option<f64>,
}

/// What one transcription request heard.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Heard {
    /// `(start, end, text)` in seconds from the clip's start.
    pub(crate) segments: Vec<(f64, f64, String)>,
    pub(crate) duration_seconds: f64,
    /// Who served it: the transcription row's `provider` and `model`.
    pub(crate) provider: Option<String>,
    pub(crate) model: Option<String>,
}

/// `TranscriptSegmentInput`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Segment {
    pub(crate) speaker_id: i32,
    pub(crate) speaker_label: String,
    pub(crate) speaker_name: Option<String>,
    pub(crate) text: String,
    pub(crate) start: f64,
    pub(crate) end: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Generated {
    summary: String,
    last_end_seconds: f64,
}

/// Transcribe chunk `index` of `audio` (step `whisper-<a>-<k>`): the byte
/// window, cut on frame boundaries, sent to the install's transcription
/// model.
pub(crate) async fn transcribe_chunk(
    ai: &Ai,
    call: &AiCall,
    bucket: &dyn RecordingsBucket,
    key: &str,
    size: u64,
    index: u64,
    language: Option<&str>,
) -> Result<Heard, JobError> {
    let window = mp3::chunk_window(size, CHUNK_BYTES, index);
    let bytes = bucket
        .get(key, Some((window.offset, window.length)))
        .await
        .map_err(failed)?
        .ok_or_else(|| JobError::failed(format!("Audio file {key} is missing from storage")))?;
    let clip = mp3::align_chunk(&bytes, CHUNK_BYTES, index, window.is_last);
    if clip.is_empty() {
        return Ok(Heard::default());
    }
    let duration_seconds = mp3::duration_seconds(clip);
    let name = key.rsplit('/').next().unwrap_or("audio.mp3");
    let heard = ai
        .transcribe(
            call,
            Audio {
                mime: "audio/mpeg".to_owned(),
                name: format!("{index}-{name}"),
                data: clip.to_vec(),
                language: language.map(str::to_owned),
            },
        )
        .await
        .map_err(failed)?;
    let mut segments = heard.segments;
    let whole = heard.text.trim();
    if segments.is_empty() && !whole.is_empty() {
        // A provider that gives no segments: the clip as one.
        segments.push((0.0, duration_seconds, whole.to_owned()));
    }
    Ok(Heard {
        segments,
        duration_seconds,
        provider: Some(heard.served.provider.as_str().to_owned()),
        model: Some(heard.served.model),
    })
}

/// The transcript's segments from the chunks, in order, each offset by the
/// audio before it; and the seconds the chunks measured.
pub(crate) fn assemble(chunks: &[Heard]) -> (Vec<Segment>, f64) {
    let mut segments = Vec::new();
    let mut offset = 0.0;
    for chunk in chunks {
        for (start, end, text) in &chunk.segments {
            segments.push(Segment {
                speaker_id: 0,
                speaker_label: "Speaker".to_owned(),
                speaker_name: None,
                text: text.clone(),
                start: offset + start,
                end: offset + end,
            });
        }
        offset += chunk.duration_seconds;
    }
    (segments, offset)
}

/// `formatTimestamp(seconds)`: `HH:MM:SS`.
pub(crate) fn format_timestamp(seconds: f64) -> String {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let total = seconds.max(0.0).floor() as u64;
    format!(
        "{:02}:{:02}:{:02}",
        total / 3600,
        (total % 3600) / 60,
        total % 60
    )
}

/// The summary of `transcript` (step `generate-summary`'s model call).
pub(crate) async fn summarize_transcript(
    ai: &Ai,
    call: &AiCall,
    transcript: &str,
) -> Result<String, JobError> {
    let clipped: String = transcript
        .chars()
        .take(SUMMARY_MAX_TRANSCRIPT_CHARS)
        .collect();
    let answer = ai
        .chat(
            call,
            ChatRequest::system_user(SUMMARY_SYSTEM_PROMPT, format!("Transcript:\n\n{clipped}")),
        )
        .await
        .map_err(failed)?;
    let summary = answer.text.trim();
    if summary.is_empty() {
        return Err(JobError::failed("The model returned an empty summary"));
    }
    Ok(summary.to_owned())
}

impl MeetingAiJob {
    async fn db(&self, org: &str) -> Result<PgPool, JobError> {
        match &self.state.tenants {
            Some(tenants) => tenants(org.to_owned()).await.map_err(failed),
            None => Err(JobError::failed(format!("no tenant database for {org}"))),
        }
    }

    /// `recordingsBucket(env)`.
    fn bucket(&self) -> Result<Arc<dyn RecordingsBucket>, JobError> {
        self.state
            .recordings
            .clone()
            .ok_or_else(|| JobError::failed("MEETING_RECORDINGS bucket is not bound"))
    }

    fn ai(&self) -> Result<Ai, JobError> {
        self.state
            .ai
            .clone()
            .filter(Ai::enabled)
            .ok_or_else(|| JobError::failed("AI is not configured"))
    }

    /// An AI call of the job: for the workspace (`workspaces.id` when the
    /// master database knows the org), with its tenant's settings, and no
    /// master database: the meeting minute is charged, not the tokens.
    async fn call(&self, p: &Params, db: &PgPool, task: Task) -> AiCall {
        let workspace = match &self.state.master {
            Some(master) => {
                weldsuite_core_domain::credits::resolve_internal_workspace_id(master, &p.org_id)
                    .await
                    .ok()
                    .flatten()
            }
            None => None,
        }
        .unwrap_or_else(|| p.org_id.clone());
        AiCall::new(workspace, Feature::Meet, task, Tier::Free)
            .user(p.user())
            .tenant(db.clone())
            .reference(p.session_id.clone())
    }

    /// `publishSessionUpdated(env, db, orgId, session, extra, userId)`.
    fn emit(&self, org: &str, session: &Value, extra: &[(&str, Value)], user: &str) {
        let mut data = Map::new();
        data.insert("id".into(), session["id"].clone());
        data.insert("meetingId".into(), session["meetingId"].clone());
        data.insert("status".into(), session["status"].clone());
        for (key, value) in extra {
            data.insert((*key).to_owned(), value.clone());
        }
        let id = text(session, "id").unwrap_or_default();
        publish_system(
            &self.state,
            org,
            user,
            MEETING_SESSION_UPDATED,
            id,
            Value::Object(data),
        );
    }

    async fn emit_current(
        &self,
        db: &PgPool,
        p: &Params,
        extra: &[(&str, Value)],
        user: &str,
    ) -> Result<(), JobError> {
        if let Some(session) = lifecycle::session_row(db, &p.session_id)
            .await
            .map_err(failed)?
        {
            self.emit(&p.org_id, &session, extra, user);
        }
        Ok(())
    }

    /// `charge(step, p, params)`: the credits charged, booked as its own
    /// step after the result is stored. Never fails the run: a failure is
    /// logged and the result stays delivered, unbilled.
    async fn charge(
        &self,
        ctx: &dyn JobContext,
        p: &Params,
        kind: AiKind,
        seconds: f64,
        source: &str,
        run_id: Option<&str>,
    ) -> i64 {
        let name = format!("charge-{}", kind.as_str());
        let charged = step(ctx, &name, DB_RETRIES, || async move {
            let master = self.state.master.as_ref();
            let pricing = billing::pricing(self.state.cache.as_ref(), master).await;
            let workspace = billing::metering(master, &p.org_id)
                .await
                .map_err(|error| JobError::failed(format!("{error:?}")))?;
            let master = master.ok_or_else(|| JobError::failed("no master database"))?;
            let credits = billing::charge(
                master,
                &workspace,
                p.user(),
                &Charge {
                    kind,
                    session_id: &p.session_id,
                    minutes: billing::billable_minutes(seconds),
                    rate_per_minute: kind.rate(pricing),
                    source,
                    run_id,
                },
            )
            .await
            .map_err(|error| JobError::failed(format!("{error:?}")))?;
            let column = match kind {
                AiKind::Transcription => "transcriptionCreditsCharged",
                AiKind::Summary => "summaryCreditsCharged",
            };
            let db = self.db(&p.org_id).await?;
            patch_session(&db, &p.session_id, &[(column, json!(credits))])
                .await
                .map_err(failed)?;
            Ok(credits)
        })
        .await;
        charged.unwrap_or_else(|error| {
            tracing::error!(
                session = %p.session_id,
                error = %message(&error),
                "[MeetingAi] {} charge failed (result delivered, UNBILLED)",
                kind.as_str()
            );
            0
        })
    }

    // ── whisper-transcribe ───────────────────────────────────────────────

    async fn transcribe(&self, ctx: &dyn JobContext, p: &Params) -> Result<(), JobError> {
        let transcription_id = p.transcription_id.clone().unwrap_or_default();
        match self.transcribe_steps(ctx, p, &transcription_id).await {
            Ok(()) => Ok(()),
            Err(error) => {
                self.fail_transcription(p, &message(&error), Some(&transcription_id))
                    .await;
                Err(error)
            }
        }
    }

    async fn transcribe_steps(
        &self,
        ctx: &dyn JobContext,
        p: &Params,
        transcription_id: &str,
    ) -> Result<(), JobError> {
        let user = p.user();
        // 1. Which stored audio files, in order. Not retried: a wrong format
        //    or missing audio will not fix itself.
        let plan: Plan = step(ctx, "plan", StepRetry::ONCE, || async move {
            let db = self.db(&p.org_id).await?;
            let session = lifecycle::session_row(&db, &p.session_id)
                .await
                .map_err(failed)?
                .ok_or_else(|| JobError::failed("Session not found"))?;
            let bucket = self.bucket()?;
            let mut keys: Vec<(String, Option<f64>)> = ready_parts(&session["recordingParts"])
                .iter()
                .filter_map(|part| {
                    let key = text(part, "audioKey").filter(|key| !key.is_empty())?;
                    Some((key.to_owned(), part["durationSeconds"].as_f64()))
                })
                .collect();
            if keys.is_empty()
                && let Some(key) = text(&session, "recordingAudioKey").filter(|k| !k.is_empty())
            {
                keys.push((key.to_owned(), session["recordingDurationSeconds"].as_f64()));
            }
            if keys.is_empty() {
                return Err(JobError::failed("No stored audio to transcribe"));
            }
            let mut audios = Vec::new();
            for (key, duration_seconds) in keys {
                let Some(head) = bucket.head(&key).await.map_err(failed)? else {
                    return Err(JobError::failed(format!(
                        "Audio file {key} is missing from storage"
                    )));
                };
                let sample = bucket
                    .get(&key, Some((0, SAMPLE_BYTES.min(head.size))))
                    .await
                    .map_err(failed)?
                    .unwrap_or_default();
                if !mp3::is_mp3(&sample) {
                    return Err(JobError::failed(
                        "The stored audio is not MP3, so it cannot be split for transcription",
                    ));
                }
                audios.push(PlannedAudio {
                    key,
                    size: head.size,
                    duration_seconds,
                });
            }
            let now = now();
            sqlx::query(
                "update crm_transcriptions set status = 'processing', \
                 processing_started_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
            )
            .bind(transcription_id)
            .bind(&now)
            .execute(&db)
            .await
            .map_err(failed)?;
            self.emit(
                &p.org_id,
                &session,
                &[("transcriptionStatus", json!("processing"))],
                user,
            );
            Ok(Plan {
                audios,
                session_duration: session["duration"].as_f64(),
            })
        })
        .await?;

        // 2. One retried step per chunk.
        let ai = self.ai()?;
        let language = whisper_language(p.language.as_deref());
        let db = self.db(&p.org_id).await?;
        let call = self.call(p, &db, Task::Transcribe).await;
        let (ai, call, hint) = (&ai, &call, language.as_deref());
        let mut chunks = Vec::new();
        for (a, audio) in plan.audios.iter().enumerate() {
            for k in 0..mp3::chunk_count(audio.size, CHUNK_BYTES) {
                let name = format!("whisper-{a}-{k}");
                let heard: Heard = step(ctx, &name, CHUNK_RETRIES, || async move {
                    let bucket = self.bucket()?;
                    transcribe_chunk(ai, call, bucket.as_ref(), &audio.key, audio.size, k, hint)
                        .await
                })
                .await?;
                chunks.push(heard);
            }
        }
        let (segments, measured_seconds) = assemble(&chunks);

        // 3. Store, billed on the summed part durations capped at the
        //    session's length.
        let part_seconds = if plan
            .audios
            .iter()
            .all(|audio| audio.duration_seconds.is_some_and(|d| d > 0.0))
        {
            plan.audios
                .iter()
                .filter_map(|audio| audio.duration_seconds)
                .sum()
        } else {
            measured_seconds
        };
        let billed_seconds = match plan.session_duration {
            Some(session) if session > 0.0 => part_seconds.min(session),
            _ => part_seconds,
        };
        let served = chunks.iter().rev().find(|chunk| chunk.model.is_some());
        let (provider, model) = match served {
            Some(chunk) => (chunk.provider.clone(), chunk.model.clone()),
            None => match ai.route(call).await {
                Ok(route) => (
                    Some(route.primary.provider.as_str().to_owned()),
                    Some(route.primary.model),
                ),
                Err(_) => (None, None),
            },
        };
        let keys: Vec<&str> = plan.audios.iter().map(|audio| audio.key.as_str()).collect();
        let (keys, segments) = (&keys, &segments);
        let (provider, model) = (provider.as_deref(), model.as_deref());
        step(ctx, "store-transcript", DB_RETRIES, || async move {
            let db = self.db(&p.org_id).await?;
            save_completed_transcript(
                &db,
                &SaveTranscript {
                    session_id: &p.session_id,
                    transcription_id: Some(transcription_id),
                    provider,
                    model,
                    language: hint,
                    segments,
                    metadata: json!({
                        "source": "whisper",
                        "parts": keys,
                        "billedSeconds": billed_seconds,
                    }),
                },
            )
            .await
            .map_err(failed)?;
            self.emit_current(&db, p, &[("transcriptionStatus", json!("completed"))], user)
                .await
        })
        .await?;

        // 4. Charge, once per transcription (a second pass after a delete
        //    bills again).
        self.charge(
            ctx,
            p,
            AiKind::Transcription,
            billed_seconds,
            "whisper",
            Some(transcription_id),
        )
        .await;
        Ok(())
    }

    /// `failTranscription(p, message, transcriptionId)`.
    async fn fail_transcription(&self, p: &Params, error: &str, transcription_id: Option<&str>) {
        tracing::error!(session = %p.session_id, error, "[MeetingAi] transcription failed");
        let recorded = async {
            let db = self.db(&p.org_id).await?;
            mark_transcription_failed(&db, &p.session_id, error, transcription_id)
                .await
                .map_err(failed)?;
            self.emit_current(
                &db,
                p,
                &[("transcriptionStatus", json!("failed"))],
                "system",
            )
            .await
        }
        .await;
        if let Err(update) = recorded {
            tracing::error!(error = %message(&update), "[MeetingAi] could not record transcription failure");
        }
    }

    // ── summarize ────────────────────────────────────────────────────────

    async fn summarize(&self, ctx: &dyn JobContext, p: &Params) -> Result<(), JobError> {
        match self.summarize_steps(ctx, p).await {
            Ok(()) => Ok(()),
            Err(error) => {
                self.fail_summary(p, &message(&error)).await;
                Err(error)
            }
        }
    }

    async fn summarize_steps(&self, ctx: &dyn JobContext, p: &Params) -> Result<(), JobError> {
        let user = p.user();
        step(ctx, "mark-processing", DB_RETRIES, || async move {
            let db = self.db(&p.org_id).await?;
            let session = lifecycle::session_row(&db, &p.session_id)
                .await
                .map_err(failed)?
                .ok_or_else(|| JobError::failed("Session not found"))?;
            patch_session(
                &db,
                &p.session_id,
                &[
                    ("summaryStatus", json!("processing")),
                    ("summaryError", Value::Null),
                ],
            )
            .await
            .map_err(failed)?;
            self.emit(
                &p.org_id,
                &session,
                &[("summaryStatus", json!("processing"))],
                user,
            );
            Ok(())
        })
        .await?;

        let ai = self.ai()?;
        let db = self.db(&p.org_id).await?;
        let call = self.call(p, &db, Task::Summarize).await;
        let (ai, call) = (&ai, &call);
        let generated: Generated = step(ctx, "generate-summary", SUMMARY_RETRIES, || async move {
            let db = self.db(&p.org_id).await?;
            let transcription = find_transcription(&db, &p.session_id)
                .await
                .map_err(failed)?
                .filter(|t| text(t, "status") == Some("completed"))
                .ok_or_else(|| JobError::failed("There is no completed transcript to summarize"))?;
            let (transcript, last_end_seconds) =
                load_transcript_text(&db, text(&transcription, "id").unwrap_or_default())
                    .await
                    .map_err(failed)?;
            if transcript.trim().is_empty() {
                return Err(JobError::failed("The transcript is empty"));
            }
            let summary = summarize_transcript(ai, call, &transcript).await?;
            Ok(Generated {
                summary,
                last_end_seconds,
            })
        })
        .await?;

        let summary = generated.summary.as_str();
        step(ctx, "store-summary", DB_RETRIES, || async move {
            let db = self.db(&p.org_id).await?;
            let Some(session) = lifecycle::session_row(&db, &p.session_id)
                .await
                .map_err(failed)?
            else {
                return Ok(());
            };
            patch_session(
                &db,
                &p.session_id,
                &[
                    ("summaryStatus", json!("completed")),
                    ("summaryText", json!(summary)),
                    ("summaryFormat", json!("markdown")),
                    // The worker's name for "summarized by the platform's
                    // model after the call" (as opposed to RealtimeKit's).
                    ("summarySource", json!("workers_ai")),
                    ("summaryGeneratedAt", json!(now())),
                    ("summaryError", Value::Null),
                ],
            )
            .await
            .map_err(failed)?;
            self.emit(
                &p.org_id,
                &session,
                &[("summaryStatus", json!("completed"))],
                user,
            );
            Ok(())
        })
        .await?;

        // `billSeconds`: the session's own duration, else what the
        // transcript covers.
        let session = lifecycle::session_row(&db, &p.session_id)
            .await
            .map_err(failed)?;
        let seconds = session
            .as_ref()
            .and_then(|s| s["duration"].as_f64())
            .filter(|d| *d > 0.0)
            .unwrap_or(generated.last_end_seconds);
        self.charge(
            ctx,
            p,
            AiKind::Summary,
            seconds,
            "workers_ai",
            p.run_id.as_deref(),
        )
        .await;
        Ok(())
    }

    /// `failSummary(p, message)`.
    async fn fail_summary(&self, p: &Params, error: &str) {
        tracing::error!(session = %p.session_id, error, "[MeetingAi] summary failed");
        let recorded = async {
            let db = self.db(&p.org_id).await?;
            let Some(session) = lifecycle::session_row(&db, &p.session_id)
                .await
                .map_err(failed)?
            else {
                return Ok(());
            };
            let clipped: String = error.chars().take(1000).collect();
            patch_session(
                &db,
                &p.session_id,
                &[
                    ("summaryStatus", json!("failed")),
                    ("summaryError", json!(clipped)),
                ],
            )
            .await
            .map_err(failed)?;
            self.emit(
                &p.org_id,
                &session,
                &[("summaryStatus", json!("failed"))],
                "system",
            );
            Ok::<_, JobError>(())
        }
        .await;
        if let Err(update) = recorded {
            tracing::error!(error = %message(&update), "[MeetingAi] could not record summary failure");
        }
    }
}

// ── The transcript store (`@weldsuite/meet-domain/transcript-store`) ────────

/// `SaveTranscriptParams`.
pub(crate) struct SaveTranscript<'a> {
    pub(crate) session_id: &'a str,
    /// Reuse this row (the route created it `pending`); else the session's
    /// row or a new one.
    pub(crate) transcription_id: Option<&'a str>,
    pub(crate) provider: Option<&'a str>,
    pub(crate) model: Option<&'a str>,
    pub(crate) language: Option<&'a str>,
    pub(crate) segments: &'a [Segment],
    pub(crate) metadata: Value,
}

/// `saveCompletedTranscript(db, params)`: the transcription row `completed`
/// (updated or inserted) and its segments replaced. The row's id.
pub(crate) async fn save_completed_transcript(
    db: &PgPool,
    params: &SaveTranscript<'_>,
) -> Result<String, sqlx::Error> {
    let existing: Option<String> = match params.transcription_id {
        Some(id) => {
            sqlx::query_scalar("select id from crm_transcriptions where id = $1 limit 1")
                .bind(id)
                .fetch_optional(db)
                .await?
        }
        None => {
            sqlx::query_scalar("select id from crm_transcriptions where activity_id = $1 limit 1")
                .bind(params.session_id)
                .fetch_optional(db)
                .await?
        }
    };
    let full_text = params
        .segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let word_count = i32::try_from(full_text.split_whitespace().count()).unwrap_or(i32::MAX);
    let speakers: std::collections::BTreeSet<i32> =
        params.segments.iter().map(|s| s.speaker_id).collect();
    let speaker_count = i32::try_from(speakers.len()).unwrap_or(i32::MAX);
    let now = now();
    let id = if let Some(id) = existing {
        sqlx::query(
            "update crm_transcriptions set status = 'completed', full_text = $2, provider = $3, \
                 model = $4, language = left(coalesce($5, language, 'en'), 10), word_count = $6, \
                 speaker_count = $7, error_message = null, \
                 processing_started_at = coalesce(processing_started_at, $8::timestamp), \
                 processing_completed_at = $8::timestamp, metadata = $9::jsonb, \
                 updated_at = $8::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&full_text)
        .bind(params.provider)
        .bind(params.model)
        .bind(params.language)
        .bind(word_count)
        .bind(speaker_count)
        .bind(&now)
        .bind(&params.metadata)
        .execute(db)
        .await?;
        id
    } else {
        let id = params
            .transcription_id
            .map_or_else(|| generate_id("trans"), str::to_owned);
        sqlx::query(
            "insert into crm_transcriptions (id, activity_id, status, full_text, provider, \
                 model, language, word_count, speaker_count, error_message, processing_started_at, \
                 processing_completed_at, metadata, created_at, updated_at) values ($1, $2, \
                 'completed', $3, $4, $5, left(coalesce($6, 'en'), 10), $7, $8, null, \
                 $9::timestamp, $9::timestamp, $10::jsonb, $9::timestamp, $9::timestamp)",
        )
        .bind(&id)
        .bind(params.session_id)
        .bind(&full_text)
        .bind(params.provider)
        .bind(params.model)
        .bind(params.language)
        .bind(word_count)
        .bind(speaker_count)
        .bind(&now)
        .bind(&params.metadata)
        .execute(db)
        .await?;
        id
    };
    sqlx::query("delete from crm_transcript_segments where transcription_id = $1")
        .bind(&id)
        .execute(db)
        .await?;
    let rows: Vec<Value> = params
        .segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            json!({
                "id": generate_id("seg"),
                "transcription_id": id,
                "speaker_id": segment.speaker_id,
                "speaker_label": segment.speaker_label.chars().take(50).collect::<String>(),
                "speaker_name": segment.speaker_name.as_ref().map(|n| n.chars().take(255).collect::<String>()),
                "text": segment.text,
                "start_time": segment.start,
                "end_time": segment.end,
                "timestamp": format_timestamp(segment.start),
                "sequence_number": index,
                "words": null,
                "created_at": now,
            })
        })
        .collect();
    for batch in rows.chunks(100) {
        sqlx::query(
            "insert into crm_transcript_segments (id, transcription_id, speaker_id, speaker_label, \
             speaker_name, text, start_time, end_time, timestamp, sequence_number, words, created_at) \
             select r.id, r.transcription_id, r.speaker_id, r.speaker_label, r.speaker_name, r.text, \
             r.start_time, r.end_time, r.timestamp, r.sequence_number, r.words, r.created_at \
             from jsonb_populate_recordset(null::crm_transcript_segments, $1::jsonb) r",
        )
        .bind(Value::Array(batch.to_vec()))
        .execute(db)
        .await?;
    }
    Ok(id)
}

/// `markTranscriptionFailed(db, sessionId, message, transcriptionId)`: the
/// row `failed`, created when the failure came before anything was stored.
pub(crate) async fn mark_transcription_failed(
    db: &PgPool,
    session_id: &str,
    error: &str,
    transcription_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    let now = now();
    let clipped: String = error.chars().take(1000).collect();
    let existing: Option<String> = match transcription_id {
        Some(id) => {
            sqlx::query_scalar("select id from crm_transcriptions where id = $1 limit 1")
                .bind(id)
                .fetch_optional(db)
                .await?
        }
        None => {
            sqlx::query_scalar("select id from crm_transcriptions where activity_id = $1 limit 1")
                .bind(session_id)
                .fetch_optional(db)
                .await?
        }
    };
    if let Some(id) = existing {
        sqlx::query(
            "update crm_transcriptions set status = 'failed', error_message = $2, \
             updated_at = $3::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&clipped)
        .bind(&now)
        .execute(db)
        .await?;
        return Ok(());
    }
    sqlx::query(
        "insert into crm_transcriptions (id, activity_id, status, error_message, created_at, \
         updated_at) values ($1, $2, 'failed', $3, $4::timestamp, $4::timestamp)",
    )
    .bind(transcription_id.map_or_else(|| generate_id("trans"), str::to_owned))
    .bind(session_id)
    .bind(&clipped)
    .bind(&now)
    .execute(db)
    .await?;
    Ok(())
}

/// `loadTranscriptText(db, transcriptionId)`: one `[HH:MM:SS] Speaker: text`
/// line per segment, and where the last one ends.
pub(crate) async fn load_transcript_text(
    db: &PgPool,
    transcription_id: &str,
) -> Result<(String, f64), sqlx::Error> {
    let rows: Vec<(Option<String>, String, f32, f32)> = sqlx::query_as(
        "select speaker_label, text, start_time, end_time from crm_transcript_segments \
         where transcription_id = $1 order by sequence_number asc",
    )
    .bind(transcription_id)
    .fetch_all(db)
    .await?;
    Ok(transcript_text(&rows))
}

/// [`load_transcript_text`]'s rendering of the rows.
pub(crate) fn transcript_text(rows: &[(Option<String>, String, f32, f32)]) -> (String, f64) {
    let text = rows
        .iter()
        .map(|(label, text, start, _)| {
            format!(
                "[{}] {}: {text}",
                format_timestamp(f64::from(*start)),
                label.as_deref().unwrap_or("Speaker")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let last_end = rows
        .iter()
        .map(|(_, _, _, end)| f64::from(*end))
        .fold(0.0, f64::max);
    (text, last_end)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use weldsuite_ai::config::Endpoint;
    use weldsuite_ai::{AiConfig, FakeProvider, ProviderId};
    use weldsuite_ports::{ObjectInfo, PortError};

    use super::*;
    use crate::Listed;
    use crate::mp3::tests::mp3;

    /// A recordings bucket over a map, recording each ranged read.
    #[derive(Default)]
    pub(crate) struct FakeRecordings {
        pub(crate) objects: HashMap<String, Vec<u8>>,
        pub(crate) reads: Mutex<Vec<(String, Option<(u64, u64)>)>>,
    }

    impl RecordingsBucket for FakeRecordings {
        fn head<'a>(
            &'a self,
            key: &'a str,
        ) -> BoxFuture<'a, Result<Option<ObjectInfo>, PortError>> {
            let info = self.objects.get(key).map(|bytes| ObjectInfo {
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
            self.reads
                .lock()
                .expect("reads")
                .push((key.to_owned(), range));
            let bytes = self.objects.get(key).map(|bytes| match range {
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

    fn ai(fake: &FakeProvider) -> Ai {
        let config = AiConfig {
            default_provider: Some(ProviderId::Mistral),
            mistral: Endpoint {
                base_url: "https://api.mistral.ai/v1".to_owned(),
                api_key: Some("key".to_owned()),
            },
            ..AiConfig::default()
        };
        Ai::fake(config, fake.clone())
    }

    fn call(task: Task) -> AiCall {
        AiCall::new("ws_1", Feature::Meet, task, Tier::Free).user("user_1")
    }

    #[tokio::test]
    async fn a_long_recording_is_heard_in_frame_aligned_chunks() {
        // Just over two chunks of MP3, as the worker's workflow test has it.
        let frames = usize::try_from(CHUNK_BYTES / 417).expect("frames") * 2 + 2000;
        let audio = mp3(frames);
        let size = audio.len() as u64;
        let key = "org_1/msess_1/rec_1.mp3";
        let bucket = FakeRecordings {
            objects: HashMap::from([(key.to_owned(), audio.clone())]),
            ..FakeRecordings::default()
        };
        let fake = FakeProvider::new()
            .reply_text("Hello everyone.")
            .reply_text("We ship on Friday.")
            .reply_text("Thanks, bye.");
        let ai = ai(&fake);
        let mut chunks = Vec::new();
        for index in 0..mp3::chunk_count(size, CHUNK_BYTES) {
            chunks.push(
                transcribe_chunk(
                    &ai,
                    &call(Task::Transcribe),
                    &bucket,
                    key,
                    size,
                    index,
                    Some("nl"),
                )
                .await
                .expect("chunk"),
            );
        }
        assert_eq!(chunks.len(), 3);
        let calls = fake.calls();
        assert_eq!(calls.len(), 3, "one request per chunk");
        for request in &calls {
            assert!(
                request.url.ends_with("/audio/transcriptions"),
                "{}",
                request.url
            );
            assert_eq!(
                request.model().as_deref(),
                Some("voxtral-mini-transcribe-3-0")
            );
            let body = request.body.as_str().expect("multipart");
            assert!(body.contains("name=\"language\"\r\n\r\nnl\r\n"));
        }
        // Whole frames only, and the clips tile the audio exactly.
        let seconds: f64 = chunks.iter().map(|c| c.duration_seconds).sum();
        assert!((seconds - mp3::duration_seconds(&audio)).abs() < 1e-6);
        assert_eq!(chunks[0].provider.as_deref(), Some("mistral"));
        assert_eq!(
            chunks[0].model.as_deref(),
            Some("mistral/voxtral-mini-transcribe-3-0")
        );

        // The fake answers each clip with one segment from 0 to 60 s: each
        // lands after the audio before it.
        let (segments, measured) = assemble(&chunks);
        assert_eq!(
            segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>(),
            ["Hello everyone.", "We ship on Friday.", "Thanks, bye."]
        );
        assert!(segments[0].start.abs() < 1e-9);
        assert!((segments[1].start - chunks[0].duration_seconds).abs() < 1e-6);
        assert!(
            (segments[2].start - chunks[0].duration_seconds - chunks[1].duration_seconds).abs()
                < 1e-6
        );
        assert!(
            segments
                .iter()
                .all(|s| s.speaker_id == 0 && s.speaker_label == "Speaker")
        );
        assert!((measured - seconds).abs() < 1e-9);
    }

    #[tokio::test]
    async fn a_missing_file_fails_the_chunk() {
        let fake = FakeProvider::new();
        let error = transcribe_chunk(
            &ai(&fake),
            &call(Task::Transcribe),
            &FakeRecordings::default(),
            "org_1/gone.mp3",
            1000,
            0,
            None,
        )
        .await
        .expect_err("missing");
        assert_eq!(
            message(&error),
            "Audio file org_1/gone.mp3 is missing from storage"
        );
        assert!(fake.calls().is_empty());
    }

    #[tokio::test]
    async fn a_transcript_is_summarized_with_the_workers_prompt() {
        let rows = vec![
            (
                Some("Alice".to_owned()),
                "We ship on Friday".to_owned(),
                5.0,
                8.0,
            ),
            (None, "Agreed".to_owned(), 3725.0, 3727.5),
        ];
        let (transcript, last_end) = transcript_text(&rows);
        assert_eq!(
            transcript,
            "[00:00:05] Alice: We ship on Friday\n[01:02:05] Speaker: Agreed"
        );
        assert!((last_end - 3727.5).abs() < 1e-9);

        let fake = FakeProvider::new().reply_text("  ## Summary\nShip Friday.  ");
        let summary = summarize_transcript(&ai(&fake), &call(Task::Summarize), &transcript)
            .await
            .expect("summary");
        assert_eq!(summary, "## Summary\nShip Friday.");
        let request = &fake.calls()[0];
        assert!(request.url.ends_with("/chat/completions"));
        assert_eq!(
            request.body["model"],
            json!("mistral-large-4-0"),
            "the summarize task's model"
        );
        let messages = request.body["messages"].as_array().expect("messages");
        assert_eq!(messages[0]["role"], json!("system"));
        assert!(
            messages[0]["content"]
                .as_str()
                .is_some_and(|s| s.starts_with("You write meeting summaries from a transcript."))
        );
        assert_eq!(
            messages[1]["content"],
            json!(format!("Transcript:\n\n{transcript}"))
        );

        let empty = FakeProvider::new().reply_text("   ");
        let error = summarize_transcript(&ai(&empty), &call(Task::Summarize), "x")
            .await
            .expect_err("empty");
        assert_eq!(message(&error), "The model returned an empty summary");
    }

    #[test]
    fn timestamps_format_like_the_worker() {
        assert_eq!(format_timestamp(0.0), "00:00:00");
        assert_eq!(format_timestamp(-3.0), "00:00:00");
        assert_eq!(format_timestamp(61.9), "00:01:01");
        assert_eq!(format_timestamp(3725.0), "01:02:05");
    }
}
