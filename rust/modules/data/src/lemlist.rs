//! Lemlist's B2B lead database (`apps/workers/data-api/src/lib/lemlist.ts`):
//! the people and company searches and the filter catalog, behind one shared
//! WeldSuite key (`LEMLIST_API_KEY`), through the [`OutboundHttp`] port.
//!
//! Lemlist's data is global, so search pages and the filter catalog are
//! cached in the workspace cache keyed only by the request, never by
//! workspace, under the keys the worker uses (`lemlist:v1:…`): the two
//! backends share the entries. Caching is best effort: a cache error falls
//! through to a live call.

use std::cmp::Ordering;
use std::fmt::Write as _;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use weldsuite_ports::{DynCache, HttpRequest, OutboundHttp};

use crate::js::{js_lowercase, js_number_string, js_string, js_trim};

pub(crate) const LEMLIST_API_BASE: &str = "https://api.lemlist.com/api";

const CACHE_PREFIX: &str = "lemlist:v1:";
/// Search pages change slowly; an hour keeps paging and refiltering off the API.
const SEARCH_TTL: Duration = Duration::from_hours(1);
/// The filter catalog is near-static; refresh once a day.
const FILTERS_TTL: Duration = Duration::from_hours(24);
/// The one backoff before retrying a 429 (Lemlist allows ~20 requests / 2 s).
const RATE_LIMIT_BACKOFF: Duration = Duration::from_millis(1500);

/// Why a Lemlist call failed, as the routes tell them apart.
#[derive(Debug)]
pub(crate) enum LemlistError {
    /// No `LEMLIST_API_KEY` (`LemlistNotConfiguredError`).
    NotConfigured,
    /// Lemlist answered this status (`LemlistError`).
    Status(u16),
    /// Anything else: no connection, a body that isn't JSON, a payload the
    /// normalisers trip over.
    Other(String),
}

impl std::fmt::Display for LemlistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured => {
                f.write_str("Lemlist is not configured (missing LEMLIST_API_KEY)")
            }
            Self::Status(status) => write!(f, "Lemlist API {status}"),
            Self::Other(message) => f.write_str(message),
        }
    }
}

/// One search as the route validated it.
#[derive(Debug, Clone)]
pub(crate) struct SearchArgs {
    /// `(filterId, values)`, values as they came (strings or numbers).
    pub(crate) filters: Vec<(String, Vec<Value>)>,
    pub(crate) keyword: Option<String>,
    pub(crate) page: i64,
    pub(crate) size: i64,
}

/// Which database a search runs against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Database {
    People,
    Companies,
}

impl Database {
    fn path(self) -> &'static str {
        match self {
            Self::People => "/database/people",
            Self::Companies => "/database/companies",
        }
    }

    fn scope(self) -> &'static str {
        match self {
            Self::People => "people",
            Self::Companies => "companies",
        }
    }

    /// The filter the free-text keyword folds into: neither database takes
    /// a top-level `keyword`.
    fn keyword_filter(self) -> &'static str {
        match self {
            Self::People => "keyword",
            Self::Companies => "keywordInCompany",
        }
    }
}

/// The client: the key, the HTTP port and the cache.
pub(crate) struct Lemlist {
    pub(crate) api_key: Option<String>,
    pub(crate) http: OutboundHttp,
    pub(crate) cache: Option<Arc<dyn DynCache>>,
}

impl Lemlist {
    /// `getFilters(apiKey, cache)`: the catalog per database.
    pub(crate) async fn filters(&self) -> Result<Value, LemlistError> {
        let key = format!("{CACHE_PREFIX}filters");
        if let Some(cached) = self.cached(&key).await {
            return Ok(cached);
        }
        let payload = self.request("GET", "/database/filters", None).await?;
        let catalog = json!({
            "people": normalize_filter_defs(&payload, "people")?,
            "companies": normalize_filter_defs(&payload, "companies")?,
        });
        self.store(&key, &catalog, FILTERS_TTL).await;
        Ok(catalog)
    }

