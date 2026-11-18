//! The respondent's side (`services/respondent.ts`): start a session (bot
//! check, invitation, verified email, resume, one per respondent), save
//! progress, upload a file or a signature. Nothing is written to the tenant
//! database until there is something to keep.

use serde_json::{Map, Value, json};
use sqlx::types::Json;
use weldsuite_ports::PutOptions;

use crate::bot_check;
use crate::common::{
    Ctx, Fail, FormsResult, forms_error, forms_error_with, iso, js_slice, not_found, one, opt_text,
    text,
};
use crate::counters::{Counters, rate_limited};
use crate::crypto::sha256_hex;
use crate::engine::definition::FileAccept;
use crate::engine::{FieldKind, collect_answers, fields_of};
use crate::input::{SaveProgress, StartSession};
use crate::public_cache::PublicCacheEntry;
use crate::public_form::{Link, closed_error, definition_of, load_version, state_of};
use crate::sessions::{
    RespondentSession, SessionSeed, issue_session, keyed_hash, read_seed, read_session,
    read_verification, save_seed,
};
use crate::submit::pending_key;

/// Sessions one IP may start per form per minute.
pub(crate) const SESSIONS_PER_IP_PER_MINUTE: i64 = 10;
pub(crate) const UPLOADS_PER_SESSION_PER_MINUTE: i64 = 30;

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

struct Invitation {
    id: String,
    email: String,
    status: String,
}

fn revoked() -> Fail {
    forms_error(
        410,
        "INVITATION_REVOKED",
        "This invitation link is no longer valid.",
    )
}

/// `resolveInvitation(ctx, link, token)`: 410 when revoked, 404 when unknown.
async fn resolve_invitation(ctx: &Ctx, link: &Link, token: &str) -> FormsResult<Invitation> {
    let entry = one(
        ctx.master()?,
        sqlx::query_scalar(
            "select to_jsonb(r) from form_invitation_registry r where token_hash = $1 limit 1",
        )
        .bind(sha256_hex(token.as_bytes())),
    )
    .await?;
    let Some(entry) = entry.filter(|e| {
        text(e, "workspaceId") == link.workspace_id && text(e, "formId") == link.form_id
    }) else {
        return Err(not_found("Invitation"));
    };
    if !entry["revokedAt"].is_null() {
        return Err(revoked());
    }
    let row = one(
        &ctx.db,
        sqlx::query_scalar("select to_jsonb(i) from form_invitations i where id = $1 limit 1")
            .bind(text(&entry, "invitationId")),
    )
    .await?
    .ok_or_else(|| not_found("Invitation"))?;
    if text(&row, "status") == "revoked" || !row["revokedAt"].is_null() {
        return Err(revoked());
    }
    Ok(Invitation {
        id: text(&row, "id").to_owned(),
        email: text(&row, "email").to_owned(),
        status: text(&row, "status").to_owned(),
    })
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/// What `startSession` reads besides the input.
pub(crate) struct StartArgs<'a> {
    pub(crate) svc: &'a crate::common::Svc,
    pub(crate) link: &'a Link,
    pub(crate) entry: &'a PublicCacheEntry,
    pub(crate) counters: &'a Counters,
    pub(crate) input: &'a StartSession,
    pub(crate) ip: Option<&'a str>,
    pub(crate) country: Option<&'a str>,
    pub(crate) now_ms: i64,
}

async fn latest_response(
    ctx: &Ctx,
    sql: &'static str,
    form_id: &str,
    value: &str,
) -> FormsResult<Option<Value>> {
    one(&ctx.db, sqlx::query_scalar(sql).bind(form_id).bind(value)).await
}

