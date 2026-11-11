//! The respondent's view of a form (`services/public-form.ts`): its link in
//! the master registry, its workspace, whether it is open, and the
//! `PublicForm` payload, from the public cache; the tenant database is
//! opened only to rebuild an entry that is missing.

use serde_json::{Value, json};
use sqlx::PgPool;

use crate::common::{
    Ctx, Env, Fail, FormsResult, forms_error_with, month_of, not_found, one, parse_ms, text,
    workspace_app_url,
};
use crate::engine::FormDefinition;
use crate::model::parsed_definition;
use crate::public_cache::{
    PublicCacheEntry, build_public_entry, read_public_cache, write_public_cache,
};

/// A `form_link_registry` row.
#[derive(Debug, Clone)]
pub(crate) struct Link {
    pub(crate) public_id: String,
    pub(crate) workspace_id: String,
    pub(crate) clerk_org_id: String,
    pub(crate) form_id: String,
    pub(crate) suspended: bool,
    pub(crate) held: bool,
}

/// `resolveLink(master, publicId)`: 404 when unknown.
pub(crate) async fn resolve_link(master: &PgPool, public_id: &str) -> FormsResult<Link> {
    let row = one(
        master,
        sqlx::query_scalar(
            "select to_jsonb(l) from form_link_registry l where public_id = $1 limit 1",
        )
        .bind(public_id),
    )
    .await?
    .ok_or_else(|| not_found("Form"))?;
    Ok(Link {
        public_id: text(&row, "publicId").to_owned(),
        workspace_id: text(&row, "workspaceId").to_owned(),
        clerk_org_id: text(&row, "clerkOrgId").to_owned(),
        form_id: text(&row, "formId").to_owned(),
        suspended: !row["suspendedAt"].is_null(),
        held: !row["heldAt"].is_null(),
    })
}

/// `loadEntry(env, link, workspace)`: the cached payload; on a miss it is
/// rebuilt from the tenant rows (`open` opens the link's workspace) and
/// cached again. Returns the workspace when it was opened.
pub(crate) async fn load_entry<F, Fut>(
    svc: &crate::common::Svc,
    link: &Link,
    workspace: Option<Ctx>,
    open: F,
) -> FormsResult<(PublicCacheEntry, Option<Ctx>)>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = FormsResult<Ctx>>,
{
    if let Some(cached) = read_public_cache(svc, &link.public_id).await?
        && cached.form_id == link.form_id
    {
        return Ok((cached, workspace));
    }
    let ctx = match workspace {
        Some(ctx) => ctx,
        None => open().await?,
    };
    let form = one(
        &ctx.db,
        sqlx::query_scalar(
            "select to_jsonb(f) from forms f where id = $1 and public_id = $2 limit 1",
        )
        .bind(&link.form_id)
        .bind(&link.public_id),
    )
    .await?
    .ok_or_else(|| not_found("Form"))?;
    let entry = build_public_entry(&ctx, &form, ctx.now_ms()).await?;
    write_public_cache(svc, &link.public_id, &entry).await?;
    Ok((entry, Some(ctx)))
}

/// `stateOf(link, entry, now)`: staff actions first, then the form's own
/// settings.
pub(crate) fn state_of(link: &Link, entry: &PublicCacheEntry, now_ms: i64) -> &'static str {
    if link.suspended {
        return "suspended";
    }
    if link.held {
        return "held";
    }
    if entry.status != "published" || entry.definition.is_none() {
        return "closed";
    }
    let settings = &entry.settings;
    if settings
        .opens_at
        .as_deref()
        .and_then(parse_ms)
        .is_some_and(|opens| opens > now_ms)
    {
        return "not_open_yet";
    }
    if settings
        .closes_at
        .as_deref()
        .and_then(parse_ms)
        .is_some_and(|closes| closes <= now_ms)
    {
        return "past_close_date";
    }
    if entry.limit_reached {
        return "limit_reached";
    }
    if entry.over_quota_month.as_deref() == Some(month_of(now_ms).as_str()) {
        return "over_quota";
    }
    "open"
}

