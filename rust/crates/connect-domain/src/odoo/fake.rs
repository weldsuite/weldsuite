//! A fake Odoo server behind the outbound HTTP port, for tests (this crate's
//! and, with the `testing` feature, the stash push's). It answers both
//! protocols the way Odoo documents them: JSON-RPC on `/jsonrpc`
//! (`common.version`, `common.authenticate`, `object.execute_kw`), JSON-2 on
//! `/json/2/{model}/{method}` (bearer key) and `GET /web/version`, over
//! in-memory records per model. Domains are evaluated for direct fields
//! (`=`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `not in`, with `&`, `|`, `!`);
//! a dotted path (`order_id.write_date`) counts as matching.

#![allow(clippy::missing_panics_doc, clippy::unwrap_used)]

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::{Map, Value, json};
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
};

/// The fake's state: records per model, extra field names per model, and
/// every request it received.
#[derive(Default)]
pub struct FakeOdoo {
    pub major: u32,
    /// Answer `authenticate` with `false` / JSON-2 with a 401.
    pub reject_key: bool,
    /// The `Date` header of every answer.
    pub date: Option<String>,
    /// Answer `/jsonrpc` with a 404 (JSON-RPC removed).
    pub no_jsonrpc: bool,
    /// Models whose every call is an `AccessError`.
    pub forbidden: Vec<String>,
    pub records: Mutex<BTreeMap<String, Vec<Value>>>,
    /// Field names `fields_get` reports besides the records' keys.
    pub extra_fields: Mutex<HashMap<String, Vec<String>>>,
    pub requests: Mutex<Vec<HttpRequest>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl FakeOdoo {
    pub fn new(major: u32) -> Self {
        Self {
            major,
            date: Some("Wed, 18 Nov 2026 12:00:00 GMT".to_owned()),
            ..Self::default()
        }
    }

    /// Adds records to a model.
    pub fn add(&self, model: &str, records: Vec<Value>) {
        lock(&self.records)
            .entry(model.to_owned())
            .or_default()
            .extend(records);
    }

    /// Declares field names a model has without any record carrying them.
    pub fn fields(&self, model: &str, names: &[&str]) {
        lock(&self.extra_fields)
            .entry(model.to_owned())
            .or_default()
            .extend(names.iter().map(|n| (*n).to_owned()));
    }

    /// Replaces a record's fields (by id).
    pub fn update(&self, model: &str, id: i64, values: &Value) {
        let mut records = lock(&self.records);
        if let Some(record) = records
            .get_mut(model)
            .and_then(|list| list.iter_mut().find(|r| r["id"].as_i64() == Some(id)))
            && let (Some(record), Some(values)) = (record.as_object_mut(), values.as_object())
        {
            for (k, v) in values {
                record.insert(k.clone(), v.clone());
            }
        }
    }

    /// Removes a record.
    pub fn remove(&self, model: &str, id: i64) {
        if let Some(list) = lock(&self.records).get_mut(model) {
            list.retain(|r| r["id"].as_i64() != Some(id));
        }
    }

    pub fn all(&self, model: &str) -> Vec<Value> {
        lock(&self.records).get(model).cloned().unwrap_or_default()
    }

    /// The requests' (model, method) pairs, in order (`common` calls as
    /// `("common", method)`).
    pub fn calls(&self) -> Vec<(String, String)> {
        lock(&self.requests)
            .iter()
            .filter_map(|r| {
                if let Some(rest) = r.url.split("/json/2/").nth(1) {
                    let (model, method) = rest.split_once('/')?;
                    return Some((model.to_owned(), method.to_owned()));
                }
                let body: Value = serde_json::from_slice(r.body.as_deref()?).ok()?;
                let params = &body["params"];
                if params["service"] == "object" {
                    Some((
                        params["args"][3].as_str()?.to_owned(),
                        params["args"][4].as_str()?.to_owned(),
                    ))
                } else {
                    Some(("common".to_owned(), params["method"].as_str()?.to_owned()))
                }
            })
            .collect()
    }

    /// The port over this fake.
    pub fn http(self: &Arc<Self>) -> OutboundHttp {
        OutboundHttp(Arc::clone(self) as Arc<dyn DynOutboundHttp>)
    }

    fn respond(&self, status: u16, body: &Value) -> HttpResponse {
        let mut response = HttpResponse::new(status, body.to_string().into_bytes());
        if let Some(date) = &self.date {
            response.headers.push(("date".to_owned(), date.clone()));
        }
        response
    }

    fn field_names(&self, model: &str) -> Option<Vec<String>> {
        let records = lock(&self.records);
        let extra = lock(&self.extra_fields);
        if !records.contains_key(model) && !extra.contains_key(model) {
            return None;
        }
        let mut names: Vec<String> = vec!["id".to_owned(), "write_date".to_owned()];
        for record in records.get(model).into_iter().flatten() {
            if let Some(o) = record.as_object() {
                names.extend(o.keys().cloned());
            }
        }
        names.extend(extra.get(model).cloned().unwrap_or_default());
        names.sort();
        names.dedup();
        Some(names)
    }

    /// One ORM call: the result, or `(status, name, message)`.
    fn dispatch(
        &self,
        model: &str,
        method: &str,
        args: &Map<String, Value>,
    ) -> Result<Value, (u16, String, String)> {
        if self.forbidden.iter().any(|m| m == model) {
            return Err((
                403,
                "odoo.exceptions.AccessError".to_owned(),
                format!("You are not allowed to access ({model}) records."),
            ));
        }
        let Some(names) = self.field_names(model) else {
            return Err((404, "builtins.KeyError".to_owned(), format!("'{model}'")));
        };
        let wanted: Option<Vec<String>> = args.get("fields").and_then(Value::as_array).map(|f| {
            f.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        });
        if let Some(wanted) = &wanted
            && let Some(bad) = wanted.iter().find(|f| !names.contains(f))
        {
            return Err((
                400,
                "builtins.ValueError".to_owned(),
                format!("Invalid field '{bad}' on model '{model}'"),
            ));
        }
        let project = |record: &Value| -> Value {
            let Some(wanted) = &wanted else {
                return record.clone();
            };
            let mut out = Map::new();
            out.insert("id".to_owned(), record["id"].clone());
            for f in wanted {
                out.insert(
                    f.clone(),
                    record.get(f).cloned().unwrap_or(Value::Bool(false)),
                );
            }
            Value::Object(out)
        };
        let records = self.all(model);
        let matching = |domain: &Value| -> Vec<Value> {
            let mut out: Vec<Value> = records
                .iter()
                .filter(|r| matches_domain(r, domain))
                .cloned()
                .collect();
            out.sort_by_key(|r| r["id"].as_i64().unwrap_or(0));
            out
        };
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .map(|l| l as usize);
        match method {
            "fields_get" => Ok(Value::Object(
                names
                    .into_iter()
                    .map(|n| (n, json!({ "type": "char" })))
                    .collect(),
            )),
            "search_read" => {
                let mut found = matching(args.get("domain").unwrap_or(&json!([])));
                if let Some(limit) = limit {
                    found.truncate(limit);
                }
                Ok(Value::Array(found.iter().map(project).collect()))
            }
            "search" => {
                let mut found = matching(args.get("domain").unwrap_or(&json!([])));
                if let Some(limit) = limit {
                    found.truncate(limit);
                }
                Ok(Value::Array(
                    found.iter().map(|r| r["id"].clone()).collect(),
                ))
            }
            "search_count" => Ok(json!(
                matching(args.get("domain").unwrap_or(&json!([]))).len()
            )),
            "read" => {
                let ids: Vec<i64> = args
                    .get("ids")
                    .and_then(Value::as_array)
                    .map(|ids| ids.iter().filter_map(Value::as_i64).collect())
                    .unwrap_or_default();
                Ok(Value::Array(
                    ids.iter()
                        .filter_map(|id| records.iter().find(|r| r["id"].as_i64() == Some(*id)))
                        .map(project)
                        .collect(),
                ))
            }
            "create" => {
                let list = args
                    .get("vals_list")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let mut ids = Vec::new();
                for vals in list {
                    ids.push(self.create(model, vals));
                }
                Ok(json!(ids))
            }
            other => Err((
                400,
                "builtins.AttributeError".to_owned(),
                format!("The method '{other}' does not exist on the model '{model}'"),
            )),
        }
    }

    fn next_id(&self, model: &str) -> i64 {
        lock(&self.records)
            .get(model)
            .into_iter()
            .flatten()
            .filter_map(|r| r["id"].as_i64())
            .max()
            .unwrap_or(0)
            + 1
    }

    /// `create`, with `purchase.order`'s numbering and its `order_line`
    /// `(0, 0, values)` commands.
    fn create(&self, model: &str, vals: Value) -> i64 {
        let id = self.next_id(model);
        let mut record = match vals {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        record.insert("id".to_owned(), json!(id));
        record.insert("write_date".to_owned(), json!("2026-11-18 12:00:00"));
        if model == "purchase.order" {
            let name = format!("P{id:05}");
            record.insert("name".to_owned(), json!(name));
            record
                .entry("state".to_owned())
                .or_insert_with(|| json!("draft"));
            let commands = record.remove("order_line").unwrap_or(json!([]));
            let mut line_ids = Vec::new();
            for command in commands.as_array().into_iter().flatten() {
                if command[0] == 0
                    && let Some(values) = command.get(2)
                {
                    let mut values = values.clone();
                    values["order_id"] = json!([id, name]);
                    line_ids.push(self.create("purchase.order.line", values));
                }
            }
            record.insert("order_line".to_owned(), json!(line_ids));
        }
        self.add(model, vec![Value::Object(record)]);
        id
    }

    fn rpc_error(&self, id: &Value, name: &str, message: &str) -> HttpResponse {
        self.respond(
            200,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": 200,
                    "message": "Odoo Server Error",
                    "data": { "name": name, "debug": "Traceback …", "message": message, "arguments": [message], "context": {} },
                },
            }),
        )
    }

    fn version_info(&self) -> Value {
        json!([self.major, 0, 0, "final", 0, ""])
    }

    fn handle(&self, request: &HttpRequest) -> HttpResponse {
        let body: Value = request
            .body
            .as_deref()
            .and_then(|b| serde_json::from_slice(b).ok())
            .unwrap_or(Value::Null);
        if request.url.ends_with("/web/version") {
            return self.respond(
                200,
                &json!({ "version_info": self.version_info(), "version": format!("{}.0", self.major) }),
            );
        }
        if let Some(rest) = request.url.split("/json/2/").nth(1) {
            let authorized = request
                .headers
                .iter()
                .any(|(n, v)| n.eq_ignore_ascii_case("authorization") && v.starts_with("bearer "));
            if self.reject_key || !authorized {
                return self.respond(
                    401,
                    &json!({ "name": "werkzeug.exceptions.Unauthorized", "message": "Invalid apikey", "arguments": ["Invalid apikey", 401], "context": {}, "debug": "" }),
                );
            }
            let (model, method) = rest.split_once('/').unwrap_or((rest, ""));
            let args = body.as_object().cloned().unwrap_or_default();
            return match self.dispatch(model, method, &args) {
                Ok(result) => self.respond(200, &result),
                Err((status, name, message)) => self.respond(
                    status,
                    &json!({ "name": name, "message": message, "arguments": [message], "context": {}, "debug": "" }),
                ),
            };
        }
        if request.url.ends_with("/jsonrpc") {
            if self.no_jsonrpc {
                return HttpResponse::new(404, b"<html>Not Found</html>".to_vec());
            }
            let id = body["id"].clone();
            let params = &body["params"];
            let method = params["method"].as_str().unwrap_or_default();
            if params["service"] == "common" {
                return match method {
                    "version" => self.respond(
                        200,
                        &json!({ "jsonrpc": "2.0", "id": id, "result": {
                            "server_version": format!("{}.0", self.major),
                            "server_version_info": self.version_info(),
                            "server_serie": format!("{}.0", self.major),
                            "protocol_version": 1,
                        }}),
                    ),
                    "authenticate" => self.respond(
                        200,
                        &json!({ "jsonrpc": "2.0", "id": id, "result": if self.reject_key { json!(false) } else { json!(2) } }),
                    ),
                    _ => self.rpc_error(&id, "builtins.AttributeError", "unknown method"),
                };
            }
            let args = params["args"].as_array().cloned().unwrap_or_default();
            if args.get(2).and_then(Value::as_str).is_none() || self.reject_key {
                return self.rpc_error(&id, "odoo.exceptions.AccessDenied", "Access Denied");
            }
            let model = args.get(3).and_then(Value::as_str).unwrap_or_default();
            let method = args.get(4).and_then(Value::as_str).unwrap_or_default();
            let positional = args
                .get(5)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut named = args
                .get(6)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            // `execute_kw`'s positional arguments, as our client sends them.
            match method {
                "read" => {
                    if let Some(ids) = positional.first() {
                        named.insert("ids".to_owned(), ids.clone());
                    }
                }
                "search_read" | "search" | "search_count" => {
                    if let Some(domain) = positional.first() {
                        named.insert("domain".to_owned(), domain.clone());
                    }
                }
                "create" => {
                    if let Some(vals) = positional.first() {
                        named.insert("vals_list".to_owned(), vals.clone());
                    }
                }
                _ => {}
            }
            return match self.dispatch(model, method, &named) {
                Ok(result) => self.respond(
                    200,
                    &json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                ),
                Err((_, name, message)) => self.rpc_error(&id, &name, &message),
            };
        }
        HttpResponse::new(404, b"<html>Not Found</html>".to_vec())
    }
}

