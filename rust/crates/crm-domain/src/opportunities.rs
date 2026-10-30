//! Opportunities (`@weldsuite/crm-domain/opportunities`): deals in
//! `crm_opportunities`, and the pipeline-stage rules that keep a deal's
//! status, close date and probability in step with its stage. Shared by
//! crm-api's routes and WeldConnect's `create_deal` / `move_deal_stage`
//! steps.

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;

use crate::tables::CRM_OPPORTUNITIES;
use crate::{DomainError, DomainResult, drizzle_row, insert_sql, now, to_iso};

/// A deal as Drizzle reads it: `to_jsonb` with the numeric columns as text.
#[macro_export]
macro_rules! opportunity_json {
    ($t:literal) => {
        concat!(
            "(to_jsonb(",
            $t,
            ") || jsonb_build_object('amount', ",
            $t,
            ".amount::text, ",
            "'expected_revenue', ",
            $t,
            ".expected_revenue::text, ",
            "'recurring_revenue', ",
            $t,
            ".recurring_revenue::text))"
        )
    };
}

/// `lookupCompanyName(db, customerId)`: the live company's name.
pub async fn lookup_company_name(
    db: &PgPool,
    customer_id: Option<&str>,
) -> DomainResult<Option<String>> {
    let Some(customer_id) = customer_id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let name: Option<String> = sqlx::query_scalar(
        "select name from companies where id = $1 and deleted_at is null limit 1",
    )
    .bind(customer_id)
    .fetch_optional(db)
    .await?;
    Ok(name)
}

/// A stage's flags (`PipelineStageFlags`).
#[derive(Debug, Clone)]
pub struct StageFlags {
    pub id: String,
    pub is_won: Option<bool>,
    pub is_lost: Option<bool>,
    pub probability: Option<i32>,
    pub pipeline: Option<String>,
}

impl StageFlags {
    fn closed(&self) -> bool {
        self.is_won == Some(true) || self.is_lost == Some(true)
    }
}

type StageRow = (
    String,
    Option<bool>,
    Option<bool>,
    Option<i32>,
    Option<String>,
);

fn stage_of(row: StageRow) -> StageFlags {
    StageFlags {
        id: row.0,
        is_won: row.1,
        is_lost: row.2,
        probability: row.3,
        pipeline: row.4,
    }
}

/// `loadStage(db, stageId)`: a live stage.
pub async fn load_stage(db: &PgPool, stage_id: &str) -> DomainResult<Option<StageFlags>> {
    let row: Option<StageRow> = sqlx::query_as(
        "select id, is_won, is_lost, probability, pipeline from crm_pipeline_stages
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(stage_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(stage_of))
}

/// `findFirstOpenStage(db, pipeline)`: the lowest live stage that is
/// neither won nor lost.
async fn first_open_stage(db: &PgPool, pipeline: &str) -> DomainResult<Option<StageFlags>> {
    let row: Option<StageRow> = sqlx::query_as(
        "select id, is_won, is_lost, probability, pipeline from crm_pipeline_stages
         where pipeline = $1 and (is_won is null or is_won = false)
           and (is_lost is null or is_lost = false) and deleted_at is null
         order by position asc, created_at asc limit 1",
    )
    .bind(pipeline)
    .fetch_optional(db)
    .await?;
    Ok(row.map(stage_of))
}

/// `String(value)` of an amount (a string or a number).
fn amount_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number
            .as_f64()
            .map_or_else(|| number.to_string(), crate::js::number_text),
        other => other.to_string(),
    }
}

/// What `createOpportunity` answers.
#[derive(Debug, Clone)]
pub struct CreatedOpportunity {
    pub id: String,
    pub row: Map<String, Value>,
    pub event_data: Value,
}

