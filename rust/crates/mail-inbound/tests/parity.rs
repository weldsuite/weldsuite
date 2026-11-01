//! Parity with mail-inbound-worker. `scripts/rust-mail-inbound-fixtures.ts`
//! ran the worker's own code (the inputs of its tests, and more) and wrote
//! what it did into `tests/fixtures/*.json`: how raw messages parse, the
//! spam and promotion scores, the pure helpers, the mail-rule fold, and on
//! pglite the rows `storeEmail` and `ingestDeskEmail` write. These tests run
//! the port on the same inputs and compare.
//!
//! The database tests need `WELDSUITE_TEST_TENANT_URL` (a tenant database
//! built by `scripts/rust-test-db.ts`) and skip without it. Regenerate the
//! fixtures with `pnpm rust:mail-inbound-fixtures`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use base64::Engine as _;
use regex::Regex;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_mail_inbound::catch_all::expand_catch_all_candidates;
use weldsuite_mail_inbound::deliver::run_rules;
use weldsuite_mail_inbound::fanout::{
    Plan, accounting_attachment_type, notification_content, plan, select_desk_attachments,
    stored_file_metadata,
};
use weldsuite_mail_inbound::parsed::{EmailAddress, ParsedAttachment, ParsedEmail, parse_inbound};
use weldsuite_mail_inbound::promotion::{PromotionInput, classify_promotion};
use weldsuite_mail_inbound::recipients::{RecipientAccount, select_notify_members};
use weldsuite_mail_inbound::rules::{RuleState, fold_rules};
use weldsuite_mail_inbound::spam::{SpamInput, SpamOptions, score_inbound_spam};
use weldsuite_mail_inbound::store::store_email;
use weldsuite_mail_inbound::thread_match::{
    bare_message_id, bare_subject, conversation_subjects, has_reply_prefix, involves_address,
    message_id_variants, provider_message_ids,
};
use weldsuite_mail_inbound::unsubscribe::parse_list_unsubscribe;
use weldsuite_mail_inbound::{FanOut, InboundContext, StaticDbs};
use weldsuite_ports::{FileStore, ObjectInfo, PortError, PutOptions, Stored, StoredObject};

/// The receipt time the tests parse with: a message without a usable
/// `Date` is "now", which the fixtures record as `<now>`.
const NOW: i64 = 1_800_000_000_000;

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).expect("the fixture exists");
    serde_json::from_str(&text).expect("the fixture is JSON")
}

fn bytes(b64: &Value) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(b64.as_str().expect("base64 text"))
        .expect("base64")
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn address(value: &Value) -> EmailAddress {
    EmailAddress {
        email: value["email"].as_str().unwrap_or_default().to_owned(),
        name: text(&value["name"]),
    }
}

fn addresses(value: &Value) -> Vec<EmailAddress> {
    value
        .as_array()
        .map(|items| items.iter().map(address).collect())
        .unwrap_or_default()
}

