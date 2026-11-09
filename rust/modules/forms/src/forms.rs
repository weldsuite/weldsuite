//! Forms (`services/forms.ts`): the DTOs, create (blank, from a template,
//! from a definition), save the draft with optimistic concurrency,
//! duplicate, delete, the access list.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use sqlx::types::Json;
use sqlx::{Postgres, QueryBuilder};

use crate::access::{Grants, Relation, form_permissions};
use crate::common::{
    Ctx, Env, FormsResult, all, forms_error, forms_error_with, int, iso, js_slice, not_found, one,
    opt_text, public_form_url, text,
};
use crate::members::{bare_ref, member_ref, member_refs};
use crate::model::{FormSettings, blank_definition, parsed_definition, template_definition};
use crate::public_cache::{drop_public_cache, refresh_public_cache};

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/// `toSummary(ctx, row, owner)`.
pub(crate) fn to_summary(env: &Env, row: &Value, owner: &Value) -> Value {
    let settings = FormSettings::parse(&row["settings"]);
    let layout = row["definition"]["presentation"]["layout"]
        .as_str()
        .unwrap_or("conversational");
    let public_id = opt_text(row, "publicId");
    json!({
        "id": row["id"],
        "title": row["title"],
        "status": row["status"],
        "folderId": row["folderId"],
        "layout": layout,
        "publicId": public_id,
        "publicUrl": public_form_url(env, public_id.as_deref()),
        "access": row["access"],
        "respondentMode": settings.respondent_mode,
        "owner": owner,
        "responseCount": row["responseCount"],
        "lastResponseAt": row["lastResponseAt"],
        "hasUnpublishedChanges": row["hasUnpublishedChanges"],
        "publishedAt": row["publishedAt"],
        "closedAt": row["closedAt"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    })
}

/// `moderationOf(ctx, row)`: what staff did to the public link.
pub(crate) async fn moderation_of(ctx: &Ctx, row: &Value) -> FormsResult<Value> {
    let Some(public_id) = opt_text(row, "publicId") else {
        return Ok(Value::Null);
    };
    let link = one(
        ctx.master()?,
        sqlx::query_scalar(
            "select to_jsonb(l) from form_link_registry l where public_id = $1 limit 1",
        )
        .bind(public_id),
    )
    .await?;
    let Some(link) = link else {
        return Ok(Value::Null);
    };
    if !link["suspendedAt"].is_null() {
        return Ok(json!({ "state": "suspended", "reason": link["suspendedReason"] }));
    }
    if !link["heldAt"].is_null() {
        return Ok(json!({ "state": "held", "reason": link["heldReason"] }));
    }
    Ok(Value::Null)
}

/// `detailOf(loaded, form)`: the summary, the draft, settings, revision,
/// published version and what the member may do.
pub(crate) async fn detail_of(
    ctx: &Ctx,
    row: &Value,
    relation: Relation,
    grants: &Grants,
) -> FormsResult<Value> {
    let owner = member_ref(&ctx.db, text(row, "ownerUserId")).await?;
    let moderation = moderation_of(ctx, row).await?;
    let version = match opt_text(row, "publishedVersionId") {
        Some(id) => {
            one(
                &ctx.db,
                sqlx::query_scalar("select to_jsonb(v) from form_versions v where id = $1 limit 1")
                    .bind(id),
            )
            .await?
        }
        None => None,
    };
    let mut detail = to_summary(ctx.env(), row, &owner);
    if let Value::Object(fields) = &mut detail {
        fields.insert(
            "definition".to_owned(),
            parsed_definition(&row["definition"]),
        );
        fields.insert(
            "settings".to_owned(),
            FormSettings::parse(&row["settings"]).to_json(),
        );
        fields.insert("themeId".to_owned(), row["themeId"].clone());
        fields.insert("revision".to_owned(), row["revision"].clone());
        fields.insert(
            "publishedVersion".to_owned(),
            version.map_or(Value::Null, |v| {
                json!({ "id": v["id"], "number": v["number"], "publishedAt": v["publishedAt"] })
            }),
        );
        fields.insert(
            "permissions".to_owned(),
            form_permissions(relation, grants).to_json(),
        );
        fields.insert("moderation".to_owned(), moderation);
    }
    Ok(detail)
}

/// `formEventData(form, extra)`: ids, title and state only.
pub(crate) fn form_event_data(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "title": row["title"],
        "status": row["status"],
        "publicId": row["publicId"],
        "ownerUserId": row["ownerUserId"],
    })
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/// `ListFormsQuery`.
#[derive(Debug, Default)]
pub(crate) struct ListQuery {
    pub(crate) folder_id: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) q: Option<String>,
    pub(crate) sort: Option<String>,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<i64>,
}

