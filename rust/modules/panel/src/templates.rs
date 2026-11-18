//! The built-in dashboards (`services/dashboard-templates.ts`):
//! `GET /dashboards/templates` lists them and `POST /dashboards/from-template`
//! creates the dashboard with a new report per report tile. Names and texts
//! come in English and Dutch, picked by the request's locale.
//!
//! A template report may list more than one spec: the first the query schema
//! accepts is used, so a template can prefer a richer report kind and still
//! work where the schema does not have it.

use serde_json::{Map, Value, json};

use crate::saved::report_spec;

/// `PANEL_TEMPLATE_LOCALES`.
pub(crate) const LOCALES: &[&str] = &["en", "nl"];

/// A text in English and Dutch.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Localized {
    en: &'static str,
    nl: &'static str,
}

impl Localized {
    pub(crate) fn get(&self, locale: &str) -> &'static str {
        if locale == "nl" { self.nl } else { self.en }
    }
}

const fn texts(en: &'static str, nl: &'static str) -> Localized {
    Localized { en, nl }
}

/// A tile's place on the grid.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Layout {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

impl Layout {
    pub(crate) fn to_json(self) -> Value {
        json!({ "x": self.x, "y": self.y, "w": self.w, "h": self.h })
    }
}

const fn layout(x: u32, y: u32, w: u32, h: u32) -> Layout {
    Layout { x, y, w, h }
}

/// A template report: its name and its specs (without the project), in
/// order of preference.
#[derive(Debug, Clone)]
pub(crate) struct TemplateReport {
    pub(crate) name: Localized,
    specs: Vec<Value>,
}

/// A template's tile.
#[derive(Debug, Clone)]
pub(crate) enum TemplateTile {
    Report {
        report: TemplateReport,
        layout: Layout,
    },
    Text {
        text: Localized,
        layout: Layout,
    },
}

/// `DashboardTemplate`.
#[derive(Debug, Clone)]
pub(crate) struct Template {
    pub(crate) id: &'static str,
    pub(crate) name: Localized,
    pub(crate) description: Localized,
    pub(crate) tiles: Vec<TemplateTile>,
}

const PAGEVIEW: &str = "$pageview";

fn range30() -> Value {
    json!({ "preset": "30d" })
}

fn range90() -> Value {
    json!({ "preset": "90d" })
}

/// `trends(series, extra)`.
fn trends(series: Value, extra: Value) -> Value {
    let mut spec = json!({ "kind": "trends", "dateRange": range30(), "interval": "day" });
    spec["series"] = series;
    if let (Some(spec), Value::Object(extra)) = (spec.as_object_mut(), extra) {
        spec.extend(extra);
    }
    spec
}

/// `byColumn(field, display, limit)`.
fn by_column(field: &str, display: &str) -> Value {
    trends(
        json!([{ "event": PAGEVIEW, "math": "unique_users", "label": "Visitors" }]),
        json!({ "breakdown": { "source": "column", "field": field, "limit": 10 }, "display": display }),
    )
}

/// `vital(metric, label)`: the p75 from the `vitals` kind, else the average
/// of the `$webvitals` events.
fn vital(metric: &str, label: &str) -> Vec<Value> {
    vec![
        json!({ "kind": "vitals", "dateRange": range30(), "metric": metric, "percentile": "p75", "interval": "day" }),
        trends(
            json!([{ "event": "$webvitals", "math": "avg", "property": format!("${metric}"), "label": label }]),
            json!({ "display": "line" }),
        ),
    ]
}

fn report(name: Localized, specs: Vec<Value>, at: Layout) -> TemplateTile {
    TemplateTile::Report {
        report: TemplateReport { name, specs },
        layout: at,
    }
}

fn text_tile(text: Localized, at: Layout) -> TemplateTile {
    TemplateTile::Text { text, layout: at }
}

