//! Search query understanding (`services/search/query-understanding.ts`):
//! turns "Invoice from Acme Corp" into `{ types: [invoice], term: "Acme Corp" }`
//! so the per-entity `LIKE` queries can match it.
//!
//! Three tiers, cheapest first: routing (identifiers, emails and short
//! queries stay as they are), a bilingual en/nl keyword lexicon, and a model
//! parse cached for a day in the workspace cache (`WORKSPACE_CACHE` on
//! Global). TypeScript asks Workers AI's `classify` model through the
//! gateway; here the install's AI (`weldsuite_ai`, ADR AI-012) answers a
//! `classify` call of the feature `search` with the same prompt and JSON
//! schema (Mistral Small on EU), metered as `search_query_parse`. Every
//! failure (no AI, an empty wallet, a refusal, an answer off the schema)
//! falls back to the raw query, `source: "model_failed"`, as TypeScript
//! does; the model only ever narrows the types the caller may already see.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use weldsuite_ai::{Ai, AiCall, ChatRequest, Feature, Task, Tier};
use weldsuite_ports::DynCache;

use crate::search::{ENTITY_TYPES, SearchType};

/// How the query was structured (`SearchUnderstanding['source']`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Source {
    Lexical,
    Lexicon,
    Model,
    ModelFailed,
}

impl Source {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Lexical => "lexical",
            Self::Lexicon => "lexicon",
            Self::Model => "model",
            Self::ModelFailed => "model_failed",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        [Self::Lexical, Self::Lexicon, Self::Model, Self::ModelFailed]
            .into_iter()
            .find(|source| source.as_str() == raw)
    }
}

/// A structured query (`ParsedSearchQuery`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedQuery {
    /// The types asked about; empty is no opinion.
    pub(crate) entity_types: Vec<SearchType>,
    /// What the lexical queries match on.
    pub(crate) lexical_term: String,
    /// The query restated, for the semantic leg (kept in the cache).
    pub(crate) semantic_query: String,
    pub(crate) source: Source,
}

impl ParsedQuery {
    /// As TypeScript caches it.
    fn to_json(&self) -> Value {
        json!({
            "entityTypes": self.entity_types.iter().map(|t| t.as_str()).collect::<Vec<_>>(),
            "lexicalTerm": self.lexical_term,
            "semanticQuery": self.semantic_query,
            "source": self.source.as_str(),
        })
    }

    /// A cached parse (either backend wrote it); `None` when it isn't one.
    fn from_json(value: &Value) -> Option<Self> {
        let entity_types = value["entityTypes"]
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .filter_map(SearchType::parse)
            .collect();
        Some(Self {
            entity_types,
            lexical_term: value["lexicalTerm"].as_str()?.to_owned(),
            semantic_query: value["semanticQuery"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            source: Source::parse(value["source"].as_str()?)?,
        })
    }
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
        Article, Bill, Board, Contact, Customer, Domain, Invoice, KnowledgePage, Lead, MergeIssue,
        MergePullRequest, Opportunity, Order, Product, Project, Sheet, Task, Ticket,
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
        "board" | "boards" | "whiteboard" | "whiteboards" => Board,
        "issue" | "issues" => MergeIssue,
        "pr" | "prs" | "pullrequest" | "pullrequests" => MergePullRequest,
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
        semantic_query: js_trim(q).to_owned(),
        source: Source::Lexicon,
    })
}

fn passthrough(q: &str, source: Source) -> ParsedQuery {
    ParsedQuery {
        entity_types: Vec::new(),
        lexical_term: js_trim(q).to_owned(),
        semantic_query: js_trim(q).to_owned(),
        source,
    }
}

/// The first two tiers; `None` when the query needs the model.
fn without_model(q: &str) -> Option<ParsedQuery> {
    if !should_understand(q) {
        return Some(passthrough(q, Source::Lexical));
    }
    parse_with_lexicon(q)
}

/// The first two tiers, the model tier answering as a gateway that is not
/// configured.
#[cfg(test)]
pub(crate) fn understand_query(q: &str) -> ParsedQuery {
    without_model(q).unwrap_or_else(|| passthrough(q, Source::ModelFailed))
}

// ── The model tier ─────────────────────────────────────────────────────────

/// What the model tier runs on: the AI (`None`: off), the call (who asks,
/// for whose wallet), and the workspace cache with the key's workspace
/// (the Clerk org id, as `cacheKey`).
pub(crate) struct ModelTier {
    pub(crate) ai: Option<Ai>,
    pub(crate) call: AiCall,
    pub(crate) cache: Option<Arc<dyn DynCache>>,
    pub(crate) cache_workspace: String,
}

