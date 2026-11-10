//! Submitting a response (`services/submit.ts`): the one path the public
//! portal and the members-only page both take. The engine replays the logic
//! over the submitted answers, drops answers to blocks off the path, checks
//! the required fields on it, recomputes the variables and the score and
//! picks the ending.
//!
//! 1. checks (form still open, one per respondent, response limit)
//! 2. engine validation (422 `VALIDATION_FAILED`, `details.fields`)
//! 3. files: the answers may only reference this response's own uploads
//! 4. the number from `forms.response_counter`, then one transaction
//! 5. entity events, `ProcessResponse`, the public cache

use std::collections::{BTreeMap, HashSet};

use serde_json::{Map, Value, json};
use sqlx::types::Json;
use weldsuite_catalogs::entity_events::{
    FORM_INVITATION_COMPLETED, FORM_RESPONSE_SUBMITTED, FORM_RESPONSE_UPDATED,
};
use weldsuite_ports::PutOptions;

use crate::common::{
    Ctx, Fail, FormsResult, forms_error, forms_error_with, int, iso, js_slice, one, opt_text, text,
};
use crate::engine::{
    AnswerValue, EngineInput, FileAnswerItem, FormDefinition, RecallContext, display_answer,
    evaluate_submission, fields_of, recall, search_text,
};
use crate::model::FormSettings;
use crate::process::{ProcessResponseParams, start_processing};
use crate::public_cache::refresh_public_cache;
use crate::public_form::closed_error;

pub(crate) const PENDING_PREFIX: &str = "weldforms/pending/";

/// `pendingKey(responseId, fileId)`.
pub(crate) fn pending_key(response_id: &str, file_id: &str) -> String {
    format!("{PENDING_PREFIX}{response_id}/{file_id}")
}

/// `safeName(name)`: `[^A-Za-z0-9._-]+` → `_`, at most 100, `file` when empty.
fn safe_name(name: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    let out = js_slice(&out, 100);
    if out.is_empty() {
        "file".to_owned()
    } else {
        out
    }
}

/// `finalKey(ctx, formId, responseId, file)`.
fn final_key(ctx: &Ctx, form_id: &str, response_id: &str, file_id: &str, name: &str) -> String {
    format!(
        "workspaces/{}/weldforms/{form_id}/{response_id}/{file_id}-{}",
        ctx.clerk_org_id,
        safe_name(name)
    )
}

/// `answersByRef(def, answers)`: display text by field `ref`, without files,
/// signatures and fields marked sensitive.
pub(crate) fn answers_by_ref(
    def: &FormDefinition,
    answers: &Map<String, Value>,
) -> Map<String, Value> {
    let mut out = Map::new();
    for field in fields_of(def) {
        if field.sensitive == Some(true) || field.kind.is_file() {
            continue;
        }
        let Some(value) = answers.get(&field.id) else {
            continue;
        };
        let display = display_answer(field, Some(value));
        if !display.is_empty() {
            out.insert(field.r#ref.clone(), Value::String(display));
        }
    }
    out
}

/// Who answered (`SubmitIdentity`).
#[derive(Debug, Clone, Default)]
pub(crate) struct Identity {
    /// Verified email (code or invitation) or the member's email.
    pub(crate) email: Option<String>,
    /// The member on members-only forms that do not hide identities.
    pub(crate) user_id: Option<String>,
    /// Keyed hash enforcing one response per member or per browser.
    pub(crate) hash: Option<String>,
    pub(crate) invitation_id: Option<String>,
}

/// What the session arrived with (`Pick<SessionSeed, 'metadata' | 'ipHash' | 'startedAt'>`).
#[derive(Debug, Clone, Default)]
pub(crate) struct Seed {
    pub(crate) metadata: Map<String, Value>,
    pub(crate) ip_hash: Option<String>,
    pub(crate) started_at: i64,
}

/// `SubmitArgs`.
pub(crate) struct SubmitArgs<'a> {
    pub(crate) form: &'a Value,
    pub(crate) version: &'a Value,
    pub(crate) response_id: &'a str,
    pub(crate) answers: &'a Map<String, Value>,
    pub(crate) hidden: &'a Map<String, Value>,
    pub(crate) timings: Option<&'a Map<String, Value>>,
    pub(crate) identity: Identity,
    pub(crate) seed: Option<Seed>,
    /// The actor on the entity events: `respondent`, or the member.
    pub(crate) actor: &'a str,
}

