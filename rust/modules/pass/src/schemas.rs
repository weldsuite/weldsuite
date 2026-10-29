//! The password manager's shared schema and helpers
//! (`@weldsuite/app-api-client/schemas/weldpass-passwords`): the item
//! document, the request bodies, `hostOf` and password strength.
//!
//! An item is sealed as `JSON.stringify` of the Zod-parsed document, whose
//! keys follow the schema's order; [`ItemDocument::to_json_string`] writes
//! the same text, so both backends seal identical plaintext and agree on
//! "unchanged" when an identical item is saved again.

use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};

use crate::js;

pub(crate) const VAULT_ROLES: [&str; 3] = ["viewer", "editor", "manager"];
pub(crate) const ITEM_TYPES: [&str; 3] = ["login", "note", "card"];
pub(crate) const IMPORT_FORMATS: [&str; 6] = [
    "auto",
    "lastpass",
    "nordpass",
    "1password",
    "bitwarden",
    "chrome",
];

/// A login's fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LoginFields {
    pub(crate) username: String,
    pub(crate) password: String,
    pub(crate) totp: String,
    pub(crate) notes: String,
}

/// A card's fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CardFields {
    pub(crate) cardholder: String,
    pub(crate) number: String,
    pub(crate) expiry: String,
    pub(crate) cvc: String,
    pub(crate) notes: String,
}

/// `WeldPassItemInput`, as `itemInputSchema` parses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ItemDocument {
    Login {
        title: String,
        /// `.nullish()`: left out, `null`, or a string.
        url: Field<String>,
        fields: LoginFields,
    },
    Note {
        title: String,
        content: String,
    },
    Card {
        title: String,
        fields: CardFields,
    },
}

impl ItemDocument {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Login { .. } => "login",
            Self::Note { .. } => "note",
            Self::Card { .. } => "card",
        }
    }

    /// `passwordOf`: a login's password, else `''`.
    pub(crate) fn password(&self) -> &str {
        match self {
            Self::Login { fields, .. } => &fields.password,
            _ => "",
        }
    }

    /// `document.fields`, as the reveal route returns them.
    pub(crate) fn fields_json(&self) -> Value {
        match self {
            Self::Login { fields, .. } => json!({
                "username": fields.username,
                "password": fields.password,
                "totp": fields.totp,
                "notes": fields.notes,
            }),
            Self::Note { content, .. } => json!({ "content": content }),
            Self::Card { fields, .. } => json!({
                "cardholder": fields.cardholder,
                "number": fields.number,
                "expiry": fields.expiry,
                "cvc": fields.cvc,
                "notes": fields.notes,
            }),
        }
    }

    /// `JSON.stringify(document)`: keys in the schema's order, `url` left out
    /// when the input left it out.
    pub(crate) fn to_json_string(&self) -> String {
        let string = |text: &str| Value::String(text.to_owned()).to_string();
        let pairs = |entries: &[(&str, String)]| {
            let body: Vec<String> = entries
                .iter()
                .map(|(key, value)| format!("{}:{value}", string(key)))
                .collect();
            format!("{{{}}}", body.join(","))
        };
        match self {
            Self::Login { title, url, fields } => {
                let mut entries = vec![("type", string("login")), ("title", string(title))];
                match url {
                    Field::Absent => {}
                    Field::Null => entries.push(("url", "null".to_owned())),
                    Field::Set(url) => entries.push(("url", string(url))),
                }
                entries.push((
                    "fields",
                    pairs(&[
                        ("username", string(&fields.username)),
                        ("password", string(&fields.password)),
                        ("totp", string(&fields.totp)),
                        ("notes", string(&fields.notes)),
                    ]),
                ));
                pairs(&entries)
            }
            Self::Note { title, content } => pairs(&[
                ("type", string("note")),
                ("title", string(title)),
                ("fields", pairs(&[("content", string(content))])),
            ]),
            Self::Card { title, fields } => pairs(&[
                ("type", string("card")),
                ("title", string(title)),
                (
                    "fields",
                    pairs(&[
                        ("cardholder", string(&fields.cardholder)),
                        ("number", string(&fields.number)),
                        ("expiry", string(&fields.expiry)),
                        ("cvc", string(&fields.cvc)),
                        ("notes", string(&fields.notes)),
                    ]),
                ),
            ]),
        }
    }
}

