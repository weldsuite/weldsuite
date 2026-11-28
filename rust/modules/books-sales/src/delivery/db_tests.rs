//! E-mailing documents and the public document routes, against a database
//! (`WELDSUITE_TEST_TENANT_URL`; each test returns early without it).

#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    reason = "each test is one scenario read top to bottom"
)]

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt;
use weldsuite_books_domain::document_token::{self, DocumentToken, TokenError};
use weldsuite_db::Tenant;
use weldsuite_ports::RecordingSystemMail;

use super::email::{EmailBody, email_invoice, email_quote};
use super::public::{Acceptance, accept_quote, open_document, public_router};
use super::{Links, history_of, link_nonce};
use crate::test_support::{
    DEFAULT_ENTITY, WORKSPACE, World, answer, customer, entity, invoice, make_default, quote,
    row_of,
};

fn body(to: &str) -> EmailBody {
    EmailBody {
        to: vec![to.to_owned()],
        cc: Vec::new(),
        subject: None,
        body: None,
        attach_pdf: true,
        include_link: true,
    }
}

fn tenant(world: &World) -> Tenant {
    Tenant {
        workspace_id: WORKSPACE.to_owned(),
        clerk_org_id: None,
        db: world.db.clone(),
        suspended: false,
        restrictions: weldsuite_db::WorkspaceRestrictions::default(),
    }
}

fn app(world: &World, tenant: Tenant) -> Router {
    public_router::<()>(&world.state, None).layer(axum::Extension(tenant))
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    ip: &str,
    payload: Option<Value>,
) -> (StatusCode, http::HeaderMap, Vec<u8>) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("x-forwarded-for", ip);
    let body = match payload {
        Some(v) => {
            request = request.header("content-type", "application/json");
            Body::from(v.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, headers, bytes.to_vec())
}

fn json_of(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or(Value::Null)
}

fn is_decimal(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        let d = s.strip_prefix('-').unwrap_or(s);
        !d.is_empty()
            && d.split('.').count() <= 2
            && d.split('.')
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    })
}

/// Every field of the pay portal's `documentSchema`
/// (`apps/web/pay-portal/lib/contract.ts`), checked as Zod does.
fn assert_contract(doc: &Value) {
    let text = |v: &Value| v.is_string();
    let text_or_null = |v: &Value| v.is_string() || v.is_null();
    assert!(
        ["invoice", "quote"].contains(&doc["kind"].as_str().unwrap()),
        "{doc}"
    );
    assert!(
        [
            "open",
            "overdue",
            "paid",
            "partially_paid",
            "cancelled",
            "accepted",
            "declined",
            "expired"
        ]
        .contains(&doc["status"].as_str().unwrap()),
        "{doc}"
    );
    assert!(text(&doc["number"]) && text(&doc["issueDate"]));
    assert!(text_or_null(&doc["dueDate"]) && text_or_null(&doc["validUntil"]));
    assert_eq!(doc["currency"].as_str().unwrap().len(), 3);
    assert!(["nl", "en"].contains(&doc["locale"].as_str().unwrap()));
    let seller = &doc["seller"];
    assert!(text(&seller["name"]));
    for key in [
        "email",
        "phone",
        "vatNumber",
        "registrationNumber",
        "iban",
        "bic",
        "logoUrl",
    ] {
        assert!(text_or_null(&seller[key]), "seller.{key}: {seller}");
    }
    assert!(seller["address"].is_null() || seller["address"].is_object());
    for key in ["line1", "line2", "postalCode", "city", "country"] {
        assert!(
            text_or_null(&seller["address"][key]) || seller["address"][key].is_null(),
            "address.{key}"
        );
    }
    assert!(text(&doc["buyer"]["name"]));
    assert!(doc["buyer"]["address"].is_null() || doc["buyer"]["address"].is_object());
    for line in doc["lines"].as_array().unwrap() {
        assert!(text(&line["description"]));
        for key in ["quantity", "unitPrice", "taxRate", "total"] {
            assert!(is_decimal(&line[key]), "line.{key}: {line}");
        }
    }
    let totals = &doc["totals"];
    for key in ["subtotal", "total", "paid", "balanceDue"] {
        assert!(is_decimal(&totals[key]), "totals.{key}: {totals}");
    }
    for tax in totals["taxes"].as_array().unwrap() {
        assert!(
            is_decimal(&tax["rate"]) && is_decimal(&tax["amount"]),
            "{tax}"
        );
    }
    assert!(text_or_null(&doc["notes"]) && text_or_null(&doc["paymentTerms"]));
    let payment = &doc["payment"];
    assert!(payment["enabled"].is_boolean());
    assert!(["open", "pending", "paid"].contains(&payment["status"].as_str().unwrap()));
    assert!(
        payment["methods"]
            .as_array()
            .unwrap()
            .iter()
            .all(Value::is_string)
    );
    let quote = &doc["quote"];
    if !quote.is_null() {
        assert!(quote["canAccept"].is_boolean());
        assert!(text_or_null(&quote["acceptedAt"]) && text_or_null(&quote["acceptedBy"]));
    }
    // Written for the portal's own Zod check when asked (see the report).
    if let Ok(dir) = std::env::var("P4_FIXTURE_DIR") {
        let name = format!(
            "{}-{}.json",
            doc["kind"].as_str().unwrap(),
            doc["status"].as_str().unwrap()
        );
        std::fs::write(std::path::Path::new(&dir).join(name), doc.to_string()).unwrap();
    }
}

