//! The two-way sync's SQL against the real tenant schema (ADR INT-013):
//! every query runs, an import sets a contact's baseline, a WeldBooks edit
//! makes it a candidate, Moneybird's echo of that edit re-baselines it, a
//! Moneybird delete drops it, and only records made after the object was
//! switched on are new.
//!
//! Needs `WELDSUITE_TEST_TENANT_URL`; skips without it. Rows carry a fresh
//! suffix, so runs share the database with other tests: assertions are
//! about this test's records, never "nothing to do" for the whole database.

#![allow(clippy::unwrap_used, clippy::too_many_lines)]

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_events::{EntityEventPublisher, TaskTracker};

use super::*;
use crate::catalog::{get_connector, syncs};
use crate::ingest::{IngestArgs, IngestResult, ingest_records};

async fn tenant() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return None;
    };
    Some(
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .unwrap(),
    )
}

fn suffix() -> String {
    weldsuite_kit::generate_id("t")
        .trim_start_matches("t_")
        .chars()
        .rev()
        .take(10)
        .collect()
}

fn sync(name: &str) -> &'static Value {
    syncs(get_connector("moneybird").unwrap())
        .iter()
        .find(|s| s["syncName"] == name)
        .unwrap()
}

async fn import(
    db: &PgPool,
    connection_id: &str,
    records: Vec<Value>,
    force_deleted: bool,
) -> IngestResult {
    let events = EntityEventPublisher::new(None, TaskTracker::new());
    ingest_records(&IngestArgs {
        db,
        http: None,
        events: &events,
        connection_id,
        provider: "moneybird",
        display_name: Some("Books"),
        store_url: None,
        sync: sync("moneybird-contacts"),
        records,
        owner_id: "user_two_way_test",
        workspace_id: "ws_two_way_test",
        entity_id: None,
        force_deleted,
        moneybird_files: None,
        stripe_files: None,
        skip_financial_account_ids: &[],
    })
    .await
    .unwrap()
}

async fn baseline(db: &PgPool, connection_id: &str, external_id: &str) -> Option<(String, String)> {
    sqlx::query_as(
        "select internal_entity_id, sync_checksum from integration_entity_mappings
         where connection_id = $1 and external_entity_type = 'moneybird_baseline_contact'
           and external_entity_id = $2",
    )
    .bind(connection_id)
    .bind(external_id)
    .fetch_optional(db)
    .await
    .unwrap()
}

#[tokio::test]
async fn every_query_runs_against_the_schema() {
    let Some(db) = tenant().await else {
        return;
    };
    let id = format!("cc_q{}", suffix());
    let since = "2026-01-01T00:00:00.000Z";
    for inbound in [
        MB_CONTACT_TYPE,
        PRODUCT_TYPE,
        SALES_INVOICE_TYPE,
        PURCHASE_INVOICE_TYPE,
        RECEIPT_TYPE,
    ] {
        changed_candidates(&db, &id, inbound, 5).await.unwrap();
        unbaselined(&db, &id, inbound, 5).await.unwrap();
        assert!(!create_in_flight(&db, &id, inbound).await.unwrap());
    }
    for inbound in [MB_CONTACT_TYPE, PRODUCT_TYPE, PURCHASE_INVOICE_TYPE] {
        new_records(&db, &id, inbound, since, false, 5)
            .await
            .unwrap();
    }
    new_invoice_ids(&db, &id, since, true, 5).await.unwrap();
    for key in ["invoices", "bills"] {
        new_payments(&db, &id, payment_types(key), since, false, 5)
            .await
            .unwrap();
        voided_payments(&db, &id, payment_types(key), 5)
            .await
            .unwrap();
    }
    assert!(contact_state(&db, "party_missing").await.unwrap().is_none());
    assert!(product_state(&db, "prd_missing").await.unwrap().is_none());
    assert!(doc_state(&db, true, "inv_missing").await.unwrap().is_none());
    assert!(
        doc_state(&db, false, "bil_missing")
            .await
            .unwrap()
            .is_none()
    );
    drop_baseline(&db, &id, MB_CONTACT_TYPE, "none")
        .await
        .unwrap();
}

