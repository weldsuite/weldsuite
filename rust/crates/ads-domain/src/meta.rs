//! Meta's Marketing API and OAuth (`@weldsuite/meta-ads`): the Graph API
//! calls the WeldAds routes make, with the same URLs, parameters (in the same
//! order), bodies and error messages, so the calls compare equal in
//! conformance and an `Error`'s message reaches the client unchanged.

use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_core_domain::js::{self, Js};
use weldsuite_events::iso_timestamp;
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::AdsError;

/// `https://graph.facebook.com/v21.0`.
pub const GRAPH_BASE: &str = "https://graph.facebook.com/v21.0";
/// The OAuth dialog.
pub const OAUTH_BASE: &str = "https://www.facebook.com/v21.0/dialog/oauth";
/// `META_ADS_SCOPES`: read, business management, then management.
pub const META_ADS_SCOPES: [&str; 3] = ["ads_read", "business_management", "ads_management"];

const CAMPAIGN_FIELDS: &str = "id,name,status,objective,daily_budget,lifetime_budget";
const INSIGHT_FIELDS: &str =
    "campaign_id,spend,impressions,clicks,ctr,cpc,reach,date_start,date_stop";

/// `new URLSearchParams(pairs).toString()`.
fn search_params(pairs: &[(&str, &str)]) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}

/// JavaScript truthiness of a field (`row.status ? … : undefined`).
pub fn truthy(value: Option<&Js>) -> bool {
    match value {
        None | Some(Js::Null) => false,
        Some(Js::Bool(flag)) => *flag,
        Some(Js::Number(number)) => *number != 0.0 && !number.is_nan(),
        Some(Js::String(text)) => !text.is_empty(),
        Some(Js::Array(_) | Js::Object(_)) => true,
    }
}

/// `value != null`.
fn present(value: Option<&Js>) -> bool {
    !matches!(value, None | Some(Js::Null))
}

/// `Number(value)`.
fn js_number_of(value: &Js) -> f64 {
    match value {
        Js::Null => 0.0,
        Js::Bool(flag) => f64::from(u8::from(*flag)),
        Js::Number(number) => *number,
        Js::String(text) => weldsuite_kit::validation::js_number(text),
        Js::Array(_) => weldsuite_kit::validation::js_number(&js::js_string(value)),
        Js::Object(_) => f64::NAN,
    }
}

/// `asText(value)`, `undefined` included.
fn as_text(value: Option<&Js>) -> String {
    value.map_or_else(|| "undefined".to_owned(), js::as_text)
}

/// `String(value)`, `undefined` included.
fn js_string(value: Option<&Js>) -> String {
    value.map_or_else(|| "undefined".to_owned(), js::js_string)
}

/// `act_<id>`, as Meta's account endpoints want it.
pub fn normalize_account_id(platform_account_id: &str) -> String {
    if platform_account_id.starts_with("act_") {
        platform_account_id.to_owned()
    } else {
        format!("act_{platform_account_id}")
    }
}

/// One answer: whether it was a 2xx, its status, and the body as `res.json()`
/// reads it.
struct Reply {
    ok: bool,
    status: u16,
    json: Result<Js, AdsError>,
}

impl Reply {
    /// `res.json()`: the body, or the `SyntaxError` it throws.
    fn json(self) -> Result<(bool, u16, Js), AdsError> {
        let json = self.json?;
        Ok((self.ok, self.status, json))
    }
}

async fn send(http: &OutboundHttp, request: HttpRequest) -> Result<Reply, AdsError> {
    let response = http.send(request).await.map_err(|error| {
        tracing::warn!(%error, "[meta-ads] request failed");
        AdsError::message("fetch failed")
    })?;
    let json = if response.body.is_empty() {
        Err(AdsError::message("Unexpected end of JSON input"))
    } else {
        serde_json::from_slice::<Js>(&response.body).map_err(|_| {
            AdsError::message(format!(
                "Unexpected token in JSON: {} is not valid JSON",
                response.text()
            ))
        })
    };
    Ok(Reply {
        ok: response.ok(),
        status: response.status,
        json,
    })
}