impl DynOutboundHttp for FakeOdoo {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        let response = self.handle(&request);
        lock(&self.requests).push(request);
        Box::pin(std::future::ready(Ok(response)))
    }
}

/// A many2one's id, or the value.
fn scalar(value: &Value) -> &Value {
    match value {
        Value::Array(pair) if pair.len() == 2 && pair[0].is_i64() => &pair[0],
        other => other,
    }
}

fn compare(a: &Value, b: &Value) -> Option<std::cmp::Ordering> {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64()?.partial_cmp(&y.as_f64()?),
        (Value::String(x), Value::String(y)) => Some(x.cmp(y)),
        _ => None,
    }
}

fn leaf(record: &Value, term: &[Value]) -> bool {
    let (Some(field), Some(op), Some(value)) = (
        term.first().and_then(Value::as_str),
        term.get(1).and_then(Value::as_str),
        term.get(2),
    ) else {
        return true;
    };
    if field.contains('.') {
        return true;
    }
    let actual = record.get(field).map_or(&Value::Bool(false), scalar);
    match op {
        "=" => actual == value,
        "!=" => actual != value,
        ">" => compare(actual, value).is_some_and(std::cmp::Ordering::is_gt),
        ">=" => compare(actual, value).is_some_and(std::cmp::Ordering::is_ge),
        "<" => compare(actual, value).is_some_and(std::cmp::Ordering::is_lt),
        "<=" => compare(actual, value).is_some_and(std::cmp::Ordering::is_le),
        "in" => value.as_array().is_some_and(|list| list.contains(actual)),
        "not in" => !value.as_array().is_some_and(|list| list.contains(actual)),
        _ => true,
    }
}

