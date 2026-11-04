//! Telnyx numbers: available numbers in the shape the purchase UI reads
//! (`lib/telnyx-available-numbers.ts`), the price list's markup and a
//! number's customer price (`services/phone-number-pricing.ts`), and the
//! regulatory requirements of ordering one
//! (`services/phone-number-requirements.ts`).

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;

use crate::js;
use crate::telnyx::{Body, Telnyx, TelnyxError};

/// `asText(value)` (`@weldsuite/text`).
pub(crate) fn as_text(value: &Value) -> String {
    match value {
        Value::Object(_) => value.to_string(),
        other => js::string(other),
    }
}

/// `regionName(regions, types)`: the trimmed name of the first region of
/// one of `types`, when not empty.
fn region_name(regions: &[Value], types: &[&str]) -> Option<String> {
    let hit = regions.iter().find(|r| {
        r["region_type"]
            .as_str()
            .is_some_and(|t| !t.is_empty() && types.contains(&t))
    })?;
    let name = weldsuite_kit::validation::js_trim(hit["region_name"].as_str()?);
    (!name.is_empty()).then(|| name.to_owned())
}

/// A string field that is a non-empty string (`typeof x === 'string' && x`).
fn non_empty(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| !s.is_empty())
}

/// `mapTelnyxAvailableNumber(row, fallbackCountry)`; `None` without a
/// number.
pub(crate) fn map_available(row: &Value, fallback_country: &str) -> Option<Value> {
    let phone = row["phone_number"]
        .as_str()
        .map(|p| weldsuite_kit::validation::js_trim(p).to_owned())
        .unwrap_or_default();
    if phone.is_empty() {
        return None;
    }
    let regions: Vec<Value> = row["region_information"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let iso = row["iso_country"]
        .as_str()
        .map(|i| weldsuite_kit::validation::js_trim(i).to_owned())
        .filter(|i| !i.is_empty())
        .or_else(|| region_name(&regions, &["country_code"]))
        .unwrap_or_else(|| fallback_country.to_owned());
    let features: Vec<String> = row["features"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|f| match &f["name"] {
                    Value::Null => String::new(),
                    name => js::string(name).to_lowercase(),
                })
                .filter(|name| !name.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let mut out = Map::new();
    out.insert("phone_number".to_owned(), json!(phone));
    let friendly = row["friendly_name"]
        .as_str()
        .map(|f| weldsuite_kit::validation::js_trim(f).to_owned())
        .filter(|f| !f.is_empty())
        .unwrap_or_else(|| phone.clone());
    out.insert("friendly_name".to_owned(), json!(friendly));
    out.insert("iso_country".to_owned(), json!(iso.to_uppercase()));
    if let Some(locality) = non_empty(&row["locality"])
        .map(str::to_owned)
        .or_else(|| region_name(&regions, &["location", "rate_center"]))
    {
        out.insert("locality".to_owned(), json!(locality));
    }
    if let Some(region) = non_empty(&row["region"])
        .map(str::to_owned)
        .or_else(|| region_name(&regions, &["state"]))
    {
        out.insert("region".to_owned(), json!(region));
    }
    if let Some(kind) = row.get("phone_number_type") {
        out.insert("phone_number_type".to_owned(), kind.clone());
    }
    out.insert("region_information".to_owned(), Value::Array(regions));
    let cost = &row["cost_information"];
    if js::truthy(cost) && (js::truthy(&cost["monthly_cost"]) || js::truthy(&cost["upfront_cost"]))
    {
        let text = |value: &Value| match value {
            Value::Null => "0".to_owned(),
            other => js::string(other),
        };
        let currency = if js::truthy(&cost["currency"]) {
            cost["currency"].clone()
        } else {
            json!("USD")
        };
        out.insert(
            "cost_information".to_owned(),
            json!({
                "currency": currency,
                "monthly_cost": text(&cost["monthly_cost"]),
                "upfront_cost": text(&cost["upfront_cost"]),
            }),
        );
    }
    out.insert(
        "features".to_owned(),
        Value::Array(
            features
                .iter()
                .map(|name| json!({ "name": name }))
                .collect(),
        ),
    );
    let has =
        |name: &str| js::truthy(&row["capabilities"][name]) || features.iter().any(|f| f == name);
    out.insert(
        "capabilities".to_owned(),
        json!({ "voice": has("voice"), "sms": has("sms"), "mms": has("mms") }),
    );
    Some(Value::Object(out))
}

/// `normalizeNumberType(type)`.
pub(crate) fn normalize_type(kind: &str) -> String {
    weldsuite_kit::validation::js_trim(kind)
        .to_lowercase()
        .replace('_', "-")
}

/// `isDefaultTelephonyPricing(countryCode, numberType)`: the `*`/`*` row.
pub(crate) fn is_default_pricing(country: &str, kind: &str) -> bool {
    weldsuite_kit::validation::js_trim(country) == "*" && normalize_type(kind) == "*"
}

/// `pricingLookupKey(countryCode, numberType)`.
fn lookup_key(country: &str, kind: &str) -> String {
    format!(
        "{}:{}",
        weldsuite_kit::validation::js_trim(country).to_uppercase(),
        normalize_type(kind)
    )
}

/// An active `telephony_number_pricing` row, numerics as Drizzle reads
/// them (text).
#[derive(Debug, Clone)]
pub(crate) struct PriceRow {
    pub(crate) country_code: String,
    pub(crate) number_type: String,
    pub(crate) monthly_price: String,
    pub(crate) setup_fee: String,
    pub(crate) currency: String,
    pub(crate) stripe_price_id: Option<String>,
    pub(crate) markup: Markup,
}

/// `TelephonyMarkup`.
#[derive(Debug, Clone, Default)]
pub(crate) struct Markup {
    pub(crate) amount: Option<i32>,
    pub(crate) percent: Option<String>,
}

type RawPriceRow = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<i32>,
    Option<String>,
);

/// The active price list, in `order_by` when asked (`country_code`,
/// `number_type`), else as the table returns it.
pub(crate) async fn price_list(
    master: &PgPool,
    ordered: bool,
) -> Result<Vec<PriceRow>, sqlx::Error> {
    let sql = if ordered {
        "select country_code, number_type, monthly_price::text, setup_fee::text, currency,
             stripe_price_id, markup_amount, markup_percent::text
         from telephony_number_pricing where is_active = true
         order by country_code asc, number_type asc"
    } else {
        "select country_code, number_type, monthly_price::text, setup_fee::text, currency,
             stripe_price_id, markup_amount, markup_percent::text
         from telephony_number_pricing where is_active = true"
    };
    let rows: Vec<RawPriceRow> = sqlx::query_as(sql).fetch_all(master).await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                country_code,
                number_type,
                monthly_price,
                setup_fee,
                currency,
                stripe,
                amount,
                percent,
            )| PriceRow {
                country_code,
                number_type,
                monthly_price,
                setup_fee,
                currency,
                stripe_price_id: stripe,
                markup: Markup { amount, percent },
            },
        )
        .collect())
}