async fn sent_invoice(world: &World, due_days_ago: i64) -> (String, String, String) {
    let ent = entity(&world.db, "Acme B.V.", "nl-NL", None).await;
    let contact = customer(&world.db, "Klant BV", false).await;
    let number = format!("F-{}", &weldsuite_kit::generate_id("n")[2..8]);
    let inv = invoice(
        &world.db,
        &ent,
        &contact,
        &number,
        "sent",
        due_days_ago,
        Some("klant@example.test"),
    )
    .await;
    (ent, inv, number)
}

#[tokio::test]
async fn an_invoice_is_emailed_with_the_link_the_pdf_and_a_history() {
    let Some(world) = World::new() else { return };
    let (ent, id, number) = sent_invoice(&world, -10).await;
    let caller = world.caller(&ent);

    let (status, answer_body) =
        answer(email_invoice(&caller, &world.state, &id, body("klant@example.test")).await).await;
    assert_eq!(status, 200, "{answer_body}");
    let link = answer_body["data"]["delivery"]["link"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(link.starts_with("https://pay.example.test/d/"), "{link}");

    // The mail: from the entity's name, replies to the entity, with the link and the PDF.
    let sent = world.mail.sent();
    assert_eq!(sent.len(), 1);
    let mail = &sent[0];
    assert_eq!(mail.from.name.as_deref(), Some("Acme B.V."));
    assert_eq!(mail.reply_to.as_ref().unwrap().email, "facturen@acme.test");
    assert_eq!(mail.to[0].email, "klant@example.test");
    assert_eq!(mail.subject, format!("Factuur {number} van Acme B.V."));
    assert!(mail.text.contains(&link), "{}", mail.text);
    assert!(mail.text.contains("€ 121,00"), "{}", mail.text);
    assert!(mail.html.contains(&format!("<a href=\"{link}\">")));
    assert_eq!(mail.attachments.len(), 1);
    assert_eq!(mail.attachments[0].content_type, "application/pdf");
    assert!(mail.attachments[0].content.starts_with(b"%PDF-1.4"));
    assert_eq!(mail.attachments[0].filename, format!("{number}.pdf"));

    // The history: a link and a send, with the message id.
    let row = row_of(&world.db, "invoices", &id).await;
    let history = history_of(&json!({ "emailHistory": row["email_history"] }));
    assert_eq!(history.len(), 2, "{history:?}");
    assert_eq!(history[0]["type"], "link");
    assert_eq!(history[1]["type"], "sent");
    assert_eq!(history[1]["to"], json!(["klant@example.test"]));
    assert!(
        history[1]["messageId"]
            .as_str()
            .unwrap()
            .contains("recording")
    );
    let events = world.events().await;
    assert!(
        events
            .iter()
            .any(|(name, data)| name == "invoice.emailed" && data["id"] == json!(id)),
        "{events:?}"
    );

    // Sending again keeps the link the customer already has.
    let (_, again) =
        answer(email_invoice(&caller, &world.state, &id, body("klant@example.test")).await).await;
    assert_eq!(again["data"]["delivery"]["link"].as_str().unwrap(), link);
    assert_eq!(world.mail.sent().len(), 2);
}

#[tokio::test]
async fn the_text_can_be_overridden_and_the_link_and_pdf_left_out() {
    let Some(world) = World::new() else { return };
    let (ent, id, number) = sent_invoice(&world, -10).await;
    let caller = world.caller(&ent);
    let mut custom = body("klant@example.test");
    custom.cc = vec!["boekhouding@example.test".to_owned()];
    custom.subject = Some("Uw factuur {number}".to_owned());
    custom.body = Some("Hallo {customerName}, factuur {number} staat klaar.".to_owned());
    custom.attach_pdf = false;
    custom.include_link = false;
    let (status, out) = answer(email_invoice(&caller, &world.state, &id, custom).await).await;
    assert_eq!(status, 200, "{out}");
    let mail = &world.mail.sent()[0];
    assert_eq!(mail.subject, format!("Uw factuur {number}"));
    assert_eq!(
        mail.text,
        format!("Hallo Klant BV, factuur {number} staat klaar.")
    );
    assert_eq!(mail.cc[0].email, "boekhouding@example.test");
    assert_eq!(mail.attachments, Vec::new());
    assert!(out["data"]["delivery"]["link"].is_null());
    // No link was made.
    let row = row_of(&world.db, "invoices", &id).await;
    assert!(
        row["email_history"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["type"] != "link")
    );
}

#[tokio::test]
async fn the_entitys_own_template_and_language_win() {
    let Some(world) = World::new() else { return };
    let settings = json!({ "emailTemplates": { "invoice": { "en": { "subject": "Bill {number}", "body": "Hi {customerName}: {link}" } } } });
    let ent = entity(&world.db, "Acme B.V.", "en-GB", Some(settings)).await;
    let contact = customer(&world.db, "Klant BV", false).await;
    let id = invoice(&world.db, &ent, &contact, "F-TPL-1", "sent", -5, None).await;
    let (status, out) = answer(
        email_invoice(
            &world.caller(&ent),
            &world.state,
            &id,
            body("a@example.test"),
        )
        .await,
    )
    .await;
    assert_eq!(status, 200, "{out}");
    let mail = &world.mail.sent()[0];
    assert_eq!(mail.subject, "Bill F-TPL-1");
    assert!(
        mail.text
            .starts_with("Hi Klant BV: https://pay.example.test/d/")
    );
}

#[tokio::test]
async fn a_refused_send_is_recorded_as_bounced_and_a_missing_setup_changes_nothing() {
    let Some(world) = World::with_mail(Arc::new(RecordingSystemMail::failing())) else {
        return;
    };
    let (ent, id, _) = sent_invoice(&world, -10).await;
    let (status, _) = answer(
        email_invoice(
            &world.caller(&ent),
            &world.state,
            &id,
            body("klant@example.test"),
        )
        .await,
    )
    .await;
    assert_eq!(status, 503);
    let row = row_of(&world.db, "invoices", &id).await;
    let history = row["email_history"].as_array().unwrap();
    assert_eq!(history.last().unwrap()["type"], "bounced");
    assert_eq!(history.last().unwrap()["error"], "send_failed");
    assert!(weldsuite_books_domain::email_history::is_undelivered(
        history
    ));

    // Without a mail transport, or without a portal address, nothing is touched.
    let mut bare = World::new().unwrap();
    bare.state.mail = None;
    let (ent, id, _) = sent_invoice(&bare, -10).await;
    let (status, _) =
        answer(email_invoice(&bare.caller(&ent), &bare.state, &id, body("a@example.test")).await)
            .await;
    assert_eq!(status, 503);
    let mut no_portal = World::new().unwrap();
    no_portal.state.env = Arc::default();
    let (ent, id, _) = sent_invoice(&no_portal, -10).await;
    let (status, _) = answer(
        email_invoice(
            &no_portal.caller(&ent),
            &no_portal.state,
            &id,
            body("a@example.test"),
        )
        .await,
    )
    .await;
    assert_eq!(status, 503);
    assert_eq!(no_portal.mail.sent(), Vec::new());
    assert!(row_of(&no_portal.db, "invoices", &id).await["email_history"].is_null());
}

#[tokio::test]
async fn a_cancelled_invoice_or_an_unknown_one_is_refused() {
    let Some(world) = World::new() else { return };
    let ent = entity(&world.db, "Acme B.V.", "nl-NL", None).await;
    let contact = customer(&world.db, "Klant BV", false).await;
    let id = invoice(&world.db, &ent, &contact, "F-CAN-1", "cancelled", 0, None).await;
    let caller = world.caller(&ent);
    assert_eq!(
        answer(email_invoice(&caller, &world.state, &id, body("a@example.test")).await)
            .await
            .0,
        400
    );
    assert_eq!(
        answer(email_invoice(&caller, &world.state, "inv_missing", body("a@example.test")).await)
            .await
            .0,
        404
    );
    assert_eq!(world.mail.sent(), Vec::new());
}

#[tokio::test]
async fn a_link_is_bound_to_its_secret_its_workspace_and_its_nonce() {
    let Some(world) = World::new() else { return };
    let (ent, id, _) = sent_invoice(&world, -10).await;
    let caller = world.caller(&ent);
    let (_, out) =
        answer(email_invoice(&caller, &world.state, &id, body("a@example.test")).await).await;
    let url = out["data"]["delivery"]["link"].as_str().unwrap().to_owned();
    let text = url.rsplit('/').next().unwrap().to_owned();
    let secret = Links::secret(&world.state).unwrap();

    let token = document_token::verify(&secret, &text).unwrap();
    assert_eq!(
        (token.t.as_str(), token.id.as_str(), token.ws.as_str()),
        ("invoice", id.as_str(), WORKSPACE)
    );
    assert!(
        open_document(&world.db, &secret, &token)
            .await
            .unwrap()
            .is_some()
    );
    // Another key signs nothing this server accepts.
    assert_eq!(
        document_token::verify(document_token::new_nonce().as_bytes(), &text),
        Err(TokenError::BadSignature)
    );
    // A wrong nonce, another document's id or a draft opens nothing.
    let forged = DocumentToken::new(WORKSPACE, "invoice", &id, &document_token::new_nonce());
    assert!(
        open_document(&world.db, &secret, &forged)
            .await
            .unwrap()
            .is_none()
    );
    let missing = DocumentToken::new(WORKSPACE, "invoice", "inv_nope", &token.n);
    assert!(
        open_document(&world.db, &secret, &missing)
            .await
            .unwrap()
            .is_none()
    );

    // Over HTTP: the same answer for a tampered token, and a token of another workspace.
    let router = app(&world, tenant(&world));
    let (status, ..) = call(
        &router,
        "GET",
        &format!("/public/weldbooks/documents/{text}x"),
        "10.0.0.1",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let foreign = document_token::sign(
        &secret,
        &DocumentToken::new("ws_someone_else", "invoice", &id, &token.n),
    );
    let (status, ..) = call(
        &router,
        "GET",
        &format!("/public/weldbooks/documents/{foreign}"),
        "10.0.0.1",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, ..) = call(
        &router,
        "GET",
        "/public/weldbooks/documents/short",
        "10.0.0.1",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, ..) = call(
        &router,
        "GET",
        &format!("/public/weldbooks/documents/{text}"),
        "10.0.0.1",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Revoking withdraws it; a new e-mail makes a new one.
    let (status, _) = answer(Ok(crate::delivery::email::revoke_invoice_link(
        world.caller(&ent),
        axum::extract::Path(id.clone()),
    )
    .await))
    .await;
    assert_eq!(status, 200);
    let row = row_of(&world.db, "invoices", &id).await;
    assert_eq!(
        link_nonce(&history_of(
            &json!({ "emailHistory": row["email_history"] })
        )),
        None
    );
    let (status, ..) = call(
        &router,
        "GET",
        &format!("/public/weldbooks/documents/{text}"),
        "10.0.0.1",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, renewed) =
        answer(email_invoice(&caller, &world.state, &id, body("a@example.test")).await).await;
    let new_url = renewed["data"]["delivery"]["link"].as_str().unwrap();
    assert_ne!(new_url, url);
    let (status, ..) = call(
        &router,
        "GET",
        &format!(
            "/public/weldbooks/documents/{}",
            new_url.rsplit('/').next().unwrap()
        ),
        "10.0.0.1",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn the_public_invoice_follows_the_contract_in_every_state() {
    let Some(world) = World::new() else { return };
    let (ent, id, number) = sent_invoice(&world, 10).await;
    let (_, out) = answer(
        email_invoice(
            &world.caller(&ent),
            &world.state,
            &id,
            body("a@example.test"),
        )
        .await,
    )
    .await;
    let text = out["data"]["delivery"]["link"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_owned();
    world.events().await;
    let router = app(&world, tenant(&world));
    let uri = format!("/public/weldbooks/documents/{text}");

    let (status, headers, bytes) = call(&router, "GET", &uri, "10.0.1.1", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["cache-control"], "no-store");
    assert!(
        headers["x-robots-tag"]
            .to_str()
            .unwrap()
            .contains("noindex")
    );
    let doc = json_of(&bytes)["data"].clone();
    assert_contract(&doc);
    assert_eq!(doc["kind"], "invoice");
    assert_eq!(doc["status"], "overdue", "due ten days ago");
    assert_eq!(doc["number"], json!(number));
    assert_eq!(doc["locale"], "nl");
    assert_eq!(doc["currency"], "EUR");
    assert_eq!(doc["seller"]["name"], "Acme B.V.");
    assert_eq!(doc["seller"]["vatNumber"], "NL123456789B01");
    assert_eq!(doc["seller"]["registrationNumber"], "12345678");
    assert_eq!(doc["seller"]["iban"], "NL91ABNA0417164300");
    assert_eq!(
        doc["seller"]["logoUrl"],
        "https://cdn.example.test/logo.png"
    );
    assert_eq!(doc["seller"]["address"]["city"], "Amsterdam");
    assert_eq!(doc["buyer"]["name"], "Klant BV");
    assert_eq!(doc["buyer"]["address"]["postalCode"], "3511AB");
    assert_eq!(doc["lines"][0]["description"], "Consultancy");
    assert_eq!(doc["lines"][0]["total"], "100.00");
    assert_eq!(doc["totals"]["total"], "121.00");
    assert_eq!(doc["totals"]["balanceDue"], "121.00");
    assert_eq!(doc["totals"]["paid"], "0.00");
    assert_eq!(
        doc["totals"]["taxes"][0],
        json!({ "rate": "21", "amount": "21.00" })
    );
    assert_eq!(
        doc["payment"],
        json!({ "enabled": false, "status": "open", "methods": [] })
    );
    assert!(doc["quote"].is_null());
    assert_eq!(doc["notes"], "Dank u wel");

    // The first opening sets viewed_at and the history once an hour, and is announced.
    let row = row_of(&world.db, "invoices", &id).await;
    assert!(!row["viewed_at"].is_null());
    let viewed = |row: &Value| {
        row["email_history"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "viewed")
            .count()
    };
    assert_eq!(viewed(&row), 1);
    let events = world.events().await;
    assert_eq!(
        events.iter().filter(|(n, _)| n == "invoice.viewed").count(),
        1,
        "{events:?}"
    );
    call(&router, "GET", &uri, "10.0.1.1", None).await;
    assert_eq!(
        viewed(&row_of(&world.db, "invoices", &id).await),
        1,
        "throttled"
    );

    // The PDF.
    let (status, headers, bytes) =
        call(&router, "GET", &format!("{uri}/pdf"), "10.0.1.1", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "application/pdf");
    assert!(bytes.starts_with(b"%PDF-1.4"));
    assert!(
        headers["content-disposition"]
            .to_str()
            .unwrap()
            .contains(&format!("{number}.pdf"))
    );

    // Paying answers 503 until online payment exists; accepting an invoice is a conflict.
    let (status, _, bytes) = call(
        &router,
        "POST",
        &format!("{uri}/pay"),
        "10.0.1.1",
        Some(json!({ "returnUrl": "https://pay.example.test/d/x/return" })),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json_of(&bytes)["error"]["code"], "PAYMENT_UNAVAILABLE");
    let (status, ..) = call(
        &router,
        "POST",
        &format!("{uri}/accept"),
        "10.0.1.1",
        Some(json!({ "name": "P", "email": "p@example.test", "agree": true })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // The other states, as the contract allows them.
    for (state_sql, wanted) in [
        (
            "status = 'partial', amount_paid = '21.00', balance_due = '100.00'",
            "partially_paid",
        ),
        (
            "status = 'paid', amount_paid = '121.00', balance_due = '0.00'",
            "paid",
        ),
        ("status = 'cancelled'", "cancelled"),
        (
            "status = 'sent', due_date = now() + interval '9 days', amount_paid = '0.00', balance_due = '121.00'",
            "open",
        ),
    ] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "update invoices set {state_sql} where id = $1"
        )))
        .bind(&id)
        .execute(&world.db)
        .await
        .unwrap();
        let (status, _, bytes) = call(&router, "GET", &uri, "10.0.1.2", None).await;
        assert_eq!(status, StatusCode::OK);
        let doc = json_of(&bytes)["data"].clone();
        assert_contract(&doc);
        assert_eq!(doc["status"], wanted);
        if wanted == "paid" {
            assert_eq!(doc["payment"]["status"], "paid");
            assert_eq!(doc["totals"]["balanceDue"], "0.00");
        }
    }

    // A draft is nobody's to see, even with a valid link.
    sqlx::query("update invoices set status = 'draft' where id = $1")
        .bind(&id)
        .execute(&world.db)
        .await
        .unwrap();
    let (status, ..) = call(&router, "GET", &uri, "10.0.1.3", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn requests_are_rate_limited_per_token() {
    let Some(world) = World::new() else { return };
    let (ent, id, _) = sent_invoice(&world, -10).await;
    let (_, out) = answer(
        email_invoice(
            &world.caller(&ent),
            &world.state,
            &id,
            body("a@example.test"),
        )
        .await,
    )
    .await;
    let text = out["data"]["delivery"]["link"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_owned();
    let router = app(&world, tenant(&world));
    let uri = format!("/public/weldbooks/documents/{text}/pdf");
    let mut limited = false;
    for i in 0..80 {
        // Each request from a different address: only the token's counter can stop them.
        let (status, headers, _) = call(
            &router,
            "GET",
            &uri,
            &format!("10.9.{}.{}", i / 200, i % 200 + 1),
            None,
        )
        .await;
        if status == StatusCode::TOO_MANY_REQUESTS {
            assert!(headers.contains_key("retry-after"));
            limited = true;
            break;
        }
    }
    assert!(limited);
}

#[tokio::test]
async fn a_quote_is_emailed_viewed_and_accepted_once() {
    let Some(world) = World::new() else { return };
    let _guard = DEFAULT_ENTITY.lock().await;
    let ent = entity(&world.db, "Acme B.V.", "nl-NL", None).await;
    make_default(&world.db, &ent).await;
    let contact = customer(&world.db, "Klant BV", false).await;
    let qid = quote(&world.db, &contact, "draft", 20).await;
    let caller = world.caller(&ent);

    let (status, out) =
        answer(email_quote(&caller, &world.state, &qid, body("klant@example.test")).await).await;
    assert_eq!(status, 200, "{out}");
    assert_eq!(out["data"]["status"], "sent");
    let link = out["data"]["delivery"]["link"].as_str().unwrap().to_owned();
    let mail = &world.mail.sent()[0];
    assert!(mail.subject.starts_with("Offerte "), "{}", mail.subject);
    assert_eq!(mail.attachments.len(), 1);
    assert!(mail.text.contains(&link));
    let text = link.rsplit('/').next().unwrap().to_owned();
    // Sending it again keeps the link.
    let (_, again) =
        answer(email_quote(&caller, &world.state, &qid, body("klant@example.test")).await).await;
    assert_eq!(again["data"]["delivery"]["link"].as_str().unwrap(), link);
    world.events().await;

    let router = app(&world, tenant(&world));
    let uri = format!("/public/weldbooks/documents/{text}");
    let (status, _, bytes) = call(&router, "GET", &uri, "10.1.0.1", None).await;
    assert_eq!(status, StatusCode::OK);
    let doc = json_of(&bytes)["data"].clone();
    assert_contract(&doc);
    assert_eq!(doc["kind"], "quote");
    assert_eq!(doc["status"], "open");
    assert_eq!(
        doc["quote"],
        json!({ "canAccept": true, "acceptedAt": null, "acceptedBy": null })
    );
    assert_eq!(doc["lines"].as_array().unwrap().len(), 2);
    assert_eq!(doc["totals"]["total"], "363.00");
    assert_eq!(doc["totals"]["taxes"][0]["amount"], "63.00");
    assert!(doc["dueDate"].is_null() && !doc["validUntil"].is_null());
    assert!(!row_of(&world.db, "crm_quotes", &qid).await["viewed_at"].is_null());
    let (status, headers, bytes) =
        call(&router, "GET", &format!("{uri}/pdf"), "10.1.0.1", None).await;
    assert_eq!(
        (status, headers["content-type"].to_str().unwrap()),
        (StatusCode::OK, "application/pdf")
    );
    assert!(bytes.starts_with(b"%PDF"));

    // Accepting needs the tick, a name and an address.
    for bad in [
        json!({ "name": "P", "email": "p@example.test", "agree": false }),
        json!({ "name": "", "email": "p@example.test", "agree": true }),
        json!({ "name": "P", "email": "nope", "agree": true }),
    ] {
        let (status, ..) = call(
            &router,
            "POST",
            &format!("{uri}/accept"),
            "10.1.0.1",
            Some(bad),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let accept = json!({ "name": "Piet Jansen", "email": "piet@example.test", "agree": true });
    let (status, _, bytes) = call(
        &router,
        "POST",
        &format!("{uri}/accept"),
        "10.1.0.1",
        Some(accept.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let accepted = json_of(&bytes)["data"].clone();
    assert_eq!(accepted["acceptedBy"], "Piet Jansen");
    let row = row_of(&world.db, "crm_quotes", &qid).await;
    assert_eq!(row["status"], "accepted");
    assert_eq!(row["signed_by"], "Piet Jansen");
    assert!(!row["signed_at"].is_null());
    assert!(
        row["internal_notes"]
            .as_str()
            .unwrap()
            .contains("piet@example.test")
    );
    assert!(row["internal_notes"].as_str().unwrap().contains("10.1.0.1"));
    let events = world.events().await;
    assert_eq!(
        events.iter().filter(|(n, _)| n == "quote.accepted").count(),
        1,
        "{events:?}"
    );

    // Once only; the page then shows it as accepted.
    let (status, ..) = call(
        &router,
        "POST",
        &format!("{uri}/accept"),
        "10.1.0.1",
        Some(accept),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (_, _, bytes) = call(&router, "GET", &uri, "10.1.0.1", None).await;
    let doc = json_of(&bytes)["data"].clone();
    assert_contract(&doc);
    assert_eq!(doc["status"], "accepted");
    assert_eq!(doc["quote"]["canAccept"], false);
    assert_eq!(doc["quote"]["acceptedBy"], "Piet Jansen");

    // Revoking the link (clearing sent_at) closes the page.
    let (status, _) = answer(Ok(crate::delivery::email::revoke_quote_link(
        world.caller(&ent),
        axum::extract::Path(qid.clone()),
    )
    .await))
    .await;
    assert_eq!(status, 200);
    let (status, ..) = call(&router, "GET", &uri, "10.1.0.1", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn an_expired_or_declined_quote_cannot_be_accepted() {
    let Some(world) = World::new() else { return };
    let _guard = DEFAULT_ENTITY.lock().await;
    let ent = entity(&world.db, "Acme B.V.", "en-GB", None).await;
    make_default(&world.db, &ent).await;
    let contact = customer(&world.db, "Klant BV", false).await;
    let secret = Links::secret(&world.state).unwrap();
    for (status_text, valid_days, wanted) in [("sent", -3, "expired"), ("declined", 10, "declined")]
    {
        let qid = quote(&world.db, &contact, status_text, valid_days).await;
        let (code, out) = answer(
            email_quote(
                &world.caller(&ent),
                &world.state,
                &qid,
                body("a@example.test"),
            )
            .await,
        )
        .await;
        // A declined quote is not sent; an expired one still can be (to be seen).
        if wanted == "declined" {
            assert_eq!(code, 400);
            sqlx::query("update crm_quotes set sent_at = now() where id = $1")
                .bind(&qid)
                .execute(&world.db)
                .await
                .unwrap();
        } else {
            assert_eq!(code, 200, "{out}");
        }
        let loaded = crate::delivery::public::load_quote(&world.db, &qid)
            .await
            .unwrap()
            .unwrap();
        let sent_at =
            weldsuite_books_domain::js::millis_of(loaded["sentAt"].as_str().unwrap()).unwrap();
        let token = DocumentToken::new(
            WORKSPACE,
            "quote",
            &qid,
            &document_token::quote_nonce(&secret, &qid, sent_at),
        );
        let opened = open_document(&world.db, &secret, &token).await.unwrap();
        let Some(row) = opened else {
            panic!("the quote's link opens ({wanted})")
        };
        let opened = super::public::Opened {
            db: world.db.clone(),
            event_workspace_id: WORKSPACE.to_owned(),
            token,
            row,
        };
        let accepted = accept_quote(
            &opened,
            &world.state,
            &Acceptance {
                name: "P".into(),
                email: "p@example.test".into(),
            },
            None,
        )
        .await
        .unwrap();
        assert!(accepted.is_none(), "{wanted} cannot be accepted");
        let doc = super::public::build(
            &opened,
            &world.state,
            weldsuite_books_domain::http::now_ms(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(doc.json["status"], wanted);
        assert_eq!(doc.json["quote"]["canAccept"], false);
    }
}

#[tokio::test]
async fn reading_a_link_gives_the_current_one_and_never_makes_one() {
    let Some(world) = World::new() else { return };
    let _guard = DEFAULT_ENTITY.lock().await;
    let (ent, id, _) = sent_invoice(&world, -10).await;
    make_default(&world.db, &ent).await;
    let contact = customer(&world.db, "Link Klant BV", false).await;
    let qid = quote(&world.db, &contact, "draft", 20).await;
    let caller = world.caller(&ent);
    let read_invoice = || async {
        answer(Ok(super::email::invoice_link(
            world.caller(&ent),
            axum::extract::State(world.state.clone()),
            axum::extract::Path(id.clone()),
        )
        .await))
        .await
    };
    let read_quote = || async {
        answer(Ok(super::email::quote_link(
            world.caller(&ent),
            axum::extract::State(world.state.clone()),
            axum::extract::Path(qid.clone()),
        )
        .await))
        .await
    };

    // Nothing sent yet: no link, and reading made none.
    let (status, out) = read_invoice().await;
    assert_eq!((status, &out["data"]["url"]), (200, &json!(null)), "{out}");
    let (status, out) = read_quote().await;
    assert_eq!((status, &out["data"]["url"]), (200, &json!(null)), "{out}");
    assert!(row_of(&world.db, "invoices", &id).await["email_history"].is_null());
    assert!(row_of(&world.db, "crm_quotes", &qid).await["sent_at"].is_null());

    // Sent: the link the customer has.
    let (_, sent) =
        answer(email_invoice(&caller, &world.state, &id, body("klant@example.test")).await).await;
    let invoice_link = sent["data"]["delivery"]["link"]
        .as_str()
        .unwrap()
        .to_owned();
    let (_, out) = read_invoice().await;
    assert_eq!(out["data"]["url"], json!(invoice_link));
    let (_, sent) =
        answer(email_quote(&caller, &world.state, &qid, body("klant@example.test")).await).await;
    let quote_link = sent["data"]["delivery"]["link"]
        .as_str()
        .unwrap()
        .to_owned();
    let (_, out) = read_quote().await;
    assert_eq!(out["data"]["url"], json!(quote_link));

    // Revoked: none again; an unknown record is a 404.
    answer(Ok(super::email::revoke_invoice_link(
        world.caller(&ent),
        axum::extract::Path(id.clone()),
    )
    .await))
    .await;
    answer(Ok(super::email::revoke_quote_link(
        world.caller(&ent),
        axum::extract::Path(qid.clone()),
    )
    .await))
    .await;
    assert_eq!(read_invoice().await.1["data"]["url"], json!(null));
    assert_eq!(read_quote().await.1["data"]["url"], json!(null));
    let (status, _) = answer(Ok(super::email::quote_link(
        world.caller(&ent),
        axum::extract::State(world.state.clone()),
        axum::extract::Path("quote_unknown".to_owned()),
    )
    .await))
    .await;
    assert_eq!(status, 404);
}
