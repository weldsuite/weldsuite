//! Responses as members see them (`services/responses.ts`): the list
//! (filters, search, sort), one response with its actions, deleting (one,
//! many, a respondent's everything), file downloads, a person's responses
//! across forms and the retry of an integration step.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};
use sqlx::PgPool;

use crate::access::{Grants, Need, form_permissions, relation_to};
use crate::common::{Ctx, FormsResult, all, forms_error, iso, not_found, one, text};
use crate::members::member_refs;
use crate::process::{ProcessResponseParams, start_processing};
use crate::response_model::{
    Bind, ResponseFilter, Where, bind_all, latest_fields, load_versions, response_conditions,
    response_order, to_response_dto,
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
    let files = all(
        db,
        sqlx::query_scalar(
            "select to_jsonb(f) from form_response_files f where response_id = any($1) order by created_at",
        )
        .bind(response_ids),
    )
    .await?;
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
    let refs = member_refs(&ctx.db, &respondents).await?;
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
    mut w: Where,
    order: &str,
    limit: i64,
    offset: i64,
) -> FormsResult<(Vec<Value>, i64)> {
    let count_sql = format!("select count(*)::int from form_responses where {}", w.sql());
    let total: i32 = bind_all(sqlx::query_scalar(sqlx::AssertSqlSafe(count_sql)), &w.binds)
        .fetch_one(db)
        .await?;
    let limit = w.param(Bind::Int(limit));
    let offset = w.param(Bind::Int(offset));
    let sql = format!(
        "select to_jsonb(r) from form_responses r where {} order by {order} limit {limit} offset {offset}",
        w.sql()
    );
    let rows = all(
        db,
        bind_all(sqlx::query_scalar(sqlx::AssertSqlSafe(sql)), &w.binds),
    )
    .await?;
    Ok((rows, i64::from(total)))
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
    let (rows, total) = page_of(&ctx.db, w, &response_order(sort), limit, offset).await?;
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
    let Some(row) = one(
        &ctx.db,
        sqlx::query_scalar(
            "select to_jsonb(r) from form_responses r where id = $1 and form_id = $2 limit 1",
        )
        .bind(response_id)
        .bind(form_id),
    )
    .await?
    else {
        return Err(not_found("Response"));
    };
    let versions = load_versions(&ctx.db, form_id).await?;
    let numbers: HashMap<String, i64> = versions.iter().map(|v| (v.id.clone(), v.number)).collect();
    let mut dto = dtos(ctx, std::slice::from_ref(&row), &numbers)
        .await?
        .pop()
        .unwrap_or(Value::Null);
    let actions = all(
        &ctx.db,
        sqlx::query_scalar(
            "select to_jsonb(a) from form_response_actions a where response_id = $1 order by created_at",
        )
        .bind(text(&row, "id")),
    )
    .await?;
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
    let rows = match form_id {
        Some(form_id) => {
            all(
                &ctx.db,
                sqlx::query_scalar(
                    "select to_jsonb(r) from form_responses r where id = any($1) and form_id = $2",
                )
                .bind(response_ids)
                .bind(form_id),
            )
            .await?
        }
        None => {
            all(
                &ctx.db,
                sqlx::query_scalar("select to_jsonb(r) from form_responses r where id = any($1)")
                    .bind(response_ids),
            )
            .await?
        }
    };
    if rows.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let keys: Vec<String> = sqlx::query_scalar(
        "select storage_key from form_response_files where response_id = any($1)",
    )
    .bind(&ids)
    .fetch_all(&ctx.db)
    .await?;
    let mut form_ids: Vec<String> = Vec::new();
    for row in &rows {
        let id = text(row, "formId").to_owned();
        if !form_ids.contains(&id) {
            form_ids.push(id);
        }
    }
    let titles: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("select id, title from forms where id = any($1)")
            .bind(&form_ids)
            .fetch_all(&ctx.db)
            .await?
            .into_iter()
            .collect();
    let mut completed: Vec<(String, i32)> = Vec::new();
    for row in rows.iter().filter(|r| text(r, "status") == "completed") {
        let id = text(row, "formId");
        match completed.iter_mut().find(|(f, _)| f == id) {
            Some((_, n)) => *n += 1,
            None => completed.push((id.to_owned(), 1)),
        }
    }

    let mut tx = ctx.db.begin().await?;
    sqlx::query("delete from form_response_actions where response_id = any($1)")
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    sqlx::query("delete from form_response_files where response_id = any($1)")
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    sqlx::query("delete from form_responses where id = any($1)")
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    for (form, n) in &completed {
        sqlx::query(
            "update forms set response_count = greatest(response_count - $2, 0) where id = $1",
        )
        .bind(form)
        .bind(n)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

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

/// `responseIdsByEmail(ctx, email, formIds)`: for the GDPR erase.
pub(crate) async fn response_ids_by_email(
    ctx: &Ctx,
    email: &str,
    form_ids: &[String],
) -> FormsResult<Vec<String>> {
    if form_ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(sqlx::query_scalar(
        "select id from form_responses where form_id = any($1) and lower(respondent_email) = $2",
    )
    .bind(form_ids)
    .bind(weldsuite_kit::validation::js_trim(email).to_lowercase())
    .fetch_all(&ctx.db)
    .await?)
}

/// `findResponseFile(ctx, formId, responseId, fileId)`.
pub(crate) async fn find_response_file(
    ctx: &Ctx,
    form_id: &str,
    response_id: &str,
    file_id: &str,
) -> FormsResult<Value> {
    one(
        &ctx.db,
        sqlx::query_scalar(
            "select to_jsonb(f) from form_response_files f \
             where id = $1 and response_id = $2 and form_id = $3 limit 1",
        )
        .bind(file_id)
        .bind(response_id)
        .bind(form_id),
    )
    .await?
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
    let forms = all(db, sqlx::query_scalar("select to_jsonb(f) from forms f")).await?;
    let roles: HashMap<String, String> = if grants.manage {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (String, String)>(
            "select form_id, role from form_access where user_id = $1",
        )
        .bind(user_id)
        .fetch_all(db)
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
    let mut w = Where::default();
    let person = w.param(Bind::Text(person_id.to_owned()));
    let forms = w.param(Bind::Texts(form_ids.to_vec()));
    w.push(format!("person_id = {person}"));
    w.push(format!("form_id = any({forms})"));
    let limit = limit.unwrap_or(DEFAULT_LIMIT);
    let offset = offset_of(cursor);
    let (rows, total) = page_of(
        &ctx.db,
        w,
        "coalesce(submitted_at, started_at) desc, id desc",
        limit,
        offset,
    )
    .await?;
    let version_ids: Vec<String> = rows
        .iter()
        .map(|r| text(r, "versionId").to_owned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let mut numbers = HashMap::new();
    if !version_ids.is_empty() {
        numbers = sqlx::query_as::<_, (String, i32)>(
            "select id, number from form_versions where id = any($1)",
        )
        .bind(&version_ids)
        .fetch_all(&ctx.db)
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
    let Some(action) = one(
        &ctx.db,
        sqlx::query_scalar(
            "select to_jsonb(a) from form_response_actions a \
             where id = $1 and response_id = $2 and form_id = $3 limit 1",
        )
        .bind(action_id)
        .bind(response_id)
        .bind(form_id),
    )
    .await?
    else {
        return Err(not_found("Action"));
    };
    let status: Option<String> = sqlx::query_scalar(
        "select status from form_responses where id = $1 and form_id = $2 limit 1",
    )
    .bind(response_id)
    .bind(form_id)
    .fetch_optional(&ctx.db)
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
    let integration: Option<String> =
        sqlx::query_scalar("select id from form_integrations where id = $1 limit 1")
            .bind(text(&action, "integrationId"))
            .fetch_optional(&ctx.db)
            .await?;
    let Some(integration) = integration else {
        return Err(not_found("Integration"));
    };
    let now = ctx.now_ms();
    sqlx::query(
        "update form_response_actions set status = 'pending', error = null, updated_at = $2::timestamptz where id = $1",
    )
    .bind(text(&action, "id"))
    .bind(iso(now))
    .execute(&ctx.db)
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
