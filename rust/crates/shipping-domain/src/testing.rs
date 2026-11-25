//! A carrier double for the adapters' tests: answers by `METHOD URL` (exact,
//! or by prefix), records every request.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
};

use crate::types::{Address, LabelFormat, PieceSpec, ShipmentOptions, ShipmentRequest};

struct Answer {
    key: String,
    prefix: bool,
    status: u16,
    body: Vec<u8>,
}

/// The fake carrier.
#[derive(Default)]
pub(crate) struct Fake {
    answers: Mutex<Vec<Answer>>,
    calls: Mutex<Vec<HttpRequest>>,
}

impl Fake {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub(crate) fn outbound(self: &Arc<Self>) -> OutboundHttp {
        OutboundHttp(Arc::clone(self) as Arc<dyn DynOutboundHttp>)
    }

    fn push(&self, key: &str, prefix: bool, status: u16, body: Vec<u8>) {
        if let Ok(mut answers) = self.answers.lock() {
            answers.push(Answer {
                key: key.to_owned(),
                prefix,
                status,
                body,
            });
        }
    }

    /// Answer `METHOD URL` with JSON. Several answers for one key are used
    /// in order; the last one stays.
    pub(crate) fn answer(&self, key: &str, status: u16, body: &Value) {
        self.push(key, false, status, body.to_string().into_bytes());
    }

    pub(crate) fn answer_bytes(&self, key: &str, status: u16, body: &[u8]) {
        self.push(key, false, status, body.to_vec());
    }

    /// Answer every `METHOD URL` that starts with `prefix`.
    pub(crate) fn answer_prefix(&self, prefix: &str, status: u16, body: &Value) {
        self.push(prefix, true, status, body.to_string().into_bytes());
    }

    fn calls_to(&self, key: &str) -> Vec<HttpRequest> {
        self.calls
            .lock()
            .map(|calls| {
                calls
                    .iter()
                    .filter(|r| format!("{} {}", r.method, r.url) == key)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The JSON body of the last request to `METHOD URL`.
    pub(crate) fn body_of(&self, key: &str) -> Value {
        self.bodies_of(key).pop().unwrap_or(Value::Null)
    }

    /// Every JSON body sent to `METHOD URL`, in order.
    pub(crate) fn bodies_of(&self, key: &str) -> Vec<Value> {
        self.calls_to(key)
            .iter()
            .map(|r| {
                r.body
                    .as_deref()
                    .and_then(|b| serde_json::from_slice(b).ok())
                    .unwrap_or(Value::Null)
            })
            .collect()
    }

    /// A header of the last request to `METHOD URL`.
    pub(crate) fn header_of(&self, key: &str, name: &str) -> Option<String> {
        self.calls_to(key).pop().and_then(|r| {
            r.headers
                .iter()
                .find(|(n, _)| n.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.clone())
        })
    }

    /// Whether any request's URL contains `fragment`.
    pub(crate) fn called_with(&self, fragment: &str) -> bool {
        self.calls
            .lock()
            .is_ok_and(|calls| calls.iter().any(|r| r.url.contains(fragment)))
    }

    /// How many requests went to URLs starting with `prefix` (`METHOD URL`).
    pub(crate) fn count(&self, prefix: &str) -> usize {
        self.calls.lock().map_or(0, |calls| {
            calls
                .iter()
                .filter(|r| format!("{} {}", r.method, r.url).starts_with(prefix))
                .count()
        })
    }
}

impl DynOutboundHttp for Fake {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        let key = format!("{} {}", request.method, request.url);
        if let Ok(mut calls) = self.calls.lock() {
            calls.push(request);
        }
        let answer = self.answers.lock().ok().and_then(|mut answers| {
            let matching: Vec<usize> = answers
                .iter()
                .enumerate()
                .filter(|(_, a)| {
                    if a.prefix {
                        key.starts_with(&a.key)
                    } else {
                        key == a.key
                    }
                })
                .map(|(i, _)| i)
                .collect();
            let first = *matching.first()?;
            let a = &answers[first];
            let response = HttpResponse::new(a.status, a.body.clone());
            if matching.len() > 1 {
                answers.remove(first);
            }
            Some(response)
        });
        let response = answer
            .unwrap_or_else(|| HttpResponse::new(599, format!("no answer for {key}").into_bytes()));
        Box::pin(std::future::ready(Ok(response)))
    }
}

pub(crate) fn piece(grams: u32) -> PieceSpec {
    PieceSpec {
        weight_grams: grams,
        ..PieceSpec::default()
    }
}

/// The merchant.
pub(crate) fn address() -> Address {
    Address {
        name: Some("Jan Jansen".into()),
        company: Some("Weld Demo BV".into()),
        street: "Keizersgracht".into(),
        house_number: "100".into(),
        postal_code: "1015 AA".into(),
        city: "Amsterdam".into(),
        country: "NL".into(),
        email: Some("shop@example.com".into()),
        phone: Some("+31201234567".into()),
        ..Address::default()
    }
}

/// One 1 kg piece from the merchant to a consumer in Amsterdam.
pub(crate) fn request() -> ShipmentRequest {
    ShipmentRequest {
        reference: "ORD-1001".into(),
        sender: address(),
        recipient: Address {
            name: Some("Anna de Vries".into()),
            street: "Damrak".into(),
            house_number: "1".into(),
            house_number_suffix: Some("A".into()),
            postal_code: "1012 lg".into(),
            city: "Amsterdam".into(),
            country: "NL".into(),
            email: Some("anna@example.com".into()),
            phone: Some("+31612345678".into()),
            ..Address::default()
        },
        return_address: None,
        product: None,
        pieces: vec![piece(1000)],
        options: ShipmentOptions::default(),
        service_point: None,
        return_label: false,
        customs: None,
        label_format: LabelFormat::PdfA6,
        idempotency_key: "7a0e4f0e-5c43-4b0a-9a51-3f4a8a0c2d11".into(),
    }
}
