//! Responses as members see them (`services/responses.ts`): the list
//! (filters, search, sort), one response with its actions, deleting (one,
//! many, a respondent's everything), file downloads, a person's responses
//! across forms and the retry of an integration step.

use std::collections::{HashMap, HashSet};

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_db::{OrmConn, atomically_with, orm};
use weldsuite_schema::tenant::{
    form_access, form_integrations, form_response_actions, form_response_files, form_responses,
    form_versions, forms,
};

use crate::access::{Grants, Need, form_permissions, relation_to};
use crate::common::{Ctx, FormsResult, forms_error, instant, not_found, row_json, rows_json, text};
use crate::members::member_refs;
use crate::process::{ProcessResponseParams, start_processing};
use crate::response_model::{
    ResponseFilter, latest_fields, load_versions, response_conditions, response_order,
    to_response_dto,
};

const DEFAULT_LIMIT: i64 = 50;

/// `filesOf(ctx, responseIds)`: files of the given responses by response id.
async fn files_of(
    db: &PgPool,
    response_ids: &[String],
) -> FormsResult<HashMap<String, Vec<Value>>> {
    let mut by_response: HashMap<String, Vec<Value>> = HashMap::new();
    if response_ids.is_empty() {
        return Ok(by_response);
    }
    let files = rows_json(
        form_response_files::Entity::find()
            .filter(form_response_files::Column::ResponseId.is_in(response_ids))
            .order_by_asc(form_response_files::Column::CreatedAt)
            .all(&orm(db))
            .await?,
    )?;
    for file in files {
        by_response
            .entry(text(&file, "responseId").to_owned())
            .or_default()
            .push(file);
    }
    Ok(by_response)
}

