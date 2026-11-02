//! `/api/person-companies` (`routes/person-companies/index.ts`): the
//! person ↔ company link table, used by the company panel's People tab and
//! the person panel's Companies tab.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    COMPANY_UPDATED, CONTACT_LINK_CREATED, CONTACT_LINK_DELETED, PERSON_UPDATED,
};
use weldsuite_crm_domain::{date_or_null, drizzle_row};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};

use crate::schema::{Kind, OPT, REQ, Spec, partial, pick, s};
use crate::{Caller, CrmState, answer, now, validate_specs};

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

async fn link(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from person_companies t where id = $1 limit 1")
            .bind(id)
            .fetch_optional(&caller.db)
            .await?;
    Ok(row.map(drizzle_row))
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
        let now = now();
        let person_id = text(&data, "personId").unwrap_or_default();
        let company_id = text(&data, "companyId").unwrap_or_default();
        let is_primary = data.get("isPrimary").and_then(Value::as_bool).unwrap_or(false);
        let started = date_or_null(data.get("startedAt"))?;
        let ended = date_or_null(data.get("endedAt"))?;
        sqlx::query(
            "insert into person_companies
                 (id, created_at, updated_at, person_id, company_id, role, is_primary, started_at, ended_at)
             values ($1, $2::timestamp, $2::timestamp, $3, $4, $5, $6, $7::timestamp, $8::timestamp)",
        )
        .bind(&id)
        .bind(&now)
        .bind(person_id)
        .bind(company_id)
        .bind(text(&data, "role"))
        .bind(is_primary)
        .bind(started.as_str())
        .bind(ended.as_str())
        .execute(&caller.db)
        .await?;
        if is_primary {
            sqlx::query(
                "update person_companies set is_primary = false, updated_at = $3::timestamp
                 where person_id = $1 and id <> $2",
            )
            .bind(person_id)
            .bind(&id)
            .bind(&now)
            .execute(&caller.db)
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
        let started = date_or_null(data.get("startedAt"))?;
        let ended = date_or_null(data.get("endedAt"))?;
        sqlx::query(
            "update person_companies set
                 updated_at = $2::timestamp,
                 role = case when $3 then $4 else role end,
                 is_primary = case when $5 then $6 else is_primary end,
                 started_at = case when $7 then $8::timestamp else started_at end,
                 ended_at = case when $9 then $10::timestamp else ended_at end
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(data.contains_key("role"))
        .bind(text(&data, "role"))
        .bind(data.contains_key("isPrimary"))
        .bind(
            data.get("isPrimary")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )
        .bind(data.contains_key("startedAt"))
        .bind(started.as_str())
        .bind(data.contains_key("endedAt"))
        .bind(ended.as_str())
        .execute(&caller.db)
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
            sqlx::query(
                "update person_companies set is_primary = false, updated_at = $3::timestamp
                 where person_id = $1 and id <> $2",
            )
            .bind(person_id)
            .bind(&id)
            .bind(now())
            .execute(&caller.db)
            .await?;
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
        sqlx::query("delete from person_companies where id = $1")
            .bind(&id)
            .execute(&caller.db)
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
