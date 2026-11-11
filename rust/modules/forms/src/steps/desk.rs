//! Step `desk` (`workflows/steps/desk.ts`, ADR FORMS-006, DESK-008): per
//! enabled `desk` integration, as the member who set it up: a conversation
//! (the ticket) in the inbox with a subject and body from recall templates,
//! the respondent as requester, a priority and tags, in a department (the
//! workspace's routing rules decide when none is chosen), and the
//! response's uploads attached.
//!
//! Written through `weldsuite_desk_domain::inbox`, the writer every module
//! outside the inbox uses: auto-assignment, the team notification and the
//! `desk_conversation` events follow as for any other ticket. The
//! conversation's external id is `form-response:<responseId>:<integrationId>`,
//! so a retry lands on the ticket it made instead of opening a second one,
//! and an edit of the response leaves it as it is.

use serde_json::{Map, Value, json};
use weldsuite_desk_domain::assignment::Picker;
use weldsuite_desk_domain::attributes::Update;
use weldsuite_desk_domain::inbox::{
    Actor, InboxDeps, InboxEmitter, InboxError, InboxEvent, IngestApi, OpenConversation,
    open_desk_api_conversation,
};
use weldsuite_kit::validation::{Field, js_trim};
use weldsuite_notifications::Notifier;
use weldsuite_ports::{BoxFuture, PutOptions};

use crate::common::{Ctx, js_slice, text};
use crate::creator_access::load_creator_access;
use crate::engine::find_field;
use crate::integration_config::desk_config;
use crate::integration_support::{
    StepFail, TemplateContext, answer_lines, answer_text, email_answer, emit_record_event,
    number_text, random_uuid, read_response_file, recorded_entity, remember_entity,
    render_template, safe_file_name,
};
use crate::process::{ProcessContext, ProcessStep, StepKind, StepResult};

pub(crate) struct DeskStep;

impl ProcessStep for DeskStep {
    fn name(&self) -> &'static str {
        "desk"
    }

    fn kind(&self) -> StepKind {
        StepKind::Integration("desk")
    }

    fn run<'a>(
        &'a self,
        ctx: &'a ProcessContext,
        integration: Option<&'a Value>,
    ) -> BoxFuture<'a, Result<StepResult, String>> {
        Box::pin(async move {
            let Some(integration) = integration else {
                return Err("forms: the Desk step runs per integration".to_owned());
            };
            run_desk_step(ctx, integration).await
        })
    }
}

/// `PRIORITY`: the form's priority as the inbox's.
fn priority_of(priority: &str) -> &'static str {
    match priority {
        "low" => "low",
        "high" => "high",
        "urgent" => "urgent",
        _ => "medium",
    }
}

/// Types the inbox may serve inline from the public bucket; anything else
/// is stored as a download.
const PASSIVE_TYPES: [&str; 12] = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
    "text/plain",
    "text/csv",
    "application/zip",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