/// `json.error?.message ?? fallback`, as the message of an `Error`.
fn error_message(json: &Js, fallback: impl FnOnce() -> String) -> String {
    if matches!(json, Js::Null) {
        return "Cannot read properties of null (reading 'error')".to_owned();
    }
    match json.get("error").and_then(|error| error.get("message")) {
        Some(message) if present(Some(message)) => js::js_string(message),
        _ => fallback(),
    }
}

// ── OAuth ───────────────────────────────────────────────────────────────────

/// `buildAuthorizeUrl({ appId, redirectUri, state })`.
pub fn build_authorize_url(app_id: &str, redirect_uri: &str, state: &str) -> String {
    let scope = META_ADS_SCOPES.join(",");
    let query = search_params(&[
        ("client_id", app_id),
        ("redirect_uri", redirect_uri),
        ("response_type", "code"),
        ("state", state),
        ("scope", &scope),
    ]);
    format!("{OAUTH_BASE}?{query}")
}

/// An exchanged token (`parseTokenResponse`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub access_token: String,
    /// `toISOString()` of when it expires, when Meta said.
    pub expires_at: Option<String>,
}

/// `new Date(millis).toISOString()`, or the `RangeError` an invalid date throws.
fn iso_from_millis(millis: f64) -> Result<String, AdsError> {
    let invalid = || AdsError::message("Invalid time value");
    if !millis.is_finite() || millis.abs() > 8.64e15 {
        return Err(invalid());
    }
    #[allow(clippy::cast_possible_truncation)]
    let nanos = (millis.trunc() as i128) * 1_000_000;
    let at = OffsetDateTime::from_unix_timestamp_nanos(nanos).map_err(|_| invalid())?;
    Ok(iso_timestamp(at))
}

fn parse_token_response(json: &Js) -> Result<Token, AdsError> {
    if !truthy(json.get("access_token")) {
        return Err(AdsError::message(error_message(json, || {
            "No access token in Meta response".to_owned()
        })));
    }
    let expires_at = if truthy(json.get("expires_in")) {
        #[allow(clippy::cast_precision_loss)]
        let now = (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as f64;
        let seconds = json.get("expires_in").map_or(f64::NAN, js_number_of);
        Some(iso_from_millis(now + seconds * 1000.0)?)
    } else {
        None
    };
    Ok(Token {
        access_token: js_string(json.get("access_token")),
        expires_at,
    })
}

async fn token_call(
    http: &OutboundHttp,
    params: &[(&str, &str)],
    failure: &str,
) -> Result<Token, AdsError> {
    let url = format!("{GRAPH_BASE}/oauth/access_token?{}", search_params(params));
    let (ok, status, json) = send(http, HttpRequest::empty("GET", url)).await?.json()?;
    if !ok {
        return Err(AdsError::message(error_message(&json, || {
            format!("{failure} ({status})")
        })));
    }
    parse_token_response(&json)
}

/// `exchangeCodeForTokens`: the authorization code for a short-lived token.
pub async fn exchange_code_for_tokens(
    http: &OutboundHttp,
    app_id: &str,
    app_secret: &str,
    redirect_uri: &str,
    code: &str,
) -> Result<Token, AdsError> {
    token_call(
        http,
        &[
            ("client_id", app_id),
            ("client_secret", app_secret),
            ("redirect_uri", redirect_uri),
            ("code", code),
        ],
        "Token exchange failed",
    )
    .await
}

/// `exchangeForLongLivedToken`: a short-lived token for a long-lived one.
pub async fn exchange_for_long_lived_token(
    http: &OutboundHttp,
    app_id: &str,
    app_secret: &str,
    short_lived_token: &str,
) -> Result<Token, AdsError> {
    token_call(
        http,
        &[
            ("grant_type", "fb_exchange_token"),
            ("client_id", app_id),
            ("client_secret", app_secret),
            ("fb_exchange_token", short_lived_token),
        ],
        "Long-lived exchange failed",
    )
    .await
}

/// The person who connected (`getMetaUserProfile`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetaProfile {
    pub id: String,
    pub name: String,
}

