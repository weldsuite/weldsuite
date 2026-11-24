//! Reseller territory (weldsuite-documentation/plans/reseller-licensing.md): the request's
//! network country, the partner that serves it, the 409 that refuses a
//! direct workspace there, and the request a signup files with that partner
//! instead (`@weldsuite/core-domain/partners`, `services/partner/*`).

use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, FromQueryResult, JoinType, PaginatorTrait,
    QueryFilter, QuerySelect,
};
use serde::Serialize;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::ApiError;
use weldsuite_ports::{DynSystemMail, Mailbox, OutgoingMail};
use weldsuite_schema::master::{
    partner_members, partner_territories, partner_workspace_requests, partners,
};

/// `normalizeCountryCode`: ISO-2, upper case; Cloudflare's `XX` (unknown)
/// and `T1` (Tor) are no country.
pub(crate) fn normalize_country_code(value: Option<&str>) -> Option<String> {
    let code = value.unwrap_or_default().trim().to_uppercase();
    if code == "XX" || code == "T1" {
        return None;
    }
    is_country_code(&code).then_some(code)
}

/// `countryCodeSchema`: `^[A-Z]{2}$`.
pub(crate) fn is_country_code(code: &str) -> bool {
    code.len() == 2 && code.bytes().all(|b| b.is_ascii_uppercase())
}

/// `requestCountry`: the network country of the request, from the
/// `CF-IPCountry` header (the Kubernetes editions have no `request.cf`; an
/// ingress that geolocates can set the same header).
pub(crate) fn request_country(headers: &HeaderMap) -> Option<String> {
    normalize_country_code(
        headers
            .get("cf-ipcountry")
            .and_then(|value| value.to_str().ok()),
    )
}

/// `PartnerPublicInfo`: what a signup sees about a reseller.
#[derive(Debug, Clone, Serialize, FromQueryResult)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PartnerInfo {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) logo_url: Option<String>,
    pub(crate) website_url: Option<String>,
    pub(crate) support_email: Option<String>,
    pub(crate) support_url: Option<String>,
}

/// `territoryPartnerInfo`: the partner serving `country`, `None` when the
/// country is open for direct signup.
pub(crate) async fn territory_partner(
    master: &PgPool,
    country: Option<&str>,
) -> Result<Option<PartnerInfo>, DbErr> {
    let Some(country) =
        country.filter(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_alphabetic()))
    else {
        return Ok(None);
    };
    partner_territories::Entity::find()
        .select_only()
        .columns([
            partners::Column::Id,
            partners::Column::Name,
            partners::Column::LogoUrl,
            partners::Column::WebsiteUrl,
            partners::Column::SupportEmail,
            partners::Column::SupportUrl,
        ])
        .join(
            JoinType::InnerJoin,
            partner_territories::Entity::belongs_to(partners::Entity)
                .from(partner_territories::Column::PartnerId)
                .to(partners::Column::Id)
                .into(),
        )
        .filter(partner_territories::Column::CountryCode.eq(country.to_ascii_uppercase()))
        .into_model::<PartnerInfo>()
        .one(&orm(master))
        .await
}

#[derive(Serialize)]
struct TerritoryDetails<'a> {
    country: &'a str,
    partner: &'a PartnerInfo,
}

/// `partnerTerritoryResponse`: 409 `PARTNER_TERRITORY`.
pub(crate) fn territory_response(country: &str, partner: &PartnerInfo) -> Response {
    ApiError::new(
        StatusCode::CONFLICT,
        "PARTNER_TERRITORY",
        format!("WeldSuite in {country} is provided by {}.", partner.name),
    )
    .with_details(TerritoryDetails { country, partner })
    .into_response()
}

/// The 409 when the request's country is a reseller's, `None` otherwise.
pub(crate) async fn territory_refusal(
    master: &PgPool,
    headers: &HeaderMap,
) -> Result<Option<Response>, DbErr> {
    let country = request_country(headers);
    let partner = territory_partner(master, country.as_deref()).await?;
    Ok(match (partner, country) {
        (Some(partner), Some(country)) => Some(territory_response(&country, &partner)),
        _ => None,
    })
}

/// `MAX_REQUESTS_PER_USER_PER_DAY`.
const MAX_REQUESTS_PER_USER_PER_DAY: u64 = 5;

/// Why `createWorkspaceRequest` failed.
#[derive(Debug)]
pub(crate) enum RequestError {
    /// `PartnerPortalError('RATE_LIMITED')`.
    RateLimited,
    Database(DbErr),
}

impl From<DbErr> for RequestError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

/// A territory request from a signup.
pub(crate) struct WorkspaceRequest<'a> {
    pub(crate) partner_id: &'a str,
    pub(crate) requester_user_id: &'a str,
    pub(crate) requester_email: &'a str,
    pub(crate) requester_name: Option<&'a str>,
    pub(crate) company_name: &'a str,
    pub(crate) country_code: &'a str,
    pub(crate) selected_apps: &'a [String],
    pub(crate) message: Option<&'a str>,
}