/// `z.string()...default('')`.
fn defaulted(issues: &mut Issues, fields: &Map<String, Value>, key: &str, rules: Text) -> String {
    issues
        .text_with(fields, key, Presence::Optional, rules)
        .into_option()
        .unwrap_or_default()
}

/// `itemInputSchema` (a discriminated union on `type`) read from a body that
/// is the item. `None` when invalid; the issues say why.
pub(crate) fn read_item(issues: &mut Issues, body: &Value) -> Option<ItemDocument> {
    let object = issues.object(body)?;
    let kind = match object.get("type") {
        Some(Value::String(kind)) if ITEM_TYPES.contains(&kind.as_str()) => kind.clone(),
        _ => {
            issues.invalid_discriminator("type", &ITEM_TYPES);
            return None;
        }
    };
    let before = issues.count();
    let title = issues
        .text_with(
            object,
            "title",
            Presence::Required,
            Text::trimmed(Some(1), Some(200)),
        )
        .into_option();
    let document = match kind.as_str() {
        "login" => {
            let url = issues.text_with(
                object,
                "url",
                Presence::Nullish,
                Text::trimmed(None, Some(2048)),
            );
            let fields = issues
                .nested(object, "fields", Presence::Required, |issues, fields| {
                    LoginFields {
                        username: defaulted(issues, fields, "username", Text::length(None, Some(255))),
                        password: defaulted(issues, fields, "password", Text::length(None, Some(4096))),
                        totp: defaulted(issues, fields, "totp", Text::trimmed(None, Some(2048))),
                        notes: defaulted(issues, fields, "notes", Text::length(None, Some(20_000))),
                    }
                })
                .into_option();
            fields.map(|fields| ItemDocument::Login {
                title: title.clone().unwrap_or_default(),
                url,
                fields,
            })
        }
        "note" => issues
            .nested(object, "fields", Presence::Required, |issues, fields| {
                defaulted(issues, fields, "content", Text::length(None, Some(100_000)))
            })
            .into_option()
            .map(|content| ItemDocument::Note {
                title: title.clone().unwrap_or_default(),
                content,
            }),
        _ => issues
            .nested(object, "fields", Presence::Required, |issues, fields| {
                CardFields {
                    cardholder: defaulted(issues, fields, "cardholder", Text::trimmed(None, Some(255))),
                    number: defaulted(issues, fields, "number", Text::trimmed(None, Some(40))),
                    expiry: defaulted(issues, fields, "expiry", Text::trimmed(None, Some(10))),
                    cvc: defaulted(issues, fields, "cvc", Text::trimmed(None, Some(10))),
                    notes: defaulted(issues, fields, "notes", Text::length(None, Some(20_000))),
                }
            })
            .into_option()
            .map(|fields| ItemDocument::Card {
                title: title.clone().unwrap_or_default(),
                fields,
            }),
    };
    if issues.count() > before {
        return None;
    }
    document
}

/// `itemInputSchema.parse(JSON.parse(text))` for a stored document; `None`
/// where TypeScript would throw.
pub(crate) fn parse_item(text: &str) -> Option<ItemDocument> {
    let value: Value = serde_json::from_str(text).ok()?;
    let mut issues = Issues::default();
    let document = read_item(&mut issues, &value);
    issues.finish().ok()?;
    document
}

