//! Blueprint version 1 (`blueprintV1Schema` of
//! `@weldsuite/app-api-client/schemas/project-closing`, FLOW-021): the shape a
//! project template stores, read the way Zod reads it.
//!
//! [`read_blueprint_fields`] is the schema: the fields in the schema's order,
//! each with Zod's issue, `.strict()` objects refusing any other key, and the
//! output Zod would give (trimmed strings, a key left out stays out, `null`
//! stays `null`). [`validate_blueprint`] reads a stored blueprint with it, and
//! the request bodies of the template routes nest it.
//!
//! Also here: [`Obj`], the object reader the closing routes' bodies share, and
//! [`Json`], the accessors the rules read a validated blueprint with.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};

/// The blueprint layout this code writes and reads (FLOW-021: versioned,
/// upgraded when read).
pub const BLUEPRINT_VERSION: i64 = 1;

/// The role keys the code gives meaning to.
pub const PROJECT_MANAGER_ROLE: &str = "project_manager";
pub const SPONSOR_ROLE: &str = "sponsor";

pub const BLUEPRINT_MEMBER_ROLES: [&str; 4] = ["owner", "admin", "member", "viewer"];
pub const TASK_PRIORITIES: [&str; 5] = ["critical", "high", "medium", "low", "none"];
pub const SYSTEM_STATUSES: [&str; 7] = [
    "backlog",
    "todo",
    "in_progress",
    "review",
    "testing",
    "done",
    "cancelled",
];
pub const DEPENDENCY_TYPES: [&str; 4] = ["fs", "ss", "ff", "sf"];
const RAID_KINDS: [&str; 4] = ["risk", "assumption", "issue", "dependency"];
const STRATEGIES: [&str; 4] = ["avoid", "mitigate", "transfer", "accept"];
const CONFIDENCES: [&str; 3] = ["low", "medium", "high"];
const SEVERITIES: [&str; 4] = ["low", "medium", "high", "critical"];
const DIRECTIONS: [&str; 2] = ["inbound", "outbound"];
const PARTY_TYPES: [&str; 4] = ["project", "supplier", "team", "customer"];
const TASK_STATUSES: [&str; 2] = ["backlog", "todo"];
const CADENCES: [&str; 3] = ["weekly", "biweekly", "monthly"];
const RECIPIENT_RULES: [&str; 3] = ["sponsor", "all_stakeholders", "portal_contacts"];

const LOCAL_KEY_MESSAGE: &str = "Use lowercase letters, digits and underscores";
const DATE_MESSAGE: &str = "Use a date as YYYY-MM-DD";

/// `z.number().int().min(min).max(max)`.
const fn whole(min: f64, max: f64) -> Number {
    Number {
        coerce: false,
        int: true,
        min: Some(min),
        max: Some(max),
    }
}

/// `offset`: `z.number().int().min(-3_650).max(36_500)`.
const OFFSET: Number = whole(-3_650.0, 36_500.0);
/// `rating`: `z.number().int().min(1).max(5)`.
const RATING: Number = whole(1.0, 5.0);

/// `localKey`: lowercase letters, digits and underscores.
fn is_local_key(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// `/^d{4}-d{2}-d{2}$/`.
fn is_date_shape(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

/// A date of the Gregorian calendar (`new Date(…).toISOString()` gives it back).
fn is_real_date(text: &str) -> bool {
    let (Some(year), Some(month), Some(day)) = (
        text.get(0..4).and_then(|y| y.parse::<i64>().ok()),
        text.get(5..7).and_then(|m| m.parse::<i64>().ok()),
        text.get(8..10).and_then(|d| d.parse::<i64>().ok()),
    ) else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => 28 + i64::from(leap),
        _ => return false,
    };
    (1..=days).contains(&day)
}

// ── Reading a JSON object ───────────────────────────────────────────────────

/// A JSON value as the rules read a validated blueprint (or a row): a
/// missing or `null` field is `None`, a wrong type is `None` too.
pub trait Json {
    /// The string at `key`.
    fn text(&self, key: &str) -> Option<&str>;
    /// The whole number at `key`.
    fn int(&self, key: &str) -> Option<i64>;
    /// The boolean at `key`, `false` when it is not one.
    fn flag(&self, key: &str) -> bool;
    /// The array at `key`, empty when it is not one.
    fn items(&self, key: &str) -> &[Value];
    /// The value at `key`, `null` when absent.
    fn at(&self, key: &str) -> &Value;
}

static NULL: Value = Value::Null;

impl Json for Value {
    fn text(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }

    fn int(&self, key: &str) -> Option<i64> {
        self.get(key).and_then(|value| {
            value.as_i64().or_else(|| {
                value
                    .as_f64()
                    .filter(|n| n.fract() == 0.0)
                    .map(float_to_int)
            })
        })
    }

    fn flag(&self, key: &str) -> bool {
        self.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    fn items(&self, key: &str) -> &[Value] {
        self.get(key)
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice)
    }

    fn at(&self, key: &str) -> &Value {
        self.get(key).unwrap_or(&NULL)
    }
}

/// A float that is a whole number, as an integer (JSON `3.0`).
#[allow(clippy::cast_possible_truncation)]
fn float_to_int(number: f64) -> i64 {
    number as i64
}

/// Reads one object into its Zod output, remembering the keys its schema
/// knows for `.strict()`.
pub struct Obj<'a> {
    issues: &'a mut Issues,
    fields: &'a Map<String, Value>,
    known: Vec<&'static str>,
    out: Map<String, Value>,
}

impl<'a> Obj<'a> {
    /// A reader over `fields`, which sit at the issues' current path.
    pub fn new(issues: &'a mut Issues, fields: &'a Map<String, Value>) -> Self {
        Self {
            issues,
            fields,
            known: Vec::new(),
            out: Map::new(),
        }
    }

    /// The issues, for a check the readers here have no rule for.
    pub fn issues(&mut self) -> &mut Issues {
        self.issues
    }

    /// Keep a read field, as Zod's object does (absent stays out).
    fn keep<T: Into<Value>>(&mut self, key: &'static str, field: Field<T>) {
        self.known.push(key);
        match field {
            Field::Set(value) => {
                self.out.insert(key.to_owned(), value.into());
            }
            Field::Null => {
                self.out.insert(key.to_owned(), Value::Null);
            }
            Field::Absent => {}
        }
    }

