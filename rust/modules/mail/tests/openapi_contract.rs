//! What the native WeldMail apps read, held against the file they generate
//! their client from (`apps/mobile-shared/openapi/weldmail.yaml`): every mail
//! operation in it, sent as the file describes it through the router as the
//! server mounts it, on the real tenant and master schemas
//! (`weldsuite_kit::openapi_contract`). A change to these routes that would
//! break the apps fails here; change the file with it, as
//! `apps/mobile-shared/README.md` ("Changing the contract") says. The
//! contacts in the same file (`/api/people`) are checked in
//! `rust/modules/crm/tests/weldmail_openapi_contract.rs`.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` and `WELDSUITE_TEST_MASTER_URL` are
//! set; otherwise returns early. The test has its own workspace, mail domain
//! and user, cleaned at its start.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use serde_json::{Value, json};
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::permission_keys::{
    ACCOUNTS_CREATE, ACCOUNTS_DELETE, ACCOUNTS_READ, ACCOUNTS_UPDATE, MESSAGES_CREATE,
    MESSAGES_DELETE, MESSAGES_READ, MESSAGES_UPDATE,
};
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::openapi_contract::Contract;
use weldsuite_mail::{MailState, RequestTenantDatabases};
use weldsuite_mail_domain::outbound::OutboundBindings;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};
use weldsuite_ports::{
    BoxFuture, DynCache, DynJobs, JobRequest, MemoryCache, PortError, RecordingMailTransport,
};

/// `workspaces.id` of the test's workspace.
const WORKSPACE: &str = "ws_mail_native";
/// Its organization reference (`clerk_org_id`).
const ORG: &str = "org_mail_native";
const SLUG: &str = "mail-native-contract";
const USER: &str = "user_mail_native";
/// A custom mail domain of the workspace.
const DOMAIN: &str = "native-contract.test";
/// The apex free addresses are on: `{SLUG}.weldmail.eu`.
const FREE_APEX: &str = "weldmail.eu";
/// Recipients: MX answers are pre-cached for this domain (no DNS in tests).
const RECIPIENT_DOMAIN: &str = "example.com";

/// The operations checked here; `/api/people` is checked in the CRM crate.
const MAIL_OPERATIONS: &[&str] = &[
    "listMailAccounts",
    "createMailAccount",
    "sendMessage",
    "listMailboxes",
    "listMessages",
    "messageStats",
    "getMessage",
    "updateMessage",
    "deleteMessage",
    "getThread",
    "addMessageLabels",
    "removeMessageLabels",
    "listLabels",
    "createLabel",
    "createDraft",
    "deleteDraft",
    "snoozeMessage",
    "unsnoozeMessage",
    "scheduleMessage",
    "listSubscriptions",
    "scanSubscriptions",
    "unsubscribe",
    "weldmailDomain",
    "checkWeldmailAddress",
    "reserveWeldmailAddress",
    "listMailDomains",
];

struct NoQueries;

impl PermissionQueries for NoQueries {
    type Error = String;

    fn get_member(
        &self,
        _user_id: &str,
    ) -> impl Future<Output = Result<Option<MemberRow>, Self::Error>> + Send {
        std::future::ready(Ok(None))
    }

    fn get_role_permissions(
        &self,
        _role_id: &str,
    ) -> impl Future<Output = Result<Option<Vec<String>>, Self::Error>> + Send {
        std::future::ready(Ok(None))
    }

    fn get_team_permissions(
        &self,
        _member_id: &str,
    ) -> impl Future<Output = Result<Vec<Vec<String>>, Self::Error>> + Send {
        std::future::ready(Ok(Vec::new()))
    }
}

/// The deployment's jobs, for scheduled sends: records what it is asked.
#[derive(Default)]
struct Jobs(Mutex<Vec<String>>);

impl DynJobs for Jobs {
    fn start_boxed(&self, request: JobRequest) -> BoxFuture<'_, Result<(), PortError>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(format!("{request:?}"));
        Box::pin(std::future::ready(Ok(())))
    }

    fn signal_boxed<'a>(
        &'a self,
        _name: &'a str,
        _key: &'a str,
        _signal: &'a str,
    ) -> BoxFuture<'a, Result<bool, PortError>> {
        Box::pin(std::future::ready(Ok(false)))
    }
}

