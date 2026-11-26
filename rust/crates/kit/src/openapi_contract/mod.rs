//! The native apps' API contract, checked against what the Rust server
//! answers (feature `openapi-contract`, for tests).
//!
//! The iOS and Android apps generate their API clients from hand-written
//! OpenAPI 3.0 files, one per module, in `apps/mobile-shared/openapi`. The
//! server is the source of truth and nothing else ties the two together, so a
//! module's tests send the requests a file describes through the module's
//! router and hold every answer against it, as strictly as the generated
//! clients decode it: the success status (to the Swift client 201 is not 200),
//! the `{ data }` envelope, every `required` property, `null` only where the
//! file says `nullable`, the types, and enum values within the enum (both
//! clients throw on one they don't know). A property the file doesn't list is
//! fine: the apps ignore it. An error answer must decode as the file's error
//! response.
//!
//! The YAML is read by a small reader of its own (`yaml.rs`), so the workspace
//! needs no YAML crate, and the schemas by a checker that refuses any keyword
//! it doesn't read (`schema.rs`). [`CHECKED_IN`] lists where each file's
//! operations are checked; a test here fails when one has no test.
//!
//! ```ignore
//! let contract = Contract::load("weldpass");
//! let vaults = contract.success(&router, "listVaults", &[], &[], None).await;
//! // … every operation …
//! contract.finish();
//! ```

#![allow(
    clippy::missing_panics_doc,
    reason = "a test helper: a panic is how it reports"
)]

mod schema;
mod yaml;

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, header};
use serde_json::Value;
use tower::ServiceExt;

use self::schema::Schemas;

const METHODS: &[&str] = &["get", "put", "post", "delete", "patch", "head", "options"];

/// Where each file's operations are checked against the server, relative to
/// `rust/`: every operation id of `<module>.yaml` appears, quoted, in one of
/// its files. A file in `apps/mobile-shared/openapi` that isn't listed fails
/// the tests here, as does an operation no listed file names.
pub const CHECKED_IN: &[(&str, &[&str])] = &[
    ("weldpass", &["modules/pass/tests/openapi_contract.rs"]),
    (
        "core",
        &[
            "bins/weldsuite/src/server.rs",
            "modules/core-team/tests/openapi_contract.rs",
        ],
    ),
];

/// `apps/mobile-shared/openapi`, where the OpenAPI files are.
pub fn openapi_dir() -> PathBuf {
    PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../apps/mobile-shared/openapi"
    ))
}

/// One OpenAPI file, and what a test has checked against it so far.
#[derive(Debug)]
pub struct Contract {
    module: String,
    spec: Value,
    /// The operations answered with a success.
    answered: Mutex<BTreeSet<String>>,
    /// Every way an answer didn't fit, reported by [`Contract::finish`].
    problems: Mutex<Vec<String>>,
}

/// An operation of the file.
#[derive(Debug, Clone, Copy)]
struct Operation<'a> {
    method: &'a str,
    path: &'a str,
    node: &'a Value,
    /// The path item, whose `parameters` apply to each of its operations.
    item: &'a Value,
}

/// A request as the file describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// `GET`, `POST`, …
    pub method: String,
    /// The path with its parameters filled in, and the query.
    pub uri: String,
}

/// What the server answered.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub status: u16,
    /// The JSON body; a string when it isn't JSON, `None` when it's empty.
    pub body: Option<Value>,
}

impl Contract {
    /// `apps/mobile-shared/openapi/<module>.yaml`. Panics when it can't be
    /// read, or uses what the checker doesn't read.
    pub fn load(module: &str) -> Self {
        let path = openapi_dir().join(format!("{module}.yaml"));
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        Self::parse(module, &text).unwrap_or_else(|error| panic!("{}:\n{error}", path.display()))
    }