/// `startSession(args)`: the `StartSessionResult`.
#[allow(clippy::too_many_lines)] // one step per rule, in the worker's order
pub(crate) async fn start_session<F, Fut>(args: StartArgs<'_>, open: F) -> FormsResult<Value>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = FormsResult<Ctx>>,
{
    let StartArgs {
        svc,
        link,
        entry,
        counters,
        input,
        now_ms,
        ..
    } = args;
    let env = &svc.env;
    let settings = &entry.settings;
    let state = state_of(link, entry, now_ms);
    if settings.respondent_mode == "members" {
        return Err(forms_error(
            403,
            "MEMBERS_ONLY",
            "This form is answered inside WeldSuite by workspace members.",
        ));
    }
    if state != "open" {
        return Err(closed_error(state));
    }

    let resumed = read_session(env, input.resume.as_deref(), now_ms)?;
    let resume = resumed.filter(|s| s.form == link.form_id && s.public_id == link.public_id);
    let ip_hash = match args.ip {
        Some(ip) => Some(keyed_hash(env, "ip", ip)?),
        None => None,
    };
    rate_limited(
        counters,
        &format!("sess:{}", ip_hash.as_deref().unwrap_or("unknown")),
        SESSIONS_PER_IP_PER_MINUTE,
    )
    .await?;

    let verified_email =
        read_verification(env, input.verification.as_deref(), &link.form_id, now_ms)?;
    let ctx = open().await?;
    let invitation = match input.invitation_token.as_deref().filter(|t| !t.is_empty()) {
        Some(token) => Some(resolve_invitation(&ctx, link, token).await?),
        None => None,
    };

    // A personal link, a verified email and an earlier session each prove more than a bot check.
    if resume.is_none()
        && invitation.is_none()
        && verified_email.is_none()
        && !bot_check::passes(svc, input.bot_token.as_deref(), args.ip, now_ms).await?
    {
        return Err(forms_error(
            403,
            "BOT_CHECK_FAILED",
            "The bot check failed. Reload the page and try again.",
        ));
    }

    let email = invitation
        .as_ref()
        .map(|i| i.email.clone())
        .or_else(|| resume.as_ref().and_then(|r| r.email.clone()))
        .or_else(|| verified_email.clone());
    if settings.respondent_mode == "verified_email" && email.is_none() && invitation.is_none() {
        return Err(forms_error(
            401,
            "VERIFICATION_REQUIRED",
            "Verify your email address to open this form.",
        ));
    }
    let email = email.map(|e| weldsuite_kit::validation::js_trim(&e).to_lowercase());
    let browser_hash = match input.browser_key.as_deref().filter(|k| !k.is_empty()) {
        Some(key) => Some(keyed_hash(env, &format!("browser:{}", link.form_id), key)?),
        None => None,
    };

    // The respondent's earlier response, if they have one.
    let mut existing: Option<Value> = None;
    if let Some(resume) = &resume {
        existing = latest_response(
            &ctx,
            "select to_jsonb(r) from form_responses r where form_id = $1 and id = $2 limit 1",
            &link.form_id,
            &resume.resp,
        )
        .await?;
    }
    if existing.is_none()
        && let Some(invitation) = &invitation
    {
        existing = latest_response(
            &ctx,
            "select to_jsonb(r) from form_responses r where form_id = $1 and invitation_id = $2 \
             order by updated_at desc limit 1",
            &link.form_id,
            &invitation.id,
        )
        .await?;
    }
    if existing.is_none() && settings.one_per_respondent {
        if let Some(email) = &email {
            existing = latest_response(
                &ctx,
                "select to_jsonb(r) from form_responses r where form_id = $1 and respondent_email = $2 \
                 order by updated_at desc limit 1",
                &link.form_id,
                email,
            )
            .await?;
        } else if let Some(hash) = &browser_hash {
            existing = latest_response(
                &ctx,
                "select to_jsonb(r) from form_responses r where form_id = $1 and respondent_hash = $2 \
                 order by updated_at desc limit 1",
                &link.form_id,
                hash,
            )
            .await?;
        }
    }

    let allowed: Vec<String> = entry
        .definition
        .as_ref()
        .and_then(|def| def["hidden"].as_array())
        .map(|hidden| {
            hidden
                .iter()
                .filter_map(|h| h["name"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let hidden: Map<String, Value> = input
        .hidden
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|(name, _)| allowed.contains(name))
        .collect();

    let response_id = existing
        .as_ref()
        .map(|e| text(e, "id").to_owned())
        .or_else(|| resume.as_ref().map(|r| r.resp.clone()))
        .unwrap_or_else(|| weldsuite_kit::generate_id("frs"));
    let Some(version_id) = existing
        .as_ref()
        .map(|e| text(e, "versionId").to_owned())
        .or_else(|| resume.as_ref().map(|r| r.ver.clone()))
        .or_else(|| entry.version_id.clone())
    else {
        return Err(closed_error("closed"));
    };

    let resumed_seed = if resume.is_some() {
        read_seed(svc, &response_id).await?.is_some()
    } else {
        false
    };
    if existing.is_none() && !resumed_seed {
        let mut metadata = input.metadata.clone().unwrap_or_default();
        if let Some(country) = args.country {
            metadata.insert("country".to_owned(), Value::String(country.to_owned()));
        }
        let seed = SessionSeed {
            hidden: hidden.clone(),
            metadata,
            ip_hash,
            browser_hash,
            started_at: now_ms,
        };
        save_seed(svc, &response_id, &seed).await?;
    }
    if let Some(invitation) = invitation.as_ref().filter(|i| i.status == "sent") {
        let now = iso(now_ms);
        sqlx::query(
            "update form_invitations set status = 'opened', opened_at = $2::timestamptz, \
             updated_at = $2::timestamptz where id = $1 and status = 'sent'",
        )
        .bind(&invitation.id)
        .bind(&now)
        .execute(&ctx.db)
        .await?;
    }

    let session = RespondentSession {
        org: link.clerk_org_id.clone(),
        ws: link.workspace_id.clone(),
        form: link.form_id.clone(),
        public_id: link.public_id.clone(),
        ver: version_id.clone(),
        resp: response_id.clone(),
        mode: settings.respondent_mode.clone(),
        email: email.clone(),
        inv: invitation.as_ref().map(|i| i.id.clone()),
        exp: 0,
    };
    let (token, expires_at) = issue_session(env, session, now_ms)?;

    let completed = existing
        .as_ref()
        .filter(|e| text(e, "status") == "completed")
        .map(|_| settings.allow_edit && (email.is_some() || invitation.is_some()));
    let answers = match &existing {
        Some(e) => {
            let keep = if text(e, "status") == "in_progress" {
                settings.collect_partial
            } else {
                completed == Some(true)
            };
            if keep {
                e["answers"].clone()
            } else {
                json!({})
            }
        }
        None => json!({}),
    };
    Ok(json!({
        "session": token,
        "responseId": response_id,
        "versionId": version_id,
        "expiresAt": iso(expires_at),
        "answers": answers,
        "hidden": existing.as_ref().map_or_else(|| Value::Object(hidden.clone()), |e| e["hidden"].clone()),
        "lastBlockId": existing.as_ref().map_or(Value::Null, |e| e["lastBlockId"].clone()),
        "respondentEmail": email,
        "completed": completed.map(|editable| json!({ "editable": editable })),
    }))
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/// Timings added up per block.
pub(crate) fn add_timings(base: &Value, more: Option<&Map<String, Value>>) -> Map<String, Value> {
    let mut timings = base.as_object().cloned().unwrap_or_default();
    for (block, ms) in more.into_iter().flatten() {
        let total =
            timings.get(block).and_then(Value::as_f64).unwrap_or(0.0) + ms.as_f64().unwrap_or(0.0);
        timings.insert(block.clone(), crate::engine::js::number_value(total));
    }
    timings
}

/// `saveProgress(args)`: how far the respondent got, and their answers when
/// the form collects partial responses. Creates the row on the first call;
/// a completed response is left alone.
pub(crate) async fn save_progress(
    ctx: &Ctx,
    session: &RespondentSession,
    entry: &PublicCacheEntry,
    input: &SaveProgress,
) -> FormsResult<()> {
    let now = iso(ctx.now_ms());
    let existing = one(
        &ctx.db,
        sqlx::query_scalar("select to_jsonb(r) from form_responses r where id = $1 limit 1")
            .bind(&session.resp),
    )
    .await?;
    if existing
        .as_ref()
        .is_some_and(|e| text(e, "status") == "completed")
    {
        return Ok(());
    }
    let version = load_version(ctx, &session.form, &session.ver).await?;
    let def = definition_of(&version)?;
    // Only valid answers are kept, and only for the fields of this version.
    let valid: Option<Map<String, Value>> = if entry.settings.collect_partial {
        input.answers.as_ref().map(|answers| {
            collect_answers(&def, Some(answers))
                .valid
                .iter()
                .map(|(id, answer)| (id.clone(), answer.to_json()))
                .collect()
        })
    } else {
        None
    };
    let timings = add_timings(
        existing
            .as_ref()
            .map_or(&Value::Null, |e| &e["metadata"]["timings"]),
        input.timings.as_ref(),
    );
    let timings_patch = if timings.is_empty() {
        json!({})
    } else {
        json!({ "timings": timings })
    };

    if existing.is_none() {
        let seed = read_seed(&ctx.svc, &session.resp).await?;
        let mut metadata = seed
            .as_ref()
            .map(|s| s.metadata.clone())
            .unwrap_or_default();
        if !timings.is_empty() {
            metadata.insert("timings".to_owned(), Value::Object(timings.clone()));
        }
        let started_at = seed
            .as_ref()
            .map_or_else(|| now.clone(), |s| iso(s.started_at));
        let answered = valid.as_ref().map_or(0, Map::len);
        let inserted: Option<String> = sqlx::query_scalar(
            "insert into form_responses (id, form_id, version_id, status, answers, hidden, respondent_email, \
             respondent_hash, invitation_id, last_block_id, answered_count, metadata, ip_hash, started_at, updated_at) \
             values ($1, $2, $3, 'in_progress', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14::timestamptz) \
             on conflict (id) do nothing returning id",
        )
        .bind(&session.resp)
        .bind(&session.form)
        .bind(&session.ver)
        .bind(Json(Value::Object(valid.clone().unwrap_or_default())))
        .bind(Json(Value::Object(seed.as_ref().map(|s| s.hidden.clone()).unwrap_or_default())))
        .bind(&session.email)
        .bind(seed.as_ref().and_then(|s| s.browser_hash.clone()))
        .bind(&session.inv)
        .bind(&input.last_block_id)
        .bind(i32::try_from(answered).unwrap_or(i32::MAX))
        .bind(Json(Value::Object(metadata)))
        .bind(seed.as_ref().and_then(|s| s.ip_hash.clone()))
        .bind(&started_at)
        .bind(&now)
        .fetch_optional(&ctx.db)
        .await?;
        if inserted.is_some() {
            mark_invitation_started(ctx, session, &now).await?;
            return Ok(());
        }
    }
    let mut q =
        sqlx::QueryBuilder::<sqlx::Postgres>::new("update form_responses set last_block_id = ");
    q.push_bind(input.last_block_id.clone());
    if let Some(valid) = &valid {
        q.push(", answers = ")
            .push_bind(Json(Value::Object(valid.clone())))
            .push(", answered_count = ")
            .push_bind(i32::try_from(valid.len()).unwrap_or(i32::MAX));
    }
    // A save still in flight when the submit commits must not overwrite the
    // completed answers.
    q.push(", metadata = metadata || ")
        .push_bind(Json(timings_patch))
        .push(", updated_at = ")
        .push_bind(now.clone())
        .push("::timestamptz where id = ")
        .push_bind(session.resp.clone())
        .push(" and status = 'in_progress'");
    q.build().execute(&ctx.db).await?;
    mark_invitation_started(ctx, session, &now).await
}

async fn mark_invitation_started(
    ctx: &Ctx,
    session: &RespondentSession,
    now: &str,
) -> FormsResult<()> {
    let Some(invitation) = &session.inv else {
        return Ok(());
    };
    sqlx::query(
        "update form_invitations set status = 'started', started_at = $2::timestamptz, response_id = $3, \
         updated_at = $2::timestamptz where id = $1 and status in ('sent', 'opened')",
    )
    .bind(invitation)
    .bind(now)
    .bind(&session.resp)
    .execute(&ctx.db)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

const DOCUMENT_TYPES: &[&str] = &[
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/rtf",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "text/plain",
    "text/csv",
];

const MB: f64 = 1024.0 * 1024.0;
const SIGNATURE_MAX_BYTES: f64 = 2.0 * MB;

fn accepted(accept: FileAccept, content_type: &str) -> bool {
    match accept {
        FileAccept::Any => true,
        FileAccept::Images => content_type.starts_with("image/") && content_type != "image/svg+xml",
        FileAccept::Documents => DOCUMENT_TYPES.contains(&content_type),
        FileAccept::Pdf => content_type == "application/pdf",
    }
}

/// A file the request carried (`File`).
pub(crate) struct UploadedFile {
    pub(crate) name: String,
    pub(crate) content_type: String,
    pub(crate) bytes: Vec<u8>,
}

/// What an upload is bound to: the response, its form and version, and who
/// the respondent is (a verified email or an invitation may edit a completed
/// response when the form allows it).
pub(crate) struct UploadTarget<'a> {
    pub(crate) response: &'a str,
    pub(crate) form: &'a str,
    pub(crate) version: &'a str,
    pub(crate) email: Option<&'a str>,
    pub(crate) invitation: Option<&'a str>,
}

/// `assertTakesUploads(ctx, session)`: 409 `ALREADY_SUBMITTED` once the
/// response is completed, unless the respondent may edit it, as the submit
/// decides.
async fn assert_takes_uploads(ctx: &Ctx, target: &UploadTarget<'_>) -> FormsResult<()> {
    let response: Option<(String, Option<String>)> =
        sqlx::query_as("select status, invitation_id from form_responses where id = $1 limit 1")
            .bind(target.response)
            .fetch_optional(&ctx.db)
            .await?;
    let Some((status, invitation_id)) = response else {
        return Ok(());
    };
    if status != "completed" {
        return Ok(());
    }
    let form = crate::access::form_row(&ctx.db, target.form).await?;
    let identified = target.email.is_some_and(|e| !e.is_empty())
        || target.invitation.is_some_and(|i| !i.is_empty())
        || invitation_id.is_some_and(|i| !i.is_empty());
    let editable =
        form.is_some_and(|form| crate::model::FormSettings::parse(&form["settings"]).allow_edit);
    if editable && identified {
        return Ok(());
    }
    Err(forms_error(
        409,
        "ALREADY_SUBMITTED",
        "This form was already submitted.",
    ))
}

/// `name.replace(/[\u0000-\u001f/\\]+/g, '_').slice(0, 255)`.
fn safe_upload_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut in_run = false;
    for c in name.chars() {
        if c <= '\u{1f}' || c == '/' || c == '\\' {
            if !in_run {
                out.push('_');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    js_slice(&out, 255)
}

/// `uploadFile(args)`: a file or a drawn signature for one field of the
/// version the session runs on, under `weldforms/pending/<responseId>/<fileId>`.
#[allow(clippy::too_many_lines, reason = "the worker's checks, in its order")]
pub(crate) async fn upload_file(
    ctx: &Ctx,
    target: &UploadTarget<'_>,
    counters: &Counters,
    block_id: &str,
    file: UploadedFile,
) -> FormsResult<Value> {
    rate_limited(
        counters,
        &format!("up:{}", target.response),
        UPLOADS_PER_SESSION_PER_MINUTE,
    )
    .await?;
    assert_takes_uploads(ctx, target).await?;
    let version = load_version(ctx, target.form, target.version).await?;
    let def = definition_of(&version)?;
    let Some(field) = fields_of(&def)
        .into_iter()
        .find(|f| f.id == block_id && f.kind.is_file())
    else {
        return Err(forms_error(
            400,
            "BAD_REQUEST",
            "This field does not take files.",
        ));
    };
    let (is_signature, max_size_mb, accept, max_files) = match &field.kind {
        FieldKind::FileUpload(props) => (
            false,
            props.max_size_mb.min(25.0),
            props.accept,
            props.max_files,
        ),
        _ => (true, 25.0, FileAccept::Any, 1.0),
    };
    let max_bytes = if is_signature {
        SIGNATURE_MAX_BYTES
    } else {
        max_size_mb * MB
    };
    #[allow(clippy::cast_precision_loss)]
    let size = file.bytes.len() as f64;
    if file.bytes.is_empty() {
        return Err(forms_error(400, "BAD_REQUEST", "The file is empty."));
    }
    if size > max_bytes {
        return Err(forms_error_with(
            413,
            "FILE_TOO_LARGE",
            format!(
                "Files can be at most {} MB.",
                crate::engine::js::number_text((max_bytes / MB).round())
            ),
            json!({ "maxBytes": crate::engine::js::number_value(max_bytes) }),
        ));
    }
    let content_type = if file.content_type.is_empty() {
        "application/octet-stream".to_owned()
    } else {
        file.content_type.clone()
    };
    let allowed = if is_signature {
        content_type == "image/png"
    } else {
        accepted(accept, &content_type)
    };
    if !allowed {
        return Err(forms_error(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "This type of file is not accepted here.",
        ));
    }

    let files = ctx
        .svc
        .files
        .clone()
        .ok_or_else(|| Fail::Internal("forms: no private bucket".to_owned()))?;
    // Only the files staged since the last submit count (`makeRoom`): an
    // edit's new files sit next to the submitted ones, which the submit drops
    // once the answers no longer name them.
    let existing: Vec<(String, String)> = sqlx::query_as::<_, (String, String)>(
        "select id, storage_key from form_response_files where response_id = $1 and block_id = $2",
    )
    .bind(target.response)
    .bind(&field.id)
    .fetch_all(&ctx.db)
    .await?
    .into_iter()
    .filter(|(_, key)| key.starts_with(crate::submit::PENDING_PREFIX))
    .collect();
    if is_signature {
        if !existing.is_empty() {
            let ids: Vec<String> = existing.iter().map(|(id, _)| id.clone()).collect();
            sqlx::query("delete from form_response_files where id = any($1)")
                .bind(&ids)
                .execute(&ctx.db)
                .await?;
            let keys: Vec<String> = existing.iter().map(|(_, key)| key.clone()).collect();
            files.private.delete_many_boxed(&keys).await?;
        }
    } else {
        #[allow(clippy::cast_precision_loss)]
        let count = existing.len() as f64;
        if count >= max_files {
            let max_text = crate::engine::js::number_text(max_files);
            return Err(forms_error_with(
                422,
                "TOO_MANY_FILES",
                format!(
                    "At most {max_text} file{} can be added here.",
                    if (max_files - 1.0).abs() < f64::EPSILON {
                        ""
                    } else {
                        "s"
                    }
                ),
                json!({ "max": crate::engine::js::number_value(max_files) }),
            ));
        }
    }

    let id = weldsuite_kit::generate_id("ffl");
    let fallback = if is_signature {
        "signature.png"
    } else {
        "file"
    };
    let name = safe_upload_name(if file.name.is_empty() {
        fallback
    } else {
        &file.name
    });
    let storage_key = pending_key(target.response, &id);
    let size_bytes = file.bytes.len();
    files
        .private
        .put_boxed(
            &storage_key,
            file.bytes,
            &PutOptions::content_type(content_type.clone()),
        )
        .await?;
    sqlx::query(
        "insert into form_response_files (id, response_id, form_id, block_id, kind, storage_key, name, content_type, size_bytes) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(&id)
    .bind(target.response)
    .bind(target.form)
    .bind(&field.id)
    .bind(if is_signature { "signature" } else { "upload" })
    .bind(&storage_key)
    .bind(&name)
    .bind(&content_type)
    .bind(i32::try_from(size_bytes).unwrap_or(i32::MAX))
    .execute(&ctx.db)
    .await?;
    Ok(json!({ "fileId": id, "name": name, "size": size_bytes, "type": content_type }))
}

/// The `form_responses` row of a response, if there is one.
pub(crate) async fn response_row(ctx: &Ctx, id: &str) -> FormsResult<Option<Value>> {
    one(
        &ctx.db,
        sqlx::query_scalar("select to_jsonb(r) from form_responses r where id = $1 limit 1")
            .bind(id),
    )
    .await
}

/// `opt_text` re-exported for the routes.
#[allow(dead_code)]
pub(crate) fn optional(row: &Value, key: &str) -> Option<String> {
    opt_text(row, key)
}
