//! Project templates: blueprints (design: weldflow-delivery-and-portfolio.md,
//! "Create from a template"; ADR FLOW-021; slice F): the mirror of
//! `@weldsuite/flow-domain/project-templates`.
//!
//! The three pure halves: [`build_blueprint`] (a project's rows into a
//! blueprint, "Save as template"), the integrity rules in [`crate::blueprint`],
//! and [`plan_instantiation`] (a blueprint, a start date and a person per role
//! into every row of the new project, "Create project").
//!
//! No database. Rows and blueprints are camelCase JSON (`js_row`); dates are
//! epoch milliseconds inside the rules and ISO strings in the rows. Every
//! message returned here is sent to the client as it is.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};

use crate::blueprint::{
    BLUEPRINT_MEMBER_ROLES, BLUEPRINT_VERSION, DECISION_CRITERION_KEY, DECISION_CRITERION_TEXT,
    Json, PROJECT_MANAGER_ROLE, SPONSOR_ROLE, SYSTEM_STATUSES, blueprint_integrity_error,
    deliverable_criterion_text, deliverable_key_of, is_deliverable_criterion,
    upgrade_gate_criteria, validate_blueprint,
};
use crate::gates::GATE_CRITERION_KEYS;
use crate::js::{iso_from_millis, millis_of, truthy};
use crate::numbering::NumberSequence;
use crate::project_closing::{DEFAULT_WORKING_DAYS, add_working_days, working_day_offset};
use crate::raid::{RaidKind, initial_raid_status, raid_sequence};
use crate::risk::{RiskBand, next_review_at_ms, risk_band, risk_score};

pub const UNSUPPORTED_VERSION: &str = "This template was saved in a format that is not supported";
pub const CANNOT_SAVE: &str = "This project cannot be saved as a template";
pub const INVALID_BLUEPRINT: &str = "The template is no longer valid";

/// `The template has no role '<role>'`.
pub fn unknown_role_message(role: &str) -> String {
    format!("The template has no role '{role}'")
}

// ── Reading a stored blueprint ──────────────────────────────────────────────

/// A stored blueprint, upgraded to the current layout and checked
/// (`readBlueprint`). An unknown version, or a blueprint that no longer passes
/// the schema and the integrity rules, is refused with the message. Gate
/// criteria saved with the source project's ids are made manual ones.
pub fn read_blueprint(stored: &Value) -> Result<Value, &'static str> {
    if stored.get("version").and_then(Value::as_i64) != Some(BLUEPRINT_VERSION) {
        return Err(UNSUPPORTED_VERSION);
    }
    let parsed = upgrade_gate_criteria(validate_blueprint(stored).ok_or(INVALID_BLUEPRINT)?);
    if blueprint_integrity_error(&parsed).is_some() {
        return Err(INVALID_BLUEPRINT);
    }
    Ok(parsed)
}

// ── Save as template: rows into a blueprint ─────────────────────────────────

/// Everything of a project a blueprint is built from. Only live rows.
#[derive(Debug, Default)]
pub struct BlueprintSource {
    pub project: Value,
    /// Active members.
    pub members: Vec<Value>,
    pub stages: Vec<Value>,
    pub phases: Vec<Value>,
    pub milestones: Vec<Value>,
    pub deliverables: Vec<Value>,
    pub tasks: Vec<Value>,
    pub dependencies: Vec<Value>,
    pub raid_items: Vec<Value>,
}

const RAID_KIND_ORDER: [&str; 4] = ["risk", "assumption", "issue", "dependency"];

type Labels = HashMap<String, String>;

fn number_of(row: &Value, key: &str) -> i64 {
    row.int(key).unwrap_or(0)
}

fn millis(row: &Value, key: &str) -> Option<i64> {
    row.text(key).and_then(millis_of)
}

fn id_of(row: &Value) -> String {
    row.text("id").unwrap_or_default().to_owned()
}

/// A member role as a blueprint knows it (any other spelling is a plain member).
fn member_role_of(role: &str) -> &'static str {
    match role.to_lowercase().as_str() {
        "owner" => "owner",
        "admin" => "admin",
        "viewer" => "viewer",
        _ => "member",
    }
}

/// The member ids a task is assigned to: `assigneeIds`, else the one `assigneeId`.
fn assignees_of(task: &Value) -> Vec<&str> {
    let ids: Vec<&str> = task
        .items("assigneeIds")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    if !ids.is_empty() {
        return ids;
    }
    task.text("assigneeId")
        .filter(|id| !id.is_empty())
        .into_iter()
        .collect()
}

/// The people of the source project as roles: the project manager, the
/// sponsor, then everyone else in the order they first appear.
struct Roles {
    list: Vec<Value>,
    by_user: HashMap<String, String>,
    others: usize,
    membership: HashMap<String, String>,
}

impl Roles {
    fn add(
        &mut self,
        user: Option<&str>,
        key: &str,
        fallback: &str,
        project_role: Option<&str>,
        labels: &Labels,
    ) {
        let Some(user) = user.filter(|user| !user.is_empty()) else {
            return;
        };
        if self.by_user.contains_key(user) {
            return;
        }
        self.by_user.insert(user.to_owned(), key.to_owned());
        let label = labels
            .get(key)
            .map(|label| label.trim())
            .filter(|label| !label.is_empty())
            .unwrap_or(fallback);
        self.list
            .push(json!({ "key": key, "label": label, "projectRole": project_role }));
    }

    fn add_other(&mut self, user: Option<&str>, labels: &Labels) {
        let Some(user) = user.filter(|user| !user.is_empty()) else {
            return;
        };
        if self.by_user.contains_key(user) {
            return;
        }
        self.others += 1;
        let role = self.membership.get(user).map(|role| member_role_of(role));
        let key = format!("member_{}", self.others);
        let fallback = format!("Team member {}", self.others);
        self.add(Some(user), &key, &fallback, role, labels);
    }

    fn of(&self, user: Option<&str>) -> Value {
        user.and_then(|user| self.by_user.get(user))
            .map_or(Value::Null, |role| json!(role))
    }

    fn unique(&self, users: &[&str]) -> Vec<Value> {
        let mut seen = HashSet::new();
        users
            .iter()
            .filter_map(|user| self.by_user.get(*user))
            .filter(|role| seen.insert((*role).clone()))
            .map(|role| json!(role))
            .collect()
    }
}

/// The dependencies without the ones that close a circle (first come, first kept).
fn without_cycles(dependencies: Vec<Value>) -> Vec<Value> {
    let mut kept = Vec::new();
    let mut successors: HashMap<String, Vec<String>> = HashMap::new();
    for dependency in dependencies {
        let predecessor = dependency
            .text("predecessor")
            .unwrap_or_default()
            .to_owned();
        let successor = dependency.text("successor").unwrap_or_default().to_owned();
        // Adding predecessor -> successor closes a circle when the successor already reaches the predecessor.
        let mut seen = HashSet::new();
        let mut stack = vec![successor.clone()];
        let mut reaches = false;
        while let Some(current) = stack.pop() {
            if current == predecessor {
                reaches = true;
                break;
            }
            if !seen.insert(current.clone()) {
                continue;
            }
            stack.extend(successors.get(&current).cloned().unwrap_or_default());
        }
        if reaches {
            continue;
        }
        successors.entry(predecessor).or_default().push(successor);
        kept.push(dependency);
    }
    kept
}

fn sorted<K: Ord>(rows: &[Value], key: impl Fn(&Value) -> K) -> Vec<&Value> {
    let mut rows: Vec<&Value> = rows.iter().collect();
    rows.sort_by_key(|row| key(row));
    rows
}

fn priority_of(task: &Value) -> &'static str {
    match task.text("priority") {
        Some("critical") => "critical",
        Some("high") => "high",
        Some("low") => "low",
        Some("none") => "none",
        _ => "medium",
    }
}

fn raid_kind_index(row: &Value) -> i64 {
    RAID_KIND_ORDER
        .iter()
        .position(|kind| Some(*kind) == row.text("kind"))
        .map_or(-1, |index| i64::try_from(index).unwrap_or(-1))
}