fn website_overview() -> Template {
    Template {
        id: "website-overview",
        name: texts("Website overview", "Website-overzicht"),
        description: texts(
            "Visitors, pageviews, top pages, sources and the paths people take through the site.",
            "Bezoekers, paginaweergaven, toppagina\u{2019}s, bronnen en de routes die mensen over de site nemen.",
        ),
        tiles: vec![
            text_tile(
                texts(
                    "## Website overview\nThe last 30 days compared with the 30 before. Change the period with the dashboard filters.",
                    "## Website-overzicht\nDe afgelopen 30 dagen vergeleken met de 30 daarvoor. Kies een andere periode met de dashboardfilters.",
                ),
                layout(0, 0, 24, 2),
            ),
            report(
                texts("Web analytics", "Webanalyse"),
                vec![
                    json!({ "kind": "web", "dateRange": range30(), "compare": true, "limit": 10 }),
                ],
                layout(0, 2, 24, 10),
            ),
            report(
                texts("Visitors and pageviews", "Bezoekers en paginaweergaven"),
                vec![trends(
                    json!([
                        { "event": PAGEVIEW, "math": "unique_users", "label": "Visitors" },
                        { "event": PAGEVIEW, "math": "total", "label": "Pageviews" }
                    ]),
                    json!({ "display": "line", "compare": true }),
                )],
                layout(0, 12, 12, 6),
            ),
            report(
                texts("Visits", "Bezoeken"),
                vec![trends(
                    json!([{ "event": PAGEVIEW, "math": "sessions", "label": "Visits" }]),
                    json!({ "display": "line", "compare": true }),
                )],
                layout(12, 12, 12, 6),
            ),
            report(
                texts("Paths from the first page", "Routes vanaf de eerste pagina"),
                vec![json!({
                    "kind": "flows", "dateRange": range30(), "anchor": { "event": PAGEVIEW },
                    "direction": "after", "depth": 3, "scope": "pageviews", "limit": 20
                })],
                layout(0, 18, 24, 8),
            ),
        ],
    }
}

fn acquisition() -> Template {
    Template {
        id: "acquisition",
        name: texts("Acquisition", "Acquisitie"),
        description: texts(
            "Where visitors come from: referrers, campaigns and countries.",
            "Waar bezoekers vandaan komen: verwijzers, campagnes en landen.",
        ),
        tiles: vec![
            text_tile(
                texts(
                    "## Acquisition\nUnique visitors per source over the last 30 days. Tag links with `utm_source`, `utm_medium` and `utm_campaign` to see campaigns here.",
                    "## Acquisitie\nUnieke bezoekers per bron over de afgelopen 30 dagen. Voorzie links van `utm_source`, `utm_medium` en `utm_campaign` om campagnes hier te zien.",
                ),
                layout(0, 0, 24, 2),
            ),
            report(
                texts("Visitors by referrer", "Bezoekers per verwijzer"),
                vec![by_column("referrer_host", "bar")],
                layout(0, 2, 12, 7),
            ),
            report(
                texts("Visitors by UTM source", "Bezoekers per UTM-bron"),
                vec![by_column("utm_source", "bar")],
                layout(12, 2, 12, 7),
            ),
            report(
                texts("Visitors by campaign", "Bezoekers per campagne"),
                vec![by_column("utm_campaign", "table")],
                layout(0, 9, 12, 7),
            ),
            report(
                texts("Visitors by country", "Bezoekers per land"),
                vec![by_column("country", "table")],
                layout(12, 9, 12, 7),
            ),
        ],
    }
}