    /// `z.string()` with `rules`.
    pub fn text(&mut self, key: &'static str, presence: Presence, rules: Text) -> &mut Self {
        let field = self.issues.text_with(self.fields, key, presence, rules);
        self.keep(key, field);
        self
    }

    /// `localKey` (`z.string().min(1).max(40).regex(...)`).
    pub fn local_key(&mut self, key: &'static str, presence: Presence) -> &mut Self {
        let field = self.issues.pattern(
            self.fields,
            key,
            presence,
            Some(1),
            Some(40),
            is_local_key,
            LOCAL_KEY_MESSAGE,
        );
        self.keep(key, field);
        self
    }

    /// `z.enum([...])`.
    pub fn choice(&mut self, key: &'static str, presence: Presence, options: &[&str]) -> &mut Self {
        let field = self.issues.choice(self.fields, key, presence, options);
        self.keep(key, field);
        self
    }

    /// `z.number().int()` with `rules`; a whole number is written as an integer.
    pub fn whole(&mut self, key: &'static str, presence: Presence, rules: Number) -> &mut Self {
        let field = self.issues.whole_number(self.fields, key, presence, rules);
        self.keep(key, field);
        self
    }

    /// `z.number()` with `rules`, written as `JSON.stringify` writes it.
    pub fn number(&mut self, key: &'static str, presence: Presence, rules: Number) -> &mut Self {
        let field = self.issues.number(self.fields, key, presence, rules);
        let field = match field {
            Field::Set(number) => Field::Set(crate::js::number_value(number)),
            Field::Null => Field::Null,
            Field::Absent => Field::Absent,
        };
        self.keep(key, field);
        self
    }

    /// `calendarDate`: `YYYY-MM-DD`, a real calendar date.
    pub fn calendar_date(&mut self, key: &'static str) -> &mut Self {
        let field = self.issues.pattern(
            self.fields,
            key,
            Presence::Required,
            None,
            None,
            is_date_shape,
            DATE_MESSAGE,
        );
        if let Field::Set(text) = &field
            && !is_real_date(text)
        {
            self.issues.custom(key, DATE_MESSAGE);
        }
        self.keep(key, field);
        self
    }

    /// `z.boolean()`.
    pub fn boolean(&mut self, key: &'static str, presence: Presence) -> &mut Self {
        let field = self.issues.boolean(self.fields, key, presence);
        self.keep(key, field);
        self
    }

    /// `z.object({...})` at `key`: `read` gets its fields with the key on the path.
    pub fn nested(
        &mut self,
        key: &'static str,
        presence: Presence,
        read: fn(&mut Issues, &Map<String, Value>) -> Value,
    ) -> &mut Self {
        let field = self.issues.nested(self.fields, key, presence, read);
        self.keep(key, field);
        self
    }

    /// `z.record(...)` at `key`: every entry is read by `read` (given the
    /// record and the entry's key), and the output holds the entries it kept.
    pub fn record(
        &mut self,
        key: &'static str,
        presence: Presence,
        read: fn(&mut Issues, &Map<String, Value>, &str) -> Field<String>,
    ) -> &mut Self {
        let field = self
            .issues
            .nested(self.fields, key, presence, |issues, map| {
                let mut out = Map::new();
                for entry in map.keys() {
                    if let Field::Set(text) = read(issues, map, entry) {
                        out.insert(entry.clone(), Value::String(text));
                    }
                }
                Value::Object(out)
            });
        self.keep(key, field);
        self
    }

    /// `z.array(item).max(max)`: every item is read by `read`.
    pub fn list(
        &mut self,
        key: &'static str,
        presence: Presence,
        max: Option<usize>,
        read: fn(&mut Issues, &Value) -> Option<Value>,
    ) -> &mut Self {
        let field = self
            .issues
            .list(self.fields, key, presence, None, max, |issues, item| {
                read(issues, item)
            });
        self.keep(key, field.map_set(Value::Array));
        self
    }

    /// `z.array(z.string()...).max(max)`.
    pub fn strings(
        &mut self,
        key: &'static str,
        presence: Presence,
        max: usize,
        rules: Text,
    ) -> &mut Self {
        let field = self.issues.list(
            self.fields,
            key,
            presence,
            None,
            Some(max),
            |issues, item| issues.item_text(item, rules),
        );
        self.keep(
            key,
            field.map_set(|items| Value::Array(items.into_iter().map(Value::String).collect())),
        );
        self
    }

    /// `z.array(localKey).max(max)`.
    pub fn local_keys(&mut self, key: &'static str, max: usize) -> &mut Self {
        let field = self.issues.list(
            self.fields,
            key,
            Presence::Required,
            None,
            Some(max),
            |issues, item| {
                issues.item_pattern(
                    item,
                    Text::length(Some(1), Some(40)),
                    is_local_key,
                    LOCAL_KEY_MESSAGE,
                )
            },
        );
        self.keep(
            key,
            field.map_set(|items| Value::Array(items.into_iter().map(Value::String).collect())),
        );
        self
    }

    /// The output, after `.strict()`'s one `unrecognized_keys` issue at the
    /// object's own path for the keys no field read.
    pub fn finish(self) -> Value {
        let extra: Vec<&String> = self
            .fields
            .keys()
            .filter(|key| !self.known.contains(&key.as_str()))
            .collect();
        if !extra.is_empty() {
            let listed = extra
                .iter()
                .map(|key| format!("'{key}'"))
                .collect::<Vec<_>>()
                .join(", ");
            self.issues.issue_here(json!({
                "code": "unrecognized_keys",
                "keys": extra,
                "message": format!("Unrecognized key(s) in object: {listed}"),
            }));
        }
        Value::Object(self.out)
    }

    /// The output without the strictness check (a passthrough object).
    pub fn into_output(self) -> Map<String, Value> {
        self.out
    }
}

/// `Field::map`, for the kinds of fields read here.
trait MapSet<T> {
    fn map_set<U>(self, change: impl FnOnce(T) -> U) -> Field<U>;
}

