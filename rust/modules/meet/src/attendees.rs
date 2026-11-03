//! Meeting attendees: the write path from a request body
//! (`resolveAttendeeWrites`, `toMeetingAttendees`, `withOrganizerAttendee`
//! in `routes/meetings/index.ts`) and the invitation merge
//! (`normalizeInvitees`, `mergeInvitees` in `services/weldmeet/invitations.ts`).
//! An attendee is the stored JSON object (`MeetingAttendee`).

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;

use crate::js::text;
use crate::participants::{self, AvatarStore, Input};

pub(crate) type Attendee = Map<String, Value>;

/// `normalizeEmail`: trimmed, lower case.
pub(crate) fn normalize_email(email: Option<&str>) -> String {
    email.unwrap_or_default().trim().to_lowercase()
}

/// A non-empty string field.
fn non_empty<'a>(attendee: &'a Attendee, key: &str) -> Option<&'a str> {
    attendee
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// `resolveAttendeeWrites(c, db, inputs, stored)`: each new email resolved
/// to a member or person; an email already stored keeps its stored links.
pub(crate) async fn resolve_writes(
    db: &PgPool,
    avatars: &AvatarStore,
    workspace_key: &str,
    inputs: &[Attendee],
    stored: &[Attendee],
) -> Result<Vec<Attendee>, sqlx::Error> {
    let mut stored_by_email: HashMap<String, &Attendee> = HashMap::new();
    for attendee in stored {
        stored_by_email.insert(normalize_email(text_of(attendee, "email")), attendee);
    }
    let mut seen = HashSet::new();
    let mut resolved = Vec::new();
    for input in inputs {
        let email = normalize_email(text_of(input, "email"));
        if email.is_empty() || !seen.insert(email.clone()) {
            continue;
        }
        let status = non_empty(input, "status").map(str::to_owned);
        if let Some(existing) = stored_by_email.get(&email) {
            let mut out = (*existing).clone();
            if let Some(name) = non_empty(input, "name") {
                out.insert("name".into(), json!(name));
            }
            if let Some(avatar) = non_empty(input, "avatar") {
                out.insert("avatar".into(), json!(avatar));
            }
            if let Some(status) = status {
                out.insert("status".into(), json!(status));
            }
            resolved.push(out);
            continue;
        }
        let name = non_empty(input, "name");
        let link = participants::resolve(
            db,
            avatars,
            workspace_key,
            Input {
                email: Some(&email),
                name: text_of(input, "name"),
                user_id: None,
            },
        )
        .await;
        let avatar = non_empty(input, "avatar")
            .map(str::to_owned)
            .or_else(|| link.avatar_url.clone().filter(|a| !a.is_empty()));
        let mut out = Map::new();
        out.insert("email".into(), json!(email));
        // `input.name || link.displayName` (undefined when neither).
        if let Some(name) = name
            .map(str::to_owned)
            .or_else(|| link.display_name.clone().filter(|d| !d.is_empty()))
        {
            out.insert("name".into(), json!(name));
        }
        if let Some(avatar) = avatar {
            out.insert("avatar".into(), json!(avatar));
        }
        if let Some(status) = status {
            out.insert("status".into(), json!(status));
        }
        out.insert("role".into(), json!("attendee"));
        if let Some(member) = link.workspace_member_id.filter(|m| !m.is_empty()) {
            out.insert("workspaceMemberId".into(), json!(member));
        }
        if let Some(person) = link.person_id.filter(|p| !p.is_empty()) {
            out.insert("personId".into(), json!(person));
        }
        resolved.push(out);
    }

    // Members carry their user id (invited-member checks use it).
    let mut member_ids: Vec<String> = Vec::new();
    for attendee in &resolved {
        if let Some(id) = non_empty(attendee, "workspaceMemberId")
            && !member_ids.iter().any(|m| m == id)
        {
            member_ids.push(id.to_owned());
        }
    }
    if !member_ids.is_empty() {
        let rows: Vec<(String, String)> =
            sqlx::query_as("select id, user_id from workspace_members where id = any($1)")
                .bind(&member_ids)
                .fetch_all(db)
                .await?;
        let by_member: HashMap<String, String> = rows.into_iter().collect();
        for attendee in &mut resolved {
            let member = non_empty(attendee, "workspaceMemberId").map(str::to_owned);
            if let Some(member) = member
                && !attendee.contains_key("userId")
            {
                let user = by_member.get(&member).cloned().unwrap_or_default();
                attendee.insert("userId".into(), json!(user));
            }
        }
    }
    Ok(to_meeting_attendees(resolved))
}

