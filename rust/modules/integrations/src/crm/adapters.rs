//! `lib/engine/adapters/*`: the CRM sync adapters the `CRM_SYNC` Workflow
//! registers (Attio, `HubSpot`, Google Calendar), as far as the sync engine
//! uses them: the default field mappings, a page of records, and the token
//! refresh. Outbound pushes, OAuth and webhook registration live in
//! WeldConnect (`modules/connect`), which never calls them here.

use serde_json::{Map, Value, json};
use weldsuite_core_domain::js::{Js, as_text, js_date, js_string};
use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp};

use super::mapper::{FieldMapping, truthy};
use super::{Record, now_iso, now_millis};

const ATTIO_API_BASE: &str = "https://api.attio.com/v2";
const ATTIO_TOKEN_URL: &str = "https://app.attio.com/oauth/token";
const ATTIO_PAGE_SIZE: usize = 500;
const HUBSPOT_API_BASE: &str = "https://api.hubapi.com";
const HUBSPOT_TOKEN_URL: &str = "https://api.hubapi.com/oauth/v1/token";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const CALENDAR_API_BASE: &str = "https://www.googleapis.com/calendar/v3";

/// A registered adapter (`getAdapter(provider)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Adapter {
    Attio,
    HubSpot,
    GoogleCalendar,
}

/// `ExternalEntity`: a provider record, `data` already shaped for the
/// field mapper (or, for Google Calendar, for the table).
#[derive(Debug, Clone)]
pub struct ExternalEntity {
    pub id: String,
    pub data: Record,
    pub updated_at: String,
    /// What the checksum is taken of (`JSON.stringify(raw)`).
    pub raw: Js,
}

/// `FetchPageResult`.
#[derive(Debug, Clone, Default)]
pub struct Page {
    pub entities: Vec<ExternalEntity>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

/// `OAuthTokens` after a refresh, as stored in `oauth_tokens`.
#[derive(Debug, Clone, PartialEq)]
pub struct Tokens {
    /// `undefined` (left out) is `None`.
    pub access_token: Option<Value>,
    pub refresh_token: Option<Value>,
    pub expires_at: Option<String>,
    pub token_type: Option<Value>,
}

impl Tokens {
    /// The `oauth_tokens` object (`undefined` keys left out).
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        put(&mut out, "accessToken", self.access_token.clone());
        put(&mut out, "refreshToken", self.refresh_token.clone());
        put(
            &mut out,
            "expiresAt",
            self.expires_at.clone().map(Value::String),
        );
        put(&mut out, "tokenType", self.token_type.clone());
        Value::Object(out)
    }

    /// The access token as `String(token)`.
    pub fn access_text(&self) -> String {
        self.access_token
            .as_ref()
            .map_or_else(|| "undefined".to_owned(), |v| js_string(&Js::from_jsonb(v)))
    }
}

/// `fetch(...)` through the port; a connection failure is `fetch` throwing.
pub(crate) async fn send(
    http: Option<&OutboundHttp>,
    request: HttpRequest,
) -> Result<HttpResponse, String> {
    let http = http.ok_or("fetch failed")?;
    http.send(request).await.map_err(|error| error.to_string())
}

/// `await response.json()`, keys in JavaScript's order.
pub(crate) fn json_of(response: &HttpResponse) -> Result<Js, String> {
    serde_json::from_slice::<Js>(&response.body).map_err(|_| {
        format!(
            "Unexpected token in JSON: {}",
            String::from_utf8_lossy(&response.body)
        )
    })
}

/// A form body (`new URLSearchParams({...})`).
pub(crate) fn form(pairs: &[(&str, &str)]) -> Vec<u8> {
    let mut out = form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        out.append_pair(key, value);
    }
    out.finish().into_bytes()
}

