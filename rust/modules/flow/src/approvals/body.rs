//! The request schemas of `/api/approvals`
//! (`@weldsuite/app-api-client/schemas/flow-approvals`), read the way Zod reads
//! them (see `raid_body`).

use serde_json::Value;
use weldsuite_kit::validation::{Issues, Presence, Text};

use crate::Refusal;
use crate::raid_body::{Body, IDENTIFIER, Reader, iso_date_time, read_query};

pub(crate) const REVIEW_TYPES: [&str; 8] = [
    "change_request",
    "gate",
    "deliverable",
    "decision",
    "risk_acceptance",
    "project_request",
    "project_close",
    "timesheet",
];
const APPROVAL_ANSWERS: [&str; 4] = [
    "approved",
    "approved_with_conditions",
    "rejected",
    "info_requested",
];

/// `decideApprovalSchema`.
pub(crate) fn read_decide(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.choice("decision", Presence::Required, &APPROVAL_ANSWERS)
        .text("note", Presence::Nullish, Text::length(None, Some(5_000)));
    Some(r.strict())
}

/// `createDelegationSchema`.
pub(crate) fn read_delegation(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("delegateId", Presence::Required, IDENTIFIER)
        .text("startsAt", Presence::Required, iso_date_time())
        .text("endsAt", Presence::Required, iso_date_time());
    Some(r.strict())
}

/// `setSponsorSchema`.
pub(crate) fn read_sponsor(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("sponsorId", Presence::Nullable, IDENTIFIER);
    Some(r.strict())
}

/// `listMyReviewsQuerySchema`: the type and the project.
pub(crate) fn mine_query(raw: Option<&str>) -> Result<(Option<String>, Option<String>), Refusal> {
    read_query(raw, |issues, f| {
        let review_type = issues
            .choice(f, "type", Presence::Optional, &REVIEW_TYPES)
            .into_option();
        let project = issues
            .text_with(f, "projectId", Presence::Optional, Text::default())
            .into_option();
        (review_type, project)
    })
}

/// `listReviewsQuerySchema` (`/sent` and `/done`).
#[derive(Debug, Default)]
pub(crate) struct PageQuery {
    pub(crate) review_type: Option<String>,
    pub(crate) project_id: Option<String>,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<String>,
}

pub(crate) fn page_query(raw: Option<&str>) -> Result<PageQuery, Refusal> {
    read_query(raw, |issues, f| {
        let string = |issues: &mut Issues, key: &str| {
            issues
                .text_with(f, key, Presence::Optional, Text::default())
                .into_option()
        };
        PageQuery {
            review_type: issues
                .choice(f, "type", Presence::Optional, &REVIEW_TYPES)
                .into_option(),
            project_id: string(issues, "projectId"),
            cursor: string(issues, "cursor"),
            limit: string(issues, "limit"),
        }
    })
}
