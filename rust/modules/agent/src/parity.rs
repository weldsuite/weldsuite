//! Skills, routines, memories, templates, teach sessions and connector events
//! (`apps/workers/agent-api/src/routes/weldagent/parity.ts`,
//! `packages/domains/agent/src/parity.ts`,
//! `@weldsuite/app-api-client/schemas/weldagent-parity`). Approvals are in
//! [`crate::approvals`].

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, FromQueryResult, JoinType, QueryFilter,
    QueryOrder, QuerySelect, RelationDef,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_db::orm;
use weldsuite_kit::validation::{Field, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::weldagent_agent_skills::{self as links, Column as Link};
use weldsuite_schema::tenant::weldagent_memories::{self as memories, Column as Memory};
use weldsuite_schema::tenant::weldagent_skills::{self as skills, Column as Skill};
use weldsuite_schema::tenant::weldagent_teach_sessions::{self as teach, Column as Teach};
use weldsuite_schema::tenant::weldagent_templates::{self as templates, Column as Template};

use crate::agent_routes::{Mode, agent_guard, cannot_grant, ungrantable};
use crate::agents::{CreateAgent, UpdateAgent, create_agent, get_agent, js, now_tz, update_agent};
use crate::routines::{
    NewRoutine, create_routine, create_routine_run, delete_routine, find_connector_routines,
    get_routine, list_routine_runs, list_routines, mark_routine_scheduled, reindex_workspace,
    update_routine,
};
use crate::run::{RunParams, TriggerType, run_agent};
use crate::{AgentState, Caller, failed, validate};

const CONTEXT: &str = "weldagent/parity";

fn not_found(what: &str) -> Response {
    ApiError::not_found(what, None).into_response()
}

fn pick(row: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keys {
        out.insert(
            (*key).to_owned(),
            row.get(*key).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(out)
}

// ── Skills ──────────────────────────────────────────────────────────────────

const SKILL_KEYS: [&str; 10] = [
    "id",
    "name",
    "description",
    "instructions",
    "status",
    "steps",
    "createdBy",
    "sourceAgentId",
    "createdAt",
    "updatedAt",
];

fn skill_row(skill: skills::Model) -> Value {
    let mut out = pick(&js(skill), &SKILL_KEYS);
    if out["steps"].is_null() {
        out["steps"] = json!([]);
    }
    out
}

async fn get_skill(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    Ok(skills::Entity::find_by_id(id.to_owned())
        .filter(Skill::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(skill_row))
}

/// `join weldagent_agent_skills l on s.id = l.skill_id`: a skill's links to
/// agents.
fn skill_links() -> RelationDef {
    skills::Entity::belongs_to(links::Entity)
        .from(Skill::Id)
        .to(Link::SkillId)
        .into()
}

/// `createSkill`.
async fn create_skill(
    db: &PgPool,
    name: &str,
    description: Option<&str>,
    instructions: &str,
    steps: &Value,
    status: &str,
    created_by: Option<&str>,
    source_agent_id: Option<&str>,
) -> Result<Value, DbErr> {
    let id = generate_id("skl");
    skills::Entity::insert(skills::ActiveModel {
        id: Set(id.clone()),
        name: Set(name.trim().to_owned()),
        description: Set(description.map(str::to_owned)),
        instructions: Set(instructions.trim().to_owned()),
        steps: Set(steps.clone()),
        status: Set(status.to_owned()),
        created_by: Set(created_by.map(str::to_owned)),
        source_agent_id: Set(source_agent_id.map(str::to_owned)),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    Ok(get_skill(db, &id).await?.unwrap_or(Value::Null))
}

/// `enableSkillForAgent`: an existing link is switched on, else created.
async fn enable_skill_for_agent(
    db: &PgPool,
    agent_id: &str,
    skill_id: &str,
) -> Result<Option<Value>, DbErr> {
    let Some(skill) = get_skill(db, skill_id).await? else {
        return Ok(None);
    };
    let conn = orm(db);
    let relinked = links::Entity::update_many()
        .col_expr(Link::Enabled, Expr::value(true))
        .filter(Link::AgentId.eq(agent_id))
        .filter(Link::SkillId.eq(skill_id))
        .exec(&conn)
        .await?;
    if relinked.rows_affected == 0 {
        links::Entity::insert(links::ActiveModel {
            id: Set(generate_id("asl")),
            agent_id: Set(agent_id.to_owned()),
            skill_id: Set(skill_id.to_owned()),
            enabled: Set(true),
            ..Default::default()
        })
        .exec_without_returning(&conn)
        .await?;
    }
    Ok(Some(skill))
}

struct SkillInput {
    name: Option<String>,
    description: Option<String>,
    instructions: Option<String>,
    steps: Option<Vec<Value>>,
    status: Option<String>,
}

fn skill_input(headers: &HeaderMap, body: &Bytes, partial: bool) -> Result<SkillInput, Response> {
    validate(headers, body, |issues, f| {
        let req = if partial {
            Presence::Optional
        } else {
            Presence::Required
        };
        SkillInput {
            name: issues
                .text(f, "name", req, Some(2), Some(255))
                .into_option(),
            description: issues
                .text(f, "description", Presence::Optional, None, Some(2000))
                .into_option(),
            instructions: issues
                .text(f, "instructions", req, Some(20), Some(20000))
                .into_option(),
            steps: issues.records(f, "steps", Presence::Optional).into_option(),
            status: issues
                .choice(
                    f,
                    "status",
                    Presence::Optional,
                    &["draft", "active", "archived"],
                )
                .into_option(),
        }
    })
}

#[derive(Deserialize)]
pub(crate) struct StatusQuery {
    status: Option<String>,
}

/// `GET /skills`.
pub(crate) async fn skills_list(caller: Caller, Query(query): Query<StatusQuery>) -> Response {
    let mut find = skills::Entity::find().filter(Skill::DeletedAt.is_null());
    if let Some(status) = query.status.as_deref().filter(|s| !s.is_empty()) {
        find = find.filter(Skill::Status.eq(status));
    }
    let rows = find
        .order_by_desc(Skill::UpdatedAt)
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(skill_row).collect::<Vec<_>>()).into_response(),
        Err(e) => failed(&e, CONTEXT, "Failed to list skills"),
    }
}

/// `POST /skills`.
pub(crate) async fn skills_create(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let data = match skill_input(&headers, &body, false) {
        Ok(d) => d,
        Err(r) => return r,
    };
    let steps = json!(data.steps.unwrap_or_default());
    match create_skill(
        &caller.db,
        data.name.as_deref().unwrap_or_default(),
        data.description.as_deref(),
        data.instructions.as_deref().unwrap_or_default(),
        &steps,
        data.status.as_deref().unwrap_or("draft"),
        Some(&caller.user_id),
        None,
    )
    .await
    {
        Ok(skill) => Created(skill).into_response(),
        Err(e) => failed(&e, CONTEXT, "Failed to create skill"),
    }
}

/// `PATCH /skills/:id`.
pub(crate) async fn skills_update(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match skill_input(&headers, &body, true) {
        Ok(d) => d,
        Err(r) => return r,
    };
    let result = async {
        if get_skill(&caller.db, &id).await?.is_none() {
            return Ok::<_, DbErr>(None);
        }
        // `coalesce($new, column)`: only what the body sent changes.
        let mut update =
            skills::Entity::update_many().col_expr(Skill::UpdatedAt, Expr::value(now_tz()));
        if let Some(name) = data.name.as_deref() {
            update = update.col_expr(Skill::Name, Expr::value(name.trim()));
        }
        if let Some(description) = data.description.as_deref() {
            update = update.col_expr(Skill::Description, Expr::value(description));
        }
        if let Some(instructions) = data.instructions.as_deref() {
            update = update.col_expr(Skill::Instructions, Expr::value(instructions.trim()));
        }
        if let Some(steps) = data.steps {
            update = update.col_expr(Skill::Steps, Expr::value(Value::Array(steps)));
        }
        if let Some(status) = data.status.as_deref() {
            update = update.col_expr(Skill::Status, Expr::value(status));
        }
        update
            .filter(Skill::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        get_skill(&caller.db, &id).await
    }
    .await;
    match result {
        Ok(Some(skill)) => Data(skill).into_response(),
        Ok(None) => not_found("Skill not found"),
        Err(e) => failed(&e, CONTEXT, "Failed to update skill"),
    }
}

/// `DELETE /skills/:id`.
pub(crate) async fn skills_delete(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        if get_skill(&caller.db, &id).await?.is_none() {
            return Ok::<_, DbErr>(false);
        }
        let now = now_tz();
        skills::Entity::update_many()
            .col_expr(Skill::DeletedAt, Expr::value(now))
            .col_expr(Skill::UpdatedAt, Expr::value(now))
            .filter(Skill::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        Ok(true)
    }
    .await;
    match result {
        Ok(true) => NoContent.into_response(),
        Ok(false) => not_found("Skill not found"),
        Err(e) => failed(&e, CONTEXT, "Failed to delete skill"),
    }
}

/// A skill with its link to one agent (`to_jsonb(s) || jsonb_build_object(
/// 'enabled', l.enabled, 'link_id', l.id)`).
#[derive(Debug, FromQueryResult)]
struct LinkedSkill {
    #[sea_orm(nested)]
    skill: skills::Model,
    link_enabled: bool,
    link_id: String,
}

/// `GET /agents/:id/skills`: the agent's skills with whether each is on.
pub(crate) async fn agent_skills(caller: Caller, Path(id): Path<String>) -> Response {
    if let Err(r) = agent_guard(&caller, &id, Mode::Access).await {
        return r;
    }
    let rows = skills::Entity::find()
        .join(JoinType::InnerJoin, skill_links())
        .column_as(Link::Enabled, "link_enabled")
        .column_as(Link::Id, "link_id")
        .filter(Link::AgentId.eq(&id))
        .filter(Skill::DeletedAt.is_null())
        .into_model::<LinkedSkill>()
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(rows) => Data(
            rows.into_iter()
                .map(|row| {
                    let mut out = skill_row(row.skill);
                    out["enabled"] = json!(row.link_enabled);
                    out["linkId"] = json!(row.link_id);
                    out
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => failed(&e, CONTEXT, "Failed to list the agent's skills"),
    }
}

/// `POST /agents/:id/skills/:skillId`.
pub(crate) async fn agent_skill_enable(
    caller: Caller,
    Path((id, skill_id)): Path<(String, String)>,
) -> Response {
    if let Err(r) = agent_guard(&caller, &id, Mode::Edit).await {
        return r;
    }
    match enable_skill_for_agent(&caller.db, &id, &skill_id).await {
        Ok(Some(skill)) => Data(skill).into_response(),
        Ok(None) => not_found("Skill not found"),
        Err(e) => failed(&e, CONTEXT, "Failed to enable the skill"),
    }
}

/// `DELETE /agents/:id/skills/:skillId`.
pub(crate) async fn agent_skill_disable(
    caller: Caller,
    Path((id, skill_id)): Path<(String, String)>,
) -> Response {
    if let Err(r) = agent_guard(&caller, &id, Mode::Edit).await {
        return r;
    }
    match links::Entity::update_many()
        .col_expr(Link::Enabled, Expr::value(false))
        .filter(Link::AgentId.eq(&id))
        .filter(Link::SkillId.eq(&skill_id))
        .exec(&orm(&caller.db))
        .await
    {
        Ok(_) => NoContent.into_response(),
        Err(e) => failed(&e, CONTEXT, "Failed to disable the skill"),
    }
}

// ── Routines ────────────────────────────────────────────────────────────────

const SCHEDULE_KINDS: [&str; 3] = ["cron", "event", "connector"];

/// `createRoutineSchema` (or its `.partial()` without `agentId`) as the keys
/// that were sent. A JSON `null` is kept where the schema allows it.
fn routine_body(
    headers: &HeaderMap,
    body: &Bytes,
    partial: bool,
) -> Result<Map<String, Value>, Response> {
    validate(headers, body, |issues, f| {
        let req = if partial {
            Presence::Optional
        } else {
            Presence::Required
        };
        let mut out = Map::new();
        let mut set = |key: &str, field: Field<String>| match field {
            Field::Set(v) => {
                out.insert(key.to_owned(), json!(v));
            }
            Field::Null => {
                out.insert(key.to_owned(), Value::Null);
            }
            Field::Absent => {}
        };
        if !partial {
            set(
                "agentId",
                issues.text(f, "agentId", Presence::Required, Some(1), Some(30)),
            );
        }
        set("name", issues.text(f, "name", req, Some(2), Some(255)));
        set(
            "instructions",
            issues.text(f, "instructions", req, Some(10), Some(20000)),
        );
        set(
            "skillId",
            issues.text(f, "skillId", Presence::Nullish, Some(1), Some(30)),
        );
        set(
            "scheduleKind",
            issues.choice(f, "scheduleKind", Presence::Optional, &SCHEDULE_KINDS),
        );
        set(
            "cronExpr",
            issues.text(f, "cronExpr", Presence::Nullish, None, Some(100)),
        );
        set(
            "timezone",
            issues.text(f, "timezone", Presence::Optional, None, Some(64)),
        );
        set(
            "eventKey",
            issues.text(f, "eventKey", Presence::Nullish, None, Some(100)),
        );
        match f.get("connectorConfig") {
            Some(Value::Null) => {
                out.insert("connectorConfig".into(), Value::Null);
            }
            Some(Value::Object(_)) => {
                let cfg = issues
                    .nested(f, "connectorConfig", Presence::Optional, |issues, c| {
                        let mut cfg = Map::new();
                        for (key, max) in [
                            ("channel", 200),
                            ("match", 500),
                            ("repo", 200),
                            ("event", 100),
                        ] {
                            if let Some(v) = issues
                                .text(c, key, Presence::Optional, None, Some(max))
                                .into_option()
                            {
                                cfg.insert(key.to_owned(), json!(v));
                            }
                        }
                        if let Some(v) = issues
                            .choice(c, "provider", Presence::Optional, &["slack", "github"])
                            .into_option()
                        {
                            cfg.insert("provider".to_owned(), json!(v));
                        }
                        Value::Object(cfg)
                    })
                    .into_option();
                if let Some(cfg) = cfg {
                    out.insert("connectorConfig".into(), cfg);
                }
            }
            Some(_) => {
                issues.custom("connectorConfig", "Expected object");
            }
            None => {}
        }
        for key in ["enabled", "requireApproval"] {
            if let Some(v) = issues.boolean(f, key, Presence::Optional).into_option() {
                out.insert(key.to_owned(), json!(v));
            }
        }
        out
    })
}

/// `GET /routines`: of one agent, or of the agents the caller can see.
pub(crate) async fn routines_list(caller: Caller, Query(query): Query<AgentQuery>) -> Response {
    let agent_id = query.agent_id.as_deref().filter(|a| !a.is_empty());
    if let Some(agent_id) = agent_id {
        if let Err(r) = agent_guard(&caller, agent_id, Mode::Access).await {
            return r;
        }
        return match list_routines(&caller.db, Some(agent_id)).await {
            Ok(rows) => Data(rows).into_response(),
            Err(e) => failed(&e, CONTEXT, "Failed to list routines"),
        };
    }
    let result = async {
        let visible = crate::agents::list_agents(&caller.db, None, &caller.viewer()).await?;
        let routines = list_routines(&caller.db, None).await?;
        Ok::<_, DbErr>(
            routines
                .into_iter()
                .filter(|r| visible.iter().any(|a| a["id"] == r["agentId"]))
                .collect::<Vec<_>>(),
        )
    }
    .await;
    match result {
        Ok(rows) => Data(rows).into_response(),
        Err(e) => failed(&e, CONTEXT, "Failed to list routines"),
    }
}

#[derive(Deserialize)]
pub(crate) struct AgentQuery {
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
}

fn str_of(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// `POST /routines`.
pub(crate) async fn routines_create(
    State(state): State<AgentState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match routine_body(&headers, &body, false) {
        Ok(d) => d,
        Err(r) => return r,
    };
    let agent_id = str_of(&data, "agentId").unwrap_or_default();
    if let Err(r) = agent_guard(&caller, &agent_id, Mode::Edit).await {
        return r;
    }
    let routine = create_routine(
        &caller.db,
        NewRoutine {
            agent_id,
            name: str_of(&data, "name").unwrap_or_default(),
            instructions: str_of(&data, "instructions").unwrap_or_default(),
            skill_id: str_of(&data, "skillId"),
            schedule_kind: str_of(&data, "scheduleKind"),
            cron_expr: str_of(&data, "cronExpr"),
            timezone: str_of(&data, "timezone"),
            event_key: str_of(&data, "eventKey"),
            connector_config: data
                .get("connectorConfig")
                .filter(|c| !c.is_null())
                .cloned(),
            enabled: data.get("enabled").and_then(Value::as_bool),
            require_approval: data.get("requireApproval").and_then(Value::as_bool),
            created_by: Some(caller.user_id.clone()),
        },
    )
    .await;
    match routine {
        Ok(routine) => {
            reindex_workspace(state.master.as_ref(), &caller.db, &caller.workspace_id).await;
            Created(routine).into_response()
        }
        Err(e) => failed(&e, CONTEXT, "Failed to create the routine"),
    }
}

/// `PATCH /routines/:id`.
pub(crate) async fn routines_update(
    State(state): State<AgentState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match routine_body(&headers, &body, true) {
        Ok(d) => d,
        Err(r) => return r,
    };
    let existing = match get_routine(&caller.db, &id).await {
        Ok(Some(r)) => r,
        Ok(None) => return not_found("Routine not found"),
        Err(e) => return failed(&e, CONTEXT, "Failed to update the routine"),
    };
    if let Err(r) = agent_guard(
        &caller,
        existing["agentId"].as_str().unwrap_or_default(),
        Mode::Edit,
    )
    .await
    {
        return r;
    }
    match update_routine(&caller.db, &id, &data).await {
        Ok(Some(routine)) => {
            reindex_workspace(state.master.as_ref(), &caller.db, &caller.workspace_id).await;
            Data(routine).into_response()
        }
        Ok(None) => not_found("Routine not found"),
        Err(e) => failed(&e, CONTEXT, "Failed to update the routine"),
    }
}

/// `DELETE /routines/:id`.
pub(crate) async fn routines_delete(
    State(state): State<AgentState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let existing = match get_routine(&caller.db, &id).await {
        Ok(Some(r)) => r,
        Ok(None) => return not_found("Routine not found"),
        Err(e) => return failed(&e, CONTEXT, "Failed to delete the routine"),
    };
    if let Err(r) = agent_guard(
        &caller,
        existing["agentId"].as_str().unwrap_or_default(),
        Mode::Edit,
    )
    .await
    {
        return r;
    }
    match delete_routine(&caller.db, &id).await {
        Ok(true) => {
            reindex_workspace(state.master.as_ref(), &caller.db, &caller.workspace_id).await;
            NoContent.into_response()
        }
        Ok(false) => not_found("Routine not found"),
        Err(e) => failed(&e, CONTEXT, "Failed to delete the routine"),
    }
}

/// `GET /routines/:id/runs`.
pub(crate) async fn routines_runs(caller: Caller, Path(id): Path<String>) -> Response {
    let routine = match get_routine(&caller.db, &id).await {
        Ok(Some(r)) => r,
        Ok(None) => return not_found("Routine not found"),
        Err(e) => return failed(&e, CONTEXT, "Failed to list the routine's runs"),
    };
    if let Err(r) = agent_guard(
        &caller,
        routine["agentId"].as_str().unwrap_or_default(),
        Mode::Access,
    )
    .await
    {
        return r;
    }
    match list_routine_runs(&caller.db, &id, 20).await {
        Ok(rows) => Data(rows).into_response(),
        Err(e) => failed(&e, CONTEXT, "Failed to list the routine's runs"),
    }
}

fn routine_message(routine: &Value, test: bool) -> (String, Option<String>) {
    if test {
        (
            format!(
                "Run routine \"{}\" as a test.\n\n{}",
                routine["name"].as_str().unwrap_or_default(),
                routine["instructions"].as_str().unwrap_or_default()
            ),
            Some(
                "This is a routine test run. Prefer draft/recommend over irreversible actions."
                    .to_owned(),
            ),
        )
    } else {
        (String::new(), None)
    }
}

/// `POST /routines/:id/test`: a test run is a full agent run and can outlive
/// the request: it runs in the background and lands on the routine run row.
pub(crate) async fn routines_test(
    State(state): State<AgentState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let routine = match get_routine(&caller.db, &id).await {
        Ok(Some(r)) => r,
        Ok(None) => return not_found("Routine not found"),
        Err(e) => return failed(&e, CONTEXT, "Failed to test the routine"),
    };
    let agent_id = routine["agentId"].as_str().unwrap_or_default().to_owned();
    if let Err(r) = agent_guard(&caller, &agent_id, Mode::Edit).await {
        return r;
    }
    let run_id = match create_routine_run(&caller.db, &id, &agent_id, "test").await {
        Ok(id) => id,
        Err(e) => return failed(&e, CONTEXT, "Failed to test the routine"),
    };
    let (user_message, extra_system) = routine_message(&routine, true);
    let params = RunParams {
        db: caller.db.clone(),
        workspace_id: caller.workspace_id.clone(),
        actor_user_id: caller.user_id.clone(),
        agent_id,
        trigger_type: TriggerType::Manual,
        trigger_data: Some(json!({ "routineId": id, "test": true })),
        user_message,
        extra_system,
        run_id: None,
        routine_run_id: Some(run_id.clone()),
        skip_approvals: routine["requireApproval"] != json!(true),
        notify: true,
        actor_permissions: None,
        events: None,
        env: state.run_env(),
    };
    let ai = caller.ai(&state);
    tokio::spawn(async move {
        if let Err(error) = run_agent(ai.as_ref(), params).await {
            tracing::warn!(?error, "[weldagent/routines] the test run could not start");
        }
    });
    Data(json!({ "queued": true, "runId": run_id })).into_response()
}

// ── Memories ────────────────────────────────────────────────────────────────

const MEMORY_KINDS: [&str; 4] = ["preference", "fact", "summary", "correction"];
const MEMORY_KEYS: [&str; 8] = [
    "id",
    "agentId",
    "kind",
    "content",
    "source",
    "createdBy",
    "createdAt",
    "updatedAt",
];

async fn get_memory(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    Ok(memories::Entity::find_by_id(id.to_owned())
        .filter(Memory::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(|m| pick(&js(m), &MEMORY_KEYS)))
}

/// `select … from weldagent_memories where agent_id = $1 and deleted_at is
/// null order by updated_at desc limit 100`.
async fn agent_memories(db: &PgPool, agent_id: &str) -> Result<Vec<Value>, DbErr> {
    Ok(memories::Entity::find()
        .filter(Memory::AgentId.eq(agent_id))
        .filter(Memory::DeletedAt.is_null())
        .order_by_desc(Memory::UpdatedAt)
        .limit(100)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(js)
        .collect())
}

async fn create_memory(
    db: &PgPool,
    agent_id: &str,
    kind: &str,
    content: &str,
    source: Option<&str>,
    created_by: Option<&str>,
) -> Result<Value, DbErr> {
    let id = generate_id("mem");
    memories::Entity::insert(memories::ActiveModel {
        id: Set(id.clone()),
        agent_id: Set(agent_id.to_owned()),
        kind: Set(kind.to_owned()),
        content: Set(content.trim().to_owned()),
        source: Set(source.map(str::to_owned)),
        created_by: Set(created_by.map(str::to_owned)),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    Ok(get_memory(db, &id).await?.unwrap_or(Value::Null))
}

/// `GET /agents/:id/memories`.
pub(crate) async fn memories_list(caller: Caller, Path(id): Path<String>) -> Response {
    if let Err(r) = agent_guard(&caller, &id, Mode::Access).await {
        return r;
    }
    match agent_memories(&caller.db, &id).await {
        Ok(rows) => Data(
            rows.iter()
                .map(|r| pick(r, &MEMORY_KEYS))
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => failed(&e, CONTEXT, "Failed to list memories"),
    }
}

/// `POST /memories`.
pub(crate) async fn memories_create(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let data = match validate(&headers, &body, |issues, f| {
        (
            issues
                .text(f, "agentId", Presence::Required, Some(1), Some(30))
                .into_option()
                .unwrap_or_default(),
            issues
                .choice(f, "kind", Presence::Optional, &MEMORY_KINDS)
                .into_option()
                .unwrap_or_else(|| "fact".to_owned()),
            issues
                .text(f, "content", Presence::Required, Some(1), Some(5000))
                .into_option()
                .unwrap_or_default(),
            issues
                .text(f, "source", Presence::Optional, None, Some(100))
                .into_option(),
        )
    }) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if let Err(r) = agent_guard(&caller, &data.0, Mode::Edit).await {
        return r;
    }
    match create_memory(
        &caller.db,
        &data.0,
        &data.1,
        &data.2,
        data.3.as_deref(),
        Some(&caller.user_id),
    )
    .await
    {
        Ok(m) => Created(m).into_response(),
        Err(e) => failed(&e, CONTEXT, "Failed to create the memory"),
    }
}

/// `PATCH /memories/:id`.
pub(crate) async fn memories_update(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, f| {
        (
            issues
                .text(f, "content", Presence::Optional, Some(1), Some(5000))
                .into_option(),
            issues
                .choice(f, "kind", Presence::Optional, &MEMORY_KINDS)
                .into_option(),
        )
    }) {
        Ok(d) => d,
        Err(r) => return r,
    };
    let existing = match get_memory(&caller.db, &id).await {
        Ok(Some(m)) => m,
        Ok(None) => return not_found("Memory not found"),
        Err(e) => return failed(&e, CONTEXT, "Failed to update the memory"),
    };
    if let Err(r) = agent_guard(
        &caller,
        existing["agentId"].as_str().unwrap_or_default(),
        Mode::Edit,
    )
    .await
    {
        return r;
    }
    let result = async {
        // `coalesce($new, column)`: only what the body sent changes.
        let mut update =
            memories::Entity::update_many().col_expr(Memory::UpdatedAt, Expr::value(now_tz()));
        if let Some(content) = data.0.as_deref() {
            update = update.col_expr(Memory::Content, Expr::value(content.trim()));
        }
        if let Some(kind) = data.1.as_deref() {
            update = update.col_expr(Memory::Kind, Expr::value(kind));
        }
        update
            .filter(Memory::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        get_memory(&caller.db, &id).await
    }
    .await;
    match result {
        Ok(Some(m)) => Data(m).into_response(),
        Ok(None) => not_found("Memory not found"),
        Err(e) => failed(&e, CONTEXT, "Failed to update the memory"),
    }
}

/// `DELETE /memories/:id`.
pub(crate) async fn memories_delete(caller: Caller, Path(id): Path<String>) -> Response {
    let existing = match get_memory(&caller.db, &id).await {
        Ok(Some(m)) => m,
        Ok(None) => return NoContent.into_response(),
        Err(e) => return failed(&e, CONTEXT, "Failed to delete the memory"),
    };
    if let Err(r) = agent_guard(
        &caller,
        existing["agentId"].as_str().unwrap_or_default(),
        Mode::Edit,
    )
    .await
    {
        return r;
    }
    let now = now_tz();
    match memories::Entity::update_many()
        .col_expr(Memory::DeletedAt, Expr::value(now))
        .col_expr(Memory::UpdatedAt, Expr::value(now))
        .filter(Memory::Id.eq(&id))
        .exec(&orm(&caller.db))
        .await
    {
        Ok(_) => NoContent.into_response(),
        Err(e) => failed(&e, CONTEXT, "Failed to delete the memory"),
    }
}

// ── Templates ───────────────────────────────────────────────────────────────

const TEMPLATE_KEYS: [&str; 10] = [
    "id",
    "name",
    "description",
    "payload",
    "isPublic",
    "shareToken",
    "sourceAgentId",
    "createdBy",
    "createdAt",
    "updatedAt",
];

fn template_row(template: templates::Model) -> Value {
    let mut out = pick(&js(template), &TEMPLATE_KEYS);
    if out["payload"].is_null() {
        out["payload"] = json!({});
    }
    out
}

/// The live template whose `column` (its id or its share token) is `value`.
async fn template_by(db: &PgPool, column: Template, value: &str) -> Result<Option<Value>, DbErr> {
    Ok(templates::Entity::find()
        .filter(column.eq(value))
        .filter(Template::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(template_row))
}

/// The model a template installs with: on Global only a Claude id it still
/// knows (older templates carry others), elsewhere whatever the policy knows.
fn template_model(global: bool, model: Option<String>) -> Option<String> {
    if global {
        model.filter(|m| crate::agents::GLOBAL_MODELS.contains(&m.as_str()))
    } else {
        model
    }
}

/// A 32-character random alphanumeric token (`randomString(32, ALPHANUMERIC)`).
fn share_token() -> String {
    let id = generate_id("");
    let mut token: String = id.chars().filter(char::is_ascii_alphanumeric).collect();
    while token.len() < 32 {
        token.push_str(
            &generate_id("")
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .collect::<String>(),
        );
    }
    format!("share_{}", &token[..32])
}

/// `POST /templates/export`: the agent's prompt, grants, routines and memories
/// plus a bearer share token, so only the agent's owner may export it.
pub(crate) async fn templates_export(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    struct Input {
        agent_id: String,
        name: Option<String>,
        description: Option<String>,
        is_public: Option<bool>,
    }
    let data = match validate(&headers, &body, |issues, f| Input {
        agent_id: issues
            .text(f, "agentId", Presence::Required, Some(1), Some(30))
            .into_option()
            .unwrap_or_default(),
        name: issues
            .text(f, "name", Presence::Optional, Some(2), Some(255))
            .into_option(),
        description: issues
            .text(f, "description", Presence::Optional, None, Some(2000))
            .into_option(),
        is_public: issues
            .boolean(f, "isPublic", Presence::Optional)
            .into_option(),
    }) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if let Err(r) = agent_guard(&caller, &data.agent_id, Mode::Edit).await {
        return r;
    }
    let result = async {
        let Some(agent) = get_agent(&caller.db, &data.agent_id).await? else {
            return Ok::<_, DbErr>(None);
        };
        let skills = skills::Entity::find()
            .join(JoinType::InnerJoin, skill_links())
            .filter(Link::AgentId.eq(&data.agent_id))
            .filter(Skill::DeletedAt.is_null())
            .all(&orm(&caller.db))
            .await?;
        let routines = list_routines(&caller.db, Some(&data.agent_id)).await?;
        let memories = agent_memories(&caller.db, &data.agent_id).await?;
        let payload = json!({
            "systemPrompt": agent["systemPrompt"], "permissions": agent["permissions"],
            "enabledTools": agent["enabledTools"], "modelId": agent["modelId"],
            "skills": skills.into_iter().map(|s| {
                let s = skill_row(s);
                json!({ "name": s["name"], "description": s["description"], "instructions": s["instructions"], "steps": s["steps"] })
            }).collect::<Vec<_>>(),
            "routines": routines.iter().map(|r| pick(r, &["name", "instructions", "scheduleKind", "cronExpr", "timezone", "eventKey", "connectorConfig", "requireApproval"])).collect::<Vec<_>>(),
            "memories": memories.iter().map(|m| pick(m, &["kind", "content"])).filter(|m| m["kind"] == "preference" || m["kind"] == "fact").collect::<Vec<_>>(),
        });
        let id = generate_id("tpl");
        let name = data.name.clone().unwrap_or_else(|| format!("{} template", agent["name"].as_str().unwrap_or("Agent")));
        let description = data.description.clone().or_else(|| agent["description"].as_str().map(str::to_owned));
        templates::Entity::insert(templates::ActiveModel {
            id: Set(id.clone()),
            name: Set(name.trim().to_owned()),
            description: Set(description),
            payload: Set(payload),
            is_public: Set(data.is_public.unwrap_or(false)),
            share_token: Set(Some(share_token())),
            source_agent_id: Set(Some(data.agent_id.clone())),
            created_by: Set(Some(caller.user_id.clone())),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
        .await?;
        template_by(&caller.db, Template::Id, &id).await
    }
    .await;
    match result {
        Ok(Some(t)) => Created(t).into_response(),
        Ok(None) => not_found("Agent not found"),
        Err(e) => failed(&e, CONTEXT, "Failed to export the template"),
    }
}

/// `GET /templates/:id`.
pub(crate) async fn templates_get(caller: Caller, Path(id): Path<String>) -> Response {
    match template_by(&caller.db, Template::Id, &id).await {
        Ok(Some(t)) => Data(t).into_response(),
        Ok(None) => not_found("Template not found"),
        Err(e) => failed(&e, CONTEXT, "Failed to load the template"),
    }
}

/// `GET /templates/share/:token`.
pub(crate) async fn templates_share(caller: Caller, Path(token): Path<String>) -> Response {
    match template_by(&caller.db, Template::ShareToken, &token).await {
        Ok(Some(t)) => Data(t).into_response(),
        Ok(None) => not_found("Template not found"),
        Err(e) => failed(&e, CONTEXT, "Failed to load the template"),
    }
}

/// `POST /templates/install`: a new draft agent with the template's skills,
/// routines and memories.
#[allow(clippy::too_many_lines)] // the steps of one install, in TypeScript's order
pub(crate) async fn templates_install(
    State(state): State<AgentState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, f| {
        (
            issues
                .text(f, "templateId", Presence::Optional, Some(1), Some(30))
                .into_option(),
            issues
                .text_with(
                    f,
                    "shareToken",
                    Presence::Optional,
                    Text::length(Some(8), Some(64)),
                )
                .into_option(),
            issues
                .text(f, "name", Presence::Optional, Some(1), Some(255))
                .into_option(),
        )
    }) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if data.0.is_none() && data.1.is_none() {
        return ApiError::bad_request("templateId or shareToken required").into_response();
    }
    let result = async {
        let template = match (&data.0, &data.1) {
            (Some(id), _) => template_by(&caller.db, Template::Id, id).await?,
            (None, Some(token)) => template_by(&caller.db, Template::ShareToken, token).await?,
            (None, None) => None,
        };
        let Some(template) = template else {
            return Ok::<_, DbErr>(None);
        };
        let payload = &template["payload"];
        let strings = |key: &str| -> Option<Vec<String>> {
            payload[key].as_array().map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
        };
        // Templates exported before agents ran on Claude carry other model ids.
        let model = payload["modelId"]
            .as_str()
            .filter(|m| !m.is_empty())
            .map(str::to_owned);
        let model = template_model(state.global, model);
        let name = data.2.clone().unwrap_or_else(|| {
            let base = template["name"].as_str().unwrap_or_default();
            let cut = if base.to_lowercase().ends_with("template") {
                &base[..base.len() - 8]
            } else {
                base
            };
            let cut = cut.trim();
            if cut.is_empty() {
                "Imported agent".to_owned()
            } else {
                cut.to_owned()
            }
        });
        // The template's grants are the installer's to give, as on `POST /agents`.
        let denied = ungrantable(&caller, strings("permissions").as_deref(), &[]);
        if !denied.is_empty() {
            return Ok(Some(Err(denied)));
        }
        // Without grants of its own: the sandbox and web ones, where the
        // installer holds them.
        let default_permissions: Vec<String> = if state.sandbox {
            ["computer:use", "browser:use"]
                .into_iter()
                .filter(|p| crate::grants::granter_holds(caller.permissions.resolved(), p))
                .map(str::to_owned)
                .collect()
        } else {
            Vec::new()
        };
        let agent = create_agent(
            &caller.db,
            CreateAgent {
                name,
                description: template["description"].as_str().map(str::to_owned),
                system_prompt: Some(
                    payload["systemPrompt"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                ),
                permissions: strings("permissions").unwrap_or(default_permissions),
                enabled_tools: Some(strings("enabledTools").unwrap_or_default()),
                model_id: model,
                created_by: Some(caller.user_id.clone()),
                default_model: state.default_model.clone(),
                ..CreateAgent::default()
            },
        )
        .await?;
        let agent_id = agent["id"].as_str().unwrap_or_default().to_owned();
        for skill in payload["skills"].as_array().into_iter().flatten() {
            let created = create_skill(
                &caller.db,
                skill["name"].as_str().unwrap_or_default(),
                skill["description"].as_str(),
                skill["instructions"].as_str().unwrap_or_default(),
                &if skill["steps"].is_array() {
                    skill["steps"].clone()
                } else {
                    json!([])
                },
                "active",
                Some(&caller.user_id),
                Some(&agent_id),
            )
            .await?;
            enable_skill_for_agent(
                &caller.db,
                &agent_id,
                created["id"].as_str().unwrap_or_default(),
            )
            .await?;
        }
        for routine in payload["routines"].as_array().into_iter().flatten() {
            create_routine(
                &caller.db,
                NewRoutine {
                    agent_id: agent_id.clone(),
                    name: routine["name"].as_str().unwrap_or_default().to_owned(),
                    instructions: routine["instructions"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    schedule_kind: routine["scheduleKind"].as_str().map(str::to_owned),
                    cron_expr: routine["cronExpr"].as_str().map(str::to_owned),
                    timezone: routine["timezone"].as_str().map(str::to_owned),
                    event_key: routine["eventKey"].as_str().map(str::to_owned),
                    connector_config: Some(routine["connectorConfig"].clone())
                        .filter(|c| !c.is_null()),
                    require_approval: routine["requireApproval"].as_bool(),
                    created_by: Some(caller.user_id.clone()),
                    ..NewRoutine::default()
                },
            )
            .await?;
        }
        for memory in payload["memories"].as_array().into_iter().flatten() {
            create_memory(
                &caller.db,
                &agent_id,
                memory["kind"].as_str().unwrap_or("fact"),
                memory["content"].as_str().unwrap_or_default(),
                Some("template"),
                Some(&caller.user_id),
            )
            .await?;
        }
        if payload["systemPrompt"]
            .as_str()
            .is_some_and(|p| !p.trim().is_empty())
        {
            update_agent(
                &caller.db,
                &agent_id,
                UpdateAgent {
                    status: Some("draft".to_owned()),
                    ..UpdateAgent::default()
                },
            )
            .await?;
        }
        Ok(Some(Ok(agent)))
    }
    .await;
    match result {
        Ok(Some(Ok(agent))) => {
            reindex_workspace(state.master.as_ref(), &caller.db, &caller.workspace_id).await;
            Created(agent).into_response()
        }
        Ok(Some(Err(denied))) => cannot_grant(&denied),
        Ok(None) => not_found("Template not found"),
        Err(e) => failed(&e, CONTEXT, "Failed to install the template"),
    }
}

// ── Teach ───────────────────────────────────────────────────────────────────

/// `POST /agents/:id/teach/start`.
pub(crate) async fn teach_start(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let title = match validate(&headers, &body, |issues, f| {
        issues
            .text(f, "title", Presence::Required, Some(2), Some(255))
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(t) => t,
        Err(r) => return r,
    };
    if let Err(r) = agent_guard(&caller, &id, Mode::Edit).await {
        return r;
    }
    let result = async {
        let Some(agent) = get_agent(&caller.db, &id).await? else {
            return Ok::<_, DbErr>(None);
        };
        let session_id = generate_id("tch");
        teach::Entity::insert(teach::ActiveModel {
            id: Set(session_id.clone()),
            agent_id: Set(agent["id"].as_str().unwrap_or_default().to_owned()),
            title: Set(title.trim().to_owned()),
            status: Set("recording".to_owned()),
            steps: Set(json!([])),
            created_by: Set(Some(caller.user_id.clone())),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
        .await?;
        Ok(Some(json!({ "id": session_id, "agentId": agent["id"], "title": title, "status": "recording", "steps": [] })))
    }
    .await;
    match result {
        Ok(Some(s)) => Created(s).into_response(),
        Ok(None) => not_found("Agent not found"),
        Err(e) => failed(&e, CONTEXT, "Failed to start the teach session"),
    }
}

async fn teach_agent_id(db: &PgPool, id: &str) -> Result<Option<String>, DbErr> {
    teach::Entity::find()
        .select_only()
        .column(Teach::AgentId)
        .filter(Teach::Id.eq(id))
        .into_tuple()
        .one(&orm(db))
        .await
}

/// A teach session's `column` (its status or title) and its steps.
async fn teach_steps(
    db: &PgPool,
    id: &str,
    column: Teach,
) -> Result<Option<(String, Value)>, DbErr> {
    teach::Entity::find()
        .select_only()
        .columns([column, Teach::Steps])
        .filter(Teach::Id.eq(id))
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `POST /teach/:id/steps`.
pub(crate) async fn teach_step(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let step = match validate(&headers, &body, |issues, f| match f.get("step") {
        Some(Value::Object(step)) => Some(step.clone()),
        other => {
            let _ = other;
            issues.custom("step", "Expected object");
            None
        }
    }) {
        Ok(Some(s)) => s,
        Ok(None) => return ApiError::bad_request("Invalid request body").into_response(),
        Err(r) => return r,
    };
    let missing = || not_found("Teach session not found or not recording");
    let agent_id = match teach_agent_id(&caller.db, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return missing(),
        Err(e) => return failed(&e, CONTEXT, "Failed to record the step"),
    };
    if let Err(r) = agent_guard(&caller, &agent_id, Mode::Edit).await {
        return r;
    }
    let result = async {
        let row = teach_steps(&caller.db, &id, Teach::Status).await?;
        let Some((status, steps)) = row else {
            return Ok::<_, DbErr>(None);
        };
        if status != "recording" {
            return Ok(None);
        }
        let mut steps = steps.as_array().cloned().unwrap_or_default();
        let mut step = step;
        step.insert("at".into(), json!(crate::now()));
        steps.push(Value::Object(step));
        teach::Entity::update_many()
            .col_expr(Teach::Steps, Expr::value(Value::Array(steps.clone())))
            .filter(Teach::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        Ok(Some(json!({ "id": id, "steps": steps, "status": status })))
    }
    .await;
    match result {
        Ok(Some(s)) => Data(s).into_response(),
        Ok(None) => missing(),
        Err(e) => failed(&e, CONTEXT, "Failed to record the step"),
    }
}

/// `POST /teach/:id/stop`: stops recording; the steps become a draft skill
/// (unless `createSkill` is false) the agent has.
pub(crate) async fn teach_stop(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (make_skill, skill_name) = match validate(&headers, &body, |issues, f| {
        (
            issues
                .boolean(f, "createSkill", Presence::Optional)
                .into_option(),
            issues
                .text(f, "skillName", Presence::Optional, Some(2), Some(255))
                .into_option(),
        )
    }) {
        Ok(d) => d,
        Err(r) => return r,
    };
    let agent_id = match teach_agent_id(&caller.db, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return not_found("Teach session not found"),
        Err(e) => return failed(&e, CONTEXT, "Failed to stop the teach session"),
    };
    if let Err(r) = agent_guard(&caller, &agent_id, Mode::Edit).await {
        return r;
    }
    let result = async {
        let row = teach_steps(&caller.db, &id, Teach::Title).await?;
        let Some((title, steps)) = row else { return Ok::<_, DbErr>(None) };
        let list = steps.as_array().cloned().unwrap_or_default();
        let mut skill_id: Option<String> = None;
        if make_skill != Some(false) {
            let lines: Vec<String> =
                list.iter().enumerate().map(|(i, s)| format!("{}. {}", i + 1, serde_json::to_string(s).unwrap_or_default())).collect();
            let skill = create_skill(
                &caller.db,
                &skill_name.unwrap_or(title),
                Some(&format!("Taught workflow with {} steps", list.len())),
                &format!(
                    "Perform this taught workflow carefully.\n{}\nRequire approval before sending, deleting, purchasing, or publishing.",
                    lines.join("\n")
                ),
                &steps,
                "draft",
                Some(&caller.user_id),
                Some(&agent_id),
            )
            .await?;
            let sid = skill["id"].as_str().unwrap_or_default().to_owned();
            enable_skill_for_agent(&caller.db, &agent_id, &sid).await?;
            skill_id = Some(sid);
        }
        teach::Entity::update_many()
            .col_expr(Teach::Status, Expr::value("stopped"))
            .col_expr(Teach::StoppedAt, Expr::value(now_tz()))
            .col_expr(Teach::SkillId, Expr::value(skill_id.clone()))
            .filter(Teach::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        Ok(Some(json!({ "id": id, "status": "stopped", "skillId": skill_id, "steps": steps })))
    }
    .await;
    match result {
        Ok(Some(s)) => Data(s).into_response(),
        Ok(None) => not_found("Teach session not found"),
        Err(e) => failed(&e, CONTEXT, "Failed to stop the teach session"),
    }
}

// ── Connector events ────────────────────────────────────────────────────────

/// `POST /connectors/events`: a Slack or GitHub event starts the matching
/// connector routines (at most five, each with its own run row).
pub(crate) async fn connector_event(
    State(state): State<AgentState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, f| {
        let _ = issues.text(
            f,
            "workspaceExternalId",
            Presence::Optional,
            None,
            Some(200),
        );
        let payload = match f.get("payload") {
            None | Some(Value::Null) => None,
            Some(Value::Object(_)) => f.get("payload").cloned(),
            Some(_) => {
                issues.custom("payload", "Expected object");
                None
            }
        };
        (
            issues
                .choice(f, "provider", Presence::Required, &["slack", "github"])
                .into_option()
                .unwrap_or_default(),
            issues
                .text(f, "channel", Presence::Optional, None, Some(200))
                .into_option(),
            issues
                .text(f, "repo", Presence::Optional, None, Some(200))
                .into_option(),
            issues
                .text(f, "event", Presence::Optional, None, Some(100))
                .into_option(),
            issues
                .text(f, "text", Presence::Optional, None, Some(10000))
                .into_option(),
            payload,
        )
    }) {
        Ok(d) => d,
        Err(r) => return r,
    };
    let (provider, channel, repo, event, text, _payload) = data;
    let db = &caller.db;
    let matches = match find_connector_routines(
        db,
        &provider,
        channel.as_deref(),
        repo.as_deref(),
        event.as_deref(),
        text.as_deref(),
    )
    .await
    {
        Ok(m) => m,
        Err(e) => return failed(&e, CONTEXT, "Failed to match the event"),
    };
    let ai = caller.ai(&state);
    let mut started: Vec<Value> = Vec::new();
    for routine in matches.iter().take(5) {
        let routine_id = routine["id"].as_str().unwrap_or_default().to_owned();
        let agent_id = routine["agentId"].as_str().unwrap_or_default().to_owned();
        let step = async {
            let run_id =
                create_routine_run(db, &routine_id, &agent_id, &format!("connector:{provider}"))
                    .await?;
            mark_routine_scheduled(
                db,
                routine,
                i64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
                    .unwrap_or_default(),
            )
            .await?;
            Ok::<_, DbErr>(run_id)
        }
        .await;
        match step {
            Ok(run_id) => {
                let params = RunParams {
                    db: db.clone(),
                    workspace_id: caller.workspace_id.clone(),
                    actor_user_id: caller.user_id.clone(),
                    agent_id,
                    trigger_type: TriggerType::Event,
                    trigger_data: Some(
                        json!({ "routineId": routine_id, "connector": { "provider": provider, "channel": channel, "repo": repo, "event": event, "text": text } }),
                    ),
                    user_message: format!(
                        "Connector event from {provider}.\nMatch text: {}\nFollow routine \"{}\":\n{}",
                        text.as_deref().unwrap_or("(none)"),
                        routine["name"].as_str().unwrap_or_default(),
                        routine["instructions"].as_str().unwrap_or_default()
                    ),
                    extra_system: None,
                    run_id: None,
                    routine_run_id: Some(run_id.clone()),
                    skip_approvals: routine["requireApproval"] != json!(true),
                    notify: true,
                    actor_permissions: None,
                    events: None,
                    env: state.run_env(),
                };
                let ai = ai.clone();
                tokio::spawn(async move {
                    if let Err(error) = run_agent(ai.as_ref(), params).await {
                        tracing::warn!(
                            ?error,
                            "[weldagent/connectors] the routine could not start"
                        );
                    }
                });
                started.push(json!({ "routineId": routine_id, "runId": run_id }));
            }
            Err(error) => tracing::error!(%error, "[weldagent/connectors] routine start failed"),
        }
    }
    Data(json!({ "matched": matches.len(), "started": started })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_template_keeps_its_model_by_edition() {
        let mistral = || Some("mistral/mistral-large".to_owned());
        // EU with a sandbox is not Global: the template's model stays.
        assert_eq!(template_model(false, mistral()), mistral());
        assert_eq!(template_model(true, mistral()), None);
        let claude = Some("claude-opus-5-5".to_owned());
        assert_eq!(template_model(true, claude.clone()), claude);
        assert_eq!(template_model(false, claude.clone()), claude);
    }

    #[test]
    fn share_tokens_are_long_and_prefixed() {
        let token = share_token();
        assert!(token.starts_with("share_"));
        assert_eq!(token.len(), 6 + 32);
        assert_ne!(token, share_token());
    }

    #[test]
    fn skills_read_with_steps_and_without_the_extras() {
        let at = time::macros::datetime!(2026-11-13 10:00:00.5 UTC);
        let skill = skill_row(skills::Model {
            id: "skl_1".into(),
            name: "n".into(),
            description: None,
            instructions: "i".into(),
            status: "draft".into(),
            steps: Value::Null,
            created_by: None,
            source_agent_id: None,
            created_at: at,
            updated_at: at,
            deleted_at: None,
        });
        assert_eq!(skill["steps"], json!([]));
        assert!(skill.get("deletedAt").is_none());
        assert_eq!(skill["createdAt"], "2026-11-13T10:00:00.500Z");
    }

    #[test]
    fn a_routine_test_message_names_the_routine() {
        let (message, system) = routine_message(
            &json!({ "name": "Digest", "instructions": "Summarise." }),
            true,
        );
        assert!(message.starts_with("Run routine \"Digest\" as a test."));
        assert!(system.is_some());
    }
}