/// The roles of a source project (`Roles`), in the order they first appear.
fn source_roles(
    source: &BlueprintSource,
    labels: &Labels,
    tasks: &[&Value],
    milestones: &[&Value],
    deliverables: &[&Value],
    raid_items: &[&Value],
) -> Roles {
    let project = &source.project;
    let settings = project.at("settings");
    let mut roles = Roles {
        list: Vec::new(),
        by_user: HashMap::new(),
        others: 0,
        membership: source
            .members
            .iter()
            .filter_map(|m| {
                Some((
                    m.text("userId")?.to_owned(),
                    m.text("role").unwrap_or_default().to_owned(),
                ))
            })
            .collect(),
    };
    roles.add(
        project.text("projectManagerId"),
        PROJECT_MANAGER_ROLE,
        "Project manager",
        Some("owner"),
        labels,
    );
    let sponsor = settings.text("sponsorId");
    let sponsor_role = sponsor
        .and_then(|id| roles.membership.get(id))
        .map(|role| member_role_of(role));
    roles.add(sponsor, SPONSOR_ROLE, "Sponsor", sponsor_role, labels);
    for member in sorted(&source.members, |r| {
        (millis(r, "joinedAt").unwrap_or(0), id_of(r))
    }) {
        roles.add_other(member.text("userId"), labels);
    }
    for id in settings
        .at("changeControl")
        .items("boardMemberIds")
        .iter()
        .filter_map(Value::as_str)
    {
        roles.add_other(Some(id), labels);
    }
    for task in tasks {
        for id in assignees_of(task) {
            roles.add_other(Some(id), labels);
        }
    }
    for row in milestones.iter().chain(deliverables).chain(raid_items) {
        roles.add_other(row.text("ownerId"), labels);
    }
    roles
}

/// The blueprint's dependencies: the typed rows first (they win), then the
/// legacy `dependsOn` and `blocks` arrays.
fn source_dependencies(
    source: &BlueprintSource,
    tasks: &[&Value],
    task_keys: &HashMap<String, String>,
) -> Vec<Value> {
    let mut dependencies: Vec<Value> = Vec::new();
    let mut pairs: HashSet<String> = HashSet::new();
    let mut add = |predecessor: Option<&str>, successor: Option<&str>, kind: &str, lag: i64| {
        let (Some(predecessor), Some(successor)) = (
            predecessor.and_then(|id| task_keys.get(id)),
            successor.and_then(|id| task_keys.get(id)),
        ) else {
            return;
        };
        if predecessor == successor || !pairs.insert(format!("{predecessor}>{successor}")) {
            return;
        }
        dependencies.push(json!({
            "predecessor": predecessor, "successor": successor, "type": kind, "lagDays": lag,
        }));
    };
    for row in sorted(&source.dependencies, |r| {
        (millis(r, "createdAt").unwrap_or(0), id_of(r))
    }) {
        add(
            row.text("predecessorId"),
            row.text("successorId"),
            row.text("type").unwrap_or("fs"),
            number_of(row, "lagDays"),
        );
    }
    for task in tasks {
        for predecessor in task.items("dependsOn").iter().filter_map(Value::as_str) {
            add(Some(predecessor), task.text("id"), "fs", 0);
        }
        for successor in task.items("blocks").iter().filter_map(Value::as_str) {
            add(task.text("id"), Some(successor), "fs", 0);
        }
    }
    without_cycles(dependencies)
}

fn key_map(rows: &[&Value], prefix: &str) -> HashMap<String, String> {
    rows.iter()
        .enumerate()
        .map(|(index, row)| (id_of(row), format!("{prefix}{}", index + 1)))
        .collect()
}

fn key_of(keys: &HashMap<String, String>, id: Option<&str>) -> Value {
    id.and_then(|id| keys.get(id))
        .map_or(Value::Null, |key| json!(key))
}

fn working_days_of(settings: &Value) -> Vec<i64> {
    let schedule = settings.at("schedule");
    if schedule.get("workingDays").is_some_and(Value::is_array) {
        schedule
            .items("workingDays")
            .iter()
            .filter_map(Value::as_i64)
            .collect()
    } else {
        DEFAULT_WORKING_DAYS.to_vec()
    }
}

