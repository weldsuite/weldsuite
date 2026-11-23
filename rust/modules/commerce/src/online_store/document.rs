//! The site document and its validation against the theme's section catalog
//! (`rust/catalogs/storefront-sections.json`, exported from
//! `@weldsuite/storefront-theme`). Every draft, page and menu is checked
//! here before it is saved, so the renderer only ever draws documents of
//! known shape: known section types where they may go, the main sections
//! once, settings of the right type and size, safe URLs, and no HTML
//! (rich text is a Markdown subset the theme renders itself).

use std::collections::HashSet;
use std::sync::LazyLock;

use serde_json::{Map, Value};

/// The catalog, as the theme package exports it.
static CATALOG: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../catalogs/storefront-sections.json"
    ))
    .unwrap_or(Value::Null)
});

pub(crate) const TEMPLATES: [&str; 7] = [
    "home", "product", "category", "search", "cart", "page", "notFound",
];
pub(crate) const GROUPS: [&str; 2] = ["header", "footer"];
pub(crate) const THEMES: [&str; 1] = ["atelier"];
pub(crate) const FONTS: [&str; 5] = ["inter", "dm-sans", "fraunces", "lora", "system"];
pub(crate) const LOCALES: [&str; 4] = ["en", "nl", "de", "fr"];

pub(crate) const MAX_DOCUMENT_BYTES: usize = 512 * 1024;
const MAX_SECTIONS: usize = 40;
const MAX_ID: usize = 40;
const TEXT_LENGTH: usize = 2000;
const RICH_TEXT_LENGTH: usize = 20_000;
const MAX_MENU_ITEMS: usize = 100;
const MAX_PICKS: usize = 24;

/// What is wrong, as `(path, message)` pairs: the API's `details.fields`.
#[derive(Debug, Default)]
pub(crate) struct Problems(pub(crate) Vec<(String, String)>);