impl<T> MapSet<T> for Field<T> {
    fn map_set<U>(self, change: impl FnOnce(T) -> U) -> Field<U> {
        match self {
            Self::Set(value) => Field::Set(change(value)),
            Self::Null => Field::Null,
            Self::Absent => Field::Absent,
        }
    }
}

// ── The blueprint ───────────────────────────────────────────────────────────

fn read_role(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let mut o = Obj::new(issues, fields);
    o.local_key("key", Presence::Required)
        .text(
            "label",
            Presence::Required,
            Text::trimmed(Some(1), Some(100)),
        )
        .choice("projectRole", Presence::Nullable, &BLUEPRINT_MEMBER_ROLES);
    Some(o.finish())
}

fn read_project(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    let mut o = Obj::new(issues, fields);
    let short = Text::length(None, Some(50));
    o.text("type", Presence::Nullable, short)
        .text("methodology", Presence::Nullable, short)
        .text("priority", Presence::Nullable, short)
        .text("visibility", Presence::Nullable, short)
        .text("color", Presence::Nullable, short)
        .text("icon", Presence::Nullable, Text::length(None, Some(255)))
        .text(
            "budgetCurrency",
            Presence::Nullable,
            Text::length(None, Some(10)),
        )
        .text("billingMethod", Presence::Nullable, short)
        .boolean("isBillable", Presence::Required)
        .boolean("trackTime", Presence::Required);
    o.finish()
}

fn read_stage(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let mut o = Obj::new(issues, fields);
    o.local_key("key", Presence::Required)
        .text(
            "name",
            Presence::Required,
            Text::trimmed(Some(1), Some(255)),
        )
        .text("color", Presence::Nullable, Text::length(None, Some(50)))
        .choice("systemStatus", Presence::Required, &SYSTEM_STATUSES);
    Some(o.finish())
}

/// One gate criterion: a catalogue key with its parameters, or a manual
/// criterion (text).
fn read_gate_criterion(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let mut o = Obj::new(issues, fields);
    if fields.contains_key("manual") {
        o.text(
            "manual",
            Presence::Required,
            Text::trimmed(Some(1), Some(1_000)),
        );
    } else if fields.contains_key("key") {
        o.text("key", Presence::Required, Text::length(Some(1), Some(100)))
            .nested("params", Presence::Optional, |_, map| {
                Value::Object(map.clone())
            });
    } else {
        // Neither variant of the union fits.
        o.issues().issue_here(json!({
            "code": "invalid_union",
            "unionErrors": [],
            "message": "Invalid input",
        }));
        return None;
    }
    Some(o.finish())
}

fn read_phase(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let mut o = Obj::new(issues, fields);
    o.local_key("key", Presence::Required)
        .text(
            "name",
            Presence::Required,
            Text::trimmed(Some(1), Some(255)),
        )
        .whole("startOffset", Presence::Nullish, OFFSET)
        .whole("endOffset", Presence::Nullish, OFFSET)
        .list(
            "gateCriteria",
            Presence::Required,
            Some(50),
            read_gate_criterion,
        );
    Some(o.finish())
}

fn read_milestone(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let mut o = Obj::new(issues, fields);
    o.local_key("key", Presence::Required)
        .text(
            "name",
            Presence::Required,
            Text::trimmed(Some(1), Some(255)),
        )
        .text(
            "description",
            Presence::Nullable,
            Text::length(None, Some(10_000)),
        )
        .whole("offset", Presence::Required, OFFSET)
        .boolean("isKey", Presence::Required)
        .local_key("ownerRole", Presence::Nullish);
    Some(o.finish())
}

fn read_deliverable(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let mut o = Obj::new(issues, fields);
    o.local_key("key", Presence::Required)
        .text(
            "title",
            Presence::Required,
            Text::trimmed(Some(1), Some(255)),
        )
        .text(
            "description",
            Presence::Nullable,
            Text::length(None, Some(10_000)),
        )
        .local_key("ownerRole", Presence::Nullish)
        .whole("startOffset", Presence::Nullish, OFFSET)
        .whole("endOffset", Presence::Nullish, OFFSET)
        .strings(
            "acceptanceCriteria",
            Presence::Required,
            50,
            Text::trimmed(Some(1), Some(1_000)),
        )
        .boolean("clientVisible", Presence::Required);
    Some(o.finish())
}

fn read_task(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let mut o = Obj::new(issues, fields);
    o.local_key("key", Presence::Required)
        .local_key("parentKey", Presence::Nullish)
        .text(
            "title",
            Presence::Required,
            Text::trimmed(Some(1), Some(500)),
        )
        .text(
            "description",
            Presence::Nullable,
            Text::length(None, Some(20_000)),
        )
        .choice("priority", Presence::Required, &TASK_PRIORITIES)
        .text("type", Presence::Required, Text::trimmed(Some(1), Some(50)))
        .choice("status", Presence::Required, &TASK_STATUSES)
        .local_keys("assigneeRoles", 20)
        .whole("startOffset", Presence::Nullish, OFFSET)
        .whole("dueOffset", Presence::Nullish, OFFSET)
        .text(
            "estimatedHours",
            Presence::Nullable,
            Text::length(None, Some(20)),
        )
        .whole("storyPoints", Presence::Nullable, whole(0.0, 1_000.0))
        .local_key("milestoneKey", Presence::Nullish)
        .local_key("deliverableKey", Presence::Nullish)
        .strings(
            "labels",
            Presence::Nullable,
            50,
            Text::length(None, Some(100)),
        )
        .strings(
            "tags",
            Presence::Nullable,
            50,
            Text::length(None, Some(100)),
        )
        .boolean("isBillable", Presence::Required);
    Some(o.finish())
}

fn read_dependency(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let mut o = Obj::new(issues, fields);
    o.local_key("predecessor", Presence::Required)
        .local_key("successor", Presence::Required)
        .choice("type", Presence::Required, &DEPENDENCY_TYPES)
        .whole("lagDays", Presence::Required, whole(-3_650.0, 3_650.0));
    Some(o.finish())
}

