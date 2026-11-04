//! The request schemas of `/api/capacity` and `/api/project-requests`
//! (`@weldsuite/app-api-client/schemas/flow-portfolio`), read the way Zod reads
//! them: the fields in the schema's order, each with Zod's issue, and
//! `.strict()` objects refusing any other key.
//!
//! The routes answer a failure themselves (`parseBody` / `readQuery`):
//! `error.badRequest(c, 'Invalid request body' | 'Invalid query parameters',
//! details)`, the details being Zod's issues as `{ path, message }`.

use axum::body::Bytes;
use serde_json::{Map, Value, json};
use weldsuite_flow_domain::capacity::{PROJECT_REQUEST_STATUSES, RESOURCE_REQUEST_STATUSES};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Field, Invalid, Issues, Number, Presence, Text};

use crate::{Query, Refusal};

/// A body as its schema reads it: the keys present, with Zod's output
/// (trimmed strings, numbers); `null` kept as `null`.
pub(crate) type Body = Map<String, Value>;

const DATE_MESSAGE: &str = "Use a date as YYYY-MM-DD";
const QUERY_BOOLEAN: [&str; 4] = ["true", "false", "1", "0"];
/// `identifier`: `z.string().min(1).max(255)`.
const IDENTIFIER: Text = Text::length(Some(1), Some(255));
/// `skill`: `z.string().trim().min(1).max(100)`.
const SKILL: Text = Text::trimmed(Some(1), Some(100));
/// `z.string().trim().min(1).max(255)`.
const TITLE: Text = Text::trimmed(Some(1), Some(255));

/// `hoursPerWeek`: `z.number().min(0.01).max(168)`.
const HOURS_PER_WEEK: Number = Number {
    coerce: false,
    int: false,
    min: Some(0.01),
    max: Some(168.0),
};
/// `amount`: `z.number().finite().min(0).max(9_999_999_999_999)`.
const AMOUNT: Number = Number {
    coerce: false,
    int: false,
    min: Some(0.0),
    max: Some(9_999_999_999_999.0),
};
/// `rating`: `z.number().int().min(1).max(5)`.
const RATING: Number = Number {
    coerce: false,
    int: true,
    min: Some(1.0),
    max: Some(5.0),
};

/// `DATE_PATTERN`: `^\d{4}-\d{2}-\d{2}$`.
fn date_shaped(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        })
}

/// Reads one object into its Zod output, remembering the keys its schema
/// knows for `.strict()`.
struct Reader<'a> {
    issues: &'a mut Issues,
    fields: &'a Map<String, Value>,
    known: Vec<&'static str>,
    out: Body,
}

impl<'a> Reader<'a> {
    /// The body as an object (`z.object(...)`), or the issue and `None`.
    fn of(issues: &'a mut Issues, body: &'a Value) -> Option<Self> {
        let fields = issues.object(body)?;
        Some(Self::over(issues, fields))
    }

