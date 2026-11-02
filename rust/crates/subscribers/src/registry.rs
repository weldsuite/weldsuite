//! The subscriber registry, `ENTITY_EVENT_SUBSCRIBERS` in
//! `packages/core/entity-events/src/subscribers.ts`, and its topic matching.
//! On NATS every subscriber is a durable consumer of the hub stream; its
//! topics become the consumer's filter subject, and [`topic_matches`] runs
//! again in process, as the hub worker does.

/// One registry row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Subscriber {
    /// The id in TypeScript, and the durable consumer's name on NATS.
    pub id: &'static str,
    /// Topic patterns: `*`, `entityType:*` or `entityType:action`.
    pub topics: &'static [&'static str],
    /// The queue the hub worker sends it to in Global.
    pub queue: &'static str,
    /// The queue consumer's `max_retries`, `max_batch_size` and
    /// `max_batch_timeout` (seconds) in production's wrangler.toml, and how
    /// many batches one pod handles at once (`max_concurrency` where the
    /// queue sets it; the audit queue scales on its own, here two).
    pub max_retries: u32,
    pub batch_size: usize,
    pub batch_timeout_seconds: u64,
    pub concurrency: usize,
    /// Ported to Rust: a `weldsuite consume` consumer exists for it.
    pub ported: bool,
}

/// `ENTITY_EVENT_SUBSCRIBERS`, in its order. Queue settings are production's.
pub const SUBSCRIBERS: [Subscriber; 7] = [
    Subscriber {
        id: "audit",
        topics: &["*"],
        queue: "audit-events",
        max_retries: 3,
        batch_size: 10,
        batch_timeout_seconds: 1,
        concurrency: 2,
        ported: true,
    },
    Subscriber {
        id: "analytics",
        topics: &["*"],
        queue: "analytics-events",
        max_retries: 3,
        batch_size: 25,
        batch_timeout_seconds: 5,
        concurrency: 1,
        ported: false,
    },
    Subscriber {
        id: "search-index",
        topics: &["*"],
        queue: "search-index",
        max_retries: 3,
        batch_size: 25,
        batch_timeout_seconds: 10,
        concurrency: 4,
        ported: true,
    },
    Subscriber {
        id: "webhooks",
        topics: &["*"],
        queue: "entity-webhooks",
        max_retries: 3,
        batch_size: 10,
        batch_timeout_seconds: 5,
        concurrency: 4,
        ported: true,
    },
    Subscriber {
        id: "weldconnect",
        topics: &["*"],
        queue: "entity-workflows",
        max_retries: 3,
        batch_size: 10,
        batch_timeout_seconds: 5,
        concurrency: 1,
        ported: false,
    },
    Subscriber {
        id: "weldagent",
        topics: &["*"],
        queue: "entity-agents",
        max_retries: 3,
        batch_size: 10,
        batch_timeout_seconds: 5,
        concurrency: 1,
        ported: false,
    },
    Subscriber {
        id: "realtime",
        topics: &["*"],
        queue: "entity-realtime",
        max_retries: 3,
        batch_size: 10,
        batch_timeout_seconds: 1,
        concurrency: 4,
        ported: true,
    },
];

/// The registry row for `id`.
pub fn subscriber(id: &str) -> Option<&'static Subscriber> {
    SUBSCRIBERS.iter().find(|sub| sub.id == id)
}

/// `topicMatches(patterns, eventType)`.
pub fn topic_matches(patterns: &[&str], event_type: &str) -> bool {
    let Some(colon) = event_type.find(':') else {
        return false;
    };
    if colon == 0 || colon == event_type.len() - 1 {
        return false;
    }
    let entity_type = &event_type[..colon];
    patterns.iter().any(|pattern| {
        *pattern == "*"
            || *pattern == event_type
            || pattern
                .strip_suffix(":*")
                .is_some_and(|prefix| prefix == entity_type)
    })
}

/// `matchEntityEventSubscribers(eventType)`: the ids, in registry order.
pub fn matching_subscribers(event_type: &str) -> Vec<&'static str> {
    SUBSCRIBERS
        .iter()
        .filter(|sub| topic_matches(sub.topics, event_type))
        .map(|sub| sub.id)
        .collect()
}

/// The NATS filter subject for a subscriber's topics under `prefix`
/// (`entity-events`): `prefix.>` for `*`, `prefix.<type>.*` for `type:*`,
/// `prefix.<type>.<action>` for an exact topic. Several topics, or one that
/// cannot be a subject, fall back to everything (`prefix.>`), and
/// [`topic_matches`] narrows in process.
pub fn filter_subject(topics: &[&str], prefix: &str) -> String {
    let everything = format!("{prefix}.>");
    let [topic] = topics else {
        return everything;
    };
    if *topic == "*" {
        return everything;
    }
    let Some((entity_type, action)) = topic.split_once(':') else {
        return everything;
    };
    let token = |t: &str| {
        !t.is_empty()
            && !t.contains(['.', ' ', '>', '\t', '\r', '\n'])
            && (t == "*" || !t.contains('*'))
    };
    if entity_type == "*" || !token(entity_type) || !token(action) {
        return everything;
    }
    format!("{prefix}.{entity_type}.{action}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topics_match_as_in_typescript() {
        assert!(topic_matches(&["*"], "customer:created"));
        assert!(topic_matches(&["customer:*"], "customer:updated"));
        assert!(!topic_matches(&["customer:*"], "contact:updated"));
        assert!(topic_matches(&["customer:created"], "customer:created"));
        assert!(!topic_matches(&["*"], "customer"));
        assert!(!topic_matches(&["*"], ":created"));
        assert!(!topic_matches(&["*"], "customer:"));
    }

    #[test]
    fn filter_subjects() {
        assert_eq!(filter_subject(&["*"], "entity-events"), "entity-events.>");
        assert_eq!(
            filter_subject(&["customer:*"], "entity-events"),
            "entity-events.customer.*"
        );
        assert_eq!(
            filter_subject(&["customer:created"], "entity-events"),
            "entity-events.customer.created"
        );
        assert_eq!(
            filter_subject(&["a:*", "b:*"], "entity-events"),
            "entity-events.>"
        );
    }
}