/// The mail state: with the master database (free addresses, the mailbox
/// directory, new mailboxes in the registry) or without it (sends: the
/// sender-ownership check then fails open, as the guard does without a
/// registry), a recording transport, jobs and a cache with the recipients'
/// MX answer.
fn state(master: Option<PgPool>, cache: Arc<MemoryCache>) -> MailState {
    MailState {
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        master,
        cache: Some(cache as Arc<dyn DynCache>),
        outbound: OutboundBindings {
            transport: Some(Arc::new(RecordingMailTransport::new())),
            ..OutboundBindings::default()
        },
        files: None,
        jobs: Some(Arc::new(Jobs::default())),
        system_mail: None,
        http: None,
        doh: None,
        domains: None,
        workspace_tenants: None,
        ai: None,
        env: Arc::new(HashMap::from([(
            "WELDMAIL_DOMAIN".to_owned(),
            FREE_APEX.to_owned(),
        )])),
    }
}

/// `/api` with the mail routes and the mailbox directory behind the session,
/// tenant and permission layers, for a member with every mail permission.
fn app(state: &MailState, tenant: &PgPool) -> Router {
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: [
            ACCOUNTS_READ,
            ACCOUNTS_CREATE,
            ACCOUNTS_UPDATE,
            ACCOUNTS_DELETE,
            MESSAGES_READ,
            MESSAGES_CREATE,
            MESSAGES_UPDATE,
            MESSAGES_DELETE,
        ]
        .map(str::to_owned)
        .to_vec(),
        ..ResolvedPermissions::default()
    };
    let tenants =
        RequestTenantDatabases(Arc::new(HashMap::from([(ORG.to_owned(), tenant.clone())])));
    let db = tenant.clone();
    let api: Router = Router::new()
        .merge(weldsuite_mail::router(state.clone(), &gate))
        .merge(weldsuite_mail::mailboxes_router(state.clone()));
    Router::new()
        .nest("/api", api)
        .layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: Some(ORG.to_owned()),
                    session_id: "sess_mail_native".to_owned(),
                    factor_verification_age: None,
                });
                request.extensions_mut().insert(Tenant {
                    workspace_id: WORKSPACE.to_owned(),
                    clerk_org_id: Some(ORG.to_owned()),
                    db: db.clone(),
                    suspended: false,
                    restrictions: WorkspaceRestrictions::default(),
                });
                request.extensions_mut().insert(Permissions::new(
                    resolved.clone(),
                    None,
                    false,
                    USER.to_owned(),
                ));
                request.extensions_mut().insert(tenants.clone());
                next.run(request)
            },
        ))
}

fn databases() -> Option<(PgPool, PgPool)> {
    let (Ok(master), Ok(tenant)) = (
        std::env::var("WELDSUITE_TEST_MASTER_URL"),
        std::env::var("WELDSUITE_TEST_TENANT_URL"),
    ) else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    Some((
        master_pool(&master, 2).expect("master pool"),
        master_pool(&tenant, 2).expect("tenant pool"),
    ))
}

/// The test's mailboxes: on its custom domain and its free-address domain.
const MAILBOXES: &str = "(select id from mail_accounts where email like '%@native-contract.test' \
     or email like '%@mail-native-contract.weldmail.eu')";

/// Drop what an earlier run left.
async fn clean(master: &PgPool, tenant: &PgPool) {
    for statement in [
        format!(
            "delete from mail_attachments where message_id in \
             (select id from mail_messages where account_id in {MAILBOXES})"
        ),
        format!("delete from mail_messages where account_id in {MAILBOXES}"),
        format!("delete from mail_labels where account_id in {MAILBOXES}"),
        format!("delete from mail_subscriptions where account_id in {MAILBOXES}"),
        format!("delete from mail_drafts where account_id in {MAILBOXES}"),
        format!("delete from mail_accounts where id in {MAILBOXES}"),
        format!("delete from mail_domains where domain_name = '{DOMAIN}'"),
    ] {
        // Built from this file's constants only.
        sqlx::query(sqlx::AssertSqlSafe(statement))
            .execute(tenant)
            .await
            .expect("clean tenant");
    }
    for statement in [
        "delete from mail_account_registry where email like '%@native-contract.test' \
         or email like '%@mail-native-contract.weldmail.eu'",
        "delete from user_workspaces where workspace_id = 'ws_mail_native'",
        "delete from workspaces where id = 'ws_mail_native'",
        "delete from users where id = 'user_mail_native'",
    ] {
        sqlx::query(statement)
            .execute(master)
            .await
            .expect("clean master");
    }
}

