//! The renderer against the TypeScript one. `tests/fixtures/pdf/` holds the
//! input and pdf-lib's output for it (`tools/pdf-fixtures.mts`); each test
//! draws the same input here and compares what both files draw, page by
//! page: every text run (text, font, size, origin), image and line.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

use super::*;

const ORIGINAL: &[u8] = include_bytes!("../../tests/fixtures/pdf/original.pdf");
const FLATTENED: &[u8] = include_bytes!("../../tests/fixtures/pdf/flattened.pdf");
const FIELDS: &str = include_str!("../../tests/fixtures/pdf/fields.json");
const CERTIFICATE: &[u8] = include_bytes!("../../tests/fixtures/pdf/certificate.pdf");
const CERTIFICATE_INPUT: &str = include_str!("../../tests/fixtures/pdf/certificate.json");

/// pdf-lib writes numbers with up to 6 decimals, lopdf as f32.
const TOLERANCE: f64 = 0.01;

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= TOLERANCE
}

fn same(a: &Drawn, b: &Drawn) -> bool {
    match (a, b) {
        (
            Drawn::Text {
                font: fa,
                size: sa,
                x: xa,
                y: ya,
                text: ta,
            },
            Drawn::Text {
                font: fb,
                size: sb,
                x: xb,
                y: yb,
                text: tb,
            },
        ) => fa == fb && ta == tb && close(*sa, *sb) && close(*xa, *xb) && close(*ya, *yb),
        (
            Drawn::Image {
                x: xa,
                y: ya,
                width: wa,
                height: ha,
            },
            Drawn::Image {
                x: xb,
                y: yb,
                width: wb,
                height: hb,
            },
        ) => close(*xa, *xb) && close(*ya, *yb) && close(*wa, *wb) && close(*ha, *hb),
        (
            Drawn::Line {
                x1: a1,
                y1: b1,
                x2: c1,
                y2: d1,
                width: w1,
            },
            Drawn::Line {
                x1: a2,
                y1: b2,
                x2: c2,
                y2: d2,
                width: w2,
            },
        ) => {
            close(*a1, *a2)
                && close(*b1, *b2)
                && close(*c1, *c2)
                && close(*d1, *d2)
                && close(*w1, *w2)
        }
        _ => false,
    }
}

fn assert_same_pages(rust: &[Vec<Drawn>], typescript: &[Vec<Drawn>]) {
    assert_eq!(rust.len(), typescript.len(), "page count");
    for (page, (r, t)) in rust.iter().zip(typescript).enumerate() {
        let equal = r.len() == t.len() && r.iter().zip(t).all(|(a, b)| same(a, b));
        assert!(
            equal,
            "page {page} differs\nRust:\n{}\nTypeScript:\n{}",
            describe(r),
            describe(t)
        );
    }
}

fn fields() -> Vec<RenderField> {
    let list: Vec<Value> = serde_json::from_str(FIELDS).expect("fields.json");
    list.iter()
        .map(|f| RenderField {
            page: usize::try_from(f["page"].as_u64().expect("page")).expect("page"),
            x: f["x"].as_f64().expect("x"),
            y: f["y"].as_f64().expect("y"),
            width: f["width"].as_f64().expect("width"),
            height: f["height"].as_f64().expect("height"),
            kind: f["type"].as_str().expect("type").to_owned(),
            value: f["value"].as_str().map(str::to_owned),
            image: f["image"]
                .as_str()
                .map(|b| STANDARD.decode(b).expect("base64")),
        })
        .collect()
}