/// `hostOf`: a URL's host, lower-cased and without a leading `www.`; `None`
/// for anything that is not a web address.
pub(crate) fn host_of(url: Option<&str>) -> Option<String> {
    let trimmed = js::trim(url?);
    if trimmed.is_empty() {
        return None;
    }
    let candidate = if has_scheme(trimmed) {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = url::Url::parse(&candidate).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let hostname = parsed.host_str().unwrap_or_default().to_lowercase();
    let host = hostname.strip_prefix("www.").unwrap_or(&hostname);
    (host.contains('.') || host == "localhost").then(|| js::utf16_slice(host, 0, 255))
}

/// `/^[a-z][a-z0-9+.-]*:\/\//i`.
fn has_scheme(text: &str) -> bool {
    let Some((scheme, _)) = text.split_once("://") else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// The passwords attackers try first; compared lower-cased.
const COMMON_PASSWORDS: [&str; 52] = [
    "123456",
    "1234567",
    "12345678",
    "123456789",
    "1234567890",
    "111111",
    "000000",
    "123123",
    "password",
    "password1",
    "password123",
    "passw0rd",
    "p@ssw0rd",
    "qwerty",
    "qwerty123",
    "qwertyuiop",
    "azerty",
    "abc123",
    "letmein",
    "welcome",
    "welcome1",
    "welcome123",
    "admin",
    "admin123",
    "administrator",
    "root",
    "iloveyou",
    "monkey",
    "dragon",
    "football",
    "baseball",
    "master",
    "sunshine",
    "princess",
    "login",
    "changeme",
    "secret",
    "trustno1",
    "superman",
    "batman",
    "starwars",
    "whatever",
    "hello123",
    "freedom",
    "shadow",
    "michael",
    "jennifer",
    "welkom",
    "welkom01",
    "welkom123",
    "wachtwoord",
    "geheim",
];

/// `passwordEntropyBits`: length times log2 of the character pool, where a
/// character that repeats or continues a run (`aaaa`, `1234`) adds nothing.
pub(crate) fn password_entropy_bits(password: &str) -> f64 {
    if password.is_empty() || COMMON_PASSWORDS.contains(&password.to_lowercase().as_str()) {
        return 0.0;
    }
    let mut pool = 0_u32;
    if password.chars().any(|c| c.is_ascii_lowercase()) {
        pool += 26;
    }
    if password.chars().any(|c| c.is_ascii_uppercase()) {
        pool += 26;
    }
    if password.chars().any(|c| c.is_ascii_digit()) {
        pool += 10;
    }
    if password.chars().any(|c| !c.is_ascii_alphanumeric()) {
        pool += 33;
    }
    // `charCodeAt` steps over UTF-16 code units.
    let units: Vec<u16> = password.encode_utf16().collect();
    let effective = units
        .iter()
        .enumerate()
        .filter(|&(i, &unit)| i == 0 || (i32::from(unit) - i32::from(units[i - 1])).abs() > 1)
        .count();
    #[allow(clippy::cast_precision_loss)]
    let effective = effective as f64;
    effective * f64::from(pool).log2()
}

/// `passwordStrength`.
pub(crate) fn password_strength(password: &str) -> &'static str {
    let bits = password_entropy_bits(password);
    if bits < 45.0 {
        "weak"
    } else if bits < 75.0 {
        "fair"
    } else {
        "strong"
    }
}

/// A Zod issue as the import report writes it: `<path.joined.by.dots>: <message>`.
pub(crate) fn issue_text(issue: &Value) -> String {
    let path: Vec<String> = issue["path"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .map(|part| {
                    part.as_str()
                        .map_or_else(|| part.to_string(), str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default();
    format!(
        "{}: {}",
        path.join("."),
        issue["message"].as_str().unwrap_or_default()
    )
}

/// `slugify` (`services/weldpass/vault.ts`): lower case, every run of other
/// characters one dash, no dash at either end, at most 40 characters (a dash
/// the cut lands on stays).
pub(crate) fn slugify(input: &str) -> String {
    let lower = input.to_lowercase();
    let mut slug = String::with_capacity(lower.len());
    let mut in_run = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
            in_run = false;
        } else if !in_run {
            slug.push('-');
            in_run = true;
        }
    }
    let trimmed = slug.strip_prefix('-').unwrap_or(&slug);
    let trimmed = trimmed.strip_suffix('-').unwrap_or(trimmed);
    // ASCII only by now, so bytes are UTF-16 units.
    trimmed.chars().take(40).collect()
}
