//! The e-mails WeldBooks sends for a document (Rust only, edition feature
//! `books-invoice-email`): an invoice, a quote, reminders 1 to 3 and a credit
//! note, per entity and language.
//!
//! The texts live in the entity's `jurisdiction_settings.emailTemplates`
//! (`{ <kind>: { <locale>: { subject, body } } }`; no migration), next to the
//! settings other features keep there. A kind or language the entity has not
//! written is the default text of [`default_template`] in `nl` or `en`.
//!
//! Placeholders are `{customerName}`, `{number}`, `{amount}`, `{dueDate}`,
//! `{link}` and `{companyName}`, and for a reminder with the statutory claim
//! `{collectionCosts}`, `{interest}`, `{totalClaim}` and `{noticeDays}`. A
//! placeholder that is not known stays as typed.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

/// The key in `jurisdiction_settings`.
pub const KEY: &str = "emailTemplates";

/// What a template can be for.
pub const KINDS: [&str; 6] = [
    "invoice",
    "quote",
    "reminder1",
    "reminder2",
    "reminder3",
    "creditNote",
];

pub const LOCALES: [&str; 2] = ["nl", "en"];

pub const PLACEHOLDERS: [&str; 10] = [
    "customerName",
    "number",
    "amount",
    "dueDate",
    "link",
    "companyName",
    "collectionCosts",
    "interest",
    "totalClaim",
    "noticeDays",
];

const MAX_SUBJECT: usize = 300;
const MAX_BODY: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Template {
    pub subject: String,
    pub body: String,
}

/// `nl` for a Dutch locale (`nl`, `nl-NL`, `nl_BE`), else `en`.
pub fn locale_of(tag: Option<&str>) -> &'static str {
    match tag {
        Some(t) if t.trim().to_ascii_lowercase().starts_with("nl") => "nl",
        _ => "en",
    }
}

/// The text WeldBooks sends when the entity wrote none.
pub fn default_template(kind: &str, locale: &str) -> Template {
    let nl = locale == "nl";
    let (subject, body) = match (kind, nl) {
        ("invoice", true) => (
            "Factuur {number} van {companyName}",
            "Beste {customerName},\n\nHierbij ontvangt u factuur {number} van {companyName} voor {amount}. Wij vragen u het bedrag voor {dueDate} te betalen.\n\nU kunt de factuur bekijken en betalen via {link}.\n\nMet vriendelijke groet,\n{companyName}",
        ),
        ("invoice", false) => (
            "Invoice {number} from {companyName}",
            "Dear {customerName},\n\nPlease find invoice {number} from {companyName} for {amount}. We kindly ask you to pay it before {dueDate}.\n\nYou can view and pay the invoice at {link}.\n\nKind regards,\n{companyName}",
        ),
        ("creditNote", true) => (
            "Creditnota {number} van {companyName}",
            "Beste {customerName},\n\nHierbij ontvangt u creditnota {number} van {companyName} voor {amount}.\n\nU kunt de creditnota bekijken via {link}.\n\nMet vriendelijke groet,\n{companyName}",
        ),
        ("creditNote", false) => (
            "Credit note {number} from {companyName}",
            "Dear {customerName},\n\nPlease find credit note {number} from {companyName} for {amount}.\n\nYou can view it at {link}.\n\nKind regards,\n{companyName}",
        ),
        ("quote", true) => (
            "Offerte {number} van {companyName}",
            "Beste {customerName},\n\nHierbij ontvangt u offerte {number} van {companyName} voor {amount}. De offerte is geldig tot {dueDate}.\n\nU kunt de offerte bekijken en accepteren via {link}.\n\nMet vriendelijke groet,\n{companyName}",
        ),
        ("quote", false) => (
            "Quote {number} from {companyName}",
            "Dear {customerName},\n\nPlease find quote {number} from {companyName} for {amount}. The quote is valid until {dueDate}.\n\nYou can view and accept it at {link}.\n\nKind regards,\n{companyName}",
        ),
        ("reminder1", true) => (
            "Herinnering: factuur {number}",
            "Beste {customerName},\n\nOnze administratie laat zien dat factuur {number} van {amount} nog niet is betaald. De vervaldatum was {dueDate}. Mogelijk is de betaling over het hoofd gezien.\n\nU kunt de factuur bekijken en betalen via {link}.\n\nMet vriendelijke groet,\n{companyName}",
        ),
        ("reminder1", false) => (
            "Reminder: invoice {number}",
            "Dear {customerName},\n\nOur records show that invoice {number} for {amount} has not been paid yet. It was due on {dueDate}. The payment may have been overlooked.\n\nYou can view and pay the invoice at {link}.\n\nKind regards,\n{companyName}",
        ),
        ("reminder2", true) => (
            "Tweede herinnering: factuur {number}",
            "Beste {customerName},\n\nOndanks onze eerdere herinnering hebben wij factuur {number} van {amount} (vervaldatum {dueDate}) nog niet ontvangen. Wij verzoeken u het bedrag zo spoedig mogelijk te betalen.\n\nU kunt betalen via {link}.\n\nMet vriendelijke groet,\n{companyName}",
        ),
        ("reminder2", false) => (
            "Second reminder: invoice {number}",
            "Dear {customerName},\n\nDespite our earlier reminder we have not yet received invoice {number} for {amount} (due {dueDate}). Please pay it as soon as possible.\n\nYou can pay at {link}.\n\nKind regards,\n{companyName}",
        ),
        ("reminder3", true) => (
            "Laatste aanmaning: factuur {number}",
            "Beste {customerName},\n\nFactuur {number} van {amount} (vervaldatum {dueDate}) is ondanks onze herinneringen nog niet betaald. Dit is onze laatste aanmaning.\n\nWij verzoeken u het bedrag binnen 14 dagen te betalen via {link}.\n\nMet vriendelijke groet,\n{companyName}",
        ),
        ("reminder3", false) => (
            "Final notice: invoice {number}",
            "Dear {customerName},\n\nInvoice {number} for {amount} (due {dueDate}) is still unpaid despite our reminders. This is our final notice.\n\nPlease pay the amount within 14 days at {link}.\n\nKind regards,\n{companyName}",
        ),
        _ => ("", ""),
    };
    Template {
        subject: subject.to_owned(),
        body: body.to_owned(),
    }
}

