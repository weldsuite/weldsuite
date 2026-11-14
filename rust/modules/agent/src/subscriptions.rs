//! Which events start an agent by themselves (`eventSubscriptions`;
//! `packages/domains/agent/src/subscriptions.ts`).
//!
//! Two sources, in this order of trust:
//!
//! 1. Explicit triggers the user asked for, passed to `save_agent_setup`
//!    ([`normalize_explicit_triggers`]); an agent saved that way is flagged
//!    ([`EXPLICIT_TRIGGERS_FLAG`]) so Activate keeps them.
//! 2. A deterministic reading of the instructions
//!    ([`extract_event_subscriptions`]), so activation works offline (no
//!    model) and stays testable.
//!
//! The reading is deliberately conservative: a wrong trigger makes an active
//! agent run (and spend credits) on every matching record. It works clause by
//! clause and ignores negated clauses and things done only when asked.
//! Anything unclear yields `["manual"]`.

use std::sync::LazyLock;

use regex::Regex;
use weldsuite_catalogs::entity_events::is_known_action;
use weldsuite_catalogs::entity_events::is_known_entity_type;

/// `enabledTools` flag: the agent's subscriptions came from explicit
/// triggers, not from its prompt.
pub const EXPLICIT_TRIGGERS_FLAG: &str = "agent.explicit_triggers";

/// `hasExplicitTriggers(enabledTools)`.
pub fn has_explicit_triggers(enabled_tools: &[String]) -> bool {
    enabled_tools
        .iter()
        .any(|tool| tool == EXPLICIT_TRIGGERS_FLAG)
}

/// `withExplicitTriggersFlag(enabledTools)`.
pub fn with_explicit_triggers_flag(enabled_tools: &[String]) -> Vec<String> {
    let mut out = enabled_tools.to_vec();
    if !has_explicit_triggers(&out) {
        out.push(EXPLICIT_TRIGGERS_FLAG.to_owned());
    }
    out
}

/// `isValidSubscription(value)`: a dotted (or colon) event name in the
/// catalog.
pub fn is_valid_subscription(value: &str) -> bool {
    let sep = if value.contains(':') {
        ':'
    } else if value.contains('.') {
        '.'
    } else {
        return false;
    };
    let Some((entity_type, action)) = value.split_once(sep) else {
        return false;
    };
    is_known_entity_type(entity_type) && is_known_action(entity_type, action)
}

/// Explicit triggers as stored subscriptions and the ones that were refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExplicitTriggers {
    pub subscriptions: Vec<String>,
    pub invalid: Vec<String>,
}

/// `normalizeExplicitTriggers(triggers)`: dotted catalog keys (`ticket:created`
/// is accepted too), plus `manual` / `scheduled`. Unknown keys and the `*`
/// wildcard are reported, not stored. No valid trigger means `["manual"]`.
pub fn normalize_explicit_triggers(triggers: &[String]) -> ExplicitTriggers {
    let mut subscriptions: Vec<String> = Vec::new();
    let mut invalid: Vec<String> = Vec::new();
    for raw in triggers {
        // `replace(':', '.')` replaces the first colon only.
        let key = raw.trim().to_lowercase().replacen(':', ".", 1);
        if key == "manual" || key == "scheduled" || is_valid_subscription(&key) {
            if !subscriptions.contains(&key) {
                subscriptions.push(key);
            }
        } else {
            invalid.push(raw.trim().to_owned());
        }
    }
    let real: Vec<String> = subscriptions
        .into_iter()
        .filter(|key| key != "manual")
        .collect();
    ExplicitTriggers {
        subscriptions: if real.is_empty() {
            vec!["manual".to_owned()]
        } else {
            real
        },
        invalid,
    }
}

// ---------------------------------------------------------------------------
// Reading the instructions
// ---------------------------------------------------------------------------

/// Words that make a clause something the agent must NOT do, or does not have.
const NEGATION_WORDS: [&str; 20] = [
    "no",
    "not",
    "never",
    "none",
    "nor",
    "cannot",
    "can't",
    "cant",
    "don't",
    "dont",
    "doesn't",
    "doesnt",
    "won't",
    "shouldn't",
    "mustn't",
    "without",
    "avoid",
    "refrain",
    "unless",
    "except",
];

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static pattern")
}

static NEGATION_PHRASE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(?:instead\s+of|rather\s+than)\b"));
static WORDS: LazyLock<Regex> = LazyLock::new(|| re(r"[A-Za-z']+"));

fn is_negated(clause: &str) -> bool {
    let lower = clause.to_lowercase();
    WORDS
        .find_iter(&lower)
        .any(|word| NEGATION_WORDS.contains(&word.as_str()))
        || NEGATION_PHRASE.is_match(clause)
}