/// `assertAcceptingSubmissions(ctx, form, edited, now)`.
async fn assert_accepting(ctx: &Ctx, form: &Value, edited: bool, now_ms: i64) -> FormsResult<()> {
    let settings = FormSettings::parse(&form["settings"]);
    if let Some(public_id) = opt_text(form, "publicId") {
        let flags: Option<(bool, bool)> = sqlx::query_as(
            "select suspended_at is not null, held_at is not null from form_link_registry \
             where public_id = $1 limit 1",
        )
        .bind(public_id)
        .fetch_optional(ctx.master()?)
        .await?;
        if let Some((suspended, held)) = flags {
            if suspended {
                return Err(closed_error("suspended"));
            }
            if held {
                return Err(closed_error("held"));
            }
        }
    }
    if text(form, "status") != "published" {
        return Err(closed_error("closed"));
    }
    if settings
        .closes_at
        .as_deref()
        .and_then(crate::common::parse_ms)
        .is_some_and(|closes| closes <= now_ms)
    {
        return Err(closed_error("past_close_date"));
    }
    if !edited
        && settings
            .response_limit
            .is_some_and(|limit| int(form, "responseCount") >= limit)
    {
        return Err(closed_error("limit_reached"));
    }
    Ok(())
}

/// `assertFirstResponse(ctx, formId, responseId, identity)`: another
/// completed response of the same person refuses this one.
async fn assert_first_response(
    ctx: &Ctx,
    form_id: &str,
    response_id: &str,
    identity: &Identity,
) -> FormsResult<()> {
    let mut q =
        sqlx::QueryBuilder::<sqlx::Postgres>::new("select id from form_responses where form_id = ");
    q.push_bind(form_id.to_owned())
        .push(" and status = 'completed' and id <> ")
        .push_bind(response_id.to_owned())
        .push(" and (");
    let mut any = false;
    for (column, value) in [
        ("respondent_email", &identity.email),
        ("respondent_user_id", &identity.user_id),
        ("respondent_hash", &identity.hash),
        ("invitation_id", &identity.invitation_id),
    ] {
        if let Some(value) = value.as_ref().filter(|v| !v.is_empty()) {
            if any {
                q.push(" or ");
            }
            q.push(format!("{column} = ")).push_bind(value.clone());
            any = true;
        }
    }
    if !any {
        return Ok(());
    }
    q.push(") limit 1");
    let found: Option<String> = q.build_query_scalar().fetch_optional(&ctx.db).await?;
    if found.is_some() {
        return Err(forms_error(
            409,
            "ALREADY_SUBMITTED",
            "You already submitted this form.",
        ));
    }
    Ok(())
}

/// `buildResult(def, result, responseId, number, hidden)`: the ending with
/// recall filled in.
#[allow(
    clippy::too_many_arguments,
    reason = "the engine's result, taken apart"
)]
fn build_result(
    def: &FormDefinition,
    ending_id: &str,
    answers: &Map<String, Value>,
    hidden: &Map<String, Value>,
    variables: &Map<String, Value>,
    response_id: &str,
    number: i64,
    score: f64,
    quiz: &Value,
) -> Value {
    let ending = def
        .endings
        .iter()
        .find(|e| e.id == ending_id)
        .or_else(|| def.endings.first());
    let ctx = RecallContext {
        answers: Some(answers),
        hidden: Some(hidden),
        variables: Some(variables),
    };
    let Some(ending) = ending else {
        return json!({ "responseId": response_id, "number": number, "score": score, "quiz": null });
    };
    json!({
        "responseId": response_id,
        "number": number,
        "ending": {
            "id": ending.id,
            "title": recall(&ending.title, def, ctx, false),
            "description": ending.description.as_deref().map(|d| recall(d, def, ctx, false)),
            "redirectUrl": ending.redirect_url.as_deref().map(|u| recall(u, def, ctx, true)),
            "button": ending.button.as_ref().map(|b| json!({ "text": b.text, "url": recall(&b.url, def, ctx, true) })),
            "showScore": ending.show_score,
            "showAnswers": ending.show_answers,
        },
        "score": crate::engine::js::number_value(score),
        "quiz": if ending.show_answers { quiz.clone() } else { Value::Null },
    })
}

/// The outcome of a submit: the respondent's result and whether it was an edit.
pub(crate) struct Submitted {
    pub(crate) result: Value,
}