    fn over(issues: &'a mut Issues, fields: &'a Map<String, Value>) -> Self {
        Self {
            issues,
            fields,
            known: Vec::new(),
            out: Body::new(),
        }
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

    fn text(&mut self, key: &'static str, presence: Presence, rules: Text) -> &mut Self {
        let field = self.issues.text_with(self.fields, key, presence, rules);
        self.keep(key, field);
        self
    }

    fn date(&mut self, key: &'static str, presence: Presence) -> &mut Self {
        let field = self.issues.pattern(
            self.fields,
            key,
            presence,
            None,
            None,
            date_shaped,
            DATE_MESSAGE,
        );
        self.keep(key, field);
        self
    }

    fn number(&mut self, key: &'static str, presence: Presence, rules: Number) -> &mut Self {
        let field = self.issues.number(self.fields, key, presence, rules);
        self.keep(key, field);
        self
    }

    fn flag(&mut self, key: &'static str, presence: Presence) -> &mut Self {
        let field = self.issues.boolean(self.fields, key, presence);
        self.keep(key, field);
        self
    }

    fn choice(&mut self, key: &'static str, presence: Presence, options: &[&str]) -> &mut Self {
        let field = self.issues.choice(self.fields, key, presence, options);
        self.keep(key, field);
        self
    }

    /// The output, after `.strict()`'s one `unrecognized_keys` issue at the
    /// object's own path for the keys no field read.
    fn strict(self) -> Body {
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
        self.out
    }
}

/// `error.badRequest(c, message, details)` with Zod's issues as
/// `{ path: issue.path.join('.'), message }`.
fn invalid(message: &str, invalid: &Invalid) -> Refusal {
    let details: Vec<Value> = invalid
        .issues()
        .iter()
        .map(|issue| {
            let path = issue["path"]
                .as_array()
                .map(|parts| {
                    parts
                        .iter()
                        .map(|part| {
                            part.as_str()
                                .map_or_else(|| part.to_string(), str::to_owned)
                        })
                        .collect::<Vec<_>>()
                        .join(".")
                })
                .unwrap_or_default();
            json!({ "path": path, "message": issue["message"] })
        })
        .collect();
    ApiError::bad_request(message).with_details(details).into()
}

/// `parseBody(c, schema)`: `c.req.json()`, then the schema; `Invalid JSON
/// body`, or `Invalid request body` with the issues.
pub(crate) fn parse_body<T>(
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Value) -> Option<T>,
) -> Result<T, Refusal> {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return Err(Refusal::bad_request("Invalid JSON body"));
    };
    let mut issues = Issues::default();
    let read = read(&mut issues, &value);
    match issues.finish() {
        Ok(()) => read.ok_or_else(|| ApiError::internal().into()),
        Err(failed) => Err(invalid("Invalid request body", &failed)),
    }
}

