//! Search query understanding (`services/search/query-understanding.ts`):
//! turns "Invoice from Acme Corp" into `{ types: [invoice], term: "Acme Corp" }`
//! so the per-entity `LIKE` queries can match it.
//!
//! Three tiers in TypeScript, cheapest first: routing (identifiers, emails
//! and short queries stay as they are), a bilingual en/nl keyword lexicon,
//! and a Workers AI parse cached in KV. The Kubernetes editions have no AI
//! port yet, so the third tier answers as an unconfigured gateway does in
//! TypeScript: the raw query, `source: "model_failed"`.

use crate::search::SearchType;

/// How the query was structured (`SearchUnderstanding['source']`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Source {
    Lexical,
    Lexicon,
    ModelFailed,
}

impl Source {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Lexical => "lexical",
            Self::Lexicon => "lexicon",
            Self::ModelFailed => "model_failed",
        }
    }
}

/// A structured query (`ParsedSearchQuery`, without the semantic leg).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedQuery {
    /// The types asked about; empty is no opinion.
    pub(crate) entity_types: Vec<SearchType>,
    /// What the lexical queries match on.
    pub(crate) lexical_term: String,
    pub(crate) source: Source,
}

/// `String.prototype.trim()`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `IDENTIFIER_RE`: `#?[a-z]{2,8}-?\d+(?:-\d+)*`, case-insensitive.
fn is_identifier(q: &str) -> bool {
    let q = q.strip_prefix('#').unwrap_or(q);
    let letters = q.bytes().take_while(u8::is_ascii_alphabetic).count();
    if !(2..=8).contains(&letters) {
        return false;
    }
    let rest = &q[letters..];
    let rest = rest.strip_prefix('-').unwrap_or(rest);
    let mut groups = rest.split('-');
    groups.all(|group| !group.is_empty() && group.bytes().all(|b| b.is_ascii_digit()))
}

/// Lower-cased runs of letters and digits (`tokenize`).
fn tokenize(q: &str) -> Vec<String> {
    q.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Worth structuring at all (`shouldUnderstand`)?
fn should_understand(q: &str) -> bool {
    let trimmed = js_trim(q);
    if trimmed.is_empty() || trimmed.contains('@') {
        return false;
    }
    if trimmed.bytes().all(|b| b.is_ascii_digit()) || is_identifier(trimmed) {
        return false;
    }
    let tokens = tokenize(trimmed);
    match tokens.len() {
        0 | 1 => false,
        // A first and last name, unless one names a type ("acme invoices").
        2 => tokens.iter().any(|token| keyword_type(token).is_some()),
        _ => true,
    }
}

/// Entity-type nouns in English and Dutch (`TYPE_KEYWORD_MAP`).
fn keyword_type(word: &str) -> Option<SearchType> {
    use SearchType::{
        Article, Bill, Contact, Customer, Domain, Invoice, KnowledgePage, Lead, Opportunity, Order,
        Product, Project, Sheet, Task, Ticket,
    };
    Some(match word {
        "contact" | "contacts" | "contactpersoon" | "contactpersonen" | "person" | "people"
        | "persoon" | "personen" => Contact,
        "customer" | "customers" | "client" | "clients" | "company" | "companies" | "klant"
        | "klanten" | "bedrijf" | "bedrijven" => Customer,
        "lead" | "leads" => Lead,
        "opportunity" | "opportunities" | "deal" | "deals" | "kans" | "kansen" => Opportunity,
        "ticket" | "tickets" => Ticket,
        "article" | "articles" | "artikel" | "artikelen" => Article,
        "wiki" | "page" | "pages" | "pagina" | "pagina_s" | "kennisbank" => KnowledgePage,
        "product" | "products" | "producten" => Product,
        "order" | "orders" | "bestelling" | "bestellingen" => Order,
        "invoice" | "invoices" | "factuur" | "facturen" => Invoice,
        "bill" | "bills" | "rekening" | "rekeningen" | "inkoopfactuur" | "inkoopfacturen" => Bill,
        "project" | "projects" | "projecten" => Project,
        "task" | "tasks" | "taak" | "taken" => Task,
        "sheet" | "sheets" | "spreadsheet" | "spreadsheets" | "rekenblad" | "rekenbladen" => Sheet,
        "domain" | "domains" | "domein" | "domeinen" => Domain,
        _ => return None,
    })
}

/// Function words with no match value (`STOPWORDS`).
const STOPWORDS: &[&str] = &[
    "a", "an", "the", "from", "for", "about", "with", "of", "in", "on", "at", "by", "to", "all",
    "any", "my", "our", "show", "me", "find", "search", "get", "list", "that", "this", "is", "are",
    "was", "were", "de", "het", "een", "van", "voor", "over", "met", "op", "aan", "bij", "alle",
    "mijn", "onze", "toon", "zoek", "vind", "laat", "zien", "die", "dat", "zijn", "waren",
];

/// Strip type nouns and function words; `None` when no type noun was there
/// (`parseWithLexicon`).
fn parse_with_lexicon(q: &str) -> Option<ParsedQuery> {
    let mut types: Vec<SearchType> = Vec::new();
    let mut kept: Vec<&str> = Vec::new();
    for raw in js_trim(q).split_whitespace() {
        let normalized: String = raw
            .to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric())
            .collect();
        if normalized.is_empty() {
            continue;
        }
        if let Some(mapped) = keyword_type(&normalized) {
            if !types.contains(&mapped) {
                types.push(mapped);
            }
            continue;
        }
        if STOPWORDS.contains(&normalized.as_str()) {
            continue;
        }
        kept.push(raw);
    }
    if types.is_empty() {
        return None;
    }
    let term = kept.join(" ");
    let term = js_trim(&term);
    Some(ParsedQuery {
        entity_types: types,
        lexical_term: if term.is_empty() {
            js_trim(q).to_owned()
        } else {
            term.to_owned()
        },
        source: Source::Lexicon,
    })
}

