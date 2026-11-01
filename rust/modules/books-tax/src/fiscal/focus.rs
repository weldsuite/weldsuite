//! Focus NFe's REST API v2 (books-api's `br-fiscal/focus-client`): the
//! fiscal document provider of Brazilian NF-e and NFS-e, through the
//! outbound HTTP port. Basic auth with the company token; a non-2xx answer
//! is a [`ProviderError`] carrying Focus' own `codigo` / `mensagem` /
//! `erros`; a short 429 is waited out once.

use base64::Engine;
use serde_json::{Map, Value, json};
use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp, PortError};

/// `FOCUS_BASE_URLS`.
pub(crate) fn base_url(environment: &str) -> &'static str {
    if environment == "producao" {
        "https://api.focusnfe.com.br"
    } else {
        "https://homologacao.focusnfe.com.br"
    }
}

/// `FocusErrorItem`.
#[derive(Debug, Clone)]
pub(crate) struct ErrorItem {
    pub codigo: Option<String>,
    pub mensagem: String,
    pub campo: Option<String>,
    pub correcao: Option<String>,
}

impl ErrorItem {
    pub(crate) fn json(&self) -> Value {
        let mut out = Map::new();
        if let Some(codigo) = &self.codigo {
            out.insert("codigo".into(), json!(codigo));
        }
        out.insert("mensagem".into(), json!(self.mensagem));
        if let Some(campo) = &self.campo {
            out.insert("campo".into(), json!(campo));
        }
        out.insert("correcao".into(), json!(self.correcao));
        Value::Object(out)
    }
}

/// `FiscalProviderError`.
#[derive(Debug, Clone)]
pub(crate) struct ProviderError {
    pub message: String,
    pub status: u16,
    pub codigo: Option<String>,
    pub erros: Vec<ErrorItem>,
}

impl ProviderError {
    fn new(message: impl Into<String>, status: u16) -> Self {
        Self {
            message: message.into(),
            status,
            codigo: None,
            erros: Vec::new(),
        }
    }

    /// The provider refused the content (not down, not the token).
    pub(crate) fn is_rejection(&self) -> bool {
        (400..500).contains(&self.status) && !matches!(self.status, 401 | 403 | 429)
    }

    /// The token is wrong, blocked or not allowed to use this CNPJ.
    pub(crate) fn is_auth_failure(&self) -> bool {
        matches!(self.status, 401 | 403)
    }

    /// The message plus the itemised errors, one line.
    pub(crate) fn detail(&self) -> String {
        let items: Vec<String> = self
            .erros
            .iter()
            .map(|e| match &e.campo {
                Some(campo) => format!("{campo}: {}", e.mensagem),
                None => e.mensagem.clone(),
            })
            .filter(|s| !s.is_empty())
            .collect();
        if items.is_empty() {
            self.message.clone()
        } else {
            format!("{} ({})", self.message, items.join("; "))
        }
    }

    pub(crate) fn erros_json(&self) -> Value {
        Value::Array(self.erros.iter().map(ErrorItem::json).collect())
    }
}

fn as_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

fn to_error_items(value: Option<&Value>) -> Vec<ErrorItem> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .filter(|item| item.is_object())
        .map(|item| ErrorItem {
            codigo: as_string(item.get("codigo")),
            mensagem: as_string(item.get("mensagem")).unwrap_or_else(|| "Unknown error".into()),
            campo: as_string(item.get("campo")),
            correcao: item
                .get("correcao")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
        .collect()
}

/// `mapFocusStatus(status)`.
pub(crate) fn map_status(status: Option<&Value>) -> &'static str {
    match status.and_then(Value::as_str) {
        Some("autorizado") => "authorized",
        Some("cancelado" | "substituido") => "cancelled",
        Some("erro_autorizacao" | "denegado") => "rejected",
        _ => "processing",
    }
}

/// `accessKeyOf(chave)`: the 44 digits of a `NFe…` key.
pub(crate) fn access_key_of(chave: Option<&Value>) -> Option<String> {
    let chave = chave?.as_str()?;
    let digits = if chave.get(..3).is_some_and(|p| p.eq_ignore_ascii_case("nfe")) {
        &chave[3..]
    } else {
        chave
    };
    (digits.len() == 44 && digits.bytes().all(|b| b.is_ascii_digit())).then(|| digits.to_owned())
}

/// The message of a failed call, as JavaScript's `err.message` reads it.
fn port_message(error: &PortError) -> String {
    match error {
        PortError::Backend(inner) => inner.to_string(),
        other => other.to_string(),
    }
}