/// The workspace, its member and its custom mail domain.
async fn seed(master: &PgPool, tenant: &PgPool) {
    sqlx::query("insert into users (id, email) values ($1, 'ada@native-contract.test')")
        .bind(USER)
        .execute(master)
        .await
        .expect("user");
    sqlx::query(
        "insert into workspaces (id, name, slug, clerk_org_id) values ($1, 'Acme', $2, $3)",
    )
    .bind(WORKSPACE)
    .bind(SLUG)
    .bind(ORG)
    .execute(master)
    .await
    .expect("workspace");
    sqlx::query(
        "insert into user_workspaces (id, user_id, workspace_id, role, status) \
         values ('uw_mail_native', $1, $2, 'owner', 'ACTIVE')",
    )
    .bind(USER)
    .bind(WORKSPACE)
    .execute(master)
    .await
    .expect("membership");
    sqlx::query(
        "insert into mail_domains (id, domain_name, is_active, created_at, updated_at) \
         values ('mdom_mail_native', $1, true, now(), now())",
    )
    .bind(DOMAIN)
    .execute(tenant)
    .await
    .expect("mail domain");
}

/// Two messages in one conversation (one received, with an attachment and an
/// HTML body; one sent, text only), so every nullable field reads both ways.
async fn seed_messages(tenant: &PgPool, account: &str) {
    sqlx::query(
        "insert into mail_messages (id, account_id, message_id, thread_id, \"from\", \"to\", cc, \
           subject, preview, text_body, html_body, sent_date, received_date, is_read, is_starred, \
           has_attachments, attachment_count, labels, source, created_at, updated_at) \
         values ('msg_mail_native_1', $1, '<one@example.com>', 'thr_mail_native', \
           '{\"email\": \"grace@example.com\", \"name\": \"Grace Hopper\"}'::jsonb, \
           '[{\"email\": \"team@native-contract.test\", \"name\": null}]'::jsonb, \
           '[{\"email\": \"bob@example.com\", \"name\": \"Bob\"}]'::jsonb, \
           'Invoice for November', 'Please find the invoice attached', \
           'Please find the invoice attached.', '<p>Please find the <b>invoice</b> attached.</p>', \
           now() - interval '2 hours', now() - interval '2 hours', false, false, \
           true, 1, '[\"INBOX\"]'::jsonb, 'inbound', now(), now())",
    )
    .bind(account)
    .execute(tenant)
    .await
    .expect("received message");
    sqlx::query(
        "insert into mail_messages (id, account_id, message_id, thread_id, \"from\", \"to\", \
           subject, preview, text_body, sent_date, is_read, has_attachments, labels, \"references\", \
           in_reply_to, source, created_at, updated_at) \
         values ('msg_mail_native_2', $1, '<two@native-contract.test>', 'thr_mail_native', \
           '{\"email\": \"team@native-contract.test\", \"name\": \"Team\"}'::jsonb, \
           '[{\"email\": \"grace@example.com\", \"name\": \"Grace Hopper\"}]'::jsonb, \
           'Re: Invoice for November', 'Thanks!', 'Thanks!', now() - interval '1 hour', true, \
           false, '[\"SENT\"]'::jsonb, '[\"<one@example.com>\"]'::jsonb, '<one@example.com>', \
           'sent', now(), now())",
    )
    .bind(account)
    .execute(tenant)
    .await
    .expect("sent message");
    sqlx::query(
        "insert into mail_attachments (id, message_id, file_name, content_type, size, \
           storage_path, is_inline, created_at, updated_at) \
         values ('attach_mail_native', 'msg_mail_native_1', 'invoice.pdf', 'application/pdf', 2048, \
           'workspaces/org_mail_native/mail-attachments/invoice.pdf', false, now(), now())",
    )
    .execute(tenant)
    .await
    .expect("attachment");
}

/// A mailing list that offers only its own page to unsubscribe on.
async fn seed_subscription(tenant: &PgPool, account: &str) {
    sqlx::query(
        "insert into mail_subscriptions (id, account_id, sender_email, sender_name, \
           unsubscribe_url, one_click, message_count, last_subject, first_received_at, \
           last_received_at, status, created_at, updated_at) \
         values ('msub_mail_native', $1, 'news@lists.example.com', 'Example News', \
           'https://lists.example.com/unsubscribe?u=1', false, 3, 'This week', \
           now() - interval '30 days', now() - interval '1 day', 'active', now(), now())",
    )
    .bind(account)
    .execute(tenant)
    .await
    .expect("subscription");
}

fn id(body: &Value) -> String {
    body["data"]["id"].as_str().expect("an id").to_owned()
}