impl ModelTier {
    /// `classify`, free tier, for the feature `search`, metered as
    /// `search_query_parse`.
    pub(crate) fn call(workspace_id: &str) -> AiCall {
        AiCall::new(workspace_id, Feature::Search, Task::Classify, Tier::Free)
            .op("search_query_parse")
    }
}

/// `CACHE_PREFIX`: query phrasings repeat across a workspace's members.
const CACHE_PREFIX: &str = "search-parse:v1:";
/// `CACHE_TTL_SECONDS`: a day.
const CACHE_TTL: Duration = Duration::from_hours(24);

/// `cacheKey(workspaceId, q)`: namespaced per workspace, the query trimmed,
/// lower-cased and its whitespace runs folded to one space.
pub(crate) fn cache_key(workspace: &str, q: &str) -> String {
    let lower = js_trim(q).to_lowercase();
    let normalized = lower.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{CACHE_PREFIX}{workspace}:{normalized}")
}

/// `buildSystemPrompt()`.
fn system_prompt() -> String {
    [
        "You extract structured search intent from a search box query in a business platform called WeldSuite.",
        "The platform is bilingual: queries arrive in English or Dutch.",
        "",
        "Output three fields:",
        "- entityTypes: which record types the user is asking for. Use ONLY ids from this list:",
        &format!("  {}", ENTITY_TYPES.join(", ")),
        "  Return an empty array if the query does not name or imply a specific type.",
        "- searchTerm: the proper noun, name, number or keyword to match records against,",
        "  with the type word and filler words removed. For \"Invoice from Acme Corp\" this is \"Acme Corp\".",
        "  If the query is only a type word (\"all invoices\"), return an empty string.",
        "- semanticQuery: the query restated as a short descriptive phrase, for semantic matching.",
        "",
        "Never invent an entity type that is not in the list. Never return SQL.",
        "",
        "Examples:",
        "Query: \"Invoice from Acme Corp\"",
        "{\"entityTypes\":[\"invoice\"],\"searchTerm\":\"Acme Corp\",\"semanticQuery\":\"invoice from Acme Corp\"}",
        "Query: \"openstaande facturen van Jansen BV\"",
        "{\"entityTypes\":[\"invoice\"],\"searchTerm\":\"Jansen BV\",\"semanticQuery\":\"openstaande facturen van Jansen BV\"}",
        "Query: \"tickets about the broken pump\"",
        "{\"entityTypes\":[\"ticket\"],\"searchTerm\":\"broken pump\",\"semanticQuery\":\"tickets about the broken pump\"}",
        "Query: \"who handles the Rotterdam account\"",
        "{\"entityTypes\":[\"contact\",\"customer\"],\"searchTerm\":\"Rotterdam\",\"semanticQuery\":\"who handles the Rotterdam account\"}",
    ]
    .join("\n")
}

/// `parseSchema`.
fn parse_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "entityTypes": { "type": "array", "items": { "type": "string", "enum": ENTITY_TYPES } },
            "searchTerm": { "type": "string" },
            "semanticQuery": { "type": "string" },
        },
        "required": ["entityTypes", "searchTerm", "semanticQuery"],
        "additionalProperties": false,
    })
}

/// `normalizeModelOutput(raw, q)`: unknown types are dropped (the schema is
/// best-effort on some models), repeats too; an empty term or restatement
/// falls back to the query.
pub(crate) fn normalize_model_output(raw: &Value, q: &str) -> ParsedQuery {
    let mut entity_types: Vec<SearchType> = Vec::new();
    for name in raw["entityTypes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if let Some(kind) = SearchType::parse(name)
            && !entity_types.contains(&kind)
        {
            entity_types.push(kind);
        }
    }
    let text = |key: &str| {
        let value = js_trim(raw[key].as_str().unwrap_or_default());
        if value.is_empty() {
            js_trim(q).to_owned()
        } else {
            value.to_owned()
        }
    };
    ParsedQuery {
        entity_types,
        lexical_term: text("searchTerm"),
        semantic_query: text("semanticQuery"),
        source: Source::Model,
    }
}

/// `parseWithModel`: `None` without AI, with an empty wallet or on any
/// failure.
async fn parse_with_model(q: &str, tier: &ModelTier) -> Option<ParsedQuery> {
    let ai = tier.ai.as_ref()?;
    // An empty wallet must not break search: the lexical path, silently.
    ai.assert_credits(&tier.call).await.ok()?;
    let request = ChatRequest::system_user(system_prompt(), format!("Query: \"{q}\""))
        .schema("search_query", parse_schema());
    match ai.chat(&tier.call, request).await {
        Ok(answer) => Some(normalize_model_output(
            answer.object.as_ref().unwrap_or(&Value::Null),
            q,
        )),
        Err(error) => {
            tracing::warn!(%error, "[app-api/search] query parse failed");
            None
        }
    }
}