/// Turn a project into a blueprint (`buildBlueprint`): dates become offsets in
/// working days from the project start, people become roles, ids become local
/// keys. Names, comments, time entries and files are not copied; tasks are
/// copied without their progress, and the register only with its open items.
/// `role_labels` names the roles by key.
#[allow(clippy::too_many_lines)] // one section per part of the blueprint, in the schema's order
pub fn build_blueprint(source: &BlueprintSource, role_labels: &Labels) -> Value {
    let project = &source.project;
    let settings = project.at("settings");
    let working_days = working_days_of(settings);

    let tasks: Vec<&Value> = sorted(&source.tasks, |t| (number_of(t, "position"), id_of(t)))
        .into_iter()
        .filter(|task| task.text("status") != Some("cancelled"))
        .collect();
    let milestones = sorted(&source.milestones, |r| {
        (millis(r, "dueDate").unwrap_or(0), id_of(r))
    });
    let deliverables = sorted(&source.deliverables, |r| {
        (number_of(r, "position"), number_of(r, "number"))
    });
    let phases = sorted(&source.phases, |r| (number_of(r, "position"), id_of(r)));
    let stages = sorted(&source.stages, |r| (number_of(r, "position"), id_of(r)));
    let raid_items: Vec<&Value> = sorted(&source.raid_items, |r| {
        (raid_kind_index(r), number_of(r, "number"))
    })
    .into_iter()
    .filter(|item| item.at("closedAt").is_null())
    .collect();

    let roles = source_roles(
        source,
        role_labels,
        &tasks,
        &milestones,
        &deliverables,
        &raid_items,
    );

    // ── Dates ──
    let mut dated: Vec<i64> = Vec::new();
    dated.extend(
        tasks
            .iter()
            .flat_map(|t| [millis(t, "startDate"), millis(t, "dueDate")])
            .flatten(),
    );
    dated.extend(milestones.iter().filter_map(|r| millis(r, "dueDate")));
    for row in phases.iter().chain(deliverables.iter()) {
        dated.extend(
            [millis(row, "plannedStart"), millis(row, "plannedEnd")]
                .into_iter()
                .flatten(),
        );
    }
    let start = millis(project, "startDate").or_else(|| dated.iter().min().copied());
    let offset_of = |date: Option<i64>| -> Option<i64> {
        Some(working_day_offset(start?, date?, Some(&working_days)))
    };
    let offset_value =
        |date: Option<i64>| offset_of(date).map_or(Value::Null, |offset| json!(offset));

    // ── Local keys ──
    let milestone_keys = key_map(&milestones, "m");
    let deliverable_keys = key_map(&deliverables, "d");
    let task_keys = key_map(&tasks, "t");

    let blueprint_tasks: Vec<Value> = tasks
        .iter()
        .map(|task| {
            json!({
                "key": task_keys.get(&id_of(task)),
                "parentKey": key_of(&task_keys, task.text("parentTaskId")),
                "title": task.at("title"),
                "description": task.at("description"),
                "priority": priority_of(task),
                "type": task.text("type").unwrap_or("task"),
                "status": if task.text("status") == Some("backlog") { "backlog" } else { "todo" },
                "assigneeRoles": roles.unique(&assignees_of(task)),
                "startOffset": offset_value(millis(task, "startDate")),
                "dueOffset": offset_value(millis(task, "dueDate")),
                "estimatedHours": task.at("estimatedHours"),
                "storyPoints": task.at("storyPoints"),
                "milestoneKey": key_of(&milestone_keys, task.text("milestoneId")),
                "deliverableKey": key_of(&deliverable_keys, task.text("deliverableId")),
                "labels": task.at("labels"),
                "tags": task.at("tags"),
                "isBillable": task.at("isBillable"),
            })
        })
        .collect();

    let dependencies = source_dependencies(source, &tasks, &task_keys);

    let mut last = 0;
    for task in &blueprint_tasks {
        last = last
            .max(task.int("startOffset").unwrap_or(0))
            .max(task.int("dueOffset").unwrap_or(0));
    }
    for row in &milestones {
        last = last.max(offset_of(millis(row, "dueDate")).unwrap_or(0));
    }
    for row in phases.iter().chain(deliverables.iter()) {
        for key in ["plannedStart", "plannedEnd"] {
            last = last.max(offset_of(millis(row, key)).unwrap_or(0));
        }
    }
    let duration = offset_of(millis(project, "endDate")).unwrap_or(last).max(0);

    json!({
        "version": 1,
        "durationDays": duration,
        "roles": roles.list,
        "project": project_attributes(project),
        "stages": stages.iter().enumerate().map(|(index, stage)| json!({
            "key": format!("s{}", index + 1),
            "name": stage.at("name"),
            "color": stage.at("color"),
            "systemStatus": match stage.text("systemStatus") {
                Some(s) if SYSTEM_STATUSES.contains(&s) => s,
                _ => "in_progress",
            },
        })).collect::<Vec<_>>(),
        "phases": phases.iter().enumerate().map(|(index, phase)| json!({
            "key": format!("p{}", index + 1),
            "name": phase.at("name"),
            "startOffset": offset_value(millis(phase, "plannedStart")),
            "endOffset": offset_value(millis(phase, "plannedEnd")),
            "gateCriteria": phase.items("gateCriteria").iter().map(|c| gate_criterion(c, &deliverable_keys)).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "milestones": milestones.iter().map(|row| json!({
            "key": key_of(&milestone_keys, row.text("id")),
            "name": row.at("name"),
            "description": row.at("description"),
            "offset": offset_of(millis(row, "dueDate")).unwrap_or(0),
            "isKey": row.at("isKeyMilestone").as_bool() == Some(true),
            "ownerRole": roles.of(row.text("ownerId")),
        })).collect::<Vec<_>>(),
        "deliverables": deliverables.iter().map(|row| json!({
            "key": key_of(&deliverable_keys, row.text("id")),
            "title": row.at("title"),
            "description": row.at("description"),
            "ownerRole": roles.of(row.text("ownerId")),
            "startOffset": offset_value(millis(row, "plannedStart")),
            "endOffset": offset_value(millis(row, "plannedEnd")),
            "acceptanceCriteria": row.items("acceptanceCriteria").iter().map(|c| c.at("text").clone()).collect::<Vec<_>>(),
            "clientVisible": row.at("clientVisible"),
        })).collect::<Vec<_>>(),
        "tasks": blueprint_tasks,
        "dependencies": dependencies,
        "raid": raid_items.iter().map(|item| raid_value(item, &roles)).collect::<Vec<_>>(),
        "settings": blueprint_settings(settings, &roles),
    })
}

fn project_attributes(project: &Value) -> Value {
    let mut out = Map::new();
    for key in [
        "type",
        "methodology",
        "priority",
        "visibility",
        "color",
        "icon",
        "budgetCurrency",
        "billingMethod",
        "isBillable",
        "trackTime",
    ] {
        out.insert(key.to_owned(), project.at(key).clone());
    }
    Value::Object(out)
}

/// A gate criterion as a blueprint stores it: a deliverable by its local key, a
/// decision (or a deliverable that is gone) as a manual criterion.
fn gate_criterion(criterion: &Value, deliverable_keys: &HashMap<String, String>) -> Value {
    if let Some(manual) = criterion.get("manual") {
        return json!({ "manual": manual });
    }
    let key = criterion.text("key").unwrap_or_default();
    if is_deliverable_criterion(key) {
        let local = criterion
            .at("params")
            .text("deliverableId")
            .and_then(|id| deliverable_keys.get(id));
        let (Some(local), Some(params)) = (local, criterion.at("params").as_object()) else {
            return json!({ "manual": deliverable_criterion_text(key, None) });
        };
        let mut params = params.clone();
        params.remove("deliverableId");
        params.insert("deliverableKey".to_owned(), json!(local));
        return json!({ "key": key, "params": params });
    }
    if key == DECISION_CRITERION_KEY {
        return json!({ "manual": DECISION_CRITERION_TEXT });
    }
    if !GATE_CRITERION_KEYS.contains(&key) {
        return json!({ "manual": key });
    }
    match criterion
        .get("params")
        .filter(|params| truthy(Some(params)))
    {
        Some(params) => json!({ "key": criterion.at("key"), "params": params }),
        None => json!({ "key": criterion.at("key") }),
    }
}

fn raid_value(item: &Value, roles: &Roles) -> Value {
    let mut out = Map::new();
    for key in ["kind", "title", "description", "category"] {
        out.insert(key.to_owned(), item.at(key).clone());
    }
    out.insert("ownerRole".to_owned(), roles.of(item.text("ownerId")));
    for key in [
        "probability",
        "impact",
        "strategy",
        "trigger",
        "costImpact",
        "scheduleImpactDays",
        "reviewIntervalDays",
        "confidence",
        "ifWrong",
        "severity",
        "direction",
        "partyType",
        "partyName",
    ] {
        out.insert(key.to_owned(), item.at(key).clone());
    }
    Value::Object(out)
}

fn blueprint_settings(settings: &Value, roles: &Roles) -> Value {
    let mut out = Map::new();
    let schedule = settings.at("schedule");
    if schedule.is_object() {
        out.insert(
            "schedule".to_owned(),
            json!({
                "workingDays": schedule.at("workingDays"),
                "autoSchedule": schedule.at("autoSchedule"),
            }),
        );
    }
    let change = settings.at("changeControl");
    if change.is_object() {
        let board: Vec<&str> = change
            .items("boardMemberIds")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        out.insert(
            "changeControl".to_owned(),
            json!({
                "costLimit": change.at("costLimit"),
                "scheduleLimitDays": change.at("scheduleLimitDays"),
                "boardRoles": roles.unique(&board),
            }),
        );
    }
    let report = settings.at("statusReport");
    if report.is_object() {
        out.insert(
            "statusReport".to_owned(),
            json!({
                "cadence": report.at("cadence"),
                "weekday": report.at("weekday"),
                "hour": report.at("hour"),
                "recipientsRule": report.at("recipients").text("rule").unwrap_or("sponsor"),
            }),
        );
    }
    let plan = settings.items("communicationPlan");
    if !plan.is_empty() {
        let entries: Vec<Value> = plan
            .iter()
            .map(|entry| {
                json!({
                    "what": entry.at("what"), "audience": entry.at("audience"),
                    "cadence": entry.at("cadence"), "channel": entry.at("channel"),
                })
            })
            .collect();
        out.insert("communicationPlan".to_owned(), Value::Array(entries));
    }
    if let Some(appetite) = settings.get("riskAppetite").filter(|v| v.is_number()) {
        out.insert("riskAppetite".to_owned(), appetite.clone());
    }
    Value::Object(out)
}

// ── Create project: a blueprint into rows ───────────────────────────────────

/// What to copy from the template. Everything is copied unless turned off.
// The flags are the request's: one per section.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Copy)]
pub struct CopyOptions {
    pub phases: bool,
    pub milestones: bool,
    pub deliverables: bool,
    pub tasks: bool,
    pub stages: bool,
    pub raid: bool,
    pub change_control: bool,
    pub status_report: bool,
}

/// What the copy options default to (`resolveCopy`): everything.
pub fn resolve_copy(copy: Option<&Value>) -> CopyOptions {
    let on = |key: &str| {
        copy.and_then(|c| c.get(key))
            .and_then(Value::as_bool)
            .unwrap_or(true)
    };
    CopyOptions {
        phases: on("phases"),
        milestones: on("milestones"),
        deliverables: on("deliverables"),
        tasks: on("tasks"),
        stages: on("stages"),
        raid: on("raid"),
        change_control: on("changeControl"),
        status_report: on("statusReport"),
    }
}

/// The first refusal for the roles of a request: a role the template does not have.
pub fn instantiate_roles_error(blueprint: &Value, roles: &Map<String, Value>) -> Option<String> {
    let known: HashSet<&str> = blueprint
        .items("roles")
        .iter()
        .filter_map(|r| r.text("key"))
        .collect();
    roles
        .keys()
        .find(|role| !known.contains(role.as_str()))
        .map(|role| unknown_role_message(role))
}

/// The counter of a project's deliverables: scope `del:<projectId>`, prefix `D`.
pub fn deliverable_sequence(project_id: &str) -> NumberSequence {
    NumberSequence {
        scope: Cow::Owned(format!("del:{project_id}")),
        prefix: "D",
    }
}

/// How many workspace-wide task numbers the plan needs.
pub fn needed_task_numbers(blueprint: &Value, copy: &CopyOptions) -> i64 {
    if copy.tasks {
        i64::try_from(blueprint.items("tasks").len()).unwrap_or(0)
    } else {
        0
    }
}

/// What a plan is made from (`InstantiateContext`).
pub struct InstantiateContext<'a> {
    /// The id of the new project (made up front: the plan's counters are scoped by it).
    pub project_id: String,
    /// The member creating the project: reporter, owner member, and manager when no role names one.
    pub user_id: String,
    pub now_ms: i64,
    pub name: String,
    /// Midnight UTC of the start date.
    pub start_ms: i64,
    pub client_id: Option<String>,
    /// The person for each role key.
    pub roles: HashMap<String, String>,
    pub copy: CopyOptions,
    pub template_id: String,
    pub new_id: &'a dyn Fn(&str) -> String,
    /// The workspace-wide task numbers allocated for the plan, one per task.
    pub task_numbers: Vec<i64>,
}

/// Every row of the new project, camelCase.
#[derive(Debug)]
pub struct InstantiatePlan {
    pub project_id: String,
    pub end_ms: i64,
    pub project: Value,
    pub members: Vec<Value>,
    pub stages: Vec<Value>,
    pub phases: Vec<Value>,
    pub milestones: Vec<Value>,
    pub deliverables: Vec<Value>,
    pub tasks: Vec<Value>,
    pub dependencies: Vec<Value>,
    pub raid_items: Vec<Value>,
    pub assessments: Vec<Value>,
    /// The new project's own counters, set to the next free number.
    pub sequences: Vec<Value>,
    pub counts: Value,
}

fn member_rank(role: &str) -> i32 {
    match role {
        "owner" => 3,
        "admin" => 2,
        "member" => 1,
        _ => 0,
    }
}

fn known_role(role: &str) -> &'static str {
    BLUEPRINT_MEMBER_ROLES
        .iter()
        .find(|known| **known == role)
        .copied()
        .unwrap_or("member")
}

struct Planner<'a> {
    ctx: &'a InstantiateContext<'a>,
    blueprint: &'a Value,
    calendar: Vec<i64>,
    now: String,
}

