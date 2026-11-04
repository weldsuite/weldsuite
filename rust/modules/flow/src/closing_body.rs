//! The request schemas of `/api/project-lessons`, `/api/project-close` and
//! `/api/project-templates`
//! (`@weldsuite/app-api-client/schemas/project-closing`), read the way Zod
//! reads them: the fields in the schema's order, each with Zod's issue, and
//! `.strict()` objects refusing any other key. The blueprint itself is
//! `weldsuite_flow_domain::blueprint`.
//!
//! The routes answer a failure themselves (`parseBody` / `readQuery` of
//! `lib/closing-input.ts`): `Invalid JSON body`, or `Invalid request body` /
//! `Invalid query parameters` with the issues as `details`.

use axum::body::Bytes;
use serde_json::{Map, Value, json};
use weldsuite_flow_domain::blueprint::{Obj, read_blueprint_fields};
use weldsuite_flow_domain::project_closing::{LESSON_CATEGORIES, LESSON_PAGE_LOCALES};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Field, Invalid, Issues, Presence, Text};

use crate::{Query, Refusal};

/// A body as its schema reads it: the keys present, with Zod's output.
pub(crate) type Body = Map<String, Value>;

/// `identifier`: `z.string().min(1).max(255)`.
const IDENTIFIER: Text = Text::length(Some(1), Some(255));
/// `z.string().trim().min(1).max(255)`.
const NAME: Text = Text::trimmed(Some(1), Some(255));
const QUERY_BOOLEAN: [&str; 4] = ["true", "false", "1", "0"];

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