fn eval(record: &Value, tokens: &[Value], at: &mut usize) -> bool {
    let Some(token) = tokens.get(*at) else {
        return true;
    };
    *at += 1;
    match token.as_str() {
        Some("&") => {
            let a = eval(record, tokens, at);
            let b = eval(record, tokens, at);
            a && b
        }
        Some("|") => {
            let a = eval(record, tokens, at);
            let b = eval(record, tokens, at);
            a || b
        }
        Some("!") => !eval(record, tokens, at),
        _ => token.as_array().is_none_or(|t| leaf(record, t)),
    }
}

/// A Polish-notation domain against a record (implicit `&` between the
/// top-level expressions).
pub fn matches_domain(record: &Value, domain: &Value) -> bool {
    let tokens = domain.as_array().cloned().unwrap_or_default();
    let mut at = 0;
    let mut ok = true;
    while at < tokens.len() {
        ok &= eval(record, &tokens, &mut at);
    }
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_evaluate() {
        let r = json!({ "id": 5, "state": "sale", "partner_id": [3, "A"], "write_date": "2026-01-02 00:00:00", "x": false });
        assert!(matches_domain(&r, &json!([])));
        assert!(matches_domain(
            &r,
            &json!([["id", ">", 4], ["partner_id", "=", 3]])
        ));
        assert!(!matches_domain(
            &r,
            &json!(["&", ["id", ">", 4], ["state", "=", "draft"]])
        ));
        assert!(matches_domain(
            &r,
            &json!([
                "|",
                ["state", "=", "draft"],
                ["write_date", ">", "2026-01-01 00:00:00"]
            ])
        ));
        assert!(matches_domain(
            &r,
            &json!([
                ["state", "in", ["sale", "done"]],
                ["x", "=", false],
                ["missing", "=", false]
            ])
        ));
        assert!(matches_domain(
            &r,
            &json!([["order_id.date_order", ">=", "2030-01-01"]])
        ));
        assert!(!matches_domain(&r, &json!(["!", ["id", "=", 5]])));
    }
}
