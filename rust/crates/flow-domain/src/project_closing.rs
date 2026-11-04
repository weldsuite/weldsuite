//! Closing a project: lessons learned and the close checklist (design:
//! weldflow-delivery-and-portfolio.md, "Close a project"; slice F).
//!
//! Pure functions, no database and no Hono context: the mirror of
//! `@weldsuite/flow-domain/project-closing`, with the working-day helpers of
//! `@weldsuite/app-api-client/schemas/project-closing` the templates count
//! dates with. Every message returned here is sent to the client as it is, so
//! the two backends answer alike.
//!
//! Rows are the camelCase JSON the routes read (`js_row`).

use std::cmp::Ordering;

use serde_json::{Value, json};

use crate::blueprint::Json;
use crate::js::{millis_of, number_value, slice_utf16, to_fixed};

// ── Messages ────────────────────────────────────────────────────────────────

/// The label of a lesson in a 404.
pub const LESSON_LABEL: &str = "Lesson";
pub const NO_LESSONS: &str = "There are no lessons to publish";
pub const NOT_AUTHOR: &str = "Only the author of a lesson or a project manager can change it";
pub const ALREADY_CLOSED: &str = "This project is already closed";
pub const CHECKLIST_OPEN: &str = "Finish the open checks before asking for sign-off";
pub const ALREADY_REQUESTED: &str = "Sign-off has already been requested";
pub const NO_SPONSOR: &str = "The project has no sponsor or project manager to ask for sign-off";
pub const NOTHING_TO_HAND_OVER: &str = "Choose at least one item to hand over";
pub const HANDOVER_RAID_ITEM: &str = "RAID item not found, or no longer open, in this project";
pub const HANDOVER_BENEFIT: &str = "Benefit not found, or already closed, in this project";

// ── Lessons ─────────────────────────────────────────────────────────────────

pub const LESSON_CATEGORIES: [&str; 3] = ["went_well", "went_badly", "do_differently"];
pub const LESSON_PAGE_LOCALES: [&str; 2] = ["en", "nl"];

/// The member ids that voted for a lesson.
pub fn votes_of(row: &Value) -> Vec<&str> {
    row.items("votes")
        .iter()
        .filter_map(Value::as_str)
        .collect()
}

/// A lesson as the routes answer it (`presentLesson`): the votes counted, and
/// whether the caller is one of them.
pub fn present_lesson(row: &Value, user_id: Option<&str>) -> Value {
    let votes = votes_of(row);
    let voted_by_me = user_id.is_some_and(|user| !user.is_empty() && votes.contains(&user));
    json!({
        "id": row.at("id"),
        "projectId": row.at("projectId"),
        "category": row.at("category"),
        "text": row.at("text"),
        "authorId": row.at("authorId"),
        "voteCount": votes.len(),
        "votedByMe": voted_by_me,
        "knowPageId": row.at("knowPageId"),
        "createdBy": row.at("createdBy"),
        "createdAt": row.at("createdAt"),
        "updatedAt": row.at("updatedAt"),
    })
}

/// The payload of a `project_lesson` event (`lessonEventData`): ids and
/// counts, no free text.
pub fn lesson_event_data(row: &Value) -> Value {
    json!({
        "id": row.at("id"),
        "projectId": row.at("projectId"),
        "category": row.at("category"),
        "authorId": row.at("authorId"),
        "voteCount": votes_of(row).len(),
        "knowPageId": row.at("knowPageId"),
    })
}

/// May this person edit or delete the lesson (`mayChangeLesson`): its author,
/// or someone who manages the project.
pub fn may_change_lesson(author_id: &str, user_id: Option<&str>, can_manage: bool) -> bool {
    can_manage || user_id.is_some_and(|user| !user.is_empty() && author_id == user)
}

/// The language a published page's headings are written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LessonPageLocale {
    En,
    Nl,
}

impl LessonPageLocale {
    /// `en` or `nl`.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "en" => Some(Self::En),
            "nl" => Some(Self::Nl),
            _ => None,
        }
    }

    /// The heading of a category on the page.
    fn category(self, category: &str) -> &'static str {
        match (self, category) {
            (Self::En, "went_well") => "Went well",
            (Self::En, "went_badly") => "Didn't go well",
            (Self::En, _) => "Do differently",
            (Self::Nl, "went_well") => "Ging goed",
            (Self::Nl, "went_badly") => "Ging niet goed",
            (Self::Nl, _) => "Anders doen",
        }
    }

    /// `1 vote`, `2 votes`.
    fn votes(self, count: usize) -> String {
        let (one, many) = match self {
            Self::En => ("vote", "votes"),
            Self::Nl => ("stem", "stemmen"),
        };
        format!("{count} {}", if count == 1 { one } else { many })
    }

    fn default_title(self, project_name: &str) -> String {
        match self {
            Self::En => format!("Lessons learned: {project_name}"),
            Self::Nl => format!("Geleerde lessen: {project_name}"),
        }
    }
}

