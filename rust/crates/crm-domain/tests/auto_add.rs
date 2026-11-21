//! Auto-add against the real tenant schema (built from the journaled
//! migrations by `scripts/rust-test-db.ts`, as CI does): the setting's
//! storage, who is skipped, promoting a hidden person, creating one, the
//! company of the email domain, the events, and a source switched off.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::sync::Arc;

use weldsuite_crm_domain::auto_add::{self, Candidate, Patch, Settings, Source};
use weldsuite_crm_domain::events::OrderedEvents;
use weldsuite_db::PgPool;
use weldsuite_events::{EntityEventPublisher, EventContext, TaskTracker};
use weldsuite_ports::RecordingEventBus;

/// `(in CRM, owner)` of the live person with this address.
async fn person(db: &PgPool, email: &str) -> Option<(bool, Option<String>, String)> {
    sqlx::query_as(
        "select in_crm, owner_id, id from people where lower(email) = $1 and deleted_at is null",
    )
    .bind(email)
    .fetch_optional(db)
    .await
    .expect("person")
}

/// The names of the companies the person is linked to.
async fn companies_of(db: &PgPool, person_id: &str) -> Vec<String> {
    sqlx::query_scalar(
        "select c.name from person_companies pc join companies c on c.id = pc.company_id
          where pc.person_id = $1 and pc.ended_at is null order by c.name",
    )
    .bind(person_id)
    .fetch_all(db)
    .await
    .expect("links")
}

async fn clean_up(db: &PgPool, tag: &str) {
    let like = format!("%{tag}%");
    for statement in [
        "delete from person_companies where person_id in (select id from people where email like $1)",
        "delete from parties where person_id in (select id from people where email like $1)",
        "delete from parties where company_id in (select id from companies where website like $1)",
        "delete from people where email like $1",
        "delete from companies where website like $1",
        "delete from workspace_members where email like $1",
    ] {
        sqlx::query(statement)
            .bind(&like)
            .execute(db)
            .await
            .expect(statement);
    }
}

/// A member on the workspace's own domain, a hidden person (as mail leaves
/// them) at Acme, and a CRM contact at a domain no company's website matches.
async fn seed(db: &PgPool, tag: &str, acme: &str, ours: &str, owner: &str) {
    sqlx::query(
        "insert into people (id, display_name, email, in_crm) values ($1, 'eva', $2, true)",
    )
    .bind(format!("contact_{tag}"))
    .bind(format!("eva@known-{tag}.test"))
    .execute(db)
    .await
    .expect("CRM contact");
    sqlx::query("insert into workspace_members (id, user_id, email) values ($1, $2, $3)")
        .bind(format!("wm_{tag}"))
        .bind(owner)
        .bind(format!("ann@{ours}"))
        .execute(db)
        .await
        .expect("member");
    sqlx::query(
        "insert into people (id, display_name, email, in_crm) values ($1, 'jan', $2, false)",
    )
    .bind(format!("person_{tag}"))
    .bind(format!("jan@{acme}"))
    .execute(db)
    .await
    .expect("hidden person");
}

/// Who the first run added, and how.
async fn assert_added(db: &PgPool, tag: &str, acme: &str, ours: &str, owner: &str) {
    // The hidden person is promoted, owned by the member who engaged.
    let (in_crm, jan_owner, jan) = person(db, &format!("jan@{acme}")).await.expect("jan");
    assert!(in_crm);
    assert_eq!(jan_owner.as_deref(), Some(owner));
    // A new person is created in the CRM, at the same company.
    let (in_crm, _, piet) = person(db, &format!("piet@mail.{acme}"))
        .await
        .expect("piet");
    assert!(in_crm);
    let acme_name = auto_add::company_name_for(acme);
    assert_eq!(companies_of(db, &jan).await, vec![acme_name.clone()]);
    assert_eq!(companies_of(db, &piet).await, vec![acme_name]);
    let acme_companies: i64 = sqlx::query_scalar(
        "select count(*) from companies where website = $1 and deleted_at is null",
    )
    .bind(format!("https://{acme}"))
    .fetch_one(db)
    .await
    .expect("companies");
    assert_eq!(acme_companies, 1);
    // Free mail: a person, no company.
    let (in_crm, _, free) = person(db, &format!("{tag}@gmail.com")).await.expect("free");
    assert!(in_crm);
    assert_eq!(companies_of(db, &free).await, Vec::<String>::new());
    // Someone already in the CRM is left alone: no company for their domain.
    let (_, _, eva) = person(db, &format!("eva@known-{tag}.test"))
        .await
        .expect("eva");
    assert_eq!(companies_of(db, &eva).await, Vec::<String>::new());
    let known_companies: i64 =
        sqlx::query_scalar("select count(*) from companies where website like $1")
            .bind(format!("%known-{tag}%"))
            .fetch_one(db)
            .await
            .expect("known companies");
    assert_eq!(known_companies, 0);
    // Colleagues, the workspace's own domains and automated senders: nobody.
    for skipped in [
        format!("ann@{ours}"),
        format!("bob@eu.{ours}"),
        format!("noreply@{acme}"),
    ] {
        assert_eq!(person(db, &skipped).await.map(|p| p.0), None, "{skipped}");
    }
}