    /// A contract from YAML text; what's wrong with it otherwise.
    pub fn parse(module: &str, text: &str) -> Result<Self, String> {
        let spec = yaml::parse(text)?;
        let contract = Self {
            module: module.to_owned(),
            spec,
            answered: Mutex::new(BTreeSet::new()),
            problems: Mutex::new(Vec::new()),
        };
        let problems = contract.lint();
        if problems.is_empty() {
            Ok(contract)
        } else {
            Err(problems.join("\n"))
        }
    }

    fn schemas(&self) -> Schemas<'_> {
        Schemas::new(&self.spec)
    }

    /// Every operation with its id, by path and method.
    fn operations(&self) -> Vec<(&str, Operation<'_>)> {
        let mut operations = Vec::new();
        let paths = self.spec.get("paths").and_then(Value::as_object);
        for (path, item) in paths.into_iter().flatten() {
            for (method, node) in item.as_object().into_iter().flatten() {
                if !METHODS.contains(&method.as_str()) {
                    continue;
                }
                let id = node
                    .get("operationId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                operations.push((
                    id,
                    Operation {
                        method,
                        path,
                        node,
                        item,
                    },
                ));
            }
        }
        operations
    }

    /// The `operationId` of every operation.
    pub fn operation_ids(&self) -> Vec<String> {
        self.operations()
            .into_iter()
            .map(|(id, _)| id.to_owned())
            .collect()
    }

    fn operation(&self, operation_id: &str) -> Operation<'_> {
        let Some((_, operation)) = self
            .operations()
            .into_iter()
            .find(|(id, _)| *id == operation_id)
        else {
            panic!("{}.yaml has no operation `{operation_id}`", self.module);
        };
        operation
    }

    /// The operation's parameters and its path item's, `$ref`s followed.
    fn parameters<'a>(&'a self, operation: &Operation<'a>) -> Vec<&'a Value> {
        let schemas = self.schemas();
        [operation.item, operation.node]
            .into_iter()
            .filter_map(|node| node.get("parameters").and_then(Value::as_array))
            .flatten()
            .filter_map(|parameter| schemas.deref(parameter).ok())
            .collect()
    }

    /// The JSON schema of a request body or response, `$ref` followed.
    fn json_schema<'a>(&'a self, node: &'a Value) -> Option<&'a Value> {
        let node = self.schemas().deref(node).ok()?;
        node.get("content")?.get("application/json")?.get("schema")
    }

    /// What in the file the checker can't stand behind.
    fn lint(&self) -> Vec<String> {
        let schemas = self.schemas();
        let mut problems = Vec::new();
        let version = self.spec.get("openapi").and_then(Value::as_str);
        if !version.is_some_and(|version| version.starts_with("3.0.")) {
            problems.push(format!(
                "`openapi: {}`: the checker reads OpenAPI 3.0",
                version.unwrap_or("?")
            ));
        }
        let mut seen = BTreeSet::new();
        for (id, operation) in self.operations() {
            let at = format!("{} {}", operation.method, operation.path);
            if id.is_empty() {
                problems.push(format!("{at}: no `operationId`"));
            } else if !seen.insert(id) {
                problems.push(format!("{at}: `operationId: {id}` is used twice"));
            }
            let parameters = self.parameters(&operation);
            for placeholder in placeholders(operation.path) {
                let declared = parameters
                    .iter()
                    .any(|p| p["in"] == "path" && p["name"] == placeholder);
                if !declared {
                    problems.push(format!("{at}: `{{{placeholder}}}` is no path parameter"));
                }
            }
            for parameter in &parameters {
                let name = parameter["name"].as_str().unwrap_or("?");
                if parameter["in"] == "path" && !operation.path.contains(&format!("{{{name}}}")) {
                    problems.push(format!("{at}: path parameter `{name}` is not in the path"));
                }
                match parameter.get("schema") {
                    Some(schema) => schemas.lint(schema, &format!("{at} ?{name}"), &mut problems),
                    None => problems.push(format!("{at}: parameter `{name}` has no schema")),
                }
            }
            if let Some(body) = operation.node.get("requestBody") {
                self.lint_content(body, &format!("{at} request"), &mut problems);
            }
            let responses = operation.node.get("responses").and_then(Value::as_object);
            if responses.is_none_or(|responses| !responses.keys().any(|code| code.starts_with('2')))
            {
                problems.push(format!("{at}: no success response"));
            }
            for (code, response) in responses.into_iter().flatten() {
                self.lint_content(response, &format!("{at} {code}"), &mut problems);
            }
        }
        let components = self
            .spec
            .pointer("/components/schemas")
            .and_then(Value::as_object);
        for (name, schema) in components.into_iter().flatten() {
            schemas.lint(schema, name, &mut problems);
        }
        problems
    }

    /// A request body or response: JSON only, its schema linted.
    fn lint_content(&self, node: &Value, at: &str, problems: &mut Vec<String>) {
        let node = match self.schemas().deref(node) {
            Ok(node) => node,
            Err(error) => {
                problems.push(format!("{at}: {error}"));
                return;
            }
        };
        for (media, content) in node
            .get("content")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            if media != "application/json" {
                problems.push(format!(
                    "{at}: `{media}` is not checked; only application/json"
                ));
            }
            match content.get("schema") {
                Some(schema) => self.schemas().lint(schema, at, problems),
                None => problems.push(format!("{at}: `{media}` has no schema")),
            }
        }
    }

    /// The request for `operation_id`: its method, and its path with `path`
    /// filled in and `query` added. Panics when they don't fit the file.
    pub fn endpoint(
        &self,
        operation_id: &str,
        path: &[(&str, &str)],
        query: &[(&str, &str)],
    ) -> Endpoint {
        let operation = self.operation(operation_id);
        let parameters = self.parameters(&operation);
        let mut uri = operation.path.to_owned();
        for (name, value) in path {
            assert!(
                is_url_safe(value),
                "{operation_id}: path parameter `{name}` = {value:?} needs encoding"
            );
            let placeholder = format!("{{{name}}}");
            assert!(
                uri.contains(&placeholder),
                "{operation_id}: {} has no `{placeholder}`",
                operation.path
            );
            uri = uri.replace(&placeholder, value);
        }
        assert!(
            !uri.contains('{'),
            "{operation_id}: {} needs every path parameter",
            operation.path
        );
        for (index, (name, value)) in query.iter().enumerate() {
            let parameter = parameters
                .iter()
                .find(|p| p["in"] == "query" && p["name"] == *name)
                .unwrap_or_else(|| panic!("{operation_id}: `{name}` is no query parameter"));
            let schema = &parameter["schema"];
            if schema.get("type").is_none_or(|kind| kind == "string") {
                let mut problems = Vec::new();
                self.schemas().check(
                    schema,
                    &Value::String((*value).to_owned()),
                    &format!("?{name}"),
                    &mut problems,
                );
                assert!(
                    problems.is_empty(),
                    "{operation_id}: {}",
                    problems.join("; ")
                );
            }
            assert!(
                is_url_safe(value),
                "{operation_id}: query `{name}` = {value:?} needs encoding"
            );
            uri.push(if index == 0 { '?' } else { '&' });
            uri.push_str(name);
            uri.push('=');
            uri.push_str(value);
        }
        Endpoint {
            method: operation.method.to_uppercase(),
            uri,
        }
    }

    /// Panics when `body` is not the request body the file describes: the
    /// test would prove nothing about what the apps send.
    pub fn check_request(&self, operation_id: &str, body: Option<&Value>) {
        let operation = self.operation(operation_id);
        let request = operation.node.get("requestBody");
        let required = request
            .and_then(|request| self.schemas().deref(request).ok())
            .is_some_and(|request| request["required"] == true);
        match (request.and_then(|request| self.json_schema(request)), body) {
            (None, None) => {}
            (None, Some(_)) => panic!("{operation_id}: the file takes no request body"),
            (Some(_), None) => assert!(!required, "{operation_id}: the file requires a body"),
            (Some(schema), Some(body)) => {
                let mut problems = Vec::new();
                self.schemas().check(schema, body, "$", &mut problems);
                assert!(
                    problems.is_empty(),
                    "{operation_id}: the test's request body doesn't fit the file:\n  {}",
                    problems.join("\n  ")
                );
            }
        }
    }

    /// Why an answer doesn't fit the file; nothing when it does. A success
    /// must be the file's success status exactly; an error, that status's
    /// response or `default`.
    pub fn answer_problems(&self, operation_id: &str, answer: &Answer) -> Vec<String> {
        let operation = self.operation(operation_id);
        let responses = operation.node.get("responses").and_then(Value::as_object);
        let code = answer.status.to_string();
        let documented = |code: &str| responses.and_then(|responses| responses.get(code));
        let response = if let Some(response) = documented(&code) {
            response
        } else if (200..300).contains(&answer.status) {
            let successes: Vec<&str> = responses
                .into_iter()
                .flat_map(|responses| responses.keys())
                .filter(|code| code.starts_with('2'))
                .map(String::as_str)
                .collect();
            return vec![format!(
                "answered {code}; the file's success status is {}",
                successes.join(" or ")
            )];
        } else if let Some(response) = documented("default") {
            response
        } else {
            return vec![format!("answered {code}, which the file doesn't document")];
        };
        match (self.json_schema(response), &answer.body) {
            (None, None) => Vec::new(),
            (None, Some(body)) => vec![format!("a body ({body}) where the file documents none")],
            (Some(_), None) => vec!["an empty body where the file documents one".to_owned()],
            (Some(schema), Some(body)) => {
                let mut problems = Vec::new();
                self.schemas().check(schema, body, "$", &mut problems);
                problems
            }
        }
    }

    fn record(&self, operation_id: &str, answer: &Answer, problems: Vec<String>) {
        let mut recorded = self.problems.lock().unwrap_or_else(PoisonError::into_inner);
        for problem in problems {
            let line = format!(
                "{}.yaml {operation_id} → {}: {problem}",
                self.module, answer.status
            );
            // Shown at once too, in case the test fails before `finish`.
            eprintln!("contract mismatch: {line}");
            recorded.push(line);
        }
    }

    /// Sends the request through `router`: the method and path from the
    /// file, the body as JSON.
    pub async fn send(&self, router: &Router, endpoint: &Endpoint, body: Option<&Value>) -> Answer {
        let mut request = Request::builder()
            .method(endpoint.method.as_str())
            .uri(endpoint.uri.as_str());
        let body = match body {
            Some(body) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = router
            .clone()
            .oneshot(request.body(body).expect("a request"))
            .await
            .expect("an answer");
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("the body");
        Answer {
            status,
            body: parse_body(&bytes),
        }
    }

    /// Sends `operation_id` as the file describes it and expects a success
    /// that fits the file; returns the body (`Value::Null` when empty).
    /// Panics when the request doesn't fit the file or the answer is no
    /// success (nothing after it could run); a body that doesn't fit is
    /// recorded for [`Contract::finish`].
    pub async fn success(
        &self,
        router: &Router,
        operation_id: &str,
        path: &[(&str, &str)],
        query: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Value {
        self.check_request(operation_id, body);
        let endpoint = self.endpoint(operation_id, path, query);
        let answer = self.send(router, &endpoint, body).await;
        assert!(
            (200..300).contains(&answer.status),
            "{}.yaml {operation_id}: {} {} answered {}: {}",
            self.module,
            endpoint.method,
            endpoint.uri,
            answer.status,
            answer
                .body
                .as_ref()
                .map_or_else(String::new, Value::to_string)
        );
        self.answered
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(operation_id.to_owned());
        let problems = self.answer_problems(operation_id, &answer);
        self.record(operation_id, &answer, problems);
        answer.body.unwrap_or(Value::Null)
    }

    /// Sends `body` to `operation_id` unchecked (an invalid request, or one
    /// the server must refuse) and expects an error that decodes as the
    /// file's error response. Returns the answer.
    pub async fn failure(
        &self,
        router: &Router,
        operation_id: &str,
        path: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Answer {
        let endpoint = self.endpoint(operation_id, path, &[]);
        let answer = self.send(router, &endpoint, body).await;
        assert!(
            answer.status >= 400,
            "{}.yaml {operation_id}: {} {} answered {}, not an error",
            self.module,
            endpoint.method,
            endpoint.uri,
            answer.status
        );
        let problems = self.answer_problems(operation_id, &answer);
        self.record(operation_id, &answer, problems);
        answer
    }

    /// Panics with every mismatch recorded, and when an operation of the file
    /// was never answered with a success.
    pub fn finish(&self) {
        let all = self.operation_ids();
        let all: Vec<&str> = all.iter().map(String::as_str).collect();
        self.finish_only(&all);
    }

    /// [`Contract::finish`] for a test that checks only `operation_ids` (the
    /// file's other operations are checked elsewhere).
    pub fn finish_only(&self, operation_ids: &[&str]) {
        let known = self.operation_ids();
        let answered = self
            .answered
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let mut problems = self
            .problems
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        for id in operation_ids {
            if !known.iter().any(|known| known == id) {
                problems.push(format!("{}.yaml has no operation `{id}`", self.module));
            } else if !answered.contains(*id) {
                problems.push(format!(
                    "{}.yaml {id}: never answered with a success",
                    self.module
                ));
            }
        }
        assert!(
            problems.is_empty(),
            "the server's answers don't fit apps/mobile-shared/openapi/{}.yaml, which the native apps are generated from:\n  {}",
            self.module,
            problems.join("\n  ")
        );
    }
}

/// A response body as [`Answer::body`] holds it.
pub fn parse_body(bytes: &[u8]) -> Option<Value> {
    if bytes.is_empty() {
        return None;
    }
    Some(
        serde_json::from_slice(bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(bytes).into_owned())),
    )
}

/// The `{name}`s of a path template.
fn placeholders(path: &str) -> Vec<&str> {
    path.split('{')
        .skip(1)
        .filter_map(|rest| rest.split_once('}').map(|(name, _)| name))
        .collect()
}

fn is_url_safe(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~'))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::{Value, json};

    use super::{Answer, CHECKED_IN, Contract, openapi_dir};

    const SPEC: &str = "\
openapi: 3.0.3
info:
  title: Test
  version: 1.0.0
paths:
  /api/things/{thingId}:
    parameters:
      - name: thingId
        in: path
        required: true
        schema:
          type: string
    get:
      operationId: getThing
      parameters:
        - name: kind
          in: query
          schema:
            type: string
            enum: [a, b]
      responses:
        '200':
          description: The thing.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ThingResponse'
        default:
          $ref: '#/components/responses/Error'
    delete:
      operationId: deleteThing
      responses:
        '204':
          description: Deleted.
        default:
          $ref: '#/components/responses/Error'
components:
  responses:
    Error:
      description: An error.
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
  schemas:
    ThingResponse:
      type: object
      required: [data]
      properties:
        data:
          type: object
          required: [id]
          properties:
            id:
              type: string
    ErrorResponse:
      type: object
      required: [error]
      properties:
        error:
          type: object
          properties:
            code:
              type: string
";

    fn contract() -> Contract {
        Contract::parse("test", SPEC).expect("a contract")
    }

    fn answer(status: u16, body: Option<Value>) -> Answer {
        Answer { status, body }
    }

    #[test]
    fn builds_the_request_from_the_file() {
        let endpoint = contract().endpoint("getThing", &[("thingId", "t_1")], &[("kind", "a")]);
        assert_eq!(endpoint.method, "GET");
        assert_eq!(endpoint.uri, "/api/things/t_1?kind=a");
        // By path, then method: serde_json keeps keys sorted.
        assert_eq!(contract().operation_ids(), ["deleteThing", "getThing"]);
    }

    #[test]
    #[should_panic(expected = "not in the spec's enum")]
    fn refuses_a_query_value_outside_the_enum() {
        contract().endpoint("getThing", &[("thingId", "t_1")], &[("kind", "c")]);
    }

    #[test]
    fn holds_the_status_and_the_body_against_the_file() {
        let contract = contract();
        let ok = answer(200, Some(json!({ "data": { "id": "t_1", "more": 1 } })));
        assert_eq!(
            contract.answer_problems("getThing", &ok),
            Vec::<String>::new()
        );
        assert_eq!(
            contract.answer_problems("getThing", &answer(201, ok.body.clone())),
            ["answered 201; the file's success status is 200"]
        );
        assert_eq!(
            contract.answer_problems("getThing", &answer(200, Some(json!({ "id": "t_1" })))),
            ["$: `data` is missing, and the spec requires it"]
        );
        assert_eq!(
            contract.answer_problems("deleteThing", &answer(204, None)),
            Vec::<String>::new()
        );
        assert_eq!(
            contract.answer_problems("deleteThing", &answer(200, None)),
            ["answered 200; the file's success status is 204"]
        );
        assert_eq!(
            contract.answer_problems("deleteThing", &answer(204, Some(json!({})))),
            ["a body ({}) where the file documents none"]
        );
        let zod = json!({ "success": false, "error": { "name": "ZodError", "issues": [] } });
        assert_eq!(
            contract.answer_problems("getThing", &answer(400, Some(zod))),
            Vec::<String>::new()
        );
        assert_eq!(
            contract.answer_problems("getThing", &answer(404, Some(json!({ "message": "x" })))),
            ["$: `error` is missing, and the spec requires it"]
        );
    }

    #[test]
    #[should_panic(expected = "deleteThing: never answered with a success")]
    fn finish_names_an_operation_never_answered() {
        let contract = contract();
        contract
            .answered
            .lock()
            .expect("lock")
            .insert("getThing".to_owned());
        contract.finish();
    }

    #[test]
    fn refuses_a_file_it_cannot_stand_behind() {
        let broken = SPEC
            .replace("operationId: deleteThing", "operationId: getThing")
            .replace("type: string\n            enum: [a, b]", "oneOf: []");
        let error = Contract::parse("test", &broken).expect_err("broken");
        assert!(
            error.contains("`operationId: getThing` is used twice"),
            "{error}"
        );
        assert!(error.contains("`oneOf` is not read"), "{error}");
    }

    /// Every file the apps are generated from loads, and each of its
    /// operations is named by a test that checks the server against it.
    #[test]
    fn every_operation_the_apps_call_has_a_contract_test() {
        let rust = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut modules: Vec<String> = std::fs::read_dir(openapi_dir())
            .expect("apps/mobile-shared/openapi")
            .filter_map(|entry| {
                let name = entry.ok()?.file_name().to_string_lossy().into_owned();
                name.strip_suffix(".yaml").map(str::to_owned)
            })
            .collect();
        modules.sort();
        assert!(!modules.is_empty(), "no OpenAPI files found");
        let mut missing = Vec::new();
        for module in &modules {
            let contract = Contract::load(module);
            let Some((_, files)) = CHECKED_IN.iter().find(|(listed, _)| listed == module) else {
                missing.push(format!(
                    "{module}.yaml: no test checks it (list it in CHECKED_IN)"
                ));
                continue;
            };
            let sources: Vec<String> = files
                .iter()
                .map(|file| {
                    std::fs::read_to_string(rust.join(file))
                        .unwrap_or_else(|error| panic!("rust/{file}: {error}"))
                })
                .collect();
            for id in contract.operation_ids() {
                let quoted = format!("\"{id}\"");
                if !sources.iter().any(|source| source.contains(&quoted)) {
                    missing.push(format!("{module}.yaml {id}: none of {files:?} checks it"));
                }
            }
        }
        for (listed, _) in CHECKED_IN {
            if !modules.iter().any(|module| module == listed) {
                missing.push(format!(
                    "CHECKED_IN lists {listed}.yaml, which doesn't exist"
                ));
            }
        }
        assert!(missing.is_empty(), "{}", missing.join("\n"));
    }
}