const DEFAULT_LIMIT: i64 = 50;

/// `escapeLike`: `%`, `_` and `\` escaped, inside `%…%`.
fn like_pattern(search: &str) -> String {
    let mut out = String::from("%");
    for c in search.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

fn push_filters(q: &mut QueryBuilder<Postgres>, user_id: &str, grants: &Grants, query: &ListQuery) {
    q.push(" where true");
    if !grants.manage {
        q.push(" and (f.access = 'workspace' or f.owner_user_id = ")
            .push_bind(user_id.to_owned())
            .push(" or f.id in (select form_id from form_access where user_id = ")
            .push_bind(user_id.to_owned())
            .push("))");
    }
    match query.folder_id.as_deref() {
        Some("none") => {
            q.push(" and f.folder_id is null");
        }
        Some(folder) if !folder.is_empty() => {
            q.push(" and f.folder_id = ").push_bind(folder.to_owned());
        }
        _ => {}
    }
    if let Some(status) = query.status.as_deref() {
        q.push(" and f.status = ").push_bind(status.to_owned());
    }
    if let Some(search) = query.q.as_deref().filter(|q| !q.is_empty()) {
        q.push(" and f.title ilike ")
            .push_bind(like_pattern(search));
    }
}

/// `listForms(ctx, userId, grants, query)`: a page, the total and the next cursor.
pub(crate) async fn list_forms(
    ctx: &Ctx,
    user_id: &str,
    grants: &Grants,
    query: &ListQuery,
) -> FormsResult<(Vec<Value>, i64, Option<String>)> {
    let order = match query.sort.as_deref() {
        Some("created") => "f.created_at desc",
        Some("title") => "f.title asc, f.id asc",
        Some("responses") => "f.response_count desc, f.updated_at desc",
        _ => "f.updated_at desc, f.id desc",
    };
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    let offset = query
        .cursor
        .as_deref()
        .filter(|cursor| !cursor.is_empty())
        .map_or(0, |cursor| {
            let n = weldsuite_kit::validation::js_number(cursor);
            if n.is_finite() && n > 0.0 {
                #[allow(clippy::cast_possible_truncation)]
                let n = n as i64;
                n
            } else {
                0
            }
        });

    let mut rows_query = QueryBuilder::new("select to_jsonb(f) from forms f");
    push_filters(&mut rows_query, user_id, grants, query);
    rows_query
        .push(format!(" order by {order} limit "))
        .push_bind(limit)
        .push(" offset ")
        .push_bind(offset);
    let rows: Vec<Value> = rows_query
        .build_query_scalar::<Value>()
        .fetch_all(&ctx.db)
        .await?
        .into_iter()
        .map(weldsuite_db::js_row)
        .collect();

    let mut count_query = QueryBuilder::new("select count(*)::int8 from forms f");
    push_filters(&mut count_query, user_id, grants, query);
    let total: i64 = count_query
        .build_query_scalar::<i64>()
        .fetch_one(&ctx.db)
        .await?;

    let owners = member_refs(
        &ctx.db,
        &rows
            .iter()
            .map(|row| text(row, "ownerUserId").to_owned())
            .collect::<Vec<_>>(),
    )
    .await?;
    let next = offset + i64::try_from(rows.len()).unwrap_or_default();
    let summaries = rows
        .iter()
        .map(|row| {
            let owner_id = text(row, "ownerUserId");
            let owner = owners
                .get(owner_id)
                .cloned()
                .unwrap_or_else(|| bare_ref(owner_id));
            to_summary(ctx.env(), row, &owner)
        })
        .collect();
    Ok((summaries, total, (next < total).then(|| next.to_string())))
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/// `CreateFormInput`.
#[derive(Debug, Default)]
pub(crate) struct CreateInput {
    pub(crate) title: String,
    pub(crate) folder_id: Option<String>,
    pub(crate) template_id: Option<String>,
    pub(crate) definition: Option<Value>,
    pub(crate) layout: Option<String>,
}

/// The theme new forms start with: the workspace default.
async fn default_theme_id(ctx: &Ctx) -> FormsResult<Option<String>> {
    let settings: Option<Option<String>> =
        sqlx::query_scalar("select default_theme_id from form_settings limit 1")
            .fetch_optional(&ctx.db)
            .await?;
    if let Some(id) = settings.flatten() {
        return Ok(Some(id));
    }
    Ok(
        sqlx::query_scalar("select id from form_themes where is_default = true limit 1")
            .fetch_optional(&ctx.db)
            .await?,
    )
}

fn starting_definition(input: &CreateInput) -> FormsResult<Value> {
    let mut definition = if let Some(definition) = &input.definition {
        definition.clone()
    } else if let Some(template_id) = &input.template_id {
        let Some(template) = template_definition(template_id) else {
            return Err(forms_error(
                400,
                "TEMPLATE_NOT_FOUND",
                format!("Template '{template_id}' does not exist"),
            ));
        };
        parsed_definition(&template)
    } else {
        blank_definition()
    };
    if let Some(layout) = &input.layout
        && let Some(presentation) = definition
            .get_mut("presentation")
            .and_then(Value::as_object_mut)
    {
        presentation.insert("layout".to_owned(), Value::String(layout.clone()));
    }
    Ok(definition)
}

async fn require_folder(ctx: &Ctx, folder_id: &str) -> FormsResult<()> {
    let found: Option<String> =
        sqlx::query_scalar("select id from form_folders where id = $1 limit 1")
            .bind(folder_id)
            .fetch_optional(&ctx.db)
            .await?;
    found.map(|_| ()).ok_or_else(|| not_found("Folder"))
}

/// A form row, or 404.
pub(crate) async fn load_row(ctx: &Ctx, id: &str) -> FormsResult<Value> {
    crate::access::form_row(&ctx.db, id)
        .await?
        .ok_or_else(|| not_found("Form"))
}

/// `createForm(ctx, userId, input)`.
pub(crate) async fn create_form(
    ctx: &Ctx,
    user_id: &str,
    input: &CreateInput,
) -> FormsResult<Value> {
    if let Some(folder) = input.folder_id.as_deref().filter(|f| !f.is_empty()) {
        require_folder(ctx, folder).await?;
    }
    let definition = starting_definition(input)?;
    let id = weldsuite_kit::generate_id("frm");
    let theme_id = default_theme_id(ctx).await?;
    let settings = FormSettings::default().to_json();
    weldsuite_db::atomically(
        &ctx.db,
        [
            sqlx::query(
                "insert into forms (id, folder_id, title, definition, settings, theme_id, owner_user_id) \
                 values ($1, $2, $3, $4, $5, $6, $7)",
            )
            .bind(id.clone())
            .bind(input.folder_id.clone())
            .bind(input.title.clone())
            .bind(Json(definition))
            .bind(Json(settings))
            .bind(theme_id)
            .bind(user_id.to_owned()),
            // The owner is subscribed to responses from the start.
            sqlx::query(
                "insert into form_subscriptions (id, form_id, user_id, mode) values ($1, $2, $3, 'instant')",
            )
            .bind(weldsuite_kit::generate_id("fsb"))
            .bind(id.clone())
            .bind(user_id.to_owned()),
        ],
    )
    .await?;
    load_row(ctx, &id).await
}

// ---------------------------------------------------------------------------
// Save the draft
// ---------------------------------------------------------------------------

/// `UpdateFormInput`; a field left out is `None`, a cleared one `Some(None)`.
#[allow(
    clippy::option_option,
    reason = "left out, cleared or set, as Zod's `.nullable().optional()`"
)]
#[derive(Debug, Default)]
pub(crate) struct UpdateInput {
    pub(crate) revision: i64,
    pub(crate) title: Option<String>,
    pub(crate) folder_id: Option<Option<String>>,
    pub(crate) definition: Option<Value>,
    pub(crate) settings: Option<Map<String, Value>>,
    pub(crate) theme_id: Option<Option<String>>,
    pub(crate) access: Option<String>,
}