fn text_of<'a>(attendee: &'a Attendee, key: &str) -> Option<&'a str> {
    attendee.get(key).and_then(Value::as_str)
}

/// `toMeetingAttendees(input)`: trimmed, lower-cased, de-duplicated emails
/// (first wins) and the defaults (`userId ''`, `name` = email, `pending`,
/// `attendee`).
pub(crate) fn to_meeting_attendees(input: Vec<Attendee>) -> Vec<Attendee> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for mut raw in input {
        let email = normalize_email(text_of(&raw, "email"));
        if email.is_empty() || !seen.insert(email.clone()) {
            continue;
        }
        if raw.get("userId").is_none_or(Value::is_null) {
            raw.insert("userId".into(), json!(""));
        }
        let name = text_of(&raw, "name")
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map_or_else(|| email.clone(), str::to_owned);
        raw.insert("email".into(), json!(email));
        raw.insert("name".into(), json!(name));
        if raw.get("status").is_none_or(Value::is_null) {
            raw.insert("status".into(), json!("pending"));
        }
        if raw.get("role").is_none_or(Value::is_null) {
            raw.insert("role".into(), json!("attendee"));
        }
        out.push(raw);
    }
    out
}

/// `withOrganizerAttendee(db, attendees, organizerId)`: the organizer first
/// (role organizer, accepted) unless already on the list, resolved from
/// `workspace_members`; without a member row the list is left as sent.
pub(crate) async fn with_organizer(
    db: &PgPool,
    attendees: Vec<Attendee>,
    organizer_id: &str,
) -> Result<Vec<Attendee>, sqlx::Error> {
    let member: Option<(String, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "select id, name, email, picture from workspace_members where user_id = $1 limit 1",
    )
    .bind(organizer_id)
    .fetch_optional(db)
    .await?;
    let Some((member_id, name, email, picture)) = member else {
        return Ok(attendees);
    };
    let email = email.map(|e| e.trim().to_lowercase()).unwrap_or_default();
    let is_organizer = |a: &Attendee| {
        text_of(a, "userId") == Some(organizer_id)
            || (!email.is_empty() && text_of(a, "email") == Some(email.as_str()))
    };
    if attendees.iter().any(&is_organizer) {
        return Ok(attendees
            .into_iter()
            .map(|mut a| {
                if is_organizer(&a) {
                    a.insert("userId".into(), json!(organizer_id));
                    a.insert("role".into(), json!("organizer"));
                    a.insert("status".into(), json!("accepted"));
                }
                a
            })
            .collect());
    }
    let display = name
        .filter(|n| !n.is_empty())
        .or_else(|| (!email.is_empty()).then(|| email.clone()))
        .unwrap_or_else(|| "Organizer".to_owned());
    let mut organizer = Map::new();
    organizer.insert("userId".into(), json!(organizer_id));
    organizer.insert("email".into(), json!(email));
    organizer.insert("name".into(), json!(display));
    organizer.insert("status".into(), json!("accepted"));
    organizer.insert("role".into(), json!("organizer"));
    organizer.insert("workspaceMemberId".into(), json!(member_id));
    if let Some(picture) = picture.filter(|p| !p.is_empty()) {
        organizer.insert("avatar".into(), json!(picture));
    }
    let mut out = vec![organizer];
    out.extend(attendees);
    Ok(out)
}

/// An invitee (`InviteeInput`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Invitee {
    pub(crate) email: String,
    pub(crate) name: Option<String>,
}

/// `normalizeInvitees(invitees)`.
pub(crate) fn normalize_invitees(invitees: Vec<Invitee>) -> Vec<Invitee> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for invitee in invitees {
        let email = invitee.email.trim().to_lowercase();
        if email.is_empty() || !seen.insert(email.clone()) {
            continue;
        }
        let name = invitee
            .name
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty());
        out.push(Invitee { email, name });
    }
    out
}

/// `ResolvedInvitee`.
#[derive(Debug, Clone)]
pub(crate) struct ResolvedInvitee {
    pub(crate) email: String,
    pub(crate) name: String,
    pub(crate) user_id: String,
    pub(crate) avatar: Option<String>,
    pub(crate) workspace_member_id: Option<String>,
    pub(crate) person_id: Option<String>,
}

