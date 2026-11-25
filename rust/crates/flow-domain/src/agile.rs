//! Agile delivery in WeldFlow (EU and self-hosted only; ADRs FLOW-023 and
//! FLOW-024): a project's delivery settings, epics and features, and the
//! sprint lifecycle (start, complete with carry-over, the report and its
//! burndown).
//!
//! Pure functions, no database: the flow module's routes read the rows and
//! write the results. Every message here is sent to the client as it is.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Issues, Number, Presence, Text};

use crate::blueprint::Obj;
use crate::js::{civil_from_days, days_from_civil, number_value};

// ── Item types ──────────────────────────────────────────────────────────────

pub const EPIC: &str = "epic";
pub const FEATURE: &str = "feature";
/// The work item types a project can turn on (`tasks.type`).
pub const ITEM_TYPES: [&str; 7] = [
    "epic", "feature", "story", "bug", "task", "spike", "subtask",
];
/// The item types a project starts with.
pub const DEFAULT_ENABLED_ITEM_TYPES: [&str; 6] =
    ["epic", "story", "bug", "task", "spike", "subtask"];

/// Whether a task of this type holds items (an epic or a feature).
pub fn is_container(kind: Option<&str>) -> bool {
    matches!(kind, Some(EPIC | FEATURE))
}

// ── Messages ────────────────────────────────────────────────────────────────

pub const SPRINT_NOT_PLANNED: &str = "Only a planned sprint can be started";
pub const SPRINT_ALREADY_ACTIVE: &str = "Another sprint is already active in this project";
pub const SPRINT_NOT_ACTIVE: &str = "Only an active sprint can be completed";
pub const END_BEFORE_START: &str = "The end date must not be before the start date";
pub const NEXT_SPRINT_INVALID: &str = "The next sprint must be a planned sprint of this project";
pub const EPIC_WITHOUT_PROJECT: &str = "A task without a project cannot belong to an epic";
pub const EPIC_ITSELF: &str = "A task cannot be its own epic";
pub const EPIC_SUBTASK: &str = "A subtask cannot belong to an epic";
pub const EPIC_IN_EPIC: &str = "An epic cannot belong to another epic";
pub const FEATURE_OUTSIDE_EPIC: &str = "A feature can only belong to an epic";
pub const ITEM_TYPES_REPEAT: &str = "Item types must not repeat";
pub const TOO_MANY_WIP_LIMITS: &str = "At most 50 WIP limits";
pub const WIP_STAGE_ID: &str = "A stage id must have 1 to 40 characters";

// ── Delivery settings ───────────────────────────────────────────────────────

/// How a project delivers its work.
pub const APPROACHES: [&str; 5] = ["tasklist", "predictive", "scrum", "kanban", "hybrid"];
/// What a project calls its backlog items: product backlog items, or stories.
pub const NAMINGS: [&str; 2] = ["pbi", "story"];
pub const DEFAULT_SPRINT_LENGTH_DAYS: i64 = 14;
pub const MAX_SPRINT_LENGTH_DAYS: i64 = 42;
const MAX_WIP_LIMITS: usize = 50;
const MAX_STAGE_ID: usize = 40;
const MAX_DONE_CRITERIA: usize = 20;

/// `z.number().int().min(min).max(max)`.
const fn whole(min: f64, max: f64) -> Number {
    Number {
        coerce: false,
        int: true,
        min: Some(min),
        max: Some(max),
    }
}

/// An array item as one of [`ITEM_TYPES`].
fn read_item_type(issues: &mut Issues, item: &Value) -> Option<Value> {
    issues.item_choice(item, &ITEM_TYPES).map(Value::String)
}

/// `itemTypes`: `{ naming, featureLevel, enabled }`, strict, every field
/// required, `enabled` without repeats.
fn read_item_types(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    let mut o = Obj::new(issues, fields);
    o.choice("naming", Presence::Required, &NAMINGS)
        .boolean("featureLevel", Presence::Required)
        .list(
            "enabled",
            Presence::Required,
            Some(ITEM_TYPES.len()),
            read_item_type,
        );
    let out = o.finish();
    let mut seen = HashSet::new();
    let repeats = out
        .get("enabled")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|item| !seen.insert(item.as_str())));
    if repeats {
        issues.custom("enabled", ITEM_TYPES_REPEAT);
    }
    out
}

/// `wipLimits`: at most 50 stage ids (1 to 40 characters), each a whole
/// number from 1 to 999.
fn read_wip_limits(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    if fields.len() > MAX_WIP_LIMITS {
        issues.custom_here(TOO_MANY_WIP_LIMITS);
    }
    let mut out = Map::new();
    for key in fields.keys() {
        let length = key.encode_utf16().count();
        if length == 0 || length > MAX_STAGE_ID {
            issues.custom(key, WIP_STAGE_ID);
            continue;
        }
        if let Some(limit) = issues
            .whole_number(fields, key, Presence::Required, whole(1.0, 999.0))
            .into_option()
        {
            out.insert(key.clone(), json!(limit));
        }
    }
    Value::Object(out)
}

