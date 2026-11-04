//! Schedule rules (`@weldsuite/flow-domain/schedule`): the forward and
//! backward pass over a project's tasks, their typed dependencies and its
//! working calendar (design: weldflow-delivery-and-portfolio.md; ADR
//! FLOW-015).
//!
//! A line-by-line port: the same fixtures
//! (`packages/domains/flow/src/testing/schedule-fixtures.json`) run in both
//! languages, so a change here is a change in `schedule.ts`.
//!
//! Everything is in working days of the project calendar. A task spans its
//! planned start to its planned due date (at least one working day; a task
//! with one date lasts one day; one with none, or cancelled, is outside the
//! network). A link has a type (`fs`, `ss`, `ff`, `sf`) and a lag (negative
//! is lead time). The forward pass pushes a task's start to what its
//! predecessors require, never earlier than its planned start; done and
//! pinned tasks keep their dates. The backward pass runs from the project
//! finish; total float is late start minus early start; the critical path is
//! the linked, unfinished tasks with no float. Conflicts are checked against
//! the planned dates, link by link.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::js::{civil_from_days, days_from_civil};

pub const DEFAULT_WORKING_DAYS: [i64; 5] = [1, 2, 3, 4, 5];

const MS_PER_DAY: i64 = 86_400_000;
/// A search for the next working day gives up after this many days.
const MAX_SEARCH_DAYS: i64 = 3_700;

/// `fs`, `ss`, `ff`, `sf`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DependencyKind {
    Fs,
    Ss,
    Ff,
    Sf,
}

impl DependencyKind {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "fs" => Some(Self::Fs),
            "ss" => Some(Self::Ss),
            "ff" => Some(Self::Ff),
            "sf" => Some(Self::Sf),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fs => "fs",
            Self::Ss => "ss",
            Self::Ff => "ff",
            Self::Sf => "sf",
        }
    }
}

