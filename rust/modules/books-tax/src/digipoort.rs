//! Filing the BTW-aangifte and the Opgaaf ICP over Digipoort, when the
//! install has a connection (`BooksState::digipoort`, the EU and self-hosted
//! editions with a PKIoverheid certificate; `vat-digipoort`). Without one the
//! routes keep the worker's simulated submission ([`crate::filing`]).
//!
//! A delivery Digipoort took leaves the return `submitted` with Digipoort's
//! kenmerk as its filing reference. The Belastingdienst answers within two
//! working days: 500 accepts it (`accepted`), a failure refuses it
//! (`rejected`, the reason kept), and a rejected return can be corrected and
//! filed again. The statuses are read when someone asks
//! (`GET …/filing-status`) and by `weldsuite cron digipoort-status`
//! ([`poll_open_filings`]), which visits only workspaces the due index lists.

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_books_domain::http::{BooksState, Caller, Refusal};
use weldsuite_catalogs::entity_events::{EventName, VAT_RETURN_UPDATED};
use weldsuite_db::{orm, utc_timestamp};
use weldsuite_digipoort::status::{delivered_record, failed_record, next_poll, with_statuses};
use weldsuite_digipoort::{
    Assessment, Delivery, Digipoort, DigipoortError, Identity, Outcome, assess, profile,
};
use weldsuite_kit::ApiError;
use weldsuite_schema::tenant::{icp_declarations, vat_returns};

/// Which filing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Filing {
    VatReturn,
    IcpDeclaration,
}

impl Filing {
    pub(crate) fn berichtsoort(self) -> &'static str {
        match self {
            Self::VatReturn => profile::BERICHTSOORT_OB,
            Self::IcpDeclaration => profile::BERICHTSOORT_ICP,
        }
    }

    fn file_name(self) -> &'static str {
        match self {
            Self::VatReturn => "Omzetbelasting.xbrl",
            Self::IcpDeclaration => "OpgaafICP.xbrl",
        }
    }

    /// What the messages call it.
    fn label(self) -> &'static str {
        match self {
            Self::VatReturn => "BTW-aangifte",
            Self::IcpDeclaration => "Opgaaf ICP",
        }
    }
}

/// A delivery Digipoort took.
pub(crate) struct Delivered {
    pub kenmerk: String,
    /// The record the filing stores (`digipoortResponse`).
    pub stored: Value,
}

/// A delivery Digipoort refused or couldn't take: nothing was filed.
pub(crate) struct Refused {
    pub error: DigipoortError,
    pub stored: Value,
}

impl Refused {
    /// The 502 the route answers: Digipoort's reason, so the user can act.
    pub(crate) fn refusal(&self, filing: Filing) -> Refusal {
        let mut error = ApiError::bad_gateway().with_message(format!(
            "The {} was not filed: {}",
            filing.label(),
            self.error
        ));
        if let DigipoortError::Fault {
            code: Some(code), ..
        } = &self.error
        {
            error = error.with_details(json!({ "digipoortCode": code }));
        }
        error.into()
    }
}

/// `aanleveren` of the XBRL `xml` for the entity with omzetbelastingnummer
/// `vat_number`, with `reference` (the return's `OB-…` / `ICP-…`) as our
/// aanleverkenmerk.
pub(crate) async fn deliver(
    digipoort: &Digipoort,
    filing: Filing,
    vat_number: &str,
    reference: &str,
    xml: &str,
    now: OffsetDateTime,
) -> Result<Delivered, Refused> {
    let delivery = Delivery {
        berichtsoort: filing.berichtsoort().to_owned(),
        aanleverkenmerk: reference.chars().take(40).collect(),
        belanghebbende: Identity {
            number: weldsuite_digipoort::fiscal_number(vat_number),
            kind: profile::IDENTITY_FISCAL.to_owned(),
        },
        role: profile::ROLE_COMPANY.to_owned(),
        file_name: filing.file_name().to_owned(),
        mime_type: "application/xml".to_owned(),
        content: xml.as_bytes().to_vec(),
    };
    match digipoort.deliver(&delivery).await {
        Ok(delivered) => Ok(Delivered {
            stored: delivered_record(
                digipoort.mode(),
                filing.berichtsoort(),
                &delivery.aanleverkenmerk,
                &delivered,
                now,
            ),
            kenmerk: delivered.kenmerk,
        }),
        Err(error) => {
            tracing::warn!(%error, berichtsoort = filing.berichtsoort(), "books: Digipoort refused a filing");
            let stored = failed_record(digipoort.mode(), filing.berichtsoort(), &error, now);
            Err(Refused { error, stored })
        }
    }
}

