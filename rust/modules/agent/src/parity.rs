//! Skills, routines, memories, templates, teach sessions and connector events
//! (`apps/workers/agent-api/src/routes/weldagent/parity.ts`,
//! `packages/domains/agent/src/parity.ts`,
//! `@weldsuite/app-api-client/schemas/weldagent-parity`). Approvals are in
//! [`crate::approvals`].

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_db::js_row;
use weldsuite_kit::validation::{Field, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};

use crate::agent_routes::{Mode, agent_guard};
use crate::agents::{CreateAgent, UpdateAgent, create_agent, get_agent, update_agent};
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

fn skill_row(row: Value) -> Value {
    let row = js_row(row);
    let mut out = pick(&row, &SKILL_KEYS);
    if out["steps"].is_null() {
        out["steps"] = json!([]);
    }
    out
}

async fn get_skill(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from weldagent_skills s where s.id = $1 and s.deleted_at is null",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(skill_row))
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
) -> Result<Value, sqlx::Error> {
    let id = generate_id("skl");
    sqlx::query(
        "insert into weldagent_skills (id, name, description, instructions, steps, status, created_by, source_agent_id)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)",
    )
    .bind(&id)
    .bind(name.trim())
    .bind(description)
    .bind(instructions.trim())
    .bind(steps)
    .bind(status)
    .bind(created_by)
    .bind(source_agent_id)
    .execute(db)
    .await?;
    Ok(get_skill(db, &id).await?.unwrap_or(Value::Null))
}

/// `enableSkillForAgent`: an existing link is switched on, else created.
async fn enable_skill_for_agent(
    db: &PgPool,
    agent_id: &str,
    skill_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let Some(skill) = get_skill(db, skill_id).await? else {
        return Ok(None);
    };
    let relinked = sqlx::query(
        "update weldagent_agent_skills set enabled = true where agent_id = $1 and skill_id = $2",
    )
    .bind(agent_id)
    .bind(skill_id)
    .execute(db)
    .await?;
    if relinked.rows_affected() == 0 {
        sqlx::query("insert into weldagent_agent_skills (id, agent_id, skill_id, enabled) values ($1, $2, $3, true)")
            .bind(generate_id("asl"))
            .bind(agent_id)
            .bind(skill_id)
            .execute(db)
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
    let rows: Result<Vec<Value>, _> = sqlx::query_scalar(
        "select to_jsonb(s) from weldagent_skills s where s.deleted_at is null and ($1::text is null or s.status = $1)
         order by s.updated_at desc",
    )
    .bind(query.status.as_deref().filter(|s| !s.is_empty()))
    .fetch_all(&caller.db)
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
            return Ok::<_, sqlx::Error>(None);
        }
        sqlx::query(
            "update weldagent_skills set updated_at = $2::timestamptz, name = coalesce($3, name),
               description = coalesce($4, description), instructions = coalesce($5, instructions),
               steps = coalesce($6::jsonb, steps), status = coalesce($7, status) where id = $1",
        )
        .bind(&id)
        .bind(crate::now())
        .bind(data.name.as_deref().map(str::trim))
        .bind(&data.description)
        .bind(data.instructions.as_deref().map(str::trim))
        .bind(data.steps.map(Value::Array))
        .bind(&data.status)
        .execute(&caller.db)
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
            return Ok::<_, sqlx::Error>(false);
        }
        sqlx::query("update weldagent_skills set deleted_at = $2::timestamptz, updated_at = $2::timestamptz where id = $1")
            .bind(&id)
            .bind(crate::now())
            .execute(&caller.db)
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

