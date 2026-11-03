//! The read and webhook side of the store clients (`WooCommerceClient`,
//! `ShopifyClient`, `PicqerClient` in `@weldsuite/connectors`): `listSync`,
//! `hasUpdatesSince`, `countResource`, `registerWebhooks`, `deleteWebhook`.

use serde_json::{Map, Value, json};
use weldsuite_ports::OutboundHttp;

use crate::clients::{ConnectorError, Picqer, Shopify, Woo, as_text};
use crate::stripe::{ListPage, WebhookCreated};

const PICQER_DEFAULT_LIMIT: u64 = 100;
const SHOPIFY_DEFAULT_LIMIT: u32 = 100;
const WOO_DEFAULT_PER_PAGE: u32 = 100;

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

fn array(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}

/// `Number(text) || fallback` for a header.
fn header_number(value: Option<&str>, fallback: f64) -> f64 {
    let n = value.map_or(fallback, weldsuite_kit::validation::js_number);
    if n.is_nan() || n == 0.0 { fallback } else { n }
}

fn is_catalog_key(key: &str) -> bool {
    matches!(key, "products" | "orders" | "customers")
}

// ── WooCommerce ─────────────────────────────────────────────────────────────

struct WooList {
    items: Vec<Value>,
    page: u32,
    total_pages: f64,
    total: f64,
}

impl Woo {
    /// `listResource(resource, { page, perPage, modifiedAfter, strictModifiedAfter })`.
    async fn list_resource(
        &self,
        http: Option<&OutboundHttp>,
        resource: &str,
        page: u32,
        per_page: u32,
        modified_after: Option<&str>,
        strict: bool,
    ) -> Result<WooList, ConnectorError> {
        let mut after = modified_after.filter(|m| !m.is_empty());
        loop {
            let search = [
                ("page", page.to_string()),
                ("per_page", per_page.to_string()),
                ("modified_after", after.unwrap_or_default().to_owned()),
            ];
            match self
                .request_full(http, "GET", resource, &search, None)
                .await
            {
                Ok((data, headers)) => {
                    let items = array(&data);
                    #[allow(clippy::cast_precision_loss)]
                    let count = items.len() as f64;
                    let total_pages = header_number(header(&headers, "x-wp-totalpages"), 1.0);
                    let total = header(&headers, "x-wp-total").map_or(count, |t| {
                        let n = weldsuite_kit::validation::js_number(t);
                        if n.is_nan() || n == 0.0 { count } else { n }
                    });
                    return Ok(WooList {
                        items,
                        page,
                        total_pages,
                        total,
                    });
                }
                // Customers (and some older WC versions) reject `modified_after`.
                Err(error) if error.status == 400 && after.is_some() && !strict => after = None,
                Err(error) => return Err(error),
            }
        }
    }

    async fn list_variations(
        &self,
        http: Option<&OutboundHttp>,
        product_id: &str,
    ) -> Result<Vec<Value>, ConnectorError> {
        let data = self
            .request(
                http,
                "GET",
                &format!("products/{product_id}/variations"),
                &[("per_page", "100".to_owned())],
                None,
            )
            .await?;
        Ok(array(&data))
    }

    /// `client.listSync(sync, { page, limit, modifiedAfter })`.
    pub async fn list_sync(
        &self,
        http: Option<&OutboundHttp>,
        setting_key: &str,
        page: u32,
        limit: u32,
        modified_after: Option<&str>,
    ) -> Result<ListPage, ConnectorError> {
        if !is_catalog_key(setting_key) {
            return Ok(ListPage::empty());
        }
        let result = self
            .list_resource(http, setting_key, page, limit, modified_after, false)
            .await?;
        let mut items = result.items;
        if setting_key == "products" {
            for item in &mut items {
                let variable = item.get("type").and_then(Value::as_str) == Some("variable")
                    && item.get("id").is_some_and(|id| !id.is_null())
                    && !item.get("_variations").is_some_and(Value::is_array);
                if variable {
                    let id = as_text(&item["id"]);
                    let variations = self.list_variations(http, &id).await?;
                    if let Some(object) = item.as_object_mut() {
                        object.insert("_variations".to_owned(), Value::Array(variations));
                    }
                }
            }
        }
        Ok(ListPage {
            items,
            done: f64::from(result.page) >= result.total_pages,
            next_cursor: None,
        })
    }

