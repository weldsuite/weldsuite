//! Validation material for the DSS (B-LT): every certificate of the
//! chains, and for each certificate below its root an OCSP answer saying it
//! is good, or else the issuer's CRL. A responder that can't be reached is
//! logged and skipped: the document then stays at B-T for that certificate,
//! which is still valid, only harder to validate years later.

use weldsuite_pades::ocsp::{self, CertStatus};
use weldsuite_pades::{Certificate, ValidationData};
use weldsuite_ports::{HttpRequest, OutboundHttp};

/// Collect what validates `chains` (each leaf first).
pub async fn collect(http: Option<&OutboundHttp>, chains: &[Vec<Certificate>]) -> ValidationData {
    let mut data = ValidationData::default();
    for chain in chains {
        for cert in chain {
            if !data.certificates.contains(&cert.der) {
                data.certificates.push(cert.der.clone());
            }
        }
    }
    let Some(http) = http else {
        return data;
    };
    for chain in chains {
        for (i, cert) in chain.iter().enumerate() {
            let Some(issuer) = chain.get(i + 1) else {
                continue;
            };
            if cert.extensions.ocsp_no_check {
                continue;
            }
            if let Some(answer) = ocsp_answer(http, cert, issuer).await {
                data.ocsps.push(answer);
                continue;
            }
            for url in &cert.extensions.crl_urls {
                match http.send(HttpRequest::empty("GET", url.clone())).await {
                    Ok(response) if response.ok() && !response.body.is_empty() => {
                        data.crls.push(response.body);
                        break;
                    }
                    Ok(response) => {
                        tracing::warn!(url, status = response.status, "sign: CRL not fetched");
                    }
                    Err(error) => tracing::warn!(url, %error, "sign: CRL not fetched"),
                }
            }
        }
    }
    data
}

async fn ocsp_answer(
    http: &OutboundHttp,
    cert: &Certificate,
    issuer: &Certificate,
) -> Option<Vec<u8>> {
    let request = ocsp::request(cert, issuer).ok()?;
    for url in &cert.extensions.ocsp_urls {
        let sent = http
            .send(HttpRequest {
                method: "POST".to_owned(),
                url: url.clone(),
                headers: vec![(
                    "content-type".to_owned(),
                    "application/ocsp-request".to_owned(),
                )],
                body: Some(request.clone()),
            })
            .await;
        match sent {
            Ok(response) if response.ok() => match ocsp::status(&response.body) {
                Ok(CertStatus::Good) => return Some(response.body),
                Ok(status) => {
                    tracing::error!(
                        url,
                        ?status,
                        serial = cert.serial_hex(),
                        "sign: OCSP says the certificate is not good"
                    );
                    return None;
                }
                Err(error) => tracing::warn!(url, %error, "sign: unreadable OCSP answer"),
            },
            Ok(response) => tracing::warn!(url, status = response.status, "sign: OCSP refused"),
            Err(error) => tracing::warn!(url, %error, "sign: OCSP unreachable"),
        }
    }
    None
}
