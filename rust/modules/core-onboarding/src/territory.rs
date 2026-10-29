//! Reseller territory (docs/plans/reseller-licensing.md): the request's
//! network country, the partner that serves it, the 409 that refuses a
//! direct workspace there, and the request a signup files with that partner
//! instead (`@weldsuite/core-domain/partners`, `services/partner/*`).

use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use serde::Serialize;
use weldsuite_db::PgPool;
use weldsuite_kit::ApiError;
use weldsuite_ports::{DynSystemMail, Mailbox, OutgoingMail};

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
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
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
) -> Result<Option<PartnerInfo>, sqlx::Error> {
    let Some(country) =
        country.filter(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_alphabetic()))
    else {
        return Ok(None);
    };
    sqlx::query_as(
        "select p.id, p.name, p.logo_url, p.website_url, p.support_email, p.support_url
           from partner_territories t
           join partners p on p.id = t.partner_id
          where t.country_code = $1
          limit 1",
    )
    .bind(country.to_ascii_uppercase())
    .fetch_optional(master)
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
) -> Result<Option<Response>, sqlx::Error> {
    let country = request_country(headers);
    let partner = territory_partner(master, country.as_deref()).await?;
    Ok(match (partner, country) {
        (Some(partner), Some(country)) => Some(territory_response(&country, &partner)),
        _ => None,
    })
}

/// `MAX_REQUESTS_PER_USER_PER_DAY`.
const MAX_REQUESTS_PER_USER_PER_DAY: i64 = 5;

/// Why `createWorkspaceRequest` failed.
#[derive(Debug)]
pub(crate) enum RequestError {
    /// `PartnerPortalError('RATE_LIMITED')`.
    RateLimited,
    Database(sqlx::Error),
}

impl From<sqlx::Error> for RequestError {
    fn from(error: sqlx::Error) -> Self {
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
    let recent: i64 = sqlx::query_scalar(
        "select count(*) from partner_workspace_requests
          where requester_user_id = $1 and created_at >= now() - interval '1 day'",
    )
    .bind(request.requester_user_id)
    .fetch_one(master)
    .await?;
    if recent >= MAX_REQUESTS_PER_USER_PER_DAY {
        return Err(RequestError::RateLimited);
    }
    let id = weldsuite_kit::generate_id("pwr");
    sqlx::query(
        "insert into partner_workspace_requests
           (id, partner_id, requester_user_id, requester_email, requester_name, company_name,
            country_code, selected_apps, message, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'new')",
    )
    .bind(&id)
    .bind(request.partner_id)
    .bind(request.requester_user_id)
    .bind(request.requester_email.trim().to_lowercase())
    .bind(request.requester_name)
    .bind(request.company_name)
    .bind(request.country_code.to_ascii_uppercase())
    .bind(sqlx::types::Json(request.selected_apps))
    .bind(request.message)
    .execute(master)
    .await?;
    Ok(id)
}

/// `partnerAdminEmails`: the partner's owners and admins.
pub(crate) async fn partner_admin_emails(
    master: &PgPool,
    partner_id: &str,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select email from partner_members where partner_id = $1 and role in ('owner', 'admin')",
    )
    .bind(partner_id)
    .fetch_all(master)
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
