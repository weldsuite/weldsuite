//! Members-only forms (`routes/fill/index.ts`), answered inside the platform
//! at `/api/forms/fill/:publicId`:
//!
//! ```text
//! GET  /:publicId   the form (the public payload, no bot check) and whether the member already responded
//! POST /:publicId/uploads   a file or signature for one field, bound to the member's
//!                   in-progress response (made by the first upload; the submit completes it)
//! POST /:publicId   submit: the public submit's validation, the response tied to the member,
//!                   or to a keyed hash when the form hides identities
//! ```
//!
//! No `forms:*` permission gates it: whoever is a member may answer a form
//! addressed to the workspace. The form's respondent mode is the gate: any
//! other form is a 404, and so is a public id of another workspace.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Request};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_kit::{Created, Data};

use super::Member;
use crate::FormsState;
use crate::common::{Ctx, FormsResult, answer, forms_error, not_found, one, text};
use crate::counters::Counters;
use crate::input;
use crate::members::member_ref;
use crate::public_cache::PublicCacheEntry;
use crate::public_form::{
    Link, closed_error, load_entry, load_version, resolve_link, state_of, to_public_form,
};
use crate::respondent::{UploadTarget, UploadedFile, upload_file};
use crate::sessions::keyed_hash;
use crate::submit::{Identity, Seed, SubmitArgs, submit_response};

pub(super) fn routes() -> Router<FormsState> {
    Router::new()
        .route("/fill/{publicId}", get(form).post(submit))
        .route(
            "/fill/{publicId}/uploads",
            post(uploads).layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
}

/// `membersForm(ctx, publicId)`: the form behind a public id, if it is a
/// members-only form of this workspace.
async fn members_form(ctx: &Ctx, public_id: &str) -> FormsResult<(Link, PublicCacheEntry)> {
    let link = resolve_link(ctx.master()?, public_id).await?;
    if link.workspace_id != ctx.workspace_id {
        return Err(not_found("Form"));
    }
    let (entry, _) = load_entry(&ctx.svc, &link, Some(ctx.clone()), || async {
        Err(not_found("Form"))
    })
    .await?;
    if entry.settings.respondent_mode != "members" {
        return Err(not_found("Form"));
    }
    Ok((link, entry))
}

/// `identityOf(ctx, entry, userId)`: the member's id, or a keyed hash when
/// the form hides identities.
async fn identity_of(ctx: &Ctx, entry: &PublicCacheEntry, user_id: &str) -> FormsResult<Identity> {
    if entry.settings.hide_member_identity {
        return Ok(Identity {
            hash: Some(keyed_hash(
                ctx.env(),
                &format!("member:{}", entry.form_id),
                user_id,
            )?),
            ..Identity::default()
        });
    }
    let profile = member_ref(&ctx.db, user_id).await?;
    Ok(Identity {
        email: profile["email"].as_str().map(str::to_lowercase),
        user_id: Some(user_id.to_owned()),
        ..Identity::default()
    })
}

/// The same-member condition of a responses query: `respondent_hash` or
/// `respondent_user_id`, and its value.
fn same_member(identity: &Identity) -> (&'static str, String) {
    match &identity.hash {
        Some(hash) => ("respondent_hash", hash.clone()),
        None => (
            "respondent_user_id",
            identity.user_id.clone().unwrap_or_default(),
        ),
    }
}

/// `memberInProgress(ctx, formId, identity)`: the member's unfinished response.
async fn member_in_progress(
    ctx: &Ctx,
    form_id: &str,
    identity: &Identity,
) -> FormsResult<Option<String>> {
    let (column, value) = same_member(identity);
    Ok(sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select id from form_responses where form_id = $1 and status = 'in_progress' and {column} = $2 \
         order by updated_at desc limit 1"
    )))
    .bind(form_id)
    .bind(value)
    .fetch_optional(&ctx.db)
    .await?)
}

async fn form(member: Member, Path(public_id): Path<String>) -> Response {
    answer(
        async {
            let ctx = &member.ctx;
            let (link, entry) = members_form(ctx, &public_id).await?;
            let mut already = false;
            if entry.settings.one_per_respondent {
                let who = identity_of(ctx, &entry, &member.user_id).await?;
                let (column, value) = same_member(&who);
                let found: Option<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                    "select id from form_responses where form_id = $1 and status = 'completed' and {column} = $2 limit 1"
                )))
                .bind(&link.form_id)
                .bind(value)
                .fetch_optional(&ctx.db)
                .await?;
                already = found.is_some();
            }
            let form = to_public_form(ctx.env(), &link, &entry, None, true, ctx.now_ms());
            Ok(Data(json!({ "form": form, "alreadyResponded": already })).into_response())
        }
        .await,
    )
}