fn form_request(url: &str, pairs: &[(&str, &str)]) -> HttpRequest {
    HttpRequest {
        method: "POST".to_owned(),
        url: url.to_owned(),
        headers: vec![(
            "Content-Type".to_owned(),
            "application/x-www-form-urlencoded".to_owned(),
        )],
        body: Some(form(pairs)),
    }
}

fn bearer_get(url: String, token: &str, accept: bool) -> HttpRequest {
    let mut request =
        HttpRequest::empty("GET", url).header("Authorization", format!("Bearer {token}"));
    if accept {
        request = request.header("Accept", "application/json");
    }
    request
}

/// `new Date(Date.now() + seconds * 1000).toISOString()`.
fn expires_in(seconds: f64) -> Option<String> {
    #[allow(clippy::cast_precision_loss)]
    let at = now_millis() as f64 + seconds * 1000.0;
    if !at.is_finite() {
        return None;
    }
    #[allow(clippy::cast_possible_truncation)]
    Some(super::iso_of_millis(at as i64))
}

/// `data.x || fallback` for a string-ish token field.
fn or(value: Option<&Value>, fallback: Value) -> Option<Value> {
    if truthy(value) {
        value.cloned()
    } else {
        Some(fallback)
    }
}

impl Adapter {
    /// `getAdapter(provider)`.
    pub fn for_provider(provider: &str) -> Result<Self, String> {
        match provider {
            "attio" => Ok(Self::Attio),
            "hubspot" => Ok(Self::HubSpot),
            "google_calendar" => Ok(Self::GoogleCalendar),
            other => Err(format!(
                "No CRM sync adapter registered for provider: {other}"
            )),
        }
    }