impl Problems {
    pub(crate) fn add(&mut self, path: impl Into<String>, message: impl Into<String>) {
        if self.0.len() < 100 {
            self.0.push((path.into(), message.into()));
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// `[a-z0-9_-]{1,40}`.
pub(crate) fn is_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// A page slug or menu handle: lower-case words joined by single hyphens.
pub(crate) fn is_slug(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A link a shop may carry: a path of this shop (`/products`, never
/// `//host`), or an `https:`, `http:`, `mailto:` or `tel:` URL. Never
/// `javascript:` or `data:`.
pub(crate) fn is_safe_link(value: &str) -> bool {
    if value.len() > 2000 || value.chars().any(char::is_control) {
        return false;
    }
    if let Some(rest) = value.strip_prefix('/') {
        return !rest.starts_with('/') && !rest.starts_with('\\');
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("mailto:") || lower.starts_with("tel:") {
        return true;
    }
    url::Url::parse(value).is_ok_and(|url| {
        matches!(url.scheme(), "https" | "http") && url.host_str().is_some_and(|h| !h.is_empty())
    })
}

/// An image or other asset: a path of this install or an `https:` URL.
fn is_safe_asset(value: &str) -> bool {
    if value.len() > 2000 || value.chars().any(char::is_control) {
        return false;
    }
    if let Some(rest) = value.strip_prefix('/') {
        return !rest.starts_with('/') && !rest.starts_with('\\');
    }
    url::Url::parse(value)
        .is_ok_and(|url| url.scheme() == "https" && url.host_str().is_some_and(|h| !h.is_empty()))
}

/// `#rrggbb`.
pub(crate) fn is_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn sections_catalog() -> Option<&'static Map<String, Value>> {
    CATALOG["sections"].as_object()
}

/// The catalog loaded (it is compiled in; a broken export fails tests).
#[cfg(test)]
pub(crate) fn catalog_loaded() -> bool {
    sections_catalog().is_some_and(|sections| !sections.is_empty())
}

fn text_limit(setting: &Value, fallback: usize) -> usize {
    setting["maxLength"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(fallback)
}

/// One setting's value against its definition.
fn check_setting(definition: &Value, value: &Value, path: &str, problems: &mut Problems) {
    if value.is_null() {
        return;
    }
    let kind = definition["type"].as_str().unwrap_or_default();
    let string = || value.as_str();
    match kind {
        "text" | "textarea" => match string() {
            Some(text) if text.chars().count() <= text_limit(definition, TEXT_LENGTH) => {}
            Some(_) => problems.add(
                path,
                format!("At most {} characters", text_limit(definition, TEXT_LENGTH)),
            ),
            None => problems.add(path, "Must be text"),
        },
        "richtext" => match string() {
            Some(text) if text.chars().count() <= text_limit(definition, RICH_TEXT_LENGTH) => {}
            Some(_) => problems.add(
                path,
                format!(
                    "At most {} characters",
                    text_limit(definition, RICH_TEXT_LENGTH)
                ),
            ),
            None => problems.add(path, "Must be text"),
        },
        "url" => match string() {
            Some(text) if text.is_empty() || is_safe_link(text) => {}
            Some(_) => problems.add(
                path,
                "Must be a path of this shop (/…) or an https:// address",
            ),
            None => problems.add(path, "Must be text"),
        },
        "image" => match string() {
            Some(text) if text.is_empty() || is_safe_asset(text) => {}
            Some(_) => problems.add(path, "Must be an https:// address"),
            None => problems.add(path, "Must be text"),
        },
        "video" => match string() {
            Some(text) if text.is_empty() || (is_safe_asset(text) && !text.starts_with('/')) => {}
            Some(_) => problems.add(path, "Must be an https:// address"),
            None => problems.add(path, "Must be text"),
        },
        "select" => {
            let options: Vec<&str> = definition["options"]
                .as_array()
                .map(|options| options.iter().filter_map(|o| o["value"].as_str()).collect())
                .unwrap_or_default();
            if !string().is_some_and(|v| options.contains(&v)) {
                problems.add(path, format!("Must be one of: {}", options.join(", ")));
            }
        }
        "checkbox" => {
            if !value.is_boolean() {
                problems.add(path, "Must be true or false");
            }
        }
        "number" => match value.as_f64() {
            Some(number) => {
                if definition["min"].as_f64().is_some_and(|min| number < min)
                    || definition["max"].as_f64().is_some_and(|max| number > max)
                {
                    problems.add(
                        path,
                        format!(
                            "Must be between {} and {}",
                            definition["min"], definition["max"]
                        ),
                    );
                }
            }
            None => problems.add(path, "Must be a number"),
        },
        "color" => match string() {
            Some(text) if text.is_empty() || is_color(text) => {}
            _ => problems.add(path, "Must be a colour like #1a2b3c"),
        },
        "menu" => match string() {
            Some(text) if text.is_empty() || is_slug(text, MAX_ID) => {}
            _ => problems.add(path, "Must be a menu handle"),
        },
        "category" | "product" | "page" | "form" => match string() {
            Some(text) if text.len() <= 100 => {}
            _ => problems.add(path, "Must be an id"),
        },
        "categories" | "products" => match value.as_array() {
            Some(items)
                if items.len() <= MAX_PICKS
                    && items
                        .iter()
                        .all(|i| i.as_str().is_some_and(|s| s.len() <= 100)) => {}
            _ => problems.add(path, format!("Must be a list of at most {MAX_PICKS} ids")),
        },
        other => problems.add(path, format!("Unknown setting type {other}")),
    }
}

/// A `settings` object against its definitions: known ids, valid values.
fn check_settings(definitions: &Value, settings: &Value, path: &str, problems: &mut Problems) {
    let Some(settings) = settings.as_object() else {
        problems.add(path, "Must be an object");
        return;
    };
    let definitions = definitions
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    for (id, value) in settings {
        match definitions.iter().find(|d| d["id"] == id.as_str()) {
            Some(definition) => check_setting(definition, value, &format!("{path}.{id}"), problems),
            None => problems.add(format!("{path}.{id}"), "Unknown setting"),
        }
    }
}

/// A list of sections for the list `list` (a template, a group, or
/// `content` for a page's own sections).
pub(crate) fn check_sections(list: &str, sections: &Value, path: &str, problems: &mut Problems) {
    let Some(catalog) = sections_catalog() else {
        problems.add(path, "The section catalog is missing");
        return;
    };
    let Some(sections) = sections.as_array() else {
        problems.add(path, "Must be a list of sections");
        return;
    };
    if sections.len() > MAX_SECTIONS {
        problems.add(path, format!("At most {MAX_SECTIONS} sections"));
        return;
    }
    let mut ids = HashSet::new();
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for (index, section) in sections.iter().enumerate() {
        let here = format!("{path}[{index}]");
        let Some(object) = section.as_object() else {
            problems.add(here, "Must be a section");
            continue;
        };
        for key in object.keys() {
            if !matches!(
                key.as_str(),
                "id" | "type" | "hidden" | "settings" | "blocks"
            ) {
                problems.add(format!("{here}.{key}"), "Unknown field");
            }
        }
        match object.get("id").and_then(Value::as_str) {
            Some(id) if is_id(id) => {
                if !ids.insert(id.to_owned()) {
                    problems.add(format!("{here}.id"), "Used twice in this list");
                }
            }
            _ => problems.add(format!("{here}.id"), "Must be 1–40 of a-z, 0-9, _ and -"),
        }
        if object.get("hidden").is_some_and(|h| !h.is_boolean()) {
            problems.add(format!("{here}.hidden"), "Must be true or false");
        }
        let Some(kind) = object.get("type").and_then(Value::as_str) else {
            problems.add(format!("{here}.type"), "Must be a section type");
            continue;
        };
        let Some(definition) = catalog.get(kind) else {
            problems.add(
                format!("{here}.type"),
                format!("Unknown section type {kind}"),
            );
            continue;
        };
        let allowed = definition["where"]
            .as_array()
            .is_some_and(|lists| lists.iter().any(|l| l == list));
        if !allowed {
            problems.add(format!("{here}.type"), format!("{kind} can't be used here"));
            continue;
        }
        *counts.entry(kind).or_default() += 1;
        check_settings(
            &definition["settings"],
            object.get("settings").unwrap_or(&Value::Object(Map::new())),
            &format!("{here}.settings"),
            problems,
        );
        check_blocks(definition, object.get("blocks"), &here, problems);
    }
    for (kind, definition) in catalog {
        let count = counts.get(kind.as_str()).copied().unwrap_or_default();
        let required = definition["required"]
            .as_array()
            .is_some_and(|lists| lists.iter().any(|l| l == list));
        if required && count != 1 {
            problems.add(path, format!("Needs exactly one {kind} section"));
        }
        if let Some(limit) = definition["limit"].as_u64()
            && u64::try_from(count).unwrap_or(u64::MAX) > limit
        {
            problems.add(path, format!("At most {limit} {kind} section(s)"));
        }
    }
}

fn check_blocks(definition: &Value, blocks: Option<&Value>, here: &str, problems: &mut Problems) {
    let Some(blocks) = blocks else {
        return;
    };
    let path = format!("{here}.blocks");
    let Some(blocks) = blocks.as_array() else {
        problems.add(path, "Must be a list of blocks");
        return;
    };
    let max = definition["maxBlocks"].as_u64().unwrap_or_default();
    if u64::try_from(blocks.len()).unwrap_or(u64::MAX) > max {
        problems.add(&path, format!("At most {max} blocks"));
        return;
    }
    let mut ids = HashSet::new();
    for (index, block) in blocks.iter().enumerate() {
        let at = format!("{path}[{index}]");
        let Some(object) = block.as_object() else {
            problems.add(at, "Must be a block");
            continue;
        };
        match object.get("id").and_then(Value::as_str) {
            Some(id) if is_id(id) => {
                if !ids.insert(id.to_owned()) {
                    problems.add(format!("{at}.id"), "Used twice in this section");
                }
            }
            _ => problems.add(format!("{at}.id"), "Must be 1–40 of a-z, 0-9, _ and -"),
        }
        let kind = object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(block_definition) = definition["blocks"].get(kind) else {
            problems.add(format!("{at}.type"), format!("Unknown block type {kind}"));
            continue;
        };
        check_settings(
            &block_definition["settings"],
            object.get("settings").unwrap_or(&Value::Object(Map::new())),
            &format!("{at}.settings"),
            problems,
        );
    }
}

fn text_at(
    object: &Map<String, Value>,
    key: &str,
    max: usize,
    path: &str,
    problems: &mut Problems,
) {
    match object.get(key) {
        None | Some(Value::Null) => {}
        Some(Value::String(text)) if text.chars().count() <= max => {}
        Some(Value::String(_)) => {
            problems.add(format!("{path}.{key}"), format!("At most {max} characters"));
        }
        Some(_) => problems.add(format!("{path}.{key}"), "Must be text"),
    }
}

fn asset_at(object: &Map<String, Value>, key: &str, path: &str, problems: &mut Problems) {
    match object.get(key) {
        None | Some(Value::Null) => {}
        Some(Value::String(text)) if text.is_empty() || is_safe_asset(text) => {}
        Some(_) => problems.add(format!("{path}.{key}"), "Must be an https:// address"),
    }
}

fn check_theme(theme: &Value, problems: &mut Problems) {
    let Some(theme) = theme.as_object() else {
        problems.add("theme", "Must be an object");
        return;
    };
    if !theme
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| THEMES.contains(&id))
    {
        problems.add("theme.id", format!("Must be one of: {}", THEMES.join(", ")));
    }
    let Some(settings) = theme.get("settings").and_then(Value::as_object) else {
        problems.add("theme.settings", "Must be an object");
        return;
    };
    text_at(settings, "preset", 40, "theme.settings", problems);
    match settings.get("colors").and_then(Value::as_object) {
        Some(colors) => {
            for key in [
                "background",
                "foreground",
                "primary",
                "primaryForeground",
                "muted",
                "border",
            ] {
                if !colors
                    .get(key)
                    .and_then(Value::as_str)
                    .is_some_and(is_color)
                {
                    problems.add(
                        format!("theme.settings.colors.{key}"),
                        "Must be a colour like #1a2b3c",
                    );
                }
            }
        }
        None => problems.add("theme.settings.colors", "Must be an object"),
    }
    for key in ["fontHeading", "fontBody"] {
        if !settings
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|font| FONTS.contains(&font))
        {
            problems.add(
                format!("theme.settings.{key}"),
                format!("Must be one of: {}", FONTS.join(", ")),
            );
        }
    }
    if !settings
        .get("radius")
        .and_then(Value::as_str)
        .is_some_and(|r| matches!(r, "none" | "small" | "medium" | "large"))
    {
        problems.add(
            "theme.settings.radius",
            "Must be none, small, medium or large",
        );
    }
    asset_at(settings, "logoUrl", "theme.settings", problems);
    asset_at(settings, "faviconUrl", "theme.settings", problems);
    text_at(settings, "logoAlt", 200, "theme.settings", problems);
    if let Some(social) = settings.get("social") {
        match social.as_object() {
            Some(social) => {
                for (key, value) in social {
                    let ok = matches!(
                        key.as_str(),
                        "instagram"
                            | "facebook"
                            | "x"
                            | "linkedin"
                            | "tiktok"
                            | "youtube"
                            | "pinterest"
                    ) && (value.is_null()
                        || value.as_str().is_some_and(|v| {
                            v.is_empty() || (is_safe_asset(v) && !v.starts_with('/'))
                        }));
                    if !ok {
                        problems.add(
                            format!("theme.settings.social.{key}"),
                            "Must be an https:// address of a known network",
                        );
                    }
                }
            }
            None => problems.add("theme.settings.social", "Must be an object"),
        }
    }
}

fn check_site_settings(document: &Map<String, Value>, problems: &mut Problems) {
    match document.get("seo").and_then(Value::as_object) {
        Some(seo) => {
            text_at(seo, "title", 200, "seo", problems);
            text_at(seo, "description", 500, "seo", problems);
            asset_at(seo, "imageUrl", "seo", problems);
        }
        None => problems.add("seo", "Must be an object"),
    }
    let Some(settings) = document.get("settings").and_then(Value::as_object) else {
        problems.add("settings", "Must be an object");
        return;
    };
    if !settings
        .get("access")
        .and_then(Value::as_str)
        .is_some_and(|a| matches!(a, "public" | "prices_signed_in" | "signed_in"))
    {
        problems.add(
            "settings.access",
            "Must be public, prices_signed_in or signed_in",
        );
    }
    if !settings.get("cookieBanner").is_some_and(Value::is_boolean) {
        problems.add("settings.cookieBanner", "Must be true or false");
    }
    if let Some(analytics) = settings.get("analytics").filter(|a| !a.is_null()) {
        match analytics.as_object() {
            Some(analytics) => {
                text_at(
                    analytics,
                    "weldpanelProjectKey",
                    100,
                    "settings.analytics",
                    problems,
                );
                asset_at(analytics, "collectorUrl", "settings.analytics", problems);
            }
            None => problems.add("settings.analytics", "Must be an object"),
        }
    }
}

/// A whole site document (a draft).
pub(crate) fn check_document(document: &Value) -> Problems {
    let mut problems = Problems::default();
    if serde_json::to_vec(document).map_or(usize::MAX, |bytes| bytes.len()) > MAX_DOCUMENT_BYTES {
        problems.add("document", "The site is too large (at most 512 KiB)");
        return problems;
    }
    let Some(object) = document.as_object() else {
        problems.add("document", "Must be an object");
        return problems;
    };
    for key in object.keys() {
        if !matches!(
            key.as_str(),
            "schemaVersion" | "theme" | "templates" | "groups" | "seo" | "settings"
        ) {
            problems.add(key.clone(), "Unknown field");
        }
    }
    if object.get("schemaVersion").and_then(Value::as_i64) != Some(1) {
        problems.add("schemaVersion", "Must be 1");
    }
    check_theme(object.get("theme").unwrap_or(&Value::Null), &mut problems);
    for (field, names) in [("templates", &TEMPLATES[..]), ("groups", &GROUPS[..])] {
        match object.get(field).and_then(Value::as_object) {
            Some(lists) => {
                for key in lists.keys() {
                    if !names.contains(&key.as_str()) {
                        problems.add(format!("{field}.{key}"), "Unknown list");
                    }
                }
                for name in names {
                    check_sections(
                        name,
                        lists.get(*name).unwrap_or(&Value::Null),
                        &format!("{field}.{name}"),
                        &mut problems,
                    );
                }
            }
            None => problems.add(field, "Must be an object"),
        }
    }
    check_site_settings(object, &mut problems);
    problems
}

fn check_link(link: &Value, path: &str, problems: &mut Problems) {
    let kind = link["type"].as_str().unwrap_or_default();
    match kind {
        "home" | "cart" | "account" | "search" | "catalog" => {}
        "category" | "product" | "page" => {
            if !link["id"]
                .as_str()
                .is_some_and(|id| !id.is_empty() && id.len() <= 100)
            {
                problems.add(format!("{path}.id"), "Must be an id");
            }
        }
        "url" => {
            if !link["url"].as_str().is_some_and(is_safe_link) {
                problems.add(
                    format!("{path}.url"),
                    "Must be a path of this shop (/…) or an https:// address",
                );
            }
        }
        _ => problems.add(format!("{path}.type"), "Unknown link type"),
    }
}

/// A menu's items: at most two levels and 100 items.
pub(crate) fn check_menu_items(items: &Value, problems: &mut Problems) {
    fn walk(
        items: &Value,
        path: &str,
        depth: usize,
        count: &mut usize,
        ids: &mut HashSet<String>,
        problems: &mut Problems,
    ) {
        let Some(items) = items.as_array() else {
            problems.add(path, "Must be a list");
            return;
        };
        for (index, item) in items.iter().enumerate() {
            *count += 1;
            let at = format!("{path}[{index}]");
            match item["id"].as_str() {
                Some(id) if is_id(id) => {
                    if !ids.insert(id.to_owned()) {
                        problems.add(format!("{at}.id"), "Used twice in this menu");
                    }
                }
                _ => problems.add(format!("{at}.id"), "Must be 1–40 of a-z, 0-9, _ and -"),
            }
            if !item["label"]
                .as_str()
                .is_some_and(|l| !l.trim().is_empty() && l.chars().count() <= 100)
            {
                problems.add(format!("{at}.label"), "Must be 1–100 characters");
            }
            check_link(&item["link"], &format!("{at}.link"), problems);
            if let Some(children) = item.get("children").filter(|c| !c.is_null()) {
                if depth >= 2 {
                    problems.add(format!("{at}.children"), "Menus go two levels deep at most");
                } else {
                    walk(
                        children,
                        &format!("{at}.children"),
                        depth + 1,
                        count,
                        ids,
                        problems,
                    );
                }
            }
        }
    }
    let mut count = 0;
    walk(items, "items", 1, &mut count, &mut HashSet::new(), problems);
    if count > MAX_MENU_ITEMS {
        problems.add("items", format!("At most {MAX_MENU_ITEMS} items"));
    }
}

/// A redirect's source: a path of the shop.
pub(crate) fn is_redirect_source(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && path.len() <= 500
        && !path.starts_with("/__")
        && !path.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// A redirect's target: a path of the shop or an `https:` address.
pub(crate) fn is_redirect_target(target: &str) -> bool {
    target.len() <= 1000
        && !target.starts_with("mailto:")
        && !target.starts_with("tel:")
        && is_safe_link(target)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn document() -> Value {
        let section = |id: &str, kind: &str| json!({ "id": id, "type": kind, "settings": {} });
        json!({
            "schemaVersion": 1,
            "theme": { "id": "atelier", "settings": {
                "preset": "classic",
                "colors": { "background": "#ffffff", "foreground": "#111827", "primary": "#111827",
                            "primaryForeground": "#ffffff", "muted": "#f3f4f6", "border": "#e5e7eb" },
                "fontHeading": "inter", "fontBody": "inter", "radius": "small",
                "logoUrl": null, "logoAlt": null, "faviconUrl": null, "social": {}
            } },
            "groups": { "header": [section("header", "header")], "footer": [section("footer", "footer")] },
            "templates": {
                "home": [section("hero", "hero")],
                "product": [section("main", "main-product")],
                "category": [section("main", "main-category")],
                "search": [section("main", "main-search")],
                "cart": [section("main", "main-cart")],
                "page": [section("main", "main-page")],
                "notFound": [section("main", "main-not-found")]
            },
            "seo": {},
            "settings": { "access": "public", "cookieBanner": false }
        })
    }

    fn fields(problems: &Problems) -> Vec<String> {
        problems.0.iter().map(|(path, _)| path.clone()).collect()
    }

    #[test]
    fn the_catalog_is_compiled_in() {
        assert!(catalog_loaded());
    }

    #[test]
    fn a_minimal_document_is_valid() {
        let problems = check_document(&document());
        assert!(problems.is_empty(), "{:?}", problems.0);
    }

    #[test]
    fn main_sections_are_required_once_and_stay_in_their_template() {
        let mut doc = document();
        doc["templates"]["product"] = json!([]);
        doc["templates"]["home"] = json!([{ "id": "x", "type": "main-product", "settings": {} }]);
        let paths = fields(&check_document(&doc));
        assert!(paths.contains(&"templates.product".to_owned()), "{paths:?}");
        assert!(
            paths.contains(&"templates.home[0].type".to_owned()),
            "{paths:?}"
        );
    }

    #[test]
    fn settings_are_typed_and_links_are_safe() {
        let mut doc = document();
        doc["templates"]["home"] = json!([{ "id": "hero", "type": "hero", "settings": {
            "buttonLink": "javascript:alert(1)",
            "height": "huge",
            "overlay": 95,
            "heading": 3,
            "nope": true
        } }]);
        let paths = fields(&check_document(&doc));
        for path in [
            "templates.home[0].settings.buttonLink",
            "templates.home[0].settings.height",
            "templates.home[0].settings.overlay",
            "templates.home[0].settings.heading",
            "templates.home[0].settings.nope",
        ] {
            assert!(paths.contains(&path.to_owned()), "{path} in {paths:?}");
        }
    }

    #[test]
    fn duplicate_ids_and_unknown_types_are_refused() {
        let mut doc = document();
        doc["templates"]["home"] = json!([
            { "id": "a", "type": "hero", "settings": {} },
            { "id": "a", "type": "rich-text", "settings": {} },
            { "id": "b", "type": "carousel-3000", "settings": {} }
        ]);
        let paths = fields(&check_document(&doc));
        assert!(
            paths.contains(&"templates.home[1].id".to_owned()),
            "{paths:?}"
        );
        assert!(
            paths.contains(&"templates.home[2].type".to_owned()),
            "{paths:?}"
        );
    }

    #[test]
    fn blocks_are_checked() {
        let mut doc = document();
        doc["templates"]["home"] = json!([{ "id": "faq", "type": "faq", "settings": {}, "blocks": [
            { "id": "q1", "type": "item", "settings": { "question": "Why?" } },
            { "id": "q2", "type": "slide", "settings": {} }
        ] }]);
        let paths = fields(&check_document(&doc));
        assert_eq!(paths, vec!["templates.home[0].blocks[1].type".to_owned()]);
    }

    #[test]
    fn links() {
        for good in [
            "/products",
            "https://example.com/a",
            "mailto:hi@example.com",
            "tel:+31200000000",
        ] {
            assert!(is_safe_link(good), "{good}");
        }
        for bad in [
            "//evil.test",
            "javascript:alert(1)",
            "data:text/html,x",
            "/\\evil",
            "ftp://x.test",
        ] {
            assert!(!is_safe_link(bad), "{bad}");
        }
        assert!(is_redirect_source("/old-shop/item?id=1"));
        assert!(!is_redirect_source("/__preview"));
        assert!(!is_redirect_target("mailto:x@y.z"));
    }

    #[test]
    fn menus() {
        let mut problems = Problems::default();
        check_menu_items(
            &json!([
                { "id": "a", "label": "Shop", "link": { "type": "catalog" }, "children": [
                    { "id": "b", "label": "Shoes", "link": { "type": "category", "id": "cat_1" }, "children": [
                        { "id": "c", "label": "Too deep", "link": { "type": "home" } }
                    ] }
                ] },
                { "id": "d", "label": "", "link": { "type": "url", "url": "javascript:x" } }
            ]),
            &mut problems,
        );
        let paths = fields(&problems);
        assert!(
            paths.contains(&"items[0].children[0].children".to_owned()),
            "{paths:?}"
        );
        assert!(paths.contains(&"items[1].label".to_owned()), "{paths:?}");
        assert!(paths.contains(&"items[1].link.url".to_owned()), "{paths:?}");
    }

    #[test]
    fn slugs() {
        assert!(is_slug("terms-and-conditions", 120));
        assert!(!is_slug("Terms", 120));
        assert!(!is_slug("a--b", 120));
        assert!(!is_slug("-a", 120));
    }
}
