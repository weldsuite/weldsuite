//! WeldForms' emails (`packages/core/emails/src/templates/forms/`): each
//! function takes the template's props, picks the variant its React
//! component would render and fills it in.
//!
//! A list of answers (`<Details>`) or responses (`<List>`) is a loop in the
//! exported template over `rows`; each row names its own variant (`v`, the
//! row's set flags joined by `+`) where a row has optional parts.

use std::collections::BTreeMap;

use minijinja::Value;

use crate::{EmailBrand, EmailError, EmailLocale, RenderedEmail, format_date, render};

fn vars<const N: usize>(pairs: [(&str, Value); N]) -> BTreeMap<String, Value> {
    pairs
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

/// `text.trim()`: JavaScript's white space (U+FEFF too, not U+0085).
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// One row of a loop: its variant and its placeholders.
fn row<const N: usize>(variant: &str, pairs: [(&str, Value); N]) -> Value {
    let mut fields = vars(pairs);
    fields.insert("v".to_owned(), Value::from(variant));
    Value::from(fields)
}

/// One question and its answer as text (`{ question, answer }`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QuestionAnswer {
    pub question: String,
    pub answer: String,
}

/// `<Details rows>`: the answers that are not empty, as loop rows; `None`
/// when none is left (the component renders nothing).
fn answer_rows(answers: &[QuestionAnswer]) -> Option<Value> {
    let rows: Vec<Value> = answers
        .iter()
        .filter(|a| !a.answer.is_empty())
        .map(|a| {
            row(
                "",
                [
                    ("question", Value::from(a.question.as_str())),
                    ("answer", Value::from(a.answer.as_str())),
                ],
            )
        })
        .collect();
    (!rows.is_empty()).then(|| Value::from(rows))
}

/// `FormsCodeEmailProps`: the one-time code a respondent enters on a
/// verified-email form.
pub fn code(
    locale: EmailLocale,
    brand: &EmailBrand,
    title: &str,
    code: &str,
    expires_in_minutes: Option<u32>,
) -> Result<RenderedEmail, EmailError> {
    let values = vars([
        ("title", Value::from(title)),
        ("code", Value::from(code)),
        ("minutes", Value::from(expires_in_minutes.unwrap_or(10))),
    ]);
    render("forms.code", locale, brand, &[], values)
}

/// `FormsInviteEmailProps`: an invitation to fill in a form with the
/// person's own link, or a reminder of one.
#[derive(Debug, Clone, Copy, Default)]
pub struct InviteProps<'a> {
    /// Who sent the invitation (a person, or the workspace when unknown).
    pub sender_name: &'a str,
    /// The form's title.
    pub title: &'a str,
    /// The sender's own subject line; the template's when empty.
    pub subject: Option<&'a str>,
    pub message: Option<&'a str>,
    /// The person's personal link.
    pub url: &'a str,
    /// ISO time the form closes, when it does.
    pub closes_at: Option<&'a str>,
    pub time_zone: Option<&'a str>,
    /// A reminder: the person got this invitation before.
    pub reminder: bool,
}

pub fn invite(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &InviteProps<'_>,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = vars([
        ("sender_name", Value::from(props.sender_name)),
        ("title", Value::from(props.title)),
        ("url", Value::from(props.url)),
    ]);
    // `props.message?.trim() ? <Quote>… : null`
    if let Some(message) = props.message.filter(|m| !js_trim(m).is_empty()) {
        flags.push("message");
        values.insert("message".to_owned(), Value::from(message));
    }
    if let Some(closes_at) = props.closes_at.filter(|c| !c.is_empty()) {
        flags.push("closes");
        let zone = props.time_zone.filter(|z| !z.is_empty()).unwrap_or("UTC");
        values.insert(
            "closes_date".to_owned(),
            Value::from(format_date(closes_at, locale, zone)?),
        );
    }
    if props.reminder {
        flags.push("reminder");
    }
    let mut email = render("forms.invite", locale, brand, &flags, values)?;
    // `if (!props.reminder && props.subject?.trim()) return props.subject.trim();`
    // then `.replace(/[\r\n]+/g, ' ').trim()`.
    if let Some(own) = props
        .subject
        .map(js_trim)
        .filter(|s| !props.reminder && !s.is_empty())
    {
        let joined = own
            .split(['\r', '\n'])
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        js_trim(&joined).clone_into(&mut email.subject);
    }
    Ok(email)
}

/// `FormsReceiptEmailProps`: a copy of the respondent's own answers.
pub fn receipt(
    locale: EmailLocale,
    brand: &EmailBrand,
    title: &str,
    number: Option<i64>,
    answers: &[QuestionAnswer],
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = vars([("title", Value::from(title))]);
    if let Some(rows) = answer_rows(answers) {
        flags.push("rows");
        values.insert("rows".to_owned(), rows);
    }
    // `props.number ? <Paragraph>…`
    if let Some(number) = number.filter(|n| *n != 0) {
        flags.push("number");
        values.insert("number".to_owned(), Value::from(number));
    }
    render("forms.receipt", locale, brand, &flags, values)
}