    /// `supportedEntities`.
    pub fn supported_entities(self) -> &'static [&'static str] {
        match self {
            Self::Attio => &["customer", "contact"],
            Self::HubSpot => &["contact", "customer", "opportunity"],
            Self::GoogleCalendar => &["calendar_event"],
        }
    }

    /// `getDefaultFieldMappings(entityType)`.
    pub fn default_field_mappings(self, entity_type: &str) -> Vec<FieldMapping> {
        let m = FieldMapping::new;
        match (self, entity_type) {
            (Self::Attio, "customer") => vec![
                m("companyName", "companyName", "inbound", "direct"),
                m("email", "email", "inbound", "direct").required(),
                m("website", "website", "inbound", "direct"),
                m("phone", "phone", "inbound", "direct"),
                m("notes", "notes", "inbound", "direct"),
                m("tags", "tags", "inbound", "direct"),
                m("type", "type", "inbound", "direct"),
                m("status", "status", "inbound", "direct"),
                m("source", "source", "inbound", "direct"),
            ],
            (Self::Attio, "contact") => vec![
                m("firstName", "firstName", "inbound", "direct"),
                m("lastName", "lastName", "inbound", "direct"),
                m("fullName", "fullName", "inbound", "direct"),
                m("email", "email", "inbound", "direct").required(),
                m("phone", "directPhone", "inbound", "direct"),
                m("title", "title", "inbound", "direct"),
                m("status", "status", "inbound", "direct"),
            ],
            (Self::HubSpot, "contact") => vec![
                m(
                    "properties.firstname",
                    "firstName",
                    "bidirectional",
                    "direct",
                ),
                m("properties.lastname", "lastName", "bidirectional", "direct"),
                m("properties.email", "email", "bidirectional", "direct").required(),
                m("properties.phone", "directPhone", "bidirectional", "direct"),
                m(
                    "properties.mobilephone",
                    "mobile",
                    "bidirectional",
                    "direct",
                ),
                m("properties.jobtitle", "title", "bidirectional", "direct"),
                m("properties.lifecyclestage", "status", "inbound", "lookup").lookup(&json!({
                    "subscriber": "active",
                    "lead": "active",
                    "marketingqualifiedlead": "active",
                    "salesqualifiedlead": "active",
                    "opportunity": "active",
                    "customer": "active",
                    "evangelist": "active",
                    "other": "active",
                })),
            ],
            (Self::HubSpot, "customer") => vec![
                m("properties.name", "companyName", "bidirectional", "direct").required(),
                m("properties.domain", "website", "bidirectional", "direct"),
                m("properties.phone", "phone", "bidirectional", "direct"),
                m("properties.industry", "industry", "bidirectional", "direct"),
                m("properties.description", "notes", "bidirectional", "direct"),
                m("properties.address", "billingAddress", "inbound", "direct"),
                m("properties.city", "billingCity", "inbound", "direct"),
                m("properties.country", "billingCountry", "inbound", "direct"),
            ],
            (Self::HubSpot, "opportunity") => vec![
                m("properties.dealname", "name", "bidirectional", "direct").required(),
                m("properties.amount", "amount", "bidirectional", "direct"),
                m(
                    "properties.deal_currency_code",
                    "currency",
                    "bidirectional",
                    "direct",
                ),
                m(
                    "properties.closedate",
                    "closeDate",
                    "bidirectional",
                    "format_date",
                ),
                m("properties.dealstage", "stage", "bidirectional", "lookup").lookup(&json!({
                    "appointmentscheduled": "prospecting",
                    "qualifiedtobuy": "qualification",
                    "presentationscheduled": "needs_analysis",
                    "decisionmakerboughtin": "proposal",
                    "contractsent": "negotiation",
                    "closedwon": "closed_won",
                    "closedlost": "closed_lost",
                })),
                m(
                    "properties.description",
                    "description",
                    "bidirectional",
                    "direct",
                ),
                m("properties.pipeline", "pipeline", "inbound", "direct"),
            ],
            _ => Vec::new(),
        }
    }

    /// `fetchEntities(accessToken, entityType, cursor)` (the engine never
    /// passes `updatedSince`).
    pub async fn fetch_entities(
        self,
        http: Option<&OutboundHttp>,
        access_token: &str,
        entity_type: &str,
        cursor: Option<&str>,
    ) -> Result<Page, String> {
        match self {
            Self::Attio => attio_fetch(http, access_token, entity_type, cursor).await,
            Self::HubSpot => hubspot_fetch(http, access_token, entity_type, cursor).await,
            Self::GoogleCalendar => calendar_fetch(http, access_token, cursor).await,
        }
    }

    /// `refreshAccessToken(clientId, clientSecret, refreshToken)`.
    pub async fn refresh_access_token(
        self,
        http: Option<&OutboundHttp>,
        client_id: &str,
        client_secret: &str,
        refresh_token: &str,
    ) -> Result<Tokens, String> {
        let request = match self {
            Self::Attio => form_request(
                ATTIO_TOKEN_URL,
                &[
                    ("client_id", client_id),
                    ("client_secret", client_secret),
                    ("refresh_token", refresh_token),
                    ("grant_type", "refresh_token"),
                ],
            ),
            Self::HubSpot => form_request(
                HUBSPOT_TOKEN_URL,
                &[
                    ("grant_type", "refresh_token"),
                    ("client_id", client_id),
                    ("client_secret", client_secret),
                    ("refresh_token", refresh_token),
                ],
            ),
            Self::GoogleCalendar => form_request(
                GOOGLE_TOKEN_URL,
                &[
                    ("client_id", client_id),
                    ("client_secret", client_secret),
                    ("refresh_token", refresh_token),
                    ("grant_type", "refresh_token"),
                ],
            ),
        };
        let response = send(http, request).await?;
        if !response.ok() {
            let (status, text) = (response.status, response.text());
            return Err(match self {
                Self::Attio => format!("Attio token refresh failed ({status}): {text}"),
                Self::HubSpot => format!("HubSpot token refresh failed ({status}): {text}"),
                Self::GoogleCalendar => format!("Google token refresh failed: {status} {text}"),
            });
        }
        let data = json_of(&response)?.to_value();
        let refresh = Value::String(refresh_token.to_owned());
        let seconds = data.get("expires_in");
        let expires_at = match self {
            // `new Date(Date.now() + data.expires_in * 1000).toISOString()`,
            // which throws without a number.
            Self::HubSpot => Some(
                seconds
                    .and_then(Value::as_f64)
                    .and_then(expires_in)
                    .ok_or("Invalid time value")?,
            ),
            _ if truthy(seconds) => seconds.and_then(Value::as_f64).and_then(expires_in),
            _ => None,
        };
        Ok(Tokens {
            access_token: data.get("access_token").cloned(),
            refresh_token: match self {
                Self::GoogleCalendar => Some(refresh),
                _ => or(data.get("refresh_token"), refresh),
            },
            expires_at,
            token_type: or(data.get("token_type"), Value::String("Bearer".to_owned())),
        })
    }
}

