//! The purchases area's shared modules on the real tenant schema (built from
//! the journaled migrations by `scripts/rust-test-db.ts`): a company's
//! billing contact (set, moved, cleared), the contact snapshot documents
//! keep, the reveal log of a sealed TIN, and the VIES cache with a fake
//! VIES behind the outbound port.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use weldsuite_books_domain::contacts::{
    clear_billing_contact, document_contact_fields, load_billing_contacts, load_contact_snapshot,
    set_billing_contact, with_contact_names,
};
use weldsuite_books_domain::vendor_tax::{
    SecretField, VendorTaxError, VendorTaxInput, build_vendor_tax_change, reveal_party_secret,
};
use weldsuite_books_domain::vies::{VIES_API_URL, check_vat_number};
use weldsuite_db::{Keyring, master_pool};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::Field;
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
};

async fn person(db: &sqlx::PgPool, name: &str, email: Option<&str>) -> String {
    let id = generate_id("per");
    sqlx::query("insert into people (id, display_name, email) values ($1, $2, $3)")
        .bind(&id)
        .bind(name)
        .bind(email)
        .execute(db)
        .await
        .expect("person");
    id
}

async fn company(db: &sqlx::PgPool, name: &str, email: Option<&str>) -> String {
    let id = generate_id("cmp");
    sqlx::query("insert into companies (id, name, display_name, email) values ($1, $2, $2, $3)")
        .bind(&id)
        .bind(name)
        .bind(email)
        .execute(db)
        .await
        .expect("company");
    id
}

async fn party(db: &sqlx::PgPool, company_id: Option<&str>, display: Option<&str>) -> String {
    let id = generate_id("acn");
    sqlx::query(
        "insert into parties (id, kind, company_id, display_name) values ($1, 'company', $2, $3)",
    )
    .bind(&id)
    .bind(company_id)
    .bind(display)
    .execute(db)
    .await
    .expect("party");
    id
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one scenario, step by step
async fn contacts_and_vendor_secrets_on_the_real_schema() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");

    // A company without an email of its own, two people.
    let acme = company(&db, "Acme", None).await;
    let ann = person(&db, "Ann", Some("ann@acme.test")).await;
    let bob = person(&db, "Bob", Some("bob@acme.test")).await;

    let first = set_billing_contact(&db, &acme, &ann)
        .await
        .expect("set ann");
    assert!(first.created && first.changed);
    assert_eq!(first.demoted_person_ids, Vec::<String>::new());
    let again = set_billing_contact(&db, &acme, &ann)
        .await
        .expect("set ann again");
    assert!(!again.created && !again.changed);
    assert_eq!(again.link_id, first.link_id);

    let moved = set_billing_contact(&db, &acme, &bob)
        .await
        .expect("set bob");
    assert!(moved.created && moved.changed);
    assert_eq!(moved.demoted_person_ids, std::slice::from_ref(&ann));
    let contacts = load_billing_contacts(&db, &[acme.clone(), acme.clone()])
        .await
        .expect("billing contacts");
    assert_eq!(contacts[&acme]["id"], json!(bob));
    assert_eq!(contacts[&acme]["email"], json!("bob@acme.test"));

    // A document's snapshot: the party's name, the contact person's email.
    let acme_party = party(&db, Some(&acme), Some("Acme Trading")).await;
    let snapshot = load_contact_snapshot(&db, Some(&acme_party))
        .await
        .expect("snapshot");
    assert_eq!(snapshot.name.as_deref(), Some("Acme Trading"));
    assert_eq!(snapshot.email.as_deref(), Some("bob@acme.test"));
    let fields = document_contact_fields(&db, Some(&acme_party), Some("  Typed "), None)
        .await
        .expect("fields");
    assert_eq!(fields.name.as_deref(), Some("Typed"));
    assert_eq!(fields.email.as_deref(), Some("bob@acme.test"));
    let named = with_contact_names(
        &db,
        vec![
            json!({ "contactId": acme_party, "contactName": null }),
            json!({ "contactId": acme_party, "contactName": "Kept" }),
        ],
    )
    .await
    .expect("names");
    assert_eq!(named[0]["contactName"], json!("Acme Trading"));
    assert_eq!(named[1]["contactName"], json!("Kept"));

    assert_eq!(
        clear_billing_contact(&db, &acme).await.expect("clear"),
        std::slice::from_ref(&bob)
    );
    assert!(
        load_billing_contacts(&db, std::slice::from_ref(&acme))
            .await
            .expect("none left")
            .is_empty()
    );

    // A sealed TIN, revealed with a log row first.
    let keyring = Keyring {
        v1: None,
        v2: Some("ab".repeat(32)),
    };
    let input = VendorTaxInput {
        tin_type: Field::Set("ssn".to_owned()),
        tin: Field::Set("123-45-6789".to_owned()),
        ach_routing_number: Field::Set("021000021".to_owned()),
        ach_account_number: Field::Set("000123456789".to_owned()),
        ..VendorTaxInput::default()
    };
    let change = build_vendor_tax_change(None, &input, &keyring).expect("change");
    let sealed = change.columns["sensitiveEncrypted"]
        .as_str()
        .expect("sealed")
        .to_owned();
    sqlx::query("update parties set sensitive_encrypted = $2, tin_last4 = '6789', tin_type = 'ssn' where id = $1")
        .bind(&acme_party)
        .bind(&sealed)
        .execute(&db)
        .await
        .expect("seal");
    let row = json!({ "id": acme_party, "sensitiveEncrypted": sealed });
    let tin = reveal_party_secret(
        &db,
        &keyring,
        &row,
        SecretField::Tin,
        "user_1",
        Some("1099"),
        None,
    )
    .await
    .expect("reveal");
    assert_eq!(tin, "123456789");
    let account = reveal_party_secret(
        &db,
        &keyring,
        &row,
        SecretField::AchAccountNumber,
        "user_1",
        None,
        None,
    )
    .await
    .expect("reveal account");
    assert_eq!(account, "000123456789");
    let logged: Vec<String> = sqlx::query_scalar(
        "select field from tax_id_reveals where subject_type = 'party' and subject_id = $1 order by field",
    )
    .bind(&acme_party)
    .fetch_all(&db)
    .await
    .expect("log");
    assert_eq!(logged, ["ach_account_number", "tin"]);
    let nothing = json!({ "id": acme_party });
    assert_eq!(
        reveal_party_secret(&db, &keyring, &nothing, SecretField::Tin, "u", None, None).await,
        Err(VendorTaxError::SecretNotFound(SecretField::Tin))
    );
}

