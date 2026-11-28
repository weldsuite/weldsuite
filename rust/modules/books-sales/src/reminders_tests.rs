//! Payment reminders against a database (`WELDSUITE_TEST_TENANT_URL`; each
//! test returns early without it). The sweep visits every entity of the
//! database, so these tests run one at a time and first switch every other
//! entity's workflow off.

#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    clippy::many_single_char_names,
    reason = "each test is one scenario read top to bottom; x, y, z are customers"
)]

use serde_json::{Value, json};
use weldsuite_books_domain::contact_page::{contact_paused, paused_contacts, set_contact_paused};
use weldsuite_books_domain::http::now_ms;

use crate::reminders::{pause_invoice, remind_invoice, remind_many, send_due_reminders};
use crate::test_support::{WORKSPACE, World, answer, customer, entity, invoice, row_of};

static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn workflow(statutory: bool) -> Value {
    json!({ "reminders": {
        "enabled": true,
        "steps": [
            { "level": 1, "daysAfterDue": 7, "auto": true, "template": "reminder1" },
            { "level": 2, "daysAfterDue": 21, "auto": true, "template": "reminder2" },
            { "level": 3, "daysAfterDue": 35, "auto": false, "template": "reminder3", "final": true },
        ],
        "statutoryCosts": { "enabled": statutory, "interest": true },
    } })
}

async fn alone(world: &World) {
    sqlx::query("update entities set jurisdiction_settings = coalesce(jurisdiction_settings, '{}'::jsonb) - 'reminders'")
        .execute(&world.db)
        .await
        .unwrap();
}

async fn set_level(world: &World, id: &str, level: i32) {
    sqlx::query("update invoices set reminder_level = $2 where id = $1")
        .bind(id)
        .bind(level)
        .execute(&world.db)
        .await
        .unwrap();
}

fn level(row: &Value) -> i64 {
    row["reminder_level"].as_i64().unwrap()
}

fn kinds(row: &Value, kind: &str) -> Vec<Value> {
    row["email_history"]
        .as_array()
        .map(|h| h.iter().filter(|e| e["type"] == kind).cloned().collect())
        .unwrap_or_default()
}