/// `values[key]` as Attio's array of typed values: its first item, when the
/// array has one.
fn first<'a>(values: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    match values.get(key)? {
        Value::Array(items) => items.first(),
        _ => None,
    }
}

/// `arr[0]?.<field>`.
fn first_field<'a>(values: &'a Map<String, Value>, key: &str, field: &str) -> Option<&'a Value> {
    first(values, key)?.get(field)
}

/// Inserts `key: value` unless the value is `undefined`.
fn put(out: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        out.insert(key.to_owned(), value);
    }
}

/// Attio's adapter helpers (`adapters/attio.ts`), shared with the webhook
/// provider where they read the same.
pub(crate) mod attio_values {
    use super::{Js, Map, Value, as_text, first, first_field, js_string, truthy};

    pub(crate) fn email(values: &Map<String, Value>) -> Option<Value> {
        first_field(values, "email_addresses", "email_address").cloned()
    }

    pub(crate) fn phone(values: &Map<String, Value>) -> Option<Value> {
        let original = first_field(values, "phone_numbers", "original_phone_number");
        if truthy(original) {
            return original.cloned();
        }
        first_field(values, "phone_numbers", "phone_number").cloned()
    }

    pub(crate) fn company_name(values: &Map<String, Value>) -> Option<Value> {
        first_field(values, "name", "value").cloned()
    }

    pub(crate) fn domain(values: &Map<String, Value>) -> Option<Value> {
        first_field(values, "domains", "domain").cloned()
    }

    pub(crate) fn description(values: &Map<String, Value>) -> Option<Value> {
        first_field(values, "description", "value").cloned()
    }

    /// `arr.map(c => c.option?.title).filter(Boolean)`.
    pub(crate) fn categories(values: &Map<String, Value>) -> Option<Value> {
        let Some(Value::Array(items)) = values.get("categories") else {
            return None;
        };
        if items.is_empty() {
            return None;
        }
        Some(Value::Array(
            items
                .iter()
                .filter_map(|c| c.get("option").and_then(|o| o.get("title")))
                .filter(|title| truthy(Some(title)))
                .cloned()
                .collect(),
        ))
    }

    pub(crate) fn company_record_id(values: &Map<String, Value>) -> Option<Value> {
        first_field(values, "company", "target_record_id").cloned()
    }

    /// `{ firstName, lastName, fullName }`, each `|| undefined`.
    pub(crate) fn person_name(
        values: &Map<String, Value>,
    ) -> (Option<Value>, Option<Value>, Option<Value>) {
        let Some(name) = first(values, "name") else {
            return (None, None, None);
        };
        let part = |field: &str| name.get(field).filter(|v| truthy(Some(v))).cloned();
        (part("first_name"), part("last_name"), part("full_name"))
    }

    /// The adapter's `getAttrValue(values, key)`.
    pub(crate) fn attr_value(values: &Map<String, Value>, key: &str) -> Option<Value> {
        let item = first(values, key)?;
        match item.get("value") {
            Some(value) if !value.is_null() => {
                return Some(Value::String(as_text(&Js::from_jsonb(value))));
            }
            _ => {}
        }
        let original = item.get("original");
        if truthy(original) {
            return Some(Value::String(as_text(&Js::from_jsonb(
                original.expect("truthy"),
            ))));
        }
        None
    }

