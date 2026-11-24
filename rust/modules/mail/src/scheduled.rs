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

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde::Deserialize;
use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_mail_domain::labels::{labels_of, labels_value, remove_labels};
use weldsuite_mail_domain::messages::iso;
use weldsuite_mail_domain::outbound::clock::{now_ms, parse_iso};
use weldsuite_mail_domain::send::{
    SendAttachmentInput, SendDeps, SendError, SendInput, SendOptions, SendResult, send_and_persist,
};
use weldsuite_ports::{BoxFuture, DynJobs, Job, JobContext, JobError, JobRequest, StepRetry};
use weldsuite_schema::tenant::{mail_attachments, mail_messages};

use crate::MailState;
use crate::routes::mail_messages::message_json;
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
pub(crate) async fn load_scheduled(db: &PgPool, id: &str) -> Result<Option<ScheduledRow>, DbErr> {
    let row = mail_messages::Entity::find_by_id(id)
        .filter(mail_messages::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(message_json)
        .transpose()?;
    Ok(row.map(|row| ScheduledRow {
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
#[allow(clippy::option_option)] // unchanged, cleared or set, like the TypeScript patch
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

/// An ISO time (`toISOString()`) as the `timestamp` column holds it, as
/// `$n::timestamp` read it.
fn timestamp(text: &str) -> Result<PrimitiveDateTime, DbErr> {
    OffsetDateTime::parse(text, &Rfc3339)
        .map(utc_timestamp)
        .map_err(|error| DbErr::Type(format!("invalid timestamp {text:?}: {error}")))
}

pub(crate) async fn apply_scheduled_patch(
    db: &PgPool,
    id: &str,
    patch: ScheduledPatch,
) -> Result<bool, DbErr> {
    use mail_messages::Column;
    let labels: Option<Option<Value>> = mail_messages::Entity::find_by_id(id)
        .select_only()
        .column(Column::Labels)
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
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
    let now = utc_now();
    let mut update =
        mail_messages::Entity::update_many().col_expr(Column::UpdatedAt, Expr::value(now));
    if let Some(status) = patch.send_status {
        update = update.col_expr(Column::SendStatus, Expr::value(status));
    }
    if let Some(at) = patch.scheduled_for {
        let at = at.as_deref().map(timestamp).transpose()?;
        update = update.col_expr(Column::ScheduledFor, Expr::value(at));
    }
    if let Some(run) = patch.trigger_run_id {
        update = update.col_expr(Column::TriggerRunId, Expr::value(run));
    }
    if let Some(sent_at) = patch.sent_at {
        update = update.col_expr(Column::SentDate, Expr::value(timestamp(&sent_at)?));
    }
    if let Some(external) = patch.external_message_id {
        update = update.col_expr(Column::ExternalMessageId, Expr::value(external));
    }
    if let Some((status, detail)) = patch.delivery {
        update = update
            .col_expr(Column::DeliveryStatus, Expr::value(status))
            .col_expr(Column::DeliveryDetail, Expr::value(detail))
            .col_expr(Column::DeliveryUpdatedAt, Expr::value(now));
    }
    if let Some(labels) = labels {
        update = update.col_expr(Column::Labels, Expr::value(labels));
    }
    if patch.soft_delete {
        update = update.col_expr(Column::DeletedAt, Expr::value(now));
    }
    update.filter(Column::Id.eq(id)).exec(&orm(db)).await?;
    Ok(true)
}

/// A database error in the send path: `sendAndPersist`'s internal error.
#[allow(clippy::needless_pass_by_value)] // a `map_err` callback
fn internal(error: DbErr) -> SendError {
    SendError::Internal(error.to_string())
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

/// A stored attachment: file name, content type, size, storage path.
type StoredFile = (String, Option<String>, i32, Option<String>);

/// The message's live attachments that are in storage, to send again.
async fn stored_attachments(db: &PgPool, id: &str) -> Result<Vec<SendAttachmentInput>, DbErr> {
    let rows: Vec<StoredFile> = mail_attachments::Entity::find()
        .select_only()
        .columns([
            mail_attachments::Column::FileName,
            mail_attachments::Column::ContentType,
            mail_attachments::Column::Size,
            mail_attachments::Column::StoragePath,
        ])
        .filter(mail_attachments::Column::MessageId.eq(id))
        .filter(mail_attachments::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(filename, content_type, size, path)| {
            path.filter(|p| !p.is_empty())
                .map(|file_key| SendAttachmentInput {
                    filename,
                    content_type,
                    size: i64::from(size),
                    file_key,
                })
        })
        .collect())
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
    let attachments = stored_attachments(deps.db, &message.id)
        .await
        .map_err(internal)?;
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
            mail_attachments::Entity::delete_many()
                .filter(mail_attachments::Column::MessageId.eq(&result.message_id))
                .exec(&orm(deps.db))
                .await
                .map_err(internal)?;
            mail_messages::Entity::delete_many()
                .filter(mail_messages::Column::Id.eq(&result.message_id))
                .filter(mail_messages::Column::AccountId.eq(&message.account_id))
                .exec(&orm(deps.db))
                .await
                .map_err(internal)?;
            apply_scheduled_patch(
                deps.db,
                &message.id,
                ScheduledPatch {
                    send_status: Some("sent"),
                    scheduled_for: Some(None),
                    sent_at: Some(iso(OffsetDateTime::now_utc())),
                    external_message_id: Some(result.external_message_id.clone()),
                    trigger_run_id: Some(None),
                    drop_scheduled_label: true,
                    ..ScheduledPatch::default()
                },
            )
            .await
            .map_err(internal)?;
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
                .await
                .map_err(internal)?;
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
#[allow(clippy::struct_field_names)] // `SendScheduledEmailParams`, named as TypeScript names them
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
        let fail = |error: DbErr| JobError::Failed(error.to_string());
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
        let context = SendContext::for_state(&self.state).with_crm(
            &self.state,
            weldsuite_events::EventContext::new(
                &params.workspace_id,
                &params.user_id,
                weldsuite_events::EventSource::System,
            ),
        );
        let deps = context.deps_for(&db);
        match deliver(&deps, &params.workspace_id, &params.user_id, &message).await {
            Ok(_) => Ok("sent".to_owned()),
            Err(SendError::Mail { code, .. }) if code == "PARTIALLY_SENT" => Ok("sent".to_owned()),
            Err(error) => {
                let detail = match &error {
                    SendError::Mail { message, .. } | SendError::Internal(message) => {
                        message.clone()
                    }
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
