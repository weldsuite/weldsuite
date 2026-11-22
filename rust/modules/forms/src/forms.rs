//! Forms (`services/forms.ts`): the DTOs, create (blank, from a template,
//! from a definition), save the draft with optimistic concurrency,
//! duplicate, delete, the access list.

use std::collections::HashMap;

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, Query};
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_db::{OrmConn, orm};
use weldsuite_schema::master::{form_invitation_registry, form_link_registry};
use weldsuite_schema::tenant::{
    form_access, form_ai_summaries, form_folders, form_integrations, form_invitations,
    form_response_actions, form_response_files, form_responses, form_settings,
    form_subscriptions, form_themes, form_versions, forms,
};

use crate::access::{Grants, Relation, form_permissions};
use crate::common::{
    Ctx, Env, Fail, FormsResult, forms_error, forms_error_with, instant, int, js_slice, not_found,
    opt_text, parse_ms, public_form_url, row_json, rows_json, text,
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
    let link = form_link_registry::Entity::find()
        .filter(form_link_registry::Column::PublicId.eq(public_id))
        .one(&orm(ctx.master()?))
        .await?;
    let Some(link) = link else {
        return Ok(Value::Null);
    };
    if link.suspended_at.is_some() {
        return Ok(json!({ "state": "suspended", "reason": link.suspended_reason }));
    }
    if link.held_at.is_some() {
        return Ok(json!({ "state": "held", "reason": link.held_reason }));
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
    let owner = member_ref(ctx, text(row, "ownerUserId")).await?;
    let moderation = moderation_of(ctx, row).await?;
    let version = match opt_text(row, "publishedVersionId") {
        Some(id) => form_versions::Entity::find_by_id(id)
            .one(&orm(&ctx.db))
            .await?
            .map(row_json)
            .transpose()?,
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

/// The list's conditions: what the member may see, the folder, the status
/// and the title search.
fn list_condition(user_id: &str, grants: &Grants, query: &ListQuery) -> Condition {
    let mut condition = Condition::all();
    if !grants.manage {
        condition = condition.add(
            Condition::any()
                .add(forms::Column::Access.eq("workspace"))
                .add(forms::Column::OwnerUserId.eq(user_id))
                .add(
                    forms::Column::Id.in_subquery(
                        Query::select()
                            .column(form_access::Column::FormId)
                            .from(form_access::Entity)
                            .and_where(form_access::Column::UserId.eq(user_id))
                            .to_owned(),
                    ),
                ),
        );
    }
    match query.folder_id.as_deref() {
        Some("none") => {
            condition = condition.add(forms::Column::FolderId.is_null());
        }
        Some(folder) if !folder.is_empty() => {
            condition = condition.add(forms::Column::FolderId.eq(folder));
        }
        _ => {}
    }
    if let Some(status) = query.status.as_deref() {
        condition = condition.add(forms::Column::Status.eq(status));
    }
    if let Some(search) = query.q.as_deref().filter(|q| !q.is_empty()) {
        condition = condition.add(forms::Column::Title.ilike(like_pattern(search)));
    }
    condition
}

/// `listForms(ctx, userId, grants, query)`: a page, the total and the next cursor.
pub(crate) async fn list_forms(
    ctx: &Ctx,
    user_id: &str,
    grants: &Grants,
    query: &ListQuery,
) -> FormsResult<(Vec<Value>, i64, Option<String>)> {
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

    let db = orm(&ctx.db);
    let condition = list_condition(user_id, grants, query);
    let find = forms::Entity::find().filter(condition.clone());
    let find = match query.sort.as_deref() {
        Some("created") => find.order_by_desc(forms::Column::CreatedAt),
        Some("title") => find
            .order_by_asc(forms::Column::Title)
            .order_by_asc(forms::Column::Id),
        Some("responses") => find
            .order_by_desc(forms::Column::ResponseCount)
            .order_by_desc(forms::Column::UpdatedAt),
        _ => find
            .order_by_desc(forms::Column::UpdatedAt)
            .order_by_desc(forms::Column::Id),
    };
    let rows = rows_json(
        find.limit(u64::try_from(limit).unwrap_or(0))
            .offset(u64::try_from(offset).unwrap_or(0))
            .all(&db)
            .await?,
    )?;

    let total = forms::Entity::find().filter(condition).count(&db).await?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);

    let owners = member_refs(
        ctx,
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
    let db = orm(&ctx.db);
    let settings: Option<Option<String>> = form_settings::Entity::find()
        .select_only()
        .column(form_settings::Column::DefaultThemeId)
        .into_tuple()
        .one(&db)
        .await?;
    if let Some(id) = settings.flatten() {
        return Ok(Some(id));
    }
    Ok(form_themes::Entity::find()
        .select_only()
        .column(form_themes::Column::Id)
        .filter(form_themes::Column::IsDefault.eq(true))
        .into_tuple()
        .one(&db)
        .await?)
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
    let found: Option<String> = form_folders::Entity::find_by_id(folder_id)
        .select_only()
        .column(form_folders::Column::Id)
        .into_tuple()
        .one(&orm(&ctx.db))
        .await?;
    found.map(|_| ()).ok_or_else(|| not_found("Folder"))
}

/// A form row, or 404.
pub(crate) async fn load_row(ctx: &Ctx, id: &str) -> FormsResult<Value> {
    crate::access::form_row(&ctx.db, id)
        .await?
        .ok_or_else(|| not_found("Form"))
}

/// The owner's `instant` subscription to a new form.
fn owner_subscription(form_id: &str, user_id: &str) -> form_subscriptions::ActiveModel {
    form_subscriptions::ActiveModel {
        id: Set(weldsuite_kit::generate_id("fsb")),
        form_id: Set(form_id.to_owned()),
        user_id: Set(user_id.to_owned()),
        mode: Set("instant".to_owned()),
        ..Default::default()
    }
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
    let form = forms::ActiveModel {
        id: Set(id.clone()),
        folder_id: Set(input.folder_id.clone()),
        title: Set(input.title.clone()),
        definition: Set(definition),
        settings: Set(settings),
        theme_id: Set(theme_id),
        owner_user_id: Set(user_id.to_owned()),
        ..Default::default()
    };
    // The owner is subscribed to responses from the start.
    let subscription = owner_subscription(&id, user_id);
    weldsuite_db::atomically_with(&ctx.db, move |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            forms::Entity::insert(form)
                .exec_without_returning(&tx)
                .await?;
            form_subscriptions::Entity::insert(subscription)
                .exec_without_returning(&tx)
                .await?;
            Ok::<_, Fail>(())
        })
    })
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
        let found: Option<String> = form_themes::Entity::find_by_id(theme.as_str())
            .select_only()
            .column(form_themes::Column::Id)
            .into_tuple()
            .one(&orm(&ctx.db))
            .await?;
        if found.is_none() {
            return Err(not_found("Theme"));
        }
    }
    let merged = input
        .settings
        .as_ref()
        .map(|patch| (patch, FormSettings::parse(&form["settings"]).merged(patch)));
    // `checkOpenWindow`: a save of the dates may not close the form before
    // (or as) it opens, so that it could never take a response.
    if let Some((patch, settings)) = &merged
        && (patch.contains_key("opensAt") || patch.contains_key("closesAt"))
        && let (Some(opens), Some(closes)) = (
            settings.opens_at.as_deref().and_then(parse_ms),
            settings.closes_at.as_deref().and_then(parse_ms),
        )
        && closes <= opens
    {
        return Err(forms_error_with(
            400,
            "BAD_REQUEST",
            "The closing date must be after the opening date.",
            json!({ "field": "closesAt" }),
        ));
    }
    let settings = merged.map(|(_, settings)| settings.to_json());
    let changes_content = input.definition.is_some() || input.theme_id.is_some();
    let id = text(form, "id").to_owned();

    let mut update = forms::Entity::update_many()
        .col_expr(
            forms::Column::Revision,
            sea_orm::ExprTrait::add(Expr::col(forms::Column::Revision), 1),
        )
        .col_expr(forms::Column::UpdatedAt, Expr::value(instant(ctx.now_ms())));
    if let Some(title) = &input.title {
        update = update.col_expr(forms::Column::Title, Expr::value(title.clone()));
    }
    if let Some(folder) = &input.folder_id {
        update = update.col_expr(forms::Column::FolderId, Expr::value(folder.clone()));
    }
    if let Some(definition) = &input.definition {
        update = update.col_expr(forms::Column::Definition, Expr::value(definition.clone()));
    }
    if let Some(settings) = &settings {
        update = update.col_expr(forms::Column::Settings, Expr::value(settings.clone()));
    }
    if let Some(theme) = &input.theme_id {
        update = update.col_expr(forms::Column::ThemeId, Expr::value(theme.clone()));
    }
    if let Some(access) = &input.access {
        update = update.col_expr(forms::Column::Access, Expr::value(access.clone()));
    }
    if changes_content && !form["publishedVersionId"].is_null() {
        update = update.col_expr(forms::Column::HasUnpublishedChanges, Expr::value(true));
    }
    let db = orm(&ctx.db);
    let updated = update
        .filter(forms::Column::Id.eq(id.as_str()))
        .filter(forms::Column::Revision.eq(input.revision))
        .exec(&db)
        .await?;
    if updated.rows_affected == 0 {
        let current: Option<i32> = forms::Entity::find_by_id(id.as_str())
            .select_only()
            .column(forms::Column::Revision)
            .into_tuple()
            .one(&db)
            .await?;
        let Some(current) = current.map(i64::from) else {
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

/// A `form_access` row of `form_id`.
fn access_entry(form_id: &str, user_id: String, role: String) -> form_access::ActiveModel {
    form_access::ActiveModel {
        id: Set(weldsuite_kit::generate_id("fac")),
        form_id: Set(form_id.to_owned()),
        user_id: Set(user_id),
        role: Set(role),
        ..Default::default()
    }
}

/// `duplicateForm(ctx, source, userId, title)`: a copy as a new draft owned
/// by `user_id`, seen by the same people: the original's `access` and its
/// access list come along (less the new owner, who needs no entry), so
/// copying a restricted form never opens it up.
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
    let listed: Vec<(String, String)> = form_access::Entity::find()
        .select_only()
        .columns([form_access::Column::UserId, form_access::Column::Role])
        .filter(form_access::Column::FormId.eq(text(source, "id")))
        .order_by_asc(form_access::Column::UserId)
        .into_tuple()
        .all(&orm(&ctx.db))
        .await?;
    let form = forms::ActiveModel {
        id: Set(id.clone()),
        folder_id: Set(opt_text(source, "folderId")),
        title: Set(copy_title),
        definition: Set(source["definition"].clone()),
        settings: Set(source["settings"].clone()),
        theme_id: Set(opt_text(source, "themeId")),
        access: Set(text(source, "access").to_owned()),
        owner_user_id: Set(user_id.to_owned()),
        ..Default::default()
    };
    let subscription = owner_subscription(&id, user_id);
    let entries: Vec<form_access::ActiveModel> = listed
        .into_iter()
        .filter(|(member, _)| member != user_id)
        .map(|(member, role)| access_entry(&id, member, role))
        .collect();
    weldsuite_db::atomically_with(&ctx.db, move |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            forms::Entity::insert(form)
                .exec_without_returning(&tx)
                .await?;
            form_subscriptions::Entity::insert(subscription)
                .exec_without_returning(&tx)
                .await?;
            for entry in entries {
                form_access::Entity::insert(entry)
                    .exec_without_returning(&tx)
                    .await?;
            }
            Ok::<_, Fail>(())
        })
    })
    .await?;
    load_row(ctx, &id).await
}