impl Planner<'_> {
    fn id(&self, prefix: &str) -> String {
        (self.ctx.new_id)(prefix)
    }

    fn at(&self, offset: Option<i64>) -> Value {
        offset
            .and_then(|offset| {
                iso_from_millis(add_working_days(
                    self.ctx.start_ms,
                    offset,
                    Some(&self.calendar),
                ))
            })
            .map_or(Value::Null, Value::String)
    }

    fn person(&self, role: Option<&str>) -> Value {
        role.and_then(|role| self.ctx.roles.get(role))
            .map_or(Value::Null, |person| json!(person))
    }

    /// The creator owns the project; each role with a person joins as the template says.
    fn members(&self) -> Vec<Value> {
        let mut roles: Vec<(String, &str)> = vec![(self.ctx.user_id.clone(), "owner")];
        for role in self.blueprint.items("roles") {
            let Some(person) = role.text("key").and_then(|key| self.ctx.roles.get(key)) else {
                continue;
            };
            let Some(project_role) = role.text("projectRole") else {
                continue;
            };
            match roles.iter_mut().find(|(id, _)| id == person) {
                Some((_, current)) => {
                    if member_rank(project_role) > member_rank(current) {
                        *current = known_role(project_role);
                    }
                }
                None => roles.push((person.clone(), known_role(project_role))),
            }
        }
        roles
            .into_iter()
            .map(|(user, role)| {
                json!({
                    "id": self.id("pmem"), "projectId": self.ctx.project_id, "userId": user,
                    "role": role, "isActive": true, "joinedAt": self.now,
                    "createdAt": self.now, "updatedAt": self.now,
                })
            })
            .collect()
    }

    fn stages(&self) -> Vec<Value> {
        if !self.ctx.copy.stages {
            return Vec::new();
        }
        self.blueprint
            .items("stages")
            .iter()
            .enumerate()
            .map(|(index, stage)| {
                json!({
                    "id": self.id("stg"), "projectId": self.ctx.project_id, "name": stage.at("name"),
                    "color": stage.at("color"), "position": index, "systemStatus": stage.at("systemStatus"),
                    "createdAt": self.now, "updatedAt": self.now,
                })
            })
            .collect()
    }

    fn phases(&self) -> Vec<Value> {
        if !self.ctx.copy.phases {
            return Vec::new();
        }
        self.blueprint
            .items("phases")
            .iter()
            .enumerate()
            .map(|(index, phase)| {
                json!({
                    "id": self.id("phs"), "projectId": self.ctx.project_id, "position": index,
                    "name": phase.at("name"),
                    "plannedStart": self.at(phase.int("startOffset")),
                    "plannedEnd": self.at(phase.int("endOffset")),
                    // The project starts in its first phase.
                    "status": if index == 0 { "active" } else { "upcoming" },
                    // Resolved against the new deliverables once those are made, see resolve_gate_criteria.
                    "gateCriteria": [], "createdBy": self.ctx.user_id,
                    "createdAt": self.now, "updatedAt": self.now,
                })
            })
            .collect()
    }

    /// The phases with their gate criteria resolved against the new project's deliverables.
    fn resolve_gate_criteria(
        &self,
        mut phases: Vec<Value>,
        deliverable_ids: &HashMap<String, String>,
    ) -> Vec<Value> {
        let blueprint_phases = self.blueprint.items("phases");
        for (index, phase) in phases.iter_mut().enumerate() {
            let criteria: Vec<Value> = blueprint_phases
                .get(index)
                .map(|source| source.items("gateCriteria"))
                .unwrap_or_default()
                .iter()
                .map(|criterion| self.instantiate_criterion(criterion, deliverable_ids))
                .collect();
            phase["gateCriteria"] = Value::Array(criteria);
        }
        phases
    }

    /// A blueprint criterion as a phase row of the new project holds it: a
    /// deliverable key becomes the new deliverable's id; with the deliverables
    /// not copied, or for a decision, it is a manual criterion.
    fn instantiate_criterion(
        &self,
        criterion: &Value,
        deliverable_ids: &HashMap<String, String>,
    ) -> Value {
        if let Some(manual) = criterion.text("manual") {
            return json!({ "manual": manual, "met": false, "metAt": null });
        }
        let key = criterion.text("key").unwrap_or_default();
        if key == DECISION_CRITERION_KEY {
            return json!({ "manual": DECISION_CRITERION_TEXT, "met": false, "metAt": null });
        }
        if !is_deliverable_criterion(key) {
            return criterion.clone();
        }
        let local = deliverable_key_of(criterion.at("params"));
        let Some(id) = local.and_then(|local| deliverable_ids.get(local)) else {
            let title = self
                .blueprint
                .items("deliverables")
                .iter()
                .find(|d| d.text("key") == local)
                .and_then(|d| d.text("title"));
            return json!({
                "manual": deliverable_criterion_text(key, title), "met": false, "metAt": null
            });
        };
        let mut params = criterion
            .at("params")
            .as_object()
            .cloned()
            .unwrap_or_default();
        params.remove("deliverableKey");
        params.insert("deliverableId".to_owned(), json!(id));
        json!({ "key": key, "params": params })
    }

    fn milestones(&self) -> (Vec<Value>, HashMap<String, String>) {
        let mut ids = HashMap::new();
        if !self.ctx.copy.milestones {
            return (Vec::new(), ids);
        }
        let rows = self
            .blueprint
            .items("milestones")
            .iter()
            .map(|milestone| {
                let id = self.id("ms");
                ids.insert(
                    milestone.text("key").unwrap_or_default().to_owned(),
                    id.clone(),
                );
                json!({
                    "id": id, "projectId": self.ctx.project_id, "name": milestone.at("name"),
                    "description": milestone.at("description"),
                    "dueDate": self.at(Some(milestone.int("offset").unwrap_or(0))),
                    "status": "pending", "progress": "0",
                    "ownerId": self.person(milestone.text("ownerRole")),
                    "isKeyMilestone": milestone.at("isKey"),
                    "createdAt": self.now, "updatedAt": self.now,
                })
            })
            .collect();
        (rows, ids)
    }

    fn deliverables(&self) -> (Vec<Value>, HashMap<String, String>) {
        let mut ids = HashMap::new();
        if !self.ctx.copy.deliverables {
            return (Vec::new(), ids);
        }
        let rows = self
            .blueprint
            .items("deliverables")
            .iter()
            .enumerate()
            .map(|(index, d)| {
                let id = self.id("dlv");
                ids.insert(d.text("key").unwrap_or_default().to_owned(), id.clone());
                let criteria: Vec<Value> = d
                    .items("acceptanceCriteria")
                    .iter()
                    .map(|text| json!({ "text": text, "met": false, "metAt": null }))
                    .collect();
                json!({
                    "id": id, "projectId": self.ctx.project_id, "number": index + 1,
                    "title": d.at("title"), "description": d.at("description"),
                    "ownerId": self.person(d.text("ownerRole")), "status": "not_started",
                    "plannedStart": self.at(d.int("startOffset")),
                    "plannedEnd": self.at(d.int("endOffset")),
                    "acceptanceCriteria": criteria, "position": index,
                    "clientVisible": d.at("clientVisible"),
                    "createdBy": self.ctx.user_id, "createdAt": self.now, "updatedAt": self.now,
                })
            })
            .collect();
        (rows, ids)
    }
}