/// The body of `PUT /api/projects/:id/delivery`, read and normalised: the
/// delivery settings with every default filled in. `None` when the body is
/// not an object (the issue is recorded).
pub fn read_delivery(issues: &mut Issues, body: &Value) -> Option<Value> {
    let fields = issues.object(body)?;
    let mut o = Obj::new(issues, fields);
    o.choice("approach", Presence::Required, &APPROACHES)
        .whole(
            "sprintLengthDays",
            Presence::Optional,
            #[allow(clippy::cast_precision_loss)]
            whole(1.0, MAX_SPRINT_LENGTH_DAYS as f64),
        )
        .nested("itemTypes", Presence::Optional, read_item_types)
        .nested("wipLimits", Presence::Optional, read_wip_limits)
        .strings(
            "definitionOfDone",
            Presence::Optional,
            MAX_DONE_CRITERIA,
            Text::trimmed(Some(1), Some(200)),
        );
    let read = o.finish();
    Some(normalize_delivery(&read))
}

/// The delivery settings a project has before anyone sets them.
pub fn default_item_types() -> Value {
    json!({ "naming": "pbi", "featureLevel": false, "enabled": DEFAULT_ENABLED_ITEM_TYPES })
}

/// The read body with its defaults filled in, in a fixed key order.
pub fn normalize_delivery(read: &Value) -> Value {
    let or = |key: &str, fallback: Value| match read.get(key) {
        None | Some(Value::Null) => fallback,
        Some(value) => value.clone(),
    };
    json!({
        "approach": read.get("approach").cloned().unwrap_or(Value::Null),
        "sprintLengthDays": or("sprintLengthDays", json!(DEFAULT_SPRINT_LENGTH_DAYS)),
        "itemTypes": or("itemTypes", default_item_types()),
        "wipLimits": or("wipLimits", json!({})),
        "definitionOfDone": or("definitionOfDone", json!([])),
    })
}

/// `settings.delivery.sprintLengthDays` of a project's settings, when it is a
/// whole number from 1 to 42; else 14.
pub fn sprint_length_days(settings: Option<&Value>) -> i64 {
    settings
        .and_then(|s| s.get("delivery"))
        .and_then(|d| d.get("sprintLengthDays"))
        .and_then(|n| {
            n.as_i64().or_else(|| {
                n.as_f64()
                    .filter(|f| f.fract() == 0.0 && f.abs() < 1e9)
                    .map(float_to_int)
            })
        })
        .filter(|n| (1..=MAX_SPRINT_LENGTH_DAYS).contains(n))
        .unwrap_or(DEFAULT_SPRINT_LENGTH_DAYS)
}

#[allow(clippy::cast_possible_truncation)]
fn float_to_int(number: f64) -> i64 {
    number as i64
}

// ── Epics ───────────────────────────────────────────────────────────────────

/// A task as the epic rules see it.
#[derive(Debug, Clone, Copy, Default)]
pub struct LinkedItem<'a> {
    /// `None` for a task being created.
    pub id: Option<&'a str>,
    pub project_id: Option<&'a str>,
    pub kind: Option<&'a str>,
    pub parent_task_id: Option<&'a str>,
}

/// The task an item points at as its epic, as stored.
#[derive(Debug, Clone, Copy)]
pub struct EpicTarget<'a> {
    pub project_id: Option<&'a str>,
    pub kind: Option<&'a str>,
    /// Not soft-deleted.
    pub live: bool,
}

fn set(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

/// Why `item` may not belong to the epic `epic_id` (`epic`: that task, if it
/// exists), or `None` when it may.
pub fn epic_link_error(
    item: &LinkedItem<'_>,
    epic_id: &str,
    epic: Option<&EpicTarget<'_>>,
) -> Option<String> {
    let Some(project_id) = set(item.project_id) else {
        return Some(EPIC_WITHOUT_PROJECT.to_owned());
    };
    if item.id == Some(epic_id) {
        return Some(EPIC_ITSELF.to_owned());
    }
    if set(item.parent_task_id).is_some() {
        return Some(EPIC_SUBTASK.to_owned());
    }
    if item.kind == Some(EPIC) {
        return Some(EPIC_IN_EPIC.to_owned());
    }
    let Some(epic) = epic.filter(|e| e.live && e.project_id == Some(project_id)) else {
        return Some(format!("Epic {epic_id} not found in this project"));
    };
    if !is_container(epic.kind) {
        return Some(format!("Task {epic_id} is not an epic or a feature"));
    }
    if item.kind == Some(FEATURE) && epic.kind != Some(EPIC) {
        return Some(FEATURE_OUTSIDE_EPIC.to_owned());
    }
    None
}

/// Which members of a task lose their link when its type changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberClear {
    None,
    /// It no longer holds items.
    All,
    /// An epic became a feature: its features cannot stay in it.
    FeaturesOnly,
}