fn product_health() -> Template {
    Template {
        id: "product-health",
        name: texts("Product health", "Productgezondheid"),
        description: texts(
            "Daily and weekly active users, retention, errors and frustration.",
            "Dagelijks en wekelijks actieve gebruikers, retentie, fouten en frustratie.",
        ),
        tiles: vec![
            report(
                texts("Daily active users", "Dagelijks actieve gebruikers"),
                vec![trends(
                    json!([{ "event": PAGEVIEW, "math": "unique_users", "label": "DAU" }]),
                    json!({ "display": "line" }),
                )],
                layout(0, 0, 12, 6),
            ),
            report(
                texts("Weekly active users", "Wekelijks actieve gebruikers"),
                vec![json!({
                    "kind": "trends", "dateRange": range90(), "interval": "week",
                    "series": [{ "event": PAGEVIEW, "math": "unique_users", "label": "WAU" }],
                    "display": "line"
                })],
                layout(12, 0, 12, 6),
            ),
            report(
                texts("Weekly retention", "Wekelijkse retentie"),
                vec![json!({
                    "kind": "retention", "dateRange": range90(), "firstEvent": PAGEVIEW,
                    "interval": "week", "periods": 8
                })],
                layout(0, 6, 24, 8),
            ),
            report(
                texts("Errors", "Fouten"),
                vec![trends(
                    json!([{ "event": "$exception", "math": "total", "label": "Errors" }]),
                    json!({ "display": "bar" }),
                )],
                layout(0, 14, 12, 6),
            ),
            report(
                texts("Rage and dead clicks", "Woedende en dode klikken"),
                vec![trends(
                    json!([
                        { "event": "$rageclick", "math": "total", "label": "Rage clicks" },
                        { "event": "$deadclick", "math": "total", "label": "Dead clicks" }
                    ]),
                    json!({ "display": "line" }),
                )],
                layout(12, 14, 12, 6),
            ),
        ],
    }
}

fn performance() -> Template {
    Template {
        id: "performance",
        name: texts("Performance", "Prestaties"),
        description: texts(
            "Core Web Vitals from real visits: loading (LCP), responsiveness (INP) and visual stability (CLS).",
            "Core Web Vitals van echte bezoeken: laden (LCP), reactiesnelheid (INP) en visuele stabiliteit (CLS).",
        ),
        tiles: vec![
            text_tile(
                texts(
                    "## Performance\nGood is LCP under 2.5 s, INP under 200 ms and CLS under 0.1. Measured on real visits by the WeldPanel script.",
                    "## Prestaties\nGoed is een LCP onder 2,5 s, een INP onder 200 ms en een CLS onder 0,1. Gemeten bij echte bezoeken door het WeldPanel-script.",
                ),
                layout(0, 0, 24, 2),
            ),
            report(
                texts("Largest Contentful Paint", "Largest Contentful Paint"),
                vital("lcp", "LCP (ms)"),
                layout(0, 2, 12, 6),
            ),
            report(
                texts("Interaction to Next Paint", "Interaction to Next Paint"),
                vital("inp", "INP (ms)"),
                layout(12, 2, 12, 6),
            ),
            report(
                texts("Cumulative Layout Shift", "Cumulative Layout Shift"),
                vital("cls", "CLS"),
                layout(0, 8, 12, 6),
            ),
            report(
                texts("Time to First Byte", "Time to First Byte"),
                vital("ttfb", "TTFB (ms)"),
                layout(12, 8, 12, 6),
            ),
        ],
    }
}

fn engagement() -> Template {
    Template {
        id: "engagement",
        name: texts("Engagement", "Betrokkenheid"),
        description: texts(
            "How often people come back: stickiness, the lifecycle of users and retention.",
            "Hoe vaak mensen terugkomen: terugkeerfrequentie, de levenscyclus van gebruikers en retentie.",
        ),
        tiles: vec![
            report(
                texts("Stickiness", "Terugkeerfrequentie"),
                vec![
                    json!({
                        "kind": "stickiness", "dateRange": range30(), "event": PAGEVIEW,
                        "interval": "day", "measure": "intervals"
                    }),
                    trends(
                        json!([{ "event": PAGEVIEW, "math": "avg_per_user", "label": "Pageviews per user" }]),
                        json!({ "display": "line" }),
                    ),
                ],
                layout(0, 0, 12, 7),
            ),
            report(
                texts("User lifecycle", "Levenscyclus van gebruikers"),
                vec![
                    json!({ "kind": "lifecycle", "dateRange": range90(), "event": PAGEVIEW, "interval": "week" }),
                    json!({
                        "kind": "trends", "dateRange": range90(), "interval": "week",
                        "series": [{ "event": PAGEVIEW, "math": "unique_users", "label": "Weekly users" }],
                        "display": "bar"
                    }),
                ],
                layout(12, 0, 12, 7),
            ),
            report(
                texts("Retention", "Retentie"),
                vec![json!({
                    "kind": "retention", "dateRange": range90(), "firstEvent": PAGEVIEW,
                    "interval": "week", "periods": 8
                })],
                layout(0, 7, 24, 8),
            ),
        ],
    }
}