    /// `client.hasUpdatesSince(resource, modifiedAfter)`.
    pub async fn has_updates_since(
        &self,
        http: Option<&OutboundHttp>,
        resource: &str,
        modified_after: Option<&str>,
    ) -> Result<bool, ConnectorError> {
        if !is_catalog_key(resource) {
            return Ok(false);
        }
        let strict = modified_after.is_some_and(|m| !m.is_empty());
        match self
            .list_resource(http, resource, 1, 1, modified_after, strict)
            .await
        {
            Ok(page) => Ok(!page.items.is_empty()),
            Err(error) if error.status == 400 && strict => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// `client.countResource(resource)`.
    pub async fn count_resource(
        &self,
        http: Option<&OutboundHttp>,
        resource: &str,
    ) -> Result<f64, ConnectorError> {
        if !is_catalog_key(resource) {
            return Ok(0.0);
        }
        Ok(self
            .list_resource(http, resource, 1, 1, None, false)
            .await?
            .total)
    }

    /// `client.registerWebhooks({ deliveryUrl, secret, topics })`: one per topic.
    pub async fn register_webhooks(
        &self,
        http: Option<&OutboundHttp>,
        delivery_url: &str,
        secret: &str,
        topics: &[String],
    ) -> Result<Vec<WebhookCreated>, ConnectorError> {
        let mut out = Vec::new();
        for topic in topics {
            let data = self
                .request(
                    http,
                    "POST",
                    "webhooks",
                    &[],
                    Some(&json!({
                        "name": format!("WeldSuite {topic}"),
                        "topic": topic,
                        "delivery_url": delivery_url,
                        "secret": secret,
                        "status": "active",
                    })),
                )
                .await?;
            out.push(WebhookCreated {
                id: data
                    .get("id")
                    .map_or_else(|| "undefined".to_owned(), as_text),
                topic: data
                    .get("topic")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                delivery_url: data
                    .get("delivery_url")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                secret: None,
            });
        }
        Ok(out)
    }

    pub async fn delete_webhook(
        &self,
        http: Option<&OutboundHttp>,
        id: &str,
    ) -> Result<(), ConnectorError> {
        self.request(
            http,
            "DELETE",
            &format!("webhooks/{id}"),
            &[("force", "true".to_owned())],
            None,
        )
        .await
        .map(|_| ())
    }
}

/// `WOO_DEFAULT_PER_PAGE`, for callers that list without a limit.
pub const fn woo_default_per_page() -> u32 {
    WOO_DEFAULT_PER_PAGE
}

// ── Shopify ─────────────────────────────────────────────────────────────────

/// `parseNextPageInfo(linkHeader)`.
fn next_page_info(link: Option<&str>) -> Option<String> {
    let link = link.filter(|l| !l.is_empty())?;
    let part = link.split(',').find(|p| p.contains("rel=\"next\""))?;
    let start = part.find('<')?;
    let end = part[start + 1..].find('>')?;
    let url = url::Url::parse(&part[start + 1..start + 1 + end]).ok()?;
    url.query_pairs()
        .find(|(k, _)| k == "page_info")
        .map(|(_, v)| v.into_owned())
}

impl Shopify {
    async fn list_resource(
        &self,
        http: Option<&OutboundHttp>,
        resource: &str,
        limit: Option<u32>,
        page_info: Option<&str>,
        updated_at_min: Option<&str>,
    ) -> Result<(Vec<Value>, Option<String>), ConnectorError> {
        let path = format!("{resource}.json");
        let limit = limit.unwrap_or(SHOPIFY_DEFAULT_LIMIT).to_string();
        let query = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("limit", &limit);
            match page_info.filter(|p| !p.is_empty()) {
                Some(info) => {
                    query.append_pair("page_info", info);
                }
                None => {
                    if let Some(min) = updated_at_min.filter(|m| !m.is_empty()) {
                        query.append_pair("updated_at_min", min);
                    }
                    if resource == "orders" {
                        query.append_pair("status", "any");
                    }
                }
            }
            query.finish()
        };
        let (data, headers) = self
            .request_full(http, "GET", &format!("{path}?{query}"), None)
            .await?;
        let items = data.get(resource).map(array).unwrap_or_default();
        Ok((items, next_page_info(header(&headers, "link"))))
    }

    /// `client.listSync(sync, { cursor, limit, modifiedAfter })`.
    pub async fn list_sync(
        &self,
        http: Option<&OutboundHttp>,
        setting_key: &str,
        cursor: Option<&str>,
        limit: u32,
        modified_after: Option<&str>,
    ) -> Result<ListPage, ConnectorError> {
        let cursor = cursor.filter(|c| !c.is_empty());
        let (items, next) = if is_catalog_key(setting_key) {
            self.list_resource(
                http,
                setting_key,
                Some(limit),
                cursor,
                if cursor.is_some() {
                    None
                } else {
                    modified_after
                },
            )
            .await?
        } else {
            (Vec::new(), None)
        };
        Ok(ListPage {
            items,
            done: next.is_none(),
            next_cursor: next,
        })
    }

    pub async fn has_updates_since(
        &self,
        http: Option<&OutboundHttp>,
        resource: &str,
        since: Option<&str>,
    ) -> Result<bool, ConnectorError> {
        if !is_catalog_key(resource) {
            return Ok(false);
        }
        let (items, _) = self
            .list_resource(http, resource, Some(1), None, since)
            .await?;
        Ok(!items.is_empty())
    }

    pub async fn count_resource(
        &self,
        http: Option<&OutboundHttp>,
        resource: &str,
    ) -> Result<f64, ConnectorError> {
        if !is_catalog_key(resource) {
            return Ok(0.0);
        }
        let path = if resource == "orders" {
            "orders/count.json?status=any".to_owned()
        } else {
            format!("{resource}/count.json")
        };
        let data = self.request(http, "GET", &path, None).await?;
        Ok(data.get("count").and_then(Value::as_f64).unwrap_or(0.0))
    }

    pub async fn register_webhooks(
        &self,
        http: Option<&OutboundHttp>,
        delivery_url: &str,
        topics: &[String],
    ) -> Result<Vec<WebhookCreated>, ConnectorError> {
        let mut out = Vec::new();
        for topic in topics {
            let data = self
                .request(
                    http,
                    "POST",
                    "webhooks.json",
                    Some(&json!({ "webhook": { "topic": topic, "address": delivery_url, "format": "json" } })),
                )
                .await?;
            let hook = data.get("webhook").cloned().unwrap_or(Value::Null);
            out.push(WebhookCreated {
                id: hook
                    .get("id")
                    .map_or_else(|| "undefined".to_owned(), as_text),
                topic: hook
                    .get("topic")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                delivery_url: hook
                    .get("address")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                secret: None,
            });
        }
        Ok(out)
    }

    pub async fn delete_webhook(
        &self,
        http: Option<&OutboundHttp>,
        id: &str,
    ) -> Result<(), ConnectorError> {
        self.request(http, "DELETE", &format!("webhooks/{id}.json"), None)
            .await
            .map(|_| ())
    }
}

// ── Picqer ──────────────────────────────────────────────────────────────────

/// `expandPicqerProductStock(product)`: one inventory row per warehouse.
pub fn expand_picqer_product_stock(product: &Value) -> Vec<Value> {
    let id = product
        .get("idproduct")
        .filter(|v| !v.is_null())
        .or_else(|| product.get("id"))
        .filter(|v| !v.is_null());
    let Some(idproduct) = id else {
        return Vec::new();
    };
    let stock = product.get("stock").map(array).unwrap_or_default();
    let or = |row: &Value, keys: &[&str], fallback: Value| {
        keys.iter()
            .find_map(|k| row.get(*k).filter(|v| !v.is_null()).cloned())
            .unwrap_or(fallback)
    };
    stock
        .iter()
        .map(|row| {
            let idwarehouse = row.get("idwarehouse").cloned();
            let warehouse_text = match &idwarehouse {
                None | Some(Value::Null) => "0".to_owned(),
                Some(v) => as_text(v),
            };
            let mut out = Map::new();
            out.insert(
                "id".to_owned(),
                json!(format!("{}:{warehouse_text}", as_text(idproduct))),
            );
            out.insert("idproduct".to_owned(), idproduct.clone());
            if let Some(w) = idwarehouse {
                out.insert("idwarehouse".to_owned(), w);
            }
            out.insert("stock".to_owned(), or(row, &["stock"], json!(0)));
            out.insert("reserved".to_owned(), or(row, &["reserved"], json!(0)));
            out.insert(
                "freestock".to_owned(),
                or(row, &["freestock", "stock"], json!(0)),
            );
            out.insert(
                "freepickablestock".to_owned(),
                or(row, &["freepickablestock", "freestock"], json!(0)),
            );
            for key in ["productcode", "name", "barcode"] {
                if let Some(v) = product.get(key) {
                    out.insert(key.to_owned(), v.clone());
                }
            }
            Value::Object(out)
        })
        .collect()
}

#[derive(Default)]
struct PicqerOptions<'a> {
    offset: u64,
    limit: u64,
    updated_after: Option<&'a str>,
    sincedate: Option<&'a str>,
}