/// The members to unlink when a task's type goes from `old` to `new`.
pub fn members_to_clear(old: Option<&str>, new: Option<&str>) -> MemberClear {
    if old == new {
        return MemberClear::None;
    }
    match (old, new) {
        (Some(EPIC), Some(FEATURE)) => MemberClear::FeaturesOnly,
        (Some(EPIC | FEATURE), Some(EPIC | FEATURE)) => MemberClear::None,
        (Some(EPIC | FEATURE), _) => MemberClear::All,
        _ => MemberClear::None,
    }
}

/// A live, not cancelled task linked to an epic or a feature.
#[derive(Debug, Clone)]
pub struct EpicMember {
    pub epic_id: String,
    pub kind: Option<String>,
    pub status: String,
    pub points: i64,
}

/// The items of an epic or a feature, and how many are done.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Rollup {
    pub items: i64,
    pub done: i64,
    pub points: i64,
    pub done_points: i64,
}

impl Rollup {
    fn add(&mut self, member: &EpicMember) {
        self.items += 1;
        self.points += member.points;
        if member.status == "done" {
            self.done += 1;
            self.done_points += member.points;
        }
    }
}

/// The roll-up of every container (`(id, type, epicId)` of the project's
/// epics and features): a feature counts its members, an epic its own
/// members and its features' members. Features are not items; cancelled
/// members are left out.
pub fn epic_rollups(
    containers: &[(String, Option<String>, Option<String>)],
    members: &[EpicMember],
) -> HashMap<String, Rollup> {
    let by_id: HashMap<&str, (Option<&str>, Option<&str>)> = containers
        .iter()
        .map(|(id, kind, epic)| (id.as_str(), (kind.as_deref(), epic.as_deref())))
        .collect();
    let mut rollups: HashMap<String, Rollup> = containers
        .iter()
        .map(|(id, _, _)| (id.clone(), Rollup::default()))
        .collect();
    for member in members {
        if member.status == "cancelled" || member.kind.as_deref() == Some(FEATURE) {
            continue;
        }
        let Some((kind, parent_epic)) = by_id.get(member.epic_id.as_str()) else {
            continue;
        };
        if let Some(rollup) = rollups.get_mut(&member.epic_id) {
            rollup.add(member);
        }
        if *kind == Some(FEATURE)
            && let Some(epic) = parent_epic
            && by_id.get(epic).is_some_and(|(k, _)| *k == Some(EPIC))
            && let Some(rollup) = rollups.get_mut(*epic)
        {
            rollup.add(member);
        }
    }
    rollups
}

// ── Sprints ─────────────────────────────────────────────────────────────────

/// The name of the sprint after `name`: its trailing number plus one
/// (`Sprint 14` → `Sprint 15`), else the name with ` 2`; at most 255
/// characters.
pub fn next_sprint_name(name: &str) -> String {
    let trimmed = name.trim_end();
    if trimmed.is_empty() {
        return "Sprint 2".to_owned();
    }
    let digits_at = trimmed
        .char_indices()
        .rev()
        .take_while(|(_, c)| c.is_ascii_digit())
        .last()
        .map(|(at, _)| at);
    let (base, suffix) = match digits_at {
        Some(at) => (&trimmed[..at], increment(&trimmed[at..])),
        None => (trimmed, " 2".to_owned()),
    };
    let room = 255usize.saturating_sub(suffix.chars().count());
    let base: String = base.chars().take(room).collect();
    format!("{base}{suffix}")
}

/// A decimal number's text plus one, its width kept where it fits (`09` →
/// `10`, `99` → `100`).
fn increment(digits: &str) -> String {
    let mut out: Vec<u8> = digits.bytes().collect();
    for byte in out.iter_mut().rev() {
        if *byte == b'9' {
            *byte = b'0';
        } else {
            *byte += 1;
            return String::from_utf8(out).unwrap_or_default();
        }
    }
    let mut grown = vec![b'1'];
    grown.extend(out);
    String::from_utf8(grown).unwrap_or_default()
}

/// The `moveTo` values of `POST /api/sprints/:id/complete`.
pub const CARRY_TARGETS: [&str; 2] = ["next", "backlog"];

/// Where an unfinished item goes when its sprint completes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CarryTarget {
    Next,
    Backlog,
}

impl CarryTarget {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "next" => Some(Self::Next),
            "backlog" => Some(Self::Backlog),
            _ => None,
        }
    }
}

/// The unfinished items split by target, in their order: an item listed in
/// `overrides` goes there, the others to `default`. Overrides for other
/// tasks are ignored.
pub fn carry_over_plan(
    unfinished: &[String],
    default: CarryTarget,
    overrides: &[(String, CarryTarget)],
) -> (Vec<String>, Vec<String>) {
    let mut next = Vec::new();
    let mut backlog = Vec::new();
    for id in unfinished {
        let target = overrides
            .iter()
            .rev()
            .find(|(task, _)| task == id)
            .map_or(default, |(_, target)| *target);
        match target {
            CarryTarget::Next => next.push(id.clone()),
            CarryTarget::Backlog => backlog.push(id.clone()),
        }
    }
    (next, backlog)
}

/// Whether an item is finished (done or cancelled): what stays behind when
/// the sprint completes.
pub fn is_finished(status: &str) -> bool {
    matches!(status, "done" | "cancelled")
}

