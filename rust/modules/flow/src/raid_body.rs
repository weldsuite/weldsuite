//! The request schemas of `/api/project-raid` and `/api/project-control-links`
//! (`@weldsuite/app-api-client/schemas/project-control`), read the way Zod
//! reads them: the fields in the schema's order, each with Zod's issue, and
//! `.strict()` objects refusing any other key.
//!
//! The routes answer a failure themselves (`parseBody` / `readQuery`), not
//! as `zValidator` does: `error.badRequest(c, 'Invalid request body' |
//! 'Invalid query parameters', details)`, the details being Zod's issues as
//! `{ path: issue.path.join('.'), message }`.

use axum::body::Bytes;
use serde_json::{Map, Value, json};
use weldsuite_flow_domain::raid::{
    ASSUMPTION_CONFIDENCES, CONTROL_LINK_RELATIONS, CONTROL_LINK_TYPES, DEPENDENCY_DIRECTIONS,
    DEPENDENCY_PARTY_TYPES, ISSUE_SEVERITIES, RAID_KINDS, RAID_TASK_PRIORITIES, RISK_STRATEGIES,
    RaidKind,
};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Format, Invalid, Issues, Number, Presence, Text};

use crate::{Query, Refusal};

/// A body as its schema reads it: the keys present, with Zod's output
/// (trimmed strings, numbers); `null` kept as `null`.
pub(crate) type Body = Map<String, Value>;

/// `identifier`: `z.string().min(1).max(255)`.
pub(crate) const IDENTIFIER: Text = Text::length(Some(1), Some(255));
/// `title`: `z.string().trim().min(1).max(255)`.
pub(crate) const TITLE: Text = Text::trimmed(Some(1), Some(255));
/// `z.string().max(10_000)`.
pub(crate) const LONG_TEXT: Text = Text::length(None, Some(10_000));
/// `z.string().trim().max(100)`.
const CATEGORY: Text = Text::trimmed(None, Some(100));
/// `rating`: `z.number().int().min(1).max(5)`.
const RATING: Number = whole(1.0, 5.0);
const QUERY_BOOLEAN: [&str; 4] = ["true", "false", "1", "0"];

/// `z.number().int().min(min).max(max)`.
pub(crate) const fn whole(min: f64, max: f64) -> Number {
    Number {
        coerce: false,
        int: true,
        min: Some(min),
        max: Some(max),
    }
}

/// `isoDateTime`: `z.string().datetime({ offset: true })`.
pub(crate) fn iso_date_time() -> Text {
    Text {
        format: Some(Format::DatetimeOffset),
        ..Text::default()
    }
}

/// Reads one object into its Zod output, remembering the keys its schema
/// knows for `.strict()`.
pub(crate) struct Reader<'a> {
    pub(crate) issues: &'a mut Issues,
    pub(crate) fields: &'a Map<String, Value>,
    pub(crate) known: Vec<&'static str>,
    pub(crate) out: Body,
}

impl<'a> Reader<'a> {
    /// The body as an object (`z.object(...)`), or the issue and `None`.
    pub(crate) fn of(issues: &'a mut Issues, body: &'a Value) -> Option<Self> {
        let fields = issues.object(body)?;
        Some(Self::over(issues, fields))
    }

    pub(crate) fn over(issues: &'a mut Issues, fields: &'a Map<String, Value>) -> Self {
        Self {
            issues,
            fields,
            known: Vec::new(),
            out: Body::new(),
        }
    }