    /// `searchPeople` / `searchCompanies`: one page, normalised.
    pub(crate) async fn search(
        &self,
        database: Database,
        args: &SearchArgs,
    ) -> Result<Value, LemlistError> {
        // Lemlist wants `{ filterId, in, out }`; the keyword folds into its
        // filter, merged with one of the same id.
        let mut filters: Vec<(String, Vec<Value>)> = args.filters.clone();
        let keyword = args.keyword.as_deref().map(js_trim).unwrap_or_default();
        if !keyword.is_empty() {
            let id = database.keyword_filter();
            match filters.iter_mut().find(|(filter_id, _)| filter_id == id) {
                Some((_, values)) => values.push(Value::String(keyword.to_owned())),
                None => filters.push((id.to_owned(), vec![Value::String(keyword.to_owned())])),
            }
        }
        let key = format!(
            "{CACHE_PREFIX}search:{}:{}",
            database.scope(),
            sha256_hex(&canonical_search(&filters, args.page, args.size))
        );
        if let Some(cached) = self.cached(&key).await {
            return Ok(cached);
        }
        let body = json!({
            "filters": filters
                .iter()
                .map(|(id, values)| json!({ "filterId": id, "in": values, "out": [] }))
                .collect::<Vec<_>>(),
            "page": args.page,
            "size": args.size,
        });
        let payload = self.request("POST", database.path(), Some(&body)).await?;
        let rows = extract_rows(&payload)
            .iter()
            .map(|row| match database {
                Database::People => normalize_person(row),
                Database::Companies => normalize_company(row),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let count = i64::try_from(rows.len()).unwrap_or(i64::MAX);
        let total =
            extract_total(&payload).unwrap_or_else(|| json!((args.page - 1) * args.size + count));
        let result = json!({
            "rows": rows,
            "page": args.page,
            "size": args.size,
            "total": total,
            "hasMore": count >= args.size,
        });
        self.store(&key, &result, SEARCH_TTL).await;
        Ok(result)
    }

    /// `kv.get(key, 'json')`; a miss, an error or text that isn't JSON (or
    /// is `null`) reads as nothing.
    async fn cached(&self, key: &str) -> Option<Value> {
        let cache = self.cache.as_ref()?;
        let text = cache.get_boxed(key).await.ok().flatten()?;
        serde_json::from_str::<Value>(&text)
            .ok()
            .filter(|value| !value.is_null())
    }

    /// `kv.put(key, JSON.stringify(value), { expirationTtl })`, best effort.
    async fn store(&self, key: &str, value: &Value, ttl: Duration) {
        if let Some(cache) = &self.cache
            && let Err(error) = cache.put_boxed(key, &value.to_string(), Some(ttl)).await
        {
            tracing::warn!(%error, "lemlist: cache write failed");
        }
    }

    /// `lemlistRequest(apiKey, path, init)`: Basic auth with the key as the
    /// password, one retry after a 429, the body as JSON.
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, LemlistError> {
        let Some(api_key) = self.api_key.as_deref().filter(|key| !key.is_empty()) else {
            return Err(LemlistError::NotConfigured);
        };
        let authorization = basic_auth(api_key).ok_or_else(|| {
            LemlistError::Other(
                "The string to be encoded contains characters outside of the Latin1 range."
                    .to_owned(),
            )
        })?;
        let request = HttpRequest {
            method: method.to_owned(),
            url: format!("{LEMLIST_API_BASE}{path}"),
            headers: vec![
                ("Authorization".to_owned(), authorization),
                ("Content-Type".to_owned(), "application/json".to_owned()),
                ("Accept".to_owned(), "application/json".to_owned()),
            ],
            body: body.map(|body| body.to_string().into_bytes()),
        };
        let send = || async {
            self.http
                .send(request.clone())
                .await
                .map_err(|error| LemlistError::Other(error.to_string()))
        };
        let mut response = send().await?;
        if response.status == 429 {
            tokio::time::sleep(RATE_LIMIT_BACKOFF).await;
            response = send().await?;
        }
        if !response.ok() {
            return Err(LemlistError::Status(response.status));
        }
        serde_json::from_slice(&response.body).map_err(|error| {
            LemlistError::Other(format!(
                "Lemlist answered something that is not JSON: {error}"
            ))
        })
    }
}

/// `Basic ${btoa(':' + apiKey)}`; `None` where `btoa` throws (a character
/// above U+00FF).
fn basic_auth(api_key: &str) -> Option<String> {
    let latin1 = std::iter::once(':')
        .chain(api_key.chars())
        .map(|c| u8::try_from(u32::from(c)).ok())
        .collect::<Option<Vec<u8>>>()?;
    Some(format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(latin1)
    ))
}

fn sha256_hex(input: &str) -> String {
    Sha256::digest(input.as_bytes())
        .iter()
        .fold(String::with_capacity(64), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

/// The cache key's canonical request, as `JSON.stringify` writes it: the
/// filters sorted by id (`localeCompare`), each inclusion list as strings
/// sorted by code unit, then the page and size.
pub(crate) fn canonical_search(filters: &[(String, Vec<Value>)], page: i64, size: i64) -> String {
    let mut sorted: Vec<&(String, Vec<Value>)> = filters.iter().collect();
    sorted.sort_by(|a, b| locale_compare(&a.0, &b.0));
    let mut out = String::from("{\"filters\":[");
    for (index, (id, values)) in sorted.into_iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        let mut texts: Vec<String> = values.iter().map(js_string).collect();
        texts.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        out.push_str("{\"filterId\":");
        out.push_str(&Value::String(id.clone()).to_string());
        out.push_str(",\"in\":");
        out.push_str(&Value::from(texts).to_string());
        out.push('}');
    }
    let _ = write!(out, "],\"page\":{page},\"size\":{size}}}");
    out
}

/// `a.localeCompare(b)` (ICU's root collation) for the identifiers filter
/// ids are: letters compare without case first, after digits, which come
/// after punctuation and spaces; then lowercase sorts before uppercase; then
/// code units decide. Close to ICU for ASCII, which filter ids are.
pub(crate) fn locale_compare(a: &str, b: &str) -> Ordering {
    fn primary(c: char) -> (u8, u32) {
        if c.is_alphabetic() {
            let folded = c.to_lowercase().next().unwrap_or(c);
            (3, u32::from(folded))
        } else if c.is_numeric() {
            (2, c.to_digit(10).unwrap_or_else(|| u32::from(c)))
        } else if c.is_whitespace() {
            (0, u32::from(c))
        } else {
            (1, u32::from(c))
        }
    }
    fn tertiary(c: char) -> u8 {
        u8::from(c.is_uppercase())
    }
    a.chars()
        .map(primary)
        .cmp(b.chars().map(primary))
        .then_with(|| a.chars().map(tertiary).cmp(b.chars().map(tertiary)))
        .then_with(|| a.encode_utf16().cmp(b.encode_utf16()))
}

// ── normalisation ────────────────────────────────────────────────────────────

/// `pick(row, ...keys)`: the first key whose value is neither undefined nor
/// null. `Err` where JavaScript reads a property of `null` (a `TypeError`).
fn pick<'a>(row: Option<&'a Value>, keys: &[&str]) -> Result<Option<&'a Value>, LemlistError> {
    match row {
        None | Some(Value::Null) => Err(LemlistError::Other(
            "Cannot read properties of null".to_owned(),
        )),
        Some(Value::Object(map)) => Ok(keys
            .iter()
            .find_map(|key| map.get(*key).filter(|value| !value.is_null()))),
        // A property of a string, number, boolean or array: undefined.
        Some(_) => Ok(None),
    }
}

