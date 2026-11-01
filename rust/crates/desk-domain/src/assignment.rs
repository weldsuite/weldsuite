//! WeldDesk auto-assignment for `desk_conversations`
//! (`@weldsuite/db/lib/desk-assignment`, `packages/core/db/src/lib/desk-assignment.ts`).
//!
//! A customer message on an open, unowned conversation hands it to a teammate
//! from the workspace's assignment settings
//! (`helpdesk_settings.automation.deskAssignment`). The pick is serialised
//! per workspace in the [`AssignmentRouter`](crate::assignment_router)
//! (`helpdesk-workflow-worker`'s Durable Object on Global, ADR DESK-005),
//! which keeps the rotation pointer and the last picks: [`Picker::Router`].
//! Without a router (or when it fails) the pick is the one TypeScript falls
//! back to without the binding (`deskAssignmentRouterPicker(undefined)`): a
//! one-off balanced pick, with no rotation memory ([`Picker::Local`]).

use std::cmp::Ordering;

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;

use crate::assignment_router::{AssignmentRouter, PickCandidate, PickMode, PickRequest};
use crate::webchat::{Append, AppendError, append_desk_message, now};

/// `DeskAssignmentSettings`, normalised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    /// `off`, `round_robin` or `balanced`.
    pub mode: String,
    pub member_ids: Vec<String>,
    pub away_member_ids: Vec<String>,
    pub max_open_per_member: Option<i64>,
}

/// `idList(value)`: the non-empty strings, each once, in order.
fn id_list(value: &Value) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for id in value.as_array().into_iter().flatten() {
        if let Some(id) = id.as_str().filter(|id| !id.is_empty())
            && !ids.iter().any(|known| known == id)
        {
            ids.push(id.to_owned());
        }
    }
    ids
}

/// `normalizeDeskAssignment(raw)`: a stored (or partly written) settings
/// blob with its gaps filled.
pub fn normalize(raw: &Value) -> Settings {
    let mode = raw["mode"]
        .as_str()
        .filter(|mode| matches!(*mode, "off" | "round_robin" | "balanced"))
        .unwrap_or("off");
    // `Number.isInteger(max) && max > 0`.
    let max = raw["maxOpenPerMember"]
        .as_f64()
        .filter(|max| max.fract() == 0.0 && *max > 0.0 && *max <= 9_007_199_254_740_991.0);
    Settings {
        mode: mode.to_owned(),
        member_ids: id_list(&raw["memberIds"]),
        away_member_ids: id_list(&raw["awayMemberIds"]),
        #[allow(clippy::cast_possible_truncation)] // a whole number within the safe range
        max_open_per_member: max.map(|max| max as i64),
    }
}

/// `getDeskAssignmentSettings(db)`: the settings on the workspace's
/// `helpdesk_settings` row.
pub async fn settings(db: &PgPool) -> Result<Settings, sqlx::Error> {
    let automation: Option<Option<Value>> = sqlx::query_scalar(
        "select automation from helpdesk_settings where deleted_at is null limit 1",
    )
    .fetch_optional(db)
    .await?;
    let automation = automation.flatten().unwrap_or(Value::Null);
    Ok(normalize(&automation["deskAssignment"]))
}

/// `DeskAssignmentCandidate`: a teammate who may take a conversation, and
/// how many open ones they own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub user_id: String,
    pub open: i64,
}