/// The template to send: the entity's own for this kind and language, else
/// the default.
pub fn template_for(jurisdiction_settings: Option<&Value>, kind: &str, locale: &str) -> Template {
    let stored = jurisdiction_settings
        .and_then(|s| s.get(KEY))
        .and_then(|all| all.get(kind))
        .and_then(|k| k.get(locale));
    let text = |key: &str| {
        stored
            .and_then(|s| s.get(key))
            .and_then(Value::as_str)
            .filter(|t| !t.trim().is_empty())
            .map(str::to_owned)
    };
    let default = default_template(kind, locale);
    Template {
        subject: text("subject").unwrap_or(default.subject),
        body: text("body").unwrap_or(default.body),
    }
}

/// The final notice when the entity claims the statutory costs and has not
/// written its own text: `notice` is the consumer's 14-day notice (the costs
/// are stated, not yet due), else the claim itself (a business, or a consumer
/// after the notice term).
pub fn statutory_template(locale: &str, notice: bool) -> Template {
    let nl = locale == "nl";
    let (subject, body) = match (notice, nl) {
        (true, true) => (
            "Laatste aanmaning (14-dagenbrief): factuur {number}",
            "Beste {customerName},\n\nFactuur {number} van {amount} (vervaldatum {dueDate}) is ondanks onze herinneringen nog niet betaald.\n\nWij verzoeken u het openstaande bedrag van {totalClaim} binnen {noticeDays} dagen na ontvangst van deze brief te betalen via {link}. Betaalt u niet op tijd, dan zijn wij gerechtigd buitengerechtelijke incassokosten van {collectionCosts} en wettelijke rente bij u in rekening te brengen.\n\nMet vriendelijke groet,\n{companyName}",
        ),
        (true, false) => (
            "Final notice (14-day letter): invoice {number}",
            "Dear {customerName},\n\nInvoice {number} for {amount} (due {dueDate}) is still unpaid despite our reminders.\n\nPlease pay the outstanding {totalClaim} within {noticeDays} days of receiving this letter at {link}. If you do not, we are entitled to charge extrajudicial collection costs of {collectionCosts} and statutory interest.\n\nKind regards,\n{companyName}",
        ),
        (false, true) => (
            "Aanmaning incassokosten: factuur {number}",
            "Beste {customerName},\n\nFactuur {number} van {amount} (vervaldatum {dueDate}) is nog steeds niet betaald. Wij berekenen daarom buitengerechtelijke incassokosten van {collectionCosts} en wettelijke rente van {interest}.\n\nWij verzoeken u in totaal {totalClaim} per omgaande te betalen via {link}.\n\nMet vriendelijke groet,\n{companyName}",
        ),
        (false, false) => (
            "Demand incl. collection costs: invoice {number}",
            "Dear {customerName},\n\nInvoice {number} for {amount} (due {dueDate}) is still unpaid. We therefore charge extrajudicial collection costs of {collectionCosts} and statutory interest of {interest}.\n\nPlease pay a total of {totalClaim} immediately at {link}.\n\nKind regards,\n{companyName}",
        ),
    };
    Template {
        subject: subject.to_owned(),
        body: body.to_owned(),
    }
}