fn already_submitted() -> Fail {
    forms_error(409, "ALREADY_SUBMITTED", "This form was already submitted.")
}

/// The completed response's columns, on insert and on update alike. A new
/// response's upsert is its claim (`CLAIM_GUARD`).
const UPSERT_RESPONSE: &str = "insert into form_responses (id, form_id, version_id, number, status, answers, hidden, variables, \
     ending_id, score, respondent_email, respondent_user_id, respondent_hash, invitation_id, last_block_id, \
     answered_count, search_text, metadata, ip_hash, started_at, submitted_at, duration_ms, updated_at, person_id) \
     values ($1, $2, $3, $4, 'completed', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, \
     $19::timestamptz, $20::timestamptz, $21, $20::timestamptz, $22) \
     on conflict (id) do update set form_id = excluded.form_id, version_id = excluded.version_id, \
     number = excluded.number, status = excluded.status, answers = excluded.answers, hidden = excluded.hidden, \
     variables = excluded.variables, ending_id = excluded.ending_id, score = excluded.score, \
     respondent_email = excluded.respondent_email, respondent_user_id = excluded.respondent_user_id, \
     respondent_hash = excluded.respondent_hash, invitation_id = excluded.invitation_id, \
     last_block_id = excluded.last_block_id, answered_count = excluded.answered_count, \
     search_text = excluded.search_text, metadata = excluded.metadata, ip_hash = excluded.ip_hash, \
     submitted_at = excluded.submitted_at, duration_ms = excluded.duration_ms, updated_at = excluded.updated_at, \
     person_id = excluded.person_id";

/// A new response is only written while it is not completed: of two submits
/// of one response (a double click), one gets past it.
const CLAIM_GUARD: &str = " where form_responses.status <> 'completed'";

/// `submitResponse(args)`: a call that loses the race to a submit of the
/// same response runs once more, now on the completed response: as an
/// edit, or refused.
pub(crate) async fn submit_response(ctx: &Ctx, args: SubmitArgs<'_>) -> FormsResult<Submitted> {
    if let Some(submitted) = submit_once(ctx, &args).await? {
        return Ok(submitted);
    }
    submit_once(ctx, &args).await?.ok_or_else(already_submitted)
}

