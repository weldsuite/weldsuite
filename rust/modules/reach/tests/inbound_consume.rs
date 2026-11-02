//! WeldReach's replies on `mail.inbound`, on the real schema: the RCPT check
//! for the reply domain, and [`ReachInboundRouter`] taking WeldReach's
//! recipients out of a spooled message before WeldMail sees the rest.
//!
//! Needs `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL`
//! (`scripts/rust-test-db.ts`); skipped without them.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_ports::{
    BatchHandler, BoxFuture, Delivery, Disposition, DynFileStore, MemoryFileStore, PutOptions,
};
use weldsuite_reach::inbound::{ReachInbound, ReachInboundRouter, accepts_recipient};

const DOMAIN: &str = "reply-test.weldreach.com";
const TOKEN: &str = "inboundconsume01";
const ORG: &str = "org_reachin_consume";

async fn pool(var: &str) -> Option<PgPool> {
    let url = std::env::var(var).ok()?;
    Some(PgPool::connect(&url).await.expect("the test database"))
}

async fn exec(db: &PgPool, statements: &[&str]) {
    for statement in statements {
        sqlx::raw_sql(sqlx::AssertSqlSafe((*statement).to_owned()))
            .execute(db)
            .await
            .unwrap_or_else(|e| panic!("{statement}: {e}"));
    }
}

async fn seed(master: &PgPool, tenant: &PgPool) {
    exec(
        master,
        &[
            "delete from reach_routes where clerk_org_id = 'org_reachin_consume'",
            "delete from reach_warmup_messages where id = 'rwms_reachin_1'",
            "insert into reach_routes (id, kind, external_id, workspace_id, clerk_org_id, tenant_entity_id, status) values
               ('rrt_reachin_1', 'inbound_token', 'inboundconsume01', 'ws_reachin', 'org_reachin_consume', 'rmbx_reachin', 'active'),
               ('rrt_reachin_2', 'inbound_token', 'inboundconsume02', 'ws_reachin', 'org_reachin_consume', 'rmbx_reachin', 'deleted')",
            "insert into reach_warmup_messages (id, thread_id, from_mailbox_id, to_mailbox_id, corpus_thread_id, message_id_header, subject, scheduled_at) values
               ('rwms_reachin_1', 'rwth_reachin', 'rwmb_a', 'rwmb_b', 'corpus-1', 'warmup-1@pool.example', 'Lunch?', now())",
        ],
    )
    .await;
    exec(
        tenant,
        &[
            "delete from reach_messages",
            "delete from reach_mailboxes where id = 'rmbx_reachin' or email = 'consume@reachin.test' or inbound_token = 'inboundconsume01'",
            "insert into reach_mailboxes (id, domain_id, email, first_name, last_name, type, status, inbound_token) values
               ('rmbx_reachin', 'rdom_test', 'consume@reachin.test', 'Sam', 'Jansen', 'shared', 'active', 'inboundconsume01')",
        ],
    )
    .await;
}

/// The WeldMail side: records what it was handed.
#[derive(Default)]
struct RecordingMail(Mutex<Vec<Value>>);

impl BatchHandler for RecordingMail {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>> {
        for delivery in batch {
            self.0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(serde_json::from_slice(&delivery.payload).unwrap_or(Value::Null));
        }
        Box::pin(async move { vec![Disposition::Ack; batch.len()] })
    }
}

fn delivery(key: &str, rcpt: &[&str]) -> Delivery {
    Delivery {
        subject: "mail.inbound".to_owned(),
        payload: serde_json::to_vec(&json!({
            "key": key, "mailFrom": "jane@acme.nl", "rcptTo": rcpt, "remoteIp": "203.0.113.9",
        }))
        .expect("json"),
        attempt: 1,
        deferrals: 0,
    }
}

fn message(id: &str, in_reply_to: &str) -> Vec<u8> {
    format!(
        "From: Jane Doe <jane@acme.nl>\r\nTo: sam@getacme.com\r\nSubject: Re: hello\r\nMessage-ID: <{id}>\r\nIn-Reply-To: <{in_reply_to}>\r\n\r\nSounds good.\r\n"
    )
    .into_bytes()
}

async fn inbound_ids(tenant: &PgPool) -> Vec<String> {
    sqlx::query_scalar(
        "select message_id_header from reach_messages where direction = 'in' order by message_id_header",
    )
    .fetch_all(tenant)
    .await
    .expect("rows")
}