/// Keep a refused attempt on the filing: its message and Digipoort's
/// answer. The status stays, so the user can correct and file again.
pub(crate) async fn record_refusal(
    db: &PgPool,
    filing: Filing,
    id: &str,
    stored: &Value,
    xml: &str,
) -> Result<(), Refusal> {
    let at = utc_timestamp(OffsetDateTime::now_utc());
    let result = match filing {
        Filing::VatReturn => {
            vat_returns::Entity::update_many()
                .col_expr(
                    vat_returns::Column::DigipoortResponse,
                    Expr::value(stored.clone()),
                )
                .col_expr(vat_returns::Column::XmlContent, Expr::value(xml))
                .col_expr(vat_returns::Column::UpdatedAt, Expr::value(at))
                .filter(vat_returns::Column::Id.eq(id))
                .exec(&orm(db))
                .await
        }
        Filing::IcpDeclaration => {
            icp_declarations::Entity::update_many()
                .col_expr(
                    icp_declarations::Column::DigipoortResponse,
                    Expr::value(stored.clone()),
                )
                .col_expr(icp_declarations::Column::XmlContent, Expr::value(xml))
                .col_expr(icp_declarations::Column::UpdatedAt, Expr::value(at))
                .filter(icp_declarations::Column::Id.eq(id))
                .exec(&orm(db))
                .await
        }
    };
    result
        .map(|_| ())
        .map_err(|e| Refusal::Internal(e.to_string()))
}

/// Put the caller's workspace in the due index, so
/// `weldsuite cron digipoort-status` reads the new delivery's statuses in
/// five minutes. Best effort: the status check in the app reads them too.
pub(crate) async fn watch_statuses(caller: &Caller, state: &BooksState) {
    if let Some(master) = caller.master(state) {
        weldsuite_db::due_index::mark_due(
            &master,
            weldsuite_digipoort::SWEEP_KIND,
            &caller.workspace_id,
            OffsetDateTime::now_utc() + time::Duration::minutes(5),
        )
        .await;
    }
}

/// Whether a filing's stored record is a real delivery (not the simulated
/// one an install without Digipoort records).
pub(crate) fn is_delivery(record: Option<&Value>) -> bool {
    record.is_some_and(|r| {
        r.get("simulated") == Some(&Value::Bool(false))
            && r.get("success") == Some(&Value::Bool(true))
    })
}

/// Once the delivery is final, the filing's new status.
fn settled_status(outcome: Outcome) -> Option<&'static str> {
    match outcome {
        Outcome::Accepted => Some("accepted"),
        Outcome::Rejected => Some("rejected"),
        _ => None,
    }
}

/// The statuses read once, applied to the filing.
pub(crate) struct Refreshed {
    pub assessment: Assessment,
    pub record: Value,
    /// `accepted` or `rejected` when this read settled it.
    pub settled: Option<&'static str>,
}