/// The page title (`lessonsPageTitle`): the given one, else the default for
/// the language, at most 500 characters.
pub fn lessons_page_title(
    project_name: &str,
    locale: LessonPageLocale,
    given: Option<&str>,
) -> String {
    let title = match given {
        Some(given) if !given.is_empty() => given.to_owned(),
        _ => locale.default_title(project_name),
    };
    slice_utf16(&title, 500)
}

/// Most votes first, then oldest first, then by id (`compareLessons`): the
/// order of a category on the board and on the page.
pub fn compare_lessons(a: &Value, b: &Value) -> Ordering {
    let by_votes = votes_of(b).len().cmp(&votes_of(a).len());
    if by_votes != Ordering::Equal {
        return by_votes;
    }
    let created = |row: &Value| row.text("createdAt").and_then(millis_of);
    created(a)
        .cmp(&created(b))
        .then_with(|| a.text("id").cmp(&b.text("id")))
}

/// The `BlockNote` blocks of the published page (`lessonBlocks`): a level-2
/// heading per category that has lessons, then one bullet per lesson, most
/// votes first, with its votes in brackets when it has any.
pub fn lesson_blocks(rows: &[Value], locale: LessonPageLocale) -> Vec<Value> {
    let mut blocks = Vec::new();
    for category in LESSON_CATEGORIES {
        let mut lessons: Vec<&Value> = rows
            .iter()
            .filter(|row| row.text("category") == Some(category))
            .collect();
        if lessons.is_empty() {
            continue;
        }
        lessons.sort_by(|a, b| compare_lessons(a, b));
        blocks.push(json!({
            "type": "heading",
            "props": { "level": 2 },
            "content": [{ "type": "text", "text": locale.category(category), "styles": {} }],
            "children": [],
        }));
        for lesson in lessons {
            let votes = votes_of(lesson).len();
            let text = lesson.text("text").unwrap_or_default();
            let line = if votes > 0 {
                format!("{text} ({})", locale.votes(votes))
            } else {
                text.to_owned()
            };
            blocks.push(json!({
                "type": "bulletListItem",
                "content": [{ "type": "text", "text": line, "styles": {} }],
                "children": [],
            }));
        }
    }
    blocks
}

// ── The close checklist ─────────────────────────────────────────────────────

/// What the approval rows of the close request add up to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignOff {
    None,
    Pending,
    Approved,
    Rejected,
}

impl SignOff {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
        }
    }
}

/// What the approval rows of the close request add up to (`signOffState`):
/// none, waiting, approved or declined.
pub fn sign_off_state(decisions: &[&str]) -> SignOff {
    if decisions.is_empty() {
        return SignOff::None;
    }
    if decisions.contains(&"rejected") {
        return SignOff::Rejected;
    }
    if decisions
        .iter()
        .all(|decision| matches!(*decision, "approved" | "approved_with_conditions"))
    {
        return SignOff::Approved;
    }
    SignOff::Pending
}

/// What the checklist counts, read from the project's tables (`CloseCounts`).
/// Each pair is `(total, in order)` unless said otherwise.
#[derive(Debug, Clone, Copy)]
pub struct CloseCounts {
    pub closed: bool,
    /// `(total, accepted)`.
    pub deliverables: (i64, i64),
    /// Change requests: `(total, still in draft, assessing or awaiting approval)`.
    pub changes: (i64, i64),
    /// Open register items: `(open, handed over)`.
    pub raid: (i64, i64),
    /// Benefits not closed yet: `(total, with an owner and a measurement)`.
    pub benefits: (i64, i64),
    /// Time entries: `(total, still draft or submitted)`.
    pub time: (i64, i64),
    /// `(total, published)`.
    pub lessons: (i64, i64),
    pub sign_off: SignOff,
}

/// One check of the close checklist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseCheck {
    pub key: &'static str,
    /// A blocking check has to be done before sign-off can be requested.
    pub blocking: bool,
    pub done: bool,
    pub state: &'static str,
    pub total: i64,
    pub satisfied: i64,
}

