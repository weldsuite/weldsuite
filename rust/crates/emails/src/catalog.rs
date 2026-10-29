//! The exported templates (`rust/catalogs/emails/`), compiled once into one
//! minijinja environment, and [`render`].

use std::collections::BTreeMap;
use std::sync::LazyLock;

use minijinja::{AutoEscape, Environment, UndefinedBehavior, Value};
use serde::Deserialize;

use crate::escape::{self, escape_html};
use crate::{EmailBrand, EmailLocale};

/// Every exported file. `every_export_is_compiled_in` fails when the export
/// writes one that is not listed here.
const TEMPLATE_FILES: &[(&str, &str)] = &[
    (
        "calendar.event.cancel",
        include_str!("../../../catalogs/emails/templates/calendar.event.cancel.json"),
    ),
    (
        "calendar.event.invite",
        include_str!("../../../catalogs/emails/templates/calendar.event.invite.json"),
    ),
    (
        "calendar.event.removed",
        include_str!("../../../catalogs/emails/templates/calendar.event.removed.json"),
    ),
    (
        "calendar.event.reschedule",
        include_str!("../../../catalogs/emails/templates/calendar.event.reschedule.json"),
    ),
    (
        "calendar.event.restored",
        include_str!("../../../catalogs/emails/templates/calendar.event.restored.json"),
    ),
    (
        "calendar.event.update",
        include_str!("../../../catalogs/emails/templates/calendar.event.update.json"),
    ),
    (
        "sign.code",
        include_str!("../../../catalogs/emails/templates/sign.code.json"),
    ),
    (
        "sign.completed",
        include_str!("../../../catalogs/emails/templates/sign.completed.json"),
    ),
    (
        "sign.declined",
        include_str!("../../../catalogs/emails/templates/sign.declined.json"),
    ),
    (
        "sign.expired",
        include_str!("../../../catalogs/emails/templates/sign.expired.json"),
    ),
    (
        "sign.request",
        include_str!("../../../catalogs/emails/templates/sign.request.json"),
    ),
    (
        "sign.voided",
        include_str!("../../../catalogs/emails/templates/sign.voided.json"),
    ),
];
const LAYOUTS: &str = include_str!("../../../catalogs/emails/layouts.json");

#[derive(Deserialize)]
struct LayoutFile {
    theme: Theme,
    layouts: BTreeMap<String, BTreeMap<String, Layout>>,
}

#[derive(Deserialize)]
struct Theme {
    accent: String,
}

#[derive(Deserialize)]
struct Layout {
    plain: String,
    footer: String,
}

#[derive(Deserialize)]
struct TemplateFile {
    id: String,
    flags: Vec<String>,
    variants: BTreeMap<String, BTreeMap<String, Variant>>,
}

#[derive(Deserialize)]
struct Variant {
    subject: String,
    preview: String,
    footer: Option<String>,
    html: String,
    text: BTreeMap<String, String>,
}

/// A rendered email (`RenderedEmail`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedEmail {
    pub subject: String,
    pub html: String,
    pub text: String,
}

/// Why rendering failed.
#[derive(Debug)]
pub enum EmailError {
    /// No such template, or a flag it does not have.
    Unknown(String),
    /// A placeholder had no value, or the template did not compile.
    Template(minijinja::Error),
    /// A date or time zone that cannot be formatted.
    Date(String),
}

impl std::fmt::Display for EmailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unknown(what) => write!(f, "unknown email template or variant: {what}"),
            Self::Template(error) => write!(f, "email template: {error}"),
            Self::Date(what) => write!(f, "email date: {what}"),
        }
    }
}

impl std::error::Error for EmailError {}

impl From<minijinja::Error> for EmailError {
    fn from(error: minijinja::Error) -> Self {
        Self::Template(error)
    }
}

struct Catalog {
    env: Environment<'static>,
    accent: String,
    /// Each template's flags, in the order its variant keys use.
    flags: BTreeMap<String, Vec<String>>,
    /// Which variants have a footer.
    footers: BTreeMap<String, bool>,
}