/// `resolveTelephonyMarkup(rows, countryCode, numberType)`: the exact row's
/// markup, else the default row's.
pub(crate) fn resolve_markup(rows: &[PriceRow], country: &str, kind: &str) -> Option<Markup> {
    let key = lookup_key(country, kind);
    rows.iter()
        .find(|r| lookup_key(&r.country_code, &r.number_type) == key)
        .or_else(|| {
            rows.iter()
                .find(|r| is_default_pricing(&r.country_code, &r.number_type))
        })
        .map(|r| r.markup.clone())
}

/// `applyTelephonyMarkupMajor(wholesaleMajor, markup)`.
pub(crate) fn apply_markup(wholesale: &str, markup: Option<&Markup>) -> Option<String> {
    let major = js::parse_float(wholesale).filter(|n| n.is_finite())?;
    let mut sell = major;
    if let Some(markup) = markup {
        if let Some(amount) = markup.amount {
            sell = major + f64::from(amount) / 100.0;
        } else if let Some(percent) = &markup.percent
            && let Some(pct) = js::parse_float(percent).filter(|p| p.is_finite())
        {
            sell = major * (1.0 + pct / 100.0);
        }
    }
    Some(js::to_fixed2(sell))
}

/// `applyTelephonyMarkupToCost(cost, markup)`.
pub(crate) fn apply_markup_to_cost(cost: &Value, markup: Option<&Markup>) -> Value {
    if !cost.is_object() {
        return cost.clone();
    }
    let text = |key: &str| js::string(&cost[key]);
    let monthly =
        apply_markup(&text("monthly_cost"), markup).unwrap_or_else(|| text("monthly_cost"));
    let upfront =
        apply_markup(&text("upfront_cost"), markup).unwrap_or_else(|| text("upfront_cost"));
    json!({ "currency": cost["currency"], "monthly_cost": monthly, "upfront_cost": upfront })
}

