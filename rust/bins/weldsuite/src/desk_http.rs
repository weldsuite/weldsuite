//! WeldDesk's third-party HTTP calls (Discord, Slack) over reqwest.

use weldsuite_desk_domain::http::{DeskHttp, HttpRequest, HttpResponse};
use weldsuite_ports::BoxFuture;

/// [`DeskHttp`] over a shared reqwest client.
#[derive(Debug, Clone, Default)]
pub(crate) struct ReqwestDeskHttp {
    client: reqwest::Client,
}

impl DeskHttp for ReqwestDeskHttp {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, String>> {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(request.method.as_bytes())
                .map_err(|error| error.to_string())?;
            let mut outgoing = self.client.request(method, &request.url);
            for (name, value) in &request.headers {
                outgoing = outgoing.header(name.as_str(), value.as_str());
            }
            if let Some(body) = request.body {
                outgoing = outgoing.body(body);
            }
            let response = outgoing.send().await.map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let body = response.text().await.map_err(|error| error.to_string())?;
            Ok(HttpResponse { status, body })
        })
    }
}