/// `ScheduleCalendar`: ISO weekdays (1 = Monday ... 7 = Sunday) that are
/// working days, and non-working dates (`YYYY-MM-DD`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleCalendar {
    pub working_days: Vec<i64>,
    pub holidays: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ScheduleTaskInput {
    pub id: String,
    pub status: String,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ScheduleLinkInput {
    pub id: String,
    pub predecessor_id: String,
    pub successor_id: String,
    pub kind: DependencyKind,
    pub lag_days: i64,
}

#[derive(Debug, Clone)]
pub struct ScheduleInput {
    pub tasks: Vec<ScheduleTaskInput>,
    pub links: Vec<ScheduleLinkInput>,
    pub calendar: ScheduleCalendar,
    pub go_live: Option<String>,
    pub pinned_task_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledTask {
    pub id: String,
    pub scheduled: bool,
    pub done: bool,
    pub planned_start: Option<String>,
    pub planned_finish: Option<String>,
    pub duration_days: Option<i64>,
    pub early_start: Option<String>,
    pub early_finish: Option<String>,
    pub late_start: Option<String>,
    pub late_finish: Option<String>,
    pub total_float: Option<i64>,
    pub critical: bool,
    pub shift_days: i64,
    pub linked: bool,
}

impl ScheduledTask {
    /// The fields of `ScheduledTask` in the answer's own shape.
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "scheduled": self.scheduled,
            "done": self.done,
            "plannedStart": self.planned_start,
            "plannedFinish": self.planned_finish,
            "durationDays": self.duration_days,
            "earlyStart": self.early_start,
            "earlyFinish": self.early_finish,
            "lateStart": self.late_start,
            "lateFinish": self.late_finish,
            "totalFloat": self.total_float,
            "critical": self.critical,
            "shiftDays": self.shift_days,
            "linked": self.linked,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleConflict {
    pub link_id: String,
    pub predecessor_id: String,
    pub successor_id: String,
    pub kind: DependencyKind,
    pub lag_days: i64,
    pub required_start: String,
    pub planned_start: String,
    pub short_by_days: i64,
}

impl ScheduleConflict {
    pub fn to_json(&self) -> Value {
        json!({
            "linkId": self.link_id,
            "predecessorId": self.predecessor_id,
            "successorId": self.successor_id,
            "type": self.kind.as_str(),
            "lagDays": self.lag_days,
            "requiredStart": self.required_start,
            "plannedStart": self.planned_start,
            "shortByDays": self.short_by_days,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleResult {
    pub tasks: Vec<ScheduledTask>,
    pub conflicts: Vec<ScheduleConflict>,
    pub critical_path: Vec<String>,
    pub finish: Option<String>,
    pub go_live: Option<String>,
    pub go_live_slack_days: Option<i64>,
    pub cyclic_task_ids: Vec<String>,
}

impl ScheduleResult {
    pub fn to_json(&self) -> Value {
        json!({
            "tasks": self.tasks.iter().map(ScheduledTask::to_json).collect::<Vec<_>>(),
            "conflicts": self.conflicts.iter().map(ScheduleConflict::to_json).collect::<Vec<_>>(),
            "criticalPath": self.critical_path,
            "finish": self.finish,
            "goLive": self.go_live,
            "goLiveSlackDays": self.go_live_slack_days,
            "cyclicTaskIds": self.cyclic_task_ids,
        })
    }
}

// ── Dates and calendar ──────────────────────────────────────────────────────

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
    }
}

/// `dayNumber(date)`: days since 1970-01-01 of a `YYYY-MM-DD` date, or `None`
/// when it is not a real calendar date (years under 100 are not: JavaScript's
/// `Date.UTC` reads them as 19xx, which fails the round trip).
pub fn day_number(date: &str) -> Option<i64> {
    let bytes = date.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = &bytes[range];
        if part.iter().all(u8::is_ascii_digit) {
            std::str::from_utf8(part).ok()?.parse().ok()
        } else {
            None
        }
    };
    let year = digits(0..4)?;
    let month = digits(5..7)?;
    let day = digits(8..10)?;
    if year < 100 || !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

/// `isoDate(day)`: `YYYY-MM-DD` of a day number.
pub fn iso_date(day: i64) -> String {
    let (year, month, date) = civil_from_days(day);
    format!("{year:04}-{month:02}-{date:02}")
}

/// `isoWeekday(day)`: 1 = Monday ... 7 = Sunday (1970-01-01 was a Thursday).
pub fn iso_weekday(day: i64) -> i64 {
    ((day + 3) % 7 + 7) % 7 + 1
}

/// `normalizeCalendar(settings)`: the calendar as stored, with the defaults
/// for what is missing or unusable.
pub fn normalize_calendar(
    working_days: Option<&Value>,
    holidays: Option<&Value>,
) -> ScheduleCalendar {
    let mut days: Vec<i64> = match working_days {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                let number = item.as_f64()?;
                (number.fract() == 0.0 && (1.0..=7.0).contains(&number)).then(|| number as i64)
            })
            .collect(),
        _ => Vec::new(),
    };
    days.sort_unstable();
    days.dedup();
    if days.is_empty() {
        days = DEFAULT_WORKING_DAYS.to_vec();
    }
    let mut holidays: Vec<String> = match holidays {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().filter(|h| day_number(h).is_some()))
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    };
    holidays.sort();
    holidays.dedup();
    ScheduleCalendar {
        working_days: days,
        holidays,
    }
}

struct WorkingCalendar {
    weekdays: [bool; 8],
    holidays: HashSet<i64>,
}

impl WorkingCalendar {
    fn new(calendar: &ScheduleCalendar) -> Self {
        let normal = normalize_calendar(
            Some(&json!(calendar.working_days)),
            Some(&json!(calendar.holidays)),
        );
        let mut weekdays = [false; 8];
        for weekday in normal.working_days {
            weekdays[usize::try_from(weekday).unwrap_or(0)] = true;
        }
        let holidays = normal
            .holidays
            .iter()
            .filter_map(|holiday| day_number(holiday))
            .collect();
        Self { weekdays, holidays }
    }

    fn is_working(&self, day: i64) -> bool {
        self.weekdays[usize::try_from(iso_weekday(day)).unwrap_or(0)]
            && !self.holidays.contains(&day)
    }

    /// The day itself when it is a working day, else the next one.
    fn next_working(&self, day: i64) -> i64 {
        let mut current = day;
        let mut guard = 0;
        while guard < MAX_SEARCH_DAYS && !self.is_working(current) {
            current += 1;
            guard += 1;
        }
        current
    }

    /// `n` working days later (earlier when negative); zero returns the day as it is.
    fn add(&self, day: i64, n: i64) -> i64 {
        let mut current = day;
        let step = if n > 0 { 1 } else { -1 };
        for _ in 0..n.abs() {
            current += step;
            let mut guard = 0;
            while guard < MAX_SEARCH_DAYS && !self.is_working(current) {
                current += step;
                guard += 1;
            }
        }
        current
    }

    /// Signed working days from `a` to `b`.
    fn diff(&self, a: i64, b: i64) -> i64 {
        if a == b {
            return 0;
        }
        let (low, high, sign) = if b > a { (a, b, 1) } else { (b, a, -1) };
        let count = ((low + 1)..=high)
            .filter(|day| self.is_working(*day))
            .count();
        sign * i64::try_from(count).unwrap_or(0)
    }

    /// Working days from `start` to `end`, both included.
    fn count_inclusive(&self, start: i64, end: i64) -> i64 {
        let count = (start..=end).filter(|day| self.is_working(*day)).count();
        i64::try_from(count).unwrap_or(0)
    }
}

/// The earliest start of a successor lasting `successor_days`, given the
/// predecessor's start and finish and the link.
fn required_start(
    cal: &WorkingCalendar,
    kind: DependencyKind,
    lag: i64,
    predecessor_start: i64,
    predecessor_finish: i64,
    successor_days: i64,
) -> i64 {
    let start = match kind {
        DependencyKind::Fs => cal.add(predecessor_finish, lag + 1),
        DependencyKind::Ss => cal.add(predecessor_start, lag),
        DependencyKind::Ff => cal.add(cal.add(predecessor_finish, lag), -(successor_days - 1)),
        DependencyKind::Sf => cal.add(cal.add(predecessor_start, lag), -(successor_days - 1)),
    };
    cal.next_working(start)
}

/// The latest finish of a predecessor lasting `predecessor_days`, given the
/// successor's late start and late finish and the link.
fn latest_finish(
    cal: &WorkingCalendar,
    kind: DependencyKind,
    lag: i64,
    successor_late_start: i64,
    successor_late_finish: i64,
    predecessor_days: i64,
) -> i64 {
    match kind {
        DependencyKind::Fs => cal.add(successor_late_start, -(lag + 1)),
        DependencyKind::Ss => cal.add(cal.add(successor_late_start, -lag), predecessor_days - 1),
        DependencyKind::Ff => cal.add(successor_late_finish, -lag),
        DependencyKind::Sf => cal.add(cal.add(successor_late_finish, -lag), predecessor_days - 1),
    }
}

// ── computeSchedule ─────────────────────────────────────────────────────────

struct Node {
    id: String,
    scheduled: bool,
    done: bool,
    pinned: bool,
    planned_start: i64,
    planned_finish: i64,
    duration: i64,
    early_start: i64,
    early_finish: i64,
    late_start: i64,
    late_finish: i64,
    cyclic: bool,
    linked: bool,
}

struct Edge<'a> {
    link: &'a ScheduleLinkInput,
    from: usize,
    to: usize,
}

fn plan_node(cal: &WorkingCalendar, task: &ScheduleTaskInput, pinned: &HashSet<&str>) -> Node {
    let start_day = task.start_date.as_deref().and_then(day_number);
    let due_day = task.due_date.as_deref().and_then(day_number);
    let in_network = task.status != "cancelled" && (start_day.is_some() || due_day.is_some());
    let done = task.status == "done";
    let (Some(first), true) = (start_day.or(due_day), in_network) else {
        return Node {
            id: task.id.clone(),
            scheduled: false,
            done,
            pinned: false,
            planned_start: 0,
            planned_finish: 0,
            duration: 0,
            early_start: 0,
            early_finish: 0,
            late_start: 0,
            late_finish: 0,
            cyclic: false,
            linked: false,
        };
    };
    let last = first.max(due_day.or(start_day).unwrap_or(first));
    let planned_start = cal.next_working(first);
    let duration = cal.count_inclusive(first, last).max(1);
    let planned_finish = cal.add(planned_start, duration - 1);
    Node {
        id: task.id.clone(),
        scheduled: true,
        done,
        pinned: pinned.contains(task.id.as_str()),
        planned_start,
        planned_finish,
        duration,
        early_start: planned_start,
        early_finish: planned_finish,
        late_start: planned_start,
        late_finish: planned_finish,
        cyclic: false,
        linked: false,
    }
}

/// The topological order of the network (Kahn, lowest index first), and the
/// nodes left in a cycle.
fn order_nodes(nodes: &[Node], edges: &[Edge<'_>]) -> (Vec<usize>, Vec<usize>) {
    // Insertion order of the scheduled nodes, as the Map in TypeScript keeps it.
    let mut incoming: Vec<(usize, i64)> = nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| node.scheduled)
        .map(|(index, _)| (index, 0))
        .collect();
    let slot: HashMap<usize, usize> = incoming
        .iter()
        .enumerate()
        .map(|(at, (index, _))| (*index, at))
        .collect();
    let mut outgoing: HashMap<usize, Vec<usize>> = HashMap::new();
    for edge in edges {
        incoming[slot[&edge.to]].1 += 1;
        outgoing.entry(edge.from).or_default().push(edge.to);
    }
    let mut queue: Vec<usize> = incoming
        .iter()
        .filter(|(_, count)| *count == 0)
        .map(|(index, _)| *index)
        .collect();
    queue.sort_unstable();
    let mut order = Vec::new();
    let mut head = 0;
    while head < queue.len() {
        let current = queue[head];
        head += 1;
        order.push(current);
        for to in outgoing.get(&current).cloned().unwrap_or_default() {
            let entry = &mut incoming[slot[&to]];
            entry.1 -= 1;
            if entry.1 == 0 {
                queue.push(to);
            }
        }
    }
    let placed: HashSet<usize> = order.iter().copied().collect();
    let mut cyclic: Vec<usize> = incoming
        .iter()
        .map(|(index, _)| *index)
        .filter(|index| !placed.contains(index))
        .collect();
    cyclic.sort_unstable();
    (order, cyclic)
}

/// `computeSchedule(input)`.
pub fn compute_schedule(input: &ScheduleInput) -> ScheduleResult {
    let cal = WorkingCalendar::new(&input.calendar);
    let pinned: HashSet<&str> = input.pinned_task_ids.iter().map(String::as_str).collect();
    let mut nodes: Vec<Node> = input
        .tasks
        .iter()
        .map(|task| plan_node(&cal, task, &pinned))
        .collect();
    // `new Map(...)` keeps the last task of an id, and so does this.
    let by_id: HashMap<String, usize> = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| (node.id.clone(), index))
        .collect();

    // Links between two tasks of the network; the rest are ignored.
    let mut edges: Vec<Edge<'_>> = Vec::new();
    for link in &input.links {
        let (Some(&from), Some(&to)) = (
            by_id.get(&link.predecessor_id),
            by_id.get(&link.successor_id),
        ) else {
            continue;
        };
        if from == to || !nodes[from].scheduled || !nodes[to].scheduled {
            continue;
        }
        edges.push(Edge { link, from, to });
        nodes[from].linked = true;
        nodes[to].linked = true;
    }
    let mut incoming_of: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut outgoing_of: HashMap<usize, Vec<usize>> = HashMap::new();
    for (at, edge) in edges.iter().enumerate() {
        incoming_of.entry(edge.to).or_default().push(at);
        outgoing_of.entry(edge.from).or_default().push(at);
    }

    let (order, cyclic) = order_nodes(&nodes, &edges);
    for index in &cyclic {
        nodes[*index].cyclic = true;
    }

    // Forward pass. A task in a cycle is placed after the rest, from the
    // predecessors that are already placed.
    let mut placed: HashSet<usize> = HashSet::new();
    for index in order.iter().chain(cyclic.iter()) {
        let index = *index;
        if !nodes[index].done && !nodes[index].pinned {
            let mut start = nodes[index].planned_start;
            for at in incoming_of.get(&index).into_iter().flatten() {
                let edge = &edges[*at];
                if !placed.contains(&edge.from) {
                    continue;
                }
                let from = &nodes[edge.from];
                start = start.max(required_start(
                    &cal,
                    edge.link.kind,
                    edge.link.lag_days,
                    from.early_start,
                    from.early_finish,
                    nodes[index].duration,
                ));
            }
            let early_start = cal.next_working(start);
            nodes[index].early_start = early_start;
            nodes[index].early_finish = cal.add(early_start, nodes[index].duration - 1);
        }
        placed.insert(index);
    }

    let finish = nodes
        .iter()
        .filter(|node| node.scheduled)
        .map(|node| node.early_finish)
        .max();

    // Backward pass over the acyclic part, from the project finish.
    if let Some(finish) = finish {
        for index in order.iter().rev() {
            let index = *index;
            if nodes[index].done {
                nodes[index].late_start = nodes[index].early_start;
                nodes[index].late_finish = nodes[index].early_finish;
                continue;
            }
            let mut late_finish = finish;
            for at in outgoing_of.get(&index).into_iter().flatten() {
                let edge = &edges[*at];
                let to = &nodes[edge.to];
                if to.cyclic {
                    continue;
                }
                late_finish = late_finish.min(latest_finish(
                    &cal,
                    edge.link.kind,
                    edge.link.lag_days,
                    to.late_start,
                    to.late_finish,
                    nodes[index].duration,
                ));
            }
            nodes[index].late_finish = late_finish;
            nodes[index].late_start = cal.add(late_finish, -(nodes[index].duration - 1));
        }
    }

    let tasks: Vec<ScheduledTask> = nodes
        .iter()
        .map(|node| {
            if !node.scheduled {
                return ScheduledTask {
                    id: node.id.clone(),
                    scheduled: false,
                    done: node.done,
                    planned_start: None,
                    planned_finish: None,
                    duration_days: None,
                    early_start: None,
                    early_finish: None,
                    late_start: None,
                    late_finish: None,
                    total_float: None,
                    critical: false,
                    shift_days: 0,
                    linked: false,
                };
            }
            let has_float = !node.done && !node.cyclic;
            let total_float = has_float.then(|| cal.diff(node.early_start, node.late_start));
            ScheduledTask {
                id: node.id.clone(),
                scheduled: true,
                done: node.done,
                planned_start: Some(iso_date(node.planned_start)),
                planned_finish: Some(iso_date(node.planned_finish)),
                duration_days: Some(node.duration),
                early_start: Some(iso_date(node.early_start)),
                early_finish: Some(iso_date(node.early_finish)),
                late_start: (!node.cyclic).then(|| iso_date(node.late_start)),
                late_finish: (!node.cyclic).then(|| iso_date(node.late_finish)),
                total_float,
                critical: has_float && total_float == Some(0) && node.linked,
                shift_days: if node.done {
                    0
                } else {
                    cal.diff(node.planned_start, node.early_start)
                },
                linked: node.linked,
            }
        })
        .collect();

    let mut critical: Vec<(usize, &ScheduledTask)> = tasks
        .iter()
        .enumerate()
        .filter(|(_, task)| task.critical)
        .collect();
    critical.sort_by(|(ai, a), (bi, b)| {
        a.early_start
            .cmp(&b.early_start)
            .then_with(|| a.early_finish.cmp(&b.early_finish))
            .then_with(|| ai.cmp(bi))
    });
    let critical_path: Vec<String> = critical.iter().map(|(_, task)| task.id.clone()).collect();

    // Conflicts against the planned dates, link by link.
    let mut conflicts = Vec::new();
    for edge in &edges {
        let from = &nodes[edge.from];
        let to = &nodes[edge.to];
        if to.done {
            continue;
        }
        let required = required_start(
            &cal,
            edge.link.kind,
            edge.link.lag_days,
            from.planned_start,
            from.planned_finish,
            to.duration,
        );
        if to.planned_start < required {
            conflicts.push(ScheduleConflict {
                link_id: edge.link.id.clone(),
                predecessor_id: from.id.clone(),
                successor_id: to.id.clone(),
                kind: edge.link.kind,
                lag_days: edge.link.lag_days,
                required_start: iso_date(required),
                planned_start: iso_date(to.planned_start),
                short_by_days: cal.diff(to.planned_start, required),
            });
        }
    }

    let go_live_day = input.go_live.as_deref().and_then(day_number);
    ScheduleResult {
        tasks,
        conflicts,
        critical_path,
        finish: finish.map(iso_date),
        go_live: go_live_day.map(iso_date),
        go_live_slack_days: match (go_live_day, finish) {
            (Some(go_live), Some(finish)) => Some(cal.diff(finish, go_live)),
            _ => None,
        },
        cyclic_task_ids: cyclic
            .iter()
            .map(|index| nodes[*index].id.clone())
            .collect(),
    }
}