/// The column a new task of this status lands in: its own, else the neighbour, else the first.
fn stage_for(stages: &[Value], status: &str) -> Value {
    let by_status = |wanted: &str| {
        stages
            .iter()
            .find(|stage| stage.text("systemStatus") == Some(wanted))
            .map(|stage| stage.at("id").clone())
    };
    let found = if status == "backlog" {
        by_status("backlog").or_else(|| by_status("todo"))
    } else {
        by_status("todo").or_else(|| by_status("backlog"))
    };
    found
        .or_else(|| stages.first().map(|stage| stage.at("id").clone()))
        .unwrap_or(Value::Null)
}

type Ids = HashMap<String, String>;

fn plan_tasks(
    p: &Planner<'_>,
    stages: &[Value],
    milestone_ids: &Ids,
    deliverable_ids: &Ids,
) -> (Vec<Value>, Vec<Value>) {
    if !p.ctx.copy.tasks {
        return (Vec::new(), Vec::new());
    }
    let blueprint_tasks = p.blueprint.items("tasks");
    let task_ids: HashMap<&str, String> = blueprint_tasks
        .iter()
        .map(|task| (task.text("key").unwrap_or_default(), p.id("task")))
        .collect();
    let mut depends_on: HashMap<String, Vec<String>> = HashMap::new();
    let mut blocks: HashMap<String, Vec<String>> = HashMap::new();
    let mut dependencies = Vec::new();
    for dependency in p.blueprint.items("dependencies") {
        let (Some(predecessor), Some(successor)) = (
            dependency.text("predecessor").and_then(|k| task_ids.get(k)),
            dependency.text("successor").and_then(|k| task_ids.get(k)),
        ) else {
            continue;
        };
        dependencies.push(json!({
            "id": p.id("tdp"), "projectId": p.ctx.project_id, "predecessorId": predecessor,
            "successorId": successor, "type": dependency.at("type"), "lagDays": dependency.at("lagDays"),
            "createdBy": p.ctx.user_id, "createdAt": p.now, "updatedAt": p.now,
        }));
        depends_on
            .entry(successor.clone())
            .or_default()
            .push(predecessor.clone());
        blocks
            .entry(predecessor.clone())
            .or_default()
            .push(successor.clone());
    }
    let lookup = |key: Option<&str>, map: &Ids| {
        key.and_then(|key| map.get(key))
            .map_or(Value::Null, |id| json!(id))
    };
    let tasks = blueprint_tasks
        .iter()
        .enumerate()
        .map(|(index, task)| {
            let id = task_ids.get(task.text("key").unwrap_or_default()).cloned().unwrap_or_default();
            let mut assignees: Vec<&String> = Vec::new();
            for role in task.items("assigneeRoles").iter().filter_map(Value::as_str) {
                if let Some(person) = p.ctx.roles.get(role)
                    && !assignees.contains(&person)
                {
                    assignees.push(person);
                }
            }
            let status = task.text("status").unwrap_or("todo");
            json!({
                "id": id, "number": p.ctx.task_numbers.get(index), "projectId": p.ctx.project_id,
                "title": task.at("title"), "description": task.at("description"), "status": status,
                "stageId": stage_for(stages, status), "priority": task.at("priority"),
                "type": task.at("type"), "assigneeId": assignees.first(),
                "assigneeIds": if assignees.is_empty() { Value::Null } else { json!(assignees) },
                "reporterId": p.ctx.user_id,
                "parentTaskId": task.text("parentKey").and_then(|key| task_ids.get(key)),
                "milestoneId": lookup(task.text("milestoneKey"), milestone_ids),
                "deliverableId": lookup(task.text("deliverableKey"), deliverable_ids),
                "startDate": p.at(task.int("startOffset")), "dueDate": p.at(task.int("dueOffset")),
                "estimatedHours": task.at("estimatedHours"), "storyPoints": task.at("storyPoints"),
                "labels": task.at("labels"), "tags": task.at("tags"), "isBillable": task.at("isBillable"),
                "dependsOn": depends_on.get(&id), "blocks": blocks.get(&id),
                "position": index + 1, "progress": "0", "createdAt": p.now, "updatedAt": p.now,
            })
        })
        .collect();
    (tasks, dependencies)
}

fn plan_raid(p: &Planner<'_>) -> (Vec<Value>, Vec<Value>) {
    let mut items = Vec::new();
    let mut assessments = Vec::new();
    if !p.ctx.copy.raid {
        return (items, assessments);
    }
    let mut used: HashMap<&str, i64> = HashMap::new();
    for item in p.blueprint.items("raid") {
        let Some(kind) = item.text("kind").and_then(RaidKind::parse) else {
            continue;
        };
        let number = {
            let count = used.entry(kind.as_str()).or_insert(0);
            *count += 1;
            *count
        };
        let id = p.id("raid");
        let mut row = Map::new();
        for (key, value) in [
            ("id", json!(id)),
            ("projectId", json!(p.ctx.project_id)),
            ("kind", json!(kind.as_str())),
            ("number", json!(number)),
            ("title", item.at("title").clone()),
            ("description", item.at("description").clone()),
            ("status", json!(initial_raid_status(kind))),
            ("category", item.at("category").clone()),
            ("ownerId", p.person(item.text("ownerRole"))),
            ("closedAt", Value::Null),
            ("customFields", Value::Null),
            ("createdBy", json!(p.ctx.user_id)),
            ("createdAt", json!(p.now)),
            ("updatedAt", json!(p.now)),
        ] {
            row.insert(key.to_owned(), value);
        }
        let copy_keys = |row: &mut Map<String, Value>, keys: &[&str]| {
            for key in keys {
                row.insert((*key).to_owned(), item.at(key).clone());
            }
        };
        match kind {
            RaidKind::Risk => {
                let (Some(probability), Some(impact)) =
                    (item.int("probability"), item.int("impact"))
                else {
                    continue;
                };
                let band = risk_score(probability, impact)
                    .and_then(risk_band)
                    .unwrap_or(RiskBand::Low);
                let due = iso_from_millis(next_review_at_ms(
                    p.ctx.now_ms,
                    band,
                    item.int("reviewIntervalDays"),
                ));
                row.insert("dueAt".to_owned(), json!(due));
                copy_keys(
                    &mut row,
                    &[
                        "probability",
                        "impact",
                        "strategy",
                        "trigger",
                        "costImpact",
                        "scheduleImpactDays",
                        "reviewIntervalDays",
                    ],
                );
                // A risk's first assessment is its creation: the start of the trend.
                assessments.push(json!({
                    "id": p.id("rasm"), "itemId": id, "projectId": p.ctx.project_id,
                    "probability": probability, "impact": impact, "residualProbability": null,
                    "residualImpact": null, "note": null, "assessedBy": p.ctx.user_id,
                    "assessedAt": p.now,
                }));
            }
            RaidKind::Assumption => copy_keys(&mut row, &["confidence", "ifWrong"]),
            RaidKind::Issue => {
                row.insert(
                    "severity".to_owned(),
                    json!(item.text("severity").unwrap_or("medium")),
                );
            }
            RaidKind::Dependency => copy_keys(&mut row, &["direction", "partyType", "partyName"]),
        }
        items.push(Value::Object(row));
    }
    (items, assessments)
}

fn plan_settings(p: &Planner<'_>, phases: &[Value]) -> Value {
    let blueprint_settings = p.blueprint.at("settings");
    let copy = &p.ctx.copy;
    let mut settings = Map::new();
    settings.insert("templateId".to_owned(), json!(p.ctx.template_id));
    let schedule = blueprint_settings.at("schedule");
    if schedule.is_object() {
        settings.insert(
            "schedule".to_owned(),
            json!({
                "workingDays": schedule.at("workingDays"), "holidays": [],
                "autoSchedule": schedule.at("autoSchedule"),
            }),
        );
    }
    let change = blueprint_settings.at("changeControl");
    if copy.change_control && change.is_object() {
        let mut board: Vec<Value> = Vec::new();
        for role in change.items("boardRoles").iter().filter_map(Value::as_str) {
            let person = p.person(Some(role));
            if !person.is_null() && !board.contains(&person) {
                board.push(person);
            }
        }
        settings.insert(
            "changeControl".to_owned(),
            json!({
                "costLimit": change.at("costLimit"),
                "scheduleLimitDays": change.at("scheduleLimitDays"),
                "boardMemberIds": board,
            }),
        );
    }
    let report = blueprint_settings.at("statusReport");
    if copy.status_report && report.is_object() {
        settings.insert(
            "statusReport".to_owned(),
            json!({
                "cadence": report.at("cadence"), "weekday": report.at("weekday"),
                "hour": report.at("hour"), "recipients": { "rule": report.at("recipientsRule") },
            }),
        );
        if let Some(plan) = blueprint_settings
            .get("communicationPlan")
            .filter(|v| v.is_array())
        {
            settings.insert("communicationPlan".to_owned(), plan.clone());
        }
    }
    if let Some(appetite) = blueprint_settings
        .get("riskAppetite")
        .filter(|v| v.is_number())
    {
        settings.insert("riskAppetite".to_owned(), appetite.clone());
    }
    let sponsor = p.person(Some(SPONSOR_ROLE));
    if !sponsor.is_null() {
        settings.insert("sponsorId".to_owned(), sponsor);
    }
    if let Some(first) = phases.first() {
        settings.insert("currentPhaseId".to_owned(), first.at("id").clone());
    }
    Value::Object(settings)
}