impl Picqer {
    async fn list_offset(
        &self,
        http: Option<&OutboundHttp>,
        path: &str,
        options: &PicqerOptions<'_>,
    ) -> Result<(Vec<Value>, Option<u64>), ConnectorError> {
        let search = [
            ("offset", options.offset.to_string()),
            (
                "updated_after",
                options.updated_after.unwrap_or_default().to_owned(),
            ),
            (
                "sincedate",
                options.sincedate.unwrap_or_default().to_owned(),
            ),
        ];
        let data = self.request(http, "GET", path, &search, None).await?;
        let items = array(&data);
        let next =
            (items.len() as u64 >= options.limit).then(|| options.offset + items.len() as u64);
        Ok((items, next))
    }

    async fn list_for_setting_key(
        &self,
        http: Option<&OutboundHttp>,
        key: &str,
        options: &PicqerOptions<'_>,
    ) -> Result<(Vec<Value>, Option<u64>), ConnectorError> {
        let path = match key {
            "products" => "products",
            "orders" => "orders",
            "customers" => "customers",
            "warehouses" => "warehouses",
            "locations" => "locations",
            "picklists" => "picklists",
            "suppliers" => "suppliers",
            "purchaseOrders" => "purchaseorders",
            "returns" => "returns",
            "movements" => "movements",
            "inventory" => {
                let (products, next) = self.list_offset(http, "products", options).await?;
                return Ok((
                    products
                        .iter()
                        .flat_map(expand_picqer_product_stock)
                        .collect(),
                    next,
                ));
            }
            "shipments" => {
                let (picklists, next) = self.list_offset(http, "picklists", options).await?;
                let mut shipments = Vec::new();
                for picklist in &picklists {
                    let idpicklist = picklist
                        .get("idpicklist")
                        .filter(|v| !v.is_null())
                        .or_else(|| picklist.get("id"))
                        .cloned();
                    for shipment in picklist.get("shipments").map(array).unwrap_or_default() {
                        let idshipment = shipment
                            .get("idshipment")
                            .filter(|v| !v.is_null())
                            .or_else(|| shipment.get("id"))
                            .cloned();
                        let mut out = shipment.as_object().cloned().unwrap_or_default();
                        match idshipment.as_ref().filter(|v| !v.is_null()) {
                            Some(id) => {
                                out.insert("id".to_owned(), json!(as_text(id)));
                            }
                            None => {
                                out.remove("id");
                            }
                        }
                        match idshipment {
                            Some(v) => out.insert("idshipment".to_owned(), v),
                            None => out.remove("idshipment"),
                        };
                        match idpicklist.clone() {
                            Some(v) => out.insert("idpicklist".to_owned(), v),
                            None => out.remove("idpicklist"),
                        };
                        shipments.push(Value::Object(out));
                    }
                }
                return Ok((shipments, next));
            }
            "stockCounts" => {
                return match self.list_offset(http, "locationstockcounts", options).await {
                    Err(error) if error.status == 404 => Ok((Vec::new(), None)),
                    other => other,
                };
            }
            _ => return Ok((Vec::new(), None)),
        };
        self.list_offset(http, path, options).await
    }