/// `mergeInvitees(existing, invitees)`: `(attendees, added, alreadyInvited)`.
pub(crate) fn merge_invitees(
    existing: &[Attendee],
    invitees: &[ResolvedInvitee],
) -> (Vec<Attendee>, Vec<Attendee>, Vec<String>) {
    let mut attendees: Vec<Attendee> = existing.to_vec();
    let mut added_at: Vec<usize> = Vec::new();
    let mut already = Vec::new();
    for invitee in invitees {
        let matched = attendees.iter().position(|a| {
            text_of(a, "email")
                .filter(|e| !e.is_empty())
                .is_some_and(|e| e.to_lowercase() == invitee.email)
                || (!invitee.user_id.is_empty()
                    && text_of(a, "userId") == Some(invitee.user_id.as_str()))
        });
        if let Some(index) = matched {
            if text_of(&attendees[index], "source") == Some("walk_in") {
                attendees[index].remove("source");
                added_at.push(index);
            } else {
                already.push(invitee.email.clone());
            }
            continue;
        }
        let mut attendee = Map::new();
        attendee.insert("userId".into(), json!(invitee.user_id));
        attendee.insert("email".into(), json!(invitee.email));
        attendee.insert("name".into(), json!(invitee.name));
        attendee.insert("status".into(), json!("pending"));
        attendee.insert("role".into(), json!("attendee"));
        if let Some(avatar) = invitee.avatar.as_deref().filter(|a| !a.is_empty()) {
            attendee.insert("avatar".into(), json!(avatar));
        }
        if let Some(member) = invitee
            .workspace_member_id
            .as_deref()
            .filter(|m| !m.is_empty())
        {
            attendee.insert("workspaceMemberId".into(), json!(member));
        }
        if let Some(person) = invitee.person_id.as_deref().filter(|p| !p.is_empty()) {
            attendee.insert("personId".into(), json!(person));
        }
        attendees.push(attendee);
        added_at.push(attendees.len() - 1);
    }
    // `added` holds the same objects as `attendees` (a walk-in promoted after
    // a later change is the changed object).
    let added = added_at.iter().map(|&i| attendees[i].clone()).collect();
    (attendees, added, already)
}

/// The stored attendee list of a meeting row (`existing.attendees ?? []`).
pub(crate) fn stored(row: &Value) -> Vec<Attendee> {
    row.get("attendees")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_object().cloned())
                .collect()
        })
        .unwrap_or_default()
}

/// Whether `user_id` is an invited (not walk-in) attendee.
pub(crate) fn is_invited_member(attendees: &[Attendee], user_id: &str) -> bool {
    attendees.iter().any(|a| {
        text(&Value::Object(a.clone()), "userId") == Some(user_id)
            && text_of(a, "source") != Some("walk_in")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attendee(value: Value) -> Attendee {
        match value {
            Value::Object(object) => object,
            other => panic!("not an object: {other}"),
        }
    }

    #[test]
    fn merges_invitees_like_the_worker() {
        let existing = vec![
            attendee(
                json!({ "userId": "u1", "email": "a@x.io", "name": "A", "status": "accepted", "role": "attendee" }),
            ),
            attendee(
                json!({ "userId": "", "email": "walk@x.io", "name": "W", "status": "pending", "role": "attendee", "source": "walk_in" }),
            ),
        ];
        let invitee = |email: &str, user: &str| ResolvedInvitee {
            email: email.into(),
            name: email.into(),
            user_id: user.into(),
            avatar: None,
            workspace_member_id: None,
            person_id: None,
        };
        let (attendees, added, already) = merge_invitees(
            &existing,
            &[
                invitee("a@x.io", ""),
                invitee("walk@x.io", ""),
                invitee("new@x.io", "u9"),
            ],
        );
        assert_eq!(already, vec!["a@x.io".to_owned()]);
        assert_eq!(added.len(), 2);
        assert!(!attendees[1].contains_key("source"));
        assert_eq!(attendees[2]["userId"], "u9");
        assert_eq!(
            normalize_invitees(vec![
                Invitee {
                    email: " A@X.io ".into(),
                    name: Some(" Ann ".into())
                },
                Invitee {
                    email: "a@x.io".into(),
                    name: None
                },
            ]),
            vec![Invitee {
                email: "a@x.io".into(),
                name: Some("Ann".into())
            }]
        );
    }
}
