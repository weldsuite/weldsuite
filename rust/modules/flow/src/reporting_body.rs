//! The request schemas of `/api/project-status-reports` and
//! `/api/project-stakeholders` (`@weldsuite/app-api-client/schemas/project-reporting`),
//! read the way Zod reads them: the fields in the schema's order, each with
//! Zod's issue, top-level objects `.strict()` and nested ones stripping
//! unknown keys.

use serde_json::{Map, Value};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};

use crate::Refusal;
use crate::raid_body::{Body, IDENTIFIER, Reader, iso_date_time, read_query, whole};

pub(crate) const OVERRIDE_COLOURS: [&str; 3] = ["green", "amber", "red"];
const AREAS: [&str; 5] = ["schedule", "budget", "scope", "risk", "benefits"];
const STATUSES: [&str; 2] = ["draft", "published"];
const CADENCES: [&str; 3] = ["weekly", "biweekly", "monthly"];
const RULES: [&str; 3] = ["sponsor", "all_stakeholders", "portal_contacts"];
const ATTITUDES: [&str; 3] = ["supportive", "neutral", "resistant"];
const ENGAGEMENT: [&str; 5] = ["unaware", "resistant", "neutral", "supportive", "leading"];
const SUBJECT_TYPES: [&str; 3] = ["deliverable", "change_requests", "go_live"];
const LETTERS: [&str; 4] = ["R", "A", "C", "I"];

const PERIOD_MESSAGE: &str = "period must be an ISO week (2026-W45) or a month (2026-11)";

/// `STATUS_REPORT_PERIOD_PATTERN`.
pub(crate) fn period_matches(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() < 7 || !bytes[..4].iter().all(u8::is_ascii_digit) || bytes[4] != b'-' {
        return false;
    }
    let rest = &text[5..];
    let two = |s: &str| -> Option<u32> {
        (s.len() == 2 && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse().ok())
            .flatten()
    };
    if let Some(week) = rest.strip_prefix('W') {
        return two(week).is_some_and(|w| (1..=53).contains(&w));
    }
    two(rest).is_some_and(|m| (1..=12).contains(&m))
}

fn value<T: Into<Value>>(field: Field<T>) -> Option<Value> {
    match field {
        Field::Set(v) => Some(v.into()),
        Field::Null => Some(Value::Null),
        Field::Absent => None,
    }
}

fn object(entries: Vec<(&str, Option<Value>)>) -> Value {
    let mut map = Map::new();
    for (key, entry) in entries {
        if let Some(entry) = entry {
            map.insert(key.to_owned(), entry);
        }
    }
    Value::Object(map)
}

/// A list of identifiers (`z.array(identifier).max(200)`).
fn identifiers(issues: &mut Issues, map: &Map<String, Value>, key: &str) -> Field<Vec<Value>> {
    issues.list(map, key, Presence::Optional, None, Some(200), |i, item| {
        i.item_text(item, IDENTIFIER).map(Value::from)
    })
}

fn long_text(max: usize) -> Text {
    Text::length(None, Some(max))
}

// ── Status reports ──────────────────────────────────────────────────────────

/// `listStatusReportsQuerySchema`.
#[derive(Debug, Default)]
pub(crate) struct ReportListQuery {
    pub(crate) project_id: String,
    pub(crate) status: Option<String>,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<String>,
}

pub(crate) fn report_list_query(raw: Option<&str>) -> Result<ReportListQuery, Refusal> {
    read_query(raw, |issues, f| ReportListQuery {
        project_id: issues
            .text_with(f, "projectId", Presence::Required, IDENTIFIER)
            .into_option()
            .unwrap_or_default(),
        status: issues
            .choice(f, "status", Presence::Optional, &STATUSES)
            .into_option(),
        cursor: issues
            .text_with(f, "cursor", Presence::Optional, Text::default())
            .into_option(),
        limit: issues
            .text_with(f, "limit", Presence::Optional, Text::default())
            .into_option(),
    })
}

/// `createStatusReportSchema`.
pub(crate) fn read_create_report(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("projectId", Presence::Required, IDENTIFIER);
    let period = r.issues.pattern(
        r.fields,
        "period",
        Presence::Optional,
        None,
        None,
        period_matches,
        PERIOD_MESSAGE,
    );
    r.keep("period", period);
    Some(r.strict())
}