/// `encodeURIComponent(value)`.
pub(crate) fn encode_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')')
        {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A Focus answer: status, JSON body, headers.
pub(crate) struct FocusResponse {
    pub data: Value,
    pub response: HttpResponse,
}

/// `FocusClient`.
pub(crate) struct Focus {
    pub base_url: &'static str,
    auth: String,
    http: Option<OutboundHttp>,
}

impl Focus {
    pub(crate) fn new(token: &str, environment: &str, http: Option<OutboundHttp>) -> Self {
        let credentials = format!("{token}:");
        Self {
            base_url: base_url(environment),
            auth: format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes())
            ),
            http,
        }
    }

    /// `absoluteUrl(path)`: a `caminho_*` path as an absolute URL.
    pub(crate) fn absolute_url(&self, path: Option<&Value>) -> Option<String> {
        let path = path?.as_str().filter(|p| !p.is_empty())?;
        let lower = path.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            return Some(path.to_owned());
        }
        let slash = if path.starts_with('/') { "" } else { "/" };
        Some(format!("{}{slash}{path}", self.base_url))
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<HttpResponse, ProviderError> {
        let mut url = format!("{}{path}", self.base_url);
        if !query.is_empty() {
            let mut serializer = form_urlencoded::Serializer::new(String::new());
            for (key, value) in query {
                serializer.append_pair(key, value);
            }
            url.push('?');
            url.push_str(&serializer.finish());
        }
        let mut retried = false;
        loop {
            let mut request = HttpRequest::empty(method, url.clone())
                .header("Authorization", self.auth.clone())
                .header("Accept", "application/json");
            if let Some(body) = body {
                request = request.header("Content-Type", "application/json");
                request.body = Some(body.to_string().into_bytes());
            }
            let Some(http) = &self.http else {
                return Err(ProviderError::new(
                    "Focus NFe could not be reached: network error",
                    0,
                ));
            };
            let response = http.send(request).await.map_err(|error| {
                ProviderError::new(
                    format!("Focus NFe could not be reached: {}", port_message(&error)),
                    0,
                )
            })?;
            if response.status == 429 && !retried {
                let wait = response
                    .header("Rate-Limit-Reset")
                    .and_then(weldsuite_books_domain::js::parse_int);
                if let Some(wait) = wait.filter(|w| (0..=3).contains(w)) {
                    retried = true;
                    let millis = u64::try_from(wait * 1000 + 50).unwrap_or(50);
                    tokio::time::sleep(std::time::Duration::from_millis(millis)).await;
                    continue;
                }
            }
            return Ok(response);
        }
    }

    /// `request(method, path, { query, body })`: any non-2xx throws.
    pub(crate) async fn request(
        &self,
        method: &str,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<FocusResponse, ProviderError> {
        let response = self.send(method, path, query, body).await?;
        let text = response.text();
        let parsed: Option<Value> = if text.is_empty() {
            Some(json!({}))
        } else {
            serde_json::from_str(&text).ok()
        };
        if response.ok() {
            let Some(data) = parsed else {
                return Err(ProviderError::new(
                    "Focus NFe answered with something that is not JSON",
                    response.status,
                ));
            };
            return Ok(FocusResponse { data, response });
        }
        if response.status == 401 {
            let mut error = ProviderError::new("Focus NFe rejected the token", 401);
            error.codigo = Some("token_invalido".into());
            return Err(error);
        }
        let body = match &parsed {
            Some(Value::Object(map)) => map.clone(),
            _ => Map::new(),
        };
        let erros = to_error_items(body.get("erros"));
        if response.status == 429 {
            let mut error =
                ProviderError::new("Focus NFe rate limit reached, try again in a moment", 429);
            error.codigo = Some("limite_requisicoes".into());
            return Err(error);
        }
        let message = as_string(body.get("mensagem"))
            .or_else(|| erros.first().map(|e| e.mensagem.clone()))
            .unwrap_or_else(|| {
                if parsed.is_none() {
                    weldsuite_books_domain::js::slice_utf16(&text, 200)
                } else {
                    String::new()
                }
            });
        let message = if message.is_empty() {
            format!("Focus NFe answered {}", response.status)
        } else {
            message
        };
        let codigo =
            as_string(body.get("codigo")).or_else(|| erros.first().and_then(|e| e.codigo.clone()));
        Err(ProviderError {
            message,
            status: response.status,
            codigo,
            erros,
        })
    }

    /// `submit(kind, ref, payload)`.
    pub(crate) async fn submit(
        &self,
        kind: &str,
        reference: &str,
        payload: &Value,
    ) -> Result<FocusResponse, ProviderError> {
        self.request(
            "POST",
            &format!("/v2/{kind}"),
            &[("ref", reference.to_owned())],
            Some(payload),
        )
        .await
    }

    /// `get(kind, ref)`: NF-e with `completa=1`.
    pub(crate) async fn get(&self, kind: &str, reference: &str) -> Result<FocusResponse, ProviderError> {
        let query: Vec<(&str, String)> = if kind == "nfe" {
            vec![("completa", "1".to_owned())]
        } else {
            Vec::new()
        };
        self.request(
            "GET",
            &format!("/v2/{kind}/{}", encode_component(reference)),
            &query,
            None,
        )
        .await
    }

    /// `cancel(kind, ref, justificativa)`.
    pub(crate) async fn cancel(
        &self,
        kind: &str,
        reference: &str,
        justificativa: &str,
    ) -> Result<FocusResponse, ProviderError> {
        self.request(
            "DELETE",
            &format!("/v2/{kind}/{}", encode_component(reference)),
            &[],
            Some(&json!({ "justificativa": justificativa })),
        )
        .await
    }

    /// `correction(ref, correcao)`.
    pub(crate) async fn correction(
        &self,
        reference: &str,
        correcao: &str,
    ) -> Result<FocusResponse, ProviderError> {
        self.request(
            "POST",
            &format!("/v2/nfe/{}/carta_correcao", encode_component(reference)),
            &[],
            Some(&json!({ "correcao": correcao })),
        )
        .await
    }

    pub(crate) async fn list_hooks(&self) -> Result<FocusResponse, ProviderError> {
        self.request("GET", "/v2/hooks", &[], None).await
    }

    pub(crate) async fn create_hook(
        &self,
        event: &str,
        url: &str,
        authorization: &str,
    ) -> Result<FocusResponse, ProviderError> {
        self.request(
            "POST",
            "/v2/hooks",
            &[],
            Some(&json!({ "event": event, "url": url, "authorization": authorization })),
        )
        .await
    }

    pub(crate) async fn delete_hook(&self, id: &str) -> Result<FocusResponse, ProviderError> {
        self.request(
            "DELETE",
            &format!("/v2/hooks/{}", encode_component(id)),
            &[],
            None,
        )
        .await
    }

    /// `listReceived({ cnpj, versao })`: (items, total count, max version).
    pub(crate) async fn list_received(
        &self,
        cnpj: &str,
        versao: Option<f64>,
    ) -> Result<(Vec<Value>, f64, Option<f64>), ProviderError> {
        let mut query = vec![("cnpj", cnpj.to_owned())];
        if let Some(versao) = versao.filter(|v| *v != 0.0 && !v.is_nan()) {
            query.push(("versao", weldsuite_books_domain::js::number_text(versao)));
        }
        let res = self.request("GET", "/v2/nfes_recebidas", &query, None).await?;
        let items = match res.data {
            Value::Array(items) => items,
            _ => Vec::new(),
        };
        let header_int = |name: &str| {
            res.response
                .header(name)
                .and_then(weldsuite_books_domain::js::parse_int)
        };
        #[allow(clippy::cast_precision_loss)]
        let total = header_int("X-Total-Count").map_or(items.len() as f64, |t| t as f64);
        #[allow(clippy::cast_precision_loss)]
        let max = header_int("X-Max-Version").map(|m| m as f64);
        Ok((items, total, max))
    }

    /// `receivedXml(accessKey)`: the XML, `None` on a 404.
    pub(crate) async fn received_xml(&self, access_key: &str) -> Result<Option<String>, ProviderError> {
        let response = self
            .send("GET", &format!("/v2/nfes_recebidas/{access_key}.xml"), &[], None)
            .await?;
        if response.status == 404 {
            return Ok(None);
        }
        if !response.ok() {
            return Err(ProviderError::new(
                format!("Focus NFe could not return the XML ({})", response.status),
                response.status,
            ));
        }
        Ok(Some(response.text()))
    }

    /// `manifest(accessKey, tipo, justificativa)`.
    pub(crate) async fn manifest(
        &self,
        access_key: &str,
        tipo: &str,
        justificativa: Option<&str>,
    ) -> Result<FocusResponse, ProviderError> {
        let mut body = Map::new();
        body.insert("tipo".into(), json!(tipo));
        if let Some(reason) = justificativa.filter(|r| !r.is_empty()) {
            body.insert("justificativa".into(), json!(reason));
        }
        self.request(
            "POST",
            &format!("/v2/nfes_recebidas/{access_key}/manifesto"),
            &[],
            Some(&Value::Object(body)),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_and_keys() {
        assert_eq!(map_status(Some(&json!("autorizado"))), "authorized");
        assert_eq!(map_status(Some(&json!("anything"))), "processing");
        let key = "41261012345678000123550010000000221923094166";
        assert_eq!(
            access_key_of(Some(&json!(format!("NFe{key}")))).as_deref(),
            Some(key)
        );
        let error = ProviderError {
            message: "Erro".into(),
            status: 422,
            codigo: None,
            erros: vec![ErrorItem {
                codigo: None,
                mensagem: "Municipio inexistente".into(),
                campo: Some("codigo_municipio".into()),
                correcao: None,
            }],
        };
        assert!(error.is_rejection());
        assert_eq!(error.detail(), "Erro (codigo_municipio: Municipio inexistente)");
    }
}
