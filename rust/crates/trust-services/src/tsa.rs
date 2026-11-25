//! An RFC 3161 timestamp authority over HTTP.

use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use weldsuite_pades::{Hash, tsp};
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::TrustError;

/// A TSA at `url`, with optional basic authentication.
#[derive(Clone)]
pub struct HttpTsa {
    pub url: String,
    pub basic: Option<(String, String)>,
    pub http: OutboundHttp,
}

impl std::fmt::Debug for HttpTsa {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpTsa")
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

impl HttpTsa {
    /// A token for a SHA-256 `digest`, checked to cover it.
    pub async fn token(&self, digest: &[u8]) -> Result<Vec<u8>, TrustError> {
        let mut nonce = [0u8; 8];
        let _ = SystemRandom::new().fill(&mut nonce);
        let mut request = HttpRequest {
            method: "POST".to_owned(),
            url: self.url.clone(),
            headers: vec![(
                "content-type".to_owned(),
                "application/timestamp-query".to_owned(),
            )],
            body: Some(tsp::request(digest, &nonce)),
        };
        if let Some((user, password)) = &self.basic {
            let credentials = STANDARD.encode(format!("{user}:{password}"));
            request = request.header("authorization", format!("Basic {credentials}"));
        }
        let response = self
            .http
            .send(request)
            .await
            .map_err(|e| TrustError::new(format!("timestamp authority unreachable: {e}")))?;
        if !response.ok() {
            return Err(TrustError::new(format!(
                "timestamp authority answered {}",
                response.status
            )));
        }
        let token =
            tsp::token_from_response(&response.body).map_err(|e| TrustError::new(e.to_string()))?;
        tsp::verify_token(&token, |hash| {
            if hash == Hash::Sha256 {
                digest.to_vec()
            } else {
                Vec::new()
            }
        })
        .map_err(|e| TrustError::new(e.to_string()))?;
        Ok(token)
    }
}
