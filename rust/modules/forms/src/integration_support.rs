//! What the integration steps (CRM, Desk, Flow) share
//! (`services/integration-support.ts`): recall templates with the
//! integration-only tokens, one answer as text, the link to a response, the
//! record a step made (kept on its action row so a retry reuses it), and
//! reading a response's uploads so they can be copied where the target
//! module opens them.

use std::fmt::Write as _;
use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde_json::{Map, Value};
use sqlx::PgPool;
use weldsuite_events::{EntityEvent, EventContext, EventSource, EventType};
use weldsuite_kit::validation::js_trim;

use crate::common::{Ctx, Env, Fail, FormsResult, text};
use crate::creator_access::CreatorForbidden;
use crate::engine::{
    FormDefinition, PreparedAnswer, RecallContext, display_answer, fields_of, find_field,
    prepare_answer, recall,
};

/// How an integration step stopped: its creator may not do it (the step is
/// skipped with the reason, `CreatorForbiddenError`), or it failed (retried,
/// then recorded with the message).
#[derive(Debug)]
pub(crate) enum StepFail {
    Forbidden(CreatorForbidden),
    Error(String),
}

impl From<CreatorForbidden> for StepFail {
    fn from(forbidden: CreatorForbidden) -> Self {
        Self::Forbidden(forbidden)
    }
}

impl From<Fail> for StepFail {
    fn from(fail: Fail) -> Self {
        Self::Error(match fail {
            Fail::Api(error) => error.message().to_owned(),
            Fail::Internal(message) => message,
            Fail::Response(_) => "forms: the step failed".to_owned(),
        })
    }
}

impl From<sqlx::Error> for StepFail {
    fn from(error: sqlx::Error) -> Self {
        Self::Error(error.to_string())
    }
}

/// `responseUrl(env, formId, responseId)`: the member-side page of one
/// response (`<PLATFORM_URL>/weldforms/<formId>/results?...`).
pub(crate) fn response_url(env: &Env, form_id: &str, response_id: &str) -> String {
    let base = env
        .non_empty("PLATFORM_URL")
        .unwrap_or_else(|| "https://app.weldsuite.org".to_owned());
    let base = base.strip_suffix('/').unwrap_or(&base);
    format!("{base}/weldforms/{form_id}/results?tab=responses&response={response_id}")
}

/// What a template can recall (`TemplateContext`): the engine's tokens over
/// the response, plus `{{form:title}}`, `{{response:number}}` and
/// `{{response:url}}`.
pub(crate) struct TemplateContext<'a> {
    pub(crate) env: &'a Env,
    /// The `forms` row.
    pub(crate) form: &'a Value,
    /// The `form_responses` row.
    pub(crate) response: &'a Value,
    pub(crate) definition: &'a FormDefinition,
}

/// JavaScript's `\s`.
const JS_SPACE: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// `EXTRA_TOKEN_RE`.
static EXTRA_TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"\{{\{{[{JS_SPACE}]*(form:title|response:number|response:url)[{JS_SPACE}]*\}}\}}"
    ))
    .expect("the token pattern compiles")
});