/// `FormsResponseEmailProps`: a new response, to a member following the
/// form. `answers: None` sends only the link (the form has sensitive fields).
pub fn response(
    locale: EmailLocale,
    brand: &EmailBrand,
    title: &str,
    number: Option<i64>,
    respondent: Option<&str>,
    answers: Option<&[QuestionAnswer]>,
    url: &str,
) -> Result<RenderedEmail, EmailError> {
    // The number is not shown in this email.
    let _ = number;
    let mut flags = Vec::new();
    let mut values = vars([("title", Value::from(title)), ("url", Value::from(url))]);
    if let Some(respondent) = respondent.filter(|r| !r.is_empty()) {
        flags.push("respondent");
        values.insert("respondent".to_owned(), Value::from(respondent));
    }
    match answers {
        None => flags.push("link_only"),
        Some(answers) => {
            if let Some(rows) = answer_rows(answers) {
                flags.push("rows");
                values.insert("rows".to_owned(), rows);
            }
        }
    }
    render("forms.response", locale, brand, &flags, values)
}

/// One response in the digest (`{ number, respondent, summary }`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DigestItem {
    pub number: Option<i64>,
    pub respondent: Option<String>,
    pub summary: Option<String>,
}

/// `FormsDigestEmailProps`: the responses that came in since the last
/// digest; `responses` are the newest few, `count` all of them.
pub fn digest(
    locale: EmailLocale,
    brand: &EmailBrand,
    title: &str,
    workspace_name: &str,
    count: i64,
    responses: &[DigestItem],
    url: &str,
) -> Result<RenderedEmail, EmailError> {
    let listed = i64::try_from(responses.len()).unwrap_or(i64::MAX);
    let mut flags = Vec::new();
    let mut values = vars([
        ("title", Value::from(title)),
        ("workspace_name", Value::from(workspace_name)),
        ("count", Value::from(count)),
        ("listed", Value::from(listed)),
        ("url", Value::from(url)),
    ]);
    if !responses.is_empty() {
        flags.push("rows");
        let rows: Vec<Value> = responses
            .iter()
            .map(|item| {
                // `r.respondent?.trim() || t.anonymous`, `r.summary?.trim() || undefined`,
                // `r.number ? `#${r.number}` : undefined`.
                let respondent = item
                    .respondent
                    .as_deref()
                    .map(js_trim)
                    .filter(|r| !r.is_empty());
                let summary = item
                    .summary
                    .as_deref()
                    .map(js_trim)
                    .filter(|s| !s.is_empty());
                let number = item.number.filter(|n| *n != 0);
                let variant = [
                    respondent.map(|_| "respondent"),
                    summary.map(|_| "summary"),
                    number.map(|_| "number"),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("+");
                let mut fields = BTreeMap::new();
                if let Some(respondent) = respondent {
                    fields.insert("respondent".to_owned(), Value::from(respondent));
                }
                if let Some(summary) = summary {
                    fields.insert("summary".to_owned(), Value::from(summary));
                }
                if let Some(number) = number {
                    fields.insert("number".to_owned(), Value::from(number));
                }
                fields.insert("v".to_owned(), Value::from(variant));
                Value::from(fields)
            })
            .collect();
        values.insert("rows".to_owned(), Value::from(rows));
    }
    // `const more = props.count - props.responses.length; more > 0 ? …`
    let more = count - listed;
    if more > 0 {
        flags.push("more");
        values.insert("more".to_owned(), Value::from(more));
    }
    render("forms.digest", locale, brand, &flags, values)
}

/// `FormsQuotaEmailProps`: the workspace used 80 % (`percent` below 100) or
/// all of its monthly responses. `resets_at` is the ISO time the count
/// starts again.
#[allow(
    clippy::too_many_arguments,
    reason = "the template's props, in its order"
)]
pub fn quota(
    locale: EmailLocale,
    brand: &EmailBrand,
    workspace_name: &str,
    percent: u8,
    used: i64,
    limit: i64,
    resets_at: &str,
    url: &str,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let values = vars([
        ("workspace_name", Value::from(workspace_name)),
        ("percent", Value::from(percent)),
        ("used", Value::from(used)),
        ("limit", Value::from(limit)),
        (
            "resets_date",
            Value::from(format_date(resets_at, locale, "UTC")?),
        ),
        ("url", Value::from(url)),
    ]);
    if percent >= 100 {
        flags.push("full");
    }
    render("forms.quota", locale, brand, &flags, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> EmailBrand {
        EmailBrand::Workspace {
            name: "Acme Staffing".to_owned(),
            logo_url: None,
            accent_color: Some("#4f46e5".to_owned()),
        }
    }

    fn qa(question: &str, answer: &str) -> QuestionAnswer {
        QuestionAnswer {
            question: question.to_owned(),
            answer: answer.to_owned(),
        }
    }

    #[test]
    fn invitations_take_the_senders_subject_unless_reminding() {
        let props = InviteProps {
            sender_name: "Acme Staffing",
            title: "Customer feedback",
            subject: Some("  Two minutes\nof your time "),
            message: Some("Hi Ann,\nthanks!"),
            url: "https://forms.test/i/abc.def",
            closes_at: None,
            time_zone: None,
            reminder: false,
        };
        let email = invite(EmailLocale::En, &workspace(), &props).expect("invite");
        assert_eq!(email.subject, "Two minutes of your time");
        assert!(email.text.contains("Hi Ann,\nthanks!"));
        let reminder = InviteProps {
            reminder: true,
            ..props
        };
        let email = invite(EmailLocale::En, &workspace(), &reminder).expect("reminder");
        assert_eq!(email.subject, "Reminder: \"Customer feedback\"");
        let plain = InviteProps {
            subject: Some("   "),
            ..props
        };
        let email = invite(EmailLocale::Nl, &workspace(), &plain).expect("plain");
        assert!(email.text.contains("Open het formulier"));
    }

    #[test]
    fn answers_and_responses_loop_over_their_rows() {
        let brand = EmailBrand::weldsuite("WeldForms");
        let answers = [
            qa("Your name", "Ann <3"),
            qa("Empty", ""),
            qa("Plan", "Pro"),
        ];
        let email = receipt(EmailLocale::En, &brand, "Survey", Some(4), &answers).expect("receipt");
        assert!(email.text.contains("Your name: Ann <3"));
        assert!(email.text.contains("Plan: Pro"));
        assert!(!email.text.contains("Empty"));
        assert!(email.html.contains("Ann &lt;3"));
        assert!(email.text.contains("Response #4"));
        let none = receipt(EmailLocale::En, &brand, "Survey", None, &[]).expect("empty");
        assert!(!none.text.contains("Response #"));

        let email = response(
            EmailLocale::En,
            &brand,
            "Survey",
            Some(1),
            Some("ann@example.com"),
            None,
            "https://app.test/r",
        )
        .expect("link only");
        assert!(email.text.contains("private fields"));
        assert!(email.text.contains("New response from ann@example.com"));
        let email = response(
            EmailLocale::En,
            &brand,
            "Survey",
            None,
            None,
            Some(&answers),
            "https://app.test/r",
        )
        .expect("answers");
        assert!(email.text.contains("Your name: Ann <3"));
    }

    #[test]
    fn digests_mix_their_row_variants_and_say_how_many_more() {
        let items = [
            DigestItem {
                number: Some(12),
                respondent: Some(" ann@example.com ".to_owned()),
                summary: Some("Pro".to_owned()),
            },
            DigestItem::default(),
            DigestItem {
                number: Some(0),
                respondent: None,
                summary: Some("  ".to_owned()),
            },
        ];
        let brand = EmailBrand::weldsuite("WeldForms");
        let email = digest(
            EmailLocale::En,
            &brand,
            "Survey",
            "Acme",
            12,
            &items,
            "https://app.test/f",
        )
        .expect("digest");
        assert_eq!(email.subject, "12 new responses to \"Survey\"");
        assert!(email.text.contains("ann@example.com · Pro — #12"));
        assert!(email.text.contains("Anonymous —"));
        assert!(email.text.contains("Latest responses · 3"));
        assert!(email.text.contains("And 9 more."));
        let all = digest(
            EmailLocale::Nl,
            &brand,
            "Survey",
            "Acme",
            3,
            &items,
            "https://app.test/f",
        )
        .expect("all listed");
        assert!(!all.text.contains("more") && !all.text.contains("meer"));
    }

    #[test]
    fn quota_notices_differ_at_the_limit() {
        let brand = EmailBrand::weldsuite("WeldForms");
        let near = quota(
            EmailLocale::En,
            &brand,
            "Acme Staffing",
            80,
            80,
            100,
            "2026-12-01T00:00:00.000Z",
            "https://app.test/settings/billing",
        )
        .expect("near");
        assert_eq!(
            near.subject,
            "Acme Staffing has used 80% of its monthly form responses"
        );
        assert!(near.text.contains("80 of 100"));
        let full = quota(
            EmailLocale::En,
            &brand,
            "Acme Staffing",
            100,
            100,
            100,
            "2026-12-01T00:00:00.000Z",
            "https://app.test/settings/billing",
        )
        .expect("full");
        assert_eq!(
            full.subject,
            "Acme Staffing reached its monthly form response limit"
        );
    }
}