#[tokio::test]
async fn replies_are_taken_out_of_mail_inbound() {
    let (Some(master), Some(tenant)) = (
        pool("WELDSUITE_TEST_MASTER_URL").await,
        pool("WELDSUITE_TEST_TENANT_URL").await,
    ) else {
        eprintln!("skipped: WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL are not set");
        return;
    };
    seed(&master, &tenant).await;

    // The RCPT check: an active route on the reply domain, nothing else.
    let reply = format!("reply+{TOKEN}@{DOMAIN}");
    assert!(
        accepts_recipient(&master, DOMAIN, &reply)
            .await
            .expect("lookup")
    );
    assert!(
        !accepts_recipient(&master, DOMAIN, &format!("reply+inboundconsume02@{DOMAIN}"))
            .await
            .expect("lookup"),
        "a deleted route"
    );
    assert!(
        !accepts_recipient(&master, DOMAIN, &format!("reply+{TOKEN}@other.example"))
            .await
            .expect("lookup")
    );
    assert!(
        !accepts_recipient(&master, DOMAIN, &format!("reply+unknowntoken99@{DOMAIN}"))
            .await
            .expect("lookup")
    );

    let spool = Arc::new(MemoryFileStore::default());
    let storage = Arc::new(MemoryFileStore::default());
    let mail = Arc::new(RecordingMail::default());
    let tenant_db = tenant.clone();
    let router = ReachInboundRouter {
        reach: ReachInbound {
            master: master.clone(),
            tenants: Arc::new(move |org: String| {
                let db = tenant_db.clone();
                Box::pin(async move {
                    assert_eq!(org, ORG);
                    Ok(db)
                })
            }),
            storage: Some(storage.clone() as Arc<dyn DynFileStore>),
            events: EntityEventPublisher::new(None, TaskTracker::new()),
            inbound_domain: DOMAIN.to_owned(),
        },
        mail: mail.clone(),
        spool: spool.clone(),
    };
    let put = |key: &'static str, bytes: Vec<u8>| {
        let spool = spool.clone();
        async move {
            spool
                .put_boxed(key, bytes, &PutOptions::default())
                .await
                .expect("spooled");
        }
    };

    // Only WeldReach: stored, the spooled copy removed, WeldMail not asked.
    put(
        "inbound/a.eml",
        message("reply-a@acme.nl", "out-1@getacme.com"),
    )
    .await;
    let answer = router.handle(&[delivery("inbound/a.eml", &[&reply])]).await;
    assert_eq!(answer, [Disposition::Ack]);
    assert_eq!(inbound_ids(&tenant).await, ["reply-a@acme.nl"]);
    assert!(spool.keys().is_empty());
    assert!(mail.0.lock().expect("lock").is_empty());
    assert_eq!(storage.keys().len(), 1);

    // WeldReach and a WeldMail address: WeldMail gets the rest and the spool.
    put(
        "inbound/b.eml",
        message("reply-b@acme.nl", "out-1@getacme.com"),
    )
    .await;
    let answer = router
        .handle(&[delivery("inbound/b.eml", &["hello@acme.example", &reply])])
        .await;
    assert_eq!(answer, [Disposition::Ack]);
    assert_eq!(
        inbound_ids(&tenant).await,
        ["reply-a@acme.nl", "reply-b@acme.nl"]
    );
    assert_eq!(spool.keys(), ["inbound/b.eml"], "WeldMail removes it");
    {
        let seen = mail.0.lock().expect("lock");
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["rcptTo"], json!(["hello@acme.example"]));
        assert_eq!(seen[0]["key"], "inbound/b.eml");
        assert_eq!(seen[0]["remoteIp"], "203.0.113.9");
    }
    // A redelivery of the same message changes nothing for WeldReach.
    let answer = router
        .handle(&[delivery("inbound/b.eml", &["hello@acme.example", &reply])])
        .await;
    assert_eq!(answer, [Disposition::Ack]);
    assert_eq!(inbound_ids(&tenant).await.len(), 2);

    // Warmup mail and an unknown token are dropped, and so is their spool.
    put(
        "inbound/c.eml",
        message("warm-reply@acme.nl", "warmup-1@pool.example"),
    )
    .await;
    put(
        "inbound/d.eml",
        message("reply-d@acme.nl", "out-1@getacme.com"),
    )
    .await;
    let answer = router
        .handle(&[
            delivery("inbound/c.eml", &[&reply]),
            delivery(
                "inbound/d.eml",
                &[&format!("reply+inboundconsume02@{DOMAIN}")],
            ),
        ])
        .await;
    assert_eq!(answer, [Disposition::Ack, Disposition::Ack]);
    assert_eq!(inbound_ids(&tenant).await.len(), 2);
    assert_eq!(spool.keys(), ["inbound/b.eml"]);

    // A message already handled (no spooled object) is acknowledged.
    let answer = router
        .handle(&[delivery("inbound/gone.eml", &[&reply])])
        .await;
    assert_eq!(answer, [Disposition::Ack]);

    // Mail for nobody at WeldReach goes to WeldMail untouched.
    let answer = router
        .handle(&[delivery("inbound/e.eml", &["hello@acme.example"])])
        .await;
    assert_eq!(answer, [Disposition::Ack]);
    assert_eq!(mail.0.lock().expect("lock").len(), 3);
}
