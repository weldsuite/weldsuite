//! Hours to invoice against a database (`WELDSUITE_TEST_TENANT_URL`; each
//! test returns early without it).

#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    clippy::many_single_char_names,
    clippy::cast_possible_truncation,
    clippy::assert_is_empty,
    reason = "each test is one scenario read top to bottom"
)]

use axum::extract::{Path, State};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::http::{Caller, Refusal};

use weldsuite_legal_entities::EntityScopeCondition;

use super::{FromTime, Grouping, finance_in, invoice_from_time, unbilled};
use crate::body::{InvoiceInput, LineInput};
use crate::invoices::write::{remove, update_with_links};
use crate::test_support::{
    World, answer, answer_of, customer, entity, fresh, row_of, with_permissions,
};

fn only(entity: &str) -> EntityScopeCondition {
    EntityScopeCondition::In {
        ids: vec![entity.to_owned()],
        include_unassigned: false,
    }
}

async fn project(
    db: &PgPool,
    name: &str,
    counterparty: Option<&str>,
    customer_id: Option<&str>,
    rate: Option<&str>,
    currency: Option<&str>,
) -> String {
    let id = fresh("prj");
    sqlx::query(
        "insert into projects (id, created_at, updated_at, name, counterparty_id, customer_id, hourly_rate, budget_currency) \
         values ($1, now(), now(), $2, $3, $4, $5::numeric, $6)",
    )
    .bind(&id)
    .bind(name)
    .bind(counterparty)
    .bind(customer_id)
    .bind(rate)
    .bind(currency)
    .execute(db)
    .await
    .unwrap();
    id
}

async fn member(db: &PgPool, project: &str, user: &str, rate: Option<&str>, name: &str) {
    sqlx::query(
        "insert into project_members (id, project_id, user_id, hourly_rate) values ($1, $2, $3, $4::numeric)",
    )
    .bind(fresh("pm"))
    .bind(project)
    .bind(user)
    .bind(rate)
    .execute(db)
    .await
    .unwrap();
    sqlx::query(
        "insert into workspace_members (id, user_id, name) values ($1, $2, $3) on conflict do nothing",
    )
    .bind(fresh("wm"))
    .bind(user)
    .bind(name)
    .execute(db)
    .await
    .unwrap();
}

#[allow(clippy::too_many_arguments, reason = "a fixture row")]
async fn entry(
    db: &PgPool,
    project: &str,
    user: &str,
    date: &str,
    minutes: &str,
    rate: Option<&str>,
    status: &str,
    billable: bool,
) -> String {
    let id = fresh("te");
    sqlx::query(
        "insert into time_entries (id, project_id, user_id, date, duration, description, activity, billable, rate, status) \
         values ($1, $2, $3, $4::date, $5::numeric, $6, 'Design', $7, $8::numeric, $9)",
    )
    .bind(&id)
    .bind(project)
    .bind(user)
    .bind(date)
    .bind(minutes)
    .bind(format!("Work {}", &id[id.len() - 4..]))
    .bind(billable)
    .bind(rate)
    .bind(status)
    .execute(db)
    .await
    .unwrap();
    id
}

async fn from_time(
    world: &World,
    caller: &Caller,
    entry_ids: Vec<String>,
    grouping: Grouping,
    invoice_id: Option<&str>,
) -> (u16, Value) {
    let result = invoice_from_time(
        caller,
        &world.state,
        FromTime {
            entry_ids,
            grouping,
            invoice_id: invoice_id.map(str::to_owned),
            entity_id: None,
        },
    )
    .await;
    answer(result.map_err(Refusal::from)).await
}