/// `updateForm(ctx, form, input)`: 409 `REVISION_CONFLICT` when somebody
/// saved in between; operational settings and the title refresh the
/// public cache of a live form.
pub(crate) async fn update_form(
    ctx: &Ctx,
    form: &Value,
    input: &UpdateInput,
) -> FormsResult<Value> {
    if let Some(Some(folder)) = &input.folder_id
        && !folder.is_empty()
    {
        require_folder(ctx, folder).await?;
    }
    if let Some(Some(theme)) = &input.theme_id
        && !theme.is_empty()
    {
        let found: Option<String> =
            sqlx::query_scalar("select id from form_themes where id = $1 limit 1")
                .bind(theme)
                .fetch_optional(&ctx.db)
                .await?;
        if found.is_none() {
            return Err(not_found("Theme"));
        }
    }
    let settings = input.settings.as_ref().map(|patch| {
        FormSettings::parse(&form["settings"])
            .merged(patch)
            .to_json()
    });
    let changes_content = input.definition.is_some() || input.theme_id.is_some();
    let id = text(form, "id").to_owned();

    let mut q =
        QueryBuilder::<Postgres>::new("update forms set revision = revision + 1, updated_at = ");
    q.push_bind(iso(ctx.now_ms())).push("::timestamptz");
    if let Some(title) = &input.title {
        q.push(", title = ").push_bind(title.clone());
    }
    if let Some(folder) = &input.folder_id {
        q.push(", folder_id = ").push_bind(folder.clone());
    }
    if let Some(definition) = &input.definition {
        q.push(", definition = ")
            .push_bind(Json(definition.clone()));
    }
    if let Some(settings) = &settings {
        q.push(", settings = ").push_bind(Json(settings.clone()));
    }
    if let Some(theme) = &input.theme_id {
        q.push(", theme_id = ").push_bind(theme.clone());
    }
    if let Some(access) = &input.access {
        q.push(", access = ").push_bind(access.clone());
    }
    if changes_content && !form["publishedVersionId"].is_null() {
        q.push(", has_unpublished_changes = true");
    }
    q.push(" where id = ")
        .push_bind(id.clone())
        .push(" and revision = ")
        .push_bind(input.revision)
        .push(" returning id");
    let updated: Option<String> = q.build_query_scalar().fetch_optional(&ctx.db).await?;
    if updated.is_none() {
        let current: Option<i64> =
            sqlx::query_scalar("select revision::int8 from forms where id = $1 limit 1")
                .bind(&id)
                .fetch_optional(&ctx.db)
                .await?;
        let Some(current) = current else {
            return Err(not_found("Form"));
        };
        return Err(forms_error_with(
            409,
            "REVISION_CONFLICT",
            "Somebody else saved this form. Reload it to continue.",
            json!({ "currentRevision": current }),
        ));
    }
    let row = load_row(ctx, &id).await?;
    if !row["publicId"].is_null() && (settings.is_some() || input.title.is_some()) {
        refresh_public_cache(ctx, &row).await?;
    }
    Ok(row)
}

