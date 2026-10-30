//! Scheduled sends (`services/mail/scheduled.ts` and the
//! `SendScheduledEmailWorkflow`): where a scheduled message's delivery run
//! starts ([`ScheduledRuns`], the `SEND_SCHEDULED_EMAIL` Workflow binding on
//! Global), the delivery job itself ([`SendScheduledEmailJob`], a delayed
//! job named `mail.send-scheduled-email`), and the send-now path both share.
//!
//! A run is keyed by its instance id (the message id, or a suffixed one after
//! a reschedule) and the message row records the current one in
//! `trigger_run_id`: a run whose key is no longer the row's skips, which is
//! how a cancelled or rescheduled run ends here (the jobs port has no
//! terminate).

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_mail_domain::labels::{labels_of, labels_value, remove_labels};
use weldsuite_mail_domain::messages::iso;
use weldsuite_mail_domain::outbound::clock::{now_ms, parse_iso};
use weldsuite_mail_domain::send::{
    SendAttachmentInput, SendDeps, SendError, SendInput, SendOptions, SendResult, send_and_persist,
};
use weldsuite_ports::{BoxFuture, DynJobs, Job, JobContext, JobError, JobRequest, StepRetry};

use crate::MailState;
use crate::send::SendContext;

/// The delivery job's name (`SendScheduledEmailWorkflow`).
pub const SEND_SCHEDULED_EMAIL_JOB: &str = "mail.send-scheduled-email";

/// Starts and stops scheduled-send runs (the `SEND_SCHEDULED_EMAIL` binding).
pub trait ScheduledRuns: Send + Sync {
    /// `binding.create({ id, params })`: the run's instance id.
    fn create<'a>(
        &'a self,
        id: &'a str,
        params: &'a Value,
    ) -> BoxFuture<'a, Result<String, String>>;

    /// `(await binding.get(id)).terminate()`, best effort.
    fn terminate<'a>(&'a self, id: &'a str) -> BoxFuture<'a, ()>;
}

/// The request's runs (conformance: the test's binding, or none).
#[derive(Clone)]
pub struct RequestScheduledRuns(pub Option<Arc<dyn ScheduledRuns>>);

/// Runs on the deployment's jobs: a delayed `mail.send-scheduled-email`.
pub struct JobsScheduledRuns {
    pub jobs: Arc<dyn DynJobs>,
}

impl ScheduledRuns for JobsScheduledRuns {
    fn create<'a>(
        &'a self,
        id: &'a str,
        params: &'a Value,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let mut request = JobRequest::new(SEND_SCHEDULED_EMAIL_JOB, id, params)
                .map_err(|error| error.to_string())?;
            if let Some(ms) = params["scheduledFor"].as_str().and_then(parse_iso)
                && let Ok(ms) = u64::try_from(ms)
            {
                request = request
                    .starting_at(std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms));
            }
            self.jobs
                .start_boxed(request)
                .await
                .map_err(|error| error.to_string())?;
            Ok(id.to_owned())
        })
    }

    /// A run that is no longer the row's skips on its own.
    fn terminate<'a>(&'a self, _id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(std::future::ready(()))
    }
}

/// A scheduled row as the send paths read it.
#[derive(Debug, Clone)]
pub(crate) struct ScheduledRow {
    pub(crate) id: String,
    pub(crate) account_id: String,
    pub(crate) send_status: Option<String>,
    pub(crate) trigger_run_id: Option<String>,
    pub(crate) scheduled_for: Option<String>,
    pub(crate) row: Value,
}

/// A live message row (`loadScheduled`).
pub(crate) async fn load_scheduled(
    db: &PgPool,
    id: &str,
) -> Result<Option<ScheduledRow>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from mail_messages m where m.id = $1 and m.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row).map(|row| ScheduledRow {
        id: row["id"].as_str().unwrap_or_default().to_owned(),
        account_id: row["accountId"].as_str().unwrap_or_default().to_owned(),
        send_status: row["sendStatus"].as_str().map(str::to_owned),
        trigger_run_id: row["triggerRunId"].as_str().map(str::to_owned),
        scheduled_for: row["scheduledFor"].as_str().map(str::to_owned),
        row,
    }))
}