/// `createOpportunity(db, input, actingUserId)`.
#[allow(clippy::too_many_lines)] // one block per column, as the TypeScript lists them
pub async fn create_opportunity(
    db: &PgPool,
    input: &Map<String, Value>,
    acting_user_id: Option<&str>,
) -> DomainResult<CreatedOpportunity> {
    let owner_id = match input.get("ownerId") {
        Some(Value::String(owner)) => Some(owner.clone()),
        _ => acting_user_id.map(str::to_owned),
    }
    .filter(|owner| !owner.is_empty())
    .ok_or_else(|| DomainError::Other("ownerId required".to_owned()))?;
    let id = generate_id("opp");
    let now = now();
    let text = |key: &str| input.get(key).and_then(Value::as_str);
    let close_date = match text("closeDate") {
        Some(date) if !date.is_empty() => Value::String(to_iso(date)?),
        _ => Value::Null,
    };
    let customer_name = lookup_company_name(db, text("customerId")).await?;
    let mut probability = input.get("probability").cloned();
    if probability.is_none()
        && let Some(stage_id) = text("stageId").filter(|s| !s.is_empty())
        && let Some(stage) = load_stage(db, stage_id).await?
        && let Some(stage_probability) = stage.probability
    {
        probability = Some(json!(stage_probability));
    }
    let mut values = Map::new();
    let mut set = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            values.insert(key.to_owned(), value);
        }
    };
    let copy = |key: &str| input.get(key).cloned();
    set("id", Some(json!(id)));
    set("name", copy("name"));
    set("description", copy("description"));
    set("customerId", copy("customerId"));
    set("customerName", customer_name.map(Value::String));
    set("primaryContactId", copy("primaryContactId"));
    set(
        "amount",
        Some(
            input
                .get("amount")
                .map_or(json!("0"), |a| json!(amount_text(a))),
        ),
    );
    set(
        "currency",
        Some(match input.get("currency") {
            Some(Value::String(c)) if !c.is_empty() => json!(c),
            _ => json!("EUR"),
        }),
    );
    set(
        "expectedRevenue",
        input.get("expectedRevenue").map(|a| json!(amount_text(a))),
    );
    set(
        "recurringRevenue",
        input.get("recurringRevenue").map(|a| json!(amount_text(a))),
    );
    set("contractLength", copy("contractLength"));
    set("stage", Some(copy("stage").unwrap_or(json!("prospecting"))));
    set("stageId", copy("stageId"));
    set("status", Some(copy("status").unwrap_or(json!("open"))));
    set(
        "probability",
        Some(probability.filter(|p| !p.is_null()).unwrap_or(json!(0))),
    );
    set(
        "pipeline",
        Some(copy("pipeline").unwrap_or(json!("default"))),
    );
    set("closeDate", Some(close_date));
    if let Some(start) = text("startDate").filter(|d| !d.is_empty()) {
        set("startDate", Some(Value::String(to_iso(start)?)));
    }
    set("ownerId", Some(json!(owner_id)));
    for key in [
        "teamMembers",
        "leadSource",
        "campaign",
        "type",
        "category",
        "nextStep",
    ] {
        set(key, copy(key));
    }
    if let Some(date) = text("nextStepDate").filter(|d| !d.is_empty()) {
        set("nextStepDate", Some(Value::String(to_iso(date)?)));
    }
    for key in [
        "riskLevel",
        "riskReason",
        "proposalUrl",
        "contractUrl",
        "tags",
        "customFields",
    ] {
        set(key, copy(key));
    }
    set("createdAt", Some(json!(now)));
    set("updatedAt", Some(json!(now)));
    sqlx::query(insert_sql!(crm_opportunities))
        .bind(CRM_OPPORTUNITIES.values(&values))
        .execute(db)
        .await?;
    let mut event = Map::new();
    event.insert("id".into(), json!(id));
    for (to, from) in [
        ("name", "name"),
        ("amount", "amount"),
        ("stage", "stage"),
        ("status", "status"),
        ("currency", "currency"),
        ("customerId", "customerId"),
        ("pipelineId", "pipeline"),
        ("ownerId", "ownerId"),
    ] {
        if let Some(value) = values.get(from) {
            event.insert(to.into(), value.clone());
        }
    }
    Ok(CreatedOpportunity {
        id,
        row: values,
        event_data: Value::Object(event),
    })
}

/// `toColumnValue(key, value)`: numerics as strings, dates as `Date`s (an
/// empty date clears the column).
pub fn to_column_value(key: &str, value: &Value) -> DomainResult<Value> {
    match (key, value) {
        ("amount" | "expectedRevenue" | "recurringRevenue", Value::Number(_)) => {
            Ok(json!(amount_text(value)))
        }
        ("closeDate" | "startDate" | "nextStepDate", Value::String(text)) => {
            if text.is_empty() {
                Ok(Value::Null)
            } else {
                Ok(Value::String(to_iso(text)?))
            }
        }
        _ => Ok(value.clone()),
    }
}