#[tokio::test]
async fn the_sweep_sends_the_automatic_steps_that_are_due_and_bundles_a_contact() {
    let _one = ONE_AT_A_TIME.lock().await;
    let Some(world) = World::new() else { return };
    alone(&world).await;
    let on = entity(&world.db, "Acme B.V.", "nl-NL", Some(workflow(false))).await;
    let off = entity(&world.db, "Other B.V.", "nl-NL", None).await;
    let x = customer(&world.db, "X BV", false).await;
    let y = customer(&world.db, "Y BV", false).await;
    let z = customer(&world.db, "Z BV", false).await;
    let w = customer(&world.db, "W BV", false).await;
    let a1 = invoice(
        &world.db,
        &on,
        &x,
        "F-A1",
        "sent",
        8,
        Some("x@example.test"),
    )
    .await;
    let a2 = invoice(
        &world.db,
        &on,
        &x,
        "F-A2",
        "overdue",
        9,
        Some("x@example.test"),
    )
    .await;
    let b = invoice(
        &world.db,
        &on,
        &y,
        "F-B",
        "partial",
        30,
        Some("y@example.test"),
    )
    .await;
    set_level(&world, &b, 1).await;
    let paused = invoice(&world.db, &on, &z, "F-Z", "sent", 8, Some("z@example.test")).await;
    sqlx::query("update invoices set reminders_paused = true where id = $1")
        .bind(&paused)
        .execute(&world.db)
        .await
        .unwrap();
    let early = invoice(&world.db, &on, &w, "F-W", "sent", 3, Some("w@example.test")).await;
    let third = invoice(
        &world.db,
        &on,
        &w,
        "F-W3",
        "overdue",
        60,
        Some("w@example.test"),
    )
    .await;
    set_level(&world, &third, 2).await;
    let other = invoice(
        &world.db,
        &off,
        &x,
        "F-OFF",
        "sent",
        40,
        Some("x@example.test"),
    )
    .await;
    let paid = invoice(
        &world.db,
        &on,
        &x,
        "F-PAID",
        "paid",
        40,
        Some("x@example.test"),
    )
    .await;
    sqlx::query("update invoices set balance_due = '0.00' where id = $1")
        .bind(&paid)
        .execute(&world.db)
        .await
        .unwrap();
    world.events().await;

    let result = send_due_reminders(&world.db, &world.state, WORKSPACE, WORKSPACE, now_ms())
        .await
        .unwrap();
    assert_eq!((result.sent, result.failed), (3, 0));
    let mails = world.mail.sent();
    assert_eq!(
        mails.len(),
        2,
        "X's two invoices are one mail: {:?}",
        mails.iter().map(|m| &m.subject).collect::<Vec<_>>()
    );
    let bundle = mails
        .iter()
        .find(|m| m.to[0].email == "x@example.test")
        .unwrap();
    assert!(
        bundle.subject.starts_with("Herinnering"),
        "{}",
        bundle.subject
    );
    assert!(
        bundle.text.contains("F-A1") && bundle.text.contains("F-A2"),
        "{}",
        bundle.text
    );
    assert!(bundle.text.contains("Openstaande facturen"));
    assert_eq!(bundle.attachments.len(), 2);
    assert_eq!(bundle.from.name.as_deref(), Some("Acme B.V."));
    let second = mails
        .iter()
        .find(|m| m.to[0].email == "y@example.test")
        .unwrap();
    assert!(
        second.subject.starts_with("Tweede herinnering"),
        "{}",
        second.subject
    );

    for id in [&a1, &a2] {
        let row = row_of(&world.db, "invoices", id).await;
        assert_eq!(level(&row), 1);
        assert!(!row["last_reminded_at"].is_null());
        let history = kinds(&row, "reminder");
        assert_eq!(history.len(), 1);
        assert_eq!(
            (history[0]["level"].as_i64(), history[0]["to"].clone()),
            (Some(1), json!(["x@example.test"]))
        );
    }
    // A partial invoice keeps its status; it is reminded at its next level.
    let row = row_of(&world.db, "invoices", &b).await;
    assert_eq!(
        (level(&row), row["status"].as_str().unwrap()),
        (2, "partial")
    );
    // Paused, not yet due, a manual step, another entity's workflow that is off, and a paid one: untouched.
    for id in [&paused, &early, &third, &other, &paid] {
        let row = row_of(&world.db, "invoices", id).await;
        assert!(kinds(&row, "reminder").is_empty(), "{id}");
    }
    assert_eq!(level(&row_of(&world.db, "invoices", &third).await), 2);
    let events = world.events().await;
    let reminded: Vec<&Value> = events
        .iter()
        .filter(|(n, _)| n == "invoice.reminded")
        .map(|(_, d)| d)
        .collect();
    assert_eq!(reminded.len(), 3, "{events:?}");
    assert!(reminded.iter().all(|d| d["automatic"] == true));

    // Again at once: every step that is due went out.
    world.mail.clear();
    let again = send_due_reminders(&world.db, &world.state, WORKSPACE, WORKSPACE, now_ms())
        .await
        .unwrap();
    assert_eq!(again.sent, 0);
    assert_eq!(world.mail.sent(), Vec::new());
    // A month on, the second step is due for X's invoices.
    let later = send_due_reminders(
        &world.db,
        &world.state,
        WORKSPACE,
        WORKSPACE,
        now_ms() + 20 * 86_400_000,
    )
    .await
    .unwrap();
    assert!(later.sent >= 2, "{later:?}");
    assert_eq!(level(&row_of(&world.db, "invoices", &a1).await), 2);
    // The manual third step still waits for the owner.
    assert_eq!(level(&row_of(&world.db, "invoices", &third).await), 2);
}

#[tokio::test]
async fn a_sweep_without_mail_sends_nothing_and_changes_nothing() {
    let _one = ONE_AT_A_TIME.lock().await;
    let Some(mut world) = World::new() else {
        return;
    };
    alone(&world).await;
    let on = entity(&world.db, "Acme B.V.", "nl-NL", Some(workflow(false))).await;
    let x = customer(&world.db, "X BV", false).await;
    let a = invoice(
        &world.db,
        &on,
        &x,
        "F-NM",
        "sent",
        10,
        Some("x@example.test"),
    )
    .await;
    world.state.mail = None;
    let result = send_due_reminders(&world.db, &world.state, WORKSPACE, WORKSPACE, now_ms())
        .await
        .unwrap();
    assert_eq!((result.sent, result.failed), (0, 1));
    let row = row_of(&world.db, "invoices", &a).await;
    assert_eq!(level(&row), 0);
    assert!(row["email_history"].is_null());
}