    /// `https://${domain}` when there is one.
    pub(crate) fn website(values: &Map<String, Value>) -> Option<Value> {
        let domain = domain(values);
        truthy(domain.as_ref()).then(|| {
            Value::String(format!(
                "https://{}",
                js_string(&Js::from_jsonb(domain.as_ref().expect("truthy")))
            ))
        })
    }
}

/// `value || fallback`.
fn or_text(value: Option<Value>, fallback: &str) -> Value {
    if truthy(value.as_ref()) {
        value.expect("truthy")
    } else {
        Value::String(fallback.to_owned())
    }
}

/// The adapter's `mapCompanyValues(values)`.
fn attio_company(values: &Map<String, Value>) -> Map<String, Value> {
    use attio_values as v;
    let mut out = Map::new();
    out.insert(
        "companyName".to_owned(),
        or_text(v::company_name(values), "Unknown Company"),
    );
    put(&mut out, "email", v::email(values));
    put(&mut out, "website", v::website(values));
    put(&mut out, "notes", v::description(values));
    put(&mut out, "tags", v::categories(values));
    put(&mut out, "phone", v::phone(values));
    out.insert("type".to_owned(), "b2b".into());
    out.insert("status".to_owned(), "active".into());
    out.insert("source".to_owned(), "attio".into());
    out
}

/// The adapter's `mapPersonValues(values)` and whether it links a company.
fn attio_person(values: &Map<String, Value>) -> (Map<String, Value>, bool) {
    use attio_values as v;
    let (first_name, last_name, full_name) = v::person_name(values);
    let has_company = truthy(v::company_record_id(values).as_ref());
    let mut out = Map::new();
    if has_company {
        out.insert("firstName".to_owned(), or_text(first_name, "Unknown"));
        out.insert("lastName".to_owned(), or_text(last_name, "Unknown"));
        put(&mut out, "fullName", full_name);
        put(&mut out, "email", v::email(values));
        put(&mut out, "phone", v::phone(values));
        put(&mut out, "title", v::attr_value(values, "job_title"));
        out.insert("status".to_owned(), "active".into());
    } else {
        out.insert("type".to_owned(), "b2c".into());
        out.insert("firstName".to_owned(), or_text(first_name, "Unknown"));
        out.insert("lastName".to_owned(), or_text(last_name, "Unknown"));
        put(&mut out, "fullName", full_name);
        put(&mut out, "email", v::email(values));
        put(&mut out, "phone", v::phone(values));
        out.insert("status".to_owned(), "active".into());
        out.insert("source".to_owned(), "attio".into());
    }
    (out, has_company)
}

/// JavaScript's `parseInt(text, 10)`: `None` is `NaN`.
fn parse_int(text: &str) -> Option<i64> {
    weldsuite_core_domain::js::parse_int(text)
}

/// `record.created_at || new Date().toISOString()`.
fn updated_at_or_now(value: Option<&Value>) -> String {
    if truthy(value) {
        js_string(&Js::from_jsonb(value.expect("truthy")))
    } else {
        now_iso()
    }
}

fn items_of(page: &Js, key: &str) -> Result<Vec<Js>, String> {
    match page.get(key) {
        Some(Js::Array(items)) => Ok(items.clone()),
        _ => Err("Cannot read properties of undefined (reading 'map')".to_owned()),
    }
}