impl CloseCheck {
    pub fn to_value(&self) -> Value {
        json!({
            "key": self.key,
            "blocking": self.blocking,
            "done": self.done,
            "state": self.state,
            "total": self.total,
            "satisfied": self.satisfied,
        })
    }
}

/// The checks that have to be done before sign-off can be requested.
const BLOCKING: [&str; 5] = ["deliverables", "changes", "raid", "benefits", "time"];

fn check(key: &'static str, total: i64, satisfied: i64, done: bool, waiting: bool) -> CloseCheck {
    let state = if done {
        "done"
    } else if waiting {
        "waiting"
    } else {
        "open"
    };
    CloseCheck {
        key,
        blocking: BLOCKING.contains(&key),
        done,
        state,
        total,
        satisfied,
    }
}

/// The close checklist, in the order the page lists it (`closeChecks`).
pub fn close_checks(counts: &CloseCounts) -> Vec<CloseCheck> {
    let (deliverables, accepted) = counts.deliverables;
    let (changes, open_changes) = counts.changes;
    let (open_raid, handed_over) = counts.raid;
    let (benefits, ready) = counts.benefits;
    let (time, open_time) = counts.time;
    let (lessons, published) = counts.lessons;
    let signed_off = counts.closed || counts.sign_off == SignOff::Approved;
    vec![
        check(
            "deliverables",
            deliverables,
            accepted,
            accepted == deliverables,
            false,
        ),
        check(
            "changes",
            changes,
            changes - open_changes,
            open_changes == 0,
            false,
        ),
        check(
            "raid",
            open_raid,
            handed_over,
            handed_over >= open_raid,
            false,
        ),
        check("benefits", benefits, ready, ready == benefits, false),
        check("time", time, time - open_time, open_time == 0, false),
        check(
            "lessons",
            lessons,
            published,
            lessons > 0 && published == lessons,
            false,
        ),
        check(
            "signoff",
            0,
            0,
            signed_off,
            counts.sign_off == SignOff::Pending,
        ),
    ]
}

/// Done checks out of all of them (`closeProgress`): `(done, total)`.
pub fn close_progress(checks: &[CloseCheck]) -> (usize, usize) {
    (
        checks.iter().filter(|entry| entry.done).count(),
        checks.len(),
    )
}

/// Sign-off can be requested (`canRequestClose`): the project is open, every
/// blocking check is done, and no request is waiting for an answer.
pub fn can_request_close(checks: &[CloseCheck], closed: bool, sign_off: SignOff) -> bool {
    if closed || sign_off == SignOff::Pending {
        return false;
    }
    checks.iter().all(|entry| !entry.blocking || entry.done)
}

// ── Final finance ───────────────────────────────────────────────────────────

/// Rounds half away from zero, as the TypeScript does (`roundHalfAway`).
fn round_half_away(value: f64) -> f64 {
    value.round()
}

/// `Number(value)` when it is finite, else none (`amountOf`).
fn amount_of(value: Option<&str>) -> Option<f64> {
    let parsed = weldsuite_kit::validation::js_number(value?);
    parsed.is_finite().then_some(parsed)
}

/// `value.toFixed(2)`: a negative value that rounds to zero keeps its sign.
fn fixed2(value: f64) -> String {
    let text = to_fixed(value, 2);
    if value < 0.0 && !text.starts_with('-') {
        format!("-{text}")
    } else {
        text
    }
}

/// The latest weekly finance snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinanceSnapshot {
    pub week: String,
    pub actual_cost: String,
    pub committed: String,
    pub forecast: Option<String>,
}

/// What final finance is computed from (`CloseFinanceInput`).
#[derive(Debug, Clone)]
pub struct CloseFinanceInput {
    pub currency: Option<String>,
    pub amounts_visible: bool,
    /// The budget on the latest baseline, else the project's budgeted amount.
    pub budget: Option<String>,
    /// Cost of the approved and billed time entries.
    pub time_cost: String,
    pub snapshot: Option<FinanceSnapshot>,
    /// `(version, go-live as an ISO timestamp)`.
    pub baseline: Option<(i64, Option<String>)>,
}