/// `majorToCents(major)`.
pub(crate) fn major_to_cents(major: &str) -> i64 {
    match js::parse_float(major) {
        #[allow(clippy::cast_possible_truncation)]
        Some(n) if n.is_finite() && n > 0.0 => (n * 100.0 + 0.5).floor() as i64,
        _ => 0,
    }
}

/// `pickWholesaleMajor(catalog, live)`.
fn pick_wholesale(catalog: Option<&str>, live: Option<&str>) -> Option<String> {
    for value in [catalog, live].into_iter().flatten() {
        if js::parse_float(value).is_some_and(|n| n.is_finite() && n > 0.0) {
            return Some(value.to_owned());
        }
    }
    None
}

/// `lookupTelnyxWholesale(env, phoneNumber, countryCode)`: `(monthly,
/// upfront)` of the number on Telnyx.
async fn live_wholesale(
    telnyx: &Telnyx,
    phone_number: &str,
    country: &str,
) -> Result<Option<(String, String, String)>, TelnyxError> {
    let national = phone_number.strip_prefix('+').unwrap_or(phone_number);
    let units: Vec<u16> = national.encode_utf16().collect();
    let tail = String::from_utf16_lossy(&units[units.len().saturating_sub(8)..]);
    let upper = country.to_uppercase();
    let params = js::search_params(&[
        ("filter[country_code]", &upper),
        ("filter[limit]", "20"),
        ("filter[features][]", "voice"),
        ("filter[phone_number][contains]", &tail),
    ]);
    let response = telnyx
        .request("GET", &format!("/available_phone_numbers?{params}"), None)
        .await?;
    let mapped: Vec<Value> = response["data"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|r| map_available(r, country))
                .collect()
        })
        .unwrap_or_default();
    let hit = mapped
        .iter()
        .find(|n| n["phone_number"] == phone_number)
        .or_else(|| mapped.first());
    let Some(cost) = hit
        .map(|h| &h["cost_information"])
        .filter(|c| c.is_object())
    else {
        return Ok(None);
    };
    let or = |key: &str, fallback: &str| {
        cost[key]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback)
            .to_owned()
    };
    Ok(Some((
        or("monthly_cost", "0"),
        or("upfront_cost", "0"),
        or("currency", "USD"),
    )))
}

