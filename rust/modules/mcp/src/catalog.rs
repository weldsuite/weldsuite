//! The catalog `tools/generate.mts` writes from the TypeScript worker:
//! the tools as `tools/list` lists them with their routing into `/v1`, what
//! `initialize` and the resource listings answer, the routes of the worker's
//! own `/v1` copy, and the tenant tables' property order.

use std::collections::HashMap;
use std::sync::LazyLock;

use http::Method;
use serde::Deserialize;
use serde_json::Value;

/// One house tool (`ToolDefinition` in `src/tools/registry.ts`).
#[derive(Debug, Clone)]
pub struct Tool {
    pub name: String,
    /// The scope `requireScope` checks on its route.
    pub scope: String,
    pub method: Method,
    /// `/v1/leads/:id`.
    pub path: String,
    /// Placeholder → input field, in the definition's order.
    pub path_params: Vec<(String, String)>,
    pub exact_id: bool,
    /// The tool as `tools/list` answers it.
    pub definition: Value,
}

/// Everything the generator wrote.
#[derive(Debug)]
pub struct Catalog {
    pub initialize: Value,
    pub resources: Value,
    pub resource_templates: Value,
    pub tools: Vec<Tool>,
    by_name: HashMap<String, usize>,
    /// The worker's `/v1` copy: method and the pattern's segments.
    api_routes: Vec<(String, Vec<String>)>,
    /// Each tenant table's properties in Drizzle's order.
    pub tables: Vec<Vec<String>>,
}

impl Catalog {
    pub fn tool(&self, name: &str) -> Option<&Tool> {
        self.by_name.get(name).map(|&index| &self.tools[index])
    }

    /// Whether the worker's copy of `/v1` mounts a route for `method` at
    /// `path` (Hono's matching: `:param` takes one non-empty segment).
    pub fn api_route(&self, method: &Method, path: &str) -> bool {
        let segments: Vec<&str> = path.split('/').collect();
        self.api_routes.iter().any(|(route_method, pattern)| {
            (route_method == method.as_str() || (method == Method::HEAD && route_method == "GET"))
                && pattern.len() == segments.len()
                && pattern.iter().zip(&segments).all(|(want, got)| {
                    if want.starts_with(':') {
                        !got.is_empty()
                    } else {
                        want == got
                    }
                })
        })
    }
}

impl Tool {
    /// The worker's `/v1` copy answers this tool's route differently from
    /// external-api's (`rust/docs/mcp-server.md`), and that variant is not
    /// ported: the tool is not offered until it is. Creating a project makes
    /// the creator its owner member; creating a product takes no generated
    /// slug; tickets and conversations record `via: 'mcp'`; the copy's
    /// social media routes are its own.
    pub fn variant_pending(&self) -> bool {
        let creates = |path: &str| self.method == Method::POST && self.path == path;
        creates("/v1/projects")
            || creates("/v1/products")
            || self.path.starts_with("/v1/tickets")
            || self.path.starts_with("/v1/conversations")
            || self.path.starts_with("/v1/social-media")
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTool {
    name: String,
    scope: String,
    method: String,
    path: String,
    path_params: Vec<(String, String)>,
    exact_id: bool,
    definition: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCatalog {
    initialize: Value,
    resources: Value,
    resource_templates: Value,
    tools: Vec<RawTool>,
    api_routes: Vec<(String, String)>,
}

fn load() -> Catalog {
    let raw: RawCatalog =
        serde_json::from_str(include_str!("../catalog/tools.json")).expect("catalog/tools.json");
    let tables: HashMap<String, Vec<String>> =
        serde_json::from_str(include_str!("../catalog/tables.json")).expect("catalog/tables.json");
    let tools: Vec<Tool> = raw
        .tools
        .into_iter()
        .map(|tool| Tool {
            name: tool.name,
            scope: tool.scope,
            method: Method::from_bytes(tool.method.as_bytes()).unwrap_or(Method::GET),
            path: tool.path,
            path_params: tool.path_params,
            exact_id: tool.exact_id,
            definition: tool.definition,
        })
        .collect();
    let by_name = tools
        .iter()
        .enumerate()
        .map(|(index, tool)| (tool.name.clone(), index))
        .collect();
    let mut tables: Vec<Vec<String>> = tables.into_values().collect();
    tables.sort();
    Catalog {
        initialize: raw.initialize,
        resources: raw.resources,
        resource_templates: raw.resource_templates,
        tools,
        by_name,
        api_routes: raw
            .api_routes
            .into_iter()
            .map(|(method, path)| (method, path.split('/').map(str::to_owned).collect()))
            .collect(),
        tables,
    }
}

static CATALOG: LazyLock<Catalog> = LazyLock::new(load);

/// The generated catalog.
pub fn catalog() -> &'static Catalog {
    &CATALOG
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_loads() {
        let catalog = catalog();
        assert!(catalog.tools.len() >= 300);
        let tool = catalog.tool("get_contact").expect("get_contact");
        assert_eq!(tool.path, "/v1/people/:id");
        assert_eq!(
            tool.path_params,
            vec![("id".to_owned(), "contactId".to_owned())]
        );
        assert!(catalog.api_route(&Method::GET, "/v1/people/per_1"));
        assert!(!catalog.api_route(&Method::PUT, "/v1/people/per_1"));
        assert!(!catalog.api_route(&Method::GET, "/v1/accounting-contacts"));
        assert!(catalog.tables.len() > 300);
    }
}