fn headers(value: &Value) -> Vec<(String, String)> {
    match value {
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
            .collect(),
        Value::Array(pairs) => pairs
            .iter()
            .map(|pair| {
                (
                    pair[0].as_str().unwrap_or_default().to_owned(),
                    pair[1].as_str().unwrap_or_default().to_owned(),
                )
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn is_random_id(id: &str) -> bool {
    Regex::new("^<[0-9a-f]{32}@weldmail\\.local>$")
        .expect("pattern")
        .is_match(id)
}

/// The fixture's `emailJson` of a parsed email.
fn email_json(email: &ParsedEmail) -> Value {
    json!({
        "messageId": if is_random_id(&email.message_id) { "<random>".to_owned() } else { email.message_id.clone() },
        "from": email.from.to_json(),
        "to": email.to.iter().map(EmailAddress::to_json).collect::<Vec<_>>(),
        "cc": email.cc.iter().map(EmailAddress::to_json).collect::<Vec<_>>(),
        "envelopeTo": email.envelope_to,
        "subject": email.subject,
        "textBody": email.text_body,
        "htmlBody": email.html_body,
        "headers": email.headers.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
        "receivedAt": if email.received_at == NOW { "<now>".to_owned() } else { iso(email.received_at) },
        "hasAttachments": email.has_attachments,
        "attachmentCount": email.attachment_count,
        "inReplyTo": email.in_reply_to,
        "references": email.references,
        "spfStatus": email.spf_status,
        "dkimStatus": email.dkim_status,
        "dmarcStatus": email.dmarc_status,
    })
}

fn iso(ms: i64) -> String {
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .expect("a time");
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    )
}

fn attachment_json(att: &ParsedAttachment) -> Value {
    json!({
        "fileName": att.file_name,
        "contentType": att.content_type,
        "content": base64::engine::general_purpose::STANDARD.encode(&att.content),
        "contentId": att.content_id,
    })
}

#[test]
fn raw_messages_parse_as_the_worker_parses_them() {
    for case in fixture("parse").as_array().expect("cases") {
        let name = case["name"].as_str().unwrap_or_default();
        let raw = bytes(&case["raw"]);
        let envelope = strings(&case["envelopeTo"]);
        let (email, attachments) =
            parse_inbound(&raw, &envelope, "e", "inbound/seed", NOW).expect("parses");
        assert_eq!(email_json(&email), case["email"], "{name}: the email");
        let attachments: Vec<Value> = attachments.iter().map(attachment_json).collect();
        assert_eq!(
            Value::Array(attachments),
            case["attachments"],
            "{name}: the attachments"
        );
    }
}

fn spam_input(email: &Value) -> (EmailAddress, Vec<EmailAddress>, Vec<(String, String)>) {
    (
        address(&email["from"]),
        addresses(&email["to"]),
        headers(&email["headers"]),
    )
}

#[test]
fn spam_scores_match() {
    for case in fixture("spam").as_array().expect("cases") {
        let email = &case["email"];
        let options = &case["options"];
        let (from, to, headers) = spam_input(email);
        let result = score_inbound_spam(
            &SpamInput {
                from: Some(&from),
                to: &to,
                subject: email["subject"].as_str(),
                text_body: email["textBody"].as_str(),
                html_body: email["htmlBody"].as_str(),
                headers: &headers,
                spf_status: email["spfStatus"].as_str(),
                dkim_status: email["dkimStatus"].as_str(),
                dmarc_status: email["dmarcStatus"].as_str(),
            },
            &SpamOptions {
                attachment_names: strings(&options["attachmentNames"]),
                is_existing_ham_thread: options["isExistingHamThread"] == true,
                recipient_emails: options
                    .get("recipientEmails")
                    .filter(|v| !v.is_null())
                    .map(strings),
            },
        );
        let actual =
            json!({ "score": result.score, "reasons": result.reasons, "isSpam": result.is_spam });
        assert_eq!(actual, case["result"], "spam: {email}");
    }
}

#[test]
fn promotions_match() {
    for case in fixture("promotion").as_array().expect("cases") {
        let email = &case["email"];
        let headers = headers(&email["headers"]);
        let result = classify_promotion(
            &PromotionInput {
                subject: email["subject"].as_str(),
                text_body: email["textBody"].as_str(),
                html_body: email["htmlBody"].as_str(),
                headers: &headers,
            },
            case["options"]["isReply"] == true,
        );
        let actual = json!({ "isPromotion": result.is_promotion, "score": result.score, "reasons": result.reasons });
        assert_eq!(actual, case["result"], "promotion: {email}");
    }
}

#[test]
#[allow(clippy::too_many_lines)] // one fixture, many helpers
fn helpers_match() {
    let h = fixture("helpers");
    for pair in h["bareMessageId"].as_array().expect("cases") {
        assert_eq!(
            bare_message_id(pair[0].as_str().unwrap_or_default()),
            pair[1].as_str().unwrap_or_default()
        );
    }
    let ids: Vec<String> = h["bareMessageId"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|p| p[0].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(json!(message_id_variants(&ids)), h["messageIdVariants"]);
    assert_eq!(
        json!(provider_message_ids(&[
            "<abc-123@eu-west-1.amazonses.com>",
            "abc-123@other.test",
            "plain",
            "<@x>"
        ])),
        h["providerMessageIds"]
    );
    for case in h["subjects"].as_array().expect("cases") {
        let subject = case["subject"].as_str();
        assert_eq!(
            bare_subject(subject),
            case["bare"].as_str().unwrap_or_default(),
            "{case}"
        );
        assert_eq!(has_reply_prefix(subject), case["reply"] == true, "{case}");
        assert_eq!(
            json!(conversation_subjects(subject)),
            case["conversation"],
            "{case}"
        );
    }
    let from = json!({ "email": "Me@Weldmail.example", "name": "Me" });
    let to = json!([{ "email": "support@helpdesk.example" }]);
    for pair in h["involves"].as_array().expect("cases") {
        let address = pair[0].as_str().filter(|a| !a.is_empty());
        assert_eq!(
            involves_address(&from, &to, &Value::Null, address),
            pair[1] == true,
            "{pair}"
        );
    }
    let recipients: Vec<String> = [
        "Hello@Acme.example",
        "random@acme.example",
        "x@team.weldmail.com",
        "nobody",
        "@x",
        "y@",
        "z@Other.Test",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    assert_eq!(
        json!(expand_catch_all_candidates(
            &recipients,
            &["hello@acme.example".to_owned()]
        )),
        h["catchAll"]
    );
    let members: Vec<(String, Option<String>, Option<String>)> = [
        ("u1", Some("MEMBER")),
        ("u2", Some("admin")),
        ("u3", Some("OWNER")),
        ("u4", None),
    ]
    .iter()
    .map(|(u, r)| ((*u).to_owned(), None, r.map(str::to_owned)))
    .collect();
    let ids = |list: Vec<&(String, Option<String>, Option<String>)>| -> Value {
        json!(list.iter().map(|m| m.0.clone()).collect::<Vec<_>>())
    };
    assert_eq!(
        ids(select_notify_members(true, &[], &members)),
        h["notifyMembers"][0]
    );
    assert_eq!(
        ids(select_notify_members(false, &[], &members)),
        h["notifyMembers"][1]
    );
    assert_eq!(
        ids(select_notify_members(
            false,
            &["u4".to_owned(), "u9".to_owned()],
            &members
        )),
        h["notifyMembers"][2]
    );
    for case in h["accountingTypes"].as_array().expect("cases") {
        assert_eq!(
            json!(accounting_attachment_type(
                case[0].as_str().unwrap_or_default(),
                case[1].as_str().unwrap_or_default()
            )),
            case[2],
            "{case}"
        );
    }
    for case in h["listUnsubscribe"].as_array().expect("cases") {
        let result = parse_list_unsubscribe(&headers(&case["headers"])).map(|info| {
            json!({ "url": info.url, "mailto": info.mailto, "oneClick": info.one_click, "listId": info.list_id })
        });
        assert_eq!(json!(result), case["result"], "{case}");
    }
    let att = |name: &str, kind: &str, size: usize, cid: Option<&str>| ParsedAttachment {
        file_name: name.to_owned(),
        content_type: kind.to_owned(),
        content: vec![0; size],
        content_id: cid.map(str::to_owned),
    };
    let files = [
        att("logo.png", "image/png", 3, Some("<LOGO@x>")),
        att("a.pdf", "application/pdf", 2, None),
        att("empty.txt", "text/plain", 0, None),
        att("b.html", "text/html; charset=utf-8", 4, Some("<b@x>")),
    ];
    let kept: Vec<&str> =
        select_desk_attachments(&files, Some("<img src=\"cid:logo@X\"><img src=cid:b%40x>"))
            .iter()
            .map(|a| a.file_name.as_str())
            .collect();
    assert_eq!(json!(kept), h["deskAttachments"]);
    for case in h["storedFileMetadata"].as_array().expect("cases") {
        let (kind, disposition) = stored_file_metadata(
            case[0].as_str().unwrap_or_default(),
            case[1].as_str().unwrap_or_default(),
        );
        assert_eq!(
            json!({ "contentType": kind, "contentDisposition": disposition }),
            case[2],
            "{case}"
        );
    }
    for case in h["plans"].as_array().expect("cases") {
        let prior = case[3]
            .as_str()
            .map(|state| (state.to_owned(), case[2] == true));
        let actual = match plan(case[0] == true, case[1].as_str(), prior.as_ref()) {
            Plan::Notify => "notify",
            Plan::AssigneeReply => "assignee_reply",
            Plan::None => "none",
        };
        assert_eq!(json!(actual), case[4], "{case}");
    }
    let contents = [
        (true, "Jane", Some("Hello   there"), Some("Subj"), vec![]),
        (
            false,
            "  ",
            None,
            None,
            vec!["a.pdf".to_owned(), String::new(), "b.png".to_owned()],
        ),
        (false, "Bob", Some(""), Some(""), vec![]),
        (
            true,
            "Al",
            Some("x".repeat(200).leak() as &str),
            None,
            vec![],
        ),
    ];
    for (i, (is_new, name, body, subject, files)) in contents.iter().enumerate() {
        let (title, text) = notification_content(*is_new, name, *body, *subject, files);
        assert_eq!(
            json!({ "title": title, "body": text }),
            h["notificationContent"][i]
        );
    }
    for case in h["normalizeEmailSubject"].as_array().expect("cases") {
        assert_eq!(
            weldsuite_desk_domain::email::normalize_email_subject(case[0].as_str()),
            case[1].as_str().unwrap_or_default(),
            "{case}"
        );
    }
    for case in h["normalizeRfcMessageId"].as_array().expect("cases") {
        assert_eq!(
            json!(weldsuite_desk_domain::email::normalize_rfc_message_id(
                case[0].as_str()
            )),
            case[1],
            "{case}"
        );
    }
}

fn parsed_email(value: &Value) -> ParsedEmail {
    ParsedEmail {
        email_id: "e".to_owned(),
        message_id: value["messageId"].as_str().unwrap_or_default().to_owned(),
        from: address(&value["from"]),
        to: addresses(&value["to"]),
        cc: addresses(&value["cc"]),
        envelope_to: Vec::new(),
        subject: value["subject"].as_str().unwrap_or_default().to_owned(),
        text_body: text(&value["textBody"]),
        html_body: text(&value["htmlBody"]),
        headers: headers(&value["headers"]),
        received_at: 0,
        has_attachments: value["hasAttachments"] == true,
        attachment_count: 0,
        in_reply_to: text(&value["inReplyTo"]),
        references: value
            .get("references")
            .filter(|r| !r.is_null())
            .map(strings),
        spf_status: None,
        dkim_status: None,
        dmarc_status: None,
        raw: Vec::new(),
    }
}

fn rule_state(value: &Value) -> RuleState {
    RuleState {
        labels: strings(&value["labels"]),
        is_read: value["isRead"] == true,
        is_flagged: value["isFlagged"] == true,
        is_spam: value["isSpam"] == true,
        deleted: value["deleted"] == true,
    }
}

#[test]
fn mail_rules_fold_as_the_worker_folds_them() {
    let f = fixture("rules");
    let email = parsed_email(&f["email"]);
    for case in f["cases"].as_array().expect("cases") {
        let rules = case["rules"].as_array().cloned().unwrap_or_default();
        let (outcome, _) = fold_rules(&rules, &email, &rule_state(&case["state"]));
        let actual = match outcome {
            Ok(outcome) => json!({
                "state": {
                    "labels": outcome.state.labels,
                    "isRead": outcome.state.is_read,
                    "isFlagged": outcome.state.is_flagged,
                    "isSpam": outcome.state.is_spam,
                    "deleted": outcome.state.deleted,
                },
                "markedSpam": outcome.marked_spam,
            }),
            Err(_) => json!("throws"),
        };
        assert_eq!(actual, case["result"], "rules: {}", case["name"]);
    }
}

// ── on a database ───────────────────────────────────────────────────────────

async fn tenant_db() -> Option<PgPool> {
    let url = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
    Some(
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("the test tenant database"),
    )
}

async fn exec(db: &PgPool, statements: &Value) {
    for statement in statements.as_array().expect("statements") {
        sqlx::raw_sql(sqlx::AssertSqlSafe(
            statement.as_str().expect("sql").to_owned(),
        ))
        .execute(db)
        .await
        .expect("the seed runs");
    }
}

async fn rows(db: &PgPool, sql: &str) -> Vec<Value> {
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .fetch_all(db)
        .await
        .expect("the rows");
    rows.iter().map(|row| normalise(row, "")).collect()
}

const VOLATILE: [&str; 7] = [
    "created_at",
    "updated_at",
    "received_date",
    "last_seen_at",
    "waiting_since",
    "last_message_at",
    "last_applied_at",
];

/// The generator's `normalise`.
fn normalise(value: &Value, key: &str) -> Value {
    static PATTERNS: std::sync::LazyLock<Vec<(Regex, &str)>> = std::sync::LazyLock::new(|| {
        [
            ("msg_[A-Za-z0-9_-]{21}", "<msg>"),
            ("attach_[0-9a-z]{9,}", "<attach>"),
            ("msub_[0-9a-z]{9,}", "<msub>"),
            ("dconv_[0-9a-z]{9,}", "<dconv>"),
            ("dmsg_[0-9a-z]{9,}", "<dmsg>"),
            ("dvis_[0-9a-z]{9,}", "<dvis>"),
        ]
        .into_iter()
        .map(|(p, r)| (Regex::new(p).expect("pattern"), r))
        .collect()
    });
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|v| normalise(v, "")).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), normalise(v, k)))
                .collect::<Map<_, _>>(),
        ),
        Value::String(text) => {
            if VOLATILE.contains(&key) {
                return json!("<ts>");
            }
            let mut out = text.clone();
            for (pattern, placeholder) in PATTERNS.iter() {
                out = pattern.replace_all(&out, *placeholder).into_owned();
            }
            Value::String(out)
        }
        other => other.clone(),
    }
}