/// `parseBody(c, schema)`: `c.req.json()`, then the schema.
pub(crate) fn parse_body(
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Value) -> Option<Body>,
) -> Result<Body, Refusal> {
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

/// `readQuery(c, schema)`: the query string without empty values, then the schema.
fn read_query(
    raw: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> Body,
) -> Result<Body, Refusal> {
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

/// The object a body is, read with `fields`, or `None`.
fn object_of(issues: &mut Issues, body: &Value, fields: impl FnOnce(&mut Obj<'_>)) -> Option<Body> {
    let map = issues.object(body)?;
    let mut o = Obj::new(issues, map);
    fields(&mut o);
    match o.finish() {
        Value::Object(out) => Some(out),
        _ => None,
    }
}

// ── Lessons ─────────────────────────────────────────────────────────────────

/// `lessonText`: `z.string().trim().min(1).max(2000)`.
const LESSON_TEXT: Text = Text::trimmed(Some(1), Some(2_000));

/// `createLessonSchema`.
pub(crate) fn read_create_lesson(issues: &mut Issues, body: &Value) -> Option<Body> {
    object_of(issues, body, |o| {
        o.text("projectId", Presence::Required, IDENTIFIER)
            .choice("category", Presence::Required, &LESSON_CATEGORIES)
            .text("text", Presence::Required, LESSON_TEXT);
    })
}

/// `updateLessonSchema`.
pub(crate) fn read_update_lesson(issues: &mut Issues, body: &Value) -> Option<Body> {
    object_of(issues, body, |o| {
        o.choice("category", Presence::Optional, &LESSON_CATEGORIES)
            .text("text", Presence::Optional, LESSON_TEXT);
    })
}

/// `publishLessonsSchema`.
pub(crate) fn read_publish(issues: &mut Issues, body: &Value) -> Option<Body> {
    object_of(issues, body, |o| {
        o.text("projectId", Presence::Required, IDENTIFIER)
            .text("spaceId", Presence::Required, IDENTIFIER)
            .text(
                "title",
                Presence::Optional,
                Text::trimmed(Some(1), Some(500)),
            )
            .choice("locale", Presence::Optional, &LESSON_PAGE_LOCALES);
    })
}

/// `listQuerySchema` of `GET /api/project-lessons`.
#[derive(Debug, Default)]
pub(crate) struct LessonQuery {
    pub(crate) project_id: Option<String>,
    pub(crate) category: Option<String>,
    pub(crate) search: Option<String>,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<String>,
}

fn optional_text(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> Option<String> {
    issues
        .text_with(fields, key, Presence::Optional, Text::default())
        .into_option()
}

pub(crate) fn lesson_query(raw: Option<&str>) -> Result<LessonQuery, Refusal> {
    let mut query = LessonQuery::default();
    read_query(raw, |issues, f| {
        query = LessonQuery {
            project_id: optional_text(issues, f, "projectId"),
            category: issues
                .choice(f, "category", Presence::Optional, &LESSON_CATEGORIES)
                .into_option(),
            search: optional_text(issues, f, "search"),
            cursor: optional_text(issues, f, "cursor"),
            limit: optional_text(issues, f, "limit"),
        };
        Body::new()
    })?;
    Ok(query)
}

// ── Closing ─────────────────────────────────────────────────────────────────

/// `handoverEntrySchema`: `{ id, ownerId }`, strict.
fn read_handover_entry(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let mut o = Obj::new(issues, fields);
    o.text("id", Presence::Required, IDENTIFIER)
        .text("ownerId", Presence::Required, IDENTIFIER);
    Some(o.finish())
}

/// `handoverSchema`.
pub(crate) fn read_handover(issues: &mut Issues, body: &Value) -> Option<Body> {
    object_of(issues, body, |o| {
        o.list(
            "raidItems",
            Presence::Optional,
            Some(200),
            read_handover_entry,
        )
        .list(
            "benefits",
            Presence::Optional,
            Some(200),
            read_handover_entry,
        );
    })
}

/// `requestCloseSchema`.
pub(crate) fn read_request_close(issues: &mut Issues, body: &Value) -> Option<Body> {
    object_of(issues, body, |o| {
        o.text("note", Presence::Nullish, Text::trimmed(None, Some(2_000)));
    })
}

// ── Templates ───────────────────────────────────────────────────────────────

/// `z.string().max(2000)`.
const DESCRIPTION: Text = Text::length(None, Some(2_000));

/// `createTemplateSchema`.
pub(crate) fn read_create_template(issues: &mut Issues, body: &Value) -> Option<Body> {
    object_of(issues, body, |o| {
        o.text("name", Presence::Required, NAME)
            .text("description", Presence::Nullish, DESCRIPTION)
            .nested("blueprint", Presence::Required, read_blueprint_fields)
            .boolean("shared", Presence::Optional);
    })
}

/// `updateTemplateSchema`.
pub(crate) fn read_update_template(issues: &mut Issues, body: &Value) -> Option<Body> {
    object_of(issues, body, |o| {
        o.text("name", Presence::Optional, NAME)
            .text("description", Presence::Nullish, DESCRIPTION)
            .nested("blueprint", Presence::Optional, read_blueprint_fields)
            .boolean("shared", Presence::Optional);
    })
}

fn role_label(issues: &mut Issues, map: &Map<String, Value>, key: &str) -> Field<String> {
    issues.text_with(
        map,
        key,
        Presence::Required,
        Text::trimmed(Some(1), Some(100)),
    )
}

fn person(issues: &mut Issues, map: &Map<String, Value>, key: &str) -> Field<String> {
    issues.text_with(map, key, Presence::Required, IDENTIFIER)
}

/// `templateFromProjectSchema`.
pub(crate) fn read_from_project(issues: &mut Issues, body: &Value) -> Option<Body> {
    object_of(issues, body, |o| {
        o.text("name", Presence::Required, NAME)
            .text("description", Presence::Nullish, DESCRIPTION)
            .boolean("shared", Presence::Optional)
            .record("roleLabels", Presence::Optional, role_label);
    })
}

/// `instantiateCopySchema`.
fn read_copy(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    let mut o = Obj::new(issues, fields);
    for key in [
        "phases",
        "milestones",
        "deliverables",
        "tasks",
        "stages",
        "raid",
        "changeControl",
        "statusReport",
    ] {
        o.boolean(key, Presence::Optional);
    }
    o.finish()
}

/// `instantiateTemplateSchema`.
pub(crate) fn read_instantiate(issues: &mut Issues, body: &Value) -> Option<Body> {
    object_of(issues, body, |o| {
        o.text("name", Presence::Required, NAME)
            .calendar_date("startDate")
            .record("roles", Presence::Optional, person)
            .text("clientId", Presence::Nullish, IDENTIFIER)
            .nested("copy", Presence::Optional, read_copy);
    })
}

/// `queryBoolean`: `true`/`1` or `false`/`0`.
fn query_boolean(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> Option<bool> {
    issues
        .choice(fields, key, Presence::Optional, &QUERY_BOOLEAN)
        .into_option()
        .map(|value| value == "true" || value == "1")
}

/// `listQuerySchema` of `GET /api/project-templates`.
#[derive(Debug, Default)]
pub(crate) struct TemplateQuery {
    pub(crate) search: Option<String>,
    pub(crate) shared: Option<bool>,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<String>,
}

pub(crate) fn template_query(raw: Option<&str>) -> Result<TemplateQuery, Refusal> {
    let mut query = TemplateQuery::default();
    read_query(raw, |issues, f| {
        query = TemplateQuery {
            search: optional_text(issues, f, "search"),
            shared: query_boolean(issues, f, "shared"),
            cursor: optional_text(issues, f, "cursor"),
            limit: optional_text(issues, f, "limit"),
        };
        Body::new()
    })?;
    Ok(query)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(result: Result<Body, Refusal>) -> Value {
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
    fn bodies_that_do_not_fit_are_refused_as_parse_body_does() {
        let answer = refused(parse_body(
            &Bytes::from_static(b"{nope"),
            read_create_lesson,
        ));
        assert_eq!(answer["error"]["message"], "Invalid JSON body");
        let answer = refused(parse_body(
            &body(&json!("not an object")),
            read_create_lesson,
        ));
        assert_eq!(answer["error"]["message"], "Invalid request body");
        let base = json!({ "projectId": "p", "category": "went_well", "text": "ok" });
        assert!(parse_body(&body(&base), read_create_lesson).is_ok());
        for change in [
            json!({ "text": "   " }),
            json!({ "text": "x".repeat(2001) }),
            json!({ "category": "meh" }),
            json!({ "id": "les_hijack" }),
            json!({ "authorId": "user" }),
        ] {
            let mut bad = base.clone();
            bad.as_object_mut()
                .expect("object")
                .extend(change.as_object().expect("object").clone());
            let answer = refused(parse_body(&body(&bad), read_create_lesson));
            assert_eq!(answer["error"]["message"], "Invalid request body", "{bad}");
        }
        let missing = refused(parse_body(
            &body(&json!({ "category": "went_well", "text": "x" })),
            read_create_lesson,
        ));
        assert_eq!(missing["error"]["details"][0]["path"], "projectId");
        let trimmed = parse_body(
            &body(&json!({ "projectId": "p", "category": "went_well", "text": "  hi  " })),
            read_create_lesson,
        )
        .expect("valid");
        assert_eq!(trimmed["text"], "hi");
    }

    #[test]
    fn the_close_bodies_are_strict() {
        for bad in [
            json!({ "raidItems": [{ "id": "x" }] }),
            json!({ "raidItems": [{ "id": "x", "ownerId": "" }] }),
            json!({ "raidItems": "x" }),
            json!({ "other": [] }),
        ] {
            assert!(parse_body(&body(&bad), read_handover).is_err(), "{bad}");
        }
        assert!(parse_body(&body(&json!({})), read_handover).is_ok());
        assert!(
            parse_body(
                &body(&json!({ "note": "x".repeat(2001) })),
                read_request_close
            )
            .is_err()
        );
        assert!(parse_body(&body(&json!({ "extra": true })), read_request_close).is_err());
        assert!(parse_body(&body(&json!({ "note": null })), read_request_close).is_ok());
    }

    #[test]
    fn a_date_of_the_wrong_shape_reports_the_format_and_the_calendar_issue_like_zod() {
        let issues = |date: Value| {
            let answer = refused(parse_body(
                &body(&json!({ "name": "x", "startDate": date })),
                read_instantiate,
            ));
            answer["error"]["details"].clone()
        };
        let message = "Use a date as YYYY-MM-DD";
        let wrong_shape = issues(json!("03-03-2027"));
        assert_eq!(wrong_shape.as_array().map(Vec::len), Some(2));
        for issue in wrong_shape.as_array().into_iter().flatten() {
            assert_eq!(issue, &json!({ "message": message, "path": "startDate" }));
        }
        // A real-looking date that is not one: the calendar issue only.
        assert_eq!(
            issues(json!("2027-02-30")).as_array().map(Vec::len),
            Some(1)
        );
        // Not a string: the type issue only.
        assert_eq!(issues(json!(5)).as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn an_instantiate_body_needs_a_real_date_and_known_copy_options() {
        let ok = json!({ "name": "x", "startDate": "2027-03-03", "roles": { "sponsor": "u" }, "copy": { "tasks": false } });
        assert!(parse_body(&body(&ok), read_instantiate).is_ok());
        for bad in [
            json!({ "startDate": "2027-03-03" }),
            json!({ "name": "x" }),
            json!({ "name": "x", "startDate": "03-03-2027" }),
            json!({ "name": "x", "startDate": "2027-02-30" }),
            json!({ "name": "x", "startDate": "2027-03-03", "roles": { "sponsor": "" } }),
            json!({ "name": "x", "startDate": "2027-03-03", "copy": { "tasks": "yes" } }),
            json!({ "name": "x", "startDate": "2027-03-03", "copy": { "budget": true } }),
            json!({ "name": "x", "startDate": "2027-03-03", "extra": 1 }),
        ] {
            assert!(parse_body(&body(&bad), read_instantiate).is_err(), "{bad}");
        }
        assert!(
            parse_body(
                &body(&json!({ "name": "x", "startDate": "2028-02-29" })),
                read_instantiate
            )
            .is_ok()
        );
    }

    #[test]
    fn template_bodies_nest_the_blueprint() {
        for bad in [
            json!({}),
            json!({ "name": "   " }),
            json!({ "name": "x", "shared": "yes" }),
            json!({ "name": "x", "extra": 1 }),
            json!({ "name": "x", "roleLabels": { "member_1": "" } }),
        ] {
            assert!(parse_body(&body(&bad), read_from_project).is_err(), "{bad}");
        }
        assert!(
            parse_body(
                &body(&json!({ "name": "x", "roleLabels": { "a": " Lead " } })),
                read_from_project
            )
            .is_ok()
        );
        assert!(
            parse_body(
                &body(&json!({ "name": "x", "blueprint": { "version": 2 } })),
                read_create_template
            )
            .is_err()
        );
        assert!(parse_body(&body(&json!({ "source": "x" })), read_update_template).is_err());
        assert!(parse_body(&body(&json!({ "description": null })), read_update_template).is_ok());
    }

    #[test]
    fn queries_drop_empty_values_and_read_booleans() {
        let q = lesson_query(Some("projectId=&category=went_well&limit=2")).expect("valid");
        assert_eq!(q.project_id, None);
        assert_eq!(q.category.as_deref(), Some("went_well"));
        assert!(lesson_query(Some("category=meh")).is_err());
        let t = template_query(Some("shared=1&search=x")).expect("valid");
        assert_eq!(t.shared, Some(true));
        assert!(template_query(Some("shared=maybe")).is_err());
        assert_eq!(
            template_query(Some("limit=abc"))
                .expect("valid")
                .limit
                .as_deref(),
            Some("abc")
        );
    }
}