/// A top-level item of a sprint as the report counts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SprintItem {
    pub id: String,
    pub status: String,
    /// `story_points`, null as 0.
    pub points: i64,
    /// The UTC day (days since 1970-01-01) of `completed_date`.
    pub completed_day: Option<i64>,
}

impl SprintItem {
    fn counted(&self) -> bool {
        self.status != "cancelled"
    }
}

/// What a sprint committed to when it started.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Committed {
    pub task_ids: Vec<String>,
    pub points: i64,
    pub count: i64,
}

impl Committed {
    /// The items as they are (cancelled ones left out).
    pub fn of(items: &[SprintItem]) -> Self {
        let counted: Vec<&SprintItem> = items.iter().filter(|i| i.counted()).collect();
        Self {
            task_ids: counted.iter().map(|i| i.id.clone()).collect(),
            points: counted.iter().map(|i| i.points).sum(),
            count: i64::try_from(counted.len()).unwrap_or(i64::MAX),
        }
    }

    /// `report.committed` of a sprint's stored report.
    pub fn from_report(report: Option<&Value>) -> Option<Self> {
        let committed = report?.get("committed")?;
        let task_ids: Vec<String> = committed
            .get("taskIds")?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        Some(Self {
            points: committed.get("points").and_then(Value::as_i64).unwrap_or(0),
            count: committed
                .get("count")
                .and_then(Value::as_i64)
                .unwrap_or_else(|| i64::try_from(task_ids.len()).unwrap_or(0)),
            task_ids,
        })
    }

    pub fn to_json(&self) -> Value {
        json!({ "taskIds": self.task_ids, "points": self.points, "count": self.count })
    }
}

/// The report a sprint stores when it starts.
pub fn start_report(committed: &Committed, started_at: &str) -> Value {
    json!({ "committed": committed.to_json(), "startedAt": started_at })
}

/// Whether a stored report is the frozen one of a completed sprint.
pub fn is_frozen(report: Option<&Value>) -> bool {
    report
        .and_then(|r| r.get("completed"))
        .is_some_and(Value::is_object)
}

/// The unfinished items a completing sprint hands on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CarriedOver {
    pub task_ids: Vec<String>,
    pub points: i64,
    /// The sprint they went to, when any did.
    pub to_sprint_id: Option<String>,
    /// How many went to the backlog.
    pub to_backlog: i64,
}

impl CarriedOver {
    fn to_json(&self) -> Value {
        json!({
            "points": self.points,
            "count": self.task_ids.len(),
            "taskIds": self.task_ids,
            "toSprintId": self.to_sprint_id,
            "toBacklog": self.to_backlog,
        })
    }
}

/// The days a burndown covers, inclusive, as UTC day numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SprintDays {
    pub start: i64,
    pub end: i64,
}

/// The most days a burndown lists.
const MAX_BURNDOWN_DAYS: i64 = 366;

impl SprintDays {
    /// `start_date` to `end_date`; without them `started_at` to `last` (the
    /// completion day, or today). An end before the start is the start; a
    /// burndown never lists more than 366 days.
    pub fn of(
        start_date: Option<i64>,
        end_date: Option<i64>,
        started_at: Option<i64>,
        last: i64,
    ) -> Self {
        let start = start_date.or(started_at).unwrap_or(last);
        let end = end_date.unwrap_or(last.max(start)).max(start);
        Self {
            start,
            end: end.min(start + MAX_BURNDOWN_DAYS - 1),
        }
    }
}

/// What a sprint report is worked out from.
#[derive(Debug, Clone)]
pub struct ReportInput<'a> {
    pub committed: &'a Committed,
    /// The live top-level items in the sprint now (before any carry-over).
    pub items: &'a [SprintItem],
    /// The current points of committed tasks no longer in the sprint
    /// (deleted ones included; a task not found counts 0).
    pub left_points: &'a HashMap<String, i64>,
    /// `None` for a live report: the unfinished items then show as carried
    /// over, with no destination.
    pub carried_over: Option<&'a CarriedOver>,
    pub goal_met: Option<bool>,
    pub days: SprintDays,
    /// The day the report is for: today, or the completion day. Done items
    /// without a completion date count on it; later days have no
    /// remaining work yet.
    pub today: i64,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

fn points_and_count<'a>(items: impl Iterator<Item = &'a SprintItem>) -> Value {
    let (points, count) = items.fold((0_i64, 0_i64), |(p, c), item| (p + item.points, c + 1));
    json!({ "points": points, "count": count })
}

/// `YYYY-MM-DD` of a UTC day number.
pub fn day_text(day: i64) -> String {
    let (year, month, date) = civil_from_days(day);
    format!("{year:04}-{month:02}-{date:02}")
}

/// The UTC day number of a calendar date.
pub fn day_of_date(date: time::Date) -> i64 {
    days_from_civil(
        i64::from(date.year()),
        i64::from(u8::from(date.month())),
        i64::from(date.day()),
    )
}

