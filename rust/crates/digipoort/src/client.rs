//! The client: `aanleveren` (deliver a message, get Digipoort's kenmerk) and
//! `getStatussenProces` (every status of a delivery so far), signed with the
//! install's certificate. Transport is the [`OutboundHttp`] port; in
//! production it is a client that presents the same PKIoverheid certificate
//! for mutual TLS, which Digipoort requires on top of the signature.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use time::OffsetDateTime;
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::config::{DigipoortConfig, Mode};
use crate::envelope::{EnvelopeInput, signed_envelope};
use crate::profile;
use crate::signature::{KeyError, Signer};
use crate::xml::{Element, blocks, has_element, text_of};

/// Who the message is about (`identiteitBelanghebbende`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    /// The number (`nummer`): an omzetbelastingnummer, a fiscal number, a KvK number.
    pub number: String,
    /// Its kind (`type`): `BTW`, `Fi`, `KvK`, …
    pub kind: String,
}

/// One message to deliver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivery {
    /// The message type the receiving party expects (`berichtsoort`).
    pub berichtsoort: String,
    /// Our own reference for the delivery (`aanleverkenmerk`).
    pub aanleverkenmerk: String,
    pub belanghebbende: Identity,
    /// `rolBelanghebbende`.
    pub role: String,
    pub file_name: String,
    pub mime_type: String,
    pub content: Vec<u8>,
}

/// What `aanleveren` answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivered {
    /// Digipoort's kenmerk: the key of every status call.
    pub kenmerk: String,
    pub delivered_at: Option<String>,
}

/// One status of a delivery (`StatusResultaat`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub kenmerk: String,
    /// `statuscode`, e.g. `100`.
    pub code: String,
    /// `tijdstempelStatus`.
    pub at: String,
    /// `statusomschrijving`.
    pub description: String,
    /// `statusFoutcode/foutcode`.
    pub error_code: Option<String>,
    /// `statusFoutcode/foutbeschrijving`.
    pub error_description: Option<String>,
    /// `statusdetails`: the receiving party's own answer, when it gave one.
    pub details: Option<String>,
}

/// Why a call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DigipoortError {
    /// Digipoort refused the request with a SOAP fault.
    Fault {
        code: Option<String>,
        message: String,
        http_status: u16,
    },
    /// A non-2xx answer without a fault.
    Http { status: u16 },
    /// Digipoort could not be reached.
    Transport(String),
    /// The answer lacked what it should hold.
    Malformed(String),
    /// The message could not be signed.
    Signing(String),
}

impl std::fmt::Display for DigipoortError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Fault { code, message, .. } => match code {
                Some(code) => write!(f, "Digipoort refused the message ({code}): {message}"),
                None => write!(f, "Digipoort refused the message: {message}"),
            },
            Self::Http { status } => write!(f, "Digipoort answered HTTP {status}"),
            Self::Transport(error) => write!(f, "Digipoort could not be reached: {error}"),
            Self::Malformed(error) => write!(f, "Digipoort's answer was not understood: {error}"),
            Self::Signing(error) => write!(f, "The message could not be signed: {error}"),
        }
    }
}

impl std::error::Error for DigipoortError {}

impl From<KeyError> for DigipoortError {
    fn from(error: KeyError) -> Self {
        Self::Signing(error.0)
    }
}

type Clock = Arc<dyn Fn() -> OffsetDateTime + Send + Sync>;
type Ids = Arc<dyn Fn() -> String + Send + Sync>;

struct Inner {
    mode: Mode,
    aanlever_url: String,
    status_url: String,
    signer: Signer,
    http: OutboundHttp,
    now: Clock,
    message_id: Ids,
}

/// The install's Digipoort connection. Cheap to clone.
#[derive(Clone)]
pub struct Digipoort {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Digipoort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Digipoort")
            .field("mode", &self.inner.mode)
            .field("aanlever_url", &self.inner.aanlever_url)
            .finish_non_exhaustive()
    }
}