fn opt(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn certificate_input() -> CertificateInput {
    let v: Value = serde_json::from_str(CERTIFICATE_INPUT).expect("certificate.json");
    CertificateInput {
        envelope_id: v["envelopeId"].as_str().expect("id").to_owned(),
        title: v["title"].as_str().expect("title").to_owned(),
        sender_name: opt(&v["senderName"]),
        sender_email: opt(&v["senderEmail"]),
        workspace_name: v["workspaceName"].as_str().expect("name").to_owned(),
        sent_at: opt(&v["sentAt"]),
        completed_at: v["completedAt"].as_str().expect("completedAt").to_owned(),
        documents: v["documents"]
            .as_array()
            .expect("documents")
            .iter()
            .map(|d| CertificateDocument {
                name: d["name"].as_str().expect("name").to_owned(),
                page_count: d["pageCount"].as_i64().expect("pageCount"),
                sha256: d["sha256"].as_str().expect("sha256").to_owned(),
            })
            .collect(),
        recipients: v["recipients"]
            .as_array()
            .expect("recipients")
            .iter()
            .map(|r| CertificateRecipient {
                name: opt(&r["name"]),
                email: opt(&r["email"]),
                role: r["role"].as_str().expect("role").to_owned(),
                auth_mode: r["authMode"].as_str().expect("authMode").to_owned(),
                signature_kind: opt(&r["signatureKind"]),
                ip: opt(&r["ip"]),
                user_agent: opt(&r["userAgent"]),
                sent_at: opt(&r["sentAt"]),
                opened_at: opt(&r["openedAt"]),
                consented_at: opt(&r["consentedAt"]),
                signed_at: opt(&r["signedAt"]),
            })
            .collect(),
        disclosure_version: v["disclosureVersion"].as_str().expect("version").to_owned(),
    }
}

#[test]
fn flattening_draws_what_typescript_draws() {
    let ours = flatten_document(ORIGINAL, &fields()).expect("flatten");
    let rust = drawn_on_pages(&ours).expect("read ours");
    let typescript = drawn_on_pages(FLATTENED).expect("read pdf-lib's");
    assert_same_pages(&rust, &typescript);

    let page0 = text_of(&rust[0]);
    assert!(page0.contains(&"2026-11-02".to_owned()), "{page0:?}");
    // What WinAnsi can't show becomes "?"; tabs and line breaks a space.
    assert!(
        page0.contains(&"Zoë Ångström ?? — “quotes” € and more".to_owned()),
        "{page0:?}"
    );
    // A long value in a small box shrinks below 5 pt (9.8 down in steps of 0.5) and wraps.
    assert!(
        rust[0]
            .iter()
            .any(|d| matches!(d, Drawn::Text { size, .. } if close(*size, 4.8)))
    );
    // Two images, two check-mark strokes per ticked box.
    let images: usize = rust
        .iter()
        .map(|p| {
            p.iter()
                .filter(|d| matches!(d, Drawn::Image { .. }))
                .count()
        })
        .sum();
    assert_eq!(images, 3);
    let lines = rust[1]
        .iter()
        .filter(|d| matches!(d, Drawn::Line { .. }))
        .count();
    assert_eq!(lines, 2, "only the ticked box on page 2");
}

#[test]
fn the_certificate_draws_what_typescript_draws() {
    let mut out = OutputPdf::new();
    append_certificate(&mut out, &certificate_input()).expect("certificate");
    let bytes = out.finish("Certificate").expect("save");
    let rust = drawn_on_pages(&bytes).expect("read ours");
    let typescript = drawn_on_pages(CERTIFICATE).expect("read pdf-lib's");
    assert_eq!(rust.len(), 2, "six recipients take a second page");
    assert_same_pages(&rust, &typescript);

    let text = text_of(&rust[0]);
    assert_eq!(text[0], "Certificate of completion");
    assert!(text.contains(&"Electronic signatures by WeldSign for Acme Staffing".to_owned()));
    assert!(text.contains(&"2026-11-02 10:30:00 UTC".to_owned()));
    assert!(text.contains(&"Gert <gert@example.com>".to_owned()));
    assert!(text.contains(&"agreement.pdf (2 pages)".to_owned()));
    assert!(text.contains(&"annex.pdf (1 page)".to_owned()));
    assert!(text.contains(&"Receives a copy".to_owned()));
    assert!(text.contains(&"Email link and one-time code".to_owned()));
}

#[test]
fn the_signed_document_is_the_documents_then_the_certificate() {
    let flattened = flatten_document(ORIGINAL, &fields()).expect("flatten");
    let mut out = OutputPdf::new();
    out.append_document(Document::load_mem(&flattened).expect("load"))
        .expect("copy");
    out.append_document(Document::load_mem(ORIGINAL).expect("load"))
        .expect("copy");
    append_certificate(&mut out, &certificate_input()).expect("certificate");
    assert_eq!(out.page_count(), 12);
    let bytes = out.finish("Service agreement").expect("save");

    let pages = drawn_on_pages(&bytes).expect("read");
    assert_eq!(pages.len(), 12);
    // Copied pages keep what they draw, rotation and crop box included.
    let flattened_pages = drawn_on_pages(&flattened).expect("read");
    assert_same_pages(&pages[..5], &flattened_pages);
    assert_eq!(text_of(&pages[5]), vec!["Portrait".to_owned()]);
    assert_eq!(text_of(&pages[10])[0], "Certificate of completion");
    let doc = Document::load_mem(&bytes).expect("load");
    let page = doc.get_pages()[&3];
    assert_eq!(rotation(&doc, page), 90);
    let cropped = doc.get_pages()[&4];
    assert_eq!(
        crop_box(&doc, cropped),
        Rect {
            x: 20.0,
            y: 30.0,
            width: 560.0,
            height: 750.0
        }
    );
}

#[test]
fn boxes_map_back_to_page_space() {
    let field = Rect {
        x: 10.0,
        y: 20.0,
        width: 100.0,
        height: 30.0,
    };
    let crop = Rect {
        x: 5.0,
        y: 7.0,
        width: 600.0,
        height: 800.0,
    };
    assert_eq!(
        place_box(field, crop, 0),
        Placement {
            x: 15.0,
            y: 757.0,
            rotate: 0
        }
    );
    assert_eq!(
        place_box(field, crop, 90),
        Placement {
            x: 55.0,
            y: 17.0,
            rotate: 90
        }
    );
    assert_eq!(
        place_box(field, crop, 180),
        Placement {
            x: 595.0,
            y: 57.0,
            rotate: 180
        }
    );
    assert_eq!(
        place_box(field, crop, -90),
        Placement {
            x: 555.0,
            y: 797.0,
            rotate: 270
        }
    );
}

#[test]
fn text_is_reduced_to_win_ansi_and_measured_like_pdf_lib() {
    assert_eq!(win_ansi("a\r\n\tb 名 €"), "a b ? €");
    // Helvetica "AV" kerns by -70 (1000 units): 667 + 667 - 70.
    assert!(close(width_of_text(&HELVETICA, "AV", 10.0), 12.64));
    assert_eq!(
        break_text_into_lines(
            "aa bb cc",
            width_of_text(&HELVETICA, "aa bb ", 10.0) + 0.01,
            &HELVETICA,
            10.0
        ),
        vec!["aa bb ".to_owned(), "cc".to_owned()]
    );
}