/// `resolveCustomerPhonePrice(env, args)`: whether the number has a
/// customer price (catalog wholesale, or Telnyx's live one, plus markup).
pub(crate) async fn has_customer_price(
    telnyx: &Telnyx,
    rows: &[PriceRow],
    country_code: &str,
    number_type: &str,
    phone_number: &str,
) -> Result<bool, TelnyxError> {
    let country = country_code.to_uppercase();
    let kind = normalize_type(number_type);
    let catalog = rows.iter().find(|r| {
        r.country_code.to_uppercase() == country && normalize_type(&r.number_type) == kind
    });
    let markup = resolve_markup(rows, &country, &kind)
        .or_else(|| catalog.map(|c| c.markup.clone()))
        .unwrap_or_default();
    let mut wholesale = catalog.map(|c| c.monthly_price.clone());
    // The setup fee only decides whether Telnyx is asked; its price goes to
    // billing-worker, which is not here.
    let setup = catalog.map(|c| c.setup_fee.clone());
    // `!value || parseFloat(value) <= 0`: NaN is not <= 0.
    let needs_live = |value: &Option<String>| match value.as_deref().filter(|v| !v.is_empty()) {
        None => true,
        Some(text) => js::parse_float(text).is_some_and(|n| n <= 0.0),
    };
    if (needs_live(&wholesale) || needs_live(&setup))
        && let Some((monthly, _upfront, _currency)) =
            live_wholesale(telnyx, phone_number, &country).await?
    {
        wholesale = pick_wholesale(wholesale.as_deref(), Some(&monthly));
    }
    let Some(wholesale) = wholesale.filter(|w| !w.is_empty()) else {
        return Ok(false);
    };
    let monthly = apply_markup(&wholesale, Some(&markup)).unwrap_or(wholesale);
    Ok(major_to_cents(&monthly) >= 1)
}

// ── regulatory requirements ──────────────────────────────────────────────────

/// `fieldTypeOf(raw)`.
fn field_type_of(raw: &Value) -> &'static str {
    let kind = match raw {
        Value::Null => String::new(),
        other => as_text(other).to_lowercase(),
    };
    match kind.as_str() {
        "address" => "address",
        "document" => "document",
        "action" => "action",
        "datetime" => "datetime",
        _ => "textual",
    }
}

/// `row.a ?? row.b ?? fallback` as `asText` reads it.
fn text_or(row: &Value, keys: &[&str], fallback: &str) -> String {
    keys.iter()
        .map(|key| &row[*key])
        .find(|value| !value.is_null())
        .map_or_else(|| fallback.to_owned(), as_text)
}

/// `flattenOrderingRequirements(raw)`.
pub(crate) fn flatten_requirements(raw: &[Value]) -> Vec<Value> {
    fn visit(node: &Value, out: &mut Vec<Value>, seen: &mut Vec<String>) {
        let Value::Object(row) = node else {
            return;
        };
        let record_type = text_or(node, &["record_type"], "");
        let looks_like_type = record_type == "requirement_type"
            || row.get("type").is_some_and(Value::is_string)
            || row.get("field_type").is_some_and(Value::is_string);
        if looks_like_type
            && let Some(id) = row
                .get("id")
                .and_then(Value::as_str)
                .filter(|i| !i.is_empty())
            && !seen.iter().any(|s| s == id)
        {
            seen.push(id.to_owned());
            let mut requirement = Map::new();
            requirement.insert("id".to_owned(), json!(id));
            requirement.insert(
                "name".to_owned(),
                json!(text_or(node, &["name", "title"], "Requirement")),
            );
            requirement.insert(
                "description".to_owned(),
                json!(text_or(node, &["description", "example"], "")),
            );
            let kind = if node["type"].is_null() {
                &node["field_type"]
            } else {
                &node["type"]
            };
            requirement.insert("fieldType".to_owned(), json!(field_type_of(kind)));
            if let Some(example) = node["example"].as_str() {
                requirement.insert("example".to_owned(), json!(example));
            }
            out.push(Value::Object(requirement));
        }
        let nested = row
            .get("requirement_types")
            .and_then(Value::as_array)
            .or_else(|| row.get("requirements").and_then(Value::as_array));
        for child in nested.into_iter().flatten() {
            visit(child, out, seen);
        }
    }
    let mut out = Vec::new();
    let mut seen = Vec::new();
    for item in raw {
        visit(item, &mut out, &mut seen);
    }
    out
}

/// `data ?? []` as the list to walk: `Err` where `for … of` would throw.
fn data_list(response: &Value) -> Result<Vec<Value>, ()> {
    match &response["data"] {
        Value::Null => Ok(Vec::new()),
        Value::Array(items) => Ok(items.clone()),
        _ => Err(()),
    }
}