/// The columns each kind of register item owns; the others of the item stay null.
fn raid_fields_of(kind: &str) -> &'static [&'static str] {
    match kind {
        "risk" => &[
            "probability",
            "impact",
            "strategy",
            "trigger",
            "costImpact",
            "scheduleImpactDays",
            "reviewIntervalDays",
        ],
        "assumption" => &["confidence", "ifWrong"],
        "issue" => &["severity"],
        _ => &["direction", "partyType", "partyName"],
    }
}

/// `blueprintRaidItemSchema`'s `superRefine`: a risk is rated, and the fields
/// of another kind stay empty (the table's check constraints).
fn refine_raid_item(issues: &mut Issues, item: &Value) {
    let kind = item.text("kind").unwrap_or_default();
    if kind == "risk" && (item.at("probability").is_null() || item.at("impact").is_null()) {
        issues.custom_at(
            &[json!("probability")],
            "A risk needs a probability and an impact",
        );
    }
    for other in RAID_KINDS {
        if other == kind {
            continue;
        }
        for field in raid_fields_of(other) {
            if !item.at(field).is_null() {
                issues.custom_at(
                    &[json!(field)],
                    &format!("{field} does not apply to a {kind}"),
                );
            }
        }
    }
}

fn read_raid_item(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let before = issues.count();
    let mut o = Obj::new(issues, fields);
    let text = |max| Text::length(None, Some(max));
    o.choice("kind", Presence::Required, &RAID_KINDS)
        .text(
            "title",
            Presence::Required,
            Text::trimmed(Some(1), Some(255)),
        )
        .text("description", Presence::Nullable, text(10_000))
        .text("category", Presence::Nullable, text(100))
        .local_key("ownerRole", Presence::Nullish)
        .whole("probability", Presence::Nullable, RATING)
        .whole("impact", Presence::Nullable, RATING)
        .choice("strategy", Presence::Nullable, &STRATEGIES)
        .text("trigger", Presence::Nullable, text(2_000))
        .text("costImpact", Presence::Nullable, text(30))
        .whole(
            "scheduleImpactDays",
            Presence::Nullable,
            whole(0.0, 3_650.0),
        )
        .whole("reviewIntervalDays", Presence::Nullable, whole(1.0, 365.0))
        .choice("confidence", Presence::Nullable, &CONFIDENCES)
        .text("ifWrong", Presence::Nullable, text(10_000))
        .choice("severity", Presence::Nullable, &SEVERITIES)
        .choice("direction", Presence::Nullable, &DIRECTIONS)
        .choice("partyType", Presence::Nullable, &PARTY_TYPES)
        .text("partyName", Presence::Nullable, text(255));
    let output = o.finish();
    if issues.count() == before {
        refine_raid_item(issues, &output);
    }
    Some(output)
}

fn read_schedule(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    let mut o = Obj::new(issues, fields);
    let days = o.issues().list(
        fields,
        "workingDays",
        Presence::Required,
        Some(1),
        Some(7),
        |issues, item| {
            issues
                .item_number(item, whole(1.0, 7.0))
                .map(crate::js::number_value)
        },
    );
    o.keep("workingDays", days.map_set(Value::Array));
    o.boolean("autoSchedule", Presence::Required);
    o.finish()
}

fn read_change_control(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    let mut o = Obj::new(issues, fields);
    let at_least_zero = Number {
        min: Some(0.0),
        ..Number::default()
    };
    o.number("costLimit", Presence::Required, at_least_zero)
        .number("scheduleLimitDays", Presence::Required, at_least_zero)
        .local_keys("boardRoles", 50);
    o.finish()
}

fn read_status_report(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    let mut o = Obj::new(issues, fields);
    o.choice("cadence", Presence::Required, &CADENCES)
        .whole("weekday", Presence::Required, whole(1.0, 7.0))
        .whole("hour", Presence::Required, whole(0.0, 23.0))
        .choice("recipientsRule", Presence::Required, &RECIPIENT_RULES);
    o.finish()
}

fn read_plan_entry(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let mut o = Obj::new(issues, fields);
    o.text("what", Presence::Required, Text::length(None, Some(500)))
        .text(
            "audience",
            Presence::Required,
            Text::length(None, Some(500)),
        )
        .text("cadence", Presence::Required, Text::length(None, Some(200)))
        .text("channel", Presence::Required, Text::length(None, Some(200)));
    Some(o.finish())
}

fn read_settings(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    let mut o = Obj::new(issues, fields);
    o.nested("schedule", Presence::Optional, read_schedule)
        .nested("changeControl", Presence::Optional, read_change_control)
        .nested("statusReport", Presence::Optional, read_status_report)
        .list(
            "communicationPlan",
            Presence::Optional,
            Some(100),
            read_plan_entry,
        )
        .whole("riskAppetite", Presence::Optional, whole(1.0, 25.0));
    o.finish()
}

/// `z.literal(1)` at `version`.
fn read_version(issues: &mut Issues, fields: &Map<String, Value>) {
    let given = fields.get("version");
    if given.and_then(Value::as_f64) == Some(1.0) {
        return;
    }
    let mut issue = json!({
        "code": "invalid_literal",
        "expected": 1,
        "message": "Invalid literal value, expected 1",
    });
    if let Some(given) = given {
        issue["received"] = given.clone();
    }
    issues.push_issue("version", issue);
}

/// `blueprintV1Schema`: the fields of the blueprint object at the issues'
/// current path.
pub fn read_blueprint_fields(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    read_version(issues, fields);
    let mut o = Obj::new(issues, fields);
    // `version` is read above: it is a known key, and a good blueprint keeps it.
    o.known.push("version");
    o.out.insert("version".to_owned(), json!(BLUEPRINT_VERSION));
    o.whole("durationDays", Presence::Required, whole(0.0, 36_500.0))
        .list("roles", Presence::Required, Some(100), read_role)
        .nested("project", Presence::Required, read_project)
        .list("stages", Presence::Required, Some(50), read_stage)
        .list("phases", Presence::Required, Some(100), read_phase)
        .list("milestones", Presence::Required, Some(500), read_milestone)
        .list(
            "deliverables",
            Presence::Required,
            Some(500),
            read_deliverable,
        )
        .list("tasks", Presence::Required, Some(5_000), read_task)
        .list(
            "dependencies",
            Presence::Required,
            Some(20_000),
            read_dependency,
        )
        .list("raid", Presence::Required, Some(500), read_raid_item)
        .nested("settings", Presence::Required, read_settings);
    o.finish()
}