/// VIES behind the port: answers by the VAT number in the body.
struct FakeVies {
    calls: Mutex<Vec<Value>>,
}

impl DynOutboundHttp for FakeVies {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        Box::pin(async move {
            assert_eq!(request.url, VIES_API_URL);
            let body: Value =
                serde_json::from_slice(request.body.as_deref().unwrap_or_default()).expect("json");
            self.calls.lock().expect("calls").push(body.clone());
            let answer = match body["vatNumber"].as_str() {
                Some("123456789B01") => {
                    json!({ "valid": true, "name": "ACME BV", "address": "---", "requestIdentifier": "WAPI1" })
                }
                Some("000000000B00") => json!({ "valid": false }),
                _ => json!({ "valid": false, "errorWrappers": [{ "error": "MS_UNAVAILABLE" }] }),
            };
            Ok(HttpResponse::new(200, answer.to_string().into_bytes()))
        })
    }
}

#[tokio::test]
async fn vies_answers_are_cached_per_tenant() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");
    sqlx::query("delete from vies_checks where vat_number in ('NL123456789B01', 'NL000000000B00', 'DE999999999')")
        .execute(&db)
        .await
        .expect("clean");
    let fake = Arc::new(FakeVies {
        calls: Mutex::default(),
    });
    let http = OutboundHttp(fake.clone());

    let valid = check_vat_number(&db, Some(&http), "nl 1234.56.789 b01")
        .await
        .expect("valid");
    assert!(valid.available && valid.valid && !valid.from_cache);
    assert_eq!(valid.trader_name.as_deref(), Some("ACME BV"));
    assert_eq!(valid.trader_address, None);
    assert_eq!(valid.consultation_number.as_deref(), Some("WAPI1"));
    let cached = check_vat_number(&db, Some(&http), "NL123456789B01")
        .await
        .expect("cached");
    assert!(cached.from_cache && cached.valid);
    assert_eq!(fake.calls.lock().expect("calls").len(), 1);

    let invalid = check_vat_number(&db, Some(&http), "NL000000000B00")
        .await
        .expect("invalid");
    assert!(invalid.available && !invalid.valid);

    let down = check_vat_number(&db, Some(&http), "DE999999999")
        .await
        .expect("down");
    assert!(!down.available && !down.valid);
    let stored: i64 =
        sqlx::query_scalar("select count(*) from vies_checks where vat_number = 'DE999999999'")
            .fetch_one(&db)
            .await
            .expect("count");
    assert_eq!(stored, 0, "an outage is never cached");

    let malformed = check_vat_number(&db, None, "12").await.expect("malformed");
    assert!(malformed.available && !malformed.valid);
    let offline = check_vat_number(&db, None, "NL123456789B01")
        .await
        .expect("offline");
    assert!(offline.from_cache, "a cached answer needs no VIES");
}