// ---------------------------------------------------------------------------
// Duplicate, delete
// ---------------------------------------------------------------------------

/// `duplicateForm(ctx, source, userId, title)`.
pub(crate) async fn duplicate_form(
    ctx: &Ctx,
    source: &Value,
    user_id: &str,
    title: Option<&str>,
) -> FormsResult<Value> {
    let id = weldsuite_kit::generate_id("frm");
    let copy_title = js_slice(
        &title.map_or_else(
            || format!("{} (copy)", text(source, "title")),
            str::to_owned,
        ),
        255,
    );
    weldsuite_db::atomically(
        &ctx.db,
        [
            sqlx::query(
                "insert into forms (id, folder_id, title, definition, settings, theme_id, owner_user_id) \
                 values ($1, $2, $3, $4, $5, $6, $7)",
            )
            .bind(id.clone())
            .bind(opt_text(source, "folderId"))
            .bind(copy_title)
            .bind(Json(source["definition"].clone()))
            .bind(Json(source["settings"].clone()))
            .bind(opt_text(source, "themeId"))
            .bind(user_id.to_owned()),
            sqlx::query(
                "insert into form_subscriptions (id, form_id, user_id, mode) values ($1, $2, $3, 'instant')",
            )
            .bind(weldsuite_kit::generate_id("fsb"))
            .bind(id.clone())
            .bind(user_id.to_owned()),
        ],
    )
    .await?;
    load_row(ctx, &id).await
}

