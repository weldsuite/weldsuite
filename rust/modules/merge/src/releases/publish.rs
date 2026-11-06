//! Publishing a release's notes elsewhere in WeldSuite
//! (`services/release-publish.ts`, `POST /releases/:id/publish`): a WeldKnow
//! page and/or an email from a workspace mail account. Both run as the member
//! who asked, so the teamspace role and the mailbox access rules apply to
//! them, and the outbound mail guard counts the email. Each publishes its own
//! module's event (`knowledge_page.created`, `email.email_sent`), as flow-api's
//! project lessons do.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::IntoResponse;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Data};
use weldsuite_know_domain::KnowError;
use weldsuite_know_domain::pages::{CreatePageInput, create_knowledge_page};
use weldsuite_mail_domain::outbound::{DenialCode, OutboundKind, RequestOutbound};
use weldsuite_mail_domain::recipients::{DnsOverHttps, MxLookup};
use weldsuite_mail_domain::send::{SendDeps, SendError, SendInput, SendOptions, send_and_persist};
use weldsuite_ports::{BoxFuture, HttpRequest, OutboundHttp};

use super::{find_release, one_release_dto, release_event, release_title};
use crate::db::{Row, col, text};
use crate::{
    Answer, Caller, MergeError, MergeState, PendingEvent, Refusal, now, publish, validate,
};

/// `text(value)`: one plain text run.
fn text_run(value: &str) -> Value {
    json!([{ "type": "text", "text": value, "styles": {} }])
}

