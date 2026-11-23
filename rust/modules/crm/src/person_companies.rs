//! `/api/person-companies` (`routes/person-companies/index.ts`): the
//! person ↔ company link table, used by the company panel's People tab and
//! the person panel's Companies tab.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    COMPANY_UPDATED, CONTACT_LINK_CREATED, CONTACT_LINK_DELETED, PERSON_UPDATED,
};
use weldsuite_crm_domain::date_or_null;
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::person_companies::{self as links, Column};

use crate::orm_rows::{json, timestamp_of};
use crate::schema::{Kind, OPT, REQ, Spec, partial, pick, s};
use crate::{Caller, CrmState, answer, validate_specs};

const LOG: &str = "person-companies";

/// `createPersonCompanySchema`.
const CREATE: [Spec; 6] = [
    Spec::new("personId", s(Some(1), None), REQ),
    Spec::new("companyId", s(Some(1), None), REQ),
    Spec::new("role", s(None, Some(50)), OPT),
    Spec::new("isPrimary", Kind::Bool, OPT).with_default("false"),
    Spec::new("startedAt", Kind::Datetime, OPT),
    Spec::new("endedAt", Kind::Datetime, OPT),
];

/// `publishBothSides`: both records changed.
fn publish_both_sides(caller: &Caller, state: &CrmState, person_id: &str, company_id: &str) {
    caller.publish(
        state,
        PERSON_UPDATED,
        person_id,
        &json!({ "id": person_id }),
    );
    caller.publish(
        state,
        COMPANY_UPDATED,
        company_id,
        &json!({ "id": company_id }),
    );
}

async fn link(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    let row = links::Entity::find_by_id(id.to_owned())
        .one(&orm(&caller.db))
        .await?;
    row.map(|row| json(serde_json::to_value(row))).transpose()
}

/// `date ? new Date(date) : null` as the `timestamp` Drizzle writes.
fn timestamp_or_null(date: &Value) -> Result<Option<time::PrimitiveDateTime>, DbErr> {
    date.as_str().map(timestamp_of).transpose()
}

/// The person's other links stop being their primary one.
async fn unset_other_primaries(caller: &Caller, person_id: &str, id: &str) -> Result<(), DbErr> {
    links::Entity::update_many()
        .col_expr(Column::IsPrimary, Expr::value(false))
        .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
        .filter(Column::PersonId.eq(person_id))
        .filter(Column::Id.ne(id))
        .exec(&orm(&caller.db))
        .await?;
    Ok(())
}

fn text<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str)
}

pub(crate) async fn create(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate_specs(&headers, &body, &CREATE) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let id = generate_id("pc");
        let now = utc_now();
        let person_id = text(&data, "personId").unwrap_or_default();
        let company_id = text(&data, "companyId").unwrap_or_default();
        let is_primary = data.get("isPrimary").and_then(Value::as_bool).unwrap_or(false);
        let started = date_or_null(data.get("startedAt"))?;
        let ended = date_or_null(data.get("endedAt"))?;
        links::Entity::insert(links::ActiveModel {
            id: Set(id.clone()),
            created_at: Set(now),
            updated_at: Set(now),
            person_id: Set(person_id.to_owned()),
            company_id: Set(company_id.to_owned()),
            role: Set(text(&data, "role").map(str::to_owned)),
            is_primary: Set(is_primary),
            started_at: Set(timestamp_or_null(&started)?),
            ended_at: Set(timestamp_or_null(&ended)?),
        })
        .exec_without_returning(&orm(&caller.db))
        .await?;
        if is_primary {
            links::Entity::update_many()
                .col_expr(Column::IsPrimary, Expr::value(false))
                .col_expr(Column::UpdatedAt, Expr::value(now))
                .filter(Column::PersonId.eq(person_id))
                .filter(Column::Id.ne(id.as_str()))
                .exec(&orm(&caller.db))
                .await?;
        }
        let row = link(&caller, &id).await?;
        caller.publish(
            &state,
            CONTACT_LINK_CREATED,
            &id,
            &json!({ "id": id, "personId": person_id, "companyId": company_id }),
        );
        publish_both_sides(&caller, &state, person_id, company_id);
        Ok(Created(row.unwrap_or(Value::Null)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to link person to company")
}

pub(crate) async fn update(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let schema = partial(&pick(
        &CREATE,
        &["role", "isPrimary", "startedAt", "endedAt"],
    ));
    let data = match validate_specs(&headers, &body, &schema) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let Some(existing) = link(&caller, &id).await? else {
            return Ok(ApiError::not_found("PersonCompany", Some(&id)).into_response());
        };
        let started = timestamp_or_null(&date_or_null(data.get("startedAt"))?)?;
        let ended = timestamp_or_null(&date_or_null(data.get("endedAt"))?)?;
        // Only the fields the body sent change.
        let mut update = links::Entity::update_many()
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()));
        if data.contains_key("role") {
            update = update.col_expr(
                Column::Role,
                Expr::value(text(&data, "role").map(str::to_owned)),
            );
        }
        if data.contains_key("isPrimary") {
            update = update.col_expr(
                Column::IsPrimary,
                Expr::value(
                    data.get("isPrimary")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                ),
            );
        }
        if data.contains_key("startedAt") {
            update = update.col_expr(Column::StartedAt, Expr::value(started));
        }
        if data.contains_key("endedAt") {
            update = update.col_expr(Column::EndedAt, Expr::value(ended));
        }
        update
            .filter(Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
            .await?;
        let person_id = existing
            .get("personId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let company_id = existing
            .get("companyId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if data.get("isPrimary") == Some(&Value::Bool(true)) {
            unset_other_primaries(&caller, person_id, &id).await?;
        }
        let updated = link(&caller, &id).await?;
        publish_both_sides(&caller, &state, person_id, company_id);
        Ok(Data(updated.unwrap_or(Value::Null)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to update affiliation")
}

pub(crate) async fn remove(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = link(&caller, &id).await? else {
            return Ok(ApiError::not_found("PersonCompany", Some(&id)).into_response());
        };
        links::Entity::delete_many()
            .filter(Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
            .await?;
        let person_id = existing
            .get("personId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let company_id = existing
            .get("companyId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        caller.publish(
            &state,
            CONTACT_LINK_DELETED,
            &id,
            &json!({ "id": id, "personId": person_id, "companyId": company_id }),
        );
        publish_both_sides(&caller, &state, person_id, company_id);
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, LOG, "Failed to unlink")
}