/// A bucket that records what was put.
#[derive(Default)]
struct Recording(Mutex<Vec<Value>>);

impl Recording {
    fn puts(&self) -> Vec<Value> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .map(|p| normalise(p, ""))
            .collect()
    }
}

#[allow(clippy::unused_async_trait_impl)] // the trait's shape
impl FileStore for Recording {
    async fn put(
        &self,
        key: &str,
        bytes: Vec<u8>,
        options: &PutOptions,
    ) -> Result<Option<Stored>, PortError> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(json!({ "key": key, "contentType": options.content_type, "size": bytes.len() }));
        Ok(Some(Stored::default()))
    }

    async fn get(&self, _key: &str) -> Result<Option<StoredObject>, PortError> {
        Ok(None)
    }

    async fn head(&self, _key: &str) -> Result<Option<ObjectInfo>, PortError> {
        Ok(None)
    }

    async fn delete(&self, _key: &str) -> Result<(), PortError> {
        Ok(())
    }

    async fn delete_many(&self, _keys: &[String]) -> Result<(), PortError> {
        Ok(())
    }
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // the steps, then every table
async fn storage_writes_the_rows_the_worker_writes() {
    let Some(db) = tenant_db().await else {
        eprintln!("skipped: WELDSUITE_TEST_TENANT_URL is not set");
        return;
    };
    let f = fixture("store");
    exec(&db, &f["seed"]).await;
    let workspace = f["workspaceId"].as_str().unwrap_or_default().to_owned();
    let files = Arc::new(Recording::default());
    let mail = Arc::new(Recording::default());
    let ctx = InboundContext {
        master: db.clone(),
        tenants: Arc::new(StaticDbs(HashMap::from([(workspace.clone(), db.clone())]))),
        storage: Some(files.clone()),
        public_url: text(&f["publicUrl"]),
        mail_storage: Some(mail.clone()),
        realtime: None,
        events: weldsuite_events::EntityEventPublisher::new(
            None,
            tokio_util::task::TaskTracker::new(),
        ),
        http: None,
        fan_out: FanOut {
            desk: false,
            books: false,
        },
    };
    let a = &f["account"];
    let account = RecipientAccount {
        account_id: a["accountId"].as_str().unwrap_or_default().to_owned(),
        account_email: a["accountEmail"].as_str().unwrap_or_default().to_owned(),
        is_shared: a["isShared"] == true,
        workspace_id: workspace,
        clerk_org_id: a["clerkOrgId"].as_str().unwrap_or_default().to_owned(),
        members: Vec::new(),
    };
    for step in f["steps"].as_array().expect("steps") {
        let name = step["name"].as_str().unwrap_or_default();
        let raw = bytes(&step["raw"]);
        let (email, attachments) = parse_inbound(
            &raw,
            std::slice::from_ref(&account.account_email),
            "e",
            "seed",
            NOW,
        )
        .expect("parses");
        let names: Vec<String> = attachments
            .iter()
            .map(|a| a.file_name.clone())
            .filter(|n| !n.is_empty())
            .collect();
        let stored = store_email(&ctx, &db, &account, &email, &names, &attachments).await;
        let mut marked_spam = Value::Null;
        if let Some(stored) = &stored
            && name == "rules"
        {
            let initial = RuleState {
                labels: weldsuite_mail_inbound::store::inbound_labels(
                    stored.is_spam,
                    stored.is_promotion,
                ),
                is_read: false,
                is_flagged: false,
                is_spam: stored.is_spam,
                deleted: false,
            };
            let spam = run_rules(
                &db,
                &account.account_id,
                &stored.message_id,
                &email,
                &initial,
            )
            .await
            .expect("the rules run");
            marked_spam = json!(spam);
        }
        let stored = stored.map(|s| {
            json!({ "threadId": s.thread_id, "isSpam": s.is_spam, "isPromotion": s.is_promotion })
        });
        assert_eq!(json!(stored), step["stored"], "{name}: the stored result");
        assert_eq!(marked_spam, step["markedSpam"], "{name}: the rules' spam");
    }
    let account_id = &account.account_id;
    let columns = "id, message_id, thread_id, \"from\", \"to\", cc, bcc, reply_to, subject, preview, text_body, html_body, sent_date, received_date,
    is_read, is_starred, is_flagged, is_important, is_draft, is_spam, is_trash, has_attachments, attachment_count, in_reply_to, \"references\",
    is_reply, is_forwarded, labels, priority, spf_status, dkim_status, dmarc_status, source, size_bytes, raw_message, headers, deleted_at, created_at, updated_at";
    assert_eq!(
        json!(rows(&db, &format!("select to_jsonb(m) from (select {columns} from mail_messages where account_id = '{account_id}') m order by m.sent_date, m.message_id")).await),
        f["messages"],
        "mail_messages"
    );
    assert_eq!(
        json!(rows(&db, &format!(
            "select to_jsonb(a) from (select a.id, a.file_name, a.content_type, a.size, a.storage_path, a.download_url, a.is_inline, a.content_id, a.content_disposition, m.message_id as rfc
             from mail_attachments a join mail_messages m on m.id = a.message_id where m.account_id = '{account_id}') a order by a.rfc, a.file_name"
        )).await),
        f["attachments"],
        "mail_attachments"
    );
    assert_eq!(
        json!(rows(&db, &format!(
            "select to_jsonb(s) from (select sender_email, sender_name, sender_domain, list_id, unsubscribe_url, unsubscribe_mailto, one_click, message_count, last_subject, first_received_at, last_received_at, status from mail_subscriptions where account_id = '{account_id}') s order by s.sender_email"
        )).await),
        f["subscriptions"],
        "mail_subscriptions"
    );
    assert_eq!(
        json!(rows(&db, &format!("select to_jsonb(r) from (select id, applied_count from mail_rules where account_id = '{account_id}') r order by r.id")).await),
        f["rules"],
        "mail_rules"
    );
    assert_eq!(json!(files.puts()), f["files"], "STORAGE puts");
    assert_eq!(json!(mail.puts()), f["mail"], "MAIL_STORAGE puts");
}