/// The ideal line: the committed points down to 0 on the last day (a
/// one-day sprint: just the committed points), to two decimals.
#[allow(clippy::cast_precision_loss)]
fn ideal(committed: i64, index: i64, days: i64) -> Value {
    if days <= 1 {
        return json!(committed);
    }
    let left = (days - 1 - index) as f64 / (days - 1) as f64;
    number_value((committed as f64 * left * 100.0).round() / 100.0)
}

/// The sprint report: what was committed, completed, added, removed and
/// carried over, and the burndown of the work in the sprint now (committed
/// plus added, less removed) by day.
pub fn sprint_report(input: &ReportInput<'_>) -> Value {
    let committed_ids: HashSet<&str> = input
        .committed
        .task_ids
        .iter()
        .map(String::as_str)
        .collect();
    let counted: Vec<&SprintItem> = input.items.iter().filter(|i| i.counted()).collect();
    let counted_ids: HashSet<&str> = counted.iter().map(|i| i.id.as_str()).collect();
    let completed = points_and_count(counted.iter().copied().filter(|item| item.status == "done"));
    let added = points_and_count(
        counted
            .iter()
            .copied()
            .filter(|item| !committed_ids.contains(item.id.as_str())),
    );
    // Committed items that left the sprint, were deleted or cancelled.
    let mut removed_points = 0;
    let mut removed_count = 0;
    for id in &input.committed.task_ids {
        if counted_ids.contains(id.as_str()) {
            continue;
        }
        removed_count += 1;
        removed_points += input
            .items
            .iter()
            .find(|item| &item.id == id)
            .map(|item| item.points)
            .or_else(|| input.left_points.get(id).copied())
            .unwrap_or(0);
    }
    let scope: i64 = counted.iter().map(|item| item.points).sum();
    let days = input.days.end - input.days.start + 1;
    let burndown: Vec<Value> = (0..days)
        .map(|index| {
            let day = input.days.start + index;
            let remaining = if day > input.today {
                Value::Null
            } else {
                let done: i64 = counted
                    .iter()
                    .filter(|item| {
                        item.status == "done" && item.completed_day.unwrap_or(input.today) <= day
                    })
                    .map(|item| item.points)
                    .sum();
                json!(scope - done)
            };
            json!({
                "date": day_text(day),
                "remaining": remaining,
                "ideal": ideal(input.committed.points, index, days),
            })
        })
        .collect();
    // A live report carries over what is unfinished now: what completing the
    // sprint would hand on, with no destination yet.
    let carried = input.carried_over.cloned().unwrap_or_else(|| {
        let unfinished: Vec<&&SprintItem> = counted
            .iter()
            .filter(|item| item.status != "done")
            .collect();
        CarriedOver {
            task_ids: unfinished.iter().map(|item| item.id.clone()).collect(),
            points: unfinished.iter().map(|item| item.points).sum(),
            to_sprint_id: None,
            to_backlog: 0,
        }
    });
    json!({
        "committed": input.committed.to_json(),
        "completed": completed,
        "added": added,
        "removed": { "points": removed_points, "count": removed_count },
        "carriedOver": carried.to_json(),
        "goalMet": input.goal_met,
        "burndown": burndown,
        "startedAt": input.started_at,
        "completedAt": input.completed_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(body: &Value) -> Result<Value, Vec<(String, String)>> {
        let mut issues = Issues::default();
        let out = read_delivery(&mut issues, body);
        match issues.finish() {
            Ok(()) => Ok(out.expect("read")),
            Err(failed) => Err(failed
                .issues()
                .iter()
                .map(|issue| {
                    let path = issue["path"]
                        .as_array()
                        .expect("path")
                        .iter()
                        .map(|p| p.as_str().map_or_else(|| p.to_string(), str::to_owned))
                        .collect::<Vec<_>>()
                        .join(".");
                    (
                        path,
                        issue["message"].as_str().unwrap_or_default().to_owned(),
                    )
                })
                .collect()),
        }
    }

    #[test]
    fn delivery_settings_get_their_defaults() {
        assert_eq!(
            read(&json!({ "approach": "scrum" })),
            Ok(json!({
                "approach": "scrum",
                "sprintLengthDays": 14,
                "itemTypes": { "naming": "pbi", "featureLevel": false,
                    "enabled": ["epic", "story", "bug", "task", "spike", "subtask"] },
                "wipLimits": {},
                "definitionOfDone": [],
            }))
        );
        let whole = json!({
            "approach": "kanban",
            "sprintLengthDays": 10,
            "itemTypes": { "naming": "story", "featureLevel": true, "enabled": ["feature", "story"] },
            "wipLimits": { "stg_doing": 3 },
            "definitionOfDone": ["  Reviewed  ", "Tested"],
        });
        let mut expected = whole.clone();
        expected["definitionOfDone"] = json!(["Reviewed", "Tested"]);
        assert_eq!(read(&whole), Ok(expected));
    }

    #[test]
    fn delivery_settings_refuse_what_the_schema_does_not_allow() {
        let issue = |path: &str, message: &str| Err(vec![(path.to_owned(), message.to_owned())]);
        assert_eq!(read(&json!({})), issue("approach", "Required"));
        assert_eq!(
            read(&json!({ "approach": "waterfall" })),
            issue(
                "approach",
                "Invalid enum value. Expected 'tasklist' | 'predictive' | 'scrum' | 'kanban' | 'hybrid', received 'waterfall'"
            )
        );
        assert_eq!(
            read(&json!({ "approach": "scrum", "extra": 1 })),
            issue("", "Unrecognized key(s) in object: 'extra'")
        );
        assert_eq!(
            read(&json!({ "approach": "scrum", "sprintLengthDays": 43 })),
            issue(
                "sprintLengthDays",
                "Number must be less than or equal to 42"
            )
        );
        assert_eq!(
            read(&json!({ "approach": "scrum", "sprintLengthDays": 1.5 })),
            issue("sprintLengthDays", "Expected integer, received float")
        );
        assert_eq!(
            read(&json!({ "approach": "scrum",
                "itemTypes": { "naming": "pbi", "featureLevel": false, "enabled": ["story", "story"] } })),
            issue("itemTypes.enabled", ITEM_TYPES_REPEAT)
        );
        assert_eq!(
            read(&json!({ "approach": "scrum",
                "itemTypes": { "naming": "pbi", "featureLevel": false, "enabled": ["saga"] } })),
            issue(
                "itemTypes.enabled.0",
                "Invalid enum value. Expected 'epic' | 'feature' | 'story' | 'bug' | 'task' | 'spike' | 'subtask', received 'saga'"
            )
        );
        assert_eq!(
            read(&json!({ "approach": "scrum", "itemTypes": { "naming": "pbi", "enabled": [] } })),
            issue("itemTypes.featureLevel", "Required")
        );
        assert_eq!(
            read(&json!({ "approach": "scrum", "wipLimits": { "stg": 0 } })),
            issue("wipLimits.stg", "Number must be greater than or equal to 1")
        );
        assert_eq!(
            read(&json!({ "approach": "scrum", "wipLimits": { "": 2 } })),
            issue("wipLimits.", WIP_STAGE_ID)
        );
        let many: Map<String, Value> = (0..51).map(|i| (format!("s{i}"), json!(1))).collect();
        assert_eq!(
            read(&json!({ "approach": "scrum", "wipLimits": many })),
            issue("wipLimits", TOO_MANY_WIP_LIMITS)
        );
        assert_eq!(
            read(&json!({ "approach": "scrum", "definitionOfDone": ["  "] })),
            issue(
                "definitionOfDone.0",
                "String must contain at least 1 character(s)"
            )
        );
        let criteria: Vec<String> = (0..21).map(|i| format!("c{i}")).collect();
        assert_eq!(
            read(&json!({ "approach": "scrum", "definitionOfDone": criteria })),
            issue(
                "definitionOfDone",
                "Array must contain at most 20 element(s)"
            )
        );
    }

    #[test]
    fn sprint_length_comes_from_the_settings() {
        assert_eq!(sprint_length_days(None), 14);
        assert_eq!(
            sprint_length_days(Some(&json!({ "delivery": { "sprintLengthDays": 7 } }))),
            7
        );
        assert_eq!(
            sprint_length_days(Some(&json!({ "delivery": { "sprintLengthDays": 99 } }))),
            14
        );
        assert_eq!(
            sprint_length_days(Some(&json!({ "tabs": {} }))),
            DEFAULT_SPRINT_LENGTH_DAYS
        );
    }

    fn item<'a>(kind: Option<&'a str>, parent: Option<&'a str>) -> LinkedItem<'a> {
        LinkedItem {
            id: Some("t1"),
            project_id: Some("p1"),
            kind,
            parent_task_id: parent,
        }
    }

    fn target(kind: &str) -> EpicTarget<'_> {
        EpicTarget {
            project_id: Some("p1"),
            kind: Some(kind),
            live: true,
        }
    }

    #[test]
    fn epic_links_follow_the_rules() {
        let story = item(Some("story"), None);
        assert_eq!(epic_link_error(&story, "e1", Some(&target("epic"))), None);
        assert_eq!(
            epic_link_error(&story, "f1", Some(&target("feature"))),
            None
        );
        let personal = LinkedItem {
            project_id: None,
            ..story
        };
        assert_eq!(
            epic_link_error(&personal, "e1", Some(&target("epic"))).as_deref(),
            Some(EPIC_WITHOUT_PROJECT)
        );
        assert_eq!(
            epic_link_error(&story, "t1", Some(&target("epic"))).as_deref(),
            Some(EPIC_ITSELF)
        );
        assert_eq!(
            epic_link_error(&item(Some("task"), Some("t0")), "e1", Some(&target("epic")))
                .as_deref(),
            Some(EPIC_SUBTASK)
        );
        assert_eq!(
            epic_link_error(&item(Some("epic"), None), "e1", Some(&target("epic"))).as_deref(),
            Some(EPIC_IN_EPIC)
        );
        assert_eq!(
            epic_link_error(&story, "e9", None).as_deref(),
            Some("Epic e9 not found in this project")
        );
        let elsewhere = EpicTarget {
            project_id: Some("p2"),
            ..target("epic")
        };
        assert_eq!(
            epic_link_error(&story, "e1", Some(&elsewhere)).as_deref(),
            Some("Epic e1 not found in this project")
        );
        let deleted = EpicTarget {
            live: false,
            ..target("epic")
        };
        assert!(epic_link_error(&story, "e1", Some(&deleted)).is_some());
        assert_eq!(
            epic_link_error(&story, "s1", Some(&target("story"))).as_deref(),
            Some("Task s1 is not an epic or a feature")
        );
        assert_eq!(
            epic_link_error(&item(Some("feature"), None), "f1", Some(&target("feature")))
                .as_deref(),
            Some(FEATURE_OUTSIDE_EPIC)
        );
        assert_eq!(
            epic_link_error(&item(Some("feature"), None), "e1", Some(&target("epic"))),
            None
        );
    }

    #[test]
    fn a_type_change_unlinks_the_members_it_can_no_longer_hold() {
        assert_eq!(
            members_to_clear(Some("epic"), Some("story")),
            MemberClear::All
        );
        assert_eq!(members_to_clear(Some("feature"), None), MemberClear::All);
        assert_eq!(
            members_to_clear(Some("epic"), Some("feature")),
            MemberClear::FeaturesOnly
        );
        assert_eq!(
            members_to_clear(Some("feature"), Some("epic")),
            MemberClear::None
        );
        assert_eq!(
            members_to_clear(Some("epic"), Some("epic")),
            MemberClear::None
        );
        assert_eq!(
            members_to_clear(Some("story"), Some("bug")),
            MemberClear::None
        );
    }

    fn member(epic: &str, kind: &str, status: &str, points: i64) -> EpicMember {
        EpicMember {
            epic_id: epic.to_owned(),
            kind: Some(kind.to_owned()),
            status: status.to_owned(),
            points,
        }
    }

    #[test]
    fn an_epic_counts_its_items_and_its_features_items() {
        let containers = vec![
            ("e1".to_owned(), Some("epic".to_owned()), None),
            (
                "f1".to_owned(),
                Some("feature".to_owned()),
                Some("e1".to_owned()),
            ),
            ("f2".to_owned(), Some("feature".to_owned()), None),
        ];
        let members = vec![
            member("e1", "story", "done", 3),
            member("e1", "feature", "todo", 8),
            member("e1", "bug", "cancelled", 5),
            member("f1", "story", "todo", 2),
            member("f1", "story", "done", 1),
            member("f2", "task", "todo", 4),
        ];
        let rollups = epic_rollups(&containers, &members);
        assert_eq!(
            rollups["e1"],
            Rollup {
                items: 3,
                done: 2,
                points: 6,
                done_points: 4
            }
        );
        assert_eq!(
            rollups["f1"],
            Rollup {
                items: 2,
                done: 1,
                points: 3,
                done_points: 1
            }
        );
        assert_eq!(rollups["f2"].items, 1);
    }

    #[test]
    fn the_next_sprint_takes_the_next_number() {
        assert_eq!(next_sprint_name("Sprint 14"), "Sprint 15");
        assert_eq!(next_sprint_name("Sprint 9"), "Sprint 10");
        assert_eq!(next_sprint_name("Sprint 09 "), "Sprint 10");
        assert_eq!(next_sprint_name("S99"), "S100");
        assert_eq!(next_sprint_name("Kick-off"), "Kick-off 2");
        assert_eq!(next_sprint_name("   "), "Sprint 2");
        let long = "x".repeat(255);
        let next = next_sprint_name(&long);
        assert_eq!(next.chars().count(), 255);
        assert!(next.ends_with(" 2"));
    }

    #[test]
    fn carry_over_follows_the_overrides() {
        let unfinished = vec!["a".to_owned(), "b".to_owned(), "c".to_owned()];
        let overrides = vec![
            ("b".to_owned(), CarryTarget::Backlog),
            ("z".to_owned(), CarryTarget::Backlog),
        ];
        assert_eq!(
            carry_over_plan(&unfinished, CarryTarget::Next, &overrides),
            (vec!["a".to_owned(), "c".to_owned()], vec!["b".to_owned()])
        );
        assert_eq!(
            carry_over_plan(&unfinished, CarryTarget::Backlog, &[]),
            (Vec::new(), unfinished.clone())
        );
    }

    fn sprint_item(id: &str, status: &str, points: i64, day: Option<i64>) -> SprintItem {
        SprintItem {
            id: id.to_owned(),
            status: status.to_owned(),
            points,
            completed_day: day,
        }
    }

    #[test]
    fn the_report_counts_scope_changes_and_burns_down() {
        let start = days_from_civil(2026, 11, 2);
        let committed = Committed {
            task_ids: vec!["a".into(), "b".into(), "c".into(), "gone".into()],
            points: 13,
            count: 4,
        };
        let items = vec![
            sprint_item("a", "done", 5, Some(start + 1)),
            sprint_item("b", "in_progress", 3, None),
            sprint_item("c", "cancelled", 2, None),
            sprint_item("new", "done", 1, None),
        ];
        let left = HashMap::from([("gone".to_owned(), 3)]);
        let carried = CarriedOver {
            task_ids: vec!["b".into()],
            points: 3,
            to_sprint_id: Some("spr_next".into()),
            to_backlog: 0,
        };
        let report = sprint_report(&ReportInput {
            committed: &committed,
            items: &items,
            left_points: &left,
            carried_over: Some(&carried),
            goal_met: Some(true),
            days: SprintDays {
                start,
                end: start + 2,
            },
            today: start + 2,
            started_at: Some("2026-11-02T09:00:00.000Z".into()),
            completed_at: Some("2026-11-04T17:00:00.000Z".into()),
        });
        assert_eq!(report["committed"], committed.to_json());
        assert_eq!(report["completed"], json!({ "points": 6, "count": 2 }));
        assert_eq!(report["added"], json!({ "points": 1, "count": 1 }));
        assert_eq!(report["removed"], json!({ "points": 5, "count": 2 }));
        assert_eq!(
            report["carriedOver"],
            json!({ "points": 3, "count": 1, "taskIds": ["b"], "toSprintId": "spr_next", "toBacklog": 0 })
        );
        assert_eq!(report["goalMet"], json!(true));
        // Scope 9 (a, b, new); a done on day 2, `new` (no date) on the last day.
        assert_eq!(
            report["burndown"],
            json!([
                { "date": "2026-11-02", "remaining": 9, "ideal": 13 },
                { "date": "2026-11-03", "remaining": 4, "ideal": 6.5 },
                { "date": "2026-11-04", "remaining": 3, "ideal": 0 },
            ])
        );
    }

    #[test]
    fn a_live_report_has_no_remaining_work_after_today() {
        let start = days_from_civil(2026, 11, 2);
        let items = vec![sprint_item("a", "todo", 2, None)];
        let committed = Committed::of(&items);
        let report = sprint_report(&ReportInput {
            committed: &committed,
            items: &items,
            left_points: &HashMap::new(),
            carried_over: None,
            goal_met: None,
            days: SprintDays::of(Some(start), Some(start + 3), None, start + 1),
            today: start + 1,
            started_at: None,
            completed_at: None,
        });
        let remaining: Vec<Value> = report["burndown"]
            .as_array()
            .expect("burndown")
            .iter()
            .map(|day| day["remaining"].clone())
            .collect();
        assert_eq!(
            remaining,
            vec![json!(2), json!(2), Value::Null, Value::Null]
        );
        assert_eq!(report["burndown"][1]["ideal"], json!(1.33));
        // Live: the unfinished items are what completing would carry over.
        assert_eq!(
            report["carriedOver"],
            json!({ "points": 2, "count": 1, "taskIds": ["a"], "toSprintId": null, "toBacklog": 0 })
        );
        assert_eq!(report["goalMet"], Value::Null);
    }

    #[test]
    fn a_one_day_sprint_starts_at_its_commitment() {
        let day = days_from_civil(2026, 1, 1);
        let items = vec![sprint_item("a", "done", 3, Some(day))];
        let committed = Committed::of(&items);
        let report = sprint_report(&ReportInput {
            committed: &committed,
            items: &items,
            left_points: &HashMap::new(),
            carried_over: None,
            goal_met: None,
            days: SprintDays {
                start: day,
                end: day,
            },
            today: day,
            started_at: None,
            completed_at: None,
        });
        assert_eq!(
            report["burndown"],
            json!([{ "date": "2026-01-01", "remaining": 0, "ideal": 3 }])
        );
    }

    #[test]
    fn sprint_days_fall_back_and_stay_bounded() {
        assert_eq!(
            SprintDays::of(None, None, Some(10), 12),
            SprintDays { start: 10, end: 12 }
        );
        assert_eq!(
            SprintDays::of(Some(20), Some(15), None, 12),
            SprintDays { start: 20, end: 20 }
        );
        assert_eq!(
            SprintDays::of(Some(0), Some(10_000), None, 5),
            SprintDays { start: 0, end: 365 }
        );
        assert_eq!(
            SprintDays::of(None, None, None, 7),
            SprintDays { start: 7, end: 7 }
        );
    }

    #[test]
    fn committed_reads_back_from_the_stored_report() {
        let committed = Committed {
            task_ids: vec!["a".into()],
            points: 5,
            count: 1,
        };
        let report = start_report(&committed, "2026-11-02T00:00:00.000Z");
        assert_eq!(Committed::from_report(Some(&report)), Some(committed));
        assert_eq!(Committed::from_report(None), None);
        assert!(!is_frozen(Some(&report)));
        assert!(is_frozen(Some(
            &json!({ "completed": { "points": 0, "count": 0 } })
        )));
    }

    #[test]
    fn days_print_as_calendar_dates() {
        assert_eq!(day_text(0), "1970-01-01");
        let date = time::Date::from_calendar_date(2026, time::Month::November, 25).expect("date");
        assert_eq!(day_text(day_of_date(date)), "2026-11-25");
    }
}