fn read_item(issues: &mut Issues, item: &Value) -> Option<Value> {
    let map = issues.object(item)?;
    let task_id = issues.text_with(map, "taskId", Presence::Nullish, IDENTIFIER);
    let text = issues.text_with(
        map,
        "text",
        Presence::Required,
        Text::trimmed(Some(1), Some(500)),
    );
    let code = issues.text_with(map, "code", Presence::Nullish, long_text(30));
    let date = issues.text_with(map, "date", Presence::Nullish, iso_date_time());
    Some(object(vec![
        ("taskId", value(task_id)),
        ("text", value(text)),
        ("code", value(code)),
        ("date", value(date)),
    ]))
}

fn read_area(issues: &mut Issues, item: &Value) -> Option<Value> {
    let map = issues.object(item)?;
    let key = issues.choice(map, "key", Presence::Required, &AREAS);
    let override_ = issues.nested(map, "override", Presence::Nullable, |i, m| {
        let colour = i.choice(m, "colour", Presence::Required, &OVERRIDE_COLOURS);
        let reason = i.text_with(
            m,
            "reason",
            Presence::Required,
            Text::trimmed(Some(1), Some(1_000)),
        );
        object(vec![("colour", value(colour)), ("reason", value(reason))])
    });
    Some(object(vec![
        ("key", value(key)),
        ("override", value(override_)),
    ]))
}

/// `updateStatusReportSchema`.
pub(crate) fn read_update_report(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text(
        "summary",
        Presence::Nullish,
        Text::trimmed(None, Some(10_000)),
    );
    r.choice("overall", Presence::Optional, &OVERRIDE_COLOURS);
    let areas = r.issues.list(
        r.fields,
        "areas",
        Presence::Optional,
        None,
        Some(5),
        read_area,
    );
    r.keep("areas", areas);
    let done = r.issues.list(
        r.fields,
        "done",
        Presence::Optional,
        None,
        Some(50),
        read_item,
    );
    r.keep("done", done);
    let next = r.issues.list(
        r.fields,
        "next",
        Presence::Optional,
        None,
        Some(50),
        read_item,
    );
    r.keep("next", next);
    let client_visible = r
        .issues
        .boolean(r.fields, "clientVisible", Presence::Optional);
    r.keep("clientVisible", client_visible);
    let recipients = r
        .issues
        .nested(r.fields, "recipients", Presence::Nullish, |i, m| {
            object(vec![(
                "stakeholderIds",
                value(identifiers(i, m, "stakeholderIds")),
            )])
        });
    r.keep("recipients", recipients);
    Some(r.strict())
}

/// `putStatusReportSettingsSchema`.
pub(crate) fn read_put_settings(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    let status_report = r
        .issues
        .nested(r.fields, "statusReport", Presence::Nullish, |i, m| {
            let cadence = i.choice(m, "cadence", Presence::Required, &CADENCES);
            let weekday = i.whole_number(m, "weekday", Presence::Required, whole(1.0, 7.0));
            let hour = i.whole_number(m, "hour", Presence::Required, whole(0.0, 23.0));
            let recipients = i.nested(m, "recipients", Presence::Required, |i, rm| {
                let ids = identifiers(i, rm, "stakeholderIds");
                let rule = i.choice(rm, "rule", Presence::Optional, &RULES);
                object(vec![("stakeholderIds", value(ids)), ("rule", value(rule))])
            });
            object(vec![
                ("cadence", value(cadence)),
                ("weekday", value(weekday)),
                ("hour", value(hour)),
                ("recipients", value(recipients)),
            ])
        });
    r.keep("statusReport", status_report);
    r.whole("riskAppetite", Presence::Optional, whole(1.0, 25.0));
    Some(r.strict())
}

// ── Stakeholders ────────────────────────────────────────────────────────────

/// `listStakeholdersQuerySchema`.
#[derive(Debug, Default)]
pub(crate) struct StakeholderListQuery {
    pub(crate) project_id: String,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<String>,
}

pub(crate) fn stakeholder_list_query(raw: Option<&str>) -> Result<StakeholderListQuery, Refusal> {
    read_query(raw, |issues, f| StakeholderListQuery {
        project_id: issues
            .text_with(f, "projectId", Presence::Required, IDENTIFIER)
            .into_option()
            .unwrap_or_default(),
        cursor: issues
            .text_with(f, "cursor", Presence::Optional, Text::default())
            .into_option(),
        limit: issues
            .text_with(f, "limit", Presence::Optional, Text::default())
            .into_option(),
    })
}