async fn attio_fetch(
    http: Option<&OutboundHttp>,
    token: &str,
    entity_type: &str,
    cursor: Option<&str>,
) -> Result<Page, String> {
    let slug = match entity_type {
        "customer" => "companies",
        "contact" => "people",
        _ => return Ok(Page::default()),
    };
    let offset = cursor.map_or(Some(0), parse_int);
    let offset_json = offset.map_or_else(|| "null".to_owned(), |o| o.to_string());
    let request = HttpRequest {
        method: "POST".to_owned(),
        url: format!("{ATTIO_API_BASE}/objects/{slug}/records/query"),
        headers: vec![
            ("Authorization".to_owned(), format!("Bearer {token}")),
            ("Content-Type".to_owned(), "application/json".to_owned()),
        ],
        body: Some(
            format!("{{\"limit\":{ATTIO_PAGE_SIZE},\"offset\":{offset_json}}}").into_bytes(),
        ),
    };
    let response = send(http, request).await?;
    if !response.ok() {
        return Err(format!(
            "Attio API error {}: {}",
            response.status,
            response.text()
        ));
    }
    let page = json_of(&response)?;
    let records = items_of(&page, "data")?;
    let count = records.len();
    let mut entities = Vec::with_capacity(count);
    for record in records {
        let value = record.to_value();
        let id = value
            .get("id")
            .and_then(|id| id.get("record_id"))
            .map(|id| js_string(&Js::from_jsonb(id)))
            .ok_or("Cannot read properties of undefined (reading 'record_id')")?;
        let values = value
            .get("values")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let data = if slug == "companies" {
            attio_company(&values)
        } else {
            attio_person(&values).0
        };
        entities.push(ExternalEntity {
            id,
            data: Record::plain(data),
            updated_at: updated_at_or_now(value.get("created_at")),
            raw: record.get("values").cloned().unwrap_or(Js::Null),
        });
    }
    let full = count == ATTIO_PAGE_SIZE;
    Ok(Page {
        entities,
        next_cursor: full.then(|| {
            offset.map_or_else(
                || "NaN".to_owned(),
                |o| (o + i64::try_from(count).unwrap_or_default()).to_string(),
            )
        }),
        has_more: full,
    })
}

/// `HUBSPOT_PROPERTIES` of the sync adapter.
fn hubspot_properties(object: &str) -> &'static [&'static str] {
    match object {
        "contacts" => &[
            "firstname",
            "lastname",
            "email",
            "phone",
            "mobilephone",
            "jobtitle",
            "company",
            "website",
            "lifecyclestage",
            "hs_lead_status",
            "address",
            "city",
            "state",
            "zip",
            "country",
        ],
        "companies" => &[
            "name",
            "domain",
            "phone",
            "industry",
            "description",
            "numberofemployees",
            "annualrevenue",
            "website",
            "city",
            "state",
            "zip",
            "country",
            "address",
        ],
        "deals" => &[
            "dealname",
            "amount",
            "dealstage",
            "pipeline",
            "closedate",
            "hs_lastmodifieddate",
            "description",
            "deal_currency_code",
        ],
        "notes" => &["hs_timestamp", "hs_note_body"],
        _ => &[],
    }
}

/// `{ id, data: { properties }, updatedAt, raw }` of a `HubSpot` record.
pub(crate) fn hubspot_entity(record: Js) -> ExternalEntity {
    let value = record.to_value();
    let mut data = Map::new();
    put(&mut data, "properties", value.get("properties").cloned());
    let updated = value.get("updatedAt");
    let updated_at = if truthy(updated) {
        updated
    } else {
        value.get("createdAt")
    };
    ExternalEntity {
        id: value.get("id").map_or_else(
            || "undefined".to_owned(),
            |id| js_string(&Js::from_jsonb(id)),
        ),
        data: Record::plain(data),
        updated_at: updated_at_or_now(updated_at),
        raw: record,
    }
}