/// `listOrderingRequirements(env, countryCode, numberType)`: Telnyx's
/// requirements catalog, or its older regulatory endpoint when that fails.
pub(crate) async fn ordering_requirements(
    telnyx: &Telnyx,
    country_code: &str,
    number_type: &str,
) -> Result<Vec<Value>, TelnyxError> {
    let country = country_code.to_uppercase();
    let kind = number_type.replace('-', "_");
    let params = js::search_params(&[
        ("filter[country_code]", &country),
        ("filter[phone_number_type]", &kind),
        ("filter[action]", "ordering"),
    ]);
    let first = telnyx
        .request("GET", &format!("/requirements?{params}"), None)
        .await
        .ok()
        .and_then(|response| data_list(&response).ok());
    if let Some(list) = first {
        return Ok(flatten_requirements(&list));
    }
    let fallback = telnyx
        .request(
            "GET",
            &format!("/phone_number_regulatory_requirements?{params}"),
            None,
        )
        .await?;
    let list = data_list(&fallback)
        .map_err(|()| TelnyxError::BadJson("raw is not iterable".to_owned()))?;
    Ok(flatten_requirements(&list))
}

/// `pickOrder(rows, phoneNumber)`.
fn pick_order(rows: &[Value], phone_number: &str) -> Option<Value> {
    let e164 = weldsuite_kit::validation::js_trim(phone_number);
    rows.iter()
        .find(|o| {
            o["phone_numbers"]
                .as_array()
                .is_some_and(|list| list.iter().any(|n| n["phone_number"] == e164))
        })
        .or_else(|| rows.first())
        .cloned()
}

/// `findNumberOrderForPhone(env, { customerReference, phoneNumber })`.
async fn find_number_order(
    telnyx: &Telnyx,
    customer_reference: &str,
    phone_number: &str,
) -> Result<Option<Value>, TelnyxError> {
    let by_ref = js::search_params(&[
        ("filter[customer_reference]", customer_reference),
        ("page[size]", "20"),
    ]);
    let response = telnyx
        .request("GET", &format!("/number_orders?{by_ref}"), None)
        .await?;
    let rows = response["data"].as_array().cloned().unwrap_or_default();
    if let Some(order) = pick_order(&rows, phone_number) {
        return Ok(Some(order));
    }
    let by_number =
        js::search_params(&[("filter[phone_number]", phone_number), ("page[size]", "20")]);
    let response = telnyx
        .request("GET", &format!("/number_orders?{by_number}"), None)
        .await?;
    let rows = response["data"].as_array().cloned().unwrap_or_default();
    Ok(pick_order(&rows, phone_number))
}