impl Digipoort {
    /// A connection on `config`, sending through `http` (which must present
    /// the same certificate for mutual TLS).
    pub fn new(config: &DigipoortConfig, http: OutboundHttp) -> Result<Self, KeyError> {
        let signer = Signer::from_pem(&config.certificate_pem, &config.private_key_pem)?;
        Ok(Self {
            inner: Arc::new(Inner {
                mode: config.mode,
                aanlever_url: config.aanlever_url.clone(),
                status_url: config.status_url.clone(),
                signer,
                http,
                now: Arc::new(OffsetDateTime::now_utc),
                message_id: Arc::new(|| uuid::Uuid::new_v4().to_string()),
            }),
        })
    }

    /// The same connection with a fixed clock and message ids (tests).
    #[must_use]
    pub fn with_clock(
        &self,
        now: impl Fn() -> OffsetDateTime + Send + Sync + 'static,
        message_id: impl Fn() -> String + Send + Sync + 'static,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                mode: self.inner.mode,
                aanlever_url: self.inner.aanlever_url.clone(),
                status_url: self.inner.status_url.clone(),
                signer: self.inner.signer.clone(),
                http: self.inner.http.clone(),
                now: Arc::new(now),
                message_id: Arc::new(message_id),
            }),
        }
    }

    pub fn mode(&self) -> Mode {
        self.inner.mode
    }

    fn element(name: &str) -> Element {
        Element::new(profile::TYPES_NS, "ns", name)
    }

    async fn call(&self, url: &str, action: &str, body: Element) -> Result<String, DigipoortError> {
        let envelope = signed_envelope(
            &self.inner.signer,
            EnvelopeInput {
                action,
                to: url,
                body,
                now: (self.inner.now)(),
                message_id: &(self.inner.message_id)(),
            },
        )?;
        let request = HttpRequest {
            method: "POST".to_owned(),
            url: url.to_owned(),
            headers: vec![
                (
                    "Content-Type".to_owned(),
                    "text/xml; charset=utf-8".to_owned(),
                ),
                ("SOAPAction".to_owned(), format!("\"{action}\"")),
            ],
            body: Some(envelope.into_bytes()),
        };
        let response = self
            .inner
            .http
            .send(request)
            .await
            .map_err(|e| DigipoortError::Transport(e.to_string()))?;
        let text = String::from_utf8_lossy(&response.body).into_owned();
        if has_element(&text, "Fault") {
            let message = text_of(&text, "foutbeschrijving")
                .or_else(|| text_of(&text, "faultstring"))
                .unwrap_or_else(|| "SOAP fault".to_owned());
            return Err(DigipoortError::Fault {
                code: text_of(&text, "foutcode"),
                message,
                http_status: response.status,
            });
        }
        if !(200..300).contains(&response.status) {
            return Err(DigipoortError::Http {
                status: response.status,
            });
        }
        Ok(text)
    }

    /// `aanleveren`: deliver a message.
    pub async fn deliver(&self, delivery: &Delivery) -> Result<Delivered, DigipoortError> {
        let el = Self::element;
        let body = el("aanleverRequest")
            .child(el("berichtsoort").text(&delivery.berichtsoort))
            .child(el("aanleverkenmerk").text(&delivery.aanleverkenmerk))
            .child(
                el("identiteitBelanghebbende")
                    .child(el("nummer").text(&delivery.belanghebbende.number))
                    .child(el("type").text(&delivery.belanghebbende.kind)),
            )
            .child(el("rolBelanghebbende").text(&delivery.role))
            .child(
                el("berichtInhoud")
                    .child(el("mimeType").text(&delivery.mime_type))
                    .child(el("bestandsnaam").text(&delivery.file_name))
                    .child(el("inhoud").text(STANDARD.encode(&delivery.content))),
            )
            .child(el("autorisatieAdres").text(profile::NO_AUTHORISATION_ADDRESS));
        let answer = self
            .call(&self.inner.aanlever_url, profile::AANLEVER_ACTION, body)
            .await?;
        let kenmerk = text_of(&answer, "kenmerk")
            .filter(|k| !k.is_empty())
            .ok_or_else(|| {
                DigipoortError::Malformed("no kenmerk in the aanleverResponse".to_owned())
            })?;
        Ok(Delivered {
            kenmerk,
            delivered_at: text_of(&answer, "tijdstempelAangeleverd"),
        })
    }

    /// `getStatussenProces`: every status of the delivery so far, oldest first.
    pub async fn statuses(&self, kenmerk: &str) -> Result<Vec<StatusEntry>, DigipoortError> {
        let el = Self::element;
        let body = el("getStatussenProcesRequest")
            .child(el("kenmerk").text(kenmerk))
            .child(el("autorisatieAdres").text(profile::NO_AUTHORISATION_ADDRESS));
        let answer = self
            .call(&self.inner.status_url, profile::STATUS_ACTION, body)
            .await?;
        Ok(parse_statuses(&answer, kenmerk))
    }
}