/// `String.prototype.trimStart()`.
fn trim_start(text: &str) -> &str {
    text.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `[label](url)` reduced to `label` (a bracket pair not followed by a url
/// stays as it is).
fn strip_links(line: &str) -> String {
    let mut out = String::new();
    let mut rest = line;
    loop {
        let Some(open) = rest.find('[') else {
            return out + rest;
        };
        let Some(close) = rest[open..].find("](").map(|i| open + i) else {
            return out + rest;
        };
        let Some(end) = rest[close..].find(')').map(|i| close + i) else {
            return out + rest;
        };
        out.push_str(&rest[..open]);
        out.push_str(&rest[open + 1..close]);
        rest = &rest[end + 1..];
    }
}

/// Bold, code and link marks reduced to their text.
fn plain_inline(line: &str) -> String {
    let stripped = strip_links(line)
        .replace("**", "")
        .replace("__", "")
        .replace('`', "");
    weldsuite_kit::validation::js_trim(&stripped).to_owned()
}

/// The text after a `- `, `* ` or `+ ` marker.
fn bullet_text(line: &str) -> Option<&str> {
    let item = trim_start(line);
    let mut chars = item.chars();
    let marker = chars.next()?;
    ("-*+".contains(marker) && chars.next() == Some(' ')).then(|| &item[2..])
}

/// The text after a `1. ` or `1) ` marker.
fn numbered_text(line: &str) -> Option<&str> {
    let item = trim_start(line);
    let digits = item.bytes().take_while(u8::is_ascii_digit).count();
    let rest = &item[digits..];
    let mut chars = rest.chars();
    let marker = chars.next()?;
    (digits > 0 && (marker == '.' || marker == ')') && chars.next() == Some(' '))
        .then(|| &item[digits + 2..])
}

/// A heading's level (1–3) and its text.
fn heading_of(line: &str) -> Option<(usize, &str)> {
    let level = line.bytes().take_while(|b| *b == b'#').count();
    ((1..=3).contains(&level) && line.as_bytes().get(level) == Some(&b' '))
        .then(|| (level, &line[level + 1..]))
}

fn block_of(raw: &str) -> Value {
    if let Some((level, heading)) = heading_of(raw) {
        return json!({
            "type": "heading",
            "props": { "level": level },
            "content": text_run(&plain_inline(heading)),
            "children": [],
        });
    }
    if let Some(bullet) = bullet_text(raw) {
        return json!({ "type": "bulletListItem", "content": text_run(&plain_inline(bullet)), "children": [] });
    }
    if let Some(numbered) = numbered_text(raw) {
        return json!({ "type": "numberedListItem", "content": text_run(&plain_inline(numbered)), "children": [] });
    }
    json!({ "type": "paragraph", "content": text_run(&plain_inline(raw)), "children": [] })
}

/// `markdownToBlocks(markdown)`: headings, bullet and numbered lists and
/// paragraphs as `BlockNote` blocks.
pub(crate) fn markdown_to_blocks(markdown: &str) -> Vec<Value> {
    markdown
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !weldsuite_kit::validation::js_trim(line).is_empty())
        .map(block_of)
        .collect()
}

/// DNS over HTTPS through the module's outbound HTTP (in conformance, the
/// test's `fetch` stub), for the recipients' MX check.
struct HttpDoh(OutboundHttp);

impl DnsOverHttps for HttpDoh {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<(u16, String), String>> {
        Box::pin(async move {
            let response = self
                .0
                .send(HttpRequest::empty("GET", url).header("accept", "application/dns-json"))
                .await
                .map_err(|error| error.to_string())?;
            Ok((response.status, response.text()))
        })
    }
}

/// `publishMergeReleaseSchema`, as validated.
struct PublishInput {
    knowledge_space_id: Option<String>,
    email: Option<EmailInput>,
}

struct EmailInput {
    mail_account_id: String,
    to: Vec<String>,
    subject: Option<String>,
}

fn read_publish(issues: &mut Issues, fields: &Map<String, Value>) -> PublishInput {
    let start = issues.count();
    let knowledge_space_id = issues
        .text(fields, "knowledgeSpaceId", Presence::Optional, None, None)
        .into_option();
    let email = issues
        .nested(fields, "email", Presence::Optional, |issues, email| {
            let mail_account_id = issues
                .text(email, "mailAccountId", Presence::Required, Some(1), None)
                .into_option()
                .unwrap_or_default();
            let to = issues
                .list(
                    email,
                    "to",
                    Presence::Required,
                    Some(1),
                    Some(100),
                    |issues, item| {
                        issues.item_text(
                            item,
                            Text {
                                format: Some(Format::Email),
                                ..Text::default()
                            },
                        )
                    },
                )
                .into_option()
                .unwrap_or_default();
            let subject = issues
                .text_with(
                    email,
                    "subject",
                    Presence::Optional,
                    Text::trimmed(None, Some(500)),
                )
                .into_option();
            EmailInput {
                mail_account_id,
                to,
                subject,
            }
        })
        .into_option();
    // `.refine((v) => Boolean(v.knowledgeSpaceId) || Boolean(v.email))`
    if !crate::schemas::aborted(issues, start)
        && knowledge_space_id.as_deref().is_none_or(str::is_empty)
        && !fields.get("email").is_some_and(Value::is_object)
    {
        issues.custom_root("Choose where to publish");
    }
    PublishInput {
        knowledge_space_id,
        email,
    }
}

/// `sendFailure(c, err)`: a refused or failed send as a response; the guard's
/// own codes keep their code in the body.
fn send_failure(error: SendError) -> Refusal {
    let (code, message, details) = match error {
        SendError::Mail {
            code,
            message,
            details,
        } => (code, message, details),
        SendError::Internal(message) => return MergeError::Unexpected(message).into(),
    };
    let mut body = Map::new();
    body.insert("code".to_owned(), json!(code));
    body.insert("message".to_owned(), json!(message));
    if let Some(details) = &details {
        body.insert("details".to_owned(), details.clone());
    }
    let with_status = |status: u16| {
        let status = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
        Refusal::Response(Box::new(
            (
                status,
                axum::Json(json!({ "error": Value::Object(body.clone()) })),
            )
                .into_response(),
        ))
    };
    if let Ok(denial) = serde_json::from_value::<DenialCode>(json!(code)) {
        return with_status(denial.status());
    }
    match code.as_str() {
        "ACCOUNT_NOT_FOUND" => Refusal::not_found("Mail account", None),
        "FORBIDDEN" => Refusal::forbidden(&message),
        "SENDER_DOMAIN_NOT_VERIFIED" => with_status(422),
        "DAILY_LIMIT_REACHED" | "PROVIDER_RATE_LIMITED" => with_status(429),
        "PARTIALLY_SENT" => with_status(502),
        "PROVIDER_DAILY_LIMIT" | "STORAGE_BINDING_MISSING" | "SEND_BINDING_MISSING" => {
            with_status(503)
        }
        _ => {
            let mut error = ApiError::bad_request(message);
            if let Some(details) = details {
                error = error.with_details(details);
            }
            error.into()
        }
    }
}

/// A WeldKnow failure as the route answers it (`SpaceNotFoundError`,
/// `SpaceAccessError`).
fn know_failure(error: KnowError) -> Refusal {
    match error {
        KnowError::Database(error) => MergeError::Db(error).into(),
        other => Refusal::Response(Box::new(other.respond("Failed to publish the release"))),
    }
}

/// `POST /releases/:id/publish`.
pub(crate) async fn publish_release(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
    request_outbound: Option<axum::Extension<RequestOutbound>>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let input = validate(&headers, &body, read_publish)?;
    let db = &caller.db;
    let Some(release) = find_release(db, &id).await? else {
        return Err(Refusal::not_found("Release", Some(&id)));
    };
    let notes = crate::db::opt_text(&release, "notes").unwrap_or_default();
    if weldsuite_kit::validation::js_trim(&notes).is_empty() {
        return Err(Refusal::unprocessable("Write the release notes first"));
    }
    // Publishing writes into other modules: the member needs their permissions there too.
    let space = input.knowledge_space_id.filter(|s| !s.is_empty());
    if space.is_some() && !caller.can("knowledge:create") {
        return Err(Refusal::forbidden(
            "Publishing to WeldKnow needs permission to create pages",
        ));
    }
    if input.email.is_some() && !caller.can("messages:create") {
        return Err(Refusal::forbidden(
            "Publishing by email needs permission to send mail",
        ));
    }

    let mut current: Row = release.clone();
    let mut knowledge_page_id: Option<String> = None;
    if let Some(space) = &space {
        let page = create_knowledge_page(
            db,
            &caller.user_id,
            &CreatePageInput {
                space_id: space,
                title: &format!("Release notes: {}", release_title(&release)),
                content_json: &markdown_to_blocks(&notes),
                can_manage_all: caller.can("knowledge:manage"),
            },
        )
        .await
        .map_err(know_failure)?;
        let page_id = text(&page, "id").to_owned();
        let row: Value = sqlx::query_scalar(
            "update merge_releases set knowledge_page_id = $2, updated_at = $3::timestamptz \
             where id = $1 returning to_jsonb(merge_releases.*)",
        )
        .bind(&id)
        .bind(&page_id)
        .bind(now())
        .fetch_one(db)
        .await?;
        current = weldsuite_db::js_row(row);
        let mut changes = Map::new();
        changes.insert(
            "knowledgePageId".to_owned(),
            json!({ "old": col(&release, "knowledgePageId"), "new": page_id }),
        );
        publish(
            &state,
            &caller.events,
            vec![
                PendingEvent::new(
                    "knowledge_page",
                    "created",
                    &page_id,
                    json!({ "id": page_id, "spaceId": col(&page, "spaceId"), "parentId": null, "title": col(&page, "title") }),
                ),
                release_event(&current, "updated", &[], Some(changes)),
            ],
        );
        knowledge_page_id = Some(page_id);
    }
    if let Some(email) = &input.email {
        let outbound = request_outbound.map_or_else(|| state.mail.clone(), |o| o.0.0.clone());
        let master = caller.overrides.master(&state);
        let cache = caller.overrides.cache(&state);
        let guard = outbound.guard(master, cache.clone());
        let mx = MxLookup {
            cache,
            doh: caller
                .overrides
                .outbound(&state)
                .map(|http| Arc::new(HttpDoh(http)) as Arc<dyn DnsOverHttps>),
        };
        let deps = SendDeps {
            db,
            guard: &guard,
            transport: outbound.transport.as_deref(),
            files: None,
            mx: &mx,
            public_url: None,
        };
        let subject = email
            .subject
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("Release notes: {}", release_title(&current)));
        let org = caller
            .clerk_org_id
            .clone()
            .unwrap_or_else(|| caller.workspace_id.clone());
        let sent = send_and_persist(
            &deps,
            &org,
            &caller.user_id,
            &email.mail_account_id,
            &SendInput {
                to: email.to.clone(),
                subject: Some(subject),
                body: Some(crate::db::opt_text(&current, "notes").unwrap_or_default()),
                ..SendInput::default()
            },
            &SendOptions {
                source: Some("compose".to_owned()),
                kind: Some(OutboundKind::NewThread),
                workspace_id: Some(caller.workspace_id.clone()),
                ..SendOptions::default()
            },
        )
        .await
        .map_err(send_failure)?;
        // The recipients and subject stay out of the event, as for a private mailbox.
        publish(
            &state,
            &caller.events,
            vec![PendingEvent::new(
                "email",
                "email_sent",
                &sent.message_id,
                json!({ "id": sent.message_id, "accountId": sent.account_id, "subject": null, "from": null, "to": null }),
            )],
        );
    }
    Ok(Data(json!({
        "release": one_release_dto(db, &current).await?,
        "knowledgePageId": knowledge_page_id,
        "emailSent": input.email.is_some(),
    }))
    .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_headings_lists_and_paragraphs_into_blocks() {
        let blocks = markdown_to_blocks(
            "# Title\n\nIntro **bold**\n- one\n- two [link](http://x)\n1. first",
        );
        let types: Vec<&str> = blocks
            .iter()
            .map(|b| b["type"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(
            types,
            [
                "heading",
                "paragraph",
                "bulletListItem",
                "bulletListItem",
                "numberedListItem"
            ]
        );
        assert_eq!(blocks[0]["props"]["level"], 1);
        assert_eq!(blocks[0]["content"][0]["text"], "Title");
        assert_eq!(blocks[1]["content"][0]["text"], "Intro bold");
        assert_eq!(blocks[3]["content"][0]["text"], "two link");
        assert_eq!(blocks[4]["content"][0]["text"], "first");
    }

    #[test]
    fn a_bracket_without_a_url_stays() {
        assert_eq!(
            strip_links("see [this] and [that](u) ok"),
            "see this] and [that ok"
        );
        assert_eq!(heading_of("#### deep"), None);
        assert_eq!(bullet_text("  * item"), Some("item"));
        assert_eq!(numbered_text("12) twelve"), Some("twelve"));
    }
}