/// `dtos(ctx, rows, versionNumbers)`.
pub(crate) async fn dtos(
    ctx: &Ctx,
    rows: &[Value],
    version_numbers: &HashMap<String, i64>,
) -> FormsResult<Vec<Value>> {
    let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let respondents: Vec<String> = rows
        .iter()
        .filter_map(|r| r["respondentUserId"].as_str())
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect();
    let files = files_of(&ctx.db, &ids).await?;
    let refs = member_refs(ctx, &respondents).await?;
    let now = ctx.now_ms();
    Ok(rows
        .iter()
        .map(|row| {
            let respondent = row["respondentUserId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map(|id| refs.get(id).cloned().unwrap_or(Value::Null));
            to_response_dto(
                row,
                version_numbers
                    .get(text(row, "versionId"))
                    .copied()
                    .unwrap_or(0),
                files.get(text(row, "id")).map_or(&[][..], Vec::as_slice),
                respondent,
                now,
            )
        })
        .collect())
}

/// One page of responses.
pub(crate) struct ResponsePage {
    pub(crate) rows: Vec<Value>,
    pub(crate) total: i64,
    pub(crate) next: Option<String>,
}

/// `Number(cursor) || 0`, at least 0.
pub(crate) fn offset_of(cursor: Option<&str>) -> i64 {
    let n = cursor.map_or(0.0, weldsuite_kit::validation::js_number);
    if n.is_finite() && n > 0.0 {
        #[allow(clippy::cast_possible_truncation)]
        let n = n as i64;
        n
    } else {
        0
    }
}

/// `select … where … order by … limit … offset …` and `count(*)` over the
/// same conditions.
async fn page_of(
    db: &PgPool,
    w: Condition,
    sort: Option<&str>,
    limit: i64,
    offset: i64,
) -> FormsResult<(Vec<Value>, i64)> {
    let db = orm(db);
    let total = form_responses::Entity::find()
        .filter(w.clone())
        .count(&db)
        .await?;
    let rows = response_order(form_responses::Entity::find().filter(w), sort)
        .limit(u64::try_from(limit).unwrap_or_default())
        .offset(u64::try_from(offset).unwrap_or_default())
        .all(&db)
        .await?;
    Ok((rows_json(rows)?, i64::try_from(total).unwrap_or(i64::MAX)))
}

fn next_cursor(offset: i64, rows: usize, total: i64) -> Option<String> {
    let next = offset + i64::try_from(rows).unwrap_or(0);
    (next < total).then(|| next.to_string())
}

/// `listResponses(ctx, formId, query)`.
pub(crate) async fn list_responses(
    ctx: &Ctx,
    form_id: &str,
    filter: &ResponseFilter,
    sort: Option<&str>,
    cursor: Option<&str>,
    limit: Option<i64>,
) -> FormsResult<ResponsePage> {
    let versions = load_versions(&ctx.db, form_id).await?;
    let w = response_conditions(form_id, filter, &latest_fields(&versions))?;
    let limit = limit.unwrap_or(DEFAULT_LIMIT);
    let offset = offset_of(cursor);
    let (rows, total) = page_of(&ctx.db, w, sort, limit, offset).await?;
    let numbers: HashMap<String, i64> = versions.iter().map(|v| (v.id.clone(), v.number)).collect();
    Ok(ResponsePage {
        next: next_cursor(offset, rows.len(), total),
        rows: dtos(ctx, &rows, &numbers).await?,
        total,
    })
}

/// `getResponse(ctx, formId, responseId)`: the DTO with its actions.
pub(crate) async fn get_response(
    ctx: &Ctx,
    form_id: &str,
    response_id: &str,
) -> FormsResult<Value> {
    let db = orm(&ctx.db);
    let Some(row) = form_responses::Entity::find()
        .filter(form_responses::Column::Id.eq(response_id))
        .filter(form_responses::Column::FormId.eq(form_id))
        .one(&db)
        .await?
        .map(row_json)
        .transpose()?
    else {
        return Err(not_found("Response"));
    };
    let versions = load_versions(&ctx.db, form_id).await?;
    let numbers: HashMap<String, i64> = versions.iter().map(|v| (v.id.clone(), v.number)).collect();
    let mut dto = dtos(ctx, std::slice::from_ref(&row), &numbers)
        .await?
        .pop()
        .unwrap_or(Value::Null);
    let actions = rows_json(
        form_response_actions::Entity::find()
            .filter(form_response_actions::Column::ResponseId.eq(text(&row, "id")))
            .order_by_asc(form_response_actions::Column::CreatedAt)
            .all(&db)
            .await?,
    )?;
    dto["actions"] = Value::Array(
        actions
            .iter()
            .map(|a| {
                json!({
                    "id": a["id"],
                    "integrationId": a["integrationId"],
                    "kind": a["kind"],
                    "status": a["status"],
                    "entityType": a["entityType"],
                    "entityId": a["entityId"],
                    "error": a["error"],
                    "attempts": a["attempts"],
                    "updatedAt": a["updatedAt"],
                })
            })
            .collect(),
    );
    Ok(dto)
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/// `DeletedResponse`: what went, for the events.
#[derive(Debug, Clone)]
pub(crate) struct DeletedResponse {
    pub(crate) id: String,
    pub(crate) form_id: String,
    pub(crate) data: Value,
}

/// `deleteResponses(ctx, ids, { formId })`: the responses with their files
/// and actions; completed ones lower their form's `response_count`. Returns
/// what went and the bucket keys the caller removes after answering.
#[allow(clippy::too_many_lines, reason = "the worker's steps, in its order")]
pub(crate) async fn delete_responses(
    ctx: &Ctx,
    response_ids: &[String],
    form_id: Option<&str>,
) -> FormsResult<(Vec<DeletedResponse>, Vec<String>)> {
    if response_ids.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let db = orm(&ctx.db);
    let mut find = form_responses::Entity::find()
        .filter(form_responses::Column::Id.is_in(response_ids.iter().cloned()));
    if let Some(form_id) = form_id {
        find = find.filter(form_responses::Column::FormId.eq(form_id));
    }
    let rows = rows_json(find.all(&db).await?)?;
    if rows.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let keys: Vec<String> = form_response_files::Entity::find()
        .select_only()
        .column(form_response_files::Column::StorageKey)
        .filter(form_response_files::Column::ResponseId.is_in(ids.iter().cloned()))
        .into_tuple()
        .all(&db)
        .await?;
    let mut form_ids: Vec<String> = Vec::new();
    for row in &rows {
        let id = text(row, "formId").to_owned();
        if !form_ids.contains(&id) {
            form_ids.push(id);
        }
    }
    let titles = form_titles(ctx, &form_ids).await?;
    let mut completed: Vec<(String, i32)> = Vec::new();
    for row in rows.iter().filter(|r| text(r, "status") == "completed") {
        let id = text(row, "formId");
        match completed.iter_mut().find(|(f, _)| f == id) {
            Some((_, n)) => *n += 1,
            None => completed.push((id.to_owned(), 1)),
        }
    }

    delete_rows(&ctx.db, ids, completed).await?;

    let deleted = rows
        .iter()
        .map(|r| {
            let form_id = text(r, "formId").to_owned();
            DeletedResponse {
                id: text(r, "id").to_owned(),
                data: json!({
                    "id": r["id"],
                    "formId": r["formId"],
                    "formTitle": titles.get(&form_id).cloned().unwrap_or_default(),
                    "number": r["number"],
                    "respondentEmail": r["respondentEmail"],
                    "personId": r["personId"],
                    "invitationId": r["invitationId"],
                }),
                form_id,
            }
        })
        .collect();
    Ok((deleted, keys))
}

/// `id, title` of the given forms.
pub(crate) async fn form_titles(
    ctx: &Ctx,
    form_ids: &[String],
) -> FormsResult<HashMap<String, String>> {
    Ok(forms::Entity::find()
        .select_only()
        .columns([forms::Column::Id, forms::Column::Title])
        .filter(forms::Column::Id.is_in(form_ids.iter().cloned()))
        .into_tuple::<(String, String)>()
        .all(&orm(&ctx.db))
        .await?
        .into_iter()
        .collect())
}

/// The responses with their actions and files, in one transaction; each
/// form's `response_count` goes down by its completed ones (not below 0).
async fn delete_rows(
    db: &PgPool,
    ids: Vec<String>,
    completed: Vec<(String, i32)>,
) -> FormsResult<()> {
    atomically_with(db, |tx| {
        Box::pin(async move {
            use sea_orm::ExprTrait as _;
            let db = OrmConn::new(tx);
            form_response_actions::Entity::delete_many()
                .filter(form_response_actions::Column::ResponseId.is_in(ids.iter().cloned()))
                .exec(&db)
                .await?;
            form_response_files::Entity::delete_many()
                .filter(form_response_files::Column::ResponseId.is_in(ids.iter().cloned()))
                .exec(&db)
                .await?;
            form_responses::Entity::delete_many()
                .filter(form_responses::Column::Id.is_in(ids))
                .exec(&db)
                .await?;
            for (form, n) in completed {
                forms::Entity::update_many()
                    .col_expr(
                        forms::Column::ResponseCount,
                        Expr::from(Func::greatest([
                            Expr::col(forms::Column::ResponseCount).sub(n),
                            Expr::val(0),
                        ])),
                    )
                    .filter(forms::Column::Id.eq(form))
                    .exec(&db)
                    .await?;
            }
            FormsResult::Ok(())
        })
    })
    .await
}

/// `responseIdsByEmail(ctx, email, formIds)`: for the GDPR erase.
pub(crate) async fn response_ids_by_email(
    ctx: &Ctx,
    email: &str,
    form_ids: &[String],
) -> FormsResult<Vec<String>> {
    use sea_orm::ExprTrait as _;
    if form_ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(form_responses::Entity::find()
        .select_only()
        .column(form_responses::Column::Id)
        .filter(form_responses::Column::FormId.is_in(form_ids.iter().cloned()))
        .filter(
            Expr::from(Func::lower(Expr::col(
                form_responses::Column::RespondentEmail,
            )))
            .eq(weldsuite_kit::validation::js_trim(email).to_lowercase()),
        )
        .into_tuple()
        .all(&orm(&ctx.db))
        .await?)
}

/// `findResponseFile(ctx, formId, responseId, fileId)`.
pub(crate) async fn find_response_file(
    ctx: &Ctx,
    form_id: &str,
    response_id: &str,
    file_id: &str,
) -> FormsResult<Value> {
    form_response_files::Entity::find()
        .filter(form_response_files::Column::Id.eq(file_id))
        .filter(form_response_files::Column::ResponseId.eq(response_id))
        .filter(form_response_files::Column::FormId.eq(form_id))
        .one(&orm(&ctx.db))
        .await?
        .map(row_json)
        .transpose()?
        .ok_or_else(|| not_found("File"))
}

// ---------------------------------------------------------------------------
// Across forms
// ---------------------------------------------------------------------------

fn role_relation(role: &str) -> Option<&'static str> {
    match role {
        "editor" => Some("editor"),
        "results" => Some("results"),
        _ => None,
    }
}

/// `answerableFormIds(db, userId, grants, need)`: the forms the member can
/// see and holds `need` on.
pub(crate) async fn answerable_form_ids(
    db: &PgPool,
    user_id: &str,
    grants: &Grants,
    need: Need,
) -> FormsResult<Vec<String>> {
    let db = orm(db);
    let forms = rows_json(forms::Entity::find().all(&db).await?)?;
    let roles: HashMap<String, String> = if grants.manage {
        HashMap::new()
    } else {
        form_access::Entity::find()
            .select_only()
            .columns([form_access::Column::FormId, form_access::Column::Role])
            .filter(form_access::Column::UserId.eq(user_id))
            .into_tuple::<(String, String)>()
            .all(&db)
            .await?
            .into_iter()
            .collect()
    };
    Ok(forms
        .iter()
        .filter(|form| {
            let entry = roles
                .get(text(form, "id"))
                .and_then(|role| role_relation(role));
            relation_to(form, user_id, grants, entry)
                .is_some_and(|relation| form_permissions(relation, grants).allows(need))
        })
        .map(|form| text(form, "id").to_owned())
        .collect())
}

/// `listPersonResponses(ctx, personId, formIds, paging)`: newest first.
pub(crate) async fn list_person_responses(
    ctx: &Ctx,
    person_id: &str,
    form_ids: &[String],
    cursor: Option<&str>,
    limit: Option<i64>,
) -> FormsResult<ResponsePage> {
    if form_ids.is_empty() {
        return Ok(ResponsePage {
            rows: Vec::new(),
            total: 0,
            next: None,
        });
    }
    let w = Condition::all()
        .add(form_responses::Column::PersonId.eq(person_id))
        .add(form_responses::Column::FormId.is_in(form_ids.iter().cloned()));
    let limit = limit.unwrap_or(DEFAULT_LIMIT);
    let offset = offset_of(cursor);
    // Newest first (`coalesce(submitted_at, started_at) desc, id desc`).
    let (rows, total) = page_of(&ctx.db, w, None, limit, offset).await?;
    let version_ids: Vec<String> = rows
        .iter()
        .map(|r| text(r, "versionId").to_owned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let mut numbers = HashMap::new();
    if !version_ids.is_empty() {
        numbers = form_versions::Entity::find()
            .select_only()
            .columns([form_versions::Column::Id, form_versions::Column::Number])
            .filter(form_versions::Column::Id.is_in(version_ids))
            .into_tuple::<(String, i32)>()
            .all(&orm(&ctx.db))
            .await?
            .into_iter()
            .map(|(id, n)| (id, i64::from(n)))
            .collect();
    }
    Ok(ResponsePage {
        next: next_cursor(offset, rows.len(), total),
        rows: dtos(ctx, &rows, &numbers).await?,
        total,
    })
}

// ---------------------------------------------------------------------------
// Retry an integration step
// ---------------------------------------------------------------------------

/// `retryAction(ctx, form, responseId, actionId)`: one integration's step
/// again, as a `ProcessResponse` run of its own (`retryIntegrationId`).
pub(crate) async fn retry_action(
    ctx: &Ctx,
    form: &Value,
    response_id: &str,
    action_id: &str,
) -> FormsResult<()> {
    let form_id = text(form, "id");
    let db = orm(&ctx.db);
    let Some(action) = form_response_actions::Entity::find()
        .filter(form_response_actions::Column::Id.eq(action_id))
        .filter(form_response_actions::Column::ResponseId.eq(response_id))
        .filter(form_response_actions::Column::FormId.eq(form_id))
        .one(&db)
        .await?
    else {
        return Err(not_found("Action"));
    };
    let status: Option<String> = form_responses::Entity::find()
        .select_only()
        .column(form_responses::Column::Status)
        .filter(form_responses::Column::Id.eq(response_id))
        .filter(form_responses::Column::FormId.eq(form_id))
        .into_tuple()
        .one(&db)
        .await?;
    let Some(status) = status else {
        return Err(not_found("Response"));
    };
    if status != "completed" {
        return Err(forms_error(
            409,
            "NOT_COMPLETED",
            "Only a completed response can be processed again.",
        ));
    }
    let integration: Option<String> = form_integrations::Entity::find()
        .select_only()
        .column(form_integrations::Column::Id)
        .filter(form_integrations::Column::Id.eq(&action.integration_id))
        .into_tuple()
        .one(&db)
        .await?;
    let Some(integration) = integration else {
        return Err(not_found("Integration"));
    };
    let now = ctx.now_ms();
    form_response_actions::Entity::update_many()
        .col_expr(
            form_response_actions::Column::Status,
            Expr::value("pending"),
        )
        .col_expr(
            form_response_actions::Column::Error,
            Expr::value(None::<String>),
        )
        .col_expr(
            form_response_actions::Column::UpdatedAt,
            Expr::value(instant(now)),
        )
        .filter(form_response_actions::Column::Id.eq(&action.id))
        .exec(&db)
        .await?;
    let params = ProcessResponseParams {
        clerk_org_id: ctx.clerk_org_id.clone(),
        workspace_id: ctx.workspace_id.clone(),
        form_id: form_id.to_owned(),
        response_id: response_id.to_owned(),
        mode: "submit".to_owned(),
        retry_integration_id: Some(integration),
    };
    start_processing(ctx, &params, now)
        .await
        .map_err(crate::common::Fail::Internal)
}