/// `listPendingOrderRequirements(env, args)`: what a paid order still
/// owes, or `None` without an order.
pub(crate) async fn pending_requirements(
    telnyx: &Telnyx,
    customer_reference: &str,
    phone_number: &str,
    country_code: &str,
    number_type: &str,
) -> Result<Option<Value>, TelnyxError> {
    let Some(order) = find_number_order(telnyx, customer_reference, phone_number).await? else {
        return Ok(None);
    };
    let lines = order["phone_numbers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let line = lines
        .iter()
        .find(|n| n["phone_number"] == phone_number)
        .or_else(|| lines.first())
        .cloned()
        .unwrap_or(Value::Null);
    if !js::truthy(&order["id"]) || !js::truthy(&line["id"]) {
        return Ok(None);
    }
    let catalog = ordering_requirements(telnyx, country_code, number_type).await?;
    let raw = line["regulatory_requirements"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let requirements: Vec<Value> = if raw.is_empty() {
        catalog
    } else {
        raw.iter()
            .filter(|r| js::truthy(&r["requirement_id"]))
            .map(|r| {
                let meta = catalog.iter().find(|c| c["id"] == r["requirement_id"]);
                let mut requirement = Map::new();
                requirement.insert("id".to_owned(), r["requirement_id"].clone());
                requirement.insert(
                    "name".to_owned(),
                    meta.map_or(json!("Requirement"), |m| m["name"].clone()),
                );
                requirement.insert(
                    "description".to_owned(),
                    meta.map_or(json!(""), |m| m["description"].clone()),
                );
                let kind = if r["field_type"].is_null() {
                    meta.map_or(Value::Null, |m| m["fieldType"].clone())
                } else {
                    r["field_type"].clone()
                };
                requirement.insert("fieldType".to_owned(), json!(field_type_of(&kind)));
                if let Some(example) = meta.and_then(|m| m.get("example")) {
                    requirement.insert("example".to_owned(), example.clone());
                }
                if js::truthy(&r["field_value"]) {
                    requirement.insert("fieldValue".to_owned(), r["field_value"].clone());
                }
                if let Some(status) = r.get("status") {
                    requirement.insert("status".to_owned(), status.clone());
                }
                Value::Object(requirement)
            })
            .collect()
    };
    Ok(Some(json!({
        "orderId": order["id"],
        "phoneNumberOrderId": line["id"],
        "requirementsMet": line["requirements_met"] == true,
        "requirements": requirements,
    })))
}

/// `submitNumberOrderRequirements(env, { phoneNumberOrderId, values })`:
/// whether Telnyx now has everything.
pub(crate) async fn submit_requirements(
    telnyx: &Telnyx,
    phone_number_order_id: &str,
    values: &[(String, String)],
) -> Result<bool, TelnyxError> {
    let requirements: Vec<Value> = values
        .iter()
        .map(|(id, value)| json!({ "requirement_id": id, "field_value": value }))
        .collect();
    let response = telnyx
        .request(
            "PATCH",
            &format!(
                "/number_order_phone_numbers/{}",
                js::encode_uri_component(phone_number_order_id)
            ),
            Some(Body::Json(
                json!({ "regulatory_requirements": requirements }),
            )),
        )
        .await?;
    Ok(response["data"]["requirements_met"] == true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn available_numbers_map_like_the_worker() {
        let row = json!({
            "phone_number": " +31201234567 ",
            "region_information": [
                { "region_type": "country_code", "region_name": "nl" },
                { "region_type": "rate_center", "region_name": " Amsterdam " },
            ],
            "cost_information": { "monthly_cost": "1.00", "upfront_cost": "0.50" },
            "features": [{ "name": "Voice" }, { "name": "sms" }],
        });
        let mapped = map_available(&row, "DE").expect("mapped");
        assert_eq!(mapped["iso_country"], "NL");
        assert_eq!(mapped["locality"], "Amsterdam");
        assert_eq!(mapped["cost_information"]["currency"], "USD");
        assert_eq!(
            mapped["capabilities"],
            json!({ "voice": true, "sms": true, "mms": false })
        );
        assert!(mapped.get("region").is_none());
        assert!(map_available(&json!({ "phone_number": "" }), "NL").is_none());
    }

    #[test]
    fn markups_apply_like_the_worker() {
        let percent = Markup {
            amount: None,
            percent: Some("20.00".to_owned()),
        };
        let flat = Markup {
            amount: Some(150),
            percent: None,
        };
        assert_eq!(
            apply_markup("1.00", Some(&percent)).as_deref(),
            Some("1.20")
        );
        assert_eq!(apply_markup("10", Some(&flat)).as_deref(), Some("11.50"));
        assert_eq!(apply_markup("abc", Some(&flat)), None);
        assert_eq!(major_to_cents("1.005"), 100);
        assert_eq!(major_to_cents("-1"), 0);
        assert_eq!(normalize_type(" Toll_Free "), "toll-free");
    }

    #[test]
    fn requirements_flatten_like_the_worker() {
        let raw = vec![json!({
            "record_type": "requirement",
            "requirement_types": [
                { "id": "rt_1", "type": "document", "name": "ID", "example": "passport" },
                { "id": "rt_1", "type": "document" },
                { "id": "rt_2", "field_type": "Address", "title": "Where" },
            ],
        })];
        let flat = flatten_requirements(&raw);
        assert_eq!(flat.len(), 2);
        assert_eq!(flat[0]["description"], "passport");
        assert_eq!(flat[1]["fieldType"], "address");
        assert_eq!(flat[1]["name"], "Where");
    }
}