/// A stored blueprint against the schema: the output Zod would give, or
/// `None` when it does not pass.
pub fn validate_blueprint(stored: &Value) -> Option<Value> {
    let mut issues = Issues::default();
    let output = issues
        .object(stored)
        .map(|fields| read_blueprint_fields(&mut issues, fields));
    issues.finish().ok()?;
    output
}

// ── Integrity ───────────────────────────────────────────────────────────────

fn duplicate_key<'a>(items: &'a [Value], key: &str) -> Option<&'a str> {
    let mut seen = HashSet::new();
    items
        .iter()
        .filter_map(|item| item.text(key))
        .find(|value| !seen.insert(*value))
}

fn key_set<'a>(items: &'a [Value], key: &str) -> HashSet<&'a str> {
    items.iter().filter_map(|item| item.text(key)).collect()
}

/// A role that is named but not in the blueprint.
fn unknown_role<'a>(roles: &HashSet<&str>, role: Option<&'a str>) -> Option<&'a str> {
    role.filter(|role| !role.is_empty() && !roles.contains(role))
}

/// The first reference of a milestone, deliverable or register item to a role the blueprint lacks.
fn role_reference_error(blueprint: &Value, roles: &HashSet<&str>) -> Option<String> {
    for milestone in blueprint.items("milestones") {
        if let Some(bad) = unknown_role(roles, milestone.text("ownerRole")) {
            return Some(format!(
                "Milestone {} refers to an unknown role: {bad}",
                milestone.text("key").unwrap_or_default()
            ));
        }
    }
    for deliverable in blueprint.items("deliverables") {
        if let Some(bad) = unknown_role(roles, deliverable.text("ownerRole")) {
            return Some(format!(
                "Deliverable {} refers to an unknown role: {bad}",
                deliverable.text("key").unwrap_or_default()
            ));
        }
    }
    for item in blueprint.items("raid") {
        if let Some(bad) = unknown_role(roles, item.text("ownerRole")) {
            return Some(format!("A register item refers to an unknown role: {bad}"));
        }
    }
    let board = blueprint
        .at("settings")
        .at("changeControl")
        .items("boardRoles");
    board
        .iter()
        .filter_map(Value::as_str)
        .find(|role| !roles.contains(role))
        .map(|role| format!("The change board refers to an unknown role: {role}"))
}

/// The first reference of a task to a parent, milestone, deliverable or role the blueprint lacks.
fn task_reference_error(blueprint: &Value, roles: &HashSet<&str>) -> Option<String> {
    let milestones = key_set(blueprint.items("milestones"), "key");
    let deliverables = key_set(blueprint.items("deliverables"), "key");
    let tasks = key_set(blueprint.items("tasks"), "key");
    for task in blueprint.items("tasks") {
        let key = task.text("key").unwrap_or_default();
        let unresolved = |reference: Option<&str>, known: &HashSet<&str>| {
            reference
                .filter(|reference| !reference.is_empty() && !known.contains(reference))
                .map(str::to_owned)
        };
        if let Some(parent) = unresolved(task.text("parentKey"), &tasks) {
            return Some(format!("Task {key} refers to an unknown parent: {parent}"));
        }
        if let Some(milestone) = unresolved(task.text("milestoneKey"), &milestones) {
            return Some(format!(
                "Task {key} refers to an unknown milestone: {milestone}"
            ));
        }
        if let Some(deliverable) = unresolved(task.text("deliverableKey"), &deliverables) {
            return Some(format!(
                "Task {key} refers to an unknown deliverable: {deliverable}"
            ));
        }
        for role in task.items("assigneeRoles").iter().filter_map(Value::as_str) {
            if !roles.contains(role) {
                return Some(format!("Task {key} refers to an unknown role: {role}"));
            }
        }
    }
    None
}

/// A task that is its own ancestor.
fn ancestor_error(blueprint: &Value) -> Option<String> {
    let parent_of: HashMap<&str, Option<&str>> = blueprint
        .items("tasks")
        .iter()
        .filter_map(|task| Some((task.text("key")?, task.text("parentKey"))))
        .collect();
    for task in blueprint.items("tasks") {
        let key = task.text("key").unwrap_or_default();
        let mut seen = HashSet::from([key]);
        let mut current = parent_of.get(key).copied().flatten();
        while let Some(ancestor) = current.filter(|ancestor| !ancestor.is_empty()) {
            if !seen.insert(ancestor) {
                return Some(format!("Task {key} is its own ancestor"));
            }
            current = parent_of.get(ancestor).copied().flatten();
        }
    }
    None
}

/// The first refusal in the dependencies: an unknown task, itself, a repeat, or a circle.
fn dependency_error(blueprint: &Value) -> Option<String> {
    let tasks = key_set(blueprint.items("tasks"), "key");
    let mut pairs = HashSet::new();
    let mut successors: HashMap<&str, Vec<&str>> = HashMap::new();
    for dependency in blueprint.items("dependencies") {
        let predecessor = dependency.text("predecessor").unwrap_or_default();
        let successor = dependency.text("successor").unwrap_or_default();
        if !tasks.contains(predecessor) || !tasks.contains(successor) {
            let unknown = if tasks.contains(predecessor) {
                successor
            } else {
                predecessor
            };
            return Some(format!("A dependency refers to an unknown task: {unknown}"));
        }
        if predecessor == successor {
            return Some(format!("Task {predecessor} cannot depend on itself"));
        }
        if !pairs.insert((predecessor, successor)) {
            return Some(format!(
                "Duplicate dependency: {predecessor} to {successor}"
            ));
        }
        successors.entry(predecessor).or_default().push(successor);
    }
    // Depth first, iteratively (0 new, 1 on the path, 2 done): the first task
    // met again on the path is the one named.
    let mut state: HashMap<&str, u8> = HashMap::new();
    for task in blueprint.items("tasks") {
        let start = task.text("key").unwrap_or_default();
        if state.contains_key(start) {
            continue;
        }
        state.insert(start, 1);
        let mut stack: Vec<(&str, usize)> = vec![(start, 0)];
        while let Some(&(node, index)) = stack.last() {
            let next = successors
                .get(node)
                .and_then(|list| list.get(index))
                .copied();
            let Some(next) = next else {
                state.insert(node, 2);
                stack.pop();
                continue;
            };
            if let Some(top) = stack.last_mut() {
                top.1 += 1;
            }
            match state.get(next) {
                Some(1) => {
                    return Some(format!("The dependencies of task {next} run in a circle"));
                }
                None => {
                    state.insert(next, 1);
                    stack.push((next, 0));
                }
                Some(_) => {}
            }
        }
    }
    None
}