/// `POST /:publicId/uploads`: a file or signature for one field, kept with
/// the member's unfinished response (made by the first upload).
async fn uploads(member: Member, Path(public_id): Path<String>, request: Request) -> Response {
    answer(
        async {
            let ctx = &member.ctx;
            let (link, entry) = members_form(ctx, &public_id).await?;
            let state = state_of(&link, &entry, ctx.now_ms());
            let Some(version_id) = entry.version_id.clone().filter(|_| state == "open") else {
                return Err(closed_error(if state == "open" { "closed" } else { state }));
            };
            let Some(fields) = super::multipart_fields(request).await else {
                return Err(forms_error(
                    400,
                    "BAD_REQUEST",
                    "Send the file as multipart form data.",
                ));
            };
            let block_id = fields
                .iter()
                .find(|(name, ..)| name == "blockId")
                .filter(|(_, file_name, ..)| file_name.is_none())
                .map(|(_, _, _, bytes)| String::from_utf8_lossy(bytes).into_owned());
            let file = fields
                .into_iter()
                .find(|(name, ..)| name == "file")
                .filter(|(_, file_name, ..)| file_name.is_some());
            let (Some(block_id), Some((_, file_name, content_type, bytes))) = (block_id, file)
            else {
                return Err(forms_error(
                    400,
                    "BAD_REQUEST",
                    "Send \"blockId\" and \"file\".",
                ));
            };
            let identity = identity_of(ctx, &entry, &member.user_id).await?;
            let response_id = if let Some(id) =
                member_in_progress(ctx, &link.form_id, &identity).await?
            {
                id
            } else {
                let id = weldsuite_kit::generate_id("frs");
                sqlx::query(
                    "insert into form_responses (id, form_id, version_id, status, respondent_email, \
                     respondent_user_id, respondent_hash, metadata) \
                     values ($1, $2, $3, 'in_progress', $4, $5, $6, $7)",
                )
                .bind(&id)
                .bind(&link.form_id)
                .bind(&version_id)
                .bind(&identity.email)
                .bind(&identity.user_id)
                .bind(&identity.hash)
                .bind(json!({ "source": "members" }))
                .execute(&ctx.db)
                .await?;
                id
            };
            let counters = Counters::new(Arc::clone(&ctx.svc.cache), &link.form_id, ctx.now_ms());
            let target = UploadTarget {
                response: &response_id,
                form: &link.form_id,
                version: &version_id,
                email: None,
                invitation: None,
            };
            let uploaded = upload_file(
                ctx,
                &target,
                &counters,
                &block_id,
                UploadedFile {
                    name: file_name.unwrap_or_default(),
                    content_type,
                    bytes,
                },
            )
            .await?;
            Ok(Created(json!({ "file": uploaded })).into_response())
        }
        .await,
    )
}

async fn submit(
    member: Member,
    Path(public_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = input::json(&headers, &body, input::member_submit)?;
            let ctx = &member.ctx;
            let (link, entry) = members_form(ctx, &public_id).await?;
            let state = state_of(&link, &entry, ctx.now_ms());
            let Some(version_id) = entry.version_id.clone().filter(|_| state == "open") else {
                return Err(closed_error(if state == "open" { "closed" } else { state }));
            };
            let form = one(
                &ctx.db,
                sqlx::query_scalar("select to_jsonb(f) from forms f where id = $1 limit 1")
                    .bind(&link.form_id),
            )
            .await?
            .ok_or_else(|| forms_error(404, "NOT_FOUND", "Form not found"))?;
            let identity = identity_of(ctx, &entry, &member.user_id).await?;
            let version = load_version(ctx, text(&form, "id"), &version_id).await?;
            let response_id = match member_in_progress(ctx, &link.form_id, &identity).await? {
                Some(id) => id,
                None => weldsuite_kit::generate_id("frs"),
            };
            let mut metadata = Map::new();
            metadata.insert("source".to_owned(), Value::String("members".to_owned()));
            // A form that hides identities must not name the member in the audit trail either.
            let actor = if entry.settings.hide_member_identity {
                "respondent".to_owned()
            } else {
                member.user_id.clone()
            };
            let outcome = submit_response(
                ctx,
                SubmitArgs {
                    form: &form,
                    version: &version,
                    response_id: &response_id,
                    answers: &input.answers,
                    hidden: &input.hidden.unwrap_or_default(),
                    timings: input.timings.as_ref(),
                    identity,
                    seed: Some(Seed {
                        metadata,
                        ip_hash: None,
                        started_at: ctx.now_ms(),
                    }),
                    actor: &actor,
                },
            )
            .await?;
            Ok(Created(outcome.result).into_response())
        }
        .await,
    )
}