/// Read the delivery's statuses and store what they say: the record always,
/// `accepted` / `rejected` (with the time and the reason) once final.
pub(crate) async fn refresh(
    db: &PgPool,
    digipoort: &Digipoort,
    filing: Filing,
    id: &str,
    kenmerk: &str,
    record: &Value,
    now: OffsetDateTime,
) -> Result<Result<Refreshed, DigipoortError>, DbErr> {
    let statuses = match digipoort.statuses(kenmerk).await {
        Ok(statuses) => statuses,
        Err(error) => return Ok(Err(error)),
    };
    let assessment = assess(&statuses);
    let record = with_statuses(record, &statuses, &assessment, now);
    let settled = settled_status(assessment.outcome);
    let at = utc_timestamp(now);
    match filing {
        Filing::VatReturn => {
            let mut update = vat_returns::Entity::update_many()
                .col_expr(
                    vat_returns::Column::DigipoortResponse,
                    Expr::value(record.clone()),
                )
                .col_expr(vat_returns::Column::UpdatedAt, Expr::value(at));
            if let Some(status) = settled {
                update = update.col_expr(vat_returns::Column::Status, Expr::value(status));
                update = if status == "accepted" {
                    update.col_expr(vat_returns::Column::AcceptedAt, Expr::value(at))
                } else {
                    update
                        .col_expr(vat_returns::Column::RejectedAt, Expr::value(at))
                        .col_expr(
                            vat_returns::Column::RejectionReason,
                            Expr::value(assessment.reason.clone()),
                        )
                };
            }
            update
                .filter(vat_returns::Column::Id.eq(id))
                .filter(vat_returns::Column::Status.eq("submitted"))
                .exec(&orm(db))
                .await?;
        }
        Filing::IcpDeclaration => {
            let mut update = icp_declarations::Entity::update_many()
                .col_expr(
                    icp_declarations::Column::DigipoortResponse,
                    Expr::value(record.clone()),
                )
                .col_expr(icp_declarations::Column::UpdatedAt, Expr::value(at));
            if let Some(status) = settled {
                update = update.col_expr(icp_declarations::Column::Status, Expr::value(status));
                update = if status == "accepted" {
                    update.col_expr(icp_declarations::Column::AcceptedAt, Expr::value(at))
                } else {
                    update
                        .col_expr(icp_declarations::Column::RejectedAt, Expr::value(at))
                        .col_expr(
                            icp_declarations::Column::RejectionReason,
                            Expr::value(assessment.reason.clone()),
                        )
                };
            }
            update
                .filter(icp_declarations::Column::Id.eq(id))
                .filter(icp_declarations::Column::Status.eq("submitted"))
                .exec(&orm(db))
                .await?;
        }
    }
    Ok(Ok(Refreshed {
        assessment,
        record,
        settled,
    }))
}

/// The `GET …/filing-status` body of a real delivery.
pub(crate) fn status_body(
    id: &str,
    kenmerk: &str,
    read: &Result<Refreshed, DigipoortError>,
    now: OffsetDateTime,
) -> Value {
    match read {
        Ok(refreshed) => json!({
            "id": id,
            "kenmerk": kenmerk,
            "success": true,
            "simulated": false,
            "status": refreshed.assessment.outcome.as_str(),
            "statusCode": refreshed.assessment.code,
            "statusDescription": refreshed.assessment.description,
            "reason": refreshed.assessment.reason,
            "statuses": refreshed.record.get("statuses").cloned().unwrap_or(Value::Array(Vec::new())),
            "timestamp": weldsuite_digipoort::status::iso(now),
        }),
        Err(error) => json!({
            "id": id,
            "kenmerk": kenmerk,
            "success": false,
            "simulated": false,
            "status": "unknown",
            "error": error.to_string(),
            "timestamp": weldsuite_digipoort::status::iso(now),
        }),
    }
}

/// What one workspace's poll did.
#[derive(Debug, Default)]
pub struct PollSummary {
    /// Deliveries whose statuses were read.
    pub checked: usize,
    /// The events to publish for the filings that settled (`vat_return`
    /// `updated`, as the routes publish for an ICP declaration too).
    pub settled: Vec<(EventName, String, Value)>,
    /// Reads that failed (Digipoort unreachable or refusing).
    pub failed: usize,
    /// When the earliest open delivery is due again; `None` when none is.
    pub next_due: Option<OffsetDateTime>,
}

/// An open delivery: id, kenmerk, record, when it was filed.
type Open = (String, String, Value, Option<OffsetDateTime>);