    /// `client.listSync(sync, { page, cursor, limit, modifiedAfter })`.
    pub async fn list_sync(
        &self,
        http: Option<&OutboundHttp>,
        setting_key: &str,
        page: u32,
        cursor: Option<&str>,
        limit: u32,
        modified_after: Option<&str>,
    ) -> Result<ListPage, ConnectorError> {
        let cursor = cursor.filter(|c| !c.is_empty());
        let offset = match cursor {
            Some(cursor) => weldsuite_kit::validation::js_number(cursor),
            None => f64::from((page.max(1) - 1) * limit),
        };
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let offset = if offset.is_finite() && offset >= 0.0 {
            offset as u64
        } else {
            0
        };
        let since = if cursor.is_some() {
            None
        } else {
            modified_after
        };
        let (items, next) = self
            .list_for_setting_key(
                http,
                setting_key,
                &PicqerOptions {
                    offset,
                    limit: u64::from(limit),
                    updated_after: since,
                    sincedate: since,
                },
            )
            .await?;
        Ok(ListPage {
            items,
            done: next.is_none(),
            next_cursor: next.map(|n| n.to_string()),
        })
    }

    pub async fn has_updates_since(
        &self,
        http: Option<&OutboundHttp>,
        resource: &str,
        since: Option<&str>,
    ) -> Result<bool, ConnectorError> {
        let (items, _) = self
            .list_for_setting_key(
                http,
                resource,
                &PicqerOptions {
                    offset: 0,
                    limit: 1,
                    updated_after: since,
                    sincedate: since,
                },
            )
            .await?;
        Ok(!items.is_empty())
    }