static ON_REQUEST: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!("(?i){}", [
        r"\b(?:only|just)\s+(?:when|if|on)\s+(?:asked|requested|prompted|told|invoked|the\s+user|a\s+user|users?|someone|they|you\s+are\s+asked)\b",
        r"\b(?:when(?:ever)?|if|once|as\s+soon\s+as)\s+(?:the\s+|a\s+|any\s+)?(?:user|users|someone|somebody|they|i|we|you)\s+(?:asks?|requests?|tells?|wants?|says?|types?|messages?|mentions?|invokes?)\b",
        r"\b(?:when|if|once)\s+(?:asked|requested|prompted|told)\b",
        r"\bon\s+(?:request|demand)\b",
        r"\bas\s+(?:asked|requested)\b",
    ]
    .join("|")))
});

static LEAD_IN: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(?:when(?:ever)?|each|every|as\s+soon\s+as|upon)\b"));
static OWN_ACTION: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(?:you|your|i|we|me|my|us|our)\b"));

const ARRIVES: &str = r"(?:is\s+|are\s+|gets?\s+|was\s+|were\s+|has\s+been\s+|have\s+been\s+|being\s+)?(?:newly\s+)?(?:created|added|opened|submitted|arrives?|arrived|comes?\s+in|come\s+in|received|raised|logged|filed|registered|placed)";

struct EntityHint {
    nouns: &'static str,
    created: &'static str,
    transitions: &'static [(&'static str, &'static str)],
}

const ENTITIES: [EntityHint; 8] = [
    EntityHint {
        nouns: "people|person|contacts?",
        created: "person.created",
        transitions: &[],
    },
    EntityHint {
        nouns: "compan(?:y|ies)|customers?",
        created: "company.created",
        transitions: &[],
    },
    EntityHint {
        nouns: "tickets?",
        created: "ticket.created",
        transitions: &[
            ("escalated", "ticket.escalated"),
            ("resolved", "ticket.resolved"),
        ],
    },
    EntityHint {
        nouns: "tasks?",
        created: "project_task.created",
        transitions: &[("completed|done|finished", "project_task.completed")],
    },
    EntityHint {
        nouns: "leads?",
        created: "lead.created",
        transitions: &[],
    },
    EntityHint {
        nouns: "orders?",
        created: "order.created",
        transitions: &[],
    },
    EntityHint {
        nouns: "invoices?",
        created: "invoice.created",
        transitions: &[("paid", "invoice.paid"), ("overdue", "invoice.overdue")],
    },
    EntityHint {
        nouns: "deals?|opportunit(?:y|ies)",
        created: "opportunity.created",
        transitions: &[("won", "opportunity.won"), ("lost", "opportunity.lost")],
    },
];

/// The compiled patterns of one entity.
struct EntityPatterns {
    happens: Regex,
    adjective: Regex,
    quantified: Regex,
    transitions: Vec<(Regex, &'static str)>,
    created: &'static str,
}

static ENTITY_PATTERNS: LazyLock<Vec<EntityPatterns>> = LazyLock::new(|| {
    ENTITIES
        .iter()
        .map(|entity| {
            let nouns = entity.nouns;
            EntityPatterns {
                happens: re(&format!(r"(?i)\b(?:{nouns})\s+{ARRIVES}\b")),
                adjective: re(&format!(
                    r"(?i)\b(new|newly\s+(?:created|added)|incoming|created)\s+(?:{nouns})\b(\s+{ARRIVES}\b)?"
                )),
                quantified: re(&format!(
                    r"(?i)\b(?:(?:for|on|upon|when|whenever|as\s+soon\s+as)\s+(?:each|every)\s+(?:new\s+)?|(?:each|every)\s+new\s+)(?:{nouns})\b"
                )),
                transitions: entity
                    .transitions
                    .iter()
                    .map(|(verbs, event)| {
                        (
                            re(&format!(
                                r"(?i)\b(?:{nouns})\s+(?:is\s+|are\s+|gets?\s+|was\s+|has\s+been\s+|being\s+)?(?:{verbs})\b"
                            )),
                            *event,
                        )
                    })
                    .collect(),
                created: entity.created,
            }
        })
        .collect()
});

/// A schedule the agent runs on, never the bare word ("no schedules").
static SCHEDULE: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!("(?i){}", [
        r"\b(?:every|each)\s+(?:\d+\s+)?(?:morning|day|night|evening|afternoon|hour|minute|week|weekday|weekend|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b",
        r"\b(?:daily|weekly|hourly|nightly|monthly)\b",
        r"\bon\s+a\s+(?:daily\s+|weekly\s+|regular\s+|fixed\s+)?schedule\b",
        r"\bon\s+schedule\b",
        r"\bcron\b",
    ]
    .join("|")))
});

static EXPLICIT_EVENT: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)\b([a-z][a-z_]*)\.(created|updated|deleted|completed|escalated|resolved|won|lost|paid|overdue|received|placed|shipped|delivered)\b",
    )
});

static CLAUSE_BREAK: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)[,:()\u{2013}\u{2014}]| - | (?:but|however|although|though|while|whereas) ")
});