async fn hubspot_fetch(
    http: Option<&OutboundHttp>,
    token: &str,
    entity_type: &str,
    cursor: Option<&str>,
) -> Result<Page, String> {
    let object = match entity_type {
        "contact" => "contacts",
        "customer" => "companies",
        "opportunity" => "deals",
        "activity" => "notes",
        _ => return Ok(Page::default()),
    };
    let properties = hubspot_properties(object).join(",");
    let mut params = vec![("limit", "100"), ("properties", properties.as_str())];
    if let Some(after) = cursor {
        params.push(("after", after));
    }
    let query = String::from_utf8(form(&params)).unwrap_or_default();
    let request = bearer_get(
        format!("{HUBSPOT_API_BASE}/crm/v3/objects/{object}?{query}"),
        token,
        true,
    );
    let response = send(http, request).await?;
    if !response.ok() {
        return Err(format!(
            "HubSpot API error {}: {}",
            response.status,
            response.text()
        ));
    }
    let page = json_of(&response)?;
    let entities = items_of(&page, "results")?
        .into_iter()
        .map(hubspot_entity)
        .collect();
    let after = page
        .get("paging")
        .and_then(|p| p.get("next"))
        .and_then(|n| n.get("after"))
        .map(Js::to_value);
    let has_more = truthy(after.as_ref());
    Ok(Page {
        entities,
        next_cursor: after
            .filter(|a| !a.is_null())
            .map(|a| js_string(&Js::from_jsonb(&a))),
        has_more,
    })
}

/// `mapFromGoogle(event)`: the `calendarEvents` properties, the times as
/// `Date`s.
pub(crate) fn map_from_google(event: &Value) -> Record {
    let field = |key: &str| event.get(key).filter(|v| truthy(Some(v))).cloned();
    let start = event.get("start");
    let end = event.get("end");
    let start_date = start.and_then(|s| s.get("date"));
    let start_time = start.and_then(|s| s.get("dateTime"));
    let all_day = truthy(start_date) && !truthy(start_time);
    let mut record = Record::default();
    let values = &mut record.values;
    values.insert(
        "title".to_owned(),
        field("summary").unwrap_or_else(|| "(No title)".into()),
    );
    values.insert(
        "description".to_owned(),
        field("description").unwrap_or(Value::Null),
    );
    values.insert(
        "location".to_owned(),
        field("location").unwrap_or(Value::Null),
    );
    values.insert(
        "status".to_owned(),
        field("status").unwrap_or_else(|| "confirmed".into()),
    );
    values.insert(
        "meetingUrl".to_owned(),
        field("hangoutLink").unwrap_or(Value::Null),
    );
    if all_day && truthy(start_date) {
        record.set_date("startTime", start_date);
        record.values.insert("allDay".to_owned(), Value::Bool(true));
    } else if truthy(start_time) {
        record.set_date("startTime", start_time);
        record
            .values
            .insert("allDay".to_owned(), Value::Bool(false));
    }
    let end_date = end.and_then(|e| e.get("date"));
    let end_time = end.and_then(|e| e.get("dateTime"));
    if all_day && truthy(end_date) {
        record.set_date("endTime", end_date);
    } else if truthy(end_time) {
        record.set_date("endTime", end_time);
    }
    let zone = start.and_then(|s| s.get("timeZone"));
    if truthy(zone) {
        record
            .values
            .insert("timezone".to_owned(), zone.cloned().unwrap_or(Value::Null));
    }
    if let Some(attendees) = event.get("attendees").filter(|a| truthy(Some(a))) {
        let list: Vec<Value> = attendees
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|a| {
                        let mut out = Map::new();
                        put(&mut out, "email", a.get("email").cloned());
                        let pick = |key: &str| a.get(key).filter(|v| truthy(Some(v))).cloned();
                        put(&mut out, "name", pick("displayName"));
                        put(&mut out, "status", pick("responseStatus"));
                        if truthy(a.get("organizer")) {
                            out.insert("role".to_owned(), "organizer".into());
                        }
                        Value::Object(out)
                    })
                    .collect()
            })
            .unwrap_or_default();
        record
            .values
            .insert("attendees".to_owned(), Value::Array(list));
    }
    if let Some(Value::Array(rules)) = event.get("recurrence")
        && let Some(rule) = rules.first()
    {
        record
            .values
            .insert("recurrenceRule".to_owned(), rule.clone());
    }
    if let Some(id) = field("recurringEventId") {
        record.values.insert("recurrenceId".to_owned(), id);
    }
    record
}

