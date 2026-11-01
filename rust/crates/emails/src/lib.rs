//! System email, as `@weldsuite/emails` sends it from the workers: the same
//! templates, the same subjects, HTML and plain text, sent from
//! `notifications@mail.weldsuite.org` under the module's or the workspace's
//! name, through the `SystemMail` port (SMTP on Kubernetes).
//!
//! # Where the templates come from
//!
//! The React Email templates stay the one source. `pnpm rust:emails`
//! (`scripts/rust-emails.ts`) renders each one to minijinja templates under
//! `rust/catalogs/emails/`, compiled into this crate, and CI fails when the
//! export is stale:
//!
//! - Every string prop is rendered as a sentinel and becomes a placeholder
//!   (`{{ title }}`); this crate escapes values exactly as React does.
//! - Every branch a template takes on its props is a **flag**, and every
//!   combination of flags is its own **variant**, rendered by React. Rust
//!   re-implements no template logic, it only picks the variant: a request
//!   with a message and an expiry date is variant `message+expires`.
//! - Dates are formatted here (`formatDate`: `Saturday, February 3, 2001`,
//!   `zaterdag 3 februari 2001`), in the recipient's time zone.
//! - The layout (logo, inbox preview, footer) is stored once per locale and
//!   brand and wrapped around the variant's content; the plain text is stored
//!   per brand.
//!
//! The typed functions in [`sign`] (and [`hr`]) choose flags and placeholders for each
//! template the way its React component does; [`render`] is the generic entry.
//!
//! # Not supported yet
//!
//! A workspace brand with the "Sent via WeldSuite" line turned off
//! (`poweredBy: false`, white-label portals): no exported layout has it.

pub mod calendar;
mod catalog;
mod date;
mod escape;
pub mod hr;
pub mod ics;
mod send;
pub mod sign;
mod when;
#[rustfmt::skip]
mod zone_names;

pub use catalog::{EmailError, RenderedEmail, render};
pub use date::format_date;
pub use send::{SYSTEM_FROM_ADDRESS, SystemEmail, WithFromAddress, send_system_email};
pub use when::{EndTime, format_time, format_when};

/// The recipient's language (`EmailLocale`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EmailLocale {
    #[default]
    En,
    Nl,
}

impl EmailLocale {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Nl => "nl",
        }
    }

    /// `resolveEmailLocale`: the first candidate whose base language is
    /// supported (`nl-BE` → `nl`), else English.
    pub fn resolve<'a>(candidates: impl IntoIterator<Item = Option<&'a str>>) -> Self {
        for candidate in candidates.into_iter().flatten() {
            let base = candidate
                .trim()
                .to_lowercase()
                .split(['-', '_'])
                .next()
                .unwrap_or_default()
                .to_owned();
            match base.as_str() {
                "en" => return Self::En,
                "nl" => return Self::Nl,
                _ => {}
            }
        }
        Self::En
    }
}

/// Who the email looks like it comes from (`EmailBrand`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmailBrand {
    /// Mail to workspace members: WeldSuite's logo, the module as sender name.
    WeldSuite { module: Option<String> },
    /// Mail to people outside the workspace: its name or logo and accent
    /// colour, and a "Sent via WeldSuite" footer.
    Workspace {
        name: String,
        logo_url: Option<String>,
        accent_color: Option<String>,
    },
}

impl EmailBrand {
    pub fn weldsuite(module: &str) -> Self {
        Self::WeldSuite {
            module: Some(module.to_owned()),
        }
    }

    /// The From display name when the caller sets none (`senderNameOf`).
    pub fn sender_name(&self) -> &str {
        match self {
            Self::WeldSuite { module } => module.as_deref().unwrap_or("WeldSuite"),
            Self::Workspace { name, .. } => name,
        }
    }

    /// The accent colour (`accentOf`): a workspace's own when it is a plain
    /// hex colour, else the theme's.
    pub fn accent(&self) -> String {
        if let Self::Workspace {
            accent_color: Some(color),
            ..
        } = self
        {
            let color = color.trim();
            let hex = color.strip_prefix('#').is_some_and(|digits| {
                (digits.len() == 3 || digits.len() == 6)
                    && digits.bytes().all(|b| b.is_ascii_hexdigit())
            });
            if hex {
                return color.to_owned();
            }
        }
        catalog::theme_accent().to_owned()
    }

    /// The logo URL when it is a valid `https` URL, normalised as
    /// `new URL(...).toString()` (`logoUrlOf`).
    pub fn logo_url(&self) -> Option<String> {
        let Self::Workspace {
            logo_url: Some(logo),
            ..
        } = self
        else {
            return None;
        };
        let url = url::Url::parse(logo).ok()?;
        (url.scheme() == "https").then(|| url.to_string())
    }

    /// Which exported layout and plain text this brand uses.
    pub(crate) fn key(&self) -> &'static str {
        match self {
            Self::WeldSuite { .. } => "weldsuite",
            Self::Workspace { .. } if self.logo_url().is_some() => "workspace_logo",
            Self::Workspace { .. } => "workspace",
        }
    }

    pub(crate) fn name(&self) -> &str {
        match self {
            Self::WeldSuite { .. } => "WeldSuite",
            Self::Workspace { name, .. } => name,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locales_resolve_like_typescript() {
        assert_eq!(EmailLocale::resolve([Some("nl-BE")]), EmailLocale::Nl);
        assert_eq!(
            EmailLocale::resolve([Some("fr"), Some("NL")]),
            EmailLocale::Nl
        );
        assert_eq!(EmailLocale::resolve([None, Some("es")]), EmailLocale::En);
    }

    #[test]
    fn brands_like_typescript() {
        let workspace = |logo: Option<&str>, color: Option<&str>| EmailBrand::Workspace {
            name: "Acme".to_owned(),
            logo_url: logo.map(str::to_owned),
            accent_color: color.map(str::to_owned),
        };
        assert_eq!(workspace(None, Some(" #4F46e5 ")).accent(), "#4F46e5");
        assert_eq!(
            workspace(None, Some("red; x")).accent(),
            catalog::theme_accent()
        );
        assert_eq!(
            workspace(Some("https://Acme.example/logo.png"), None)
                .logo_url()
                .as_deref(),
            Some("https://acme.example/logo.png")
        );
        assert_eq!(
            workspace(Some("http://acme.example/l.png"), None).logo_url(),
            None
        );
        assert_eq!(
            workspace(Some("https://acme.example"), None).key(),
            "workspace_logo"
        );
        assert_eq!(workspace(None, None).key(), "workspace");
        assert_eq!(EmailBrand::weldsuite("WeldSign").sender_name(), "WeldSign");
    }
}