/// The rules a blueprint keeps beyond its shape (`blueprintIntegrityError`):
/// keys are unique within their list, every reference (parent, milestone,
/// deliverable, role, dependency end) names something the blueprint has, a
/// task is not its own ancestor and the dependencies do not run in a circle.
/// Returns the 400 message, or `None`.
pub fn blueprint_integrity_error(blueprint: &Value) -> Option<String> {
    for (label, list) in [
        ("role", "roles"),
        ("stage", "stages"),
        ("phase", "phases"),
        ("milestone", "milestones"),
        ("deliverable", "deliverables"),
        ("task", "tasks"),
    ] {
        if let Some(repeated) = duplicate_key(blueprint.items(list), "key") {
            return Some(format!("Duplicate {label} key: {repeated}"));
        }
    }
    let roles = key_set(blueprint.items("roles"), "key");
    role_reference_error(blueprint, &roles)
        .or_else(|| task_reference_error(blueprint, &roles))
        .or_else(|| ancestor_error(blueprint))
        .or_else(|| dependency_error(blueprint))
}

// ── Summary ─────────────────────────────────────────────────────────────────

/// What the gallery shows of a blueprint (`summarizeBlueprint`).
pub fn summarize_blueprint(blueprint: &Value) -> Value {
    let count = |key: &str| blueprint.items(key).len();
    json!({
        "durationDays": blueprint.at("durationDays"),
        "tasks": count("tasks"),
        "milestones": count("milestones"),
        "phases": count("phases"),
        "deliverables": count("deliverables"),
        "raidItems": count("raid"),
        "stages": count("stages"),
        "roles": count("roles"),
    })
}

