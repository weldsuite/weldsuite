//! Who may subscribe to what on a workspace hub: `canSubscribe`,
//! `isPersonalTopicForOtherUser` and the role allow lists of the
//! realtime-worker (`src/lib/permissions.ts`), and `topicMatches`
//! (`@weldsuite/realtime/topics`).

use std::sync::LazyLock;

/// Per-user topics (`PERSONAL_HUB_TOPIC_PREFIXES`): only
/// `<prefix>.<own user id>[...]` may be subscribed to, whatever the role.
pub(crate) const PERSONAL_PREFIXES: [&str; 4] = ["notification", "mail", "inbox", "chat.user"];

/// The topic presence events go on (`PRESENCE_TOPIC`).
pub(crate) const PRESENCE_TOPIC: &str = "presence";

/// `topicMatches(subscription, eventTopic)`: the topic itself or a child of
/// it (`project` matches `project.proj_1`).
pub(crate) fn topic_matches(subscription: &str, topic: &str) -> bool {
    topic == subscription
        || topic
            .strip_prefix(subscription)
            .is_some_and(|rest| rest.starts_with('.'))
}

/// Every subscription that matches `topic`: the topic and each of its
/// parents, cut at a dot (`a.b.c` → `a`, `a.b`, `a.b.c`). Looking these up
/// is the same as testing [`topic_matches`] against every subscription.
pub(crate) fn matching_subscriptions(topic: &str) -> impl Iterator<Item = &str> {
    topic
        .char_indices()
        .filter(|(_, c)| *c == '.')
        .map(move |(i, _)| &topic[..i])
        .chain(std::iter::once(topic))
}

/// `isPersonalTopicForOtherUser`: a personal topic that is not the caller's.
/// The bare family (`notification`) is always someone else's.
pub(crate) fn is_personal_topic_for_other_user(user_id: &str, topic: &str) -> bool {
    PERSONAL_PREFIXES.iter().any(|prefix| {
        if topic == *prefix {
            return true;
        }
        topic
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_prefix('.'))
            .is_some_and(|after| after.split('.').next() != Some(user_id))
    })
}

/// The topics a connection may subscribe to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Allowed {
    /// `*`: owners and admins.
    All,
    /// `canSubscribe` patterns: a pattern allows itself and its children.
    Only(Vec<String>),
}

impl Allowed {
    /// `canSubscribe(allowed, topic)`.
    pub(crate) fn permits(&self, topic: &str) -> bool {
        match self {
            Self::All => true,
            Self::Only(patterns) => patterns.iter().any(|pattern| topic_matches(pattern, topic)),
        }
    }
}

/// The non-personal catalog entity types and `presence`
/// (`listMemberHubTopics`).
static MEMBER_HUB_TOPICS: LazyLock<Vec<String>> = LazyLock::new(|| {
    weldsuite_catalogs::entity_events::ALL
        .iter()
        .map(|(entity_type, _)| *entity_type)
        .filter(|entity_type| !PERSONAL_PREFIXES.contains(entity_type))
        .chain(std::iter::once(PRESENCE_TOPIC))
        .map(str::to_owned)
        .collect()
});

/// `getWorkspacePermissions`: owners and admins get everything (but other
/// people's personal topics, refused separately); members and viewers get
/// their own personal topics plus every catalog topic.
pub(crate) fn workspace_allowed(role: &str, user_id: &str) -> Allowed {
    if role.eq_ignore_ascii_case("owner") || role.eq_ignore_ascii_case("admin") {
        return Allowed::All;
    }
    let mut topics = vec![
        format!("notification.{user_id}"),
        format!("mail.{user_id}"),
        format!("inbox.{user_id}"),
        format!("chat.user.{user_id}"),
    ];
    topics.extend(MEMBER_HUB_TOPICS.iter().cloned());
    Allowed::Only(topics)
}

/// `getPersonalPermissions`: a consumer account reaches its own mail and
/// notifications only.
pub(crate) fn personal_allowed(user_id: &str) -> Allowed {
    Allowed::Only(vec![
        format!("mail.{user_id}"),
        format!("notification.{user_id}"),
    ])
}

/// `personalHubKey`.
pub(crate) fn personal_hub_key(user_id: &str) -> String {
    format!("personal:{user_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_follows_dots() {
        assert!(topic_matches("project", "project"));
        assert!(topic_matches("project", "project.p1"));
        assert!(!topic_matches("project", "project_task"));
        assert!(!topic_matches("project.p1", "project"));
        let found: Vec<&str> = matching_subscriptions("a.b.c").collect();
        assert_eq!(found, ["a", "a.b", "a.b.c"]);
        for (sub, topic) in [("a.", "a..x"), ("", ".x"), ("a.b", "a.bc"), ("x", "a.b")] {
            assert_eq!(
                matching_subscriptions(topic).any(|s| s == sub),
                topic_matches(sub, topic),
                "{sub} / {topic}"
            );
        }
    }

    #[test]
    fn personal_topics_belong_to_their_user() {
        assert!(is_personal_topic_for_other_user("u1", "notification"));
        assert!(is_personal_topic_for_other_user("u1", "notification.u2"));
        assert!(is_personal_topic_for_other_user("u1", "chat.user.u2"));
        assert!(!is_personal_topic_for_other_user("u1", "notification.u1"));
        assert!(!is_personal_topic_for_other_user(
            "u1",
            "notification.u1.sub"
        ));
        assert!(!is_personal_topic_for_other_user("u1", "project.p1"));
        assert!(!is_personal_topic_for_other_user("u1", "chat.channel"));
    }

    #[test]
    fn roles_get_their_lists() {
        assert_eq!(workspace_allowed("OWNER", "u1"), Allowed::All);
        assert_eq!(workspace_allowed("admin", "u1"), Allowed::All);
        let member = workspace_allowed("MEMBER", "u1");
        assert!(member.permits("notification.u1"));
        assert!(!member.permits("notification"));
        assert!(member.permits("presence"));
        assert!(member.permits("task.t1"), "a catalog entity");
        assert!(!member.permits("made_up_topic"));
        let personal = personal_allowed("u1");
        assert!(personal.permits("mail.u1"));
        assert!(!personal.permits("task"));
    }
}