/// `GET /agents/:id/skills`: the agent's skills with whether each is on.
pub(crate) async fn agent_skills(caller: Caller, Path(id): Path<String>) -> Response {
    if let Err(r) = agent_guard(&caller, &id, Mode::Access).await {
        return r;
    }
    let rows: Result<Vec<Value>, _> = sqlx::query_scalar(
        "select to_jsonb(s) || jsonb_build_object('enabled', l.enabled, 'link_id', l.id)
         from weldagent_agent_skills l join weldagent_skills s on s.id = l.skill_id
         where l.agent_id = $1 and s.deleted_at is null",
    )
    .bind(&id)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(
            rows.into_iter()
                .map(|r| {
                    let row = js_row(r);
                    let mut out = skill_row(row.clone());
                    out["enabled"] = row["enabled"].clone();
                    out["linkId"] = row["linkId"].clone();
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
    match sqlx::query(
        "update weldagent_agent_skills set enabled = false where agent_id = $1 and skill_id = $2",
    )
    .bind(&id)
    .bind(&skill_id)
    .execute(&caller.db)
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
        Ok::<_, sqlx::Error>(
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

async fn get_memory(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from weldagent_memories m where m.id = $1 and m.deleted_at is null",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|r| pick(&js_row(r), &MEMORY_KEYS)))
}

async fn create_memory(
    db: &PgPool,
    agent_id: &str,
    kind: &str,
    content: &str,
    source: Option<&str>,
    created_by: Option<&str>,
) -> Result<Value, sqlx::Error> {
    let id = generate_id("mem");
    sqlx::query("insert into weldagent_memories (id, agent_id, kind, content, source, created_by) values ($1, $2, $3, $4, $5, $6)")
        .bind(&id)
        .bind(agent_id)
        .bind(kind)
        .bind(content.trim())
        .bind(source)
        .bind(created_by)
        .execute(db)
        .await?;
    Ok(get_memory(db, &id).await?.unwrap_or(Value::Null))
}

/// `GET /agents/:id/memories`.
pub(crate) async fn memories_list(caller: Caller, Path(id): Path<String>) -> Response {
    if let Err(r) = agent_guard(&caller, &id, Mode::Access).await {
        return r;
    }
    let rows: Result<Vec<Value>, _> = sqlx::query_scalar(
        "select to_jsonb(m) from weldagent_memories m where m.agent_id = $1 and m.deleted_at is null
         order by m.updated_at desc limit 100",
    )
    .bind(&id)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(
            rows.into_iter()
                .map(|r| pick(&js_row(r), &MEMORY_KEYS))
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
        sqlx::query(
            "update weldagent_memories set updated_at = $2::timestamptz, content = coalesce($3, content), kind = coalesce($4, kind) where id = $1",
        )
        .bind(&id)
        .bind(crate::now())
        .bind(data.0.as_deref().map(str::trim))
        .bind(&data.1)
        .execute(&caller.db)
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
    match sqlx::query("update weldagent_memories set deleted_at = $2::timestamptz, updated_at = $2::timestamptz where id = $1")
        .bind(&id)
        .bind(crate::now())
        .execute(&caller.db)
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

fn template_row(row: Value) -> Value {
    let mut out = pick(&js_row(row), &TEMPLATE_KEYS);
    if out["payload"].is_null() {
        out["payload"] = json!({});
    }
    out
}

async fn template_by(db: &PgPool, column: &str, value: &str) -> Result<Option<Value>, sqlx::Error> {
    let sql = format!(
        "select to_jsonb(t) from weldagent_templates t where t.{column} = $1 and t.deleted_at is null"
    );
    Ok(sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(sql))
        .bind(value)
        .fetch_optional(db)
        .await?
        .map(template_row))
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
            return Ok::<_, sqlx::Error>(None);
        };
        let skills: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(s) from weldagent_agent_skills l join weldagent_skills s on s.id = l.skill_id
             where l.agent_id = $1 and s.deleted_at is null",
        )
        .bind(&data.agent_id)
        .fetch_all(&caller.db)
        .await?;
        let routines = list_routines(&caller.db, Some(&data.agent_id)).await?;
        let memories: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(m) from weldagent_memories m where m.agent_id = $1 and m.deleted_at is null
             order by m.updated_at desc limit 100",
        )
        .bind(&data.agent_id)
        .fetch_all(&caller.db)
        .await?;
        let payload = json!({
            "systemPrompt": agent["systemPrompt"], "permissions": agent["permissions"],
            "enabledTools": agent["enabledTools"], "modelId": agent["modelId"],
            "skills": skills.into_iter().map(|s| {
                let s = skill_row(s);
                json!({ "name": s["name"], "description": s["description"], "instructions": s["instructions"], "steps": s["steps"] })
            }).collect::<Vec<_>>(),
            "routines": routines.iter().map(|r| pick(r, &["name", "instructions", "scheduleKind", "cronExpr", "timezone", "eventKey", "connectorConfig", "requireApproval"])).collect::<Vec<_>>(),
            "memories": memories.into_iter().map(|m| pick(&js_row(m), &["kind", "content"])).filter(|m| m["kind"] == "preference" || m["kind"] == "fact").collect::<Vec<_>>(),
        });
        let id = generate_id("tpl");
        let name = data.name.clone().unwrap_or_else(|| format!("{} template", agent["name"].as_str().unwrap_or("Agent")));
        let description = data.description.clone().or_else(|| agent["description"].as_str().map(str::to_owned));
        sqlx::query(
            "insert into weldagent_templates (id, name, description, payload, is_public, share_token, source_agent_id, created_by)
             values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)",
        )
        .bind(&id)
        .bind(name.trim())
        .bind(description)
        .bind(&payload)
        .bind(data.is_public.unwrap_or(false))
        .bind(share_token())
        .bind(&data.agent_id)
        .bind(&caller.user_id)
        .execute(&caller.db)
        .await?;
        template_by(&caller.db, "id", &id).await
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
    match template_by(&caller.db, "id", &id).await {
        Ok(Some(t)) => Data(t).into_response(),
        Ok(None) => not_found("Template not found"),
        Err(e) => failed(&e, CONTEXT, "Failed to load the template"),
    }
}

/// `GET /templates/share/:token`.
pub(crate) async fn templates_share(caller: Caller, Path(token): Path<String>) -> Response {
    match template_by(&caller.db, "share_token", &token).await {
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
            (Some(id), _) => template_by(&caller.db, "id", id).await?,
            (None, Some(token)) => template_by(&caller.db, "share_token", token).await?,
            (None, None) => None,
        };
        let Some(template) = template else {
            return Ok::<_, sqlx::Error>(None);
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
        let model = if state.sandbox {
            model.filter(|m| crate::agents::GLOBAL_MODELS.contains(&m.as_str()))
        } else {
            model
        };
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
        let default_permissions: Vec<String> = if state.sandbox {
            vec!["computer:use".into(), "browser:use".into()]
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
        Ok(Some(agent))
    }
    .await;
    match result {
        Ok(Some(agent)) => {
            reindex_workspace(state.master.as_ref(), &caller.db, &caller.workspace_id).await;
            Created(agent).into_response()
        }
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
            return Ok::<_, sqlx::Error>(None);
        };
        let session_id = generate_id("tch");
        sqlx::query(
            "insert into weldagent_teach_sessions (id, agent_id, title, status, steps, created_by)
             values ($1, $2, $3, 'recording', '[]'::jsonb, $4)",
        )
        .bind(&session_id)
        .bind(agent["id"].as_str())
        .bind(title.trim())
        .bind(&caller.user_id)
        .execute(&caller.db)
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

async fn teach_agent_id(db: &PgPool, id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("select agent_id from weldagent_teach_sessions where id = $1")
        .bind(id)
        .fetch_optional(db)
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
        let row: Option<(String, Value)> =
            sqlx::query_as("select status, steps from weldagent_teach_sessions where id = $1")
                .bind(&id)
                .fetch_optional(&caller.db)
                .await?;
        let Some((status, steps)) = row else {
            return Ok::<_, sqlx::Error>(None);
        };
        if status != "recording" {
            return Ok(None);
        }
        let mut steps = steps.as_array().cloned().unwrap_or_default();
        let mut step = step;
        step.insert("at".into(), json!(crate::now()));
        steps.push(Value::Object(step));
        sqlx::query("update weldagent_teach_sessions set steps = $2::jsonb where id = $1")
            .bind(&id)
            .bind(Value::Array(steps.clone()))
            .execute(&caller.db)
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
        let row: Option<(String, Value)> =
            sqlx::query_as("select title, steps from weldagent_teach_sessions where id = $1").bind(&id).fetch_optional(&caller.db).await?;
        let Some((title, steps)) = row else { return Ok::<_, sqlx::Error>(None) };
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
        sqlx::query(
            "update weldagent_teach_sessions set status = 'stopped', stopped_at = $2::timestamptz, skill_id = $3 where id = $1",
        )
        .bind(&id)
        .bind(crate::now())
        .bind(&skill_id)
        .execute(&caller.db)
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
            Ok::<_, sqlx::Error>(run_id)
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
    fn share_tokens_are_long_and_prefixed() {
        let token = share_token();
        assert!(token.starts_with("share_"));
        assert_eq!(token.len(), 6 + 32);
        assert_ne!(token, share_token());
    }

    #[test]
    fn skills_read_with_steps_and_without_the_extras() {
        let row = json!({ "id": "skl_1", "name": "n", "instructions": "i", "status": "draft", "steps": null,
            "created_at": "2026-11-13T10:00:00.5+00:00", "deleted_at": null });
        let skill = skill_row(row);
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