fn open_vat_returns(rows: Vec<vat_returns::Model>) -> Vec<Open> {
    rows.into_iter()
        .filter(|row| is_delivery(row.digipoort_response.as_ref()))
        .filter_map(|row| {
            let kenmerk = row.filing_reference.filter(|k| !k.is_empty())?;
            Some((
                row.id,
                kenmerk,
                row.digipoort_response.unwrap_or(Value::Null),
                row.filed_at.map(time::PrimitiveDateTime::assume_utc),
            ))
        })
        .collect()
}

fn open_icp_declarations(rows: Vec<icp_declarations::Model>) -> Vec<Open> {
    rows.into_iter()
        .filter(|row| is_delivery(row.digipoort_response.as_ref()))
        .filter_map(|row| {
            let kenmerk = row.filing_reference.filter(|k| !k.is_empty())?;
            Some((
                row.id,
                kenmerk,
                row.digipoort_response.unwrap_or(Value::Null),
                row.filed_at.map(time::PrimitiveDateTime::assume_utc),
            ))
        })
        .collect()
}

/// The workspace's open VAT and ICP deliveries, each read once: what
/// `weldsuite cron digipoort-status` does in a tenant. A delivery older than
/// [`next_poll`]'s cut-off is left alone (it needs a person: the status check
/// in the app still reads it).
pub async fn poll_open_filings(
    db: &PgPool,
    digipoort: &Digipoort,
    now: OffsetDateTime,
) -> Result<PollSummary, DbErr> {
    let conn = orm(db);
    let vat = vat_returns::Entity::find()
        .filter(vat_returns::Column::Status.eq("submitted"))
        .filter(vat_returns::Column::DeletedAt.is_null())
        .all(&conn)
        .await?;
    let icp = icp_declarations::Entity::find()
        .filter(icp_declarations::Column::Status.eq("submitted"))
        .filter(icp_declarations::Column::DeletedAt.is_null())
        .all(&conn)
        .await?;
    let mut summary = PollSummary::default();
    let open = open_vat_returns(vat)
        .into_iter()
        .map(|o| (Filing::VatReturn, o))
        .chain(
            open_icp_declarations(icp)
                .into_iter()
                .map(|o| (Filing::IcpDeclaration, o)),
        );
    for (filing, (id, kenmerk, record, filed_at)) in open {
        let filed_at = filed_at.unwrap_or(now);
        let Some(next) = next_poll(filed_at, now) else {
            continue;
        };
        summary.checked += 1;
        match refresh(db, digipoort, filing, &id, &kenmerk, &record, now).await? {
            Ok(refreshed) => {
                if let Some(status) = refreshed.settled {
                    let data = match filing {
                        Filing::VatReturn => json!({ "id": id, "status": status }),
                        Filing::IcpDeclaration => {
                            json!({ "id": id, "kind": "icp", "status": status })
                        }
                    };
                    summary.settled.push((VAT_RETURN_UPDATED, id, data));
                    continue;
                }
            }
            Err(error) => {
                summary.failed += 1;
                tracing::warn!(%error, filing = id, "digipoort-status: statuses not read");
            }
        }
        summary.next_due = Some(summary.next_due.map_or(next, |due| due.min(next)));
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_deliveries_from_simulations() {
        assert!(is_delivery(Some(
            &json!({ "success": true, "simulated": false })
        )));
        assert!(!is_delivery(Some(
            &json!({ "success": true, "simulated": true })
        )));
        assert!(!is_delivery(Some(
            &json!({ "success": false, "simulated": false })
        )));
        assert!(!is_delivery(None));
        assert_eq!(settled_status(Outcome::Accepted), Some("accepted"));
        assert_eq!(settled_status(Outcome::Processing), None);
        assert_eq!(Filing::IcpDeclaration.berichtsoort(), "ICP");
    }

    #[test]
    fn answers_a_failed_read_as_unknown() {
        let now = time::macros::datetime!(2026-11-22 10:00 UTC);
        let body = status_body(
            "vat_1",
            "k",
            &Err(DigipoortError::Http { status: 503 }),
            now,
        );
        assert_eq!(body["status"], "unknown");
        assert_eq!(body["success"], false);
        assert_eq!(body["error"], "Digipoort answered HTTP 503");
    }
}