    pub async fn count_resource(
        &self,
        http: Option<&OutboundHttp>,
        resource: &str,
    ) -> Result<f64, ConnectorError> {
        let (items, _) = self
            .list_for_setting_key(
                http,
                resource,
                &PicqerOptions {
                    offset: 0,
                    limit: PICQER_DEFAULT_LIMIT,
                    ..PicqerOptions::default()
                },
            )
            .await?;
        #[allow(clippy::cast_precision_loss)]
        Ok(items.len() as f64)
    }

    pub async fn register_webhooks(
        &self,
        http: Option<&OutboundHttp>,
        delivery_url: &str,
        secret: &str,
        topics: &[String],
    ) -> Result<Vec<WebhookCreated>, ConnectorError> {
        let mut out = Vec::new();
        for topic in topics {
            let data = self
                .request(
                    http,
                    "POST",
                    "hooks",
                    &[],
                    Some(&json!({
                        "name": format!("WeldSuite {topic}"),
                        "event": topic,
                        "address": delivery_url,
                        "secret": secret,
                    })),
                )
                .await?;
            let id = data
                .get("idhook")
                .filter(|v| !v.is_null())
                .or_else(|| data.get("id"))
                .filter(|v| !v.is_null())
                .map(as_text)
                .unwrap_or_default();
            if !id.is_empty() {
                out.push(WebhookCreated {
                    id,
                    topic: topic.clone(),
                    delivery_url: delivery_url.to_owned(),
                    secret: None,
                });
            }
        }
        Ok(out)
    }

    pub async fn delete_webhook(
        &self,
        http: Option<&OutboundHttp>,
        id: &str,
    ) -> Result<(), ConnectorError> {
        self.request(http, "DELETE", &format!("hooks/{id}"), &[], None)
            .await
            .map(|_| ())
    }
}