#[tokio::test]
async fn unbilled_hours_are_priced_by_entry_project_then_member_and_grouped_per_customer() {
    let Some(world) = World::new() else { return };
    let ent = entity(&world.db, "Acme B.V.", "nl-NL", None).await;
    let a = customer(&world.db, "Alfa BV", false).await;
    let b = customer(&world.db, "Beta BV", false).await;
    let a_company: String = sqlx::query_scalar("select company_id from parties where id = $1")
        .bind(&a)
        .fetch_one(&world.db)
        .await
        .unwrap();
    let u1 = fresh("user");
    let u2 = fresh("user");

    // P1: the party's id in counterparty_id, a project rate. P2: the CRM
    // company id in the old customer_id, a member rate. P3: another customer.
    let p1 = project(&world.db, "Website", Some(&a), None, Some("80"), None).await;
    let p2 = project(&world.db, "App", None, Some(&a_company), None, Some("USD")).await;
    let p3 = project(&world.db, "Beta work", None, Some(&b), None, None).await;
    let nobody = project(&world.db, "Internal", None, None, Some("50"), None).await;
    member(&world.db, &p1, &u1, None, "Ann").await;
    member(&world.db, &p2, &u2, Some("60"), "Bob").await;

    let e1 = entry(
        &world.db,
        &p1,
        &u1,
        "2026-11-24",
        "120",
        Some("100"),
        "draft",
        true,
    )
    .await;
    let e2 = entry(
        &world.db,
        &p1,
        &u1,
        "2026-11-25",
        "60",
        None,
        "approved",
        true,
    )
    .await;
    let e3 = entry(&world.db, &p2, &u2, "2026-11-25", "90", None, "draft", true).await;
    let e4 = entry(&world.db, &p3, &u1, "2026-11-25", "60", None, "draft", true).await;
    // Not unbilled: rejected, billed, not billable, on an invoice, deleted, no customer.
    entry(
        &world.db,
        &p1,
        &u1,
        "2026-11-25",
        "60",
        None,
        "rejected",
        true,
    )
    .await;
    entry(
        &world.db,
        &p1,
        &u1,
        "2026-11-25",
        "60",
        None,
        "billed",
        true,
    )
    .await;
    entry(
        &world.db,
        &p1,
        &u1,
        "2026-11-25",
        "60",
        None,
        "draft",
        false,
    )
    .await;
    let on_invoice = entry(&world.db, &p1, &u1, "2026-11-25", "60", None, "draft", true).await;
    sqlx::query("update time_entries set invoice_id = 'inv_x' where id = $1")
        .bind(&on_invoice)
        .execute(&world.db)
        .await
        .unwrap();
    let gone = entry(&world.db, &p1, &u1, "2026-11-25", "60", None, "draft", true).await;
    sqlx::query("update time_entries set deleted_at = now() where id = $1")
        .bind(&gone)
        .execute(&world.db)
        .await
        .unwrap();
    entry(
        &world.db,
        &nobody,
        &u1,
        "2026-11-25",
        "60",
        None,
        "draft",
        true,
    )
    .await;

    let caller = world.caller(&ent).with_query(&format!("customerId={a}"));
    let (status, body) = answer_of(unbilled(caller).await).await;
    assert_eq!(status, 200, "{body}");
    let groups = body["data"].as_array().unwrap();
    // One customer, two currencies: listed once per currency.
    assert_eq!(groups.len(), 2, "{body}");
    let eur = groups.iter().find(|g| g["currency"] == "EUR").unwrap();
    assert_eq!(eur["customer"]["contactId"], json!(a));
    assert_eq!(eur["customer"]["name"], "Alfa BV");
    // 2 h at the entry's 100 + 1 h at the project's 80.
    assert_eq!(eur["hours"], "3");
    assert_eq!(eur["amount"], "280.00");
    let projects = eur["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0]["projectId"], json!(p1));
    let entries = projects[0]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["id"], json!(e1));
    assert_eq!(entries[0]["rate"], "100.00");
    assert_eq!(entries[0]["rateSource"], "entry");
    assert_eq!(entries[0]["amount"], "200.00");
    assert_eq!(entries[0]["userName"], "Ann");
    assert_eq!(entries[1]["id"], json!(e2));
    assert_eq!(entries[1]["rateSource"], "project");
    assert_eq!(entries[1]["amount"], "80.00");
    let usd = groups.iter().find(|g| g["currency"] == "USD").unwrap();
    // 1.5 h at the member's 60, found through the CRM company id.
    assert_eq!(usd["amount"], "90.00");
    assert_eq!(usd["projects"][0]["entries"][0]["id"], json!(e3));
    assert_eq!(usd["projects"][0]["entries"][0]["rateSource"], "member");

    // All customers: Beta's hours have no rate and show as 0; the project
    // without a customer is not listed; `to` and `projectId` narrow.
    let (_, all) = answer_of(unbilled(world.caller(&ent)).await).await;
    let beta = all["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["customer"]["contactId"] == json!(b))
        .unwrap();
    assert_eq!(beta["amount"], "0.00");
    assert_eq!(beta["projects"][0]["entries"][0]["id"], json!(e4));
    assert_eq!(beta["projects"][0]["entries"][0]["rateSource"], "none");
    assert!(
        all["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|g| g["projects"][0]["projectId"] != json!(nobody))
    );
    let (_, early) = answer_of(
        unbilled(
            world
                .caller(&ent)
                .with_query(&format!("customerId={a}&to=2026-11-24")),
        )
        .await,
    )
    .await;
    assert_eq!(early["data"][0]["amount"], "200.00");
    let (_, one) =
        answer_of(unbilled(world.caller(&ent).with_query(&format!("projectId={p2}"))).await).await;
    assert_eq!(one["data"].as_array().unwrap().len(), 1);
    let (status, _) = answer_of(unbilled(world.caller(&ent).with_query("to=soon")).await).await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn hours_become_lines_in_each_grouping_and_are_invoiced_once() {
    let Some(world) = World::new() else { return };
    let ent = entity(&world.db, "Acme Ltd", "en-GB", None).await;
    let contact = customer(&world.db, "Gamma BV", false).await;
    let u1 = fresh("user");
    let u2 = fresh("user");
    let p = project(&world.db, "Portal", Some(&contact), None, Some("100"), None).await;
    member(&world.db, &p, &u1, None, "Ann").await;
    member(&world.db, &p, &u2, None, "Bob").await;
    let caller = world.caller(&ent);

    let a = entry(&world.db, &p, &u1, "2026-11-24", "240", None, "draft", true).await;
    let b = entry(&world.db, &p, &u2, "2026-11-25", "270", None, "draft", true).await;
    let c = entry(
        &world.db,
        &p,
        &u1,
        "2026-11-26",
        "240",
        None,
        "approved",
        true,
    )
    .await;

    // By project: one line, hours x rate, the project on it.
    let (status, created) = from_time(
        &world,
        &caller,
        vec![a.clone(), b.clone(), c.clone()],
        Grouping::Project,
        None,
    )
    .await;
    assert_eq!(status, 201, "{created}");
    let invoice = &created["data"];
    assert_eq!(invoice["status"], "draft");
    assert_eq!(invoice["contactId"], json!(contact));
    assert_eq!(invoice["entityId"], json!(ent));
    let items = invoice["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["description"], "Portal · 24–26 Nov · 12.5 h");
    assert_eq!(items[0]["quantity"], "12.5");
    assert_eq!(items[0]["unitPrice"], "100.00");
    assert_eq!(items[0]["unit"], "h");
    assert_eq!(items[0]["projectId"], json!(p));
    assert_eq!(invoice["subtotal"], "1250.00");
    let invoice_id = invoice["id"].as_str().unwrap().to_owned();
    let item_id = items[0]["id"].as_str().unwrap().to_owned();
    for id in [&a, &b, &c] {
        let row = row_of(&world.db, "time_entries", id).await;
        assert_eq!(row["invoice_id"], json!(invoice_id));
        assert_eq!(row["invoice_item_id"], json!(item_id));
    }
    let events = world.events().await;
    assert!(events.iter().any(|(kind, _)| kind == "invoice.created"));
    assert_eq!(
        events
            .iter()
            .filter(|(kind, data)| kind == "project_time_entry.updated"
                && data["invoiceId"] == json!(invoice_id))
            .count(),
        3,
        "{events:?}"
    );

    // Once: the same entries again are refused, and nothing changed.
    let (status, again) = from_time(&world, &caller, vec![a.clone()], Grouping::Entry, None).await;
    assert_eq!(status, 409, "{again}");
    assert_eq!(again["error"]["details"]["timeEntryIds"], json!([a]));

    // By person, by activity, by entry (fresh entries).
    let d = entry(&world.db, &p, &u1, "2026-12-01", "60", None, "draft", true).await;
    let e = entry(&world.db, &p, &u2, "2026-12-02", "120", None, "draft", true).await;
    let (status, by_person) = from_time(
        &world,
        &caller,
        vec![d.clone(), e.clone()],
        Grouping::Person,
        None,
    )
    .await;
    assert_eq!(status, 201, "{by_person}");
    let items = by_person["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert!(
        items
            .iter()
            .any(|i| i["description"] == "Portal · Ann · 1 Dec · 1 h")
    );
    assert!(
        items
            .iter()
            .any(|i| i["description"] == "Portal · Bob · 2 Dec · 2 h")
    );

    let f = entry(&world.db, &p, &u1, "2026-12-03", "60", None, "draft", true).await;
    let g = entry(&world.db, &p, &u2, "2026-12-04", "30", None, "draft", true).await;
    let (status, by_activity) = from_time(
        &world,
        &caller,
        vec![f.clone(), g.clone()],
        Grouping::Activity,
        None,
    )
    .await;
    assert_eq!(status, 201, "{by_activity}");
    let items = by_activity["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["description"], "Portal · Design · 3–4 Dec · 1.5 h");

    let h = entry(&world.db, &p, &u1, "2026-12-05", "60", None, "draft", true).await;
    let i = entry(&world.db, &p, &u2, "2026-12-05", "60", None, "draft", true).await;
    let (status, by_entry) = from_time(
        &world,
        &caller,
        vec![h.clone(), i.clone()],
        Grouping::Entry,
        None,
    )
    .await;
    assert_eq!(status, 201, "{by_entry}");
    assert_eq!(by_entry["data"]["items"].as_array().unwrap().len(), 2);
    // Each entry points at its own line.
    let row_h = row_of(&world.db, "time_entries", &h).await;
    let row_i = row_of(&world.db, "time_entries", &i).await;
    assert_ne!(row_h["invoice_item_id"], row_i["invoice_item_id"]);
    assert_eq!(row_h["invoice_id"], row_i["invoice_id"]);
}

#[tokio::test]
async fn hours_are_added_to_a_draft_of_the_same_customer_and_refused_elsewhere() {
    let Some(world) = World::new() else { return };
    let ent = entity(&world.db, "Acme Ltd", "en-GB", None).await;
    let contact = customer(&world.db, "Delta BV", false).await;
    let other = customer(&world.db, "Epsilon BV", false).await;
    let u1 = fresh("user");
    let p = project(
        &world.db,
        "Delta work",
        Some(&contact),
        None,
        Some("90"),
        None,
    )
    .await;
    let q = project(
        &world.db,
        "Epsilon work",
        Some(&other),
        None,
        Some("90"),
        None,
    )
    .await;
    let r = project(
        &world.db,
        "Delta dollars",
        Some(&contact),
        None,
        Some("90"),
        Some("USD"),
    )
    .await;
    let caller = world.caller(&ent);

    let first = entry(&world.db, &p, &u1, "2026-11-24", "60", None, "draft", true).await;
    let (_, created) = from_time(
        &world,
        &caller,
        vec![first.clone()],
        Grouping::Project,
        None,
    )
    .await;
    let invoice_id = created["data"]["id"].as_str().unwrap().to_owned();
    let first_item = created["data"]["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // More hours onto the draft: the old line stays, linked, the new one is added.
    let second = entry(
        &world.db,
        &p,
        &u1,
        "2026-11-27",
        "30",
        Some("120"),
        "draft",
        true,
    )
    .await;
    let (status, appended) = from_time(
        &world,
        &caller,
        vec![second.clone()],
        Grouping::Project,
        Some(&invoice_id),
    )
    .await;
    assert_eq!(status, 200, "{appended}");
    let items = appended["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "{appended}");
    assert_eq!(items[0]["description"], "Delta work · 24 Nov · 1 h");
    assert_eq!(items[1]["description"], "Delta work · 27 Nov · 0.5 h");
    assert_eq!(items[1]["unitPrice"], "120.00");
    assert_eq!(appended["data"]["subtotal"], "150.00");
    let row_first = row_of(&world.db, "time_entries", &first).await;
    let row_second = row_of(&world.db, "time_entries", &second).await;
    assert_eq!(row_first["invoice_id"], json!(invoice_id));
    assert_eq!(row_second["invoice_id"], json!(invoice_id));
    // The first entry now points at the first line's replacement, project kept.
    assert_ne!(row_first["invoice_item_id"], json!(first_item));
    assert_eq!(row_first["invoice_item_id"], items[0]["id"]);
    assert_eq!(row_second["invoice_item_id"], items[1]["id"]);
    assert_eq!(items[0]["projectId"], json!(p));
    assert_eq!(items[1]["projectId"], json!(p));

    // Refusals: another customer's draft, another currency, a missing entry,
    // two customers at once, a finalized invoice, an unknown invoice.
    let theirs = entry(&world.db, &q, &u1, "2026-11-27", "60", None, "draft", true).await;
    let dollars = entry(&world.db, &r, &u1, "2026-11-27", "60", None, "draft", true).await;
    let free = entry(&world.db, &p, &u1, "2026-11-28", "60", None, "draft", true).await;
    let (status, body) = from_time(
        &world,
        &caller,
        vec![theirs.clone()],
        Grouping::Project,
        Some(&invoice_id),
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("another customer")
    );
    let (status, body) = from_time(
        &world,
        &caller,
        vec![dollars.clone()],
        Grouping::Project,
        Some(&invoice_id),
    )
    .await;
    assert_eq!(status, 400, "{body}");
    let (status, _) = from_time(
        &world,
        &caller,
        vec![free.clone(), theirs.clone()],
        Grouping::Project,
        None,
    )
    .await;
    assert_eq!(status, 400);
    let (status, body) = from_time(
        &world,
        &caller,
        vec![free.clone(), fresh("te")],
        Grouping::Project,
        None,
    )
    .await;
    assert_eq!(status, 400, "{body}");
    sqlx::query("update invoices set status = 'finalized' where id = $1")
        .bind(&invoice_id)
        .execute(&world.db)
        .await
        .unwrap();
    let (status, body) = from_time(
        &world,
        &caller,
        vec![free.clone()],
        Grouping::Project,
        Some(&invoice_id),
    )
    .await;
    assert_eq!(status, 400, "{body}");
    // Finalizing keeps the link.
    assert_eq!(
        row_of(&world.db, "time_entries", &first).await["invoice_id"],
        json!(invoice_id)
    );
    let (status, _) = from_time(
        &world,
        &caller,
        vec![free.clone()],
        Grouping::Project,
        Some("inv_unknown"),
    )
    .await;
    assert_eq!(status, 404);
    // None of the refused entries was taken.
    for id in [&theirs, &dollars, &free] {
        assert!(row_of(&world.db, "time_entries", id).await["invoice_id"].is_null());
    }
}

#[tokio::test]
async fn hours_are_released_when_the_draft_goes_or_a_line_is_removed() {
    let Some(world) = World::new() else { return };
    let ent = entity(&world.db, "Acme B.V.", "nl-NL", None).await;
    let contact = customer(&world.db, "Zeta BV", false).await;
    let u1 = fresh("user");
    let p = project(
        &world.db,
        "Zeta one",
        Some(&contact),
        None,
        Some("100"),
        None,
    )
    .await;
    let q = project(
        &world.db,
        "Zeta two",
        Some(&contact),
        None,
        Some("50"),
        None,
    )
    .await;
    let caller = world.caller(&ent);

    let e1 = entry(&world.db, &p, &u1, "2026-11-24", "60", None, "draft", true).await;
    let e2 = entry(&world.db, &q, &u1, "2026-11-24", "120", None, "draft", true).await;
    let (_, created) = from_time(
        &world,
        &caller,
        vec![e1.clone(), e2.clone()],
        Grouping::Project,
        None,
    )
    .await;
    let invoice_id = created["data"]["id"].as_str().unwrap().to_owned();
    let items = created["data"]["items"].as_array().unwrap().clone();
    assert_eq!(items.len(), 2);

    // The form sends the lines back as they were (the hours edited on one):
    // both stay linked, to the lines that replace the old ones.
    let line = |item: &Value, quantity: &str| LineInput {
        description: item["description"].as_str().unwrap().to_owned(),
        quantity: quantity.to_owned(),
        unit_price: item["unitPrice"].as_str().unwrap().to_owned(),
        unit: Some("h".to_owned()),
        discount_percent: "0".to_owned(),
        ..LineInput::default()
    };
    let same = InvoiceInput {
        items: Some(vec![line(&items[0], "1"), line(&items[1], "1.5")]),
        ..InvoiceInput::default()
    };
    let response = update_with_links(&caller, &world.state, &invoice_id, same, None)
        .await
        .map_err(Refusal::from);
    let (status, updated) = answer(response).await;
    assert_eq!(status, 200, "{updated}");
    let new_items = updated["data"]["items"].as_array().unwrap();
    let row1 = row_of(&world.db, "time_entries", &e1).await;
    let row2 = row_of(&world.db, "time_entries", &e2).await;
    assert_eq!(row1["invoice_id"], json!(invoice_id));
    assert_eq!(row2["invoice_id"], json!(invoice_id));
    assert_eq!(row1["invoice_item_id"], new_items[0]["id"]);
    assert_eq!(row2["invoice_item_id"], new_items[1]["id"]);
    assert_eq!(new_items[1]["projectId"], json!(q));

    // Removing the second line frees its hours; the first stays.
    let kept = InvoiceInput {
        items: Some(vec![line(&new_items[0], "1")]),
        ..InvoiceInput::default()
    };
    let response = update_with_links(&caller, &world.state, &invoice_id, kept, None)
        .await
        .map_err(Refusal::from);
    let (status, _) = answer(response).await;
    assert_eq!(status, 200);
    let row1 = row_of(&world.db, "time_entries", &e1).await;
    let row2 = row_of(&world.db, "time_entries", &e2).await;
    assert_eq!(row1["invoice_id"], json!(invoice_id));
    assert!(row2["invoice_id"].is_null());
    assert!(row2["invoice_item_id"].is_null());

    // The freed hours can be invoiced again; deleting the draft frees the rest.
    let (status, second) =
        from_time(&world, &caller, vec![e2.clone()], Grouping::Project, None).await;
    assert_eq!(status, 201, "{second}");
    let second_id = second["data"]["id"].as_str().unwrap().to_owned();
    let (status, _) = answer_of(
        remove(
            world.caller(&ent),
            State(world.state.clone()),
            Path(second_id.clone()),
        )
        .await,
    )
    .await;
    assert_eq!(status, 200);
    assert!(row_of(&world.db, "time_entries", &e2).await["invoice_id"].is_null());

    // Discarding (cancelling) the first draft frees its hours too.
    let (status, _) = answer_of(
        crate::invoices::actions::status(
            world.caller(&ent),
            State(world.state.clone()),
            Path(invoice_id.clone()),
            axum::http::HeaderMap::from_iter([(
                axum::http::header::CONTENT_TYPE,
                axum::http::HeaderValue::from_static("application/json"),
            )]),
            axum::body::Bytes::from_static(br#"{"status":"cancelled"}"#),
        )
        .await,
    )
    .await;
    assert_eq!(status, 200);
    assert!(row_of(&world.db, "time_entries", &e1).await["invoice_id"].is_null());
}

#[tokio::test]
async fn a_project_shows_what_is_invoiced_unbilled_and_spent() {
    let Some(world) = World::new() else { return };
    let ent = entity(&world.db, "Acme B.V.", "nl-NL", None).await;
    let contact = customer(&world.db, "Eta BV", false).await;
    let u1 = fresh("user");
    let p = project(
        &world.db,
        "Eta work",
        Some(&contact),
        None,
        Some("100"),
        None,
    )
    .await;
    let caller = world.caller(&ent);

    let billed = entry(&world.db, &p, &u1, "2026-11-24", "120", None, "draft", true).await;
    entry(&world.db, &p, &u1, "2026-11-25", "60", None, "draft", true).await;
    let (status, created) = from_time(&world, &caller, vec![billed], Grouping::Project, None).await;
    assert_eq!(status, 201);
    let invoice_id = created["data"]["id"].as_str().unwrap().to_owned();

    // A cost: a posted bill with a line for the project.
    let supplier = customer(&world.db, "Leverancier BV", false).await;
    let bill = fresh("bill");
    sqlx::query(
        "insert into bills (id, entity_id, bill_number, type, status, contact_id, issue_date, due_date, currency, total) \
         values ($1, $2, 'B-1', 'standard', 'approved', $3, now(), now(), 'EUR', '60.50')",
    )
    .bind(&bill)
    .bind(&ent)
    .bind(&supplier)
    .execute(&world.db)
    .await
    .unwrap();
    sqlx::query(
        "insert into bill_items (id, entity_id, bill_id, description, unit_price, line_total, project_id) \
         values ($1, $2, $3, 'Hosting', '50.00', '50.00', $4)",
    )
    .bind(fresh("bli"))
    .bind(&ent)
    .bind(&bill)
    .bind(&p)
    .execute(&world.db)
    .await
    .unwrap();

    // The invoice is still a draft: counted as draft, not invoiced.
    let reader = |world: &World| {
        with_permissions(
            world.caller(&ent),
            &["invoices:read", "time:read", "bills:read"],
        )
    };
    let (status, finance) = answer(finance_in(&reader(&world), &only(&ent), &p).await).await;
    assert_eq!(status, 200, "{finance}");
    let data = &finance["data"];
    assert_eq!(data["projectId"], json!(p));
    assert_eq!(data["invoiced"], json!([]));
    assert_eq!(
        data["draft"],
        json!([{ "currency": "EUR", "amount": "200.00", "count": 1 }])
    );
    assert_eq!(
        data["costs"],
        json!([{ "currency": "EUR", "amount": "50.00", "count": 1 }])
    );
    assert_eq!(
        data["unbilled"],
        json!([{ "currency": "EUR", "hours": "1", "amount": "100.00" }])
    );
    // Without the time and bill permissions those parts are left out.
    let (_, narrow) = answer(finance_in(&world.caller(&ent), &only(&ent), &p).await).await;
    assert!(narrow["data"].get("unbilled").is_none());
    assert!(narrow["data"].get("costs").is_none());

    // Issued: invoiced.
    sqlx::query("update invoices set status = 'sent' where id = $1")
        .bind(&invoice_id)
        .execute(&world.db)
        .await
        .unwrap();
    let (_, finance) = answer(finance_in(&reader(&world), &only(&ent), &p).await).await;
    let (_, elsewhere) = answer(finance_in(&reader(&world), &only(&fresh("ent")), &p).await).await;
    assert_eq!(elsewhere["data"]["invoiced"], json!([]));
    assert_eq!(
        finance["data"]["invoiced"],
        json!([{ "currency": "EUR", "amount": "200.00", "count": 1 }])
    );
    assert_eq!(finance["data"]["draft"], json!([]));
    let (status, _) = answer(finance_in(&world.caller(&ent), &only(&ent), "prj_nope").await).await;
    assert_eq!(status, 404);
}
