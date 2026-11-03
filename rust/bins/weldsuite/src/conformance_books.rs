//! Conformance mode's `BOOKS_INTERNAL`: the test's stub of books-api's
//! `BooksInternal` service binding, over HTTP, served by
//! `packages/core/worker-kit/src/testing/service-binding-bridge.ts`:
//!
//! ```text
//! <METHOD> <bridge>/fetch?binding=BOOKS_INTERNAL&path=<path>
//!   X-Workspace-Id: <key>, Content-Type: application/json, the JSON body
//! ```
//!
//! The bridge replays the call into the stub (`binding.fetch` on
//! `https://internal` and the path) and answers with the stub's status and
//! body; a stub that threw is a `502` with `x-binding-error: fetch-threw` and
//! the error's message as the body. Both runs' calls are compared as side
//! effects. A test without the binding gets none, as the worker then skips
//! the journal.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};

use reqwest::Client;
use weldsuite_hr::{BooksInternal, BooksRequest, BooksResponse, RequestBooksInternal};

/// The test's binding through the bridge.
struct BridgedBooks {
    bridge: String,
    client: Client,
}

impl BooksInternal for BridgedBooks {
    fn call<'a>(
        &'a self,
        _db: &'a weldsuite_db::PgPool,
        request: BooksRequest,
    ) -> Pin<Box<dyn Future<Output = Result<BooksResponse, String>> + Send + 'a>> {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(request.method.as_bytes())
                .map_err(|error| error.to_string())?;
            let url = reqwest::Url::parse_with_params(
                &format!("{}/fetch", self.bridge),
                [
                    ("binding", "BOOKS_INTERNAL"),
                    ("path", request.path.as_str()),
                ],
            )
            .map_err(|error| error.to_string())?;
            let response = self
                .client
                .request(method, url)
                .header("content-type", "application/json")
                .header("x-workspace-id", &request.workspace_key)
                .body(request.body.to_string())
                .send()
                .await
                .map_err(|error| error.to_string())?;
            let threw = response.headers().contains_key("x-binding-error");
            let status = response.status().as_u16();
            let body = response.text().await.map_err(|error| error.to_string())?;
            if threw {
                return Err(body);
            }
            Ok(BooksResponse {
                status,
                body,
                created_event: None,
            })
        })
    }
}

/// The bridged bindings, one per bridge URL.
#[derive(Default)]
pub(crate) struct BooksBridges {
    by_url: Mutex<HashMap<String, Arc<dyn BooksInternal>>>,
}

impl BooksBridges {
    /// The test's `BOOKS_INTERNAL` (`services.BOOKS_INTERNAL`), or `None`.
    pub(crate) fn request_books(
        &self,
        services: &HashMap<String, String>,
    ) -> Option<RequestBooksInternal> {
        let url = services.get("BOOKS_INTERNAL")?;
        let mut by_url = self.by_url.lock().unwrap_or_else(PoisonError::into_inner);
        let books = by_url.entry(url.clone()).or_insert_with(|| {
            Arc::new(BridgedBooks {
                bridge: url.trim_end_matches('/').to_owned(),
                client: Client::new(),
            })
        });
        Some(RequestBooksInternal(Arc::clone(books)))
    }
}

/// The test's `BOOKS_INTERNAL` as the integration workers call it
/// (`weldsuite_integrations::ServiceBinding`): the same bridge, any path.
struct BridgedBinding {
    bridge: String,
    binding: &'static str,
    client: Client,
}

impl weldsuite_integrations::ServiceBinding for BridgedBinding {
    fn fetch(
        &self,
        request: weldsuite_integrations::BindingRequest,
    ) -> weldsuite_ports::BoxFuture<'_, Result<weldsuite_integrations::BindingResponse, String>>
    {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(request.method.as_bytes())
                .map_err(|error| error.to_string())?;
            let url = reqwest::Url::parse_with_params(
                &format!("{}/fetch", self.bridge),
                [("binding", self.binding), ("path", request.path.as_str())],
            )
            .map_err(|error| error.to_string())?;
            let mut call = self
                .client
                .request(method, url)
                .header("content-type", "application/json")
                .header("x-workspace-id", &request.workspace_key);
            if let Some(body) = request.body {
                call = call.body(body);
            }
            let response = call.send().await.map_err(|error| error.to_string())?;
            let threw = response.headers().contains_key("x-binding-error");
            let status = response.status().as_u16();
            let body = response.text().await.map_err(|error| error.to_string())?;
            if threw {
                return Err(body);
            }
            Ok(weldsuite_integrations::BindingResponse { status, body })
        })
    }
}

/// The test's `BOOKS_INTERNAL` for the integration workers, or none when
/// the test binds none (the worker then runs without it).
pub(crate) fn integrations_books(
    services: &HashMap<String, String>,
) -> weldsuite_integrations::RequestBooksBinding {
    weldsuite_integrations::RequestBooksBinding(services.get("BOOKS_INTERNAL").map(|url| {
        Arc::new(BridgedBinding {
            bridge: url.trim_end_matches('/').to_owned(),
            binding: "BOOKS_INTERNAL",
            client: Client::new(),
        }) as Arc<dyn weldsuite_integrations::ServiceBinding>
    }))
}

/// The test's `CONNECT_INTERNAL` (connect-api's `ConnectInternal`
/// entrypoint) as the integration workers call it: the same bridge, with
/// the call's own headers (`X-Workspace-Id` or `X-Internal-Workspace-Id`).
struct BridgedConnect {
    bridge: String,
    client: Client,
}

impl weldsuite_integrations::ConnectInternal for BridgedConnect {
    fn fetch(
        &self,
        call: weldsuite_integrations::ConnectCall,
    ) -> weldsuite_ports::BoxFuture<'_, Result<weldsuite_integrations::BindingResponse, String>>
    {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(call.method.as_bytes())
                .map_err(|error| error.to_string())?;
            let url = reqwest::Url::parse_with_params(
                &format!("{}/fetch", self.bridge),
                [
                    ("binding", "CONNECT_INTERNAL"),
                    ("path", call.path.as_str()),
                ],
            )
            .map_err(|error| error.to_string())?;
            let mut request = self.client.request(method, url);
            for (name, value) in &call.headers {
                request = request.header(name.to_ascii_lowercase(), value);
            }
            if let Some(body) = call.body {
                request = request.body(body);
            }
            let response = request.send().await.map_err(|error| error.to_string())?;
            let threw = response.headers().contains_key("x-binding-error");
            let status = response.status().as_u16();
            let body = response.text().await.map_err(|error| error.to_string())?;
            if threw {
                return Err(body);
            }
            Ok(weldsuite_integrations::BindingResponse { status, body })
        })
    }
}

/// The test's `CONNECT_INTERNAL` for the integration workers, or none when
/// the test binds none (the worker then only logs).
pub(crate) fn integrations_connect_internal(
    services: &HashMap<String, String>,
) -> weldsuite_integrations::RequestConnectInternal {
    weldsuite_integrations::RequestConnectInternal(services.get("CONNECT_INTERNAL").map(|url| {
        Arc::new(BridgedConnect {
            bridge: url.trim_end_matches('/').to_owned(),
            client: Client::new(),
        }) as Arc<dyn weldsuite_integrations::ConnectInternal>
    }))
}