/// `closedError(state)`: the refusal for a form not taking responses.
pub(crate) fn closed_error(state: &str) -> Fail {
    if state == "suspended" || state == "held" {
        return forms_error_with(
            403,
            "FORM_UNAVAILABLE",
            "This form is no longer available.",
            json!({ "state": state }),
        );
    }
    forms_error_with(
        403,
        "FORM_CLOSED",
        "This form is not accepting responses right now.",
        json!({ "state": state }),
    )
}

/// The `correct` mark taken off a block's choices (a group's questions too).
fn strip_answer_key(block: &mut Value) {
    if let Some(children) = block.get_mut("children").and_then(Value::as_array_mut) {
        children.iter_mut().for_each(strip_answer_key);
    }
    let is_choice = matches!(
        block["type"].as_str(),
        Some("multiple_choice" | "dropdown" | "picture_choice")
    );
    if !is_choice {
        return;
    }
    if let Some(choices) = block
        .pointer_mut("/properties/choices")
        .and_then(Value::as_array_mut)
    {
        for choice in choices.iter_mut().filter_map(Value::as_object_mut) {
            choice.remove("correct");
        }
    }
}

/// `withoutAnswerKey(def)`: the definition a respondent's browser gets,
/// without the quiz's answer key (`correct` on a choice), which the submit's
/// result names per question instead. A choice's `score` stays: logic and
/// `{score}` recall run in the browser.
pub(crate) fn without_answer_key(mut definition: Value) -> Value {
    if let Some(blocks) = definition.get_mut("blocks").and_then(Value::as_array_mut) {
        blocks.iter_mut().for_each(strip_answer_key);
    }
    definition
}

/// `toPublicForm(env, link, entry, options)`: the definition only while the
/// form is open, and without the answer key.
pub(crate) fn to_public_form(
    env: &Env,
    link: &Link,
    entry: &PublicCacheEntry,
    version: Option<(&str, &Value)>,
    in_platform: bool,
    now_ms: i64,
) -> Value {
    let state = state_of(link, entry, now_ms);
    let live = state == "open";
    let provider = if in_platform {
        "none"
    } else {
        crate::bot_check::provider(env)
    };
    let definition = match version {
        Some((_, definition)) => Some(parsed_definition(definition)),
        None => entry.definition.clone(),
    };
    let settings = &entry.settings;
    let members_url = (settings.respondent_mode == "members" && !in_platform).then(|| {
        workspace_app_url(
            &env.non_empty("PLATFORM_URL")
                .unwrap_or_else(|| "https://app.weldsuite.org".to_owned()),
            &link.clerk_org_id,
            &format!("/weldforms/fill/{}", link.public_id),
        )
    });
    json!({
        "publicId": link.public_id,
        "title": entry.title,
        "state": state,
        "closedMessage": settings.closed_message,
        "versionId": version.map_or_else(|| entry.version_id.clone(), |(id, _)| Some(id.to_owned())),
        "definition": if live { definition.map(without_answer_key) } else { None },
        "theme": entry.theme,
        "respondentMode": settings.respondent_mode,
        "onePerRespondent": settings.one_per_respondent,
        "allowEdit": settings.allow_edit,
        "collectPartial": settings.collect_partial,
        "allowedEmbedDomains": settings.allowed_embed_domains,
        "botCheck": {
            "provider": provider,
            "siteKey": if provider == "turnstile" { env.non_empty("TURNSTILE_SITE_KEY") } else { None },
        },
        "branding": entry.branding,
        "membersUrl": members_url,
    })
}

/// `loadVersion(ctx, formId, versionId)`: a version row of a form, or 404.
pub(crate) async fn load_version(ctx: &Ctx, form_id: &str, version_id: &str) -> FormsResult<Value> {
    one(
        &ctx.db,
        sqlx::query_scalar(
            "select to_jsonb(v) from form_versions v where id = $1 and form_id = $2 limit 1",
        )
        .bind(version_id)
        .bind(form_id),
    )
    .await?
    .ok_or_else(|| not_found("Version"))
}

/// A version's definition, parsed for the engine.
pub(crate) fn definition_of(version: &Value) -> FormsResult<FormDefinition> {
    FormDefinition::parse(&version["definition"])
        .map_err(|_| Fail::Internal("forms: a stored definition does not parse".to_owned()))
}