/// What the gallery shows of a stored blueprint, without validating it
/// (`summarizeStoredBlueprint`): a template that no longer passes the schema
/// still lists (and can be deleted).
pub fn summarize_stored_blueprint(stored: &Value) -> Value {
    let count = |key: &str| {
        stored
            .get(key)
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
    };
    let duration = match stored.get("durationDays") {
        Some(number @ Value::Number(_)) => number.clone(),
        _ => json!(0),
    };
    json!({
        "durationDays": duration,
        "tasks": count("tasks"),
        "milestones": count("milestones"),
        "phases": count("phases"),
        "deliverables": count("deliverables"),
        "raidItems": count("raid"),
        "stages": count("stages"),
        "roles": count("roles"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal() -> Value {
        json!({
            "version": 1,
            "durationDays": 10,
            "roles": [{ "key": "project_manager", "label": "Project manager", "projectRole": "owner" }],
            "project": { "type": null, "methodology": null, "priority": null, "visibility": null,
                "color": null, "icon": null, "budgetCurrency": null, "billingMethod": null,
                "isBillable": true, "trackTime": true },
            "stages": [],
            "phases": [],
            "milestones": [],
            "deliverables": [],
            "tasks": [{ "key": "t1", "parentKey": null, "title": "Kick-off", "description": null,
                "priority": "medium", "type": "task", "status": "todo",
                "assigneeRoles": ["project_manager"], "startOffset": 0, "dueOffset": 1,
                "estimatedHours": null, "storyPoints": null, "milestoneKey": null,
                "deliverableKey": null, "labels": null, "tags": null, "isBillable": true }],
            "dependencies": [],
            "raid": [],
            "settings": {},
        })
    }

    fn risk() -> Value {
        json!({ "kind": "risk", "title": "R", "description": null, "category": null,
            "ownerRole": null, "probability": 3, "impact": 4, "strategy": "mitigate",
            "trigger": null, "costImpact": null, "scheduleImpactDays": null,
            "reviewIntervalDays": 14, "confidence": null, "ifWrong": null, "severity": null,
            "direction": null, "partyType": null, "partyName": null })
    }

    fn change(mutate: impl FnOnce(&mut Value)) -> Value {
        let mut blueprint = minimal();
        mutate(&mut blueprint);
        blueprint
    }

    #[test]
    fn a_good_blueprint_comes_out_as_it_went_in() {
        assert_eq!(validate_blueprint(&minimal()), Some(minimal()));
        // Strings are trimmed, a key left out stays out, a null stays null.
        let output = validate_blueprint(&change(|b| {
            b["tasks"][0]["title"] = json!("  Kick-off  ");
            if let Some(task) = b["tasks"][0].as_object_mut() {
                task.remove("startOffset");
            }
            b["raid"] = json!([risk()]);
        }))
        .expect("valid");
        assert_eq!(output["tasks"][0]["title"], "Kick-off");
        assert!(output["tasks"][0].get("startOffset").is_none());
        assert_eq!(output["tasks"][0]["parentKey"], Value::Null);
        assert_eq!(output["raid"][0]["ownerRole"], Value::Null);
    }

    #[allow(clippy::too_many_lines)] // one case per refusal
    #[test]
    fn what_the_schema_refuses_is_refused() {
        let broken: Vec<(&str, Value)> = vec![
            ("an unknown version", change(|b| b["version"] = json!(2))),
            (
                "a missing version",
                change(|b| drop(b.as_object_mut().map(|o| o.remove("version")))),
            ),
            ("an unknown field", change(|b| b["extra"] = json!(true))),
            (
                "a missing section",
                change(|b| drop(b.as_object_mut().map(|o| o.remove("tasks")))),
            ),
            (
                "a bad key",
                change(|b| b["tasks"][0]["key"] = json!("Task 1")),
            ),
            (
                "a bad priority",
                change(|b| b["tasks"][0]["priority"] = json!("urgent")),
            ),
            (
                "a task status of done",
                change(|b| b["tasks"][0]["status"] = json!("done")),
            ),
            (
                "an offset out of range",
                change(|b| b["tasks"][0]["dueOffset"] = json!(40_000)),
            ),
            (
                "a fractional offset",
                change(|b| b["tasks"][0]["dueOffset"] = json!(1.5)),
            ),
            (
                "a long title",
                change(|b| b["tasks"][0]["title"] = json!("x".repeat(501))),
            ),
            (
                "an extra task field",
                change(|b| b["tasks"][0]["extra"] = json!(1)),
            ),
            (
                "a text duration",
                change(|b| b["durationDays"] = json!("10")),
            ),
            (
                "a negative duration",
                change(|b| b["durationDays"] = json!(-1)),
            ),
            (
                "a role without a label",
                change(|b| b["roles"][0]["label"] = json!("  ")),
            ),
            (
                "an unknown project role",
                change(|b| b["roles"][0]["projectRole"] = json!("boss")),
            ),
            (
                "too many stages",
                change(|b| {
                    b["stages"] = json!(vec![
                        json!({ "key": "s", "name": "n", "color": null, "systemStatus": "todo" });
                        51
                    ]);
                }),
            ),
            (
                "a risk without ratings",
                change(|b| {
                    let mut item = risk();
                    item["probability"] = Value::Null;
                    item["impact"] = Value::Null;
                    b["raid"] = json!([item]);
                }),
            ),
            (
                "a field of another kind",
                change(|b| {
                    let mut item = risk();
                    item["severity"] = json!("high");
                    b["raid"] = json!([item]);
                }),
            ),
            (
                "a bad rating",
                change(|b| {
                    let mut item = risk();
                    item["probability"] = json!(6);
                    b["raid"] = json!([item]);
                }),
            ),
            (
                "a bad schedule",
                change(|b| {
                    b["settings"] =
                        json!({ "schedule": { "workingDays": [], "autoSchedule": true } });
                }),
            ),
            (
                "a bad working day",
                change(|b| {
                    b["settings"] =
                        json!({ "schedule": { "workingDays": [8], "autoSchedule": true } });
                }),
            ),
            (
                "an unknown settings key",
                change(|b| b["settings"] = json!({ "budget": 1 })),
            ),
            (
                "a bad cadence",
                change(
                    |b| b["settings"] = json!({ "statusReport": { "cadence": "daily", "weekday": 5, "hour": 15, "recipientsRule": "sponsor" } }),
                ),
            ),
            (
                "a bad risk appetite",
                change(|b| b["settings"] = json!({ "riskAppetite": 26 })),
            ),
            (
                "a gate criterion that is neither",
                change(
                    |b| b["phases"] = json!([{ "key": "p1", "name": "Build", "startOffset": null, "endOffset": null, "gateCriteria": [{ "other": 1 }] }]),
                ),
            ),
            (
                "a gate criterion that is both",
                change(
                    |b| b["phases"] = json!([{ "key": "p1", "name": "Build", "startOffset": null, "endOffset": null, "gateCriteria": [{ "key": "x", "manual": "y" }] }]),
                ),
            ),
            ("not an object", json!("blueprint")),
        ];
        for (label, blueprint) in broken {
            assert_eq!(validate_blueprint(&blueprint), None, "{label}");
        }
    }

    #[test]
    fn a_blueprint_with_every_section_passes() {
        let blueprint = change(|b| {
            b["stages"] = json!([{ "key": "s1", "name": "Backlog", "color": "#94a3b8", "systemStatus": "backlog" }]);
            b["phases"] = json!([{ "key": "p1", "name": "Build", "startOffset": 0, "endOffset": 9,
                "gateCriteria": [{ "key": "deliverables_accepted", "params": { "min": 2 } }, { "manual": " Design signed " }] }]);
            b["milestones"] = json!([{ "key": "m1", "name": "Signed off", "description": null, "offset": 4, "isKey": true, "ownerRole": "project_manager" }]);
            b["deliverables"] = json!([{ "key": "d1", "title": "Ordering", "description": "Place orders", "ownerRole": null,
                "startOffset": 1, "endOffset": 8, "acceptanceCriteria": [" Checkout works "], "clientVisible": true }]);
            b["tasks"] = json!([
                { "key": "t1", "parentKey": null, "title": "A", "description": null, "priority": "high", "type": "task", "status": "todo",
                  "assigneeRoles": [], "startOffset": 0, "dueOffset": 1, "estimatedHours": "16.00", "storyPoints": 3,
                  "milestoneKey": "m1", "deliverableKey": "d1", "labels": ["x"], "tags": [], "isBillable": false },
                { "key": "t2", "parentKey": "t1", "title": "B", "description": null, "priority": "low", "type": "bug", "status": "backlog",
                  "assigneeRoles": ["project_manager"], "startOffset": null, "dueOffset": null, "estimatedHours": null, "storyPoints": null,
                  "milestoneKey": null, "deliverableKey": null, "labels": null, "tags": null, "isBillable": true }
            ]);
            b["dependencies"] =
                json!([{ "predecessor": "t1", "successor": "t2", "type": "ss", "lagDays": -2 }]);
            b["raid"] = json!([risk()]);
            b["settings"] = json!({
                "schedule": { "workingDays": [1, 2, 3, 4, 5], "autoSchedule": true },
                "changeControl": { "costLimit": 8000.5, "scheduleLimitDays": 3, "boardRoles": ["project_manager"] },
                "statusReport": { "cadence": "biweekly", "weekday": 5, "hour": 15, "recipientsRule": "all_stakeholders" },
                "communicationPlan": [{ "what": "Status", "audience": "Sponsor", "cadence": "weekly", "channel": "mail" }],
                "riskAppetite": 12,
            });
        });
        let output = validate_blueprint(&blueprint).expect("valid");
        assert_eq!(
            output["phases"][0]["gateCriteria"][1],
            json!({ "manual": "Design signed" })
        );
        assert_eq!(
            output["deliverables"][0]["acceptanceCriteria"][0],
            "Checkout works"
        );
        assert_eq!(
            output["settings"]["changeControl"]["costLimit"],
            json!(8000.5)
        );
        assert_eq!(
            output["settings"]["schedule"]["workingDays"],
            json!([1, 2, 3, 4, 5])
        );
        assert_eq!(blueprint_integrity_error(&output), None);
    }

    #[test]
    fn issues_name_the_path_and_say_what_is_wrong() {
        let mut issues = Issues::default();
        let blueprint = change(|b| b["tasks"][0]["key"] = json!("Task 1"));
        let fields = blueprint.as_object().expect("object");
        read_blueprint_fields(&mut issues, fields);
        let failed = issues.finish().expect_err("invalid");
        let first = &failed.issues()[0];
        assert_eq!(first["path"], json!(["tasks", 0, "key"]));
        assert_eq!(first["message"], LOCAL_KEY_MESSAGE);

        let mut issues = Issues::default();
        let blueprint = change(|b| b["extra"] = json!(1));
        read_blueprint_fields(&mut issues, blueprint.as_object().expect("object"));
        let failed = issues.finish().expect_err("invalid");
        assert_eq!(
            failed.issues()[0]["message"],
            "Unrecognized key(s) in object: 'extra'"
        );
    }

    fn integrity(mutate: impl FnOnce(&mut Value)) -> Option<String> {
        blueprint_integrity_error(&change(mutate))
    }

    #[test]
    fn integrity_names_the_first_broken_reference() {
        assert_eq!(integrity(|_| {}), None);
        assert_eq!(
            integrity(|b| b["tasks"][0]["assigneeRoles"] = json!(["ghost"])).as_deref(),
            Some("Task t1 refers to an unknown role: ghost")
        );
        assert_eq!(
            integrity(|b| {
                let first = b["tasks"][0].clone();
                b["tasks"] = json!([first.clone(), first]);
            })
            .as_deref(),
            Some("Duplicate task key: t1")
        );
        assert_eq!(
            integrity(|b| b["tasks"][0]["parentKey"] = json!("t9")).as_deref(),
            Some("Task t1 refers to an unknown parent: t9")
        );
        assert_eq!(
            integrity(|b| b["tasks"][0]["milestoneKey"] = json!("m9")).as_deref(),
            Some("Task t1 refers to an unknown milestone: m9")
        );
        assert_eq!(
            integrity(|b| b["tasks"][0]["deliverableKey"] = json!("d9")).as_deref(),
            Some("Task t1 refers to an unknown deliverable: d9")
        );
        assert_eq!(
            integrity(|b| b["roles"] = json!([b["roles"][0].clone(), b["roles"][0].clone()]))
                .as_deref(),
            Some("Duplicate role key: project_manager")
        );
        assert_eq!(
            integrity(|b| b["raid"] = json!([{ "ownerRole": "ghost" }])).as_deref(),
            Some("A register item refers to an unknown role: ghost")
        );
        assert_eq!(
            integrity(|b| b["settings"] = json!({ "changeControl": { "costLimit": 1, "scheduleLimitDays": 1, "boardRoles": ["ghost"] } })).as_deref(),
            Some("The change board refers to an unknown role: ghost")
        );
        assert_eq!(
            integrity(|b| b["milestones"] = json!([{ "key": "m1", "ownerRole": "ghost" }]))
                .as_deref(),
            Some("Milestone m1 refers to an unknown role: ghost")
        );
        assert_eq!(
            integrity(|b| b["deliverables"] = json!([{ "key": "d1", "ownerRole": "ghost" }]))
                .as_deref(),
            Some("Deliverable d1 refers to an unknown role: ghost")
        );
    }

    fn two_tasks(dependencies: Value) -> impl FnOnce(&mut Value) {
        move |b: &mut Value| {
            let mut second = b["tasks"][0].clone();
            second["key"] = json!("t2");
            b["tasks"] = json!([b["tasks"][0].clone(), second]);
            b["dependencies"] = dependencies;
        }
    }

    fn dep(from: &str, to: &str) -> Value {
        json!({ "predecessor": from, "successor": to, "type": "fs", "lagDays": 0 })
    }

    #[test]
    fn integrity_checks_the_dependencies_and_the_ancestry() {
        assert_eq!(
            integrity(two_tasks(json!([dep("t1", "t9")]))).as_deref(),
            Some("A dependency refers to an unknown task: t9")
        );
        assert_eq!(
            integrity(two_tasks(json!([dep("t9", "t1")]))).as_deref(),
            Some("A dependency refers to an unknown task: t9")
        );
        assert_eq!(
            integrity(two_tasks(json!([dep("t1", "t1")]))).as_deref(),
            Some("Task t1 cannot depend on itself")
        );
        assert_eq!(
            integrity(two_tasks(json!([dep("t1", "t2"), dep("t1", "t2")]))).as_deref(),
            Some("Duplicate dependency: t1 to t2")
        );
        assert_eq!(
            integrity(two_tasks(json!([dep("t1", "t2"), dep("t2", "t1")]))).as_deref(),
            Some("The dependencies of task t1 run in a circle")
        );
        assert_eq!(integrity(two_tasks(json!([dep("t1", "t2")]))), None);
        assert_eq!(
            integrity(|b| {
                two_tasks(json!([]))(b);
                b["tasks"][0]["parentKey"] = json!("t2");
                b["tasks"][1]["parentKey"] = json!("t1");
            })
            .as_deref(),
            Some("Task t1 is its own ancestor")
        );
    }

    #[test]
    fn the_summary_counts_what_is_there() {
        assert_eq!(
            summarize_blueprint(&minimal()),
            json!({ "durationDays": 10, "tasks": 1, "milestones": 0, "phases": 0,
                "deliverables": 0, "raidItems": 0, "stages": 0, "roles": 1 })
        );
        // A stored blueprint that no longer passes the schema still has a summary.
        assert_eq!(
            summarize_stored_blueprint(
                &json!({ "version": 7, "tasks": [1, 2, 3], "durationDays": 4 })
            ),
            json!({ "durationDays": 4, "tasks": 3, "milestones": 0, "phases": 0,
                "deliverables": 0, "raidItems": 0, "stages": 0, "roles": 0 })
        );
        assert_eq!(
            summarize_stored_blueprint(&json!("nope"))["durationDays"],
            0
        );
    }
}
