//! Quotes against a database (`WELDSUITE_TEST_TENANT_URL`; each test returns
//! early without it).

#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    reason = "each test is one scenario read top to bottom"
)]

use serde_json::{Value, json};

use super::{FromQuote, create_quote, invoice_from_quote, list_quotes, read_quote, update_quote};
use crate::test_support::{
    DEFAULT_ENTITY, World, answer, answer_of, customer, entity, quote, row_of,
};

async fn make_default(world: &World, entity_id: &str) {
    crate::test_support::make_default(&world.db, entity_id).await;
}

async fn invoiced(
    world: &World,
    caller: &weldsuite_books_domain::http::Caller,
    quote_id: &str,
    body: FromQuote,
) -> (u16, Value) {
    let result = invoice_from_quote(caller, &world.state, quote_id, body).await;
    let reply = result.map_err(weldsuite_books_domain::http::Refusal::from);
    answer(reply).await
}

#[tokio::test]
async fn a_quote_is_created_priced_updated_and_listed_for_its_contact() {
    let Some(world) = World::new() else { return };
    let ent = entity(&world.db, "Acme B.V.", "nl-NL", None).await;
    let contact = customer(&world.db, "Quote Klant BV", false).await;
    let other = customer(&world.db, "Andere Klant BV", false).await;
    let caller = world.caller(&ent);

    let body = json!({
        "contactId": contact, "name": "Webshop", "validUntil": "2099-01-01T00:00:00.000Z", "notes": "Graag tekenen",
        "lines": [
            { "description": "Design", "quantity": 2, "unitPrice": "100", "taxRate": 21 },
            { "description": "Hosting", "unitPrice": "100", "discountPercent": 10, "taxRate": 9 },
        ],
    });
    let (status, created) =
        answer(create_quote(&caller, &world.state, read_quote(&body, true).unwrap()).await).await;
    assert_eq!(status, 201, "{created}");
    let data = &created["data"];
    let id = data["id"].as_str().unwrap().to_owned();
    assert!(
        data["quoteNumber"].as_str().unwrap().starts_with("Q-20"),
        "{data}"
    );
    assert_eq!(data["status"], "draft");
    assert_eq!(data["contactId"], json!(contact));
    assert_eq!(data["contactName"], "Quote Klant BV");
    // 200 + 90 = 290; tax 42.00 + 8.10 = 50.10.
    assert_eq!(data["subtotal"], "290.00");
    assert_eq!(data["tax"], "50.10");
    assert_eq!(data["total"], "340.10");
    assert_eq!(data["currency"], "EUR");
    assert_eq!(data["lines"].as_array().unwrap().len(), 2);
    assert_eq!(data["invoices"], json!([]));
    let events = world.events().await;
    assert!(
        events
            .iter()
            .any(|(n, d)| n == "quote.created" && d["id"] == json!(id)),
        "{events:?}"
    );

    // A second quote for the same contact numbers on.
    let (_, second) = answer(create_quote(&caller, &world.state, read_quote(&json!({ "contactId": contact, "name": "Onderhoud", "lines": [{ "description": "Uren", "unitPrice": 50 }] }), true).unwrap()).await).await;
    assert_ne!(second["data"]["quoteNumber"], data["quoteNumber"]);

    // Updating re-prices.
    let patch = json!({ "lines": [{ "description": "Alles", "unitPrice": "100", "taxRate": 21 }], "notes": null });
    let (status, updated) = answer(
        update_quote(
            &caller,
            &world.state,
            &id,
            read_quote(&patch, false).unwrap(),
        )
        .await,
    )
    .await;
    assert_eq!(status, 200, "{updated}");
    assert_eq!(updated["data"]["total"], "121.00");
    assert!(updated["data"]["notes"].is_null());

    // A bad contact or line is refused.
    let (status, _) = answer(create_quote(&caller, &world.state, read_quote(&json!({ "contactId": "pty_none", "name": "X", "lines": [{ "description": "a", "unitPrice": 1 }] }), true).unwrap()).await).await;
    assert_eq!(status, 400);
    assert!(read_quote(&json!({ "contactId": contact, "name": "X" }), true).is_err());

    // The list: filtered by the contact, with its name, and by status and search.
    let list = |query: &str| {
        let query = query.to_owned();
        let world = &world;
        let ent = ent.clone();
        async move {
            let mut caller = world.caller(&ent);
            caller = set_query(caller, &query);
            answer_of(list_quotes_response(&caller).await).await
        }
    };
    let (status, body) = list(&format!("contactId={contact}")).await;
    assert_eq!(status, 200);
    let rows = body["data"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "{body}");
    assert!(
        rows.iter()
            .all(|r| r["contactId"] == json!(contact) && r["contactName"] == "Quote Klant BV")
    );
    let row = rows.iter().find(|r| r["id"] == json!(id)).unwrap();
    for key in [
        "quoteNumber",
        "name",
        "total",
        "currency",
        "status",
        "validUntil",
        "sentAt",
        "viewedAt",
        "acceptedAt",
        "invoiceIds",
    ] {
        assert!(row.get(key).is_some(), "{key}: {row}");
    }
    assert_eq!(row["invoiceIds"], json!([]));
    let (_, none) = list(&format!("contactId={other}")).await;
    assert_eq!(none["data"].as_array().unwrap().len(), 0);
    let (_, sent) = list(&format!("contactId={contact}&status=sent")).await;
    assert_eq!(sent["data"].as_array().unwrap().len(), 0);
    let number = data["quoteNumber"].as_str().unwrap();
    let (_, found) = list(&format!("contactId={contact}&search={number}")).await;
    assert_eq!(found["data"].as_array().unwrap().len(), 1);
    let (_, found) = list(&format!("contactId={contact}&search=Quote%20Klant")).await;
    assert_eq!(found["data"].as_array().unwrap().len(), 2);
    let (_, page) = list(&format!("contactId={contact}&pageSize=1")).await;
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
    assert_eq!(page["pagination"]["hasMore"], true);
    assert_eq!(page["pagination"]["totalCount"], 2);

    // A quote the CRM made for the contact's company is found by it too.
    let company: String = sqlx::query_scalar("select company_id from parties where id = $1")
        .bind(&contact)
        .fetch_one(&world.db)
        .await
        .unwrap();
    let crm = crate::test_support::fresh("quote");
    sqlx::query("insert into crm_quotes (id, quote_number, name, customer_id, counterparty_id, line_items, subtotal, total, valid_from, valid_until, status) values ($1, 'CRM-1', 'Van het CRM', $2, $2, '[]'::jsonb, '0', '0', now(), now(), 'sent')")
        .bind(&crm)
        .bind(&company)
        .execute(&world.db)
        .await
        .unwrap();
    let (_, found) = list(&format!("contactId={contact}&status=sent")).await;
    let rows = found["data"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{found}");
    assert_eq!(rows[0]["id"], json!(crm));
    assert_eq!(rows[0]["contactName"], "Quote Klant BV");
}

fn set_query(
    caller: weldsuite_books_domain::http::Caller,
    query: &str,
) -> weldsuite_books_domain::http::Caller {
    caller.with_query(query)
}

async fn list_quotes_response(
    caller: &weldsuite_books_domain::http::Caller,
) -> axum::response::Response {
    match list_quotes(caller).await {
        Ok(response) => response,
        Err(refusal) => refusal.respond("Failed"),
    }
}

#[tokio::test]
async fn a_quote_becomes_an_invoice_in_the_default_entity() {
    let Some(world) = World::new() else { return };
    let _guard = DEFAULT_ENTITY.lock().await;
    let ent = entity(&world.db, "Acme B.V.", "nl-NL", None).await;
    make_default(&world, &ent).await;
    let contact = customer(&world.db, "Quote Klant BV", false).await;
    let qid = quote(&world.db, &contact, "accepted", 30).await;
    let caller = world.system(&ent);

    let (status, out) = invoiced(&world, &caller, &qid, FromQuote::default()).await;
    assert_eq!(status, 201, "{out}");
    let invoice = &out["data"];
    assert_eq!(invoice["status"], "draft");
    assert_eq!(invoice["entityId"], json!(ent));
    assert_eq!(invoice["contactId"], json!(contact));
    assert_eq!(invoice["quoteId"], json!(qid));
    assert_eq!(invoice["currency"], "EUR");
    assert_eq!(invoice["items"].as_array().unwrap().len(), 2);
    assert_eq!(invoice["subtotal"], "300.00");
    let quote_number = row_of(&world.db, "crm_quotes", &qid).await["quote_number"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(invoice["reference"], json!(quote_number));
    let stored = row_of(&world.db, "invoices", invoice["id"].as_str().unwrap()).await;
    assert_eq!(stored["quote_id"], json!(qid));
    // 100% invoiced: the quote is done, and the events say so.
    assert_eq!(
        row_of(&world.db, "crm_quotes", &qid).await["status"],
        "invoiced"
    );
    let events = world.events().await;
    let names: Vec<&str> = events.iter().map(|(n, _)| n.as_str()).collect();
    assert!(
        names.contains(&"invoice.created") && names.contains(&"quote.updated"),
        "{names:?}"
    );
    // Nothing is left to invoice.
    let (status, out) = invoiced(&world, &caller, &qid, FromQuote::default()).await;
    assert_eq!(status, 409, "{out}");
}

#[tokio::test]
async fn an_advance_invoice_bills_a_share_and_the_rest_closes_the_quote() {
    let Some(world) = World::new() else { return };
    let _guard = DEFAULT_ENTITY.lock().await;
    let ent = entity(&world.db, "Acme B.V.", "nl-NL", None).await;
    make_default(&world, &ent).await;
    let contact = customer(&world.db, "Quote Klant BV", false).await;
    let qid = quote(&world.db, &contact, "sent", 30).await;
    let caller = world.system(&ent);
    let share = |p: f64| FromQuote {
        percentage: Some(p),
        ..FromQuote::default()
    };

    let (status, out) = invoiced(&world, &caller, &qid, share(30.0)).await;
    assert_eq!(status, 201, "{out}");
    assert_eq!(out["data"]["subtotal"], "90.00", "30% of 300.00");
    assert_eq!(
        out["data"]["items"][0]["unitPrice"], "30",
        "the price is scaled, the quantity kept"
    );
    assert_eq!(out["data"]["items"][0]["quantity"], "2");
    assert!(out["data"]["notes"].as_str().unwrap().contains("30%"));
    assert_eq!(
        row_of(&world.db, "crm_quotes", &qid).await["status"],
        "sent",
        "30% does not close it"
    );

    // More than what is left is refused; the rest closes the quote.
    let (status, out) = invoiced(&world, &caller, &qid, share(80.0)).await;
    assert_eq!(status, 409, "{out}");
    assert!(
        out["error"]["message"].as_str().unwrap().contains("30%"),
        "{out}"
    );
    let (status, out) = invoiced(&world, &caller, &qid, share(70.0)).await;
    assert_eq!(status, 201, "{out}");
    assert_eq!(out["data"]["subtotal"], "210.00");
    assert_eq!(
        row_of(&world.db, "crm_quotes", &qid).await["status"],
        "invoiced"
    );

    // The quote lists both.
    let detail = super::detail_of(
        &world.db,
        super::load_quote(&world.db, &qid).await.unwrap().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(detail["invoices"].as_array().unwrap().len(), 2);
    assert_eq!(detail["invoiceIds"].as_array().unwrap().len(), 2);
    assert_eq!(detail["status"], "invoiced");

    // The list rows carry the invoices next to their ids: number and status.
    let (status, listed) = answer(
        list_quotes(
            &world
                .caller(&ent)
                .with_query(&format!("contactId={contact}")),
        )
        .await,
    )
    .await;
    assert_eq!(status, 200, "{listed}");
    let row = &listed["data"][0];
    let made = row["invoices"].as_array().unwrap();
    assert_eq!(made.len(), 2, "{row}");
    assert_eq!(row["invoiceIds"].as_array().unwrap().len(), 2);
    for (invoice, id) in made.iter().zip(row["invoiceIds"].as_array().unwrap()) {
        assert_eq!(invoice["id"], *id);
        assert!(
            invoice["invoiceNumber"]
                .as_str()
                .is_some_and(|n| !n.is_empty())
        );
        assert_eq!(invoice["status"], "draft");
        assert_eq!(invoice.as_object().unwrap().len(), 3);
    }
}

#[tokio::test]
async fn the_entity_is_chosen_when_invoicing_and_bad_requests_are_refused() {
    let Some(world) = World::new() else { return };
    let _guard = DEFAULT_ENTITY.lock().await;
    let default = entity(&world.db, "Default B.V.", "nl-NL", None).await;
    let chosen = entity(&world.db, "Chosen B.V.", "nl-NL", None).await;
    make_default(&world, &default).await;
    let contact = customer(&world.db, "Quote Klant BV", false).await;
    let caller = world.system(&default);

    let qid = quote(&world.db, &contact, "sent", 30).await;
    let body = FromQuote {
        entity_id: Some(chosen.clone()),
        percentage: Some(50.0),
        ..FromQuote::default()
    };
    let (status, out) = invoiced(&world, &caller, &qid, body).await;
    assert_eq!(status, 201, "{out}");
    assert_eq!(out["data"]["entityId"], json!(chosen));
    let (status, _) = invoiced(
        &world,
        &caller,
        &qid,
        FromQuote {
            entity_id: Some("ent_nope".into()),
            ..FromQuote::default()
        },
    )
    .await;
    assert_eq!(status, 400);
    let (status, _) = invoiced(&world, &caller, "quote_nope", FromQuote::default()).await;
    assert_eq!(status, 404);
    let declined = quote(&world.db, &contact, "declined", 30).await;
    assert_eq!(
        invoiced(&world, &caller, &declined, FromQuote::default())
            .await
            .0,
        409
    );

    // Lines of the caller's own replace the quote's, and never close it.
    let own = quote(&world.db, &contact, "sent", 30).await;
    let body = FromQuote {
        lines: Some(vec![
            json!({ "description": "Afwijkend", "unitPrice": "10", "taxRate": 21 }),
        ]),
        ..FromQuote::default()
    };
    let (status, out) = invoiced(&world, &caller, &own, body).await;
    assert_eq!(status, 201, "{out}");
    assert_eq!(out["data"]["items"][0]["description"], "Afwijkend");
    assert_eq!(out["data"]["subtotal"], "10.00");
    assert_eq!(
        row_of(&world.db, "crm_quotes", &own).await["status"],
        "sent"
    );
}