fn template_name(id: &str, locale: &str, key: &str, part: &str) -> String {
    format!("{id}/{locale}/{key}/{part}")
}

fn build() -> Catalog {
    let mut env = Environment::new();
    env.set_undefined_behavior(UndefinedBehavior::Strict);
    env.set_auto_escape_callback(|name| {
        if name.ends_with("/html") || name.starts_with("layout/") {
            AutoEscape::Html
        } else {
            AutoEscape::None
        }
    });
    env.set_formatter(|out, state, value| {
        let mut text = String::new();
        if matches!(state.auto_escape(), AutoEscape::Html) && !value.is_safe() {
            escape_html(&value.to_string(), &mut text);
        } else {
            text = value.to_string();
        }
        out.write_str(&text).map_err(minijinja::Error::from)
    });
    env.add_filter("multiline", |value: String| escape::multiline(&value));
    env.add_filter("text_lines", |value: String| escape::text_lines(&value));
    env.add_filter("collapse", |value: Value| {
        escape::collapse(&value.to_string())
    });
    env.add_filter("preview_block", |value: String| {
        escape::preview_block(&value)
    });

    let layouts: LayoutFile = serde_json::from_str(LAYOUTS).expect("layouts.json parses");
    for (locale, brands) in layouts.layouts {
        for (brand, layout) in brands {
            env.add_template_owned(format!("layout/{locale}/{brand}/plain"), layout.plain)
                .expect("a layout compiles");
            env.add_template_owned(format!("layout/{locale}/{brand}/footer"), layout.footer)
                .expect("a layout compiles");
        }
    }

    let mut flags = BTreeMap::new();
    let mut footers = BTreeMap::new();
    for (file, json) in TEMPLATE_FILES {
        let template: TemplateFile = serde_json::from_str(json)
            .unwrap_or_else(|error| panic!("{file}.json parses: {error}"));
        for (locale, variants) in template.variants {
            for (key, variant) in variants {
                let name = |part: &str| template_name(&template.id, &locale, &key, part);
                let mut parts = vec![
                    (name("subject"), variant.subject),
                    (name("preview"), variant.preview),
                    (name("html"), variant.html),
                ];
                footers.insert(name("footer"), variant.footer.is_some());
                if let Some(footer) = variant.footer {
                    parts.push((name("footer"), footer));
                }
                for (brand, text) in variant.text {
                    parts.push((name(&format!("text/{brand}")), text));
                }
                for (part, source) in parts {
                    env.add_template_owned(part, source)
                        .unwrap_or_else(|error| panic!("{file}: a template compiles: {error}"));
                }
            }
        }
        flags.insert(template.id, template.flags);
    }
    Catalog {
        env,
        accent: layouts.theme.accent,
        flags,
        footers,
    }
}

static CATALOG: LazyLock<Catalog> = LazyLock::new(build);

/// The theme's accent colour (`theme.color.accent`).
pub(crate) fn theme_accent() -> &'static str {
    &CATALOG.accent
}

fn render_part(name: &str, ctx: &Value) -> Result<String, EmailError> {
    Ok(CATALOG.env.get_template(name)?.render(ctx.clone())?)
}