/// `readQuery(c, schema)`: the query string without empty values (`?x=` is
/// no filter), then the schema; `Invalid query parameters` with the issues.
fn read_query<T>(
    raw: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Refusal> {
    let query = Query::parse(raw);
    let mut fields = Map::new();
    for (key, value) in query.values() {
        let first = match value {
            Value::Array(values) => values.first().cloned(),
            other => Some(other.clone()),
        };
        if let Some(Value::String(text)) = first
            && !text.is_empty()
        {
            fields.insert(key.clone(), Value::String(text));
        }
    }
    let mut issues = Issues::default();
    let read = read(&mut issues, &fields);
    issues
        .finish()
        .map_err(|failed| invalid("Invalid query parameters", &failed))?;
    Ok(read)
}

fn query_text(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> Option<String> {
    issues
        .text_with(fields, key, Presence::Optional, Text::default())
        .into_option()
}

fn query_date(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> Option<String> {
    issues
        .pattern(
            fields,
            key,
            Presence::Optional,
            None,
            None,
            date_shaped,
            DATE_MESSAGE,
        )
        .into_option()
}

fn query_flag(issues: &mut Issues, fields: &Map<String, Value>) -> bool {
    issues
        .choice(fields, "tentative", Presence::Optional, &QUERY_BOOLEAN)
        .into_option()
        .is_some_and(|value| value == "true" || value == "1")
}

// ── /api/capacity ───────────────────────────────────────────────────────────

/// `capacityQuerySchema`: `(from, to, skill, tentative)`.
pub(crate) type CapacityQuery = (Option<String>, Option<String>, Option<String>, bool);

pub(crate) fn capacity_query(raw: Option<&str>) -> Result<CapacityQuery, Refusal> {
    read_query(raw, |issues, f| {
        let from = query_date(issues, f, "from");
        let to = query_date(issues, f, "to");
        let skill = query_text(issues, f, "skill");
        let tentative = query_flag(issues, f);
        (from, to, skill, tentative)
    })
}

/// `roadmapQuerySchema`: `(from, to, tentative)`.
pub(crate) fn roadmap_query(
    raw: Option<&str>,
) -> Result<(Option<String>, Option<String>, bool), Refusal> {
    read_query(raw, |issues, f| {
        let from = query_date(issues, f, "from");
        let to = query_date(issues, f, "to");
        (from, to, query_flag(issues, f))
    })
}

/// `listBookingsQuerySchema`.
#[derive(Debug, Default)]
pub(crate) struct BookingsQuery {
    pub(crate) member_id: Option<String>,
    pub(crate) project_id: Option<String>,
    pub(crate) request_id: Option<String>,
    pub(crate) from: Option<String>,
    pub(crate) to: Option<String>,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<String>,
}

pub(crate) fn bookings_query(raw: Option<&str>) -> Result<BookingsQuery, Refusal> {
    read_query(raw, |issues, f| BookingsQuery {
        member_id: query_text(issues, f, "memberId"),
        project_id: query_text(issues, f, "projectId"),
        request_id: query_text(issues, f, "requestId"),
        from: query_date(issues, f, "from"),
        to: query_date(issues, f, "to"),
        cursor: query_text(issues, f, "cursor"),
        limit: query_text(issues, f, "limit"),
    })
}

/// `listResourceRequestsQuerySchema`: `(projectId, status, cursor, limit)`.
pub(crate) type RequestsQuery = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

pub(crate) fn requests_query(raw: Option<&str>) -> Result<RequestsQuery, Refusal> {
    read_query(raw, |issues, f| {
        let project_id = query_text(issues, f, "projectId");
        let status = issues
            .choice(f, "status", Presence::Optional, &RESOURCE_REQUEST_STATUSES)
            .into_option();
        (
            project_id,
            status,
            query_text(issues, f, "cursor"),
            query_text(issues, f, "limit"),
        )
    })
}

/// `createBookingSchema`.
pub(crate) fn read_create_booking(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("memberId", Presence::Required, IDENTIFIER)
        .text("projectId", Presence::Nullish, IDENTIFIER)
        .text("requestId", Presence::Nullish, IDENTIFIER)
        .date("startsOn", Presence::Required)
        .date("endsOn", Presence::Required)
        .number("hoursPerWeek", Presence::Required, HOURS_PER_WEEK)
        .flag("tentative", Presence::Optional);
    Some(r.strict())
}

/// `updateBookingSchema`.
pub(crate) fn read_update_booking(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.date("startsOn", Presence::Optional)
        .date("endsOn", Presence::Optional)
        .number("hoursPerWeek", Presence::Optional, HOURS_PER_WEEK)
        .flag("tentative", Presence::Optional);
    Some(r.strict())
}

/// `createResourceRequestSchema`.
pub(crate) fn read_create_resource_request(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("projectId", Presence::Required, IDENTIFIER)
        .text("skill", Presence::Required, SKILL)
        .number("hoursPerWeek", Presence::Required, HOURS_PER_WEEK)
        .date("startsOn", Presence::Required)
        .date("endsOn", Presence::Required);
    Some(r.strict())
}

/// `updateResourceRequestSchema`.
pub(crate) fn read_update_resource_request(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("skill", Presence::Optional, SKILL)
        .number("hoursPerWeek", Presence::Optional, HOURS_PER_WEEK)
        .date("startsOn", Presence::Optional)
        .date("endsOn", Presence::Optional)
        .choice("status", Presence::Optional, &["cancelled"]);
    Some(r.strict())
}

/// `bookResourceRequestSchema`.
pub(crate) fn read_book(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("memberId", Presence::Required, IDENTIFIER)
        .flag("tentative", Presence::Optional);
    Some(r.strict())
}

/// `updateMemberProfileSchema`.
pub(crate) fn read_profile(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.number(
        "weeklyHours",
        Presence::Optional,
        Number {
            coerce: false,
            int: false,
            min: Some(0.0),
            max: Some(168.0),
        },
    );
    let skills = r.issues.list(
        r.fields,
        "skills",
        Presence::Optional,
        None,
        Some(30),
        |i, item| i.item_text(item, SKILL),
    );
    r.keep("skills", skills);
    Some(r.strict())
}

// ── /api/project-requests ───────────────────────────────────────────────────

/// `neededSkillSchema`, read from an item of an array: `.strict()` with the skill and its hours.
fn read_needed_skill(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let mut r = Reader::over(issues, fields);
    r.text("skill", Presence::Required, SKILL).number(
        "hoursPerWeek",
        Presence::Optional,
        HOURS_PER_WEEK,
    );
    Some(Value::Object(r.strict()))
}

/// The fields a request has beyond its title (`requestFields`).
fn read_request_fields(r: &mut Reader<'_>) {
    r.text(
        "businessCase",
        Presence::Nullish,
        Text::length(None, Some(10_000)),
    )
    .number("estimatedCost", Presence::Nullish, AMOUNT)
    .number("estimatedValue", Presence::Nullish, AMOUNT);
    let skills = r.issues.list(
        r.fields,
        "neededSkills",
        Presence::Optional,
        None,
        Some(20),
        read_needed_skill,
    );
    r.keep("neededSkills", skills);
    r.date("desiredStart", Presence::Nullish)
        .date("desiredEnd", Presence::Nullish);
}

/// `createProjectRequestSchema`.
pub(crate) fn read_create_project_request(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("title", Presence::Required, TITLE);
    read_request_fields(&mut r);
    Some(r.strict())
}

/// `updateProjectRequestSchema`.
pub(crate) fn read_update_project_request(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("title", Presence::Optional, TITLE);
    read_request_fields(&mut r);
    Some(r.strict())
}

/// `listProjectRequestsQuerySchema`: `(status, search, cursor, limit)`.
pub(crate) type ProjectRequestsQuery = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

pub(crate) fn project_requests_query(raw: Option<&str>) -> Result<ProjectRequestsQuery, Refusal> {
    read_query(raw, |issues, f| {
        let status = issues
            .choice(f, "status", Presence::Optional, &PROJECT_REQUEST_STATUSES)
            .into_option();
        (
            status,
            query_text(issues, f, "search"),
            query_text(issues, f, "cursor"),
            query_text(issues, f, "limit"),
        )
    })
}

/// `scoreProjectRequestSchema`: `scores` is `z.record(rating)`.
pub(crate) fn read_score(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    let scores = r
        .issues
        .nested(r.fields, "scores", Presence::Required, |i, map| {
            let mut out = Map::new();
            for key in map.keys() {
                if let Field::Set(rating) = i.whole_number(map, key, Presence::Required, RATING) {
                    out.insert(key.clone(), json!(rating));
                }
            }
            Value::Object(out)
        });
    r.keep("scores", scores);
    Some(r.strict())
}

/// `convertProjectRequestSchema`.
pub(crate) fn read_convert(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("projectId", Presence::Required, IDENTIFIER);
    Some(r.strict())
}

/// `scoringCriterionSchema`, read from an item of an array.
fn read_criterion(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let mut r = Reader::over(issues, fields);
    r.text("key", Presence::Required, Text::trimmed(Some(1), Some(50)))
        .text(
            "label",
            Presence::Required,
            Text::trimmed(Some(1), Some(100)),
        );
    let weight = r.issues.whole_number(
        r.fields,
        "weight",
        Presence::Required,
        Number {
            coerce: false,
            int: true,
            min: Some(0.0),
            max: Some(100.0),
        },
    );
    r.keep("weight", weight);
    r.flag("inverse", Presence::Required);
    Some(Value::Object(r.strict()))
}

/// `updateFlowSettingsSchema`.
pub(crate) fn read_settings(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    let model = r.issues.list(
        r.fields,
        "scoringModel",
        Presence::Optional,
        Some(1),
        Some(12),
        read_criterion,
    );
    r.keep("scoringModel", model);
    let board = r.issues.list(
        r.fields,
        "portfolioBoardIds",
        Presence::Optional,
        None,
        Some(50),
        |i, item| i.item_text(item, IDENTIFIER),
    );
    r.keep("portfolioBoardIds", board);
    r.number("expenseApprovalLimit", Presence::Nullish, AMOUNT);
    Some(r.strict())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(result: Result<impl std::fmt::Debug, Refusal>) -> Value {
        let Err(Refusal::Response(response)) = result else {
            panic!("expected a refusal, got {result:?}");
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime");
        let bytes = runtime
            .block_on(axum::body::to_bytes(response.into_body(), usize::MAX))
            .expect("body");
        serde_json::from_slice(&bytes).expect("json")
    }

    fn body(value: &Value) -> Bytes {
        Bytes::from(value.to_string())
    }

    #[test]
    fn a_booking_is_read_in_the_schemas_order_and_refuses_other_keys() {
        let answer = refused(parse_body(
            &body(&json!({ "memberId": "", "startsOn": "1 Dec", "hoursPerWeek": 0, "extra": 1 })),
            read_create_booking,
        ));
        assert_eq!(
            answer["error"]["details"],
            json!([
                { "path": "memberId", "message": "String must contain at least 1 character(s)" },
                { "path": "startsOn", "message": "Use a date as YYYY-MM-DD" },
                { "path": "endsOn", "message": "Required" },
                { "path": "hoursPerWeek", "message": "Number must be greater than or equal to 0.01" },
                { "path": "", "message": "Unrecognized key(s) in object: 'extra'" },
            ])
        );
        let ok = parse_body(
            &body(
                &json!({ "memberId": "m", "projectId": null, "startsOn": "2026-12-01",
                "endsOn": "2026-12-31", "hoursPerWeek": 12.5, "tentative": true }),
            ),
            read_create_booking,
        )
        .expect("valid");
        assert_eq!(ok["tentative"], json!(true));
        assert_eq!(ok["projectId"], Value::Null);
    }

    #[test]
    fn needed_skills_are_read_with_their_index_on_the_path() {
        let answer = refused(parse_body(
            &body(
                &json!({ "title": "x", "neededSkills": [{ "skill": "Ok" }, { "skill": "", "hours": 4 }] }),
            ),
            read_create_project_request,
        ));
        assert_eq!(
            answer["error"]["details"],
            json!([
                { "path": "neededSkills.1.skill", "message": "String must contain at least 1 character(s)" },
                { "path": "neededSkills.1", "message": "Unrecognized key(s) in object: 'hours'" },
            ])
        );
    }

    #[test]
    fn scores_are_a_record_of_ratings() {
        let answer = refused(parse_body(
            &body(&json!({ "scores": { "value": 6, "fit": 2.5 } })),
            read_score,
        ));
        let details = answer["error"]["details"].as_array().expect("details");
        assert!(details.contains(
            &json!({ "path": "scores.value", "message": "Number must be less than or equal to 5" })
        ));
        assert!(details.contains(
            &json!({ "path": "scores.fit", "message": "Expected integer, received float" })
        ));
        let ok =
            parse_body(&body(&json!({ "scores": { "value": 5 } })), read_score).expect("valid");
        assert_eq!(ok["scores"], json!({ "value": 5 }));
        let answer = refused(parse_body(&body(&json!({})), read_score));
        assert_eq!(
            answer["error"]["details"],
            json!([{ "path": "scores", "message": "Required" }])
        );
    }

    #[test]
    fn settings_check_the_model_and_the_board() {
        let answer = refused(parse_body(
            &body(
                &json!({ "scoringModel": [], "portfolioBoardIds": [""], "expenseApprovalLimit": -1 }),
            ),
            read_settings,
        ));
        assert_eq!(
            answer["error"]["details"],
            json!([
                { "path": "scoringModel", "message": "Array must contain at least 1 element(s)" },
                { "path": "portfolioBoardIds.0", "message": "String must contain at least 1 character(s)" },
                { "path": "expenseApprovalLimit", "message": "Number must be greater than or equal to 0" },
            ])
        );
        let answer = refused(parse_body(
            &body(
                &json!({ "scoringModel": [{ "key": "a", "label": "A", "weight": 100.5, "inverse": false }] }),
            ),
            read_settings,
        ));
        assert_eq!(
            answer["error"]["details"],
            json!([{ "path": "scoringModel.0.weight", "message": "Expected integer, received float" }])
        );
    }

    #[test]
    fn queries_drop_empty_values_and_read_flags() {
        let (from, to, skill, tentative) =
            capacity_query(Some("from=&to=2026-12-01&skill=QA&tentative=1")).expect("valid");
        assert_eq!(
            (from, to.as_deref(), skill.as_deref(), tentative),
            (None, Some("2026-12-01"), Some("QA"), true)
        );
        let answer = refused(capacity_query(Some("from=tomorrow&tentative=maybe")));
        assert_eq!(answer["error"]["message"], "Invalid query parameters");
        assert_eq!(
            answer["error"]["details"],
            json!([
                { "path": "from", "message": "Use a date as YYYY-MM-DD" },
                { "path": "tentative", "message": "Invalid enum value. Expected 'true' | 'false' | '1' | '0', received 'maybe'" },
            ])
        );
        let answer = refused(requests_query(Some("status=pending")));
        assert_eq!(
            answer["error"]["details"],
            json!([{ "path": "status", "message": "Invalid enum value. Expected 'open' | 'booked' | 'cancelled', received 'pending'" }])
        );
    }
}