/// `deleteForm(ctx, form)`: the form with its versions, responses, files,
/// invitations, integrations and links. Returns the private-bucket keys of
/// its files; the caller deletes them after the response.
pub(crate) async fn delete_form(ctx: &Ctx, form: &Value) -> FormsResult<Vec<String>> {
    let id = text(form, "id").to_owned();
    let keys: Vec<String> = form_response_files::Entity::find()
        .select_only()
        .column(form_response_files::Column::StorageKey)
        .filter(form_response_files::Column::FormId.eq(id.as_str()))
        .into_tuple()
        .all(&orm(&ctx.db))
        .await?;
    let form_id = id.clone();
    weldsuite_db::atomically_with(&ctx.db, move |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            let id = form_id.as_str();
            form_ai_summaries::Entity::delete_many()
                .filter(form_ai_summaries::Column::FormId.eq(id))
                .exec(&tx)
                .await?;
            form_response_actions::Entity::delete_many()
                .filter(form_response_actions::Column::FormId.eq(id))
                .exec(&tx)
                .await?;
            form_response_files::Entity::delete_many()
                .filter(form_response_files::Column::FormId.eq(id))
                .exec(&tx)
                .await?;
            form_responses::Entity::delete_many()
                .filter(form_responses::Column::FormId.eq(id))
                .exec(&tx)
                .await?;
            form_invitations::Entity::delete_many()
                .filter(form_invitations::Column::FormId.eq(id))
                .exec(&tx)
                .await?;
            form_integrations::Entity::delete_many()
                .filter(form_integrations::Column::FormId.eq(id))
                .exec(&tx)
                .await?;
            form_subscriptions::Entity::delete_many()
                .filter(form_subscriptions::Column::FormId.eq(id))
                .exec(&tx)
                .await?;
            form_access::Entity::delete_many()
                .filter(form_access::Column::FormId.eq(id))
                .exec(&tx)
                .await?;
            form_versions::Entity::delete_many()
                .filter(form_versions::Column::FormId.eq(id))
                .exec(&tx)
                .await?;
            forms::Entity::delete_by_id(id).exec(&tx).await?;
            Ok::<_, Fail>(())
        })
    })
    .await?;
    // The registries only route; with the form gone the links must stop answering.
    let master = orm(ctx.master()?);
    form_link_registry::Entity::delete_many()
        .filter(form_link_registry::Column::WorkspaceId.eq(ctx.workspace_id.as_str()))
        .filter(form_link_registry::Column::FormId.eq(id.as_str()))
        .exec(&master)
        .await?;
    form_invitation_registry::Entity::delete_many()
        .filter(form_invitation_registry::Column::WorkspaceId.eq(ctx.workspace_id.as_str()))
        .filter(form_invitation_registry::Column::FormId.eq(id.as_str()))
        .exec(&master)
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
    let rows = form_access::Entity::find()
        .filter(form_access::Column::FormId.eq(form_id))
        .order_by_asc(form_access::Column::CreatedAt)
        .all(&orm(&ctx.db))
        .await?;
    let refs = member_refs(
        ctx,
        &rows.iter().map(|r| r.user_id.clone()).collect::<Vec<_>>(),
    )
    .await?;
    Ok(rows
        .iter()
        .map(|row| {
            let user_id = row.user_id.as_str();
            json!({
                "user": refs.get(user_id).cloned().unwrap_or_else(|| bare_ref(user_id)),
                "role": row.role,
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
    let entries: Vec<form_access::ActiveModel> = order
        .into_iter()
        .map(|user_id| {
            let role = roles.get(&user_id).cloned().unwrap_or_default();
            access_entry(&form_id, user_id, role)
        })
        .collect();
    let touched = forms::Entity::update_many()
        .col_expr(forms::Column::UpdatedAt, Expr::value(instant(ctx.now_ms())))
        .filter(forms::Column::Id.eq(form_id.as_str()));
    let id = form_id.clone();
    weldsuite_db::atomically_with(&ctx.db, move |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            form_access::Entity::delete_many()
                .filter(form_access::Column::FormId.eq(id.as_str()))
                .exec(&tx)
                .await?;
            for entry in entries {
                form_access::Entity::insert(entry)
                    .exec_without_returning(&tx)
                    .await?;
            }
            touched.exec(&tx).await?;
            Ok::<_, Fail>(())
        })
    })
    .await?;
    list_access(ctx, &form_id).await
}

/// `responseCount` of a row, for the counters.
#[allow(dead_code)]
pub(crate) fn response_count(row: &Value) -> i64 {
    int(row, "responseCount")
}