/// `getMetaUserProfile(accessToken)`.
pub async fn get_meta_user_profile(
    http: &OutboundHttp,
    access_token: &str,
) -> Result<MetaProfile, AdsError> {
    let query = search_params(&[("fields", "id,name"), ("access_token", access_token)]);
    let url = format!("{GRAPH_BASE}/me?{query}");
    let (ok, _, json) = send(http, HttpRequest::empty("GET", url)).await?.json()?;
    if !ok || !truthy(json.get("id")) {
        return Err(AdsError::message(error_message(&json, || {
            "Failed to load Meta user profile".to_owned()
        })));
    }
    let id = js_string(json.get("id"));
    let name = match json.get("name") {
        Some(name) if present(Some(name)) => js::js_string(name),
        _ => id.clone(),
    };
    Ok(MetaProfile { id, name })
}

// ── Marketing API ───────────────────────────────────────────────────────────

/// An ad account Meta lists (`MetaAdAccount`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetaAdAccount {
    pub platform_account_id: String,
    pub name: String,
    pub currency: Option<String>,
    pub timezone: Option<String>,
    pub status: Option<String>,
}

/// A campaign's last-30-day insights, in `mapMetricsRow`'s key order
/// (`spend` … `dateEnd`), the keys Meta left out left out.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Metrics(pub Vec<(&'static str, String)>);

impl Metrics {
    fn to_js(&self) -> Js {
        Js::Object(
            self.0
                .iter()
                .map(|(key, value)| ((*key).to_owned(), Js::String(value.clone())))
                .collect(),
        )
    }

    /// The `jsonb` value written to `ad_campaigns.metrics`.
    pub fn to_value(&self) -> Value {
        self.to_js().to_value()
    }
}

/// A campaign as Meta reports it (`MetaCampaign`).
#[derive(Debug, Clone, PartialEq)]
pub struct MetaCampaign {
    pub platform_campaign_id: String,
    pub name: String,
    pub status: Option<String>,
    pub objective: Option<String>,
    /// `Number(row.daily_budget)`: Meta sends minor units as text.
    pub daily_budget: Option<f64>,
    pub lifetime_budget: Option<f64>,
    pub metrics: Option<Metrics>,
}

/// What a campaign's content hash covers (`hashCampaignPayload`).
#[derive(Debug, Clone, Copy)]
pub struct CampaignContent<'a> {
    pub name: &'a str,
    pub status: Option<&'a str>,
    pub objective: Option<&'a str>,
    pub daily_budget: Option<f64>,
    pub lifetime_budget: Option<f64>,
    pub metrics: Option<&'a Metrics>,
}

impl<'a> From<&'a MetaCampaign> for CampaignContent<'a> {
    fn from(campaign: &'a MetaCampaign) -> Self {
        Self {
            name: &campaign.name,
            status: campaign.status.as_deref(),
            objective: campaign.objective.as_deref(),
            daily_budget: campaign.daily_budget,
            lifetime_budget: campaign.lifetime_budget,
            metrics: campaign.metrics.as_ref(),
        }
    }
}

/// `hashCampaignPayload`: FNV-1a over the UTF-16 units of the content's
/// `JSON.stringify`, as eight hex digits.
pub fn hash_campaign_payload(content: &CampaignContent<'_>) -> String {
    let text = |value: Option<&str>| value.map_or(Js::Null, |v| Js::String(v.to_owned()));
    let number = |value: Option<f64>| value.map_or(Js::Null, Js::Number);
    let payload = Js::Object(vec![
        ("name".to_owned(), Js::String(content.name.to_owned())),
        ("status".to_owned(), text(content.status)),
        ("objective".to_owned(), text(content.objective)),
        ("dailyBudget".to_owned(), number(content.daily_budget)),
        ("lifetimeBudget".to_owned(), number(content.lifetime_budget)),
        (
            "metrics".to_owned(),
            content.metrics.map_or(Js::Null, Metrics::to_js),
        ),
    ]);
    fnv1a(&js::stringify(&payload))
}