/// `deskAssignmentCandidates(db, settings)`: the members in rotation who
/// are not away, active and internal, with their open counts.
pub async fn candidates(db: &PgPool, settings: &Settings) -> Result<Vec<Candidate>, sqlx::Error> {
    let ids: Vec<String> = settings
        .member_ids
        .iter()
        .filter(|id| !settings.away_member_ids.contains(id))
        .cloned()
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let active: Vec<String> = sqlx::query_scalar(
        "select user_id from workspace_members
         where user_id = any($1) and deleted_at is null
           and upper(status) = 'ACTIVE' and upper(member_type) = 'INTERNAL'",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let mut user_ids: Vec<String> = Vec::new();
    for id in active {
        if !user_ids.contains(&id) {
            user_ids.push(id);
        }
    }
    if user_ids.is_empty() {
        return Ok(Vec::new());
    }
    let counts: Vec<(Option<String>, i64)> = sqlx::query_as(
        "select assignee_id, count(*)::bigint from desk_conversations
         where state = 'open' and assignee_id = any($1) group by assignee_id",
    )
    .bind(&user_ids)
    .fetch_all(db)
    .await?;
    Ok(user_ids
        .into_iter()
        .map(|user_id| {
            let open = counts
                .iter()
                .find(|(id, _)| id.as_deref() == Some(user_id.as_str()))
                .map_or(0, |(_, open)| *open);
            Candidate { user_id, open }
        })
        .collect())
}

/// `a.localeCompare(b)` for the ids it orders: ICU's root collation as it
/// treats ASCII, i.e. punctuation, then digits, then letters with case
/// ignored, and lowercase before uppercase only when nothing else differs.
pub(crate) fn locale_compare(a: &str, b: &str) -> Ordering {
    /// ASCII punctuation and symbols in ICU's root order (what
    /// `localeCompare` sorts them by), not by code point: `_` before `-`.
    const PUNCTUATION: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    fn class(c: char) -> (u8, u32) {
        if c.is_ascii_digit() {
            (2, u32::from(c))
        } else if c.is_alphabetic() {
            (3, u32::from(c.to_ascii_lowercase()))
        } else if let Some(rank) = PUNCTUATION.find(c) {
            (0, u32::try_from(rank).unwrap_or(u32::MAX))
        } else {
            (1, u32::from(c))
        }
    }
    let primary = a.chars().map(class).cmp(b.chars().map(class));
    primary.then_with(|| {
        // Tertiary: at the first case difference, lowercase first.
        for (x, y) in a.chars().zip(b.chars()) {
            if x != y {
                return match (x.is_lowercase(), y.is_lowercase()) {
                    (true, false) => Ordering::Less,
                    (false, true) => Ordering::Greater,
                    _ => x.cmp(&y),
                };
            }
        }
        a.len().cmp(&b.len())
    })
}

/// `pickDeskAssignee(EMPTY_DESK_PICKER_STATE, { ...request, mode: 'balanced' })`:
/// whoever owns the fewest open conversations, ties going to the first in
/// the stable order; nobody when everyone is at `max_open`.
pub fn pick_balanced(candidates: &[Candidate], max_open: Option<i64>) -> Option<String> {
    let mut eligible: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| max_open.is_none_or(|max| c.open < max))
        .collect();
    eligible.sort_by(|a, b| locale_compare(&a.user_id, &b.user_id));
    let mut picked = *eligible.first()?;
    for candidate in &eligible {
        if candidate.open < picked.open {
            picked = candidate;
        }
    }
    Some(picked.user_id.clone())
}

/// `DeskAssigneePicker`: how a conversation's teammate is chosen.
#[derive(Debug, Clone, Copy)]
pub enum Picker<'a> {
    /// No router: a one-off balanced pick
    /// (`deskAssignmentRouterPicker(undefined)`).
    Local,
    /// The workspace's router (`deskAssignmentRouterPicker(binding, workspace)`);
    /// when it fails, the local pick.
    Router {
        router: &'a AssignmentRouter,
        /// `workspaces.id`.
        workspace_id: &'a str,
    },
}

impl Picker<'_> {
    /// `pick({ mode, candidates, maxOpen })`.
    pub async fn pick(
        &self,
        mode: PickMode,
        candidates: &[Candidate],
        max_open: Option<i64>,
    ) -> Option<String> {
        match self {
            Self::Local => pick_balanced(candidates, max_open),
            Self::Router {
                router,
                workspace_id,
            } => {
                let request = PickRequest {
                    mode,
                    candidates: candidates
                        .iter()
                        .map(|c| PickCandidate {
                            user_id: c.user_id.clone(),
                            open: c.open,
                        })
                        .collect(),
                    max_open,
                };
                match router.pick_desk_assignee(workspace_id, &request).await {
                    Ok(user_id) => user_id,
                    Err(error) => {
                        tracing::warn!(%error, "[desk-assignment] router unreachable, picking locally");
                        pick_balanced(candidates, max_open)
                    }
                }
            }
        }
    }
}

/// [`auto_assign_with`] the local pick (no router).
pub async fn auto_assign(
    db: &PgPool,
    conversation_id: &str,
) -> Result<Option<(Value, Value)>, AppendError> {
    auto_assign_with(db, conversation_id, &Picker::Local).await
}

