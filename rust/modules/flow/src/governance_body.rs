//! The request schemas of `/api/project-decisions`, `/api/project-deliverables`,
//! `/api/project-scope` and `/api/project-benefits`
//! (`@weldsuite/app-api-client/schemas/project-governance`), read the way Zod
//! reads them: the fields in the schema's order, each with Zod's issue, and
//! `.strict()` objects refusing any other key. The failure answers are
//! `raid_body`'s (`Invalid request body` / `Invalid query parameters`).

use serde_json::{Map, Value};
use weldsuite_flow_domain::benefit_metrics::BENEFIT_METRICS;
use weldsuite_flow_domain::benefits::BENEFIT_STATUSES;
use weldsuite_flow_domain::decisions::DECISION_STATUSES;
use weldsuite_flow_domain::deliverables::DELIVERABLE_STATUSES;
use weldsuite_flow_domain::scope::SCOPE_LINK_TYPES;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};

use crate::raid_body::{
    Body, IDENTIFIER, LONG_TEXT, Reader, TITLE, iso_date_time, read_query, whole,
};
use crate::{Query, Refusal};

/// `z.string().trim().min(min).max(max)`.
const fn trimmed(min: usize, max: usize) -> Text {
    Text::trimmed(Some(min), Some(max))
}

/// `metricValue`: `z.number().finite().min(-999_999_999_999).max(999_999_999_999)`.
const METRIC_VALUE: Number = Number {
    coerce: false,
    int: false,
    min: Some(-999_999_999_999.0),
    max: Some(999_999_999_999.0),
};