fn fnv1a(input: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in input.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

fn map_metrics_row(row: &Js) -> Metrics {
    let mut metrics = Vec::new();
    for key in ["spend", "impressions", "clicks", "ctr", "cpc", "reach"] {
        if present(row.get(key)) {
            metrics.push((key, as_text(row.get(key))));
        }
    }
    for (key, field) in [("dateStart", "date_start"), ("dateEnd", "date_stop")] {
        if truthy(row.get(field)) {
            metrics.push((key, as_text(row.get(field))));
        }
    }
    Metrics(metrics)
}

fn map_campaign_row(row: &Js, metrics: Option<Metrics>) -> MetaCampaign {
    let optional_text = |key: &str| truthy(row.get(key)).then(|| as_text(row.get(key)));
    let optional_number = |key: &str| {
        row.get(key)
            .filter(|value| present(Some(value)))
            .map(js_number_of)
    };
    let name = match row.get("name") {
        Some(name) if present(Some(name)) => js::as_text(name),
        _ => as_text(row.get("id")),
    };
    MetaCampaign {
        platform_campaign_id: as_text(row.get("id")),
        name,
        status: optional_text("status"),
        objective: optional_text("objective"),
        daily_budget: optional_number("daily_budget"),
        lifetime_budget: optional_number("lifetime_budget"),
        metrics,
    }
}

/// A campaign to create on Meta (`CreateMetaCampaignInput`).
#[derive(Debug, Clone)]
pub struct NewCampaign {
    pub name: String,
    pub objective: String,
    pub status: Option<String>,
    pub daily_budget: Option<i64>,
    pub lifetime_budget: Option<i64>,
}

/// The fields of a campaign to change on Meta (`UpdateMetaCampaignInput`).
#[derive(Debug, Clone, Default)]
pub struct CampaignChanges {
    pub name: Option<String>,
    pub objective: Option<String>,
    pub status: Option<String>,
    pub daily_budget: Option<i64>,
    pub lifetime_budget: Option<i64>,
}

/// `MetaMarketingClient`: the Graph API with one access token.
#[derive(Clone)]
pub struct MetaClient {
    http: OutboundHttp,
    access_token: String,
}

impl MetaClient {
    pub fn new(http: OutboundHttp, access_token: impl Into<String>) -> Self {
        Self {
            http,
            access_token: access_token.into(),
        }
    }

    async fn graph_get(&self, path: &str, query: &[(&str, &str)]) -> Result<Js, AdsError> {
        let mut pairs = query.to_vec();
        pairs.push(("access_token", &self.access_token));
        let url = format!("{GRAPH_BASE}{path}?{}", search_params(&pairs));
        let (ok, status, json) = send(&self.http, HttpRequest::empty("GET", url))
            .await?
            .json()?;
        if !ok {
            return Err(AdsError::message(error_message(&json, || {
                format!("Meta API error ({status})")
            })));
        }
        Ok(json)
    }

    async fn graph_post(&self, path: &str, body: &[(&str, &str)]) -> Result<Js, AdsError> {
        let mut pairs = body.to_vec();
        pairs.push(("access_token", &self.access_token));
        let request = HttpRequest {
            method: "POST".to_owned(),
            url: format!("{GRAPH_BASE}{path}"),
            headers: vec![(
                "Content-Type".to_owned(),
                "application/x-www-form-urlencoded".to_owned(),
            )],
            body: Some(search_params(&pairs).into_bytes()),
        };
        let (ok, status, json) = send(&self.http, request).await?.json()?;
        if !ok {
            return Err(AdsError::message(error_message(&json, || {
                format!("Meta API error ({status})")
            })));
        }
        Ok(json)
    }

    /// `listAdAccounts()`: the accounts the token can reach.
    pub async fn list_ad_accounts(&self) -> Result<Vec<MetaAdAccount>, AdsError> {
        let json = self
            .graph_get(
                "/me/adaccounts",
                &[
                    ("fields", "id,name,account_status,currency,timezone_name"),
                    ("limit", "200"),
                ],
            )
            .await?;
        let rows = match json.get("data") {
            Some(Js::Array(rows)) => rows.as_slice(),
            _ => &[],
        };
        Ok(rows
            .iter()
            .map(|row| MetaAdAccount {
                platform_account_id: as_text(row.get("id")),
                name: match row.get("name") {
                    Some(name) if present(Some(name)) => js::as_text(name),
                    _ => as_text(row.get("id")),
                },
                currency: truthy(row.get("currency")).then(|| as_text(row.get("currency"))),
                timezone: truthy(row.get("timezone_name"))
                    .then(|| as_text(row.get("timezone_name"))),
                status: present(row.get("account_status"))
                    .then(|| as_text(row.get("account_status"))),
            })
            .collect())
    }

    /// `getCampaign(platformAccountId, campaignId)`: the campaign with its
    /// insights; `None` when either call fails.
    pub async fn get_campaign(
        &self,
        platform_account_id: &str,
        campaign_id: &str,
    ) -> Option<MetaCampaign> {
        let account_id = normalize_account_id(platform_account_id);
        let row = self
            .graph_get(&format!("/{campaign_id}"), &[("fields", CAMPAIGN_FIELDS)])
            .await
            .ok()?;
        let metrics = self
            .fetch_campaign_insights(&account_id, campaign_id)
            .await
            .ok()?;
        if matches!(row, Js::Null) {
            return None;
        }
        Some(map_campaign_row(&row, metrics))
    }

    async fn fetch_campaign_insights(
        &self,
        account_id: &str,
        campaign_id: &str,
    ) -> Result<Option<Metrics>, AdsError> {
        let filtering = format!(
            "[{{\"field\":\"campaign.id\",\"operator\":\"EQUAL\",\"value\":{}}}]",
            serde_json::to_string(campaign_id).unwrap_or_default()
        );
        let json = self
            .graph_get(
                &format!("/{account_id}/insights"),
                &[
                    ("level", "campaign"),
                    ("fields", INSIGHT_FIELDS),
                    ("date_preset", "last_30d"),
                    ("filtering", &filtering),
                    ("limit", "1"),
                ],
            )
            .await?;
        Ok(match json.get("data") {
            Some(Js::Array(rows)) => rows
                .first()
                .filter(|row| truthy(Some(row)))
                .map(map_metrics_row),
            _ => None,
        })
    }

    /// `createCampaign(platformAccountId, input)`: create, then read it back.
    pub async fn create_campaign(
        &self,
        platform_account_id: &str,
        input: &NewCampaign,
    ) -> Result<MetaCampaign, AdsError> {
        let account_id = normalize_account_id(platform_account_id);
        let budget_given = |budget: Option<i64>| budget.is_some_and(|b| b != 0);
        if !budget_given(input.daily_budget) && !budget_given(input.lifetime_budget) {
            return Err(AdsError::message(
                "A daily or lifetime budget is required to create a campaign",
            ));
        }
        let daily = input.daily_budget.map(|b| b.to_string());
        let lifetime = input.lifetime_budget.map(|b| b.to_string());
        let mut body: Vec<(&str, &str)> = vec![
            ("name", &input.name),
            ("objective", &input.objective),
            ("status", input.status.as_deref().unwrap_or("PAUSED")),
            ("special_ad_categories", "[]"),
        ];
        if let Some(daily) = &daily {
            body.push(("daily_budget", daily));
        }
        if let Some(lifetime) = &lifetime {
            body.push(("lifetime_budget", lifetime));
        }
        let json = self
            .graph_post(&format!("/{account_id}/campaigns"), &body)
            .await?;
        if !truthy(json.get("id")) {
            return Err(AdsError::message("Meta did not return a campaign id"));
        }
        let id = js_string(json.get("id"));
        self.get_campaign(&account_id, &id)
            .await
            .ok_or_else(|| AdsError::message("Failed to load created campaign"))
    }

    /// `updateCampaign(platformAccountId, platformCampaignId, input)`:
    /// update, then read it back.
    pub async fn update_campaign(
        &self,
        platform_account_id: &str,
        platform_campaign_id: &str,
        input: &CampaignChanges,
    ) -> Result<MetaCampaign, AdsError> {
        let account_id = normalize_account_id(platform_account_id);
        let daily = input.daily_budget.map(|b| b.to_string());
        let lifetime = input.lifetime_budget.map(|b| b.to_string());
        let mut body: Vec<(&str, &str)> = Vec::new();
        if let Some(name) = &input.name {
            body.push(("name", name));
        }
        if let Some(objective) = &input.objective {
            body.push(("objective", objective));
        }
        if let Some(status) = &input.status {
            body.push(("status", status));
        }
        if let Some(daily) = &daily {
            body.push(("daily_budget", daily));
        }
        if let Some(lifetime) = &lifetime {
            body.push(("lifetime_budget", lifetime));
        }
        if body.is_empty() {
            return Err(AdsError::message("No campaign fields to update"));
        }
        self.graph_post(&format!("/{platform_campaign_id}"), &body)
            .await?;
        self.get_campaign(&account_id, platform_campaign_id)
            .await
            .ok_or_else(|| AdsError::message("Failed to load updated campaign"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_like_the_typescript_helper() {
        // `hashCampaignPayload({ name: 'Fraction', status: 'ACTIVE', dailyBudget: 10.5 })`.
        let content = CampaignContent {
            name: "Fraction",
            status: Some("ACTIVE"),
            objective: None,
            daily_budget: Some(10.5),
            lifetime_budget: None,
            metrics: None,
        };
        assert_eq!(hash_campaign_payload(&content), "b4dc9025");
    }

    #[test]
    fn authorize_url_matches_url_search_params() {
        assert_eq!(
            build_authorize_url(
                "fb-app",
                "https://app.example.test/weldads/connect/callback",
                "s 1"
            ),
            "https://www.facebook.com/v21.0/dialog/oauth?client_id=fb-app&redirect_uri=https%3A%2F%2Fapp.example.test%2Fweldads%2Fconnect%2Fcallback&response_type=code&state=s+1&scope=ads_read%2Cbusiness_management%2Cads_management"
        );
    }

    #[test]
    fn maps_campaigns_and_metrics_as_javascript_reads_them() {
        let row: Js = serde_json::from_str(
            r#"{"id":"c1","status":"","objective":"OUTCOME_SALES","daily_budget":"1500","lifetime_budget":null}"#,
        )
        .expect("json");
        let metrics: Js = serde_json::from_str(
            r#"{"date_stop":"2026-10-30","clicks":3,"spend":"1.5","date_start":""}"#,
        )
        .expect("json");
        let campaign = map_campaign_row(&row, Some(map_metrics_row(&metrics)));
        assert_eq!(campaign.name, "c1");
        assert_eq!(campaign.status, None);
        assert_eq!(campaign.daily_budget, Some(1500.0));
        assert_eq!(campaign.lifetime_budget, None);
        assert_eq!(
            campaign.metrics,
            Some(Metrics(vec![
                ("spend", "1.5".to_owned()),
                ("clicks", "3".to_owned()),
                ("dateEnd", "2026-10-30".to_owned()),
            ]))
        );
    }
}