/// Final cost against budget (`closeFinance`). The actual cost is the latest
/// finance snapshot's when one was written (it counts every cost source),
/// else the approved time cost. Without `projects:finance` (and not a
/// manager) the amounts are left out and only the percentage and the verdict
/// remain.
pub fn close_finance(input: &CloseFinanceInput) -> Value {
    let budget = amount_of(input.budget.as_deref());
    let actual = match &input.snapshot {
        Some(snapshot) => amount_of(Some(&snapshot.actual_cost)).unwrap_or(0.0),
        None => amount_of(Some(&input.time_cost)).unwrap_or(0.0),
    };
    let variance = budget.map(|budget| actual - budget);
    let variance_percent = match (variance, budget) {
        (Some(variance), Some(budget)) if budget > 0.0 => {
            Some(round_half_away(variance / budget * 1000.0) / 10.0)
        }
        _ => None,
    };
    let show = input.amounts_visible;
    let snapshot = input.snapshot.as_ref().filter(|_| show).map(|snapshot| {
        json!({
            "week": snapshot.week,
            "actualCost": snapshot.actual_cost,
            "committed": snapshot.committed,
            "forecast": snapshot.forecast,
        })
    });
    json!({
        "currency": input.currency,
        "amountsVisible": show,
        "budget": budget.filter(|_| show).map(fixed2),
        "timeCost": show.then(|| fixed2(amount_of(Some(&input.time_cost)).unwrap_or(0.0))),
        "snapshot": snapshot,
        "actual": show.then(|| fixed2(actual)),
        "variance": variance.filter(|_| show).map(fixed2),
        "variancePercent": variance_percent.map(number_value),
        "overBudget": variance.is_some_and(|variance| variance > 0.0),
        "baseline": input.baseline.as_ref().map(|(version, go_live)| {
            json!({ "version": version, "goLive": go_live })
        }),
    })
}

// ── Working days ────────────────────────────────────────────────────────────

/// ISO weekdays that are working days by default: Monday to Friday
/// (1 = Monday ... 7 = Sunday).
pub const DEFAULT_WORKING_DAYS: [i64; 5] = [1, 2, 3, 4, 5];

const DAY_MS: i64 = 86_400_000;

/// The ISO weekday (1 = Monday ... 7 = Sunday) of a UTC day number.
fn iso_weekday(day_number: i64) -> i64 {
    // Day 0 is 1970-01-01, a Thursday (4).
    (day_number + 3).rem_euclid(7) + 1
}

/// The UTC day number (days since 1970-01-01) of an instant (`dayNumberOf`).
pub fn day_number_of(millis: i64) -> i64 {
    millis.div_euclid(DAY_MS)
}

/// The working weekdays: the given ones, else Monday to Friday. A calendar
/// without a real weekday (one that never reaches a working day) is the
/// default too.
fn working_set(working_days: Option<&[i64]>) -> [bool; 8] {
    let mut set = [false; 8];
    for day in working_days.unwrap_or_default() {
        if let Ok(index) = usize::try_from(*day)
            && (1..=7).contains(&index)
        {
            set[index] = true;
        }
    }
    if !set.iter().any(|day| *day) {
        for day in DEFAULT_WORKING_DAYS {
            set[usize::try_from(day).unwrap_or(1)] = true;
        }
    }
    set
}

fn is_working(set: [bool; 8], day_number: i64) -> bool {
    usize::try_from(iso_weekday(day_number))
        .ok()
        .and_then(|index| set.get(index))
        .copied()
        .unwrap_or(false)
}

/// The first working day on or after the day.
fn roll_forward(day_number: i64, set: [bool; 8]) -> i64 {
    let mut day = day_number;
    while !is_working(set, day) {
        day += 1;
    }
    day
}

/// The last working day on or before the day.
fn roll_back(day_number: i64, set: [bool; 8]) -> i64 {
    let mut day = day_number;
    while !is_working(set, day) {
        day -= 1;
    }
    day
}

/// The date `offset` working days after `start` (`addWorkingDays`), in
/// epoch milliseconds. Offset 0 is the start itself when it is a working
/// day, else the next one; a negative offset counts back. The result is
/// midnight UTC.
pub fn add_working_days(start: i64, offset: i64, working_days: Option<&[i64]>) -> i64 {
    let set = working_set(working_days);
    let mut day = roll_forward(day_number_of(start), set);
    let mut remaining = offset;
    let step = if remaining < 0 { -1 } else { 1 };
    while remaining != 0 {
        day += step;
        if is_working(set, day) {
            remaining -= step;
        }
    }
    day * DAY_MS
}