/// `seconds` from now, as the apps send a time: `2026-11-27T09:30:00Z`.
fn iso_in(seconds: i64) -> String {
    jiff::Timestamp::from_second(jiff::Timestamp::now().as_second() + seconds)
        .expect("a timestamp")
        .to_string()
}

/// Every mail operation of weldmail.yaml, with data that gives the nullable
/// fields more than one value: a received message with an attachment and an
/// HTML body and a sent reply without either, a free address and a mailbox on
/// a custom domain, a subscription that is unsubscribed through its page.
#[tokio::test]
#[allow(clippy::too_many_lines)] // one flow, operation by operation
async fn weldmail_answers_what_the_native_apps_read() {
    let Some((master, tenant)) = databases() else {
        return;
    };
    clean(&master, &tenant).await;
    seed(&master, &tenant).await;
    let cache = Arc::new(MemoryCache::new());
    cache
        .put_boxed(
            &format!("mx:{RECIPIENT_DOMAIN}"),
            "1",
            Some(Duration::from_secs(3600)),
        )
        .await
        .expect("the MX answer");
    // With the master database: free addresses, the directory, the registry.
    let app = app(&state(Some(master.clone()), Arc::clone(&cache)), &tenant);
    // Without it: sends, schedules and snoozes (the ownership check fails open).
    let sending = self::app(&state(None, Arc::clone(&cache)), &tenant);
    let contract = Contract::load("weldmail");

    // Mailboxes: one on the custom domain, one free address.
    let domains = contract
        .success(&app, "listMailDomains", &[], &[], None)
        .await;
    assert!(
        domains["data"]
            .as_array()
            .is_some_and(|list| list.iter().any(|d| d["domainName"] == DOMAIN)),
        "{domains}"
    );
    let account = id(&contract
        .success(
            &app,
            "createMailAccount",
            &[],
            &[],
            Some(&json!({
                "name": "Team",
                "email": format!("team@{DOMAIN}"),
                "displayName": "Team",
                "isShared": true,
            })),
        )
        .await);
    let account = account.as_str();
    contract
        .success(&app, "weldmailDomain", &[], &[], None)
        .await;
    let available = contract
        .success(
            &app,
            "checkWeldmailAddress",
            &[],
            &[],
            Some(&json!({ "address": "anna" })),
        )
        .await;
    assert_eq!(available["data"]["available"], true, "{available}");
    contract
        .success(
            &app,
            "reserveWeldmailAddress",
            &[],
            &[],
            Some(&json!({ "address": "anna", "name": "Anna", "displayName": "Anna" })),
        )
        .await;
    let taken = contract
        .success(
            &app,
            "checkWeldmailAddress",
            &[],
            &[],
            Some(&json!({ "address": "anna" })),
        )
        .await;
    assert_eq!(taken["data"]["available"], false, "{taken}");
    let accounts = contract
        .success(&app, "listMailAccounts", &[], &[("limit", "100")], None)
        .await;
    assert!(
        accounts["data"]
            .as_array()
            .is_some_and(|list| list.len() >= 2),
        "{accounts}"
    );
    contract
        .success(&app, "listMailboxes", &[], &[], None)
        .await;

    // Messages: the list, a page at a time, filtered, searched, counted.
    seed_messages(&tenant, account).await;
    let list = contract
        .success(
            &app,
            "listMessages",
            &[],
            &[("accountId", account), ("limit", "50")],
            None,
        )
        .await;
    assert_eq!(list["data"].as_array().map(Vec::len), Some(2), "{list}");
    let first = contract
        .success(
            &app,
            "listMessages",
            &[],
            &[("accountId", account), ("limit", "1")],
            None,
        )
        .await;
    let cursor = first["pagination"]["cursor"]
        .as_str()
        .expect("a next page")
        .to_owned();
    contract
        .success(
            &app,
            "listMessages",
            &[],
            &[
                ("accountId", account),
                ("limit", "1"),
                ("cursor", cursor.as_str()),
            ],
            None,
        )
        .await;
    contract
        .success(
            &app,
            "listMessages",
            &[],
            &[
                ("accountId", account),
                ("label", "INBOX"),
                ("isRead", "false"),
                ("hasAttachments", "true"),
            ],
            None,
        )
        .await;
    contract
        .success(
            &app,
            "listMessages",
            &[],
            &[("accountId", account), ("search", "Invoice")],
            None,
        )
        .await;
    contract.success(&app, "messageStats", &[], &[], None).await;
    contract
        .success(&app, "messageStats", &[], &[("accountId", account)], None)
        .await;

    // One message, its conversation, its flags and labels.
    for message in ["msg_mail_native_1", "msg_mail_native_2"] {
        contract
            .success(&app, "getMessage", &[("messageId", message)], &[], None)
            .await;
    }
    let thread = contract
        .success(
            &app,
            "getThread",
            &[("messageId", "msg_mail_native_1")],
            &[],
            None,
        )
        .await;
    assert_eq!(
        thread["data"]["messages"].as_array().map(Vec::len),
        Some(2),
        "{thread}"
    );
    contract
        .success(
            &app,
            "updateMessage",
            &[("messageId", "msg_mail_native_1")],
            &[],
            Some(&json!({ "isRead": true, "isStarred": true })),
        )
        .await;
    contract
        .success(
            &app,
            "createLabel",
            &[],
            &[],
            Some(&json!({ "accountId": account, "name": "Clients", "color": "#3B82F6", "aiEnabled": false })),
        )
        .await;
    contract
        .success(&app, "listLabels", &[], &[("accountId", account)], None)
        .await;
    contract.success(&app, "listLabels", &[], &[], None).await;
    contract
        .success(
            &app,
            "addMessageLabels",
            &[("messageId", "msg_mail_native_1")],
            &[],
            Some(&json!({ "labels": ["Clients", "ARCHIVE"] })),
        )
        .await;
    contract
        .success(
            &app,
            "removeMessageLabels",
            &[("messageId", "msg_mail_native_1")],
            &[],
            Some(&json!({ "labels": ["INBOX"] })),
        )
        .await;

    // Snoozed and back.
    contract
        .success(
            &sending,
            "snoozeMessage",
            &[("accountId", account), ("messageId", "msg_mail_native_1")],
            &[],
            Some(&json!({ "until": iso_in(3600) })),
        )
        .await;
    contract
        .success(
            &sending,
            "unsnoozeMessage",
            &[("accountId", account), ("messageId", "msg_mail_native_1")],
            &[],
            None,
        )
        .await;

    // A draft kept and discarded.
    let draft = id(&contract
        .success(
            &app,
            "createDraft",
            &[],
            &[],
            Some(&json!({
                "accountId": account,
                "to": [format!("bob@{RECIPIENT_DOMAIN}")],
                "subject": "Draft",
                "htmlBody": "<p>Hi</p>",
            })),
        )
        .await);
    contract
        .success(
            &app,
            "deleteDraft",
            &[("draftId", draft.as_str())],
            &[],
            None,
        )
        .await;

    // Sent now, and later.
    contract
        .success(
            &sending,
            "sendMessage",
            &[("accountId", account)],
            &[],
            Some(&json!({
                "to": [format!("bob@{RECIPIENT_DOMAIN}")],
                "cc": [format!("carol@{RECIPIENT_DOMAIN}")],
                "subject": "Re: Invoice for November",
                "body": "Thanks, paid.",
                "inReplyTo": "<one@example.com>",
                "references": ["<one@example.com>"],
                "idempotencyKey": "snd_mail_native_1",
            })),
        )
        .await;
    contract
        .success(
            &sending,
            "scheduleMessage",
            &[],
            &[],
            Some(&json!({
                "accountId": account,
                "to": [format!("bob@{RECIPIENT_DOMAIN}")],
                "subject": "Tomorrow",
                "htmlBody": "<p>See you</p>",
                "scheduledFor": iso_in(86_400),
            })),
        )
        .await;

    // Subscriptions: listed, scanned, unsubscribed on the sender's page.
    seed_subscription(&tenant, account).await;
    contract
        .success(
            &app,
            "listSubscriptions",
            &[],
            &[("accountId", account)],
            None,
        )
        .await;
    contract
        .success(
            &app,
            "scanSubscriptions",
            &[],
            &[],
            Some(&json!({ "accountId": account })),
        )
        .await;
    let unsubscribed = contract
        .success(
            &app,
            "unsubscribe",
            &[("subscriptionId", "msub_mail_native")],
            &[],
            None,
        )
        .await;
    assert_eq!(unsubscribed["data"]["method"], "link", "{unsubscribed}");
    contract
        .success(
            &app,
            "listSubscriptions",
            &[],
            &[("accountId", account)],
            None,
        )
        .await;

    contract
        .success(
            &app,
            "deleteMessage",
            &[("messageId", "msg_mail_native_2")],
            &[],
            None,
        )
        .await;

    clean(&master, &tenant).await;
    contract.finish_only(MAIL_OPERATIONS);
}