#[tokio::test]
async fn the_final_reminder_of_a_business_claims_the_costs_and_interest() {
    let _one = ONE_AT_A_TIME.lock().await;
    let Some(world) = World::new() else { return };
    alone(&world).await;
    let on = entity(&world.db, "Acme B.V.", "nl-NL", Some(workflow(true))).await;
    let x = customer(&world.db, "X BV", false).await;
    let id = invoice(
        &world.db,
        &on,
        &x,
        "F-WIK",
        "overdue",
        40,
        Some("x@example.test"),
    )
    .await;
    set_level(&world, &id, 2).await;
    let caller = world.caller(&on);
    let (status, out) = answer(remind_invoice(&caller, &world.state, &id).await).await;
    assert_eq!(status, 200, "{out}");
    let claim = &out["data"]["reminder"]["claim"];
    // 121.00 owed: the scale's minimum of 40.00, and 10.40% for 40 days = 1.38.
    assert_eq!(claim["costs"], "40.00");
    assert_eq!(claim["interest"], "1.38");
    assert_eq!(claim["total"], "162.38");
    assert_eq!(
        (claim["costsDue"].clone(), claim["isNotice"].clone()),
        (json!(true), json!(false))
    );
    let mail = &world.mail.sent()[0];
    assert!(
        mail.subject.starts_with("Aanmaning incassokosten"),
        "{}",
        mail.subject
    );
    assert!(
        mail.text.contains("€ 40,00")
            && mail.text.contains("€ 1,38")
            && mail.text.contains("€ 162,38"),
        "{}",
        mail.text
    );
    let row = row_of(&world.db, "invoices", &id).await;
    assert_eq!(level(&row), 3);
    assert_eq!(kinds(&row, "reminder")[0]["claim"]["total"], "162.38");
    // The invoice itself is not changed by the claim.
    assert_eq!(row["total"].as_f64(), Some(121.0));
    assert_eq!(row["balance_due"].as_f64(), Some(121.0));
    let events = world.events().await;
    assert!(
        events
            .iter()
            .any(|(n, d)| n == "invoice.reminded" && d["level"] == 3 && d["automatic"] == false)
    );
    // Nothing more to send.
    let (status, _) = answer(remind_invoice(&caller, &world.state, &id).await).await;
    assert_eq!(status, 409);
}

#[tokio::test]
async fn a_consumer_gets_the_14_day_notice_first_and_the_claim_after_the_term() {
    let _one = ONE_AT_A_TIME.lock().await;
    let Some(world) = World::new() else { return };
    alone(&world).await;
    let on = entity(&world.db, "Acme B.V.", "nl-NL", Some(workflow(true))).await;
    let person = customer(&world.db, "Piet Jansen", true).await;
    let id = invoice(
        &world.db,
        &on,
        &person,
        "F-B2C",
        "overdue",
        50,
        Some("piet@example.test"),
    )
    .await;
    set_level(&world, &id, 2).await;
    let caller = world.caller(&on);

    let (status, out) = answer(remind_invoice(&caller, &world.state, &id).await).await;
    assert_eq!(status, 200, "{out}");
    let claim = &out["data"]["reminder"]["claim"];
    assert_eq!(
        (claim["isNotice"].clone(), claim["costsDue"].clone()),
        (json!(true), json!(false))
    );
    assert_eq!(claim["total"], "121.00", "no costs and no interest yet");
    assert_eq!(claim["costs"], "40.00");
    assert!(world.mail.sent()[0].subject.contains("14-dagenbrief"));
    assert!(world.mail.sent()[0].text.contains("14 dagen"));
    // Inside the term nothing is sent.
    let (status, _) = answer(remind_invoice(&caller, &world.state, &id).await).await;
    assert_eq!(status, 409);

    // The notice went out 20 days ago: the claim follows, once.
    let old = (time::OffsetDateTime::now_utc() - time::Duration::days(20))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    sqlx::query("update invoices set email_history = $2::jsonb where id = $1")
        .bind(&id)
        .bind(json!([{ "type": "reminder", "at": old, "level": 3, "claim": { "isNotice": true, "costsDue": false } }]))
        .execute(&world.db)
        .await
        .unwrap();
    world.mail.clear();
    let (status, out) = answer(remind_invoice(&caller, &world.state, &id).await).await;
    assert_eq!(status, 200, "{out}");
    let claim = &out["data"]["reminder"]["claim"];
    assert_eq!(
        (claim["costsDue"].clone(), claim["isNotice"].clone()),
        (json!(true), json!(false))
    );
    // 6 days past the term at 4%: 1.21 x 6/365... on 121.00 that is 0.08.
    assert_eq!(claim["interest"], "0.08");
    assert_eq!(claim["total"], "161.08");
    assert!(
        world.mail.sent()[0]
            .subject
            .starts_with("Aanmaning incassokosten")
    );
    let (status, _) = answer(remind_invoice(&caller, &world.state, &id).await).await;
    assert_eq!(status, 409, "claimed once");
}