/// Render template `id` (`renderEmail`): `flags` picks the variant (the set
/// ones; order does not matter), `vars` fills its placeholders. The brand's
/// accent colour, name and logo are added here.
pub fn render(
    id: &str,
    locale: EmailLocale,
    brand: &EmailBrand,
    flags: &[&str],
    vars: BTreeMap<String, Value>,
) -> Result<RenderedEmail, EmailError> {
    let catalog = &*CATALOG;
    let known = catalog
        .flags
        .get(id)
        .ok_or_else(|| EmailError::Unknown(id.to_owned()))?;
    if let Some(flag) = flags.iter().find(|f| !known.iter().any(|k| k == *f)) {
        return Err(EmailError::Unknown(format!("{id} flag {flag}")));
    }
    let key = known
        .iter()
        .filter(|k| flags.contains(&k.as_str()))
        .cloned()
        .collect::<Vec<_>>()
        .join("+");
    let locale = locale.as_str();
    let name = |part: &str| template_name(id, locale, &key, part);

    let mut vars = vars;
    vars.insert("accent".to_owned(), Value::from(brand.accent()));
    vars.insert("__brand_name".to_owned(), Value::from(brand.name()));
    let ctx = Value::from(vars);

    // `subject(...).replace(/[\r\n]+/g, ' ').trim()`
    let subject = render_part(&name("subject"), &ctx)?;
    let subject = subject
        .split(['\r', '\n'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_owned();
    let preview = render_part(&name("preview"), &ctx)?;
    let has_footer = catalog
        .footers
        .get(&name("footer"))
        .copied()
        .unwrap_or(false);
    let footer = if has_footer {
        Some(render_part(&name("footer"), &ctx)?)
    } else {
        None
    };
    let content = render_part(&name("html"), &ctx)?;

    let mut layout = BTreeMap::new();
    layout.insert("__preview".to_owned(), Value::from(preview));
    layout.insert("__content".to_owned(), Value::from_safe_string(content));
    layout.insert("__brand_name".to_owned(), Value::from(brand.name()));
    layout.insert(
        "__logo_url".to_owned(),
        Value::from(brand.logo_url().unwrap_or_default()),
    );
    if let Some(footer) = footer {
        layout.insert("__footer".to_owned(), Value::from(footer));
    }
    let shape = if has_footer { "footer" } else { "plain" };
    let html = render_part(
        &format!("layout/{locale}/{}/{shape}", brand.key()),
        &Value::from(layout),
    )?;
    let text = render_part(&name(&format!("text/{}", brand.key())), &ctx)?;
    Ok(RenderedEmail {
        subject,
        html,
        text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCALES: [&str; 2] = ["en", "nl"];
    const BRANDS: [&str; 3] = ["weldsuite", "workspace", "workspace_logo"];

    /// A file the export wrote but nobody compiled in would be dead weight;
    /// one compiled in but no longer exported would be stale.
    #[test]
    fn every_export_is_compiled_in() {
        let dir = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../catalogs/emails/templates"
        );
        let mut exported: Vec<String> = std::fs::read_dir(dir)
            .expect("templates dir")
            .filter_map(Result::ok)
            .filter_map(|e| {
                e.file_name()
                    .to_str()?
                    .strip_suffix(".json")
                    .map(str::to_owned)
            })
            .collect();
        exported.sort();
        let listed: Vec<String> = TEMPLATE_FILES
            .iter()
            .map(|(id, _)| (*id).to_owned())
            .collect();
        assert_eq!(listed, exported);
    }

    #[test]
    fn every_locale_and_brand_has_a_layout() {
        for locale in LOCALES {
            for brand in BRANDS {
                for shape in ["plain", "footer"] {
                    assert!(
                        CATALOG
                            .env
                            .get_template(&format!("layout/{locale}/{brand}/{shape}"))
                            .is_ok()
                    );
                }
            }
        }
    }

    #[test]
    fn unknown_templates_and_flags_are_refused() {
        let brand = EmailBrand::weldsuite("WeldSign");
        assert!(matches!(
            render("nope", EmailLocale::En, &brand, &[], BTreeMap::new()),
            Err(EmailError::Unknown(_))
        ));
        assert!(matches!(
            render(
                "sign.code",
                EmailLocale::En,
                &brand,
                &["bogus"],
                BTreeMap::new()
            ),
            Err(EmailError::Unknown(_))
        ));
        // A missing placeholder is an error, not an empty string.
        assert!(matches!(
            render("sign.code", EmailLocale::En, &brand, &[], BTreeMap::new()),
            Err(EmailError::Template(_))
        ));
    }
}