/// `str(...vals)`: the first non-blank string (trimmed), or a number as
/// text.
fn str_of(values: &[Option<&Value>]) -> Value {
    for value in values.iter().flatten() {
        match value {
            Value::String(text) if !js_trim(text).is_empty() => {
                return Value::String(js_trim(text).to_owned());
            }
            Value::Number(number) => return Value::String(js_number_string(number)),
            _ => {}
        }
    }
    Value::Null
}

/// `str(pick(row, ...keys))`.
fn pick_str(row: Option<&Value>, keys: &[&str]) -> Result<Value, LemlistError> {
    Ok(str_of(&[pick(row, keys)?]))
}

/// A row's `id`, or a fresh UUID when the provider sent none.
fn id_or_uuid(value: Value) -> Value {
    if value.is_null() {
        Value::String(random_uuid())
    } else {
        value
    }
}

/// `crypto.randomUUID()`.
fn random_uuid() -> String {
    let hex = weldsuite_kit::id::random_string(32, "0123456789abcdef");
    let variant = ["8", "9", "a", "b"][usize::from(hex.as_bytes()[16] % 4)];
    format!(
        "{}-{}-4{}-{}{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        variant,
        &hex[17..20],
        &hex[20..32]
    )
}

/// The lead's company facts: the experience whose company is the current
/// one, else the first, else nothing.
fn current_experience(row: &Value) -> Result<Value, LemlistError> {
    let experiences: &[Value] = match row.get("experiences") {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    let current = pick_str(Some(row), &["current_exp_company_name"])?;
    if !current.is_null() {
        for experience in experiences {
            if pick_str(Some(experience), &["company_name"])? == current {
                return Ok(experience.clone());
            }
        }
    }
    Ok(experiences
        .first()
        .filter(|first| !first.is_null())
        .cloned()
        .unwrap_or_else(|| json!({})))
}

/// `normalizePerson(row)`.
pub(crate) fn normalize_person(row: &Value) -> Result<Value, LemlistError> {
    let row_ref = Some(row);
    let exp = current_experience_checked(row)?;
    let exp_ref = Some(&exp);
    let first = pick_str(row_ref, &["firstName", "first_name"])?;
    let last = pick_str(row_ref, &["lastName", "last_name"])?;
    let joined = [first.as_str(), last.as_str()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    let mut name = pick_str(row_ref, &["full_name", "name", "fullName"])?;
    if name.is_null() && !joined.is_empty() {
        name = Value::String(joined);
    }
    if name.is_null() {
        name = pick_str(row_ref, &["canonical_shorthand_name"])?;
    }
    Ok(json!({
        "id": id_or_uuid(pick_str(row_ref, &["_id", "lead_id", "id", "leadId"])?),
        "kind": "person",
        "name": name,
        "email": pick_str(row_ref, &["email"])?,
        "title": pick_str(exp_ref, &["title_normalized", "title"])?,
        "companyName": str_of(&[
            pick(row_ref, &["current_exp_company_name"])?,
            pick(exp_ref, &["company_name"])?,
        ]),
        "domain": pick_str(exp_ref, &["company_domain"])?,
        "industry": pick_str(exp_ref, &["company_industry"])?,
        "location": str_of(&[
            pick(row_ref, &["location"])?,
            pick(exp_ref, &["location"])?,
            pick(row_ref, &["state"])?,
        ]),
        "country": pick_str(row_ref, &["country"])?,
        "companySize": str_of(&[
            pick(exp_ref, &["company_size"])?,
            pick(exp_ref, &["company_employee_count"])?,
        ]),
        "linkedinUrl": pick_str(row_ref, &["lead_linkedin_url", "linkedinUrl", "linkedin_url"])?,
        "avatarUrl": str_of(&[
            pick(
                row_ref,
                &[
                    "lead_picture_url",
                    "picture_url",
                    "profile_picture_url",
                    "profilePictureUrl",
                    "picture",
                    "photo",
                    "photo_url",
                    "avatar",
                    "image",
                ],
            )?,
            pick(exp_ref, &["company_logo_url"])?,
        ]),
        "raw": row,
    }))
}

/// [`current_experience`], after the property reads JavaScript makes on
/// the row itself (`row.experiences` of `null` throws).
fn current_experience_checked(row: &Value) -> Result<Value, LemlistError> {
    if row.is_null() {
        return Err(LemlistError::Other(
            "Cannot read properties of null (reading 'experiences')".to_owned(),
        ));
    }
    current_experience(row)
}

/// `normalizeCompany(row)`.
pub(crate) fn normalize_company(row: &Value) -> Result<Value, LemlistError> {
    let row_ref = Some(row);
    let name = || pick_str(row_ref, &["company_name", "name"]);
    Ok(json!({
        "id": id_or_uuid(pick_str(row_ref, &["_id", "company_id", "id"])?),
        "kind": "company",
        "name": name()?,
        "email": pick_str(row_ref, &["email"])?,
        "title": null,
        "companyName": name()?,
        "domain": pick_str(row_ref, &["company_domain", "company_website_url", "domain"])?,
        "industry": pick_str(row_ref, &["company_industry", "company_subindustry", "industry"])?,
        "location": pick_str(row_ref, &["company_location", "company_headquarters_city"])?,
        "country": pick_str(row_ref, &["company_headquarters_country", "country"])?,
        "companySize": pick_str(row_ref, &["company_size", "company_employee_count"])?,
        "linkedinUrl": pick_str(row_ref, &["company_linkedin_url", "linkedinUrl"])?,
        "avatarUrl": pick_str(row_ref, &["company_logo_url", "logo_url", "logo", "companyLogoUrl"])?,
        "raw": row,
    }))
}

/// `extractRows(payload)`: the payload itself when it is a list, else the
/// first list under a known key.
fn extract_rows(payload: &Value) -> Vec<Value> {
    match payload {
        Value::Array(items) => items.clone(),
        Value::Object(map) => ["hits", "results", "data", "people", "companies", "leads"]
            .iter()
            .find_map(|key| match map.get(*key) {
                Some(Value::Array(items)) => Some(items.clone()),
                _ => None,
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// `extractTotal(payload, fallback)`: the first numeric total; `None` for
/// the fallback.
fn extract_total(payload: &Value) -> Option<Value> {
    let Value::Object(map) = payload else {
        return None;
    };
    ["total", "totalCount", "count", "nbHits"]
        .iter()
        .find_map(|key| map.get(*key).filter(|value| value.is_number()).cloned())
}

/// `normalizeFilterType(raw, hasOptions)`.
fn normalize_filter_type(raw: Option<&str>, has_options: bool) -> &'static str {
    let t = js_lowercase(raw.unwrap_or_default());
    if t.contains("range") {
        return "range";
    }
    if t.contains("multi") {
        return "multiselect";
    }
    if t.contains("bool") || t.contains("checkbox") {
        return "boolean";
    }
    if t.contains("number") || t.contains("integer") || t == "int" || t == "year" {
        return "number";
    }
    if ["select", "enum", "dropdown", "choice"]
        .iter()
        .any(|word| t.contains(word))
    {
        return "select";
    }
    if has_options && (t.is_empty() || t == "text") {
        return "select";
    }
    "text"
}

/// `normalizeFilterDefs(payload, scope)`: the filters of one database,
/// those Lemlist tags with a `mode` kept only for the modes they list.
fn normalize_filter_defs(payload: &Value, scope: &str) -> Result<Vec<Value>, LemlistError> {
    let scope_mode = if scope == "people" {
        "leads"
    } else {
        "companies"
    };
    let field = |key: &str| match payload {
        Value::Object(map) => map.get(key).filter(|value| !value.is_null()),
        _ => None,
    };
    let raw = field(scope).or_else(|| field("filters")).unwrap_or(payload);
    let Value::Array(items) = raw else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for def in items {
        let options_raw = pick(Some(def), &["options"])?
            .or(pick(Some(def), &["values"])?)
            .cloned()
            .unwrap_or_else(|| json!([]));
        let Value::Array(options_raw) = options_raw else {
            return Err(LemlistError::Other(
                "optionsRaw.map is not a function".to_owned(),
            ));
        };
        let mut options = Vec::with_capacity(options_raw.len());
        for option in &options_raw {
            if let Value::String(text) = option {
                options.push(json!({ "value": text, "label": text }));
                continue;
            }
            let value = match pick_str(Some(option), &["value", "id"])? {
                Value::String(value) => value,
                _ => String::new(),
            };
            let label = match pick_str(Some(option), &["label", "name"])? {
                Value::String(label) => label,
                _ => value.clone(),
            };
            options.push(json!({ "value": value, "label": label }));
        }
        let filter_id = match pick_str(Some(def), &["filterId", "id", "key"])? {
            Value::String(id) => id,
            _ => "unknown".to_owned(),
        };
        let mode: Option<Vec<String>> = match def.get("mode") {
            Some(Value::Array(modes)) => Some(modes.iter().map(js_string).collect()),
            _ => None,
        };
        if mode
            .as_ref()
            .is_some_and(|modes| !modes.iter().any(|m| m == scope_mode))
        {
            continue;
        }
        let label = match pick_str(Some(def), &["label", "name", "title"])? {
            Value::String(label) => label,
            _ => filter_id.clone(),
        };
        let kind = pick_str(Some(def), &["type"])?;
        let mut entry = Map::new();
        entry.insert("filterId".to_owned(), Value::String(filter_id));
        entry.insert("label".to_owned(), Value::String(label));
        entry.insert(
            "type".to_owned(),
            Value::from(normalize_filter_type(kind.as_str(), !options.is_empty())),
        );
        let description = pick_str(Some(def), &["description"])?;
        if !description.is_null() {
            entry.insert("description".to_owned(), description);
        }
        let helper = pick_str(Some(def), &["helper", "hint", "placeholder"])?;
        if !helper.is_null() {
            entry.insert("helper".to_owned(), helper);
        }
        entry.insert("options".to_owned(), Value::Array(options));
        out.push(Value::Object(entry));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_canonical_search_is_the_workers() {
        let filters = vec![
            ("tech".to_owned(), vec![json!("b"), json!(3), json!("A")]),
            ("country".to_owned(), vec![json!("UK")]),
        ];
        assert_eq!(
            canonical_search(&filters, 2, 10),
            r#"{"filters":[{"filterId":"country","in":["UK"]},{"filterId":"tech","in":["3","A","b"]}],"page":2,"size":10}"#
        );
        assert_eq!(locale_compare("hasEmail", "headcount"), Ordering::Less);
        assert_eq!(locale_compare("jobTitle", "jobtitle"), Ordering::Greater);
        assert_eq!(
            locale_compare("keyword", "keywordInCompany"),
            Ordering::Less
        );
        assert_eq!(locale_compare("Zeta", "alpha"), Ordering::Greater);
    }

    #[test]
    fn people_and_companies_normalise_like_the_worker() {
        let ada = json!({
            "_id": "lp_ada",
            "full_name": "Ada Lovelace",
            "current_exp_company_name": "Analytical Engines",
            "experiences": [
                { "company_name": "Old Co", "title": "Engineer" },
                { "company_name": "Analytical Engines", "title_normalized": "CTO", "company_size": "11-50" },
            ],
            "state": "London",
        });
        let person = normalize_person(&ada).expect("person");
        assert_eq!(person["title"], "CTO");
        assert_eq!(person["companySize"], "11-50");
        assert_eq!(person["location"], "London");
        let anon = normalize_person(
            &json!({ "id": 4711, "first_name": " ", "last_name": "Doe", "email": " a@b.test " }),
        )
        .expect("person");
        assert_eq!(anon["id"], "4711");
        assert_eq!(anon["name"], "Doe");
        assert_eq!(anon["email"], "a@b.test");
        assert!(normalize_person(&Value::Null).is_err());
        let company = normalize_company(
            &json!({ "company_id": "c1", "name": "Globex", "company_employee_count": 12 }),
        )
        .expect("company");
        assert_eq!(company["companyName"], "Globex");
        assert_eq!(company["companySize"], "12");
        assert_eq!(company["title"], Value::Null);
    }

    #[test]
    fn filters_keep_their_modes() {
        let payload = json!({ "filters": [
            { "filterId": "jobTitle", "type": "text", "mode": ["leads"] },
            { "id": "country", "name": "Country", "options": ["NL", { "value": "BE", "label": "Belgium" }] },
            { "key": "headcount", "type": "range", "description": "Employees", "mode": ["companies"] },
        ] });
        let people = normalize_filter_defs(&payload, "people").expect("people");
        assert_eq!(people.len(), 2);
        assert_eq!(people[1]["type"], "select");
        assert_eq!(
            people[1]["options"][1],
            json!({ "value": "BE", "label": "Belgium" })
        );
        assert!(people[0].get("description").is_none());
        let companies = normalize_filter_defs(&payload, "companies").expect("companies");
        assert_eq!(companies[1]["filterId"], "headcount");
        assert_eq!(companies[1]["description"], "Employees");
        assert_eq!(normalize_filter_type(Some("Integer"), false), "number");
    }

    #[test]
    fn basic_auth_is_btoa() {
        assert_eq!(basic_auth("key").as_deref(), Some("Basic OmtleQ=="));
        assert_eq!(basic_auth("ключ"), None);
    }
}