/// `buildUpdatePayload(data)`: the `set` of a PATCH (`updatedAt` first).
pub fn build_update_payload(data: &Map<String, Value>) -> DomainResult<Map<String, Value>> {
    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now()));
    for (key, value) in data {
        update.insert(key.clone(), to_column_value(key, value)?);
    }
    if update.get("currency") == Some(&json!("")) {
        update.remove("currency");
    }
    Ok(update)
}

/// `a ?? b` over JSON: `b` when `a` is absent or `null`.
fn coalesce<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Value {
    match a {
        Some(value) if !value.is_null() => value.clone(),
        _ => b.cloned().unwrap_or(Value::Null),
    }
}

/// One event `opportunityUpdateEvents` derives: its action and data.
#[derive(Debug, Clone)]
pub struct UpdateEvent {
    /// `updated`, `stage_changed`, `won` or `lost`.
    pub action: &'static str,
    pub data: Value,
}

/// `opportunityUpdateEvents(id, existing, update)`: `updated`, plus
/// `stage_changed`, `won` or `lost` when the PATCH did that.
pub fn opportunity_update_events(
    id: &str,
    existing: &Value,
    update: &Map<String, Value>,
) -> Vec<UpdateEvent> {
    let new_stage = coalesce(update.get("stage"), existing.get("stage"));
    let new_stage_id = coalesce(update.get("stageId"), existing.get("stageId"));
    let new_status = coalesce(update.get("status"), existing.get("status"));
    let amount = match update.get("amount") {
        Some(value) if !value.is_null() => value.clone(),
        _ => match existing.get("amount") {
            Some(value) if !value.is_null() => value.clone(),
            _ => json!("0"),
        },
    };
    let data = json!({
        "id": id,
        "name": coalesce(update.get("name"), existing.get("name")),
        "amount": amount,
        "stage": new_stage,
        "stageId": new_stage_id,
        "status": new_status,
        "customerId": coalesce(update.get("customerId"), existing.get("customerId")),
        "ownerId": coalesce(update.get("ownerId"), existing.get("ownerId")),
    });
    let mut events = vec![UpdateEvent {
        action: "updated",
        data: data.clone(),
    }];
    let old_stage = existing.get("stage").cloned().unwrap_or(Value::Null);
    let old_stage_id = existing.get("stageId").cloned().unwrap_or(Value::Null);
    if new_stage != old_stage || new_stage_id != old_stage_id {
        events.push(UpdateEvent {
            action: "stage_changed",
            data: data.clone(),
        });
    }
    let old_status = existing.get("status").cloned().unwrap_or(Value::Null);
    if new_status == json!("won") && old_status != json!("won") {
        events.push(UpdateEvent {
            action: "won",
            data,
        });
    } else if new_status == json!("lost") && old_status != json!("lost") {
        events.push(UpdateEvent {
            action: "lost",
            data,
        });
    }
    events
}