/// `applyScheduledPatch`: the scheduled fields a step changes.
#[derive(Debug, Default)]
pub(crate) struct ScheduledPatch {
    pub(crate) send_status: Option<&'static str>,
    /// `Some(None)` clears it.
    pub(crate) scheduled_for: Option<Option<String>>,
    pub(crate) trigger_run_id: Option<Option<String>>,
    pub(crate) sent_at: Option<String>,
    pub(crate) external_message_id: Option<String>,
    pub(crate) drop_scheduled_label: bool,
    pub(crate) soft_delete: bool,
    pub(crate) delivery: Option<(&'static str, String)>,
}

pub(crate) async fn apply_scheduled_patch(
    db: &PgPool,
    id: &str,
    patch: ScheduledPatch,
) -> Result<bool, sqlx::Error> {
    let labels: Option<Option<Value>> = sqlx::query_scalar(
        "select labels from mail_messages where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(labels) = labels else {
        return Ok(false);
    };
    let labels = patch.drop_scheduled_label.then(|| {
        labels_value(&remove_labels(
            &labels_of(labels.as_ref()),
            &["SCHEDULED".to_owned()],
        ))
    });
    let now = iso(time::OffsetDateTime::now_utc());
    let (delivery_status, delivery_detail) = patch.delivery.unzip();
    sqlx::query(
        "update mail_messages set updated_at = $2::timestamp,
           send_status = coalesce($3, send_status),
           scheduled_for = case when $4 then $5::timestamp else scheduled_for end,
           trigger_run_id = case when $6 then $7 else trigger_run_id end,
           sent_date = coalesce($8::timestamp, sent_date),
           external_message_id = coalesce($9, external_message_id),
           delivery_status = case when $10::text is null then delivery_status else $10 end,
           delivery_detail = case when $10::text is null then delivery_detail else $11 end,
           delivery_updated_at = case when $10::text is null then delivery_updated_at else $2::timestamp end,
           labels = case when $12::jsonb is null then labels else $12 end,
           deleted_at = case when $13 then $2::timestamp else deleted_at end
         where id = $1",
    )
    .bind(id)
    .bind(&now)
    .bind(patch.send_status)
    .bind(patch.scheduled_for.is_some())
    .bind(patch.scheduled_for.flatten())
    .bind(patch.trigger_run_id.is_some())
    .bind(patch.trigger_run_id.flatten())
    .bind(patch.sent_at)
    .bind(patch.external_message_id)
    .bind(delivery_status)
    .bind(delivery_detail)
    .bind(labels)
    .bind(patch.soft_delete)
    .execute(db)
    .await?;
    Ok(true)
}

/// The addresses of a recipient column.
fn addresses(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.get("email").and_then(Value::as_str))
        .filter(|e| !e.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `sendScheduledNow`'s send: the stored message through `sendAndPersist`,
/// then the scheduled row becomes the sent copy. On a partial send the
/// scheduled row goes; on any other failure it is left as it was for the
/// caller to restore or fail.
pub(crate) async fn deliver(
    deps: &SendDeps<'_>,
    org: &str,
    user_id: &str,
    message: &ScheduledRow,
) -> Result<SendResult, SendError> {
    let rows: Vec<(String, Option<String>, Option<i64>, Option<String>)> = sqlx::query_as(
        "select file_name, content_type, size::bigint, storage_path from mail_attachments
         where message_id = $1 and deleted_at is null",
    )
    .bind(&message.id)
    .fetch_all(deps.db)
    .await?;
    let attachments: Vec<SendAttachmentInput> = rows
        .into_iter()
        .filter_map(|(filename, content_type, size, path)| {
            path.filter(|p| !p.is_empty())
                .map(|file_key| SendAttachmentInput {
                    filename,
                    content_type,
                    size: size.unwrap_or(0),
                    file_key,
                })
        })
        .collect();
    let row = &message.row;
    let cc = addresses(&row["cc"]);
    let bcc = addresses(&row["bcc"]);
    let references = row["references"].as_array().map(|items| {
        items
            .iter()
            .filter_map(|r| r.as_str().map(str::to_owned))
            .collect::<Vec<_>>()
    });
    let input = SendInput {
        to: addresses(&row["to"]),
        cc: (!cc.is_empty()).then_some(cc),
        bcc: (!bcc.is_empty()).then_some(bcc),
        subject: row["subject"].as_str().map(str::to_owned),
        body: row["textBody"].as_str().map(str::to_owned),
        html_body: row["htmlBody"].as_str().map(str::to_owned),
        reply_to: None,
        in_reply_to: row["inReplyTo"].as_str().map(str::to_owned),
        references,
        attachments,
        idempotency_key: None,
    };
    let options = SendOptions {
        source: Some("scheduled".to_owned()),
        ..SendOptions::default()
    };
    match send_and_persist(deps, org, user_id, &message.account_id, &input, &options).await {
        Ok(result) => {
            // The stored row stays the canonical sent copy: the second copy
            // sendAndPersist recorded goes.
            sqlx::query("delete from mail_attachments where message_id = $1")
                .bind(&result.message_id)
                .execute(deps.db)
                .await?;
            sqlx::query("delete from mail_messages where id = $1 and account_id = $2")
                .bind(&result.message_id)
                .bind(&message.account_id)
                .execute(deps.db)
                .await?;
            apply_scheduled_patch(
                deps.db,
                &message.id,
                ScheduledPatch {
                    send_status: Some("sent"),
                    scheduled_for: Some(None),
                    sent_at: Some(iso(time::OffsetDateTime::now_utc())),
                    external_message_id: Some(result.external_message_id.clone()),
                    trigger_run_id: Some(None),
                    drop_scheduled_label: true,
                    ..ScheduledPatch::default()
                },
            )
            .await?;
            Ok(result)
        }
        Err(error) => {
            if matches!(&error, SendError::Mail { code, .. } if code == "PARTIALLY_SENT") {
                apply_scheduled_patch(
                    deps.db,
                    &message.id,
                    ScheduledPatch {
                        send_status: Some("cancelled"),
                        scheduled_for: Some(None),
                        trigger_run_id: Some(None),
                        soft_delete: true,
                        ..ScheduledPatch::default()
                    },
                )
                .await?;
            }
            Err(error)
        }
    }
}

/// A workspace's tenant database for the delivery job.
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

/// `SendScheduledEmailParams`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    /// The Clerk org id the schedule was made under.
    workspace_id: String,
    user_id: String,
    message_id: String,
}

/// `SendScheduledEmailWorkflow`: at the scheduled time (the job starts
/// then), send the stored message unless it was cancelled, rescheduled or
/// sent meanwhile. A refusal marks it failed.
pub struct SendScheduledEmailJob {
    pub state: MailState,
    pub tenants: TenantDatabases,
}

impl SendScheduledEmailJob {
    async fn send_once(&self, key: &str, params: &Params) -> Result<String, JobError> {
        let db = (self.tenants)(params.workspace_id.clone())
            .await
            .map_err(JobError::Failed)?;
        let fail = |error: sqlx::Error| JobError::Failed(error.to_string());
        let Some(message) = load_scheduled(&db, &params.message_id)
            .await
            .map_err(fail)?
        else {
            return Ok("skipped".to_owned());
        };
        if message.send_status.as_deref() != Some("scheduled")
            || message
                .trigger_run_id
                .as_deref()
                .is_some_and(|run| run != key)
        {
            return Ok("skipped".to_owned());
        }
        let context = SendContext::for_state(&self.state);
        let deps = context.deps_for(&db);
        match deliver(&deps, &params.workspace_id, &params.user_id, &message).await {
            Ok(_) => Ok("sent".to_owned()),
            Err(SendError::Mail { code, .. }) if code == "PARTIALLY_SENT" => Ok("sent".to_owned()),
            Err(error) => {
                let detail = match &error {
                    SendError::Mail { message, .. } => message.clone(),
                    SendError::Internal(message) => message.clone(),
                };
                tracing::warn!(
                    "[SendScheduledEmail] {} failed: {detail}",
                    params.message_id
                );
                apply_scheduled_patch(
                    &db,
                    &params.message_id,
                    ScheduledPatch {
                        send_status: Some("failed"),
                        trigger_run_id: Some(None),
                        delivery: Some(("failed", detail.chars().take(500).collect())),
                        ..ScheduledPatch::default()
                    },
                )
                .await
                .map_err(fail)?;
                Ok("failed".to_owned())
            }
        }
    }
}

impl Job for SendScheduledEmailJob {
    fn name(&self) -> &'static str {
        SEND_SCHEDULED_EMAIL_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let params: Params = serde_json::from_value(payload)?;
            let key = ctx.key().to_owned();
            let outcome: String =
                weldsuite_ports::step(ctx, "send-email", StepRetry::default(), || {
                    self.send_once(&key, &params)
                })
                .await?;
            tracing::info!(message = %params.message_id, outcome, "[SendScheduledEmail] done");
            Ok(())
        })
    }
}

/// The params a run is created with.
pub(crate) fn run_params(
    org: &str,
    user_id: &str,
    message_id: &str,
    account_id: &str,
    scheduled_for: &str,
) -> Value {
    json!({
        "workspaceId": org,
        "userId": user_id,
        "messageId": message_id,
        "accountId": account_id,
        "scheduledFor": scheduled_for,
    })
}

/// `Date.now()`.
pub(crate) fn now_millis() -> i64 {
    now_ms()
}