/// A response's number as `String(number)`, empty when it has none.
pub(crate) fn number_text(response: &Value) -> String {
    match &response["number"] {
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

fn object_of(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// `renderTemplate(text, ctx)`.
pub(crate) fn render_template(template: &str, ctx: &TemplateContext<'_>) -> String {
    let with_extras =
        EXTRA_TOKEN_RE.replace_all(template, |captures: &Captures<'_>| match &captures[1] {
            "form:title" => text(ctx.form, "title").to_owned(),
            "response:number" => number_text(ctx.response),
            _ => response_url(ctx.env, text(ctx.form, "id"), text(ctx.response, "id")),
        });
    recall(
        &with_extras,
        ctx.definition,
        RecallContext {
            answers: object_of(&ctx.response["answers"]),
            hidden: object_of(&ctx.response["hidden"]),
            variables: object_of(&ctx.response["variables"]),
        },
        false,
    )
}

/// `answerText(definition, response, blockId, part?)`: the text of one
/// answer; of one `part` (`email`, `firstName`, …) of a contact or address
/// question. Empty when unanswered or the question is gone.
pub(crate) fn answer_text(
    definition: &FormDefinition,
    answers: &Value,
    block_id: &str,
    part: Option<&str>,
) -> String {
    let Some(field) = find_field(definition, block_id) else {
        return String::new();
    };
    let raw = answers.get(&field.id);
    if let Some(part) = part
        && field.kind.is_composite()
    {
        return match prepare_answer(field, raw) {
            PreparedAnswer::Value(answer) => answer
                .part(part)
                .map(js_trim)
                .unwrap_or_default()
                .to_owned(),
            PreparedAnswer::Empty | PreparedAnswer::Invalid(_) => String::new(),
        };
    }
    js_trim(&display_answer(field, raw)).to_owned()
}

/// `emailAnswer(definition, response, blockId)`: the email of a response
/// through an email or contact-info question, lowercased.
pub(crate) fn email_answer(definition: &FormDefinition, answers: &Value, block_id: &str) -> String {
    let Some(field) = find_field(definition, block_id) else {
        return String::new();
    };
    let value = if field.kind.type_name() == "contact_info" {
        answer_text(definition, answers, block_id, Some("email"))
    } else {
        answer_text(definition, answers, block_id, None)
    };
    value.to_lowercase()
}

/// `answerLines(definition, response)`: every answered question as
/// "Question: answer" lines, without the sensitive ones and the files.
pub(crate) fn answer_lines(definition: &FormDefinition, answers: &Value) -> String {
    let mut lines = Vec::new();
    for field in fields_of(definition) {
        let kind = field.kind.type_name();
        if field.sensitive == Some(true) || kind == "file_upload" || kind == "signature" {
            continue;
        }
        let answer = display_answer(field, answers.get(&field.id));
        let answer = js_trim(&answer);
        if !answer.is_empty() {
            lines.push(format!("{}: {answer}", field.title));
        }
    }
    lines.join("\n")
}

/// `findPersonByEmail(db, email)` (`steps/crm.ts`): a CRM person with this
/// (lowercased) email.
pub(crate) async fn find_person_by_email(db: &PgPool, email: &str) -> FormsResult<Option<Value>> {
    crate::common::one(
        db,
        sqlx::query_scalar(
            "select to_jsonb(p) from people p              where lower(p.email) = $1 and p.deleted_at is null and p.in_crm = true limit 1",
        )
        .bind(email),
    )
    .await
}

// ── The record a step made ───────────────────────────────────────────────────

/// `recordedEntity(db, ctx, integration)`: the record an earlier attempt of
/// this step already made (and recorded), as `(entityType, entityId)`.
pub(crate) async fn recorded_entity(
    db: &PgPool,
    response_id: &str,
    integration_id: &str,
) -> FormsResult<Option<(String, String)>> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "select entity_type, entity_id from form_response_actions \
         where response_id = $1 and integration_id = $2 limit 1",
    )
    .bind(response_id)
    .bind(integration_id)
    .fetch_optional(db)
    .await?;
    Ok(match row {
        Some((Some(kind), Some(id))) if !kind.is_empty() && !id.is_empty() => Some((kind, id)),
        _ => None,
    })
}

/// `rememberEntity(db, ctx, integration, entityType, entityId)`: the record
/// on the action row right away, so a failure after it exists retries into
/// the same record.
pub(crate) async fn remember_entity(
    db: &PgPool,
    response_id: &str,
    integration_id: &str,
    entity_type: &str,
    entity_id: &str,
) -> FormsResult<()> {
    sqlx::query(
        "update form_response_actions set entity_type = $3, entity_id = $4 \
         where response_id = $1 and integration_id = $2",
    )
    .bind(response_id)
    .bind(integration_id)
    .bind(entity_type)
    .bind(entity_id)
    .execute(db)
    .await?;
    Ok(())
}