/// An array of objects, each read by `read` into its Zod output (strict).
fn objects(
    r: &mut Reader<'_>,
    key: &'static str,
    presence: Presence,
    max: usize,
    read: impl Fn(&mut Reader<'_>),
) {
    let field: Field<Vec<Value>> =
        r.issues
            .list(r.fields, key, presence, None, Some(max), |issues, item| {
                let fields = issues.object(item)?;
                let mut item = Reader::over(issues, fields);
                read(&mut item);
                Some(Value::Object(item.strict()))
            });
    r.keep(key, field);
}

/// An array of strings, each `z.string().trim().min(1).max(max_len)`.
fn strings(r: &mut Reader<'_>, key: &'static str, presence: Presence, max: usize, max_len: usize) {
    let field: Field<Vec<Value>> =
        r.issues
            .list(r.fields, key, presence, None, Some(max), |issues, item| {
                issues
                    .item_text(item, trimmed(1, max_len))
                    .map(Value::String)
            });
    r.keep(key, field);
}

fn boolean(r: &mut Reader<'_>, key: &'static str, presence: Presence) {
    let field = r.issues.boolean(r.fields, key, presence);
    r.keep(key, field);
}

// ── Decisions ───────────────────────────────────────────────────────────────

/// `decisionOptionSchema` items.
fn read_option(item: &mut Reader<'_>) {
    item.text("title", Presence::Required, trimmed(1, 255))
        .text("note", Presence::Nullish, Text::trimmed(None, Some(2_000)));
    boolean(item, "chosen", Presence::Optional);
}

/// `createDecisionSchema`.
pub(crate) fn read_create_decision(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("projectId", Presence::Required, IDENTIFIER)
        .text("title", Presence::Required, TITLE)
        .text("context", Presence::Nullish, LONG_TEXT);
    objects(&mut r, "options", Presence::Optional, 20, read_option);
    strings(&mut r, "consequences", Presence::Optional, 50, 1_000);
    r.choice("status", Presence::Optional, &["proposed", "decided"])
        .text("deciderId", Presence::Nullish, IDENTIFIER)
        .text("decisionDueAt", Presence::Nullish, iso_date_time())
        .text("decidedBy", Presence::Nullish, IDENTIFIER)
        .text("decidedAt", Presence::Nullish, iso_date_time());
    Some(r.strict())
}

/// `updateDecisionSchema`.
pub(crate) fn read_update_decision(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("title", Presence::Optional, TITLE)
        .text("context", Presence::Nullish, LONG_TEXT);
    objects(&mut r, "options", Presence::Optional, 20, read_option);
    strings(&mut r, "consequences", Presence::Optional, 50, 1_000);
    r.text("deciderId", Presence::Nullish, IDENTIFIER).text(
        "decisionDueAt",
        Presence::Nullish,
        iso_date_time(),
    );
    Some(r.strict())
}

/// `decideDecisionSchema`.
pub(crate) fn read_decide(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.whole("chosenIndex", Presence::Optional, whole(0.0, 19.0))
        .text("decidedBy", Presence::Optional, IDENTIFIER)
        .text("decidedAt", Presence::Optional, iso_date_time());
    Some(r.strict())
}

/// `supersedeDecisionSchema`.
pub(crate) fn read_supersede(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("supersededById", Presence::Required, IDENTIFIER);
    Some(r.strict())
}

// ── Deliverables ────────────────────────────────────────────────────────────

/// `acceptanceCriterionInputSchema` items.
fn read_criterion(item: &mut Reader<'_>) {
    item.text("text", Presence::Required, trimmed(1, 1_000));
    boolean(item, "met", Presence::Optional);
}

/// `deliverableFields`, in the schema's order.
fn read_deliverable_fields(r: &mut Reader<'_>) {
    r.text("description", Presence::Nullish, LONG_TEXT)
        .text("ownerId", Presence::Nullish, IDENTIFIER)
        .text("plannedStart", Presence::Nullish, iso_date_time())
        .text("plannedEnd", Presence::Nullish, iso_date_time());
    objects(
        r,
        "acceptanceCriteria",
        Presence::Optional,
        50,
        read_criterion,
    );
    boolean(r, "clientVisible", Presence::Optional);
    r.whole("position", Presence::Optional, whole(0.0, 100_000.0));
}

/// `createDeliverableSchema`.
pub(crate) fn read_create_deliverable(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("projectId", Presence::Required, IDENTIFIER)
        .text("title", Presence::Required, TITLE)
        .choice(
            "status",
            Presence::Optional,
            &["not_started", "in_progress"],
        );
    read_deliverable_fields(&mut r);
    Some(r.strict())
}

/// `updateDeliverableSchema`.
pub(crate) fn read_update_deliverable(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("title", Presence::Optional, TITLE).choice(
        "status",
        Presence::Optional,
        &["not_started", "in_progress"],
    );
    read_deliverable_fields(&mut r);
    Some(r.strict())
}

/// `requestSignoffSchema`.
pub(crate) fn read_request_signoff(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("contactId", Presence::Optional, IDENTIFIER).text(
        "dueAt",
        Presence::Optional,
        iso_date_time(),
    );
    Some(r.strict())
}

/// `rejectDeliverableSchema`.
pub(crate) fn read_reject_deliverable(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("note", Presence::Optional, Text::trimmed(None, Some(2_000)));
    Some(r.strict())
}

// ── Scope ───────────────────────────────────────────────────────────────────

/// `outOfScopeItemInputSchema` items.
fn read_out_of_scope(item: &mut Reader<'_>) {
    item.text("text", Presence::Required, trimmed(1, 1_000))
        .text(
            "reason",
            Presence::Nullish,
            Text::trimmed(None, Some(1_000)),
        )
        .choice("linkType", Presence::Nullish, &SCOPE_LINK_TYPES)
        .text("linkId", Presence::Nullish, IDENTIFIER);
}

/// `putScopeSchema`.
pub(crate) fn read_put_scope(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("statement", Presence::Nullish, LONG_TEXT);
    strings(&mut r, "inScope", Presence::Optional, 200, 1_000);
    objects(
        &mut r,
        "outOfScope",
        Presence::Optional,
        200,
        read_out_of_scope,
    );
    Some(r.strict())
}

// ── Benefits ────────────────────────────────────────────────────────────────

/// `benefitFields`, in the schema's order.
fn read_benefit_fields(r: &mut Reader<'_>) {
    r.text("description", Presence::Nullish, LONG_TEXT)
        .text("ownerId", Presence::Nullish, IDENTIFIER)
        .text("goalRef", Presence::Nullish, IDENTIFIER)
        .choice("metric", Presence::Optional, &BENEFIT_METRICS)
        .record("metricParams", Presence::Optional)
        .text("unit", Presence::Nullish, Text::trimmed(None, Some(30)))
        .number("baselineValue", Presence::Nullish, METRIC_VALUE)
        .number("targetValue", Presence::Nullish, METRIC_VALUE)
        .text("realiseBy", Presence::Nullish, iso_date_time());
}

/// `createBenefitSchema`.
pub(crate) fn read_create_benefit(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("projectId", Presence::Required, IDENTIFIER)
        .text("title", Presence::Required, TITLE)
        .choice("status", Presence::Optional, &["planned", "measuring"]);
    read_benefit_fields(&mut r);
    Some(r.strict())
}

/// `updateBenefitSchema`.
pub(crate) fn read_update_benefit(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("title", Presence::Optional, TITLE).choice(
        "status",
        Presence::Optional,
        &BENEFIT_STATUSES,
    );
    read_benefit_fields(&mut r);
    Some(r.strict())
}

/// `periodSchema`: `YYYY-MM`.
fn period_matches(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 7
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && matches!(
            &text[5..],
            "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12"
        )
}

/// `createMeasurementSchema`.
pub(crate) fn read_create_measurement(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    let period = r.issues.pattern(
        r.fields,
        "period",
        Presence::Required,
        None,
        None,
        period_matches,
        "period must be a month, YYYY-MM",
    );
    r.keep("period", period);
    r.number("value", Presence::Required, METRIC_VALUE);
    Some(r.strict())
}

// ── Queries ─────────────────────────────────────────────────────────────────

/// A list query of the registers: the project, a status (one of `statuses`),
/// a search term, the cursor and the limit.
#[derive(Debug, Default)]
pub(crate) struct RegisterQuery {
    pub(crate) project_id: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) search: Option<String>,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<String>,
}