/// `createWorkspaceRequest`: at most five a day per signed-in user.
pub(crate) async fn create_workspace_request(
    master: &PgPool,
    request: &WorkspaceRequest<'_>,
) -> Result<String, RequestError> {
    use partner_workspace_requests::{ActiveModel, Column, Entity};
    use sea_orm::ExprTrait as _;
    let db = orm(master);
    // `created_at >= now() - interval '1 day'`.
    let since = Expr::current_timestamp().sub(Expr::val("1 day").cast_as("interval"));
    let recent = Entity::find()
        .filter(Column::RequesterUserId.eq(request.requester_user_id))
        .filter(Expr::col((Entity, Column::CreatedAt)).gte(since))
        .count(&db)
        .await?;
    if recent >= MAX_REQUESTS_PER_USER_PER_DAY {
        return Err(RequestError::RateLimited);
    }
    let id = weldsuite_kit::generate_id("pwr");
    Entity::insert(ActiveModel {
        id: Set(id.clone()),
        partner_id: Set(request.partner_id.to_owned()),
        requester_user_id: Set(Some(request.requester_user_id.to_owned())),
        requester_email: Set(request.requester_email.trim().to_lowercase()),
        requester_name: Set(request.requester_name.map(str::to_owned)),
        company_name: Set(request.company_name.to_owned()),
        country_code: Set(request.country_code.to_ascii_uppercase()),
        selected_apps: Set(serde_json::json!(request.selected_apps)),
        message: Set(request.message.map(str::to_owned)),
        status: Set("new".to_owned()),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await?;
    Ok(id)
}

/// `partnerAdminEmails`: the partner's owners and admins.
pub(crate) async fn partner_admin_emails(
    master: &PgPool,
    partner_id: &str,
) -> Result<Vec<String>, DbErr> {
    partner_members::Entity::find()
        .select_only()
        .column(partner_members::Column::Email)
        .filter(partner_members::Column::PartnerId.eq(partner_id))
        .filter(partner_members::Column::Role.is_in(["owner", "admin"]))
        .into_tuple()
        .all(&orm(master))
        .await
}

/// The "new workspace request" notice (`sendWorkspaceRequestEmail`): plain
/// text, as the workers send it (there is no partner template yet), through
/// the system mail transport.
pub(crate) struct RequestNotice {
    pub(crate) to: Vec<String>,
    pub(crate) partner_name: String,
    pub(crate) company_name: String,
    pub(crate) country_code: String,
    pub(crate) requester_email: String,
    pub(crate) requester_name: Option<String>,
    pub(crate) selected_apps: Vec<String>,
    pub(crate) message: Option<String>,
    /// `PARTNER_PORTAL_URL`, default `https://partner.weldsuite.org`.
    pub(crate) portal_url: String,
    /// `SYSTEM_EMAIL_FROM`, default `notifications@mail.weldsuite.org`.
    pub(crate) from: String,
}

impl RequestNotice {
    fn subject(&self) -> String {
        let subject = format!(
            "New workspace request for {}: {}",
            self.partner_name, self.company_name
        );
        subject
            .split(['\r', '\n'])
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_owned()
    }

    fn text(&self) -> String {
        let contact = match &self.requester_name {
            Some(name) => format!("{name} <{}>", self.requester_email),
            None => self.requester_email.clone(),
        };
        let mut lines = vec![
            format!(
                "{} asked for a WeldSuite workspace in {}.",
                self.company_name, self.country_code
            ),
            String::new(),
            format!("Contact: {contact}"),
        ];
        if !self.selected_apps.is_empty() {
            lines.push(format!("Apps: {}", self.selected_apps.join(", ")));
        }
        if let Some(message) = self.message.as_deref().filter(|m| !m.is_empty()) {
            lines.push(String::new());
            lines.push(message.to_owned());
        }
        lines.push(String::new());
        lines.push(format!(
            "Review it in the partner portal: {}/requests",
            self.portal_url.trim_end_matches('/')
        ));
        lines.join("\n")
    }

    /// Send it; a failure is logged, never answered.
    pub(crate) async fn send(self, mail: &dyn DynSystemMail) {
        if self.to.is_empty() {
            return;
        }
        let text = self.text();
        let html = format!(
            "<pre style=\"font-family:inherit;white-space:pre-wrap\">{}</pre>",
            escape_html(&text)
        );
        let outgoing = OutgoingMail {
            from: Mailbox::new(self.from.clone()).named("WeldSuite"),
            to: self.to.iter().map(Mailbox::new).collect(),
            cc: Vec::new(),
            bcc: Vec::new(),
            reply_to: None,
            subject: self.subject(),
            html,
            text,
            attachments: Vec::new(),
            headers: Vec::new(),
        };
        if let Err(error) = mail.send_boxed(outgoing).await {
            tracing::error!(%error, "onboarding: partner request notification failed");
        }
    }
}

fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn countries_are_iso_two_letter_codes() {
        assert_eq!(normalize_country_code(Some(" br ")).as_deref(), Some("BR"));
        assert_eq!(normalize_country_code(Some("XX")), None);
        assert_eq!(normalize_country_code(Some("t1")), None);
        assert_eq!(normalize_country_code(Some("BRA")), None);
        assert_eq!(normalize_country_code(None), None);
        let mut headers = HeaderMap::new();
        headers.insert("CF-IPCountry", "nl".parse().expect("header"));
        assert_eq!(request_country(&headers).as_deref(), Some("NL"));
    }

    #[test]
    fn the_notice_reads_like_the_workers() {
        let notice = RequestNotice {
            to: vec!["a@p.test".to_owned()],
            partner_name: "Acme".to_owned(),
            company_name: "Customer\nBV".to_owned(),
            country_code: "BR".to_owned(),
            requester_email: "ana@c.test".to_owned(),
            requester_name: Some("Ana".to_owned()),
            selected_apps: vec!["crm".to_owned(), "welddesk".to_owned()],
            message: Some("Call me".to_owned()),
            portal_url: "https://partner.test/".to_owned(),
            from: "n@m.test".to_owned(),
        };
        assert_eq!(
            notice.subject(),
            "New workspace request for Acme: Customer BV"
        );
        assert_eq!(
            notice.text(),
            "Customer\nBV asked for a WeldSuite workspace in BR.\n\nContact: Ana <ana@c.test>\n\
             Apps: crm, welddesk\n\nCall me\n\nReview it in the partner portal: https://partner.test/requests"
        );
    }
}