fn plan_project(p: &Planner<'_>, phases: &[Value], end_ms: i64) -> Value {
    let manager = match p.person(Some(PROJECT_MANAGER_ROLE)) {
        Value::Null => json!(p.ctx.user_id),
        person => person,
    };
    let mut row = project_attributes(p.blueprint.at("project"));
    if let Some(row) = row.as_object_mut() {
        for (key, value) in [
            ("id", json!(p.ctx.project_id)),
            ("name", json!(p.ctx.name)),
            ("status", json!("Planning")),
            ("customerId", json!(p.ctx.client_id)),
            ("projectManagerId", manager),
            ("startDate", json!(iso_from_millis(p.ctx.start_ms))),
            ("endDate", json!(iso_from_millis(end_ms))),
            ("settings", plan_settings(p, phases)),
            ("createdAt", json!(p.now)),
            ("updatedAt", json!(p.now)),
        ] {
            row.insert(key.to_owned(), value);
        }
    }
    row
}

fn plan_sequences(p: &Planner<'_>, deliverables: usize, raid_items: &[Value]) -> Vec<Value> {
    let mut sequences = Vec::new();
    let mut add = |sequence: &NumberSequence, used: usize| {
        if used > 0 {
            sequences.push(json!({
                "id": p.id("seq"), "scope": sequence.scope, "prefix": sequence.prefix,
                "nextValue": used + 1, "createdAt": p.now, "updatedAt": p.now,
            }));
        }
    };
    add(&deliverable_sequence(&p.ctx.project_id), deliverables);
    for kind in RaidKind::ALL {
        let used = raid_items
            .iter()
            .filter(|item| item.text("kind") == Some(kind.as_str()))
            .count();
        add(&raid_sequence(kind, &p.ctx.project_id), used);
    }
    sequences
}