/// One attempt at the submit; `None` when another call completed the
/// response after this one read it.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
async fn submit_once(ctx: &Ctx, args: &SubmitArgs<'_>) -> FormsResult<Option<Submitted>> {
    let now_ms = ctx.now_ms();
    let now = iso(now_ms);
    let form = args.form;
    let form_id = text(form, "id").to_owned();
    let settings = FormSettings::parse(&form["settings"]);
    let def = crate::public_form::definition_of(args.version)?;

    let existing = crate::respondent::response_row(ctx, args.response_id).await?;
    if existing
        .as_ref()
        .is_some_and(|e| text(e, "formId") != form_id)
    {
        return Err(forms_error(404, "NOT_FOUND", "Response not found"));
    }
    let edited = existing
        .as_ref()
        .is_some_and(|e| text(e, "status") == "completed");
    let identity = &args.identity;
    if edited
        && !(settings.allow_edit && (identity.email.is_some() || identity.invitation_id.is_some()))
    {
        return Err(already_submitted());
    }
    assert_accepting(ctx, form, edited, now_ms).await?;
    if !edited && settings.one_per_respondent {
        assert_first_response(ctx, &form_id, args.response_id, identity).await?;
    }

    // 2. The engine decides the path, the score and the ending.
    let hidden_names: HashSet<&str> = def.hidden.iter().map(|h| h.name.as_str()).collect();
    let hidden: Map<String, Value> = args
        .hidden
        .iter()
        .filter(|(name, _)| hidden_names.contains(name.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let result = evaluate_submission(
        &def,
        EngineInput {
            answers: Some(args.answers),
            hidden: Some(&hidden),
        },
    );
    let mut errors: BTreeMap<String, Value> = result
        .errors
        .iter()
        .map(|(id, error)| {
            (
                id.clone(),
                serde_json::to_value(error).unwrap_or(Value::Null),
            )
        })
        .collect();

    // 3. Files: an answer may only name this response's own uploads, for its own field.
    let files: Vec<Value> = crate::common::all(
        &ctx.db,
        sqlx::query_scalar("select to_jsonb(f) from form_response_files f where response_id = $1")
            .bind(args.response_id),
    )
    .await?;
    let engine_answers: Map<String, Value> = result
        .answers
        .iter()
        .map(|(id, answer)| (id.clone(), answer.to_json()))
        .collect();
    let mut answers = engine_answers.clone();
    let mut used: HashSet<String> = HashSet::new();
    for field in fields_of(&def) {
        if !field.kind.is_file() {
            continue;
        }
        let Some(value) = result.answers.get(&field.id) else {
            continue;
        };
        let items: Vec<&FileAnswerItem> = match value {
            AnswerValue::Files(items) => items.iter().collect(),
            AnswerValue::File(item) => vec![item],
            _ => Vec::new(),
        };
        let is_signature = matches!(value, AnswerValue::File(_));
        let mut resolved = Vec::new();
        for item in items {
            let row = files.iter().find(|f| text(f, "id") == item.file_id);
            let Some(row) = row
                .filter(|row| text(row, "blockId") == field.id && text(row, "formId") == form_id)
            else {
                errors.insert(field.id.clone(), json!({ "code": "invalid" }));
                break;
            };
            used.insert(text(row, "id").to_owned());
            resolved.push(json!({
                "fileId": row["id"],
                "name": row["name"],
                "size": row["sizeBytes"],
                "type": row["contentType"],
            }));
        }
        let stored = if is_signature {
            resolved.into_iter().next().unwrap_or(Value::Null)
        } else {
            Value::Array(resolved)
        };
        answers.insert(field.id.clone(), stored);
    }
    if !errors.is_empty() {
        return Err(forms_error_with(
            422,
            "VALIDATION_FAILED",
            "Some answers are missing or not valid.",
            json!({ "fields": errors }),
        ));
    }

    // 4a. The files move from the pending prefix to the form's own folder first.
    let store = ctx.svc.files.clone();
    let mut moves: Vec<(String, String, String)> = Vec::new();
    for row in &files {
        let id = text(row, "id");
        let key = text(row, "storageKey");
        if !used.contains(id) || !key.starts_with(PENDING_PREFIX) {
            continue;
        }
        let Some(store) = &store else {
            return Err(Fail::Internal("forms: no private bucket".to_owned()));
        };
        let to = final_key(ctx, &form_id, args.response_id, id, text(row, "name"));
        let Some(object) = store.private.get_boxed(key).await? else {
            let field = fields_of(&def)
                .into_iter()
                .find(|f| f.id == text(row, "blockId"))
                .map_or_else(|| text(row, "blockId").to_owned(), |f| f.id.clone());
            return Err(forms_error_with(
                422,
                "VALIDATION_FAILED",
                "An uploaded file is no longer available. Upload it again.",
                json!({ "fields": { field: { "code": "invalid" } } }),
            ));
        };
        store
            .private
            .put_boxed(
                &to,
                object.bytes,
                &PutOptions::content_type(text(row, "contentType")),
            )
            .await?;
        moves.push((id.to_owned(), key.to_owned(), to));
    }
    let unused: Vec<&Value> = files
        .iter()
        .filter(|f| !used.contains(text(f, "id")))
        .collect();

    // 4b. One transaction: an edit rewrites the response under its number; a
    // new one is claimed first and numbered last.
    let kept_number = if edited {
        existing.as_ref().and_then(|e| e["number"].as_i64())
    } else {
        None
    };
    // An invited CRM person: the response is theirs (the CRM Forms tab lists it by `personId`).
    let invited_person_id: Option<String> = match &identity.invitation_id {
        Some(invitation) => sqlx::query_scalar::<_, Option<String>>(
            "select person_id from form_invitations where id = $1 limit 1",
        )
        .bind(invitation)
        .fetch_optional(&ctx.db)
        .await?
        .flatten(),
        None => None,
    };
    let person_id = existing
        .as_ref()
        .and_then(|e| opt_text(e, "personId"))
        .or(invited_person_id);
    let started_at = match &existing {
        Some(e) => text(e, "startedAt").to_owned(),
        None => args
            .seed
            .as_ref()
            .map_or_else(|| now.clone(), |s| iso(s.started_at)),
    };
    let started_ms = crate::common::parse_ms(&started_at).unwrap_or(now_ms);
    let mut metadata = match &existing {
        Some(e) => crate::common::object(&e["metadata"]),
        None => args
            .seed
            .as_ref()
            .map(|s| s.metadata.clone())
            .unwrap_or_default(),
    };
    let timings = crate::respondent::add_timings(
        existing
            .as_ref()
            .map_or(&Value::Null, |e| &e["metadata"]["timings"]),
        args.timings,
    );
    if !timings.is_empty() {
        metadata.insert("timings".to_owned(), Value::Object(timings));
    }
    let invitation_id = identity
        .invitation_id
        .clone()
        .or_else(|| existing.as_ref().and_then(|e| opt_text(e, "invitationId")));
    let last_block_id = result
        .path
        .last()
        .cloned()
        .or_else(|| existing.as_ref().and_then(|e| opt_text(e, "lastBlockId")));
    let ip_hash = existing
        .as_ref()
        .and_then(|e| opt_text(e, "ipHash"))
        .or_else(|| args.seed.as_ref().and_then(|s| s.ip_hash.clone()));
    let variables = result.variables.to_json();
    let search = search_text(&def, &answers);
    let answered = i32::try_from(result.answers.len()).unwrap_or(i32::MAX);
    let duration = (now_ms - started_ms).max(0);

    let mut tx = ctx.db.begin().await?;
    let guard = if edited { "" } else { CLAIM_GUARD };
    let claimed: Option<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "{UPSERT_RESPONSE}{guard} returning id"
    )))
    .bind(args.response_id)
    .bind(&form_id)
    .bind(text(args.version, "id"))
    .bind(kept_number.map(|n| i32::try_from(n).unwrap_or(i32::MAX)))
    .bind(Json(Value::Object(answers.clone())))
    .bind(Json(Value::Object(hidden.clone())))
    .bind(Json(Value::Object(variables.clone())))
    .bind(&result.ending_id)
    .bind(result.score)
    .bind(&identity.email)
    .bind(&identity.user_id)
    .bind(&identity.hash)
    .bind(&invitation_id)
    .bind(&last_block_id)
    .bind(answered)
    .bind(&search)
    .bind(Json(Value::Object(metadata)))
    .bind(&ip_hash)
    .bind(&started_at)
    .bind(&now)
    .bind(i32::try_from(duration).unwrap_or(i32::MAX))
    .bind(&person_id)
    .fetch_optional(&mut *tx)
    .await?;
    if claimed.is_none() {
        tx.rollback().await?;
        return Ok(None);
    }
    for (id, _, to) in &moves {
        sqlx::query("update form_response_files set storage_key = $2 where id = $1")
            .bind(id)
            .bind(to)
            .execute(&mut *tx)
            .await?;
    }
    if !unused.is_empty() {
        let ids: Vec<String> = unused.iter().map(|f| text(f, "id").to_owned()).collect();
        sqlx::query("delete from form_response_files where id = any($1)")
            .bind(&ids)
            .execute(&mut *tx)
            .await?;
    }
    let number = if edited {
        kept_number.unwrap_or(0)
    } else {
        let counter: Option<i32> = sqlx::query_scalar(
            "update forms set response_counter = response_counter + 1, response_count = response_count + 1, \
             last_response_at = $2::timestamptz where id = $1 returning response_counter",
        )
        .bind(&form_id)
        .bind(&now)
        .fetch_optional(&mut *tx)
        .await?;
        let number = counter.map_or(1, i64::from);
        sqlx::query("update form_responses set number = $2 where id = $1")
            .bind(args.response_id)
            .bind(i32::try_from(number).unwrap_or(i32::MAX))
            .execute(&mut *tx)
            .await?;
        number
    };
    if let Some(invitation) = &identity.invitation_id {
        sqlx::query(
            "update form_invitations set status = 'completed', completed_at = $2::timestamptz, response_id = $3, \
             next_reminder_at = null, updated_at = $2::timestamptz where id = $1 and status <> 'revoked'",
        )
        .bind(invitation)
        .bind(&now)
        .bind(args.response_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    // Leftovers go after the commit; a failed delete only costs storage.
    let dead: Vec<String> = moves
        .iter()
        .map(|(_, from, _)| from.clone())
        .chain(unused.iter().map(|f| text(f, "storageKey").to_owned()))
        .collect();
    if !dead.is_empty()
        && let Some(store) = store.clone()
    {
        ctx.after(async move {
            if let Err(error) = store.private.delete_many_boxed(&dead).await {
                tracing::warn!(%error, "forms: deleting leftover uploads failed");
            }
        });
    }

    // 5. Side effects.
    let event = json!({
        "id": args.response_id,
        "formId": form_id,
        "formTitle": form["title"],
        "number": number,
        "respondentEmail": identity.email,
        "respondentUserId": identity.user_id,
        "personId": person_id,
        "invitationId": invitation_id,
        "endingId": result.ending_id,
        "score": crate::engine::js::number_value(result.score),
        "answers": answers_by_ref(&def, &answers),
        "hidden": hidden,
        "submittedAt": now,
    });
    let action = if edited {
        FORM_RESPONSE_UPDATED
    } else {
        FORM_RESPONSE_SUBMITTED
    };
    ctx.publish_as(args.actor, action, args.response_id, &event);
    if let (Some(invitation), false) = (&identity.invitation_id, edited) {
        let mut data = json!({ "id": invitation, "formId": form_id });
        if let (Some(email), Value::Object(fields)) = (&identity.email, &mut data) {
            fields.insert("email".to_owned(), Value::String(email.clone()));
        }
        ctx.publish_as(args.actor, FORM_INVITATION_COMPLETED, invitation, &data);
        // The reminder sweep re-derives this workspace's next reminder: this
        // person needs none now (`markWorkspaceDue`, the master due index).
        if let Some(master) = ctx.master.clone() {
            let workspace_id = ctx.workspace_id.clone();
            ctx.after(async move {
                weldsuite_db::due_index::mark_due(
                    &master,
                    "forms_reminders",
                    &workspace_id,
                    time::OffsetDateTime::now_utc(),
                )
                .await;
            });
        }
    }
    let params = ProcessResponseParams {
        clerk_org_id: ctx.clerk_org_id.clone(),
        workspace_id: ctx.workspace_id.clone(),
        form_id: form_id.clone(),
        response_id: args.response_id.to_owned(),
        mode: if edited { "update" } else { "submit" }.to_owned(),
        retry_integration_id: None,
    };
    if let Err(error) = start_processing(ctx, &params, now_ms).await {
        // The response is saved; its steps can be run again from the response.
        tracing::error!(
            error,
            response = args.response_id,
            "forms: could not start processing"
        );
    }
    // The form's own limit and the plan quota may have been crossed.
    if !edited {
        let refresh = ctx.clone();
        let id = form_id.clone();
        ctx.after(async move {
            match crate::access::form_row(&refresh.db, &id).await {
                Ok(Some(fresh)) => {
                    if let Err(Fail::Internal(error)) = refresh_public_cache(&refresh, &fresh).await
                    {
                        tracing::error!(error, "forms: could not refresh the public cache");
                    }
                }
                Ok(None) => {}
                Err(_) => tracing::error!("forms: could not reload the form to refresh its cache"),
            }
        });
    }

    let quiz = Value::Array(
        result
            .quiz
            .iter()
            .map(|item| {
                json!({
                    "fieldId": item.field_id,
                    "correct": item.correct,
                    "points": crate::engine::js::number_value(item.points),
                    "correctAnswer": correct_answer_of(&def, &item.field_id),
                })
            })
            .collect(),
    );
    let engine_variables = variables;
    Ok(Some(Submitted {
        result: build_result(
            &def,
            &result.ending_id,
            &engine_answers,
            &hidden,
            &engine_variables,
            args.response_id,
            number,
            result.score,
            &quiz,
        ),
    }))
}

/// `correctAnswerOf(def, fieldId)`: the right answer of a quiz question, for
/// the review on the ending: the labels of its correct choices, joined;
/// `None` when none is marked. The public definition leaves `correct` out.
fn correct_answer_of(def: &FormDefinition, field_id: &str) -> Option<String> {
    let field = fields_of(def).into_iter().find(|f| f.id == field_id)?;
    if !field.kind.is_choice() {
        return None;
    }
    let labels: Vec<&str> = field
        .choices()
        .iter()
        .filter(|choice| choice.correct == Some(true))
        .map(|choice| choice.label.as_str())
        .collect();
    (!labels.is_empty()).then(|| labels.join(", "))
}

/// A response row of a form by id (`existing`), for the routes.
#[allow(dead_code)]
pub(crate) async fn load_response(ctx: &Ctx, id: &str) -> FormsResult<Option<Value>> {
    one(
        &ctx.db,
        sqlx::query_scalar("select to_jsonb(r) from form_responses r where id = $1 limit 1")
            .bind(id),
    )
    .await
}