/// `stakeholderFields`.
fn read_stakeholder_fields(r: &mut Reader<'_>) {
    r.text(
        "organisation",
        Presence::Nullish,
        Text::trimmed(None, Some(255)),
    )
    .text("role", Presence::Nullish, Text::trimmed(None, Some(100)))
    .whole("influence", Presence::Optional, whole(1.0, 5.0))
    .whole("interest", Presence::Optional, whole(1.0, 5.0))
    .choice("attitude", Presence::Optional, &ATTITUDES)
    .choice("engagement", Presence::Optional, &ENGAGEMENT)
    .text("notes", Presence::Nullish, long_text(10_000))
    .text("lastContactAt", Presence::Nullish, iso_date_time());
}

/// `createStakeholderSchema`.
pub(crate) fn read_create_stakeholder(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("projectId", Presence::Required, IDENTIFIER)
        .text("memberId", Presence::Nullish, IDENTIFIER)
        .text("crmContactId", Presence::Nullish, IDENTIFIER);
    read_stakeholder_fields(&mut r);
    Some(r.strict())
}

/// `updateStakeholderSchema`.
pub(crate) fn read_update_stakeholder(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    read_stakeholder_fields(&mut r);
    Some(r.strict())
}

fn read_assignment(issues: &mut Issues, item: &Value) -> Option<Value> {
    let map = issues.object(item)?;
    let id = issues.text_with(map, "stakeholderId", Presence::Required, IDENTIFIER);
    let letter = issues.choice(map, "letter", Presence::Required, &LETTERS);
    Some(object(vec![
        ("stakeholderId", value(id)),
        ("letter", value(letter)),
    ]))
}

/// `putRaciSchema`.
pub(crate) fn read_put_raci(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.choice("subjectType", Presence::Required, &SUBJECT_TYPES)
        .text("subjectId", Presence::Nullish, IDENTIFIER);
    let assignments = r.issues.list(
        r.fields,
        "assignments",
        Presence::Required,
        None,
        Some(200),
        read_assignment,
    );
    r.keep("assignments", assignments);
    Some(r.strict())
}

fn read_plan_entry(issues: &mut Issues, item: &Value) -> Option<Value> {
    let map = issues.object(item)?;
    let mut read = |key: &str, max: usize| {
        value(issues.text_with(
            map,
            key,
            Presence::Required,
            Text::trimmed(Some(1), Some(max)),
        ))
    };
    let what = read("what", 255);
    let audience = read("audience", 500);
    let cadence = read("cadence", 100);
    let channel = read("channel", 255);
    Some(object(vec![
        ("what", what),
        ("audience", audience),
        ("cadence", cadence),
        ("channel", channel),
    ]))
}

/// `putCommunicationPlanSchema`.
pub(crate) fn read_put_plan(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    let plan = r.issues.list(
        r.fields,
        "communicationPlan",
        Presence::Required,
        None,
        Some(50),
        read_plan_entry,
    );
    r.keep("communicationPlan", plan);
    Some(r.strict())
}

#[cfg(test)]
mod tests {
    use axum::body::Bytes;
    use serde_json::json;

    use super::*;
    use crate::raid_body::parse_body;

    fn body(value: &Value) -> Bytes {
        Bytes::from(value.to_string())
    }