fn register_query(raw: Option<&str>, statuses: &[&str]) -> Result<RegisterQuery, Refusal> {
    read_query(raw, |issues, f| {
        let string = |issues: &mut Issues, key: &str| {
            issues
                .text_with(f, key, Presence::Optional, Text::default())
                .into_option()
        };
        RegisterQuery {
            project_id: string(issues, "projectId"),
            status: issues
                .choice(f, "status", Presence::Optional, statuses)
                .into_option(),
            search: string(issues, "search"),
            cursor: string(issues, "cursor"),
            limit: string(issues, "limit"),
        }
    })
}

/// `listQuerySchema` of `GET /api/project-decisions`.
pub(crate) fn decision_list_query(raw: Option<&str>) -> Result<RegisterQuery, Refusal> {
    register_query(raw, &DECISION_STATUSES)
}

/// `listQuerySchema` of `GET /api/project-deliverables`.
pub(crate) fn deliverable_list_query(raw: Option<&str>) -> Result<RegisterQuery, Refusal> {
    register_query(raw, &DELIVERABLE_STATUSES)
}

/// `listQuerySchema` of `GET /api/project-benefits`.
pub(crate) fn benefit_list_query(raw: Option<&str>) -> Result<RegisterQuery, Refusal> {
    register_query(raw, &BENEFIT_STATUSES)
}

/// `goalTargetsQuerySchema`: the project (`z.string().min(1)`, required).
pub(crate) fn goal_targets_query(raw: Option<&str>) -> Result<String, Refusal> {
    read_query(raw, |issues, f| {
        issues
            .text_with(
                f,
                "projectId",
                Presence::Required,
                Text::length(Some(1), None),
            )
            .into_option()
            .unwrap_or_default()
    })
}

/// `Query` is kept in scope for the callers that read raw values.
#[allow(dead_code)]
type RawQuery = Query;

/// The keys of a body that were sent (`!== undefined`), for the edit rules.
pub(crate) fn sent(body: &Map<String, Value>) -> Vec<&str> {
    body.keys().map(String::as_str).collect()
}

#[cfg(test)]
mod tests {
    use axum::body::Bytes;
    use serde_json::json;

    use super::*;
    use crate::raid_body::parse_body;

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

    fn details(result: Result<impl std::fmt::Debug, Refusal>) -> Value {
        refused(result)["error"]["details"].clone()
    }

    fn paths(details: &Value) -> Vec<&str> {
        details
            .as_array()
            .expect("details")
            .iter()
            .filter_map(|issue| issue["path"].as_str())
            .collect()
    }

    #[test]
    fn a_decision_reads_its_options_and_trims_its_text() {
        let input = parse_body(
            &body(&json!({
                "projectId": "p", "title": " Keep it ", "context": null,
                "options": [{ "title": " A ", "note": null }, { "title": "B", "chosen": true }],
                "consequences": [" One "], "status": "proposed", "deciderId": "u1",
                "decisionDueAt": "2026-11-06T00:00:00Z",
            })),
            read_create_decision,
        )
        .expect("valid");
        assert_eq!(
            Value::Object(input),
            json!({
                "projectId": "p", "title": "Keep it", "context": null,
                "options": [{ "title": "A", "note": null }, { "title": "B", "chosen": true }],
                "consequences": ["One"], "status": "proposed", "deciderId": "u1",
                "decisionDueAt": "2026-11-06T00:00:00Z",
            })
        );
    }

    #[test]
    fn a_decision_refuses_what_its_schema_refuses() {
        let answer = details(parse_body(
            &body(
                &json!({ "projectId": "p", "title": "x", "status": "superseded", "extra": 1,
                "options": [{ "title": "", "chosen": "yes", "other": true }] }),
            ),
            read_create_decision,
        ));
        let found = paths(&answer);
        for expected in [
            "status",
            "options.0.title",
            "options.0.chosen",
            "options.0",
            "",
        ] {
            assert!(found.contains(&expected), "{expected} in {found:?}");
        }
        let answer = details(parse_body(
            &body(&json!({ "projectId": "p", "title": "x", "consequences": [""] })),
            read_create_decision,
        ));
        assert_eq!(answer[0]["path"], "consequences.0");
        let answer = details(parse_body(
            &body(&json!({ "supersededById": "" })),
            read_supersede,
        ));
        assert_eq!(answer[0]["path"], "supersededById");
        let answer = details(parse_body(
            &body(&json!({ "chosenIndex": 20 })),
            read_decide,
        ));
        assert_eq!(
            answer[0]["message"],
            "Number must be less than or equal to 19"
        );
    }