/// `copyAttachments(ctx)`: the response's uploads, copied to the public
/// bucket (an unguessable path), in the desk message shape.
async fn copy_attachments(ctx: &ProcessContext) -> Result<Vec<Value>, StepFail> {
    let env = ctx.ctx.env();
    let base = env
        .get("R2_PUBLIC_URL")
        .or_else(|| env.get("S3_PUBLIC_URL"))
        .map(|base| js_trim(&base).trim_end_matches('/').to_owned())
        .filter(|base| !base.is_empty());
    let public = ctx
        .ctx
        .svc
        .files
        .as_ref()
        .and_then(|files| files.public.clone());
    let (Some(base), Some(public)) = (base, public) else {
        return Ok(Vec::new());
    };
    if ctx.files.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for file in ctx.files.iter().take(10) {
        let Some(body) = read_response_file(&ctx.ctx, file).await? else {
            continue;
        };
        let content_type = text(file, "contentType");
        let kind = js_trim(content_type.split(';').next().unwrap_or_default()).to_lowercase();
        let passive = PASSIVE_TYPES.contains(&kind.as_str());
        let name = safe_file_name(text(file, "name"));
        let key = format!(
            "desk/{}/forms/{}/{}/{name}",
            ctx.params.clerk_org_id,
            text(&ctx.response, "id"),
            random_uuid()
        );
        let stored_type = if passive {
            kind.clone()
        } else {
            "application/octet-stream".to_owned()
        };
        let options = PutOptions {
            content_type: Some(stored_type.clone()),
            content_disposition: Some(if passive {
                format!("inline; filename=\"{name}\"")
            } else {
                format!("attachment; filename=\"{name}\"")
            }),
            ..PutOptions::default()
        };
        public
            .put_boxed(&key, body, &options)
            .await
            .map_err(|error| StepFail::Error(error.to_string()))?;
        out.push(json!({
            "name": text(file, "name"),
            "url": format!("{base}/{key}"),
            "contentType": stored_type,
            "filesize": file["sizeBytes"],
        }));
    }
    Ok(out)
}

/// `requesterOf(ctx, requesterFieldId)`: the chosen email question (and the
/// name from a contact question), else the verified email.
fn requester_of(ctx: &ProcessContext, field_id: Option<&str>) -> (Option<String>, Option<String>) {
    let answers = &ctx.response["answers"];
    let from_field =
        field_id.map_or_else(String::new, |id| email_answer(&ctx.definition, answers, id));
    let email = Some(from_field).filter(|e| !e.is_empty()).or_else(|| {
        ctx.response["respondentEmail"]
            .as_str()
            .filter(|e| !e.is_empty())
            .map(str::to_owned)
    });
    let name = field_id
        .filter(|id| {
            find_field(&ctx.definition, id).is_some_and(|f| f.kind.type_name() == "contact_info")
        })
        .and_then(|id| {
            let parts: Vec<String> = ["firstName", "lastName"]
                .into_iter()
                .map(|part| answer_text(&ctx.definition, answers, id, Some(part)))
                .filter(|part| !part.is_empty())
                .collect();
            (!parts.is_empty()).then(|| parts.join(" "))
        });
    (email, name)
}

/// The desk-domain emitter: every event as the integration's creator
/// (`publishEntityEventRaw({ workspaceId: clerkOrgId, userId, source: 'api' })`).
struct CreatorEmitter<'a> {
    ctx: &'a Ctx,
    creator: &'a str,
}

impl InboxEmitter for CreatorEmitter<'_> {
    fn emit<'a>(&'a self, event: &'a InboxEvent) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            emit_record_event(
                self.ctx,
                self.creator,
                event.entity_type,
                event.action,
                &event.entity_id,
                &event.data,
            )
            .await;
            Ok(())
        })
    }
}

/// `runDeskStep(ctx, integration)`.
pub(crate) async fn run_desk_step(
    ctx: &ProcessContext,
    integration: &Value,
) -> Result<StepResult, String> {
    let Some(config) = desk_config(&integration["config"]) else {
        return Ok(StepResult::Skipped(
            "The Desk integration is not set up correctly".to_owned(),
        ));
    };
    match desk_body(ctx, integration, &config).await {
        Ok(result) => Ok(result),
        Err(StepFail::Forbidden(reason)) => Ok(StepResult::Skipped(reason.0)),
        Err(StepFail::Error(message)) => Err(message),
    }
}