#[tokio::test]
async fn a_reminder_needs_an_open_invoice_and_an_address() {
    let _one = ONE_AT_A_TIME.lock().await;
    let Some(world) = World::new() else { return };
    alone(&world).await;
    let on = entity(&world.db, "Acme B.V.", "nl-NL", Some(workflow(false))).await;
    let x = customer(&world.db, "X BV", false).await;
    let caller = world.caller(&on);
    let paid = invoice(&world.db, &on, &x, "F-P", "paid", 5, Some("x@example.test")).await;
    sqlx::query("update invoices set balance_due = '0.00' where id = $1")
        .bind(&paid)
        .execute(&world.db)
        .await
        .unwrap();
    let draft = invoice(
        &world.db,
        &on,
        &x,
        "F-D",
        "draft",
        5,
        Some("x@example.test"),
    )
    .await;
    let no_address = invoice(&world.db, &on, &x, "F-NA", "sent", 5, None).await;
    assert_eq!(
        answer(remind_invoice(&caller, &world.state, &paid).await)
            .await
            .0,
        409
    );
    assert_eq!(
        answer(remind_invoice(&caller, &world.state, &draft).await)
            .await
            .0,
        409
    );
    assert_eq!(
        answer(remind_invoice(&caller, &world.state, &no_address).await)
            .await
            .0,
        400
    );
    assert_eq!(
        answer(remind_invoice(&caller, &world.state, "inv_missing").await)
            .await
            .0,
        404
    );
    assert_eq!(world.mail.sent(), Vec::new());
    // A first reminder can be sent before its days: "send now".
    let early = invoice(&world.db, &on, &x, "F-E", "sent", 1, Some("x@example.test")).await;
    let (status, out) = answer(remind_invoice(&caller, &world.state, &early).await).await;
    assert_eq!(status, 200, "{out}");
    assert_eq!(level(&row_of(&world.db, "invoices", &early).await), 1);
}

#[tokio::test]
async fn pausing_holds_the_sweep_and_resuming_releases_it() {
    let _one = ONE_AT_A_TIME.lock().await;
    let Some(world) = World::new() else { return };
    alone(&world).await;
    let on = entity(&world.db, "Acme B.V.", "nl-NL", Some(workflow(false))).await;
    let x = customer(&world.db, "X BV", false).await;
    let id = invoice(
        &world.db,
        &on,
        &x,
        "F-PAUSE",
        "sent",
        10,
        Some("x@example.test"),
    )
    .await;
    let caller = world.caller(&on);
    let (status, out) = answer(pause_invoice(&caller, &world.state, &id, true).await).await;
    assert_eq!(status, 200);
    assert_eq!(out["data"]["remindersPaused"], true);
    assert_eq!(
        send_due_reminders(&world.db, &world.state, WORKSPACE, WORKSPACE, now_ms())
            .await
            .unwrap()
            .sent,
        0
    );
    let (_, out) = answer(pause_invoice(&caller, &world.state, &id, false).await).await;
    assert_eq!(out["data"]["remindersPaused"], false);
    assert_eq!(
        send_due_reminders(&world.db, &world.state, WORKSPACE, WORKSPACE, now_ms())
            .await
            .unwrap()
            .sent,
        1
    );
    assert_eq!(
        answer(pause_invoice(&caller, &world.state, "inv_missing", true).await)
            .await
            .0,
        404
    );
}