/// `DASHBOARD_TEMPLATES`, in their order.
pub(crate) fn templates() -> Vec<Template> {
    vec![
        website_overview(),
        acquisition(),
        product_health(),
        performance(),
        engagement(),
    ]
}

/// `findTemplate(id)`.
pub(crate) fn find_template(id: &str) -> Option<Template> {
    templates().into_iter().find(|template| template.id == id)
}

/// `templateLocale(explicit, acceptLanguage)`: the locale asked for, else
/// the first of `Accept-Language` there is a text for, else English.
pub(crate) fn template_locale(
    explicit: Option<&str>,
    accept_language: Option<&str>,
) -> &'static str {
    if let Some(explicit) = explicit
        && let Some(locale) = LOCALES.iter().find(|locale| **locale == explicit)
    {
        return locale;
    }
    for part in accept_language.unwrap_or_default().split(',') {
        let base = part
            .split(';')
            .next()
            .map(weldsuite_panel_domain::js::trim)
            .unwrap_or_default()
            .to_lowercase();
        let base = base.split('-').next().unwrap_or_default();
        if let Some(locale) = LOCALES.iter().find(|locale| **locale == base) {
            return locale;
        }
    }
    "en"
}

/// `templateReportSpec(report, projectId)`: the first of the report's specs
/// the query schema accepts, parsed; `None` when none does.
pub(crate) fn template_report_spec(
    report: &TemplateReport,
    project_id: &str,
) -> Option<Map<String, Value>> {
    report.specs.iter().find_map(|spec| {
        let mut spec = spec.clone();
        if let Some(object) = spec.as_object_mut() {
            object.insert("projectId".to_owned(), Value::String(project_id.to_owned()));
        }
        report_spec(&spec)
    })
}

/// `toTemplateDto(template, locale)`.
pub(crate) fn template_dto(template: &Template, locale: &str) -> Value {
    let tiles: Vec<Value> = template
        .tiles
        .iter()
        .map(|tile| match tile {
            TemplateTile::Text { text, layout } => json!({
                "kind": "text",
                "reportName": null,
                "reportKind": null,
                "text": text.get(locale),
                "layout": layout.to_json(),
            }),
            TemplateTile::Report { report, layout } => {
                let kind = template_report_spec(report, "pnp_template")
                    .and_then(|spec| spec.get("kind").cloned())
                    .unwrap_or(Value::Null);
                json!({
                    "kind": "report",
                    "reportName": report.name.get(locale),
                    "reportKind": kind,
                    "text": null,
                    "layout": layout.to_json(),
                })
            }
        })
        .collect();
    json!({
        "id": template.id,
        "name": template.name.get(locale),
        "description": template.description.get(locale),
        "tiles": tiles,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_template_yields_specs_the_schema_accepts() {
        let ids: Vec<&str> = templates().iter().map(|t| t.id).collect();
        assert_eq!(
            ids,
            [
                "website-overview",
                "acquisition",
                "product-health",
                "performance",
                "engagement"
            ]
        );
        for template in templates() {
            for tile in &template.tiles {
                if let TemplateTile::Report { report, .. } = tile {
                    assert!(
                        template_report_spec(report, "pnp_a").is_some(),
                        "{}: {}",
                        template.id,
                        report.name.en
                    );
                }
            }
        }
    }

    #[test]
    fn the_locale_comes_from_the_request() {
        assert_eq!(template_locale(None, Some("nl-NL,nl;q=0.9,en;q=0.8")), "nl");
        assert_eq!(template_locale(None, Some("de-DE,fr;q=0.9")), "en");
        assert_eq!(template_locale(Some("en"), Some("nl")), "en");
    }
}
