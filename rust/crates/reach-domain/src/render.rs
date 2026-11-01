//! `render.ts`: a campaign step as it is sent: template variables from the
//! prospect and the mailbox, the signature, and the opt-out footer.

use serde_json::Value;

use crate::schemas::render_template;
use crate::text::{collapse_spaces, js_trim, js_trim_end};

/// `DEFAULT_OPT_OUT_TEXT`.
pub const DEFAULT_OPT_OUT_TEXT: &str =
    "If you'd rather not hear from me, just reply 'stop' and I won't email you again.";

/// The prospect fields a template reads (`RenderProspect`).
#[derive(Debug, Clone, Default)]
pub struct RenderProspect {
    pub email: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub company_name: Option<String>,
    pub title: Option<String>,
    /// `customFields`, in the stored order.
    pub custom_fields: Vec<(String, String)>,
}

impl RenderProspect {
    /// From a `reach_prospects` row.
    pub fn from_row(row: &Value) -> Self {
        let opt = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
        Self {
            email: opt("email").unwrap_or_default(),
            first_name: opt("firstName"),
            last_name: opt("lastName"),
            company_name: opt("companyName"),
            title: opt("title"),
            custom_fields: row
                .get("customFields")
                .and_then(Value::as_object)
                .map(|fields| {
                    fields
                        .iter()
                        .map(|(k, v)| (k.clone(), v.as_str().map_or_else(|| v.to_string(), str::to_owned)))
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
}

/// The sending mailbox's name (`RenderSender`).
#[derive(Debug, Clone)]
pub struct RenderSender {
    pub first_name: String,
    pub last_name: String,
}

fn join_name(first: Option<&str>, last: Option<&str>) -> Option<String> {
    let full = [first, last]
        .into_iter()
        .flatten()
        .map(js_trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    (!full.is_empty()).then_some(full)
}

/// `buildTemplateValues(prospect, sender)`: custom fields first, so the
/// built-in names win.
pub fn template_values(prospect: &RenderProspect, sender: Option<&RenderSender>) -> Vec<(String, Option<String>)> {
    let mut values: Vec<(String, Option<String>)> = prospect
        .custom_fields
        .iter()
        .map(|(k, v)| (k.clone(), Some(v.clone())))
        .collect();
    values.extend([
        ("firstName".to_owned(), prospect.first_name.clone()),
        ("lastName".to_owned(), prospect.last_name.clone()),
        (
            "fullName".to_owned(),
            join_name(prospect.first_name.as_deref(), prospect.last_name.as_deref()),
        ),
        ("email".to_owned(), Some(prospect.email.clone())),
        ("companyName".to_owned(), prospect.company_name.clone()),
        ("title".to_owned(), prospect.title.clone()),
        ("senderFirstName".to_owned(), sender.map(|s| s.first_name.clone())),
        ("senderLastName".to_owned(), sender.map(|s| s.last_name.clone())),
        (
            "senderFullName".to_owned(),
            sender.and_then(|s| join_name(Some(&s.first_name), Some(&s.last_name))),
        ),
    ]);
    values
}

/// `singleLine(value)`.
pub fn single_line(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_break = false;
    for c in value.chars() {
        if c == '\r' || c == '\n' {
            if !in_break {
                out.push(' ');
            }
            in_break = true;
        } else {
            out.push(c);
            in_break = false;
        }
    }
    js_trim(&out).to_owned()
}

/// `renderStepContent(step, values)`.
#[derive(Debug, Clone)]
pub struct RenderedStep {
    pub subject: String,
    pub body: String,
    pub missing: Vec<String>,
}

pub fn render_step(subject: &str, body: &str, values: &[(String, Option<String>)]) -> RenderedStep {
    let (subject, subject_missing) = render_template(subject, values);
    let (body, body_missing) = render_template(body, values);
    let mut missing = subject_missing;
    for name in body_missing {
        if !missing.contains(&name) {
            missing.push(name);
        }
    }
    RenderedStep {
        subject: single_line(&subject),
        body,
        missing,
    }
}

/// `replySubject(subject)` of a follow-up step (`render.ts`).
pub fn follow_up_subject(subject: &str) -> String {
    let lower = subject.to_lowercase();
    if lower.starts_with("re:") && subject.chars().nth(3).is_some_and(crate::text::is_js_space) {
        subject.to_owned()
    } else {
        format!("Re: {subject}")
    }
}

/// `composeBody(body, signature)`.
pub fn compose_body(body: &str, signature: Option<&str>) -> String {
    let sig = signature.map(js_trim).unwrap_or_default();
    let trimmed = js_trim_end(body);
    if sig.is_empty() || trimmed.ends_with(sig) {
        return trimmed.to_owned();
    }
    format!("{trimmed}\n\n{sig}")
}

/// The footer settings (`FooterSettings`), from a `reach_settings` row.
pub fn email_footer(settings: Option<&Value>) -> String {
    let field = |key: &str| {
        settings
            .and_then(|s| s.get(key))
            .and_then(Value::as_str)
            .map(js_trim)
    };
    let opt_out = field("optOutText").filter(|t| !t.is_empty()).unwrap_or(DEFAULT_OPT_OUT_TEXT);
    let lines: Vec<&str> = [
        opt_out,
        field("senderCompanyName").unwrap_or_default(),
        field("senderAddress").unwrap_or_default(),
    ]
    .into_iter()
    .filter(|line| !line.is_empty())
    .collect();
    format!("\n\n-- \n{}", lines.join("\n"))
}

/// `snippetOf(text, 500)`: one line, with an ellipsis when cut.
pub fn snippet_of(text: &str, max: usize) -> String {
    let flat = js_trim(&collapse_spaces(text)).to_owned();
    if crate::js_len(&flat) > max {
        format!("{}…", crate::js_slice(&flat, max - 1))
    } else {
        flat
    }
}