async fn calendar_fetch(
    http: Option<&OutboundHttp>,
    token: &str,
    cursor: Option<&str>,
) -> Result<Page, String> {
    let mut params: Vec<(&str, String)> = vec![
        ("maxResults", "250".to_owned()),
        ("singleEvents", "true".to_owned()),
        ("orderBy", "updated".to_owned()),
    ];
    if let Some(token) = cursor {
        params.push(("pageToken", token.to_owned()));
    }
    params.push((
        "timeMin",
        super::iso_of_millis(now_millis() - 30 * 24 * 60 * 60 * 1000),
    ));
    let pairs: Vec<(&str, &str)> = params.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let query = String::from_utf8(form(&pairs)).unwrap_or_default();
    let request = bearer_get(
        format!("{CALENDAR_API_BASE}/calendars/primary/events?{query}"),
        token,
        false,
    );
    let response = send(http, request).await?;
    if !response.ok() {
        return Err(format!("Google Calendar API error: {} ", response.status));
    }
    let page = json_of(&response)?;
    let items = match page.get("items") {
        Some(Js::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    let entities = items
        .into_iter()
        .map(|event| {
            let value = event.to_value();
            ExternalEntity {
                id: value.get("id").map_or_else(
                    || "undefined".to_owned(),
                    |id| js_string(&Js::from_jsonb(id)),
                ),
                data: map_from_google(&value),
                updated_at: updated_at_or_now(value.get("updated")),
                raw: event,
            }
        })
        .collect();
    let next = page.get("nextPageToken").map(Js::to_value);
    let has_more = truthy(next.as_ref());
    Ok(Page {
        entities,
        next_cursor: next
            .filter(|n| !n.is_null())
            .map(|n| js_string(&Js::from_jsonb(&n))),
        has_more,
    })
}

/// `new Date(value)` of a stored time, in milliseconds: `None` is an
/// invalid date.
pub(crate) fn millis_of(text: &str) -> Option<i64> {
    let iso = js_date(text)?;
    super::millis_of_iso(&iso)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_events_map_to_calendar_rows() {
        let record = map_from_google(&json!({
            "id": "e1",
            "summary": "",
            "start": { "date": "2026-10-05" },
            "end": { "date": "2026-10-06" },
            "attendees": [{ "email": "a@x.io", "displayName": "", "organizer": true }],
            "recurrence": ["RRULE:FREQ=DAILY"],
        }));
        assert_eq!(record.values["title"], json!("(No title)"));
        assert_eq!(
            record.values["startTime"],
            json!("2026-10-05T00:00:00.000Z")
        );
        assert_eq!(record.values["endTime"], json!("2026-10-06T00:00:00.000Z"));
        assert_eq!(record.values["allDay"], json!(true));
        assert_eq!(
            record.values["attendees"],
            json!([{ "email": "a@x.io", "role": "organizer" }])
        );
        assert_eq!(record.values["recurrenceRule"], json!("RRULE:FREQ=DAILY"));
        assert_eq!(record.dates, vec!["startTime", "endTime"]);
    }

    #[test]
    fn attio_people_without_a_company_become_b2c() {
        let values = json!({
            "name": [{ "first_name": "Ada", "last_name": "", "full_name": "Ada" }],
            "email_addresses": [{ "email_address": "ada@x.io" }],
            "phone_numbers": [{ "original_phone_number": "", "phone_number": "+31" }],
        });
        let (data, has_company) = attio_person(values.as_object().expect("object"));
        assert!(!has_company);
        assert_eq!(
            Value::Object(data),
            json!({
                "type": "b2c", "firstName": "Ada", "lastName": "Unknown", "fullName": "Ada",
                "email": "ada@x.io", "phone": "+31", "status": "active", "source": "attio",
            })
        );
    }
}
