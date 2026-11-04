//! The request schemas of `/api/project-changes`
//! (`@weldsuite/app-api-client/schemas/flow-approvals`), read the way Zod
//! reads them (see `raid_body`).

use serde_json::{Map, Value};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};

use crate::Refusal;
use crate::raid_body::{
    Body, IDENTIFIER, LONG_TEXT, Reader, TITLE, iso_date_time, read_query, whole,
};

const STATUSES: [&str; 7] = [
    "draft",
    "assessing",
    "awaiting_approval",
    "approved",
    "rejected",
    "implemented",
    "withdrawn",
];

fn signed_amount() -> Number {
    Number {
        coerce: false,
        int: false,
        min: Some(-9_999_999_999_999.0),
        max: Some(9_999_999_999_999.0),
    }
}

fn array_field(field: Field<Vec<Value>>) -> Field<Value> {
    match field {
        Field::Set(items) => Field::Set(Value::Array(items)),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    }
}

/// A strict object read by `read`.
fn strict_object(
    issues: &mut Issues,
    item: &Value,
    read: impl FnOnce(&mut Reader<'_>),
) -> Option<Value> {
    let fields = issues.object(item)?;
    let mut r = Reader::over(issues, fields);
    read(&mut r);
    Some(Value::Object(r.strict()))
}

/// `planChangesSchema` at `key`.
fn plan_changes(r: &mut Reader<'_>) {
    let field = r
        .issues
        .nested(r.fields, "planChanges", Presence::Nullish, |issues, map| {
            let mut n = Reader::over(issues, map);
            let milestones = n.issues.list(
                n.fields,
                "milestones",
                Presence::Optional,
                None,
                Some(100),
                |iss, item| {
                    strict_object(iss, item, |m| {
                        m.text("milestoneId", Presence::Required, IDENTIFIER).text(
                            "to",
                            Presence::Required,
                            iso_date_time(),
                        );
                    })
                },
            );
            n.keep("milestones", array_field(milestones));
            let deliverables = n.issues.list(
                n.fields,
                "deliverables",
                Presence::Optional,
                None,
                Some(100),
                |iss, item| {
                    strict_object(iss, item, |m| {
                        m.text("deliverableId", Presence::Required, IDENTIFIER)
                            .text("plannedStart", Presence::Nullish, iso_date_time())
                            .text("plannedEnd", Presence::Nullish, iso_date_time());
                    })
                },
            );
            n.keep("deliverables", array_field(deliverables));
            n.text("goLive", Presence::Nullish, iso_date_time());
            Value::Object(n.strict())
        });
    r.keep("planChanges", field);
}

/// `scopeChangesSchema` at `key`.
fn scope_changes(r: &mut Reader<'_>) {
    let field = r.issues.nested(
        r.fields,
        "scopeChanges",
        Presence::Nullish,
        |issues, map| {
            let mut n = Reader::over(issues, map);
            let add = n.issues.list(
                n.fields,
                "add",
                Presence::Optional,
                None,
                Some(50),
                |iss, item| {
                    strict_object(iss, item, |m| {
                        m.text("title", Presence::Required, TITLE)
                            .text("description", Presence::Nullish, LONG_TEXT)
                            .text("ownerId", Presence::Nullish, IDENTIFIER)
                            .text("plannedStart", Presence::Nullish, iso_date_time())
                            .text("plannedEnd", Presence::Nullish, iso_date_time());
                    })
                },
            );
            n.keep("add", array_field(add));
            let remove = n.issues.list(
                n.fields,
                "remove",
                Presence::Optional,
                None,
                Some(100),
                |iss, item| iss.item_text(item, IDENTIFIER).map(Value::String),
            );
            n.keep("remove", array_field(remove));
            Value::Object(n.strict())
        },
    );
    r.keep("scopeChanges", field);
}

/// The impact fields after the common ones (`changeImpactFields`).
fn impact(r: &mut Reader<'_>) {
    r.number("costDelta", Presence::Nullish, signed_amount())
        .whole(
            "scheduleDeltaDays",
            Presence::Nullish,
            whole(-3_650.0, 3_650.0),
        );
    plan_changes(r);
    scope_changes(r);
}

fn client_visible(r: &mut Reader<'_>) {
    let field = r
        .issues
        .boolean(r.fields, "clientVisible", Presence::Optional);
    r.keep("clientVisible", field);
}

/// `createChangeRequestSchema`.
pub(crate) fn read_create(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("projectId", Presence::Required, IDENTIFIER)
        .text("title", Presence::Required, TITLE)
        .text("description", Presence::Nullish, LONG_TEXT);
    impact(&mut r);
    client_visible(&mut r);
    Some(r.strict())
}

/// `updateChangeRequestSchema`.
pub(crate) fn read_update(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("title", Presence::Optional, TITLE)
        .text("description", Presence::Nullish, LONG_TEXT);
    impact(&mut r);
    client_visible(&mut r);
    Some(r.strict())
}

/// `changeControlSettingsSchema`.
pub(crate) fn read_settings(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.number(
        "costLimit",
        Presence::Required,
        Number {
            coerce: false,
            int: false,
            min: Some(0.0),
            max: Some(9_999_999_999_999.0),
        },
    )
    .whole("scheduleLimitDays", Presence::Required, whole(0.0, 3_650.0));
    let ids = r.issues.list(
        r.fields,
        "boardMemberIds",
        Presence::Required,
        None,
        Some(50),
        |iss, item| iss.item_text(item, IDENTIFIER).map(Value::String),
    );
    r.keep("boardMemberIds", array_field(ids));
    Some(r.strict())
}

/// `listChangeRequestsQuerySchema`.
#[derive(Debug, Default)]
pub(crate) struct ListQuery {
    pub(crate) project_id: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) search: Option<String>,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<String>,
}

pub(crate) fn list_query(raw: Option<&str>) -> Result<ListQuery, Refusal> {
    read_query(raw, |issues, f| {
        let string = |issues: &mut Issues, key: &str| {
            issues
                .text_with(f, key, Presence::Optional, Text::default())
                .into_option()
        };
        ListQuery {
            project_id: string(issues, "projectId"),
            status: issues
                .choice(f, "status", Presence::Optional, &STATUSES)
                .into_option(),
            search: string(issues, "search"),
            cursor: string(issues, "cursor"),
            limit: string(issues, "limit"),
        }
    })
}

/// Present keys of a map (for the update's "was it sent").
pub(crate) fn has(body: &Map<String, Value>, key: &str) -> bool {
    body.contains_key(key)
}