fn passthrough(q: &str, source: Source) -> ParsedQuery {
    ParsedQuery {
        entity_types: Vec::new(),
        lexical_term: js_trim(q).to_owned(),
        source,
    }
}

/// A raw search string as a scoped query; never fails (`understandQuery`).
pub(crate) fn understand_query(q: &str) -> ParsedQuery {
    if !should_understand(q) {
        return passthrough(q, Source::Lexical);
    }
    if let Some(parsed) = parse_with_lexicon(q) {
        return parsed;
    }
    // The model tier: no AI port on Kubernetes yet, which TypeScript answers
    // like a gateway that is not configured.
    passthrough(q, Source::ModelFailed)
}

/// The parsed types, narrowed to what the caller may see; all of those when
/// nothing is left (`applyPermittedTypes`).
pub(crate) fn apply_permitted_types(
    parsed: &ParsedQuery,
    permitted: &[SearchType],
) -> Vec<SearchType> {
    if parsed.entity_types.is_empty() {
        return permitted.to_vec();
    }
    let scoped: Vec<SearchType> = parsed
        .entity_types
        .iter()
        .copied()
        .filter(|t| permitted.contains(t))
        .collect();
    if scoped.is_empty() {
        permitted.to_vec()
    } else {
        scoped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_keeps_identifiers_and_names_lexical() {
        assert_eq!(understand_query("acme").source, Source::Lexical);
        assert_eq!(understand_query("INV-2024-0042").source, Source::Lexical);
        assert_eq!(understand_query("TASK-1042").source, Source::Lexical);
        assert_eq!(understand_query("ann@acme.com is").source, Source::Lexical);
        assert_eq!(understand_query("John Smith").source, Source::Lexical);
        assert_eq!(understand_query("1042").source, Source::Lexical);
    }

    #[test]
    fn the_lexicon_strips_type_nouns_and_stopwords() {
        let parsed = understand_query("Invoice from Acme Corp");
        assert_eq!(parsed.source, Source::Lexicon);
        assert_eq!(parsed.entity_types, [SearchType::Invoice]);
        assert_eq!(parsed.lexical_term, "Acme Corp");
        let all = understand_query("show me all invoices");
        assert_eq!(all.lexical_term, "show me all invoices");
        let dutch = understand_query("facturen van Jansen BV");
        assert_eq!(dutch.entity_types, [SearchType::Invoice]);
        assert_eq!(dutch.lexical_term, "Jansen BV");
        assert_eq!(
            understand_query("the broken pump report").source,
            Source::ModelFailed
        );
    }

    #[test]
    fn parsed_types_only_narrow() {
        let parsed = understand_query("acme invoices");
        assert_eq!(
            apply_permitted_types(&parsed, &[SearchType::Contact]),
            [SearchType::Contact]
        );
        assert_eq!(
            apply_permitted_types(&parsed, &[SearchType::Contact, SearchType::Invoice]),
            [SearchType::Invoice]
        );
    }
}