#[tokio::test]
async fn desk_email_writes_the_rows_ingest_desk_email_writes() {
    let Some(db) = tenant_db().await else {
        eprintln!("skipped: WELDSUITE_TEST_TENANT_URL is not set");
        return;
    };
    let f = fixture("desk");
    exec(&db, &f["seed"]).await;
    // Conversation numbers count every conversation in the database; the
    // fixture's started at 1 on an empty one.
    let base: i64 = sqlx::query_scalar(
        "select coalesce(max(conversation_number), 0)::bigint from desk_conversations",
    )
    .fetch_one(&db)
    .await
    .expect("the numbers");
    let relative = |rows: Vec<Value>| -> Value {
        Value::Array(
            rows.into_iter()
                .map(|mut row| {
                    for key in ["conversation_number", "conversation"] {
                        if let Some(n) = row[key].as_i64() {
                            row[key] = json!(n - base);
                        }
                    }
                    row
                })
                .collect(),
        )
    };
    for (i, input) in f["inputs"].as_array().expect("inputs").iter().enumerate() {
        let references = strings(&input["references"]);
        let attachments = input["attachments"].as_array().cloned();
        let ingested = weldsuite_desk_domain::email::ingest_desk_email(
            &db,
            weldsuite_desk_domain::email::IngestEmail {
                from_name: input["fromName"].as_str(),
                from_email: input["fromEmail"].as_str().unwrap_or_default(),
                to_address: input["toAddress"].as_str().unwrap_or_default(),
                subject: input["subject"].as_str().unwrap_or_default(),
                body: input["body"].as_str().unwrap_or_default(),
                attachments,
                rfc_message_id: input["rfcMessageId"].as_str().unwrap_or_default(),
                in_reply_to: input["inReplyTo"].as_str(),
                references: &references,
                to_emails: input.get("toEmails").map(strings),
                cc_emails: input.get("ccEmails").map(strings),
            },
        )
        .await
        .expect("ingests");
        assert_eq!(
            json!({ "created": ingested.created, "conversationNumber": ingested.conversation["conversationNumber"].as_i64().map(|n| n - base) }),
            f["results"][i],
            "input {i}"
        );
    }
    assert_eq!(
        relative(rows(&db, "select to_jsonb(c) - 'id' - 'visitor_id' from desk_conversations c where c.email like '%@cust.test' order by c.conversation_number").await),
        f["conversations"],
        "desk_conversations"
    );
    assert_eq!(
        relative(rows(&db, "select to_jsonb(m) - 'id' - 'conversation_id' - 'author_id' || jsonb_build_object('conversation', c.conversation_number)
         from desk_messages m join desk_conversations c on c.id = m.conversation_id where c.email like '%@cust.test' order by c.conversation_number, m.created_at, m.body").await),
        f["messages"],
        "desk_messages"
    );
    assert_eq!(
        json!(rows(&db, "select to_jsonb(v) - 'id' from desk_visitors v where v.email like '%@cust.test' order by v.email").await),
        f["visitors"],
        "desk_visitors"
    );
}