    #[test]
    fn a_deliverable_reads_criteria_and_dates() {
        let input = parse_body(
            &body(&json!({
                "projectId": "p", "title": "Login", "status": "in_progress",
                "plannedStart": "2026-11-01T00:00:00+01:00", "position": 3,
                "acceptanceCriteria": [{ "text": " Works ", "met": true }, { "text": "Resets" }],
                "clientVisible": true,
            })),
            read_create_deliverable,
        )
        .expect("valid");
        assert_eq!(
            input["acceptanceCriteria"],
            json!([{ "text": "Works", "met": true }, { "text": "Resets" }])
        );
        let answer = details(parse_body(
            &body(
                &json!({ "projectId": "p", "title": "x", "status": "accepted",
                "plannedEnd": "tomorrow", "position": -1 }),
            ),
            read_create_deliverable,
        ));
        assert_eq!(paths(&answer), ["status", "plannedEnd", "position"]);
        // Accepting is not a PATCH either.
        let answer = details(parse_body(
            &body(&json!({ "status": "accepted" })),
            read_update_deliverable,
        ));
        assert_eq!(answer[0]["path"], "status");
    }

    #[test]
    fn a_scope_reads_lists_and_links() {
        let input = parse_body(
            &body(&json!({
                "statement": null, "inScope": [" Ordering "],
                "outOfScope": [{ "text": "Reporting", "reason": " R2 ", "linkType": "decision", "linkId": "dec_1" }],
            })),
            read_put_scope,
        )
        .expect("valid");
        assert_eq!(input["inScope"], json!(["Ordering"]));
        assert_eq!(input["outOfScope"][0]["reason"], "R2");
        let answer = details(parse_body(
            &body(&json!({ "outOfScope": [{ "text": "x", "linkType": "task" }] })),
            read_put_scope,
        ));
        assert_eq!(answer[0]["path"], "outOfScope.0.linkType");
    }

    #[test]
    fn a_benefit_reads_its_numbers_and_metric() {
        let input = parse_body(
            &body(&json!({
                "projectId": "p", "title": "Fewer tickets", "metric": "desk_tickets_by_tag",
                "metricParams": { "tag": "order status" }, "baselineValue": 1150, "targetValue": 400.5,
                "unit": " tickets ", "realiseBy": "2027-06-30T00:00:00Z",
            })),
            read_create_benefit,
        )
        .expect("valid");
        assert_eq!(input["unit"], "tickets");
        assert_eq!(input["targetValue"], 400.5);
        let answer = details(parse_body(
            &body(&json!({ "projectId": "p", "title": "x", "metric": "magic",
                "baselineValue": 1_000_000_000_000_i64, "status": "realised" })),
            read_create_benefit,
        ));
        assert_eq!(paths(&answer), ["status", "metric", "baselineValue"]);
        assert!(parse_body(&body(&json!({ "status": "closed" })), read_update_benefit).is_ok());
    }

    #[test]
    fn a_measurement_wants_a_month_and_a_value() {
        assert!(
            parse_body(
                &body(&json!({ "period": "2026-10", "value": -3.25 })),
                read_create_measurement
            )
            .is_ok()
        );
        for period in [
            "2026-13",
            "2026-00",
            "2026-1",
            "26-10",
            "2026-10-01",
            "abcd-ef",
        ] {
            let answer = details(parse_body(
                &body(&json!({ "period": period, "value": 1 })),
                read_create_measurement,
            ));
            assert_eq!(
                answer[0]["message"], "period must be a month, YYYY-MM",
                "{period}"
            );
        }
        let answer = details(parse_body(
            &body(&json!({ "period": "2026-10" })),
            read_create_measurement,
        ));
        assert_eq!(answer[0]["path"], "value");
    }

    #[test]
    fn the_queries_check_their_statuses() {
        let q = decision_list_query(Some("projectId=p&status=decided&limit=5")).expect("valid");
        assert_eq!(q.status.as_deref(), Some("decided"));
        assert_eq!(q.limit.as_deref(), Some("5"));
        assert_eq!(
            refused(decision_list_query(Some("status=nonsense")))["error"]["message"],
            "Invalid query parameters"
        );
        assert!(benefit_list_query(Some("status=at_risk")).is_ok());
        assert!(deliverable_list_query(Some("status=accepted&projectId=")).is_ok());
        assert_eq!(
            goal_targets_query(Some("projectId=prj_1&x=1")).expect("valid"),
            "prj_1"
        );
        assert_eq!(
            refused(goal_targets_query(Some("projectId=")))["error"]["message"],
            "Invalid query parameters"
        );
    }
}