/// A raw search string as a scoped query; never fails (`understandQuery`).
pub(crate) async fn understand_query_with(q: &str, tier: &ModelTier) -> ParsedQuery {
    if let Some(parsed) = without_model(q) {
        return parsed;
    }
    let key = cache_key(&tier.cache_workspace, q);
    if let Some(cache) = &tier.cache
        && let Ok(Some(hit)) = cache.get_boxed(&key).await
        && let Some(parsed) = serde_json::from_str::<Value>(&hit)
            .ok()
            .as_ref()
            .and_then(ParsedQuery::from_json)
    {
        return parsed;
    }
    let Some(parsed) = parse_with_model(q, tier).await else {
        return passthrough(q, Source::ModelFailed);
    };
    if let Some(cache) = &tier.cache
        && let Err(error) = cache
            .put_boxed(&key, &parsed.to_json().to_string(), Some(CACHE_TTL))
            .await
    {
        tracing::debug!(%error, "[app-api/search] the parse cache is unavailable");
    }
    parsed
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

    fn ai(fake: &weldsuite_ai::FakeProvider) -> Ai {
        let env = |name: &str| match name {
            "AI_DEFAULT_PROVIDER" => Some("mistral".to_owned()),
            "MISTRAL_API_KEY" => Some("mistral-key".to_owned()),
            _ => None,
        };
        let mut problems = Vec::new();
        let config = weldsuite_ai::AiConfig::from_lookup(&env, &mut problems);
        assert!(problems.is_empty(), "{problems:?}");
        Ai::fake(config, fake.clone())
    }

    fn tier(ai: Option<Ai>) -> ModelTier {
        ModelTier {
            ai,
            call: ModelTier::call("ws_1"),
            cache: None,
            cache_workspace: "org_1".to_owned(),
        }
    }

    #[test]
    fn the_model_output_is_checked_against_the_types() {
        let parsed = normalize_model_output(
            &json!({ "entityTypes": ["ticket", "bogus", "ticket"], "searchTerm": " acme pump ", "semanticQuery": "" }),
            " the broken acme pump report ",
        );
        assert_eq!(parsed.source, Source::Model);
        assert_eq!(parsed.entity_types, [SearchType::Ticket]);
        assert_eq!(parsed.lexical_term, "acme pump");
        assert_eq!(parsed.semantic_query, "the broken acme pump report");
        let nothing = normalize_model_output(&Value::Null, "q");
        assert_eq!(nothing.entity_types, []);
        assert_eq!(nothing.lexical_term, "q");
        assert_eq!(
            ParsedQuery::from_json(&parsed.to_json()).as_ref(),
            Some(&parsed)
        );
        assert_eq!(
            cache_key("org_1", "  The  Broken\tPump "),
            "search-parse:v1:org_1:the broken pump"
        );
    }

    #[tokio::test]
    async fn the_model_tier_classifies_on_mistral_with_the_schema() {
        let fake = weldsuite_ai::FakeProvider::new().reply_json(
            &json!({ "entityTypes": ["ticket"], "searchTerm": "acme pump", "semanticQuery": "broken acme pump" }),
        );
        let parsed =
            understand_query_with("the broken acme pump report", &tier(Some(ai(&fake)))).await;
        assert_eq!(parsed.source, Source::Model);
        assert_eq!(parsed.entity_types, [SearchType::Ticket]);
        assert_eq!(parsed.lexical_term, "acme pump");
        let calls = fake.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].url, "https://api.mistral.ai/v1/chat/completions");
        assert_eq!(calls[0].model().as_deref(), Some("mistral-small-2603"));
        assert_eq!(calls[0].body["response_format"]["type"], "json_schema");
        assert_eq!(
            calls[0].body["messages"][1]["content"],
            "Query: \"the broken acme pump report\""
        );
        // The lexical tiers never reach the model.
        let lexical = understand_query_with("Invoice from Acme Corp", &tier(Some(ai(&fake)))).await;
        assert_eq!(lexical.source, Source::Lexicon);
        assert_eq!(fake.calls().len(), 1);
    }

    #[tokio::test]
    async fn without_ai_or_on_a_refusal_the_raw_query_stays() {
        let off = understand_query_with("the broken acme pump report", &tier(None)).await;
        assert_eq!(off.source, Source::ModelFailed);
        assert_eq!(off.lexical_term, "the broken acme pump report");
        let fake = weldsuite_ai::FakeProvider::new().reply_status(400, "{\"message\":\"bad\"}");
        let refused =
            understand_query_with("the broken acme pump report", &tier(Some(ai(&fake)))).await;
        assert_eq!(refused.source, Source::ModelFailed);
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