    /// Keep a read field, as Zod's object does (absent stays out).
    pub(crate) fn keep<T: Into<Value>>(
        &mut self,
        key: &'static str,
        field: weldsuite_kit::validation::Field<T>,
    ) {
        use weldsuite_kit::validation::Field;
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

    pub(crate) fn text(&mut self, key: &'static str, presence: Presence, rules: Text) -> &mut Self {
        let field = self.issues.text_with(self.fields, key, presence, rules);
        self.keep(key, field);
        self
    }

    pub(crate) fn choice(
        &mut self,
        key: &'static str,
        presence: Presence,
        options: &[&str],
    ) -> &mut Self {
        let field = self.issues.choice(self.fields, key, presence, options);
        self.keep(key, field);
        self
    }

    pub(crate) fn whole(
        &mut self,
        key: &'static str,
        presence: Presence,
        rules: Number,
    ) -> &mut Self {
        let field = self.issues.whole_number(self.fields, key, presence, rules);
        self.keep(key, field);
        self
    }

    pub(crate) fn number(
        &mut self,
        key: &'static str,
        presence: Presence,
        rules: Number,
    ) -> &mut Self {
        let field = self.issues.number(self.fields, key, presence, rules);
        self.keep(key, field);
        self
    }

    /// `z.record(z.unknown())`.
    pub(crate) fn record(&mut self, key: &'static str, presence: Presence) -> &mut Self {
        let field = self.issues.nested(self.fields, key, presence, |_, map| {
            Value::Object(map.clone())
        });
        self.keep(key, field);
        self
    }

    /// The output, after `.strict()`'s one `unrecognized_keys` issue at the
    /// object's own path for the keys no field read.
    pub(crate) fn strict(self) -> Body {
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
pub(crate) fn invalid(message: &str, invalid: &Invalid) -> Refusal {
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
pub(crate) fn read_query<T>(
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

// ── /api/project-raid ───────────────────────────────────────────────────────

/// `commonCreateFields` (with `kind` first) / `commonUpdateFields`.
fn read_common(r: &mut Reader<'_>, create: bool) {
    if create {
        r.text("projectId", Presence::Required, IDENTIFIER).text(
            "title",
            Presence::Required,
            TITLE,
        );
    } else {
        r.text("title", Presence::Optional, TITLE);
    }
    r.text("description", Presence::Nullish, LONG_TEXT)
        .text("category", Presence::Nullish, CATEGORY)
        .text("ownerId", Presence::Nullish, IDENTIFIER)
        .text("dueAt", Presence::Nullish, iso_date_time())
        .record("customFields", Presence::Nullish);
}

/// The fields after the common ones, in the schema's order: the status, then
/// the kind's own (`create<Kind>Schema` / `update<Kind>Schema`).
fn read_kind_fields(r: &mut Reader<'_>, kind: RaidKind, create: bool) {
    let required = if create {
        Presence::Required
    } else {
        Presence::Optional
    };
    r.choice("status", Presence::Optional, kind.statuses());
    match kind {
        RaidKind::Risk => {
            r.whole("probability", required, RATING)
                .whole("impact", required, RATING)
                .whole("residualProbability", Presence::Nullish, RATING)
                .whole("residualImpact", Presence::Nullish, RATING)
                .choice("strategy", Presence::Nullish, &RISK_STRATEGIES)
                .text(
                    "trigger",
                    Presence::Nullish,
                    Text::length(None, Some(2_000)),
                )
                .number(
                    "costImpact",
                    Presence::Nullish,
                    Number {
                        int: false,
                        ..whole(0.0, 9_999_999_999_999.0)
                    },
                )
                .whole("scheduleImpactDays", Presence::Nullish, whole(0.0, 3_650.0))
                .whole("reviewIntervalDays", Presence::Nullish, whole(1.0, 365.0));
        }
        RaidKind::Assumption => {
            r.choice("confidence", Presence::Nullish, &ASSUMPTION_CONFIDENCES)
                .text("ifWrong", Presence::Nullish, LONG_TEXT);
        }
        RaidKind::Issue => {
            r.choice("severity", Presence::Optional, &ISSUE_SEVERITIES)
                .text("escalatedAt", Presence::Nullish, iso_date_time());
        }
        RaidKind::Dependency => {
            r.choice("direction", required, &DEPENDENCY_DIRECTIONS)
                .choice("partyType", Presence::Nullish, &DEPENDENCY_PARTY_TYPES)
                .text("partyProjectId", Presence::Nullish, IDENTIFIER)
                .text(
                    "partyName",
                    Presence::Nullish,
                    Text::trimmed(None, Some(255)),
                );
        }
    }
}

/// `createRaidItemSchema`: a discriminated union on `kind`.
pub(crate) fn read_create(issues: &mut Issues, body: &Value) -> Option<(RaidKind, Body)> {
    let mut r = Reader::of(issues, body)?;
    let Some(kind) = r
        .fields
        .get("kind")
        .and_then(Value::as_str)
        .and_then(RaidKind::parse)
    else {
        r.issues.invalid_discriminator("kind", &RAID_KINDS);
        return None;
    };
    r.known.push("kind");
    r.out.insert("kind".to_owned(), json!(kind.as_str()));
    read_common(&mut r, true);
    read_kind_fields(&mut r, kind, true);
    Some((kind, r.strict()))
}

/// `updateRaidItemSchemas[kind]`: the kind of an item never changes.
pub(crate) fn read_update(issues: &mut Issues, body: &Value, kind: RaidKind) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    read_common(&mut r, false);
    read_kind_fields(&mut r, kind, false);
    Some(r.strict())
}

/// `assessRiskSchema`.
pub(crate) fn read_assess(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.whole("probability", Presence::Required, RATING)
        .whole("impact", Presence::Required, RATING)
        .whole("residualProbability", Presence::Nullish, RATING)
        .whole("residualImpact", Presence::Nullish, RATING)
        .text("note", Presence::Nullish, Text::trimmed(None, Some(2_000)))
        .text("nextReviewAt", Presence::Optional, iso_date_time());
    Some(r.strict())
}

/// `convertRaidItemSchema`.
pub(crate) fn read_convert(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.choice("to", Presence::Required, &["risk", "issue"])
        .text("title", Presence::Optional, TITLE)
        .text("description", Presence::Nullish, LONG_TEXT)
        .text("category", Presence::Nullish, CATEGORY)
        .text("ownerId", Presence::Nullish, IDENTIFIER)
        .text("dueAt", Presence::Nullish, iso_date_time())
        .whole("probability", Presence::Optional, RATING)
        .whole("impact", Presence::Optional, RATING)
        .choice("severity", Presence::Optional, &ISSUE_SEVERITIES);
    Some(r.strict())
}

/// `createRaidTaskSchema`.
pub(crate) fn read_task(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text(
        "title",
        Presence::Required,
        Text::trimmed(Some(1), Some(500)),
    )
    .text("description", Presence::Nullish, LONG_TEXT)
    .text("assigneeId", Presence::Nullish, IDENTIFIER)
    .text("dueDate", Presence::Nullish, iso_date_time())
    .choice("priority", Presence::Optional, &RAID_TASK_PRIORITIES);
    Some(r.strict())
}

/// `queryBoolean`: `true`/`1` or `false`/`0`.
fn query_boolean(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> Option<bool> {
    issues
        .choice(fields, key, Presence::Optional, &QUERY_BOOLEAN)
        .into_option()
        .map(|value| value == "true" || value == "1")
}

/// `listQuerySchema` of `GET /api/project-raid`.
#[derive(Debug, Default)]
pub(crate) struct ListQuery {
    pub(crate) project_id: Option<String>,
    pub(crate) kind: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) owner_id: Option<String>,
    pub(crate) band: Option<String>,
    pub(crate) open: bool,
    pub(crate) search: Option<String>,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<String>,
}

pub(crate) fn raid_list_query(raw: Option<&str>) -> Result<ListQuery, Refusal> {
    read_query(raw, |issues, f| {
        let string = |issues: &mut Issues, key: &str| {
            issues
                .text_with(f, key, Presence::Optional, Text::default())
                .into_option()
        };
        ListQuery {
            project_id: string(issues, "projectId"),
            kind: issues
                .choice(f, "kind", Presence::Optional, &RAID_KINDS)
                .into_option(),
            status: string(issues, "status"),
            owner_id: string(issues, "ownerId"),
            band: issues
                .choice(
                    f,
                    "band",
                    Presence::Optional,
                    &weldsuite_flow_domain::risk::RISK_BANDS,
                )
                .into_option(),
            open: query_boolean(issues, f, "open").unwrap_or(false),
            search: string(issues, "search"),
            cursor: string(issues, "cursor"),
            limit: string(issues, "limit"),
        }
    })
}

/// `matrixQuerySchema`: the project, and whether to place risks by their
/// residual ratings.
pub(crate) fn matrix_query(raw: Option<&str>) -> Result<(Option<String>, bool), Refusal> {
    read_query(raw, |issues, f| {
        let project_id = issues
            .text_with(f, "projectId", Presence::Optional, Text::default())
            .into_option();
        let residual = query_boolean(issues, f, "residual").unwrap_or(false);
        (project_id, residual)
    })
}

// ── /api/project-control-links ──────────────────────────────────────────────

/// `listQuerySchema` of `GET /api/project-control-links` (strict).
pub(crate) fn link_list_query(raw: Option<&str>) -> Result<Body, Refusal> {
    read_query(raw, |issues, f| {
        let mut r = Reader::over(issues, f);
        r.choice("fromType", Presence::Optional, &CONTROL_LINK_TYPES)
            .text("fromId", Presence::Optional, Text::default())
            .choice("toType", Presence::Optional, &CONTROL_LINK_TYPES)
            .text("toId", Presence::Optional, Text::default());
        r.strict()
    })
}

/// `createControlLinkSchema`.
pub(crate) fn read_link(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.choice("fromType", Presence::Required, &CONTROL_LINK_TYPES)
        .text("fromId", Presence::Required, IDENTIFIER)
        .choice("toType", Presence::Required, &CONTROL_LINK_TYPES)
        .text("toId", Presence::Required, IDENTIFIER)
        .choice("relation", Presence::Required, &CONTROL_LINK_RELATIONS);
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
    fn a_body_that_is_not_json_or_not_an_object_is_refused_like_parse_body() {
        let answer = refused(parse_body(&Bytes::from_static(b"{nope"), read_create));
        assert_eq!(
            answer,
            json!({ "error": { "code": "BAD_REQUEST", "message": "Invalid JSON body" } })
        );
        let answer = refused(parse_body(&body(&json!("not an object")), read_create));
        assert_eq!(
            answer,
            json!({ "error": { "code": "BAD_REQUEST", "message": "Invalid request body",
                "details": [{ "path": "", "message": "Expected object, received string" }] } })
        );
    }

    #[test]
    fn create_picks_the_kind_and_refuses_other_kinds_fields() {
        let answer = refused(parse_body(
            &body(&json!({ "kind": "epic", "projectId": "p", "title": "x" })),
            read_create,
        ));
        assert_eq!(
            answer["error"]["details"],
            json!([{ "path": "kind", "message": "Invalid discriminator value. Expected 'risk' | 'assumption' | 'issue' | 'dependency'" }])
        );
        let answer = refused(parse_body(
            &body(
                &json!({ "kind": "assumption", "projectId": "p", "title": "x", "strategy": "avoid" }),
            ),
            read_create,
        ));
        assert_eq!(
            answer["error"]["details"],
            json!([{ "path": "", "message": "Unrecognized key(s) in object: 'strategy'" }])
        );
        let answer = refused(parse_body(
            &body(
                &json!({ "kind": "risk", "projectId": "p", "title": "  ", "probability": 6, "impact": 2.5 }),
            ),
            read_create,
        ));
        assert_eq!(
            answer["error"]["details"],
            json!([
                { "path": "title", "message": "String must contain at least 1 character(s)" },
                { "path": "probability", "message": "Number must be less than or equal to 5" },
                { "path": "impact", "message": "Expected integer, received float" },
            ])
        );
        let (kind, input) = parse_body(
            &body(
                &json!({ "kind": "risk", "projectId": "p", "title": " Late ", "probability": 3,
                "impact": 4, "description": null, "costImpact": 12.5 }),
            ),
            read_create,
        )
        .expect("valid");
        assert_eq!(kind, RaidKind::Risk);
        assert_eq!(
            Value::Object(input),
            json!({ "kind": "risk", "projectId": "p", "title": "Late", "probability": 3,
                "impact": 4, "description": null, "costImpact": 12.5 })
        );
    }

    #[test]
    fn updates_follow_the_stored_kind() {
        assert!(
            parse_body(&body(&json!({ "probability": 3 })), |i, b| read_update(
                i,
                b,
                RaidKind::Assumption
            ))
            .is_err()
        );
        let answer = refused(parse_body(&body(&json!({ "title": null })), |i, b| {
            read_update(i, b, RaidKind::Risk)
        }));
        assert_eq!(
            answer["error"]["details"],
            json!([{ "path": "title", "message": "Expected string, received null" }])
        );
        let input = parse_body(
            &body(&json!({ "residualProbability": null, "status": "closed" })),
            |i, b| read_update(i, b, RaidKind::Risk),
        )
        .expect("valid");
        assert_eq!(
            Value::Object(input),
            json!({ "residualProbability": null, "status": "closed" })
        );
    }

    #[test]
    fn queries_drop_empty_values_and_read_booleans() {
        let q = raid_list_query(Some("projectId=&open=1&band=high&limit=2")).expect("valid");
        assert_eq!(q.project_id, None);
        assert!(q.open);
        assert_eq!(q.band.as_deref(), Some("high"));
        let answer = refused(raid_list_query(Some("open=maybe")));
        assert_eq!(answer["error"]["message"], "Invalid query parameters");
        assert_eq!(
            answer["error"]["details"],
            json!([{ "path": "open", "message": "Invalid enum value. Expected 'true' | 'false' | '1' | '0', received 'maybe'" }])
        );
        let answer = refused(link_list_query(Some("fromType=task&fromId=x&extra=1")));
        assert_eq!(
            answer["error"]["details"],
            json!([{ "path": "", "message": "Unrecognized key(s) in object: 'extra'" }])
        );
    }
}