#[tokio::test]
async fn a_contact_goes_round_without_echoes() {
    let Some(db) = tenant().await else {
        return;
    };
    let s = suffix();
    let connection_id = format!("cc_c{s}");
    sqlx::query(
        "insert into connector_connections (id, provider, status, direction, object_sync_directions, settings)
         values ($1, 'moneybird', 'active', 'inbound', '{\"contacts\": \"bidirectional\"}'::jsonb, '{}'::jsonb)",
    )
    .bind(&connection_id)
    .execute(&db)
    .await
    .unwrap();
    let row = crate::connections::get_connection(&db, &connection_id)
        .await
        .unwrap()
        .unwrap();
    let row = stamp_since(&db, &row).await.unwrap();
    assert!(since(&row, "contacts").is_some());
    let reread = crate::connections::get_connection(&db, &connection_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(since(&reread, "contacts"), since(&row, "contacts"), "saved");

    // Imported from Moneybird: mapped, and baselined as WeldBooks has it.
    let external_id = format!("mb{s}");
    let contact = json!({
        "id": external_id,
        "company_name": format!("Acme {s}"),
        "email": format!("acme{s}@example.test"),
        "phone": "+31 20 000 0000",
        "address1": "Main 1",
        "zipcode": "1000 AA",
        "city": "Amsterdam",
        "country": "NL",
        "updated_at": "2026-11-20T10:00:00.000Z",
        "version": 1,
    });
    let imported = import(&db, &connection_id, vec![contact.clone()], false).await;
    assert_eq!(imported.created, 1, "{imported:?}");
    let (party_id, hash) = baseline(&db, &connection_id, &external_id).await.unwrap();
    let state = contact_state(&db, &party_id).await.unwrap().unwrap();
    assert_eq!(state.hashed().hash, hash);
    assert!(
        changed_candidates(&db, &connection_id, MB_CONTACT_TYPE, 5)
            .await
            .unwrap()
            .is_empty(),
        "nothing changed since the import"
    );

    // Edited in WeldBooks: a candidate whose hash moved.
    sqlx::query(
        "update companies set phone = '+31 20 111 1111',
           updated_at = (now() at time zone 'utc') + interval '1 second'
         where id = (select company_id from parties where id = $1)",
    )
    .bind(&party_id)
    .execute(&db)
    .await
    .unwrap();
    let candidates = changed_candidates(&db, &connection_id, MB_CONTACT_TYPE, 5)
        .await
        .unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].internal_id, party_id);
    assert_eq!(candidates[0].external_id, external_id);
    let edited = contact_state(&db, &party_id).await.unwrap().unwrap();
    assert_ne!(edited.hashed().hash, candidates[0].baseline);
    assert_eq!(edited.update["phone"], "+31 20 111 1111");
    assert_eq!(
        edited.update["address2"], "",
        "a cleared field is sent empty"
    );
    assert!(has_work(&db, &row, false).await.unwrap());

    // Moneybird's echo of the pushed edit re-baselines it: no loop.
    let mut echoed = contact.clone();
    echoed["phone"] = json!("+31 20 111 1111");
    echoed["version"] = json!(2);
    echoed["updated_at"] = json!("2026-11-21T10:00:00.000Z");
    import(&db, &connection_id, vec![echoed], false).await;
    assert!(
        changed_candidates(&db, &connection_id, MB_CONTACT_TYPE, 5)
            .await
            .unwrap()
            .is_empty(),
        "the echo re-baselined it"
    );
    let (_, rebased) = baseline(&db, &connection_id, &external_id).await.unwrap();
    assert_eq!(
        rebased,
        contact_state(&db, &party_id)
            .await
            .unwrap()
            .unwrap()
            .hashed()
            .hash
    );

    // A party made in WeldBooks after the switch is new; one the import
    // made is not.
    let made = format!("party_n{s}");
    sqlx::query(
        "insert into parties (id, kind, display_name, role, created_at, updated_at)
         values ($1, 'company', $2, 'customer', now() at time zone 'utc', now() at time zone 'utc')",
    )
    .bind(&made)
    .bind(format!("New {s}"))
    .execute(&db)
    .await
    .unwrap();
    let since_at = since(&row, "contacts").unwrap();
    let new = new_records(&db, &connection_id, MB_CONTACT_TYPE, &since_at, false, 50)
        .await
        .unwrap();
    assert!(new.contains(&made));
    assert!(!new.contains(&party_id));

    // Deleted in Moneybird: the baseline goes with it.
    import(&db, &connection_id, vec![contact], true).await;
    assert!(baseline(&db, &connection_id, &external_id).await.is_none());
}