/// `deleteForm(ctx, form)`: the form with its versions, responses, files,
/// invitations, integrations and links. Returns the private-bucket keys of
/// its files; the caller deletes them after the response.
pub(crate) async fn delete_form(ctx: &Ctx, form: &Value) -> FormsResult<Vec<String>> {
    let id = text(form, "id").to_owned();
    let keys: Vec<String> =
        sqlx::query_scalar("select storage_key from form_response_files where form_id = $1")
            .bind(&id)
            .fetch_all(&ctx.db)
            .await?;
    let statements: [&'static str; 10] = [
        "delete from form_ai_summaries where form_id = $1",
        "delete from form_response_actions where form_id = $1",
        "delete from form_response_files where form_id = $1",
        "delete from form_responses where form_id = $1",
        "delete from form_invitations where form_id = $1",
        "delete from form_integrations where form_id = $1",
        "delete from form_subscriptions where form_id = $1",
        "delete from form_access where form_id = $1",
        "delete from form_versions where form_id = $1",
        "delete from forms where id = $1",
    ];
    let queries: Vec<_> = statements
        .into_iter()
        .map(|sql| sqlx::query(sql).bind(id.clone()))
        .collect();
    weldsuite_db::atomically(&ctx.db, queries).await?;
    // The registries only route; with the form gone the links must stop answering.
    let master = ctx.master()?;
    sqlx::query("delete from form_link_registry where workspace_id = $1 and form_id = $2")
        .bind(&ctx.workspace_id)
        .bind(&id)
        .execute(master)
        .await?;
    sqlx::query("delete from form_invitation_registry where workspace_id = $1 and form_id = $2")
        .bind(&ctx.workspace_id)
        .bind(&id)
        .execute(master)
        .await?;
    if let Some(public_id) = opt_text(form, "publicId") {
        drop_public_cache(&ctx.svc, &public_id).await?;
    }
    Ok(keys)
}

// ---------------------------------------------------------------------------
// Access list
// ---------------------------------------------------------------------------

/// `listAccess(ctx, formId)`.
pub(crate) async fn list_access(ctx: &Ctx, form_id: &str) -> FormsResult<Vec<Value>> {
    let rows = all(
        &ctx.db,
        sqlx::query_scalar(
            "select to_jsonb(a) from form_access a where form_id = $1 order by created_at asc",
        )
        .bind(form_id),
    )
    .await?;
    let refs = member_refs(
        &ctx.db,
        &rows
            .iter()
            .map(|r| text(r, "userId").to_owned())
            .collect::<Vec<_>>(),
    )
    .await?;
    Ok(rows
        .iter()
        .map(|row| {
            let user_id = text(row, "userId");
            json!({
                "user": refs.get(user_id).cloned().unwrap_or_else(|| bare_ref(user_id)),
                "role": row["role"],
            })
        })
        .collect())
}

/// `setAccess(ctx, form, input)`: replaces the access list; the owner never
/// needs an entry.
pub(crate) async fn set_access(
    ctx: &Ctx,
    form: &Value,
    entries: &[(String, String)],
) -> FormsResult<Vec<Value>> {
    let form_id = text(form, "id").to_owned();
    let owner = text(form, "ownerUserId");
    // A Map keyed by user: the first position, the last role.
    let mut order: Vec<String> = Vec::new();
    let mut roles: HashMap<String, String> = HashMap::new();
    for (user_id, role) in entries {
        if user_id == owner {
            continue;
        }
        if !roles.contains_key(user_id) {
            order.push(user_id.clone());
        }
        roles.insert(user_id.clone(), role.clone());
    }
    let mut statements =
        vec![sqlx::query("delete from form_access where form_id = $1").bind(form_id.clone())];
    for user_id in &order {
        statements.push(
            sqlx::query(
                "insert into form_access (id, form_id, user_id, role) values ($1, $2, $3, $4)",
            )
            .bind(weldsuite_kit::generate_id("fac"))
            .bind(form_id.clone())
            .bind(user_id.clone())
            .bind(roles.get(user_id).cloned().unwrap_or_default()),
        );
    }
    statements.push(
        sqlx::query("update forms set updated_at = $2::timestamptz where id = $1")
            .bind(form_id.clone())
            .bind(iso(ctx.now_ms())),
    );
    weldsuite_db::atomically(&ctx.db, statements).await?;
    list_access(ctx, &form_id).await
}

/// `responseCount` of a row, for the counters.
#[allow(dead_code)]
pub(crate) fn response_count(row: &Value) -> i64 {
    int(row, "responseCount")
}