    fn details(result: Result<Body, Refusal>) -> Value {
        let Err(Refusal::Response(response)) = result else {
            panic!("expected a refusal, got {result:?}");
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime");
        let bytes = runtime
            .block_on(axum::body::to_bytes(response.into_body(), usize::MAX))
            .expect("body");
        let answer: Value = serde_json::from_slice(&bytes).expect("json");
        answer["error"]["details"].clone()
    }

    #[test]
    fn periods() {
        for ok in [
            "2026-W45", "2026-W01", "2026-W53", "2026-11", "2026-01", "2026-12",
        ] {
            assert!(period_matches(ok), "{ok}");
        }
        for bad in [
            "2026-W54",
            "2026-W00",
            "2026-13",
            "2026-00",
            "next week",
            "2026-W5",
            "2026-1",
        ] {
            assert!(!period_matches(bad), "{bad}");
        }
    }

    #[test]
    fn create_report_reads_the_period() {
        let out = parse_body(
            &body(&json!({ "projectId": "p", "period": "2026-W45" })),
            read_create_report,
        )
        .expect("valid");
        assert_eq!(
            Value::Object(out),
            json!({ "projectId": "p", "period": "2026-W45" })
        );
        let bad = parse_body(
            &body(&json!({ "projectId": "p", "period": "next week" })),
            read_create_report,
        );
        assert_eq!(
            details(bad),
            json!([{ "path": "period", "message": PERIOD_MESSAGE }])
        );
        let extra = parse_body(
            &body(&json!({ "projectId": "p", "extra": 1 })),
            read_create_report,
        );
        assert_eq!(
            details(extra),
            json!([{ "path": "", "message": "Unrecognized key(s) in object: 'extra'" }])
        );
    }

    #[test]
    fn update_report_reads_nested_lists() {
        let out = parse_body(
            &body(&json!({
                "summary": "  Fine.  ",
                "areas": [{ "key": "scope", "override": { "colour": "red", "reason": " Stuck " } },
                          { "key": "risk", "override": null }],
                "done": [{ "text": " Called ", "date": "2026-11-03T08:00:00Z" }],
                "recipients": null,
            })),
            read_update_report,
        )
        .expect("valid");
        assert_eq!(out["summary"], "Fine.");
        assert_eq!(out["areas"][0]["override"]["reason"], "Stuck");
        assert_eq!(out["areas"][1]["override"], Value::Null);
        assert_eq!(out["done"][0]["text"], "Called");
        assert_eq!(out["recipients"], Value::Null);
        let bad = parse_body(
            &body(
                &json!({ "areas": [{ "key": "weather", "override": { "colour": "red", "reason": "" } }] }),
            ),
            read_update_report,
        );
        assert_eq!(
            details(bad),
            json!([
                { "path": "areas.0.key", "message": "Invalid enum value. Expected 'schedule' | 'budget' | 'scope' | 'risk' | 'benefits', received 'weather'" },
                { "path": "areas.0.override.reason", "message": "String must contain at least 1 character(s)" },
            ])
        );
    }

    #[test]
    fn settings_and_stakeholders() {
        let bad = parse_body(
            &body(
                &json!({ "statusReport": { "cadence": "daily", "weekday": 8, "hour": 24, "recipients": {} }, "riskAppetite": 26 }),
            ),
            read_put_settings,
        );
        assert_eq!(
            details(bad),
            json!([
                { "path": "statusReport.cadence", "message": "Invalid enum value. Expected 'weekly' | 'biweekly' | 'monthly', received 'daily'" },
                { "path": "statusReport.weekday", "message": "Number must be less than or equal to 7" },
                { "path": "statusReport.hour", "message": "Number must be less than or equal to 23" },
                { "path": "riskAppetite", "message": "Number must be less than or equal to 25" },
            ])
        );
        let off =
            parse_body(&body(&json!({ "statusReport": null })), read_put_settings).expect("valid");
        assert_eq!(off["statusReport"], Value::Null);
        let create = parse_body(
            &body(&json!({ "projectId": "p", "memberId": "u", "influence": 6 })),
            read_create_stakeholder,
        );
        assert_eq!(
            details(create),
            json!([{ "path": "influence", "message": "Number must be less than or equal to 5" }])
        );
        let raci = parse_body(
            &body(
                &json!({ "subjectType": "go_live", "assignments": [{ "stakeholderId": "s", "letter": "X" }] }),
            ),
            read_put_raci,
        );
        assert_eq!(
            details(raci),
            json!([{ "path": "assignments.0.letter", "message": "Invalid enum value. Expected 'R' | 'A' | 'C' | 'I', received 'X'" }])
        );
        let plan = parse_body(
            &body(
                &json!({ "communicationPlan": [{ "what": "", "audience": "x", "cadence": "x", "channel": "x" }] }),
            ),
            read_put_plan,
        );
        assert_eq!(
            details(plan),
            json!([{ "path": "communicationPlan.0.what", "message": "String must contain at least 1 character(s)" }])
        );
    }

    #[test]
    fn queries() {
        let q = report_list_query(Some("projectId=p&status=draft&limit=2")).expect("valid");
        assert_eq!(
            (
                q.project_id.as_str(),
                q.status.as_deref(),
                q.limit.as_deref()
            ),
            ("p", Some("draft"), Some("2"))
        );
        assert!(report_list_query(Some("")).is_err());
        assert!(report_list_query(Some("projectId=p&status=sent")).is_err());
        assert!(stakeholder_list_query(Some("projectId=")).is_err());
    }
}