/// `autoAssignDeskConversation(db, { conversationId, pick })`: give an open,
/// unowned conversation to a teammate, if the workspace has auto-assignment
/// on and someone can take it. The conversation after it and the `assigned`
/// event (author `system`, `metadata.auto`), or `None` when nothing changed.
/// Safe under concurrent customer messages: the owner is claimed with a
/// conditional update before the event is written.
pub async fn auto_assign_with(
    db: &PgPool,
    conversation_id: &str,
    picker: &Picker<'_>,
) -> Result<Option<(Value, Value)>, AppendError> {
    let current: Option<(String, Option<String>)> =
        sqlx::query_as("select state, assignee_id from desk_conversations where id = $1 limit 1")
            .bind(conversation_id)
            .fetch_optional(db)
            .await?;
    let Some((state, None)) = current else {
        return Ok(None);
    };
    if state != "open" {
        return Ok(None);
    }
    let settings = settings(db).await?;
    let Some(mode) = PickMode::parse(&settings.mode) else {
        return Ok(None);
    };
    let candidates = candidates(db, &settings).await?;
    if candidates.is_empty() {
        return Ok(None);
    }
    let Some(user_id) = picker
        .pick(mode, &candidates, settings.max_open_per_member)
        .await
        .filter(|id| candidates.iter().any(|c| &c.user_id == id))
    else {
        return Ok(None);
    };
    let claimed: Option<String> = sqlx::query_scalar(
        "update desk_conversations set assignee_id = $2, updated_at = $3::timestamp
         where id = $1 and assignee_id is null returning id",
    )
    .bind(conversation_id)
    .bind(&user_id)
    .bind(now())
    .fetch_optional(db)
    .await?;
    if claimed.is_none() {
        return Ok(None);
    }
    let mut metadata = Map::new();
    metadata.insert("eventType".to_owned(), json!("assigned"));
    metadata.insert("assigneeId".to_owned(), json!(user_id));
    metadata.insert("auto".to_owned(), json!(true));
    append_desk_message(
        db,
        Append {
            conversation_id,
            kind: "event",
            author_type: "system",
            author_id: None,
            body: None,
            attachments: None,
            metadata: Some(metadata),
            assignee_id: Some(Some(user_id)),
        },
    )
    .await
    .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(user_id: &str, open: i64) -> Candidate {
        Candidate {
            user_id: user_id.to_owned(),
            open,
        }
    }

    #[test]
    fn normalize_fills_gaps_and_drops_bad_values() {
        let settings = normalize(&json!({
            "mode": "sideways",
            "memberIds": ["u1", "", "u1", 3, "u2"],
            "maxOpenPerMember": 2.5,
        }));
        assert_eq!(settings.mode, "off");
        assert_eq!(settings.member_ids, ["u1", "u2"]);
        assert_eq!(settings.away_member_ids, Vec::<String>::new());
        assert_eq!(settings.max_open_per_member, None);
        assert_eq!(
            normalize(&json!({ "mode": "balanced", "maxOpenPerMember": 3 })).max_open_per_member,
            Some(3)
        );
        assert_eq!(normalize(&Value::Null).mode, "off");
    }

    #[test]
    fn balanced_pick_takes_the_least_loaded_first_in_order() {
        let picked = pick_balanced(
            &[
                candidate("user_c", 1),
                candidate("user_a", 2),
                candidate("user_b", 1),
            ],
            None,
        );
        assert_eq!(picked.as_deref(), Some("user_b"));
    }

    #[test]
    fn balanced_pick_respects_the_cap() {
        let full = [candidate("user_a", 3), candidate("user_b", 3)];
        assert_eq!(pick_balanced(&full, Some(3)), None);
        assert_eq!(pick_balanced(&full, Some(4)).as_deref(), Some("user_a"));
        assert_eq!(pick_balanced(&[], None), None);
    }

    #[test]
    fn ids_order_as_locale_compare_does() {
        assert_eq!(locale_compare("user_2", "user_a"), Ordering::Less);
        assert_eq!(locale_compare("user_a", "user_B"), Ordering::Less);
        assert_eq!(locale_compare("user_b", "user_A"), Ordering::Greater);
        assert_eq!(locale_compare("user_a", "user_A"), Ordering::Less);
        assert_eq!(locale_compare("user_", "user_a"), Ordering::Less);
        assert_eq!(locale_compare("a_b", "ab"), Ordering::Less);
        // ICU orders `_` before `-` (code points say otherwise).
        assert_eq!(locale_compare("user_2", "user-x"), Ordering::Less);
        assert_eq!(locale_compare("a b", "a.b"), Ordering::Less);
    }
}