#[allow(clippy::too_many_lines, reason = "the worker's steps, in its order")]
async fn desk_body(
    ctx: &ProcessContext,
    integration: &Value,
    config: &crate::integration_config::DeskConfig,
) -> Result<StepResult, StepFail> {
    let response_id = text(&ctx.response, "id");
    let integration_id = text(integration, "id");
    let creator = text(integration, "createdByUserId");
    let recorded = recorded_entity(&ctx.db, response_id, integration_id).await?;
    // A ticket this integration already opened for the response stays as the team found it: a retry or an edit adds nothing.
    if let Some((kind, id)) = recorded
        && kind == "desk_conversation"
    {
        return Ok(StepResult::Done {
            entity_type: Some(kind),
            entity_id: Some(id),
        });
    }
    let access = load_creator_access(&ctx.db, ctx.ctx.env(), creator).await?;
    access.require("tickets:create", "welddesk", "open tickets")?;

    let template = TemplateContext {
        env: ctx.ctx.env(),
        form: &ctx.form,
        response: &ctx.response,
        definition: &ctx.definition,
    };
    let fallback = js_trim(&format!(
        "{} #{}",
        text(&ctx.form, "title"),
        number_text(&ctx.response)
    ))
    .to_owned();
    let title = Some(js_trim(&render_template(&config.subject, &template)).to_owned())
        .filter(|t| !t.is_empty())
        .unwrap_or(fallback);
    let raw_body = if js_trim(&config.body).is_empty() {
        answer_lines(&ctx.definition, &ctx.response["answers"])
    } else {
        render_template(&config.body, &template)
    };
    let body = Some(js_trim(&raw_body).to_owned())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| title.clone());
    let (email, name) = requester_of(ctx, config.requester_field_id.as_deref());
    let attachments = if config.attach_files {
        copy_attachments(ctx).await?
    } else {
        Vec::new()
    };

    let mut metadata = Map::new();
    metadata.insert("formId".to_owned(), json!(text(&ctx.form, "id")));
    metadata.insert("responseId".to_owned(), json!(response_id));
    metadata.insert("integrationId".to_owned(), json!(integration_id));
    let fields = Update {
        priority: Field::Set(priority_of(&config.priority).to_owned()),
        tags: (!config.tags.is_empty()).then(|| config.tags.clone()),
        department_id: config
            .department_id
            .clone()
            .filter(|id| !id.is_empty())
            .map_or(Field::Absent, Field::Set),
        ..Update::default()
    };
    let input = OpenConversation {
        ingest: IngestApi {
            via: "api".to_owned(),
            external_id: Some(format!("form-response:{response_id}:{integration_id}")),
            title: Some(js_slice(&title, 255)),
            body,
            name: Some(
                name.or_else(|| email.clone())
                    .unwrap_or_else(|| text(&ctx.form, "title").to_owned()),
            ),
            email,
            contact_id: None,
            attachments: (!attachments.is_empty()).then_some(attachments),
            metadata,
        },
        fields,
        assignee_id: None,
    };

    let emitter = CreatorEmitter {
        ctx: &ctx.ctx,
        creator,
    };
    let notifier = Notifier {
        realtime: ctx.ctx.svc.realtime.clone(),
        ..Notifier::default()
    };
    let deps = InboxDeps {
        db: &ctx.db,
        clerk_org_id: &ctx.params.clerk_org_id,
        emitter: &emitter,
        rooms: ctx.ctx.svc.realtime.clone(),
        notifier: &notifier,
        picker: Picker::Local,
        due: ctx
            .ctx
            .master
            .as_ref()
            .map(|master| (master, ctx.ctx.workspace_id.as_str())),
    };
    let actor = Actor {
        author_type: "bot",
        author_id: Some(integration_id),
    };
    let result = match open_desk_api_conversation(&deps, &input, Some(actor)).await {
        Ok(result) => result,
        // A department that was removed or switched off: a retry cannot fix it, the author must.
        Err(InboxError::Rejected { message, .. }) => return Ok(StepResult::Skipped(message)),
        Err(error) => return Err(StepFail::Error(error.to_string())),
    };
    let conversation_id = result.conversation["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    remember_entity(
        &ctx.db,
        response_id,
        integration_id,
        "desk_conversation",
        &conversation_id,
    )
    .await?;
    Ok(StepResult::Done {
        entity_type: Some("desk_conversation".to_owned()),
        entity_id: Some(conversation_id),
    })
}