// ── Moving a task ───────────────────────────────────────────────────────────

/// `MoveRequest`: the task, and the dates it should get (one given keeps its
/// duration).
#[derive(Debug, Clone, Default)]
pub struct MoveRequest {
    pub task_id: String,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
}

/// One task's planned dates and the dates it would have after the move.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MovedTask {
    pub task_id: String,
    pub from_start: Option<String>,
    pub from_finish: Option<String>,
    pub to_start: String,
    pub to_finish: String,
    pub shift_days: i64,
}

impl MovedTask {
    pub fn to_json(&self) -> Value {
        json!({
            "taskId": self.task_id,
            "fromStart": self.from_start,
            "fromFinish": self.from_finish,
            "toStart": self.to_start,
            "toFinish": self.to_finish,
            "shiftDays": self.shift_days,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveFailureCode {
    TaskNotFound,
    TaskClosed,
    DatesMissing,
    DatesReversed,
    DatesInvalid,
}

impl MoveFailureCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TaskNotFound => "task_not_found",
            Self::TaskClosed => "task_closed",
            Self::DatesMissing => "dates_missing",
            Self::DatesReversed => "dates_reversed",
            Self::DatesInvalid => "dates_invalid",
        }
    }
}

/// `MOVE_MESSAGES`.
pub mod move_messages {
    pub const TASK_NOT_FOUND: &str = "Task not found in this schedule";
    pub const TASK_CLOSED: &str = "A done or cancelled task cannot be moved";
    pub const DATES_MISSING: &str = "Give a start date, a due date, or both";
    pub const DATES_REVERSED: &str = "The due date cannot be before the start date";
    pub const DATES_INVALID: &str = "Dates must be real dates in the form YYYY-MM-DD";
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveFailure {
    pub code: MoveFailureCode,
    pub message: &'static str,
}

/// The finish and the go-live float of a schedule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outlook {
    pub finish: Option<String>,
    pub go_live_slack_days: Option<i64>,
}

impl Outlook {
    pub fn to_json(&self) -> Value {
        json!({ "finish": self.finish, "goLiveSlackDays": self.go_live_slack_days })
    }
}

#[derive(Debug, Clone)]
pub struct MovePreview {
    pub task_id: String,
    pub start_date: String,
    pub due_date: String,
    pub moved: Vec<MovedTask>,
    pub new_conflicts: Vec<ScheduleConflict>,
    pub before: Outlook,
    pub after: Outlook,
    pub schedule: ScheduleResult,
}

impl MovePreview {
    /// The preview without the schedule behind it, as the tests compare it.
    pub fn to_json(&self) -> Value {
        json!({
            "ok": true,
            "taskId": self.task_id,
            "task": { "startDate": self.start_date, "dueDate": self.due_date },
            "moved": self.moved.iter().map(MovedTask::to_json).collect::<Vec<_>>(),
            "newConflicts": self.new_conflicts.iter().map(ScheduleConflict::to_json).collect::<Vec<_>>(),
            "before": self.before.to_json(),
            "after": self.after.to_json(),
        })
    }
}

/// The tasks that wait, directly or through other tasks, for `task_id`.
fn reachable_from(task_id: &str, links: &[ScheduleLinkInput]) -> HashSet<String> {
    let mut successors: HashMap<&str, Vec<&str>> = HashMap::new();
    for link in links {
        successors
            .entry(link.predecessor_id.as_str())
            .or_default()
            .push(link.successor_id.as_str());
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut stack: Vec<&str> = successors.get(task_id).cloned().unwrap_or_default();
    while let Some(current) = stack.pop() {
        if seen.contains(current) || current == task_id {
            continue;
        }
        seen.insert(current.to_owned());
        stack.extend(successors.get(current).cloned().unwrap_or_default());
    }
    seen
}

/// `previewMove(input, move)`: what moving one task does.
pub fn preview_move(
    input: &ScheduleInput,
    request: &MoveRequest,
) -> Result<MovePreview, MoveFailure> {
    let cal = WorkingCalendar::new(&input.calendar);
    let failure = |code, message| Err(MoveFailure { code, message });
    let Some(target_index) = input
        .tasks
        .iter()
        .position(|task| task.id == request.task_id)
    else {
        return failure(MoveFailureCode::TaskNotFound, move_messages::TASK_NOT_FOUND);
    };
    let target = &input.tasks[target_index];
    if target.status == "done" || target.status == "cancelled" {
        return failure(MoveFailureCode::TaskClosed, move_messages::TASK_CLOSED);
    }
    let start_given = request.start_date.as_deref();
    let due_given = request.due_date.as_deref();
    if start_given.is_none() && due_given.is_none() {
        return failure(MoveFailureCode::DatesMissing, move_messages::DATES_MISSING);
    }
    let start_day = start_given.map(day_number);
    let due_day = due_given.map(day_number);
    if matches!(start_day, Some(None)) || matches!(due_day, Some(None)) {
        return failure(MoveFailureCode::DatesInvalid, move_messages::DATES_INVALID);
    }
    let (start_day, due_day) = (start_day.flatten(), due_day.flatten());
    if let (Some(start), Some(due)) = (start_day, due_day)
        && due < start
    {
        return failure(
            MoveFailureCode::DatesReversed,
            move_messages::DATES_REVERSED,
        );
    }

    let before = compute_schedule(input);
    let current = &before.tasks[target_index];
    let duration = current.duration_days.unwrap_or(1);
    let (new_start, new_due) = match (start_day, due_day) {
        (Some(start), Some(due)) => (start, due),
        (Some(start), None) => (start, cal.add(cal.next_working(start), duration - 1)),
        (None, due) => {
            let due = due.unwrap_or(0);
            (cal.add(cal.next_working(due), -(duration - 1)), due)
        }
    };
    let (task_start, task_due) = (iso_date(new_start), iso_date(new_due));

    // Only the moved task changes dates; it keeps them even when its own
    // predecessors would push it (that shows as a conflict).
    let mut moved_input = input.clone();
    for task in &mut moved_input.tasks {
        if task.id == request.task_id {
            task.start_date = Some(task_start.clone());
            task.due_date = Some(task_due.clone());
        }
    }
    moved_input.pinned_task_ids.push(request.task_id.clone());
    let after = compute_schedule(&moved_input);

    let downstream = reachable_from(&request.task_id, &input.links);
    let own = &after.tasks[target_index];
    let mut moved = vec![MovedTask {
        task_id: request.task_id.clone(),
        from_start: current.planned_start.clone(),
        from_finish: current.planned_finish.clone(),
        to_start: own.planned_start.clone().unwrap_or_default(),
        to_finish: own.planned_finish.clone().unwrap_or_default(),
        shift_days: match (&current.planned_start, &own.planned_start) {
            (Some(from), Some(to)) => cal.diff(
                day_number(from).unwrap_or_default(),
                day_number(to).unwrap_or_default(),
            ),
            _ => 0,
        },
    }];
    let mut pushed: Vec<MovedTask> = after
        .tasks
        .iter()
        .filter(|task| {
            task.id != request.task_id
                && task.scheduled
                && !task.done
                && task.shift_days > 0
                && downstream.contains(&task.id)
        })
        .map(|task| MovedTask {
            task_id: task.id.clone(),
            from_start: task.planned_start.clone(),
            from_finish: task.planned_finish.clone(),
            to_start: task.early_start.clone().unwrap_or_default(),
            to_finish: task.early_finish.clone().unwrap_or_default(),
            shift_days: task.shift_days,
        })
        .collect();
    pushed.sort_by(|a, b| {
        a.to_start
            .cmp(&b.to_start)
            .then_with(|| a.to_finish.cmp(&b.to_finish))
            .then_with(|| a.task_id.cmp(&b.task_id))
    });
    moved.extend(pushed);

    let known: HashSet<&str> = before
        .conflicts
        .iter()
        .map(|c| c.link_id.as_str())
        .collect();
    let new_conflicts: Vec<ScheduleConflict> = after
        .conflicts
        .iter()
        .filter(|conflict| !known.contains(conflict.link_id.as_str()))
        .cloned()
        .collect();
    Ok(MovePreview {
        task_id: request.task_id.clone(),
        start_date: task_start,
        due_date: task_due,
        moved,
        new_conflicts,
        before: Outlook {
            finish: before.finish.clone(),
            go_live_slack_days: before.go_live_slack_days,
        },
        after: Outlook {
            finish: after.finish.clone(),
            go_live_slack_days: after.go_live_slack_days,
        },
        schedule: after,
    })
}

// ── Deliverables ────────────────────────────────────────────────────────────

/// `projectDeliverables(deliverableIds, taskRefs, schedule)`: where each
/// deliverable ends, by the early finish of its latest task. `task_refs` are
/// `(deliverable id, task id)` pairs.
pub fn project_deliverables(
    deliverable_ids: &[String],
    task_refs: &[(String, String)],
    schedule: &ScheduleResult,
) -> Vec<Option<String>> {
    let finishes: HashMap<&str, Option<&String>> = schedule
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task.early_finish.as_ref()))
        .collect();
    deliverable_ids
        .iter()
        .map(|deliverable| {
            let mut latest: Option<&String> = None;
            for (ref_deliverable, task_id) in task_refs {
                if ref_deliverable != deliverable {
                    continue;
                }
                if let Some(Some(finish)) = finishes.get(task_id.as_str())
                    && latest.is_none_or(|current| *finish > current)
                {
                    latest = Some(finish);
                }
            }
            latest.cloned()
        })
        .collect()
}