/// The `StatusResultaat` blocks of a `getStatussenProcesResponse`.
pub fn parse_statuses(answer: &str, kenmerk: &str) -> Vec<StatusEntry> {
    blocks(answer, "StatusResultaat")
        .into_iter()
        .map(|block| {
            let error = blocks(block, "statusFoutcode").into_iter().next();
            StatusEntry {
                kenmerk: text_of(block, "kenmerk").unwrap_or_else(|| kenmerk.to_owned()),
                code: text_of(block, "statuscode").unwrap_or_default(),
                at: text_of(block, "tijdstempelStatus").unwrap_or_default(),
                description: text_of(block, "statusomschrijving").unwrap_or_default(),
                error_code: error
                    .and_then(|e| text_of(e, "foutcode"))
                    .filter(|c| !c.is_empty()),
                error_description: error
                    .and_then(|e| text_of(e, "foutbeschrijving"))
                    .filter(|d| !d.is_empty()),
                details: text_of(block, "statusdetails").filter(|d| !d.is_empty()),
            }
        })
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Mutex;

    use weldsuite_ports::{BoxFuture, DynOutboundHttp, HttpResponse, PortError};

    use super::*;
    use crate::signature::tests::test_signer;

    /// Answers in order and records what was sent.
    pub(crate) struct Recorded {
        pub(crate) answers: Mutex<Vec<(u16, String)>>,
        pub(crate) sent: Mutex<Vec<HttpRequest>>,
    }

    impl DynOutboundHttp for Recorded {
        fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
            self.sent.lock().expect("lock").push(request);
            let (status, body) = self.answers.lock().expect("lock").remove(0);
            Box::pin(std::future::ready(Ok(HttpResponse::new(
                status,
                body.into_bytes(),
            ))))
        }
    }

    pub(crate) fn client(answers: Vec<(u16, &str)>) -> (Digipoort, Arc<Recorded>) {
        let (signer, _) = test_signer();
        let recorded = Arc::new(Recorded {
            answers: Mutex::new(
                answers
                    .into_iter()
                    .map(|(s, b)| (s, b.to_owned()))
                    .collect(),
            ),
            sent: Mutex::new(Vec::new()),
        });
        let digipoort = Digipoort {
            inner: Arc::new(Inner {
                mode: Mode::Preprod,
                aanlever_url: "https://example.test/aanleveren".to_owned(),
                status_url: "https://example.test/status".to_owned(),
                signer,
                http: OutboundHttp(recorded.clone()),
                now: Arc::new(|| time::macros::datetime!(2026-11-22 10:00 UTC)),
                message_id: Arc::new(|| "22222222-2222-4222-8222-222222222222".to_owned()),
            }),
        };
        (digipoort, recorded)
    }

    fn delivery() -> Delivery {
        Delivery {
            berichtsoort: "Omzetbelasting".to_owned(),
            aanleverkenmerk: "OB-vat_1".to_owned(),
            belanghebbende: Identity {
                number: "001234567B01".to_owned(),
                kind: "BTW".to_owned(),
            },
            role: "Intermediair".to_owned(),
            file_name: "btw-aangifte.xbrl".to_owned(),
            mime_type: "text/xml".to_owned(),
            content: b"<xbrl/>".to_vec(),
        }
    }

    const AANLEVER_OK: &str = "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><aanleverResponse xmlns=\"http://logius.nl/digipoort/koppelvlakservices/1.2/\"><kenmerk>a1b2c3</kenmerk><tijdstempelAangeleverd>2026-11-22T11:00:01.000+01:00</tijdstempelAangeleverd></aanleverResponse></s:Body></s:Envelope>";

    #[tokio::test]
    async fn delivers_a_signed_message_and_reads_the_kenmerk() {
        let (digipoort, recorded) = client(vec![(200, AANLEVER_OK)]);
        let delivered = digipoort.deliver(&delivery()).await.expect("delivered");
        assert_eq!(delivered.kenmerk, "a1b2c3");
        assert_eq!(
            delivered.delivered_at.as_deref(),
            Some("2026-11-22T11:00:01.000+01:00")
        );
        let sent = recorded.sent.lock().expect("lock");
        let request = &sent[0];
        assert_eq!(request.url, "https://example.test/aanleveren");
        assert!(request.headers.contains(&(
            "SOAPAction".to_owned(),
            format!("\"{}\"", profile::AANLEVER_ACTION)
        )));
        let body = String::from_utf8(request.body.clone().expect("body")).expect("utf8");
        assert!(body.contains("<ns:berichtsoort>Omzetbelasting</ns:berichtsoort>"));
        assert!(body.contains(
            "<ns:identiteitBelanghebbende><ns:nummer>001234567B01</ns:nummer><ns:type>BTW</ns:type></ns:identiteitBelanghebbende>"
        ));
        assert!(body.contains(&format!(
            "<ns:inhoud>{}</ns:inhoud>",
            STANDARD.encode("<xbrl/>")
        )));
        assert!(body.contains("<wsa:To xmlns:wsa=\"http://www.w3.org/2005/08/addressing\""));
        assert!(body.contains("<ds:SignatureValue>"));
    }

    #[tokio::test]
    async fn turns_faults_and_errors_into_errors() {
        let fault = "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>Bericht afgekeurd</faultstring><detail><aanleverFault xmlns=\"http://logius.nl/digipoort/koppelvlakservices/1.2/\"><foutcode>AFL-400</foutcode><foutbeschrijving>Berichtsoort onbekend &amp; ongeldig</foutbeschrijving></aanleverFault></detail></s:Fault></s:Body></s:Envelope>";
        let (digipoort, _) = client(vec![(500, fault), (503, "busy"), (200, "<ok/>")]);
        assert_eq!(
            digipoort.deliver(&delivery()).await,
            Err(DigipoortError::Fault {
                code: Some("AFL-400".to_owned()),
                message: "Berichtsoort onbekend & ongeldig".to_owned(),
                http_status: 500,
            })
        );
        assert_eq!(
            digipoort.deliver(&delivery()).await,
            Err(DigipoortError::Http { status: 503 })
        );
        assert!(matches!(
            digipoort.deliver(&delivery()).await,
            Err(DigipoortError::Malformed(_))
        ));
    }

    #[tokio::test]
    async fn reads_every_status() {
        let answer = "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><getStatussenProcesResponse xmlns=\"http://logius.nl/digipoort/koppelvlakservices/1.2/\"><getStatussenProcesResult><StatusResultaat><kenmerk>a1b2c3</kenmerk><statuscode>100</statuscode><tijdstempelStatus>2026-11-22T11:00:01</tijdstempelStatus><statusomschrijving>Aanleveren gelukt</statusomschrijving></StatusResultaat><StatusResultaat><kenmerk>a1b2c3</kenmerk><statuscode>510</statuscode><tijdstempelStatus>2026-11-22T11:05:00</tijdstempelStatus><statusomschrijving>Validatie mislukt</statusomschrijving><statusFoutcode><foutcode>X1</foutcode><foutbeschrijving>Fout &amp; meer</foutbeschrijving></statusFoutcode></StatusResultaat></getStatussenProcesResult></getStatussenProcesResponse></s:Body></s:Envelope>";
        let (digipoort, recorded) = client(vec![(200, answer)]);
        let statuses = digipoort.statuses("a1b2c3").await.expect("statuses");
        assert_eq!(statuses.len(), 2);
        assert_eq!(statuses[0].code, "100");
        assert_eq!(statuses[0].error_code, None);
        assert_eq!(statuses[1].code, "510");
        assert_eq!(statuses[1].error_code.as_deref(), Some("X1"));
        assert_eq!(
            statuses[1].error_description.as_deref(),
            Some("Fout & meer")
        );
        let sent = recorded.sent.lock().expect("lock");
        assert_eq!(sent[0].url, "https://example.test/status");
        let body = String::from_utf8(sent[0].body.clone().expect("body")).expect("utf8");
        assert!(body.contains("<ns:kenmerk>a1b2c3</ns:kenmerk>"));
    }
}