/// How many working days after `start` a date falls (`workingDayOffset`): the
/// inverse of [`add_working_days`] (negative when the date is before the
/// start). A date on a non-working day counts as the working day before it.
pub fn working_day_offset(start: i64, date: i64, working_days: Option<&[i64]>) -> i64 {
    let set = working_set(working_days);
    let from = roll_forward(day_number_of(start), set);
    let to = day_number_of(date);
    if to >= from {
        let count = ((from + 1)..=to)
            .filter(|day| is_working(set, *day))
            .count();
        return i64::try_from(count).unwrap_or(i64::MAX);
    }
    let target = roll_back(to, set);
    let count = (target..from).filter(|day| is_working(set, *day)).count();
    -i64::try_from(count).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lesson(id: &str, overrides: &Value) -> Value {
        let mut row = json!({
            "id": id,
            "projectId": "prj_1",
            "category": "went_well",
            "text": "The rehearsal caught two data problems",
            "authorId": "user_a",
            "votes": [],
            "knowPageId": null,
            "createdBy": "user_a",
            "createdAt": "2026-11-01T10:00:00.000Z",
            "updatedAt": "2026-11-01T10:00:00.000Z",
            "deletedAt": null,
        });
        if let (Some(row), Some(overrides)) = (row.as_object_mut(), overrides.as_object()) {
            row.extend(overrides.clone());
        }
        row
    }

    const READY: CloseCounts = CloseCounts {
        closed: false,
        deliverables: (3, 3),
        changes: (2, 0),
        raid: (2, 2),
        benefits: (4, 4),
        time: (10, 0),
        lessons: (5, 5),
        sign_off: SignOff::None,
    };

    fn state_of(checks: &[CloseCheck], key: &str) -> &'static str {
        checks
            .iter()
            .find(|check| check.key == key)
            .map_or("", |check| check.state)
    }

    #[test]
    fn the_checklist_lists_the_seven_checks_in_order_the_first_five_blocking() {
        let checks = close_checks(&READY);
        let keys: Vec<&str> = checks.iter().map(|check| check.key).collect();
        assert_eq!(
            keys,
            [
                "deliverables",
                "changes",
                "raid",
                "benefits",
                "time",
                "lessons",
                "signoff"
            ]
        );
        let blocking: Vec<bool> = checks.iter().map(|check| check.blocking).collect();
        assert_eq!(blocking, [true, true, true, true, true, false, false]);
    }

    #[test]
    fn it_is_done_when_everything_is_in_order_except_the_sign_off_nobody_asked_for() {
        let checks = close_checks(&READY);
        let done: Vec<&str> = checks
            .iter()
            .filter(|check| check.done)
            .map(|check| check.key)
            .collect();
        assert_eq!(
            done,
            [
                "deliverables",
                "changes",
                "raid",
                "benefits",
                "time",
                "lessons"
            ]
        );
        assert_eq!(close_progress(&checks), (6, 7));
        assert!(can_request_close(&checks, false, SignOff::None));
    }

    #[test]
    fn each_check_counts_what_is_in_order() {
        let checks = close_checks(&CloseCounts {
            deliverables: (7, 5),
            changes: (9, 2),
            raid: (4, 1),
            benefits: (5, 3),
            time: (120, 20),
            ..READY
        });
        let counted: Vec<(&str, bool, i64, i64)> = checks
            .iter()
            .map(|check| (check.key, check.done, check.total, check.satisfied))
            .collect();
        assert_eq!(
            counted,
            [
                ("deliverables", false, 7, 5),
                ("changes", false, 9, 7),
                ("raid", false, 4, 1),
                ("benefits", false, 5, 3),
                ("time", false, 120, 100),
                ("lessons", true, 5, 5),
                ("signoff", false, 0, 0),
            ]
        );
    }

    #[test]
    fn a_project_with_nothing_to_check_is_done_except_lessons_which_need_one() {
        let checks = close_checks(&CloseCounts {
            deliverables: (0, 0),
            changes: (0, 0),
            raid: (0, 0),
            benefits: (0, 0),
            time: (0, 0),
            lessons: (0, 0),
            ..READY
        });
        assert!(
            checks
                .iter()
                .filter(|check| check.blocking)
                .all(|check| check.done)
        );
        assert!(
            checks
                .iter()
                .any(|check| check.key == "lessons" && !check.done)
        );
    }

    #[test]
    fn an_open_blocking_check_stops_the_request_and_the_advisory_ones_do_not() {
        let open = close_checks(&CloseCounts {
            raid: (2, 1),
            ..READY
        });
        assert!(!can_request_close(&open, false, SignOff::None));
        let unpublished = close_checks(&CloseCounts {
            lessons: (5, 0),
            ..READY
        });
        assert!(can_request_close(&unpublished, false, SignOff::None));
    }

    #[test]
    fn it_cannot_be_requested_twice_or_once_the_project_is_closed() {
        let checks = close_checks(&READY);
        assert!(!can_request_close(&checks, false, SignOff::Pending));
        assert!(!can_request_close(&checks, true, SignOff::None));
        assert!(can_request_close(&checks, false, SignOff::Rejected));
    }

    #[test]
    fn the_sign_off_waits_while_pending_and_is_done_once_approved_or_closed() {
        let state = |counts: CloseCounts| state_of(&close_checks(&counts), "signoff");
        assert_eq!(
            state(CloseCounts {
                sign_off: SignOff::Pending,
                ..READY
            }),
            "waiting"
        );
        assert_eq!(
            state(CloseCounts {
                sign_off: SignOff::Approved,
                ..READY
            }),
            "done"
        );
        assert_eq!(
            state(CloseCounts {
                closed: true,
                ..READY
            }),
            "done"
        );
        assert_eq!(
            state(CloseCounts {
                sign_off: SignOff::Rejected,
                ..READY
            }),
            "open"
        );
    }

    #[test]
    fn the_approval_rows_add_up() {
        assert_eq!(sign_off_state(&[]), SignOff::None);
        assert_eq!(sign_off_state(&["pending"]), SignOff::Pending);
        assert_eq!(sign_off_state(&["info_requested"]), SignOff::Pending);
        assert_eq!(sign_off_state(&["approved"]), SignOff::Approved);
        assert_eq!(
            sign_off_state(&["approved_with_conditions"]),
            SignOff::Approved
        );
        assert_eq!(sign_off_state(&["rejected"]), SignOff::Rejected);
        assert_eq!(sign_off_state(&["approved", "rejected"]), SignOff::Rejected);
        assert_eq!(sign_off_state(&["approved", "pending"]), SignOff::Pending);
    }

    fn finance(overrides: impl FnOnce(&mut CloseFinanceInput)) -> Value {
        let mut input = CloseFinanceInput {
            currency: Some("EUR".to_owned()),
            amounts_visible: true,
            budget: Some("193900.00".to_owned()),
            time_cost: "120000.00".to_owned(),
            snapshot: None,
            baseline: Some((5, Some("2027-01-15T00:00:00.000Z".to_owned()))),
        };
        overrides(&mut input);
        close_finance(&input)
    }

    fn snapshot(forecast: Option<&str>) -> FinanceSnapshot {
        FinanceSnapshot {
            week: "2027-W08".to_owned(),
            actual_cost: "195200.00".to_owned(),
            committed: "0.00".to_owned(),
            forecast: forecast.map(str::to_owned),
        }
    }

    #[test]
    fn finance_uses_the_approved_time_cost_without_a_snapshot() {
        let value = finance(|_| {});
        assert_eq!(value["budget"], "193900.00");
        assert_eq!(value["timeCost"], "120000.00");
        assert_eq!(value["actual"], "120000.00");
        assert_eq!(value["variance"], "-73900.00");
        assert_eq!(value["variancePercent"], json!(-38.1));
        assert_eq!(value["overBudget"], false);
        assert_eq!(
            value["baseline"],
            json!({ "version": 5, "goLive": "2027-01-15T00:00:00.000Z" })
        );
    }

    #[test]
    fn finance_prefers_the_latest_snapshots_actual_cost() {
        let value = finance(|input| input.snapshot = Some(snapshot(Some("195200.00"))));
        assert_eq!(value["actual"], "195200.00");
        assert_eq!(value["variance"], "1300.00");
        assert_eq!(value["variancePercent"], json!(0.7));
        assert_eq!(value["overBudget"], true);
        assert_eq!(value["snapshot"]["week"], "2027-W08");
        assert_eq!(value["timeCost"], "120000.00");
    }

    #[test]
    fn finance_leaves_the_amounts_out_but_keeps_the_percentage_and_the_verdict() {
        let value = finance(|input| {
            input.amounts_visible = false;
            input.snapshot = Some(snapshot(None));
        });
        assert_eq!(value["amountsVisible"], false);
        for key in ["budget", "timeCost", "snapshot", "actual", "variance"] {
            assert_eq!(value[key], Value::Null, "{key}");
        }
        assert_eq!(value["variancePercent"], json!(0.7));
        assert_eq!(value["overBudget"], true);
    }

    #[test]
    fn finance_has_no_percentage_without_a_budget() {
        let value = finance(|input| {
            input.budget = None;
            input.baseline = None;
        });
        assert_eq!(value["budget"], Value::Null);
        assert_eq!(value["variance"], Value::Null);
        assert_eq!(value["variancePercent"], Value::Null);
        assert_eq!(value["overBudget"], false);
        assert_eq!(value["baseline"], Value::Null);
        assert_eq!(value["actual"], "120000.00");
    }

    #[test]
    fn finance_rounds_the_percentage_half_away_from_zero() {
        let percent = |time_cost: &str| {
            finance(|input| {
                input.budget = Some("1000.00".to_owned());
                input.time_cost = time_cost.to_owned();
            })["variancePercent"]
                .clone()
        };
        assert_eq!(percent("1012.50"), json!(1.3));
        assert_eq!(percent("987.50"), json!(-1.3));
        assert_eq!(percent("1000.00"), json!(0));
    }

    #[test]
    fn finance_of_a_project_with_nothing_is_zero() {
        let value = finance(|input| {
            input.time_cost = "0".to_owned();
            input.budget = Some("200000.00".to_owned());
        });
        assert_eq!(value["actual"], "0.00");
        assert_eq!(value["timeCost"], "0.00");
        assert_eq!(value["variance"], "-200000.00");
    }

    #[test]
    fn a_lesson_shows_its_votes_as_a_count_and_whether_the_caller_voted() {
        let row = lesson("les_1", &json!({ "votes": ["user_a", "user_b"] }));
        assert_eq!(present_lesson(&row, Some("user_b"))["voteCount"], 2);
        assert_eq!(present_lesson(&row, Some("user_b"))["votedByMe"], true);
        assert_eq!(present_lesson(&row, Some("user_c"))["votedByMe"], false);
        assert_eq!(present_lesson(&row, None)["votedByMe"], false);
        assert!(present_lesson(&row, Some("user_b")).get("votes").is_none());
        assert_eq!(
            present_lesson(&row, None)["createdAt"],
            "2026-11-01T10:00:00.000Z"
        );
    }

    #[test]
    fn the_event_keeps_the_text_out() {
        let row = lesson("les_1", &json!({ "votes": ["user_a"] }));
        assert_eq!(
            lesson_event_data(&row),
            json!({
                "id": "les_1", "projectId": "prj_1", "category": "went_well",
                "authorId": "user_a", "voteCount": 1, "knowPageId": null,
            })
        );
    }

    #[test]
    fn the_author_or_a_manager_may_change_a_lesson() {
        assert!(may_change_lesson("user_a", Some("user_a"), false));
        assert!(!may_change_lesson("user_a", Some("user_b"), false));
        assert!(may_change_lesson("user_a", Some("user_b"), true));
        assert!(!may_change_lesson("user_a", None, false));
    }

    #[test]
    fn lessons_order_by_votes_then_oldest_then_id() {
        let mut rows = [
            lesson(
                "les_c",
                &json!({ "votes": [], "createdAt": "2026-11-01T10:00:00.000Z" }),
            ),
            lesson(
                "les_b",
                &json!({ "votes": ["x"], "createdAt": "2026-11-01T12:00:00.000Z" }),
            ),
            lesson(
                "les_a",
                &json!({ "votes": ["x"], "createdAt": "2026-11-01T11:00:00.000Z" }),
            ),
            lesson(
                "les_d",
                &json!({ "votes": [], "createdAt": "2026-11-01T10:00:00.000Z" }),
            ),
        ];
        rows.sort_by(compare_lessons);
        let ids: Vec<&str> = rows.iter().filter_map(|row| row.text("id")).collect();
        assert_eq!(ids, ["les_a", "les_b", "les_c", "les_d"]);
    }

    fn lines(blocks: &[Value]) -> Vec<String> {
        blocks
            .iter()
            .map(|block| {
                format!(
                    "{}:{}",
                    block["type"].as_str().unwrap_or_default(),
                    block["content"][0]["text"].as_str().unwrap_or_default()
                )
            })
            .collect()
    }

    #[test]
    fn the_page_has_a_heading_per_category_with_lessons_and_a_bullet_per_lesson() {
        let blocks = lesson_blocks(
            &[
                lesson(
                    "les_1",
                    &json!({ "category": "do_differently", "text": "Trial migration in month one", "votes": ["a", "b"] }),
                ),
                lesson(
                    "les_2",
                    &json!({ "category": "went_well", "text": "Portal sign-off" }),
                ),
                lesson(
                    "les_3",
                    &json!({ "category": "went_well", "text": "Weekly reports", "votes": ["a"] }),
                ),
            ],
            LessonPageLocale::En,
        );
        assert_eq!(
            lines(&blocks),
            [
                "heading:Went well",
                "bulletListItem:Weekly reports (1 vote)",
                "bulletListItem:Portal sign-off",
                "heading:Do differently",
                "bulletListItem:Trial migration in month one (2 votes)",
            ]
        );
        assert_eq!(blocks[0]["props"], json!({ "level": 2 }));
        assert_eq!(blocks[0]["children"], json!([]));
        assert_eq!(blocks[1]["content"][0]["styles"], json!({}));
    }

    #[test]
    fn the_page_can_be_written_in_dutch() {
        let blocks = lesson_blocks(
            &[lesson(
                "les_1",
                &json!({ "category": "went_badly", "text": "Te laat gestart", "votes": ["a", "b"] }),
            )],
            LessonPageLocale::Nl,
        );
        assert_eq!(
            lines(&blocks),
            [
                "heading:Ging niet goed",
                "bulletListItem:Te laat gestart (2 stemmen)"
            ]
        );
        assert_eq!(lesson_blocks(&[], LessonPageLocale::En).len(), 0);
    }

    #[test]
    fn the_page_is_named_with_a_default_per_language_and_a_limit_of_500_characters() {
        let en = LessonPageLocale::En;
        let nl = LessonPageLocale::Nl;
        assert_eq!(
            lessons_page_title("Portal", en, None),
            "Lessons learned: Portal"
        );
        assert_eq!(
            lessons_page_title("Portal", nl, None),
            "Geleerde lessen: Portal"
        );
        assert_eq!(lessons_page_title("Portal", en, Some("Retro")), "Retro");
        assert_eq!(
            lessons_page_title("Portal", en, Some("")),
            "Lessons learned: Portal"
        );
        assert_eq!(lessons_page_title(&"x".repeat(600), en, None).len(), 500);
    }

    /// Midnight UTC of a `YYYY-MM-DD` date, in epoch milliseconds.
    fn at(date: &str) -> i64 {
        crate::js::js_date_millis(&format!("{date}T00:00:00.000Z")).expect("a date")
    }

    #[test]
    fn working_days_are_counted_from_the_start() {
        // 2027-03-03 is a Wednesday.
        let start = at("2027-03-03");
        assert_eq!(add_working_days(start, 0, None), start);
        assert_eq!(add_working_days(start, 4, None), at("2027-03-09"));
        assert_eq!(add_working_days(start, 19, None), at("2027-03-30"));
        // A start on a Saturday rolls to Monday first.
        assert_eq!(
            add_working_days(at("2027-03-06"), 0, None),
            at("2027-03-08")
        );
        assert_eq!(
            add_working_days(at("2027-03-06"), 1, None),
            at("2027-03-09")
        );
        // Counting back.
        assert_eq!(add_working_days(start, -1, None), at("2027-03-02"));
        assert_eq!(add_working_days(start, -3, None), at("2027-02-26"));
        // Another calendar: Monday to Thursday.
        assert_eq!(
            add_working_days(start, 2, Some(&[1, 2, 3, 4])),
            at("2027-03-08")
        );
        // A calendar without a real weekday is Monday to Friday.
        assert_eq!(add_working_days(start, 4, Some(&[9])), at("2027-03-09"));
        assert_eq!(add_working_days(start, 4, Some(&[])), at("2027-03-09"));
    }

    #[test]
    fn working_day_offset_is_the_inverse() {
        let start = at("2027-01-11");
        assert_eq!(working_day_offset(start, at("2027-01-11"), None), 0);
        assert_eq!(working_day_offset(start, at("2027-01-15"), None), 4);
        assert_eq!(working_day_offset(start, at("2027-02-05"), None), 19);
        // A Saturday counts as the Friday before it.
        assert_eq!(working_day_offset(start, at("2027-01-16"), None), 4);
        // Before the start, negative.
        assert_eq!(working_day_offset(start, at("2027-01-08"), None), -1);
        assert_eq!(working_day_offset(start, at("2027-01-09"), None), -1);
        for offset in [-12, -1, 0, 1, 7, 40] {
            let date = add_working_days(start, offset, None);
            assert_eq!(working_day_offset(start, date, None), offset, "{offset}");
        }
    }
}