/// `workingDaysBetween(calendar, from, to)`: signed working days between two
/// `YYYY-MM-DD` dates (`to` later is positive), `None` for a bad date.
pub fn working_days_between(calendar: &ScheduleCalendar, from: &str, to: &str) -> Option<i64> {
    let (a, b) = (day_number(from)?, day_number(to)?);
    Some(WorkingCalendar::new(calendar).diff(a, b))
}

/// `withTimeOfDay(day, original)`: the new day with the time of day the
/// stored date had (UTC midnight when it had none), as milliseconds.
pub fn with_time_of_day(day: &str, original_millis: Option<i64>) -> Option<i64> {
    let base = day_number(day)? * MS_PER_DAY;
    let time_of_day = original_millis.map_or(0, |millis| millis.rem_euclid(MS_PER_DAY));
    Some(base + time_of_day)
}

/// `dateOf(value)`: the `YYYY-MM-DD` of a stored timestamp (its UTC date).
pub fn date_of(iso: &str) -> Option<String> {
    crate::js::js_date(iso).map(|text| text[..10].to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str =
        include_str!("../../../../packages/domains/flow/src/testing/schedule-fixtures.json");

    fn fixtures() -> Value {
        serde_json::from_str(FIXTURES).expect("the shared fixtures are JSON")
    }

    fn text(value: &Value, key: &str) -> Option<String> {
        value.get(key).and_then(Value::as_str).map(str::to_owned)
    }

    fn calendar_of(value: Option<&Value>, fallback: &ScheduleCalendar) -> ScheduleCalendar {
        match value {
            Some(calendar) => ScheduleCalendar {
                working_days: calendar["workingDays"]
                    .as_array()
                    .map(|days| days.iter().filter_map(Value::as_i64).collect())
                    .unwrap_or_default(),
                holidays: calendar["holidays"]
                    .as_array()
                    .map(|days| {
                        days.iter()
                            .filter_map(|d| d.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
            },
            None => fallback.clone(),
        }
    }

    fn input_of(input: &Value, fallback: &ScheduleCalendar) -> ScheduleInput {
        ScheduleInput {
            tasks: input["tasks"]
                .as_array()
                .expect("tasks")
                .iter()
                .map(|task| ScheduleTaskInput {
                    id: text(task, "id").expect("id"),
                    status: text(task, "status").expect("status"),
                    start_date: text(task, "startDate"),
                    due_date: text(task, "dueDate"),
                })
                .collect(),
            links: input["links"]
                .as_array()
                .expect("links")
                .iter()
                .map(|link| ScheduleLinkInput {
                    id: text(link, "id").expect("id"),
                    predecessor_id: text(link, "predecessorId").expect("predecessor"),
                    successor_id: text(link, "successorId").expect("successor"),
                    kind: DependencyKind::parse(link["type"].as_str().expect("type"))
                        .expect("kind"),
                    lag_days: link["lagDays"].as_i64().expect("lag"),
                })
                .collect(),
            calendar: calendar_of(input.get("calendar"), fallback),
            go_live: text(input, "goLive"),
            pinned_task_ids: Vec::new(),
        }
    }

    /// Every field of `expected` must match `actual` exactly; arrays match
    /// element by element (the rule of `expectSubset` in schedule.test.ts).
    fn expect_subset(actual: &Value, expected: &Value, path: &str) {
        match expected {
            Value::Array(items) => {
                let list = actual
                    .as_array()
                    .unwrap_or_else(|| panic!("{path} is a list, got {actual}"));
                assert_eq!(list.len(), items.len(), "{path} length: {actual}");
                for (index, item) in items.iter().enumerate() {
                    expect_subset(&list[index], item, &format!("{path}[{index}]"));
                }
            }
            Value::Object(fields) => {
                assert!(actual.is_object(), "{path} is an object, got {actual}");
                for (key, value) in fields {
                    expect_subset(
                        actual.get(key).unwrap_or(&Value::Null),
                        value,
                        &format!("{path}.{key}"),
                    );
                }
            }
            other => assert_eq!(actual, other, "{path}"),
        }
    }

    #[test]
    fn the_shared_schedule_fixtures_give_the_same_answers_as_typescript() {
        let all = fixtures();
        let calendar = calendar_of(all.get("calendar"), &normalize_calendar(None, None));
        for fixture in all["schedule"].as_array().expect("schedule cases") {
            let name = fixture["name"].as_str().expect("name");
            let input = input_of(&fixture["input"], &calendar);
            let result = compute_schedule(&input);
            let answer = result.to_json();
            let mut expected = fixture["expected"].clone();
            let tasks = expected
                .as_object_mut()
                .and_then(|map| map.remove("tasks"))
                .unwrap_or(Value::Null);
            expect_subset(&answer, &expected, name);
            let by_id: HashMap<String, Value> = answer["tasks"]
                .as_array()
                .expect("tasks")
                .iter()
                .map(|task| {
                    (
                        task["id"].as_str().unwrap_or_default().to_owned(),
                        task.clone(),
                    )
                })
                .collect();
            for (id, want) in tasks.as_object().into_iter().flatten() {
                let got = by_id
                    .get(id)
                    .unwrap_or_else(|| panic!("{name}: task {id} is in the result"));
                expect_subset(got, want, &format!("{name}.tasks.{id}"));
            }
            let ids: Vec<&str> = input.tasks.iter().map(|task| task.id.as_str()).collect();
            let got: Vec<&str> = result.tasks.iter().map(|task| task.id.as_str()).collect();
            assert_eq!(got, ids, "{name}: one entry per input task, in order");
        }
    }

    #[test]
    fn the_shared_move_fixtures_give_the_same_answers_as_typescript() {
        let all = fixtures();
        let calendar = calendar_of(all.get("calendar"), &normalize_calendar(None, None));
        for fixture in all["moves"].as_array().expect("move cases") {
            let name = fixture["name"].as_str().expect("name");
            let input = input_of(&fixture["input"], &calendar);
            let request = MoveRequest {
                task_id: text(&fixture["move"], "taskId").expect("task"),
                start_date: text(&fixture["move"], "startDate"),
                due_date: text(&fixture["move"], "dueDate"),
            };
            let answer = match preview_move(&input, &request) {
                Ok(preview) => preview.to_json(),
                Err(failure) => json!({
                    "ok": false,
                    "code": failure.code.as_str(),
                    "message": failure.message,
                }),
            };
            expect_subset(&answer, &fixture["expected"], name);
        }
    }

    #[test]
    fn a_move_answers_the_schedule_after_it() {
        let all = fixtures();
        let calendar = calendar_of(all.get("calendar"), &normalize_calendar(None, None));
        let fixture = &all["moves"][0];
        let preview = preview_move(
            &input_of(&fixture["input"], &calendar),
            &MoveRequest {
                task_id: "A".to_owned(),
                start_date: Some("2026-11-04".to_owned()),
                due_date: None,
            },
        )
        .expect("a move");
        let by_id: HashMap<&str, &ScheduledTask> = preview
            .schedule
            .tasks
            .iter()
            .map(|task| (task.id.as_str(), task))
            .collect();
        assert_eq!(by_id["A"].planned_start.as_deref(), Some("2026-11-04"));
        assert_eq!(by_id["B"].early_start.as_deref(), Some("2026-11-11"));
        assert_eq!(by_id["C"].early_finish.as_deref(), Some("2026-11-17"));
        assert_eq!(by_id["X"].shift_days, 0);
    }

    #[test]
    fn dates_are_real_calendar_dates_only() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("2026-11-02"), Some(20_759));
        for bad in [
            "2026-02-30",
            "2026-13-01",
            "26-11-02",
            "2026-11-02T00:00:00Z",
            "",
            "2027-02-29",
            "0050-01-01",
            "2026/11/02",
            "2026-1-02",
        ] {
            assert_eq!(day_number(bad), None, "{bad}");
        }
        assert!(day_number("2028-02-29").is_some());
        assert_eq!(iso_date(day_number("2026-11-02").unwrap()), "2026-11-02");
        assert_eq!(iso_weekday(day_number("2026-11-02").unwrap()), 1);
        assert_eq!(iso_weekday(day_number("2026-11-08").unwrap()), 7);
        assert_eq!(iso_weekday(0), 4);
        assert_eq!(iso_weekday(-1), 3);
    }

    #[test]
    fn working_days_between_two_dates_are_signed() {
        let cal = normalize_calendar(None, None);
        assert_eq!(
            working_days_between(&cal, "2026-11-02", "2026-11-09"),
            Some(5)
        );
        assert_eq!(
            working_days_between(&cal, "2026-11-09", "2026-11-02"),
            Some(-5)
        );
        assert_eq!(
            working_days_between(&cal, "2026-11-06", "2026-11-09"),
            Some(1)
        );
        assert_eq!(
            working_days_between(&cal, "2026-11-02", "2026-11-02"),
            Some(0)
        );
        let holiday = ScheduleCalendar {
            working_days: vec![1, 2, 3, 4, 5],
            holidays: vec!["2026-11-09".to_owned()],
        };
        assert_eq!(
            working_days_between(&holiday, "2026-11-06", "2026-11-10"),
            Some(1)
        );
        assert_eq!(working_days_between(&cal, "nope", "2026-11-02"), None);
    }

    #[test]
    fn a_stored_date_keeps_its_time_of_day_when_a_save_moves_it() {
        let stored = 1_793_611_800_000; // 2026-11-02T09:30:00.000Z
        let moved = with_time_of_day("2026-11-09", Some(stored)).expect("a day");
        assert_eq!(
            crate::js::iso_from_millis(moved).as_deref(),
            Some("2026-11-09T09:30:00.000Z")
        );
        let midnight = with_time_of_day("2026-11-09", None).expect("a day");
        assert_eq!(
            crate::js::iso_from_millis(midnight).as_deref(),
            Some("2026-11-09T00:00:00.000Z")
        );
        assert_eq!(
            date_of("2026-11-02T09:30:00.000Z").as_deref(),
            Some("2026-11-02")
        );
        assert_eq!(date_of("not a date"), None);
    }

    #[test]
    fn the_calendar_falls_back_to_monday_to_friday_and_drops_unusable_entries() {
        assert_eq!(
            normalize_calendar(None, None),
            ScheduleCalendar {
                working_days: vec![1, 2, 3, 4, 5],
                holidays: Vec::new()
            }
        );
        assert_eq!(
            normalize_calendar(
                Some(&json!([])),
                Some(&json!(["x", "2026-12-25", "2026-12-25"]))
            ),
            ScheduleCalendar {
                working_days: vec![1, 2, 3, 4, 5],
                holidays: vec!["2026-12-25".to_owned()]
            }
        );
        assert_eq!(
            normalize_calendar(Some(&json!([7, 0, 3, 3, 8, 1.5, "x"])), None).working_days,
            vec![3, 7]
        );
    }

    #[test]
    fn a_one_day_week_still_schedules() {
        let result = compute_schedule(&ScheduleInput {
            tasks: vec![ScheduleTaskInput {
                id: "A".to_owned(),
                status: "todo".to_owned(),
                start_date: Some("2026-11-02".to_owned()),
                due_date: Some("2026-11-03".to_owned()),
            }],
            links: Vec::new(),
            calendar: ScheduleCalendar {
                working_days: vec![1],
                holidays: Vec::new(),
            },
            go_live: None,
            pinned_task_ids: Vec::new(),
        });
        assert_eq!(result.tasks[0].duration_days, Some(1));
    }

    #[test]
    fn a_deliverable_ends_with_its_latest_task() {
        let cal = normalize_calendar(None, None);
        let task = |id: &str, status: &str, start: &str, due: &str| ScheduleTaskInput {
            id: id.to_owned(),
            status: status.to_owned(),
            start_date: Some(start.to_owned()),
            due_date: Some(due.to_owned()),
        };
        let schedule = compute_schedule(&ScheduleInput {
            tasks: vec![
                task("A", "todo", "2026-11-02", "2026-11-04"),
                task("B", "todo", "2026-11-09", "2026-11-10"),
                task("C", "cancelled", "2026-11-02", "2026-12-01"),
            ],
            links: Vec::new(),
            calendar: cal,
            go_live: None,
            pinned_task_ids: Vec::new(),
        });
        let ends = project_deliverables(
            &["d1".to_owned(), "d2".to_owned(), "d3".to_owned()],
            &[
                ("d1".to_owned(), "A".to_owned()),
                ("d1".to_owned(), "B".to_owned()),
                ("d2".to_owned(), "C".to_owned()),
            ],
            &schedule,
        );
        assert_eq!(ends, vec![Some("2026-11-10".to_owned()), None, None]);
    }
}
