//! Staff cases (`outbound/cases.ts`): one row in master
//! `outbound_mail_cases` per trigger and subject per day (a dedupe key keeps
//! repeats out). The alert email goes out from mail-api's 5-minute sweep,
//! not from here.

use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::Set, DbErr, EntityTrait};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::master::outbound_mail_cases;

use super::clock::day_stamp;
use super::ledger_core::{CaseSeverity, LedgerSubject, TemplateSummary};
use super::policy_store::{OutboundEvent, record_outbound_event};
use crate::text::utf16_prefix;

/// `OpenCaseInput`.
#[derive(Debug, Clone)]
pub struct OpenCase {
    /// `None` for the platform.
    pub subject: Option<LedgerSubject>,
    /// `OutboundCaseTrigger`.
    pub trigger: String,
    pub severity: CaseSeverity,
    pub summary: String,
    pub risk_score: Option<i64>,
    pub state: Option<String>,
    pub template: Option<TemplateSummary>,
    /// In insertion order.
    pub metrics: Vec<(String, Value)>,
}

fn subject_id(subject: Option<&LedgerSubject>) -> String {
    match subject {
        None => "platform".to_owned(),
        Some(LedgerSubject::Workspace { workspace_id, .. }) => workspace_id.clone(),
        Some(LedgerSubject::Personal {
            personal_account_id,
            ..
        }) => format!("personal:{personal_account_id}"),
    }
}

/// `openOutboundCase(env, input)`: the new case id, or `None` for a repeat or
/// a failure. Never fails.
pub async fn open_outbound_case(db: &PgPool, input: &OpenCase, now_ms: i64) -> Option<String> {
    match insert_case(db, input, now_ms).await {
        Ok(id) => id,
        Err(error) => {
            tracing::error!(%error, "[outbound] Failed to open case");
            None
        }
    }
}

#[allow(clippy::too_many_lines)] // one insert, column for column, then the trail
async fn insert_case(db: &PgPool, input: &OpenCase, now_ms: i64) -> Result<Option<String>, DbErr> {
    let fingerprint = input.template.as_ref().map(|t| t.fingerprint.clone());
    let dedupe: String = [
        subject_id(input.subject.as_ref()),
        input.trigger.clone(),
        fingerprint.clone().unwrap_or_else(|| "-".to_owned()),
        day_stamp(now_ms),
    ]
    .join(":");
    let dedupe_key = utf16_prefix(&dedupe, 200).to_owned();
    let id = generate_id("obcase");
    let verdict = input
        .template
        .as_ref()
        .and_then(|t| t.verdict.as_ref())
        .map(|v| {
            json!({
                "category": v.category,
                "unsolicited": v.unsolicited,
                "confidence": v.confidence,
                "signals": v.signals,
                "modelId": v.model_id,
                "reviewedAt": v.reviewed_at,
            })
        });
    let mut metrics = Map::new();
    metrics.insert("summary".to_owned(), Value::from(input.summary.clone()));
    if let Some(state) = input.state.as_deref().filter(|s| !s.is_empty()) {
        metrics.insert("state".to_owned(), Value::from(state));
    }
    if let Some(template) = &input.template {
        metrics.insert(
            "firstContactRecipients".to_owned(),
            Value::from(template.first_contact_recipients),
        );
    }
    for (key, value) in &input.metrics {
        metrics.insert(key.clone(), value.clone());
    }
    let (workspace, personal) = match &input.subject {
        Some(LedgerSubject::Workspace { workspace_id, .. }) => (Some(workspace_id.as_str()), None),
        Some(LedgerSubject::Personal {
            personal_account_id,
            ..
        }) => (None, Some(personal_account_id.as_str())),
        None => (None, None),
    };
    let template = input.template.as_ref();
    let case = outbound_mail_cases::ActiveModel {
        id: Set(id.clone()),
        workspace_id: Set(workspace.map(str::to_owned)),
        personal_account_id: Set(personal.map(str::to_owned)),
        trigger: Set(input.trigger.clone()),
        severity: Set(input.severity.as_str().to_owned()),
        fingerprint: Set(fingerprint),
        ai_verdict: Set(verdict),
        risk_score: Set(input
            .risk_score
            .map(|s| i32::try_from(s).unwrap_or(i32::MAX))),
        snippet: Set(template.map(|t| utf16_prefix(&t.snippet, 300).to_owned())),
        subject: Set(template.map(|t| utf16_prefix(&t.subject, 300).to_owned())),
        sample_domains: Set(template.map(|t| json!(t.domains))),
        sources: Set(template.map(|t| json!(t.sources))),
        metrics: Set(Value::Object(metrics)),
        dedupe_key: Set(dedupe_key),
        ..Default::default()
    };
    // `on conflict (dedupe_key) do nothing returning id`: a repeat inserts
    // nothing.
    let inserted = outbound_mail_cases::Entity::insert(case)
        .on_conflict(
            OnConflict::column(outbound_mail_cases::Column::DedupeKey)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(&orm(db))
        .await?;
    let inserted = (inserted > 0).then_some(id);
    let Some(case_id) = inserted else {
        return Ok(None);
    };
    if let Some(subject) = &input.subject {
        record_outbound_event(
            db,
            Some(subject),
            &OutboundEvent {
                kind: "case_opened",
                from_value: None,
                to_value: Some(input.trigger.clone()),
                reason: Some(input.summary.clone()),
                actor: "system".to_owned(),
                details: Some(json!({ "caseId": case_id, "severity": input.severity.as_str() })),
            },
        )
        .await;
    }
    Ok(Some(case_id))
}