#[allow(clippy::too_many_lines)] // both directions of the sync, as TypeScript has them
/// `syncStatusWithStage(db, existing, data, update, targetStage)`: keep
/// `status`, `actualCloseDate` and `probability` in step with the stage,
/// whichever side of the move started it. Changes `update` in place.
pub async fn sync_status_with_stage(
    db: &PgPool,
    existing: &Value,
    data: &Map<String, Value>,
    update: &mut Map<String, Value>,
    target_stage: Option<&StageFlags>,
) -> DomainResult<()> {
    let existing_status = existing.get("status").and_then(Value::as_str);
    let existing_closed_at = existing
        .get("actualCloseDate")
        .is_some_and(|value| !value.is_null());
    let existing_stage_id = existing
        .get("stageId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());

    if let Some(target) = target_stage {
        if target.closed() {
            if !update.contains_key("status") {
                let status = if target.is_won == Some(true) {
                    "won"
                } else {
                    "lost"
                };
                update.insert("status".into(), json!(status));
            }
            if !update.contains_key("actualCloseDate") && !existing_closed_at {
                update.insert("actualCloseDate".into(), json!(now()));
            }
            if !update.contains_key("probability")
                && let Some(probability) = target.probability
            {
                update.insert("probability".into(), json!(probability));
            }
        } else {
            let previous = match existing_stage_id {
                Some(stage_id) => load_stage(db, stage_id).await?,
                None => None,
            };
            let was_closed = matches!(existing_status, Some("won" | "lost"))
                || previous.as_ref().is_some_and(StageFlags::closed);
            let status = update.get("status");
            if was_closed && (status.is_none() || status == Some(&json!("open"))) {
                update.insert("status".into(), json!("open"));
                if !update.contains_key("actualCloseDate") {
                    update.insert("actualCloseDate".into(), Value::Null);
                }
                if !update.contains_key("probability")
                    && let Some(probability) = target.probability
                {
                    update.insert("probability".into(), json!(probability));
                }
            }
        }
        return Ok(());
    }

    let Some(explicit) = data.get("status").and_then(Value::as_str) else {
        return Ok(());
    };
    if explicit.is_empty() || Some(explicit) == existing_status {
        return Ok(());
    }
    let existing_pipeline = existing
        .get("pipeline")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty());
    let update_pipeline = update
        .get("pipeline")
        .and_then(Value::as_str)
        .map(str::to_owned);
    match explicit {
        "won" | "lost" => {
            if !update.contains_key("actualCloseDate") && !existing_closed_at {
                update.insert("actualCloseDate".into(), json!(now()));
            }
            if !update.contains_key("stageId") {
                let pipeline = update_pipeline
                    .or_else(|| existing_pipeline.map(str::to_owned))
                    .unwrap_or_else(|| "default".to_owned());
                let matched: Option<(String, Option<i32>)> = sqlx::query_as(
                    "select id, probability from crm_pipeline_stages
                     where pipeline = $1
                       and (case when $2 then is_won else is_lost end) = true
                       and deleted_at is null
                     limit 1",
                )
                .bind(&pipeline)
                .bind(explicit == "won")
                .fetch_optional(db)
                .await?;
                if let Some((stage_id, probability)) = matched {
                    update.insert("stageId".into(), json!(stage_id));
                    if !data.contains_key("stage") {
                        update.insert("stage".into(), json!(stage_id));
                    }
                    if !update.contains_key("probability")
                        && let Some(probability) = probability
                    {
                        update.insert("probability".into(), json!(probability));
                    }
                }
            }
        }
        "open" | "abandoned" => {
            let was_closed = matches!(existing_status, Some("won" | "lost"));
            if was_closed && !update.contains_key("actualCloseDate") {
                update.insert("actualCloseDate".into(), Value::Null);
            }
            if explicit == "open" && was_closed && !update.contains_key("stageId") {
                let current = match existing_stage_id {
                    Some(stage_id) => load_stage(db, stage_id).await?,
                    None => None,
                };
                if current.as_ref().is_none_or(StageFlags::closed) {
                    let pipeline = current
                        .as_ref()
                        .and_then(|stage| stage.pipeline.clone())
                        .or(update_pipeline)
                        .or_else(|| existing_pipeline.map(str::to_owned))
                        .unwrap_or_else(|| "default".to_owned());
                    if let Some(open) = first_open_stage(db, &pipeline).await? {
                        update.insert("stageId".into(), json!(open.id));
                        if !data.contains_key("stage") {
                            update.insert("stage".into(), json!(open.id));
                        }
                        if !update.contains_key("probability")
                            && let Some(probability) = open.probability
                        {
                            update.insert("probability".into(), json!(probability));
                        }
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// A live deal as Drizzle reads it, within the owner scope.
pub async fn live_opportunity(
    db: &PgPool,
    id: &str,
    owner_scope: Option<&str>,
) -> DomainResult<Option<Value>> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        opportunity_json!("t"),
        " from crm_opportunities t
         where id = $1 and deleted_at is null and ($2::text is null or owner_id = $2) limit 1"
    ))
    .bind(id)
    .bind(owner_scope)
    .fetch_optional(db)
    .await?;
    Ok(row.map(drizzle_row))
}