/// The entity's own text for this kind and language, when it wrote one.
pub fn custom_template(
    jurisdiction_settings: Option<&Value>,
    kind: &str,
    locale: &str,
) -> Option<Template> {
    let stored = jurisdiction_settings?.get(KEY)?.get(kind)?.get(locale)?;
    stored
        .is_object()
        .then(|| template_for(jurisdiction_settings, kind, locale))
}

/// Every kind and language as the settings screen shows it:
/// `{ <kind>: { <locale>: { subject, body, isDefault } } }`.
pub fn view(jurisdiction_settings: Option<&Value>) -> Value {
    let mut out = Map::new();
    for kind in KINDS {
        let mut locales = Map::new();
        for locale in LOCALES {
            let template = template_for(jurisdiction_settings, kind, locale);
            let is_default = template == default_template(kind, locale);
            locales.insert(
                locale.to_owned(),
                json!({ "subject": template.subject, "body": template.body, "isDefault": is_default }),
            );
        }
        out.insert(kind.to_owned(), Value::Object(locales));
    }
    Value::Object(out)
}

/// `jurisdictionSettings` with the templates of `patch`
/// (`{ <kind>: { <locale>: { subject, body } | null } }`; `null` is back to
/// the default) merged in. Everything else in the settings is kept.
///
/// # Errors
///
/// The message for an unknown kind or language, or a text that is empty or
/// too long.
pub fn merged(
    jurisdiction_settings: Option<&Value>,
    patch: &Map<String, Value>,
) -> Result<Value, String> {
    let mut all = match jurisdiction_settings {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let mut stored = match all.get(KEY) {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    for (kind, locales) in patch {
        if !KINDS.contains(&kind.as_str()) {
            return Err(format!("Unknown template: {kind}"));
        }
        let locales = locales
            .as_object()
            .ok_or_else(|| format!("{kind} must be an object per language"))?;
        let mut current = match stored.get(kind) {
            Some(Value::Object(map)) => map.clone(),
            _ => Map::new(),
        };
        for (locale, template) in locales {
            if !LOCALES.contains(&locale.as_str()) {
                return Err(format!("Unknown language: {locale}"));
            }
            if template.is_null() {
                current.remove(locale);
                continue;
            }
            let field = |key: &str, max: usize| -> Result<String, String> {
                let text = template
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .ok_or_else(|| format!("{kind}.{locale}.{key} is required"))?;
                if text.chars().count() > max {
                    return Err(format!("{kind}.{locale}.{key} is too long"));
                }
                Ok(text.to_owned())
            };
            current.insert(
                locale.clone(),
                json!({ "subject": field("subject", MAX_SUBJECT)?, "body": field("body", MAX_BODY)? }),
            );
        }
        if current.is_empty() {
            stored.remove(kind);
        } else {
            stored.insert(kind.clone(), Value::Object(current));
        }
    }
    all.insert(KEY.to_owned(), Value::Object(stored));
    Ok(Value::Object(all))
}

/// `template` with its `{placeholders}` filled from `values`.
pub fn fill<S: std::hash::BuildHasher>(
    template: &str,
    values: &HashMap<&str, String, S>,
) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) if values.contains_key(&after[..close]) => {
                out.push_str(&values[&after[..close]]);
                rest = &after[close + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The body as HTML: paragraphs for blank lines, a line break for a newline,
/// and the link as a link wherever it stands. Everything is escaped.
pub fn body_html(body: &str, link: Option<&str>) -> String {
    let escaped = escape(body);
    let linked = match link {
        Some(url) if !url.is_empty() => {
            let url = escape(url);
            escaped.replace(&url, &format!("<a href=\"{url}\">{url}</a>"))
        }
        _ => escaped,
    };
    let paragraphs: Vec<String> = linked
        .split("\n\n")
        .map(|p| {
            format!(
                "<p style=\"margin:0 0 14px\">{}</p>",
                p.replace('\n', "<br>")
            )
        })
        .collect();
    format!(
        "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.5;color:#222\">{}</div>",
        paragraphs.join("")
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    #[test]
    fn every_kind_has_a_default_in_both_languages_that_names_the_number() {
        for kind in KINDS {
            for locale in LOCALES {
                let t = default_template(kind, locale);
                assert!(
                    !t.subject.is_empty() && !t.body.is_empty(),
                    "{kind} {locale}"
                );
                if kind != "quote" {
                    assert!(t.body.contains("{link}"), "{kind} {locale}");
                }
                assert!(t.subject.contains("{number}"), "{kind} {locale}");
            }
        }
        assert!(
            default_template("invoice", "nl")
                .subject
                .starts_with("Factuur")
        );
        assert!(
            default_template("invoice", "en")
                .subject
                .starts_with("Invoice")
        );
    }

    #[test]
    fn a_placeholder_is_filled_and_an_unknown_one_stays() {
        let values = HashMap::from([
            ("number", "F-1".to_owned()),
            ("amount", "€ 10,00".to_owned()),
        ]);
        assert_eq!(
            fill("Factuur {number} ({amount}) {nope} {", &values),
            "Factuur F-1 (€ 10,00) {nope} {"
        );
        assert_eq!(fill("{number}{number}", &values), "F-1F-1");
    }

    #[test]
    fn an_entitys_text_wins_for_its_language_only() {
        let settings = json!({ "emailTemplates": { "invoice": { "nl": { "subject": "Eigen {number}", "body": "Hoi {customerName} {link}" } } } });
        assert_eq!(
            template_for(Some(&settings), "invoice", "nl").subject,
            "Eigen {number}"
        );
        assert_eq!(
            template_for(Some(&settings), "invoice", "en"),
            default_template("invoice", "en")
        );
        assert_eq!(
            template_for(None, "quote", "nl"),
            default_template("quote", "nl")
        );
        let shown = view(Some(&settings));
        assert_eq!(shown["invoice"]["nl"]["isDefault"], false);
        assert_eq!(shown["invoice"]["en"]["isDefault"], true);
    }

    #[test]
    fn a_patch_sets_resets_and_keeps_other_settings() {
        let stored = json!({ "differences": { "x": 1 } });
        let patch = json!({ "quote": { "en": { "subject": "Q {number}", "body": "See {link}" } } });
        let out = merged(Some(&stored), patch.as_object().unwrap()).unwrap();
        assert_eq!(out["differences"]["x"], 1);
        assert_eq!(
            template_for(Some(&out), "quote", "en").subject,
            "Q {number}"
        );
        let reset = json!({ "quote": { "en": null } });
        let back = merged(Some(&out), reset.as_object().unwrap()).unwrap();
        assert_eq!(
            template_for(Some(&back), "quote", "en"),
            default_template("quote", "en")
        );
        assert!(back["emailTemplates"].get("quote").is_none());
        for bad in [
            json!({ "welcome": { "en": { "subject": "a", "body": "b" } } }),
            json!({ "quote": { "fr": { "subject": "a", "body": "b" } } }),
            json!({ "quote": { "en": { "subject": "", "body": "b" } } }),
            json!({ "quote": { "en": { "subject": "a" } } }),
            json!({ "quote": "x" }),
        ] {
            assert!(merged(None, bad.as_object().unwrap()).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_html_is_escaped_and_the_link_is_a_link() {
        let html = body_html(
            "Hi <b>x</b> & co\n\nPay at https://pay.example.org/d/abc?x=1&y=2",
            Some("https://pay.example.org/d/abc?x=1&y=2"),
        );
        assert!(html.contains("&lt;b&gt;x&lt;/b&gt; &amp; co"));
        assert!(html.contains("<a href=\"https://pay.example.org/d/abc?x=1&amp;y=2\">"));
        assert_eq!(html.matches("<p ").count(), 2);
    }

    #[test]
    fn the_language_follows_the_locale() {
        assert_eq!(locale_of(Some("nl-NL")), "nl");
        assert_eq!(locale_of(Some("NL")), "nl");
        assert_eq!(locale_of(Some("en-US")), "en");
        assert_eq!(locale_of(None), "en");
    }
}