#[tokio::test]
async fn a_bulk_reminder_bundles_a_contact_and_stays_inside_its_entity() {
    let _one = ONE_AT_A_TIME.lock().await;
    let Some(world) = World::new() else { return };
    alone(&world).await;
    let on = entity(&world.db, "Acme B.V.", "nl-NL", None).await;
    let off = entity(&world.db, "Other B.V.", "nl-NL", None).await;
    let x = customer(&world.db, "X BV", false).await;
    let y = customer(&world.db, "Y BV", false).await;
    let a1 = invoice(
        &world.db,
        &on,
        &x,
        "F-BU1",
        "sent",
        10,
        Some("x@example.test"),
    )
    .await;
    let a2 = invoice(
        &world.db,
        &on,
        &x,
        "F-BU2",
        "overdue",
        12,
        Some("x@example.test"),
    )
    .await;
    let b = invoice(
        &world.db,
        &on,
        &y,
        "F-BU3",
        "sent",
        10,
        Some("y@example.test"),
    )
    .await;
    let no_mail = invoice(&world.db, &on, &y, "F-BU4", "sent", 10, None).await;
    let paid = invoice(
        &world.db,
        &on,
        &x,
        "F-BU5",
        "paid",
        10,
        Some("x@example.test"),
    )
    .await;
    sqlx::query("update invoices set balance_due = '0.00' where id = $1")
        .bind(&paid)
        .execute(&world.db)
        .await
        .unwrap();
    let foreign = invoice(
        &world.db,
        &off,
        &x,
        "F-BU6",
        "sent",
        10,
        Some("x@example.test"),
    )
    .await;

    let ids = vec![
        a1.clone(),
        a2.clone(),
        b.clone(),
        no_mail.clone(),
        paid.clone(),
        foreign.clone(),
        "inv_missing".to_owned(),
    ];
    let (status, out) = answer(remind_many(&world.caller(&on), &world.state, ids).await).await;
    assert_eq!(status, 200, "{out}");
    let sent = out["data"]["sent"].as_array().unwrap();
    assert_eq!(sent.len(), 2, "{out}");
    let bundle = sent
        .iter()
        .find(|s| s["invoiceIds"].as_array().unwrap().len() == 2)
        .unwrap_or_else(|| panic!("no bundle of two: {out}"));
    assert_eq!(bundle["level"], 1);
    assert_eq!(bundle["to"], json!(["x@example.test"]));
    let skipped: Vec<(String, String)> = out["data"]["skipped"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["invoiceId"].as_str().unwrap().to_owned(),
                s["reason"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    for (id, reason) in [
        (&paid, "not_open"),
        (&foreign, "not_found"),
        (&"inv_missing".to_owned(), "not_found"),
    ] {
        assert!(
            skipped.contains(&(id.clone(), reason.to_owned())),
            "{id} {reason}: {skipped:?}"
        );
    }
    // `b` has an address, its sibling has none: the one mail goes out under the contact's name.
    assert_eq!(world.mail.sent().len(), 2);
    assert_eq!(level(&row_of(&world.db, "invoices", &a1).await), 1);
    assert_eq!(level(&row_of(&world.db, "invoices", &a2).await), 1);
    assert_eq!(
        level(&row_of(&world.db, "invoices", &foreign).await),
        0,
        "another entity's invoice is not touched"
    );
    assert!(row_of(&world.db, "invoices", &foreign).await["email_history"].is_null());
    let events = world.events().await;
    assert_eq!(
        events
            .iter()
            .filter(|(n, _)| n == "invoice.reminded")
            .count(),
        sent.iter()
            .map(|s| s["invoiceIds"].as_array().unwrap().len())
            .sum::<usize>()
    );
}

#[tokio::test]
async fn a_contact_with_reminders_paused_gets_none_from_the_sweep_or_a_bulk_reminder() {
    let _one = ONE_AT_A_TIME.lock().await;
    let Some(world) = World::new() else { return };
    alone(&world).await;
    let on = entity(&world.db, "Acme B.V.", "nl-NL", Some(workflow(false))).await;
    let held = customer(&world.db, "Gepauzeerd BV", false).await;
    let open = customer(&world.db, "Open BV", false).await;
    let a = invoice(
        &world.db,
        &on,
        &held,
        "F-HELD",
        "sent",
        8,
        Some("held@example.test"),
    )
    .await;
    let b = invoice(
        &world.db,
        &on,
        &open,
        "F-OPEN",
        "sent",
        8,
        Some("open@example.test"),
    )
    .await;
    // The pause is the contact's in this entity: the entity's list, next to its workflow.
    let other = entity(&world.db, "Other B.V.", "nl-NL", Some(workflow(false))).await;
    let was = set_contact_paused(&world.db, &on, &held, true)
        .await
        .unwrap();
    assert!(!was);
    let settings = row_of(&world.db, "entities", &on).await["jurisdiction_settings"].clone();
    assert_eq!(settings["reminders"]["pausedContactIds"], json!([held]));
    assert_eq!(settings["reminders"]["enabled"], json!(true));
    // Another entity of the workspace does not hold it.
    assert!(
        paused_contacts(&world.db, &other, std::slice::from_ref(&held))
            .await
            .unwrap()
            .is_empty()
    );

    // A bulk reminder skips the held contact's invoice and names the reason.
    let (status, out) =
        answer(remind_many(&world.caller(&on), &world.state, vec![a.clone(), b.clone()]).await)
            .await;
    assert_eq!(status, 200, "{out}");
    let sent = out["data"]["sent"].as_array().unwrap();
    assert_eq!(sent.len(), 1, "{out}");
    assert_eq!(sent[0]["invoiceIds"], json!([b]));
    assert_eq!(
        out["data"]["skipped"],
        json!([{ "invoiceId": a, "reason": "contact_paused" }])
    );
    assert_eq!(level(&row_of(&world.db, "invoices", &a).await), 0);
    assert_eq!(level(&row_of(&world.db, "invoices", &b).await), 1);

    // The sweep leaves it alone too, until the pause is lifted.
    let result = send_due_reminders(&world.db, &world.state, WORKSPACE, WORKSPACE, now_ms())
        .await
        .unwrap();
    assert_eq!(result.failed, 0);
    assert_eq!(level(&row_of(&world.db, "invoices", &a).await), 0);
    assert!(
        set_contact_paused(&world.db, &on, &held, false)
            .await
            .unwrap()
    );
    send_due_reminders(&world.db, &world.state, WORKSPACE, WORKSPACE, now_ms())
        .await
        .unwrap();
    assert_eq!(level(&row_of(&world.db, "invoices", &a).await), 1);
}

#[tokio::test]
async fn an_old_pause_moves_to_the_default_entity_when_it_is_read() {
    let _one = ONE_AT_A_TIME.lock().await;
    let Some(world) = World::new() else { return };
    alone(&world).await;
    let on = entity(&world.db, "Acme B.V.", "nl-NL", Some(workflow(false))).await;
    let held = customer(&world.db, "Oud gepauzeerd BV", false).await;
    // Phase 5 kept the pause in the party's jsonb, next to whatever else is there.
    sqlx::query("update parties set average_deal_size = $2 where id = $1")
        .bind(&held)
        .bind(json!({ "amount": 5, "weldbooks": { "remindersPaused": true } }))
        .execute(&world.db)
        .await
        .unwrap();
    let destination = weldsuite_legal_entities::default_entity_id_for(
        &world.db,
        Some(weldsuite_legal_entities::LegalEntityApp::Weldbooks),
    )
    .await
    .unwrap()
    .unwrap_or_else(|| on.clone());

    // Reading it anywhere moves it: the default entity holds it, the old key is gone.
    let seen = paused_contacts(&world.db, &destination, std::slice::from_ref(&held))
        .await
        .unwrap();
    assert!(seen.contains(&held));
    let column = row_of(&world.db, "parties", &held).await["average_deal_size"].clone();
    assert_eq!(column, json!({ "amount": 5 }));
    let settings =
        row_of(&world.db, "entities", &destination).await["jurisdiction_settings"].clone();
    assert!(
        settings["reminders"]["pausedContactIds"]
            .as_array()
            .unwrap()
            .contains(&json!(held)),
        "{settings}"
    );
    // The other keys of the entity's workflow stay.
    if destination == on {
        assert_eq!(settings["reminders"]["enabled"], json!(true));
    }
    // And it reads the same the second time.
    assert!(
        contact_paused(&world.db, &destination, &held)
            .await
            .unwrap()
    );
}