/// `emitRecordEvent(ctx, integration, entityType, action, entityId, data)`:
/// an entity event for a record a step made, as the integration's creator
/// (`publishEntityEventRaw({ workspaceId: clerkOrgId, userId, source: 'api' })`),
/// awaited as the worker awaits it.
pub(crate) async fn emit_record_event(
    ctx: &Ctx,
    actor: &str,
    entity_type: &str,
    action: &str,
    entity_id: &str,
    data: &Value,
) {
    let Ok(event) = EventType::catalog(entity_type, action) else {
        tracing::error!(
            entity_type,
            action,
            "forms: not a catalog event; dropping it"
        );
        return;
    };
    let context = EventContext::new(ctx.clerk_org_id.clone(), actor, EventSource::Api);
    ctx.svc
        .events
        .publish_and_wait(&context, EntityEvent::new(event, entity_id, data.clone()))
        .await;
}

// ── Uploads ──────────────────────────────────────────────────────────────────

/// `safeFileName(name)`: the characters a stored file name may keep, the
/// last 120, `file` when nothing is left.
pub(crate) fn safe_file_name(name: &str) -> String {
    // Per UTF-16 unit, as the pattern has no `u` flag: a surrogate pair is two `_`.
    let mut cleaned = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            cleaned.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                cleaned.push('_');
            }
        }
    }
    let cleaned = cleaned.trim_start_matches('.');
    let start = cleaned.len().saturating_sub(120);
    let tail = &cleaned[start..];
    if tail.is_empty() {
        "file".to_owned()
    } else {
        tail.to_owned()
    }
}

/// `readResponseFile(env, file)`: a response file from the private bucket;
/// `None` when the object (or the bucket) is gone.
pub(crate) async fn read_response_file(ctx: &Ctx, file: &Value) -> FormsResult<Option<Vec<u8>>> {
    let Some(files) = ctx.svc.files.as_ref() else {
        return Ok(None);
    };
    Ok(files
        .private
        .get_boxed(text(file, "storageKey"))
        .await?
        .map(|object| object.bytes))
}

/// `crypto.randomUUID()`.
pub(crate) fn random_uuid() -> String {
    let mut bytes = crate::crypto::random_bytes::<16>();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let mut out = String::with_capacity(36);
    for (i, byte) in bytes.iter().enumerate() {
        if matches!(i, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn file_names_keep_what_a_key_may_hold() {
        assert_eq!(safe_file_name("My CV (final).pdf"), "My_CV__final_.pdf");
        assert_eq!(safe_file_name("..hidden"), "hidden");
        assert_eq!(safe_file_name("😀.txt"), "__.txt");
        assert_eq!(safe_file_name("..."), "file");
        assert_eq!(safe_file_name(&"a".repeat(130)).len(), 120);
        let uuid = random_uuid();
        assert_eq!(uuid.len(), 36);
        assert_eq!(&uuid[14..15], "4");
    }

    #[test]
    fn templates_recall_the_extra_tokens() {
        let definition = FormDefinition::parse(&json!({
            "blocks": [{ "id": "b_name", "ref": "name", "type": "short_text", "title": "Name", "properties": {} }],
            "endings": [{ "id": "e_done", "ref": "thanks", "title": "Thanks" }],
        }))
        .unwrap();
        let env = Env::default();
        let form = json!({ "id": "frm_1", "title": "Contact us" });
        let response = json!({ "id": "frs_1", "number": 7, "answers": { "b_name": "Ada" }, "hidden": {}, "variables": {} });
        let ctx = TemplateContext {
            env: &env,
            form: &form,
            response: &response,
            definition: &definition,
        };
        assert_eq!(
            render_template(
                "{{ form:title }} #{{response:number}}: {{field:name}}",
                &ctx
            ),
            "Contact us #7: Ada"
        );
        assert_eq!(
            render_template("{{response:url}}", &ctx),
            "https://app.weldsuite.org/weldforms/frm_1/results?tab=responses&response=frs_1"
        );
        assert_eq!(answer_lines(&definition, &response["answers"]), "Name: Ada");
    }
}