/// Every row of the new project (`planInstantiation`). Dates are counted in
/// working days from the start on the template's calendar; people come from
/// the roles; ids are made with `new_id`; numbers are the ones allocated for
/// the plan. Rows the copy options leave out are not made, and references to
/// them are left empty.
pub fn plan_instantiation(blueprint: &Value, ctx: &InstantiateContext<'_>) -> InstantiatePlan {
    let planner = Planner {
        ctx,
        blueprint,
        calendar: working_days_of(blueprint.at("settings")),
        now: iso_from_millis(ctx.now_ms).unwrap_or_default(),
    };
    let end_ms = add_working_days(
        ctx.start_ms,
        blueprint.int("durationDays").unwrap_or(0),
        Some(&planner.calendar),
    );
    let members = planner.members();
    let stages = planner.stages();
    let phase_rows = planner.phases();
    let (milestones, milestone_ids) = planner.milestones();
    let (deliverables, deliverable_ids) = planner.deliverables();
    let phases = planner.resolve_gate_criteria(phase_rows, &deliverable_ids);
    let (tasks, dependencies) = plan_tasks(&planner, &stages, &milestone_ids, &deliverable_ids);
    let (raid_items, assessments) = plan_raid(&planner);
    let project = plan_project(&planner, &phases, end_ms);
    let sequences = plan_sequences(&planner, deliverables.len(), &raid_items);
    let counts = json!({
        "members": members.len(), "stages": stages.len(), "phases": phases.len(),
        "milestones": milestones.len(), "deliverables": deliverables.len(), "tasks": tasks.len(),
        "dependencies": dependencies.len(), "raidItems": raid_items.len(),
    });
    InstantiatePlan {
        project_id: ctx.project_id.clone(),
        end_ms,
        project,
        members,
        stages,
        phases,
        milestones,
        deliverables,
        tasks,
        dependencies,
        raid_items,
        assessments,
        sequences,
        counts,
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    fn at(date: &str) -> i64 {
        crate::js::js_date_millis(&format!("{date}T00:00:00.000Z")).expect("a date")
    }

    fn iso(date: &str) -> String {
        format!("{date}T00:00:00.000Z")
    }

    fn source() -> BlueprintSource {
        let now = "2026-12-01T08:00:00.000Z";
        BlueprintSource {
            project: json!({
                "id": "prj_src", "projectManagerId": "admin", "startDate": iso("2027-01-11"), "endDate": iso("2027-02-05"),
                "type": "software", "methodology": "agile", "priority": "high", "visibility": null, "color": null, "icon": null,
                "budgetCurrency": "EUR", "billingMethod": null, "isBillable": true, "trackTime": true,
                "settings": {
                    "sponsorId": "sponsor",
                    "changeControl": { "costLimit": 8000, "scheduleLimitDays": 3, "boardMemberIds": ["sponsor", "admin"] },
                    "statusReport": { "cadence": "biweekly", "weekday": 5, "hour": 15, "recipients": { "rule": "all_stakeholders" } },
                    "schedule": { "workingDays": [1, 2, 3, 4, 5], "holidays": [], "autoSchedule": true },
                    "riskAppetite": 12,
                },
            }),
            members: vec![
                json!({ "id": "pm1", "userId": "admin", "role": "owner", "joinedAt": "2026-12-01T08:00:00.000Z" }),
                json!({ "id": "pm2", "userId": "dev", "role": "member", "joinedAt": "2026-12-01T08:00:00.001Z" }),
                json!({ "id": "pm3", "userId": "viewer", "role": "viewer", "joinedAt": "2026-12-01T08:00:00.002Z" }),
            ],
            stages: vec![
                json!({ "id": "s1", "name": "Backlog", "color": "#94a3b8", "position": 0, "systemStatus": "backlog" }),
                json!({ "id": "s2", "name": "To Do", "color": null, "position": 1, "systemStatus": "todo" }),
            ],
            phases: vec![
                json!({ "id": "ph1", "position": 0, "name": "Build", "plannedStart": iso("2027-01-11"), "plannedEnd": iso("2027-01-22"),
                    "gateCriteria": [
                        { "key": "deliverable_accepted", "params": { "deliverableId": "dl1" } },
                        { "key": "deliverable_tasks_done", "params": { "deliverableId": "dl_gone" } },
                        { "key": "decision_decided", "params": { "decisionId": "dec1" } },
                        { "key": "no_open_risk_above", "params": { "band": "high" } },
                        { "manual": "Design signed", "met": true, "metAt": "2027-01-20T00:00:00.000Z" },
                    ] }),
                json!({ "id": "ph2", "position": 1, "name": "Go-live", "plannedStart": iso("2027-01-25"), "plannedEnd": iso("2027-02-05"), "gateCriteria": [] }),
            ],
            milestones: vec![
                json!({ "id": "ms1", "name": "Design signed off", "description": null, "dueDate": iso("2027-01-15"), "ownerId": "sponsor", "isKeyMilestone": true }),
            ],
            deliverables: vec![
                json!({ "id": "dl1", "number": 4, "position": 0, "title": "Ordering", "description": "Place orders", "ownerId": "dev",
                "plannedStart": iso("2027-01-12"), "plannedEnd": iso("2027-01-29"),
                "acceptanceCriteria": [{ "text": "Checkout works", "met": true, "metAt": "2027-01-28T00:00:00.000Z" }], "clientVisible": true }),
            ],
            tasks: vec![
                json!({ "id": "t1", "position": 1, "title": "Build ordering", "status": "in_progress", "priority": "medium", "type": null,
                    "assigneeId": "dev", "startDate": iso("2027-01-11"), "dueDate": iso("2027-01-15"), "milestoneId": "ms1", "deliverableId": "dl1",
                    "estimatedHours": "16.00", "isBillable": true }),
                json!({ "id": "t2", "position": 2, "title": "Write tests", "status": "backlog", "priority": "medium", "parentTaskId": "t1",
                    "assigneeIds": ["dev", "viewer"], "isBillable": true }),
                json!({ "id": "t3", "position": 3, "title": "Release", "status": "in_progress", "priority": "critical", "dueDate": iso("2027-02-05"),
                    "dependsOn": ["t1"], "isBillable": true }),
                json!({ "id": "t4", "position": 4, "title": "Dropped idea", "status": "cancelled", "priority": "medium", "isBillable": true }),
            ],
            dependencies: vec![
                json!({ "id": "dep1", "predecessorId": "t2", "successorId": "t3", "type": "ss", "lagDays": 2, "createdAt": now }),
            ],
            raid_items: vec![
                json!({ "id": "r1", "kind": "risk", "number": 1, "title": "Data migration loses history", "status": "mitigating", "ownerId": "dev",
                    "probability": 3, "impact": 4, "strategy": "mitigate", "reviewIntervalDays": 14, "costImpact": "5000.00", "closedAt": null }),
                json!({ "id": "r2", "kind": "issue", "number": 1, "title": "Build is red", "status": "resolved", "severity": "high", "closedAt": now }),
                json!({ "id": "r3", "kind": "assumption", "number": 1, "title": "Client supplies content", "status": "open", "ownerId": "sponsor",
                    "confidence": "medium", "ifWrong": "Launch slips", "closedAt": null }),
            ],
        }
    }

    fn labels() -> Labels {
        HashMap::from([
            ("member_1".to_owned(), "Tech lead".to_owned()),
            ("sponsor".to_owned(), "Executive sponsor".to_owned()),
        ])
    }

    #[test]
    fn a_project_becomes_a_blueprint_with_offsets_roles_and_keys() {
        let blueprint = build_blueprint(&source(), &labels());
        assert_eq!(
            blueprint["roles"],
            json!([
                { "key": "project_manager", "label": "Project manager", "projectRole": "owner" },
                { "key": "sponsor", "label": "Executive sponsor", "projectRole": null },
                { "key": "member_1", "label": "Tech lead", "projectRole": "member" },
                { "key": "member_2", "label": "Team member 2", "projectRole": "viewer" },
            ])
        );
        let tasks: Vec<(String, i64, i64)> = blueprint["tasks"]
            .as_array()
            .expect("tasks")
            .iter()
            .map(|t| {
                (
                    t["key"].as_str().unwrap_or_default().to_owned(),
                    t.int("startOffset").unwrap_or(-99),
                    t.int("dueOffset").unwrap_or(-99),
                )
            })
            .collect();
        assert_eq!(
            tasks,
            [
                ("t1".to_owned(), 0, 4),
                ("t2".to_owned(), -99, -99),
                ("t3".to_owned(), -99, 19)
            ]
        );
        assert_eq!(blueprint["durationDays"], 19);
        assert_eq!(blueprint["tasks"][0]["type"], "task");
        assert_eq!(
            blueprint["tasks"][1]["assigneeRoles"],
            json!(["member_1", "member_2"])
        );
        assert_eq!(blueprint["tasks"][1]["parentKey"], "t1");
        assert_eq!(blueprint["tasks"][0]["milestoneKey"], "m1");
        assert_eq!(
            blueprint["dependencies"],
            json!([
                { "predecessor": "t2", "successor": "t3", "type": "ss", "lagDays": 2 },
                { "predecessor": "t1", "successor": "t3", "type": "fs", "lagDays": 0 },
            ])
        );
        assert_eq!(blueprint["raid"].as_array().map(Vec::len), Some(2));
        assert_eq!(blueprint["raid"][0]["kind"], "risk");
        assert_eq!(
            blueprint["phases"][0]["gateCriteria"],
            json!([
                { "key": "deliverable_accepted", "params": { "deliverableKey": "d1" } },
                { "manual": "Deliverable tasks done" },
                { "manual": "Decision decided" },
                { "key": "no_open_risk_above", "params": { "band": "high" } },
                { "manual": "Design signed" },
            ])
        );
        assert_eq!(
            blueprint["settings"]["changeControl"]["boardRoles"],
            json!(["sponsor", "project_manager"])
        );
        let text = blueprint.to_string();
        assert!(!text.contains("prj_src") && !text.contains("\"dev\""));
        // What the builder makes is something the schema and the rules accept.
        assert!(read_blueprint(&blueprint).is_ok());
    }

    #[test]
    fn a_circle_in_the_source_is_dropped() {
        let mut source = source();
        source.dependencies.push(json!({ "id": "dep2", "predecessorId": "t3", "successorId": "t2", "type": "fs", "lagDays": 0, "createdAt": "2026-12-02T00:00:00.000Z" }));
        let blueprint = build_blueprint(&source, &HashMap::new());
        assert_eq!(blueprint["dependencies"].as_array().map(Vec::len), Some(2));
        assert_eq!(blueprint_integrity_error(&blueprint), None);
    }

    #[test]
    fn reading_refuses_what_it_cannot_use() {
        assert_eq!(
            read_blueprint(&json!({ "version": 0 })),
            Err(UNSUPPORTED_VERSION)
        );
        assert_eq!(
            read_blueprint(&json!({ "version": 7 })),
            Err(UNSUPPORTED_VERSION)
        );
        assert_eq!(read_blueprint(&json!("x")), Err(UNSUPPORTED_VERSION));
        assert_eq!(
            read_blueprint(&json!({ "version": 1 })),
            Err(INVALID_BLUEPRINT)
        );
    }

    #[test]
    fn copy_options_default_to_everything() {
        let all = resolve_copy(None);
        assert!(
            all.phases
                && all.milestones
                && all.deliverables
                && all.tasks
                && all.stages
                && all.raid
                && all.change_control
                && all.status_report
        );
        let some = resolve_copy(Some(&json!({ "tasks": false, "raid": false })));
        assert!(!some.tasks && !some.raid && some.phases);
        let roles = json!({ "ghost": "x" });
        let blueprint = build_blueprint(&source(), &HashMap::new());
        assert_eq!(
            instantiate_roles_error(&blueprint, roles.as_object().expect("object")).as_deref(),
            Some("The template has no role 'ghost'")
        );
        assert_eq!(needed_task_numbers(&blueprint, &all), 3);
        assert_eq!(needed_task_numbers(&blueprint, &some), 0);
    }

    fn plan(copy: CopyOptions, people: &[(&str, &str)]) -> InstantiatePlan {
        let blueprint = build_blueprint(&source(), &labels());
        let counter = Cell::new(0_u32);
        let new_id = |prefix: &str| {
            counter.set(counter.get() + 1);
            format!("{prefix}_{}", counter.get())
        };
        plan_instantiation(
            &blueprint,
            &InstantiateContext {
                project_id: "prj_new".to_owned(),
                user_id: "creator".to_owned(),
                now_ms: at("2027-03-01"),
                name: "Supplier Portal".to_owned(),
                start_ms: at("2027-03-03"),
                client_id: Some("cmp_1".to_owned()),
                roles: people
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                    .collect(),
                copy,
                template_id: "tpl_1".to_owned(),
                new_id: &new_id,
                task_numbers: vec![101, 102, 103],
            },
        )
    }

    const PEOPLE: [(&str, &str); 3] = [
        ("project_manager", "new_pm"),
        ("sponsor", "new_sponsor"),
        ("member_1", "new_dev"),
    ];

    #[allow(clippy::too_many_lines)] // one assertion per row of the plan
    #[test]
    fn a_plan_counts_dates_in_working_days_from_the_start() {
        let plan = plan(resolve_copy(None), &PEOPLE);
        assert_eq!(plan.project["startDate"], iso("2027-03-03"));
        assert_eq!(plan.project["endDate"], iso("2027-03-30"));
        assert_eq!(plan.project["status"], "Planning");
        assert_eq!(plan.project["projectManagerId"], "new_pm");
        assert_eq!(plan.project["customerId"], "cmp_1");
        assert_eq!(
            plan.counts,
            json!({ "members": 3, "stages": 2, "phases": 2, "milestones": 1, "deliverables": 1, "tasks": 3, "dependencies": 2, "raidItems": 2 })
        );
        let roles: Vec<(&str, &str)> = plan
            .members
            .iter()
            .map(|m| {
                (
                    m.text("userId").unwrap_or_default(),
                    m.text("role").unwrap_or_default(),
                )
            })
            .collect();
        assert_eq!(
            roles,
            [
                ("creator", "owner"),
                ("new_pm", "owner"),
                ("new_dev", "member")
            ]
        );
        assert_eq!(plan.phases[0]["status"], "active");
        assert_eq!(plan.phases[1]["status"], "upcoming");
        assert_eq!(plan.phases[0]["plannedEnd"], iso("2027-03-16"));
        assert_eq!(plan.phases[1]["plannedStart"], iso("2027-03-17"));
        // The deliverable criterion points at the new deliverable, not the source project's.
        assert_eq!(
            plan.phases[0]["gateCriteria"],
            json!([
                { "key": "deliverable_accepted", "params": { "deliverableId": plan.deliverables[0]["id"] } },
                { "manual": "Deliverable tasks done", "met": false, "metAt": null },
                { "manual": "Decision decided", "met": false, "metAt": null },
                { "key": "no_open_risk_above", "params": { "band": "high" } },
                { "manual": "Design signed", "met": false, "metAt": null },
            ])
        );
        assert_eq!(plan.milestones[0]["dueDate"], iso("2027-03-09"));
        assert_eq!(plan.milestones[0]["ownerId"], "new_sponsor");
        assert_eq!(plan.tasks[0]["startDate"], iso("2027-03-03"));
        assert_eq!(plan.tasks[0]["dueDate"], iso("2027-03-09"));
        assert_eq!(plan.tasks[2]["dueDate"], iso("2027-03-30"));
        assert_eq!(plan.tasks[0]["number"], 101);
        assert_eq!(plan.tasks[2]["number"], 103);
        assert_eq!(plan.tasks[0]["assigneeId"], "new_dev");
        assert_eq!(plan.tasks[1]["parentTaskId"], plan.tasks[0]["id"]);
        assert_eq!(plan.tasks[0]["stageId"], plan.stages[1]["id"]);
        assert_eq!(plan.tasks[1]["stageId"], plan.stages[0]["id"]);
        assert_eq!(
            plan.tasks[0]["blocks"],
            json!([plan.tasks[2]["id"].clone()])
        );
        assert_eq!(plan.tasks[2]["assigneeId"], Value::Null);
        assert_eq!(plan.tasks[2]["assigneeIds"], Value::Null);
        assert_eq!(plan.deliverables[0]["number"], 1);
        assert_eq!(plan.deliverables[0]["status"], "not_started");
        assert_eq!(
            plan.deliverables[0]["acceptanceCriteria"],
            json!([{ "text": "Checkout works", "met": false, "metAt": null }])
        );
        assert_eq!(plan.deliverables[0]["createdBy"], "creator");
        let kinds: Vec<(&str, i64, &str)> = plan
            .raid_items
            .iter()
            .map(|i| {
                (
                    i.text("kind").unwrap_or_default(),
                    i.int("number").unwrap_or(0),
                    i.text("status").unwrap_or_default(),
                )
            })
            .collect();
        assert_eq!(
            kinds,
            [("risk", 1, "identified"), ("assumption", 1, "open")]
        );
        assert_eq!(plan.raid_items[0]["dueAt"], "2027-03-15T00:00:00.000Z");
        assert_eq!(plan.assessments.len(), 1);
        assert_eq!(plan.assessments[0]["itemId"], plan.raid_items[0]["id"]);
        let scopes: Vec<(String, i64)> = plan
            .sequences
            .iter()
            .map(|s| {
                (
                    s.text("scope").unwrap_or_default().to_owned(),
                    s.int("nextValue").unwrap_or(0),
                )
            })
            .collect();
        assert_eq!(
            scopes,
            [
                ("del:prj_new".to_owned(), 2),
                ("rsk:prj_new".to_owned(), 2),
                ("asm:prj_new".to_owned(), 2)
            ]
        );
        assert_eq!(
            plan.project["settings"],
            json!({
                "templateId": "tpl_1", "sponsorId": "new_sponsor", "currentPhaseId": plan.phases[0]["id"].clone(),
                "changeControl": { "costLimit": 8000, "scheduleLimitDays": 3, "boardMemberIds": ["new_sponsor", "new_pm"] },
                "statusReport": { "cadence": "biweekly", "weekday": 5, "hour": 15, "recipients": { "rule": "all_stakeholders" } },
                "schedule": { "workingDays": [1, 2, 3, 4, 5], "holidays": [], "autoSchedule": true },
                "riskAppetite": 12,
            })
        );
    }

    #[test]
    fn a_deliverable_criterion_turns_manual_when_the_deliverables_are_not_copied() {
        let plan = plan(
            CopyOptions {
                deliverables: false,
                ..resolve_copy(None)
            },
            &PEOPLE,
        );
        assert_eq!(
            plan.phases[0]["gateCriteria"][0],
            json!({ "manual": "Deliverable accepted: Ordering", "met": false, "metAt": null })
        );
        assert_eq!(
            plan.phases[0]["gateCriteria"][1],
            json!({ "manual": "Deliverable tasks done", "met": false, "metAt": null })
        );
    }

    #[test]
    fn the_integrity_rules_refuse_gate_criteria_a_blueprint_cannot_resolve() {
        let valid = build_blueprint(&source(), &HashMap::new());
        let with = |criteria: Value| {
            let mut blueprint = valid.clone();
            blueprint["phases"][0]["gateCriteria"] = criteria;
            blueprint_integrity_error(&blueprint)
        };
        assert_eq!(
            with(json!([{ "key": "deliverable_accepted", "params": { "deliverableKey": "d9" } }])),
            Some("Phase p1 refers to an unknown deliverable: d9".to_owned())
        );
        assert_eq!(
            with(
                json!([{ "key": "deliverable_tasks_done", "params": { "deliverableId": "dl1" } }])
            ),
            Some(
                "Phase p1 has a deliverable_tasks_done criterion without a deliverableKey"
                    .to_owned()
            )
        );
        assert_eq!(
            with(json!([{ "key": "decision_decided", "params": { "decisionId": "dec1" } }])),
            Some(
                "Phase p1 has a gate criterion a template cannot carry: decision_decided"
                    .to_owned()
            )
        );
        assert_eq!(
            with(json!([{ "key": "made_up" }])),
            Some("Phase p1 has an unknown gate criterion: made_up".to_owned())
        );
    }

    #[test]
    fn reading_upgrades_criteria_stored_with_the_source_ids() {
        let mut stored = build_blueprint(&source(), &HashMap::new());
        stored["phases"][0]["gateCriteria"] = json!([
            { "key": "deliverable_accepted", "params": { "deliverableId": "dl1" } },
            { "key": "deliverable_tasks_done", "params": { "deliverableKey": "d1" } },
            { "key": "decision_decided", "params": { "decisionId": "dec1" } },
            { "key": "made_up" },
            { "key": "no_change_request_pending" },
        ]);
        let read = read_blueprint(&stored).expect("readable");
        assert_eq!(
            read["phases"][0]["gateCriteria"],
            json!([
                { "manual": "Deliverable accepted" },
                { "key": "deliverable_tasks_done", "params": { "deliverableKey": "d1" } },
                { "manual": "Decision decided" },
                { "manual": "made_up" },
                { "key": "no_change_request_pending" },
            ])
        );
    }

    #[test]
    fn the_copy_options_leave_rows_and_references_out() {
        let lean = CopyOptions {
            phases: false,
            milestones: false,
            deliverables: false,
            tasks: false,
            stages: false,
            raid: false,
            change_control: false,
            status_report: false,
        };
        let lean = plan(lean, &PEOPLE);
        assert_eq!(
            lean.counts,
            json!({ "members": 3, "stages": 0, "phases": 0, "milestones": 0, "deliverables": 0, "tasks": 0, "dependencies": 0, "raidItems": 0 })
        );
        assert_eq!(lean.sequences.len(), 0);
        assert_eq!(
            lean.project["settings"],
            json!({ "templateId": "tpl_1", "sponsorId": "new_sponsor",
                "schedule": { "workingDays": [1, 2, 3, 4, 5], "holidays": [], "autoSchedule": true }, "riskAppetite": 12 })
        );
        let tasks_only = plan(
            CopyOptions {
                phases: true,
                milestones: false,
                deliverables: false,
                tasks: true,
                stages: false,
                raid: false,
                change_control: true,
                status_report: true,
            },
            &PEOPLE,
        );
        assert_eq!(tasks_only.tasks[0]["milestoneId"], Value::Null);
        assert_eq!(tasks_only.tasks[0]["deliverableId"], Value::Null);
        assert_eq!(tasks_only.tasks[0]["stageId"], Value::Null);
    }

    #[test]
    fn without_roles_the_creator_manages() {
        let plan = plan(
            CopyOptions {
                tasks: false,
                ..resolve_copy(None)
            },
            &[],
        );
        assert_eq!(plan.project["projectManagerId"], "creator");
        assert_eq!(plan.counts["members"], 1);
        assert!(plan.project["settings"].get("sponsorId").is_none());
        assert_eq!(plan.counts["tasks"], 0);
    }
}