/// Sentences, then clauses: the unit a negation or a request reaches.
fn clauses_of(instructions: &str) -> Vec<String> {
    let text = instructions.replace(['\u{2018}', '\u{2019}'], "'");
    let mut sentences: Vec<String> = Vec::new();
    for piece in text.split([';', '\n', '\r', '\u{2022}']) {
        // A full stop ends a sentence only before whitespace: `ticket.created`
        // is one word.
        let mut current = String::new();
        let mut chars = piece.chars().peekable();
        while let Some(ch) = chars.next() {
            current.push(ch);
            if matches!(ch, '.' | '!' | '?')
                && chars.peek().is_some_and(|next| next.is_whitespace())
            {
                while chars.peek().is_some_and(|next| next.is_whitespace()) {
                    chars.next();
                }
                sentences.push(std::mem::take(&mut current));
            }
        }
        sentences.push(current);
    }
    let mut clauses = Vec::new();
    for sentence in sentences {
        let collapsed = sentence.split_whitespace().collect::<Vec<_>>().join(" ");
        for clause in CLAUSE_BREAK.split(&collapsed) {
            let clause = clause.trim();
            if !clause.is_empty() {
                clauses.push(clause.to_owned());
            }
        }
    }
    clauses
}

/// A clause that tells the agent what NOT to do, or that only applies when
/// asked.
fn is_excluded(clause: &str) -> bool {
    is_negated(clause) || ON_REQUEST.is_match(clause)
}

/// Events a clause says the agent reacts to.
fn events_in_clause(clause: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let leads_in = |index: usize| {
        let before = &clause[..index];
        LEAD_IN
            .find(before)
            .is_some_and(|lead| !OWN_ACTION.is_match(&before[lead.start()..]))
    };
    for entity in ENTITY_PATTERNS.iter() {
        if entity.happens.is_match(clause) {
            found.push(entity.created.to_owned());
        }
        if let Some(adj) = entity.adjective.captures(clause) {
            let lead = adj.get(1).map_or("", |m| m.as_str());
            let start = adj.get(0).map_or(0, |m| m.start());
            if lead.eq_ignore_ascii_case("incoming") || adj.get(2).is_some() || leads_in(start) {
                found.push(entity.created.to_owned());
            }
        }
        if let Some(quant) = entity.quantified.find(clause)
            && !OWN_ACTION.is_match(&clause[..quant.start()])
        {
            found.push(entity.created.to_owned());
        }
        for (reaches, event) in &entity.transitions {
            if reaches.is_match(clause) {
                found.push((*event).to_owned());
            }
        }
    }
    for caps in EXPLICIT_EVENT.captures_iter(clause) {
        found.push(format!("{}.{}", &caps[1], &caps[2]).to_lowercase());
    }
    found
}

/// `extractEventSubscriptions(instructions)`: event subscription keys derived
/// from instructions; `["manual"]` when nothing says the agent should react
/// to something (a chat-only agent).
pub fn extract_event_subscriptions(instructions: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut add = |key: String| {
        if !found.contains(&key) {
            found.push(key);
        }
    };
    for clause in clauses_of(instructions) {
        if is_excluded(&clause) {
            continue;
        }
        for event in events_in_clause(&clause) {
            if is_valid_subscription(&event) {
                add(event);
            }
        }
        if SCHEDULE.is_match(&clause) {
            add("scheduled".to_owned());
        }
    }
    if found.is_empty() {
        return vec!["manual".to_owned()];
    }
    // Drop the pure schedule marker when there are real entity events too.
    if found.len() > 1 {
        found.retain(|key| key != "scheduled");
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| (*i).to_owned()).collect()
    }

    #[test]
    fn explicit_triggers_are_normalised() {
        let out = normalize_explicit_triggers(&s(&["Ticket:Created", "nonsense", "manual", "*"]));
        assert_eq!(out.subscriptions, ["ticket.created"]);
        assert_eq!(out.invalid, ["nonsense", "*"]);
        assert_eq!(
            normalize_explicit_triggers(&s(&["manual"])).subscriptions,
            ["manual"]
        );
        assert_eq!(normalize_explicit_triggers(&[]).subscriptions, ["manual"]);
    }

    #[test]
    fn a_new_ticket_is_a_trigger() {
        assert_eq!(
            extract_event_subscriptions("When a new ticket arrives, triage it and reply."),
            ["ticket.created"]
        );
    }

    #[test]
    fn negated_and_on_request_clauses_are_not_triggers() {
        assert_eq!(
            extract_event_subscriptions(
                "Do not create new tasks. When the user asks, create a new person."
            ),
            ["manual"]
        );
    }

    #[test]
    fn a_schedule_alone_is_scheduled_and_loses_to_real_events() {
        assert_eq!(
            extract_event_subscriptions("Send a summary every morning."),
            ["scheduled"]
        );
        assert_eq!(
            extract_event_subscriptions("Every morning check things. For each new lead, score it."),
            ["lead.created"]
        );
    }

    #[test]
    fn an_explicit_event_key_counts() {
        assert_eq!(
            extract_event_subscriptions("React to ticket.created events and to person.created."),
            ["ticket.created", "person.created"]
        );
        assert_eq!(
            extract_event_subscriptions("Answer questions about the workspace."),
            ["manual"]
        );
    }
}