#[tokio::test]
async fn adds_the_people_the_workspace_engaged_with() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        return;
    };
    let db = PgPool::connect(&url).await.expect("tenant database");
    let id = weldsuite_kit::generate_id("t").to_lowercase();
    let tag = format!("aa{}", &id[id.len().saturating_sub(10)..]);
    let acme = format!("acme-{tag}.test");
    let ours = format!("ours-{tag}.test");
    let owner = format!("user_{tag}");
    clean_up(&db, &tag).await;
    seed(&db, &tag, &acme, &ours, &owner).await;

    let bus = Arc::new(RecordingEventBus::new());
    let tracker = TaskTracker::new();
    let events = OrderedEvents::new(
        EntityEventPublisher::new(Some(bus.clone()), tracker.clone()),
        EventContext::new("ws_test", "system", weldsuite_events::EventSource::System),
    );
    let candidates = [
        Candidate::new(&format!("Jan@{acme}"), Some("Jan de Vries")),
        Candidate::new(&format!("piet@mail.{acme}"), Some("Piet Jansen")),
        Candidate::new(&format!("ann@{ours}"), None),
        Candidate::new(&format!("bob@eu.{ours}"), None),
        Candidate::new(&format!("noreply@{acme}"), None),
        Candidate::new(&format!("{tag}@gmail.com"), None),
        Candidate::new(&format!("eva@known-{tag}.test"), None),
    ];

    // Off by default: nobody is added.
    let defaults = Settings::default();
    let reset = defaults.as_patch();
    auto_add::save_settings(&db, &reset, "ws_autoadd")
        .await
        .expect("reset");
    let added = auto_add::add(&db, &events, Source::Email, &candidates, Some(&owner))
        .await
        .expect("add while off");
    assert_eq!(added, Vec::new());
    assert_eq!(
        person(&db, &format!("jan@{acme}")).await.map(|p| p.0),
        Some(false)
    );

    // On, with companies.
    let (saved, _) = auto_add::save_settings(
        &db,
        &Patch {
            enabled: Some(true),
            create_companies: Some(true),
            ..Patch::default()
        },
        "ws_autoadd",
    )
    .await
    .expect("on");
    assert_eq!(auto_add::load_settings(&db).await.expect("reload"), saved);
    assert!(saved.covers(Source::Email));

    let added = auto_add::add(&db, &events, Source::Email, &candidates, Some(&owner))
        .await
        .expect("add");
    assert_eq!(added.len(), 3, "{added:?}");
    assert_added(&db, &tag, &acme, &ours, &owner).await;

    // Again: everyone is in already.
    let again = auto_add::add(&db, &events, Source::Email, &candidates, Some(&owner))
        .await
        .expect("again");
    assert_eq!(again, Vec::new());

    // A source switched off adds nobody.
    auto_add::save_settings(
        &db,
        &Patch {
            meetings: Some(false),
            ..Patch::default()
        },
        "ws_autoadd",
    )
    .await
    .expect("meetings off");
    let guest = Candidate::new(&format!("guest@{acme}"), None);
    let none = auto_add::add(&db, &events, Source::Meetings, &[guest], Some(&owner))
        .await
        .expect("meetings");
    assert_eq!(none, Vec::new());

    // The sending task ends once the events' sender is gone.
    drop(events);
    tracker.close();
    tracker.wait().await;
    let subjects: Vec<String> = bus.messages().into_iter().map(|m| m.subject).collect();
    for expected in [
        "entity-events.company.created",
        "entity-events.person.updated",
        "entity-events.person.created",
        "entity-events.contact_link.created",
    ] {
        assert!(
            subjects.iter().any(|s| s == expected),
            "{expected} in {subjects:?}"
        );
    }

    auto_add::save_settings(&db, &reset, "ws_autoadd")
        .await
        .expect("reset");
    assert_eq!(auto_add::load_settings(&db).await.expect("reset"), defaults);
    clean_up(&db, &tag).await;
}
