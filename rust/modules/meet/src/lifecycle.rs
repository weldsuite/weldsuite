//! Ending sessions and "one live call at a time"
//! (`@weldsuite/meet-domain/meeting-lifecycle` and `leave-other-sessions`):
//! end a session for everyone, end it only once the video provider reports
//! the room empty, drop a user from every other session they are in, and
//! drop their older connection to the session they joined again.
//!
//! The worker also leaves the user's WeldChat calls
//! (`@weldsuite/chat-domain/call-participants`). The Kubernetes editions have
//! no WeldChat calls (`chat-calls` is unavailable there), so there is never
//! a ringing or active call to leave and that half is not ported.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::MEETING_SESSION_UPDATED;
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_ports::DynCache;
use weldsuite_video_rooms::DynVideoRooms;

use crate::js::{now_ms, parse_ms, text};
use crate::tables::{MEETING_SESSIONS, MEETINGS};
use crate::{MeetState, now, publish, publish_system};

/// What the lifecycle needs besides the database.
#[derive(Clone)]
pub(crate) struct Env {
    pub(crate) video: Arc<dyn DynVideoRooms>,
    pub(crate) cache: Option<Arc<dyn DynCache>>,
}

/// `isMeetingPast(meeting, now)`: a scheduled meeting is past once its end
/// (or start + 1h without one) has gone by; unscheduled rooms never are.
pub(crate) fn is_meeting_past(
    scheduled_start: Option<&str>,
    scheduled_end: Option<&str>,
    now: i64,
) -> bool {
    if let Some(end) = scheduled_end {
        return parse_ms(end).is_some_and(|end| end < now);
    }
    if let Some(start) = scheduled_start {
        return parse_ms(start).is_some_and(|start| start < now - 60 * 60_000);
    }
    false
}

/// `LinkedPerson`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LinkedPerson {
    pub(crate) person_id: Option<String>,
    pub(crate) contact_id: Option<String>,
}

fn link_of(entry: &Value, key: &str) -> Option<String> {
    entry
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

/// `collectLinkedPeople(participants, attendees)`: one entry per person
/// (personId, else contactId), in first-seen order.
pub(crate) fn collect_linked_people(
    participants: &[Value],
    attendees: &[Value],
) -> Vec<LinkedPerson> {
    let mut by_person: Vec<LinkedPerson> = Vec::new();
    let mut person_index: HashMap<String, usize> = HashMap::new();
    let mut contact_only: Vec<LinkedPerson> = Vec::new();
    let mut contact_seen: HashSet<String> = HashSet::new();
    for raw in participants.iter().chain(attendees) {
        let person_id = link_of(raw, "personId");
        let contact_id = link_of(raw, "contactId");
        if person_id.is_none() && contact_id.is_none() {
            continue;
        }
        if let Some(person) = person_id {
            if let Some(&index) = person_index.get(&person) {
                let existing = &mut by_person[index];
                if existing.contact_id.is_none() {
                    existing.contact_id = contact_id;
                }
            } else {
                person_index.insert(person.clone(), by_person.len());
                by_person.push(LinkedPerson {
                    person_id: Some(person),
                    contact_id,
                });
            }
        } else if let Some(contact) = contact_id
            && contact_seen.insert(contact.clone())
        {
            contact_only.push(LinkedPerson {
                person_id: None,
                contact_id: Some(contact),
            });
        }
    }
    let covered: HashSet<String> = by_person
        .iter()
        .filter_map(|p| p.contact_id.clone())
        .collect();
    by_person
        .into_iter()
        .chain(
            contact_only
                .into_iter()
                .filter(|p| p.contact_id.as_ref().is_none_or(|c| !covered.contains(c))),
        )
        .collect()
}

/// `title.slice(0, 255)` in UTF-16 units.
fn slice_utf16(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in text.chars() {
        units += ch.len_utf16();
        if units > max {
            break;
        }
        out.push(ch);
    }
    out
}

/// `logMeetingActivities`: one completed `meeting` activity per linked CRM
/// person, assigned to the organizer. Best effort.
async fn log_meeting_activities(
    db: &PgPool,
    meeting_id: &str,
    session_id: &str,
    participants: &[Value],
    started_at: Option<&str>,
    ended_at: &str,
    duration_seconds: i64,
) {
    let result: Result<(), sqlx::Error> = async {
        let meeting: Option<(String, String, Option<Value>, Option<String>)> = sqlx::query_as(
            "select title, organizer_id, attendees, calendar_event_id from meetings where id = $1 limit 1",
        )
        .bind(meeting_id)
        .fetch_optional(db)
        .await?;
        let Some((title, organizer_id, attendees, calendar_event_id)) = meeting else {
            return Ok(());
        };
        let attendees = attendees
            .and_then(|a| a.as_array().cloned())
            .unwrap_or_default();
        let people = collect_linked_people(participants, &attendees);
        if people.is_empty() {
            return Ok(());
        }
        let now = now();
        #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
        let minutes = (duration_seconds as f64 / 60.0 + 0.5).floor() as i64;
        let start = started_at.unwrap_or(ended_at);
        let subject = slice_utf16(&title, 255);
        let ids: Vec<String> = people.iter().map(|_| generate_id("act")).collect();
        let person_ids: Vec<Option<String>> = people.iter().map(|p| p.person_id.clone()).collect();
        let contact_ids: Vec<Option<String>> = people
            .iter()
            .map(|p| p.contact_id.clone().or_else(|| p.person_id.clone()))
            .collect();
        sqlx::query(
            "insert into crm_activities (id, type, subject, status, is_virtual, assigned_to_id,
                 person_id, contact_id, start_time, end_time, duration, calendar_event_id,
                 created_at, updated_at)
             select u.id, 'meeting', $4, 'completed', true, $5, u.person_id, u.contact_id,
                 $6::timestamp, $7::timestamp, $8, $9, $10::timestamp, $10::timestamp
             from unnest($1::varchar[], $2::varchar[], $3::varchar[]) as u(id, person_id, contact_id)",
        )
        .bind(&ids)
        .bind(&person_ids)
        .bind(&contact_ids)
        .bind(&subject)
        .bind(&organizer_id)
        .bind(start)
        .bind(ended_at)
        .bind(i32::try_from(minutes).unwrap_or(i32::MAX))
        .bind(&calendar_event_id)
        .bind(&now)
        .execute(db)
        .await?;
        Ok(())
    }
    .await;
    if let Err(error) = result {
        tracing::error!(%error, session_id, meeting_id, "[MeetingLifecycle] CRM activity logging failed");
    }
}

/// `endMeetingSession(db, env, orgId, sessionId, session, meetingId)`: claim
/// the end (the first writer wins), release the meeting, tear down the
/// room, drop the 24 h mapping, log the CRM activities, publish.
pub(crate) async fn end_session(
    state: &MeetState,
    env: &Env,
    db: &PgPool,
    org_id: &str,
    session_id: &str,
    session: &Value,
    meeting_id: &str,
) -> Result<(), sqlx::Error> {
    let now_ms = now_ms();
    let ended_at = crate::js::iso_of_ms(now_ms);
    let started_at = text(session, "startedAt").map(str::to_owned);
    let duration = started_at.as_deref().and_then(parse_ms).map_or(0, |start| {
        #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
        let seconds = ((now_ms - start) as f64 / 1000.0 + 0.5).floor() as i64;
        seconds
    });
    let claimed: Option<Option<Value>> = sqlx::query_scalar(
        "update meeting_sessions set status = 'ended', ended_at = $2::timestamp, duration = $3,
             participants = (
               select coalesce(
                 jsonb_agg(
                   case when coalesce(e.p->>'leftAt', '') = ''
                     then e.p || jsonb_build_object('leftAt', $4::text)
                     else e.p
                   end
                   order by e.ord
                 ),
                 '[]'::jsonb
               )
               from jsonb_array_elements(coalesce(meeting_sessions.participants, '[]'::jsonb)) with ordinality as e(p, ord)
             ),
             recording_status = case when recording_status = 'recording' then 'processing' else recording_status end,
             recording_enabled = case when recording_status = 'recording' then false else recording_enabled end,
             updated_at = $2::timestamp
         where id = $1 and status <> 'ended'
         returning participants",
    )
    .bind(session_id)
    .bind(&ended_at)
    .bind(i32::try_from(duration).unwrap_or(i32::MAX))
    .bind(&ended_at)
    .fetch_optional(db)
    .await?;
    let Some(participants) = claimed else {
        return Ok(());
    };
    let participants = participants
        .and_then(|p| p.as_array().cloned())
        .unwrap_or_default();

    let schedule: Option<(Option<Value>, Option<Value>)> = sqlx::query_as(
        "select to_jsonb(scheduled_end), to_jsonb(scheduled_start) from meetings where id = $1 limit 1",
    )
    .bind(meeting_id)
    .fetch_optional(db)
    .await?;
    let (end, start) = schedule.unwrap_or((None, None));
    let past = is_meeting_past(
        start.as_ref().and_then(Value::as_str),
        end.as_ref().and_then(Value::as_str),
        now_ms,
    );
    let meeting_status = if past { "completed" } else { "scheduled" };
    sqlx::query(
        "update meetings set active_session_id = null, status = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(meeting_id)
    .bind(meeting_status)
    .bind(&ended_at)
    .execute(db)
    .await?;

    if let Some(room) = text(session, "cfAppId").filter(|r| !r.is_empty()) {
        if let Err(error) = env.video.kick_all(room).await {
            tracing::error!(%error, session_id, room, "[MeetingLifecycle] RTK kick-all failed");
        }
        if let Err(error) = env.video.end_room(room).await {
            tracing::error!(%error, session_id, room, "[MeetingLifecycle] RTK end meeting failed");
        }
        if let Some(cache) = &env.cache {
            let _ = cache.delete_boxed(&format!("rtk-meeting:{room}")).await;
        }
    }

    log_meeting_activities(
        db,
        meeting_id,
        session_id,
        &participants,
        started_at.as_deref(),
        &ended_at,
        duration,
    )
    .await;

    publish::session_ended(
        state,
        org_id,
        meeting_id,
        session_id,
        duration,
        meeting_status,
    )
    .await;
    Ok(())
}

/// `EndIfEmptyOutcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EndIfEmpty {
    Ended,
    Occupied,
    Unknown,
}

/// `endMeetingSessionIfEmpty`: end only once the provider reports nobody
/// connected; a provider that can't be asked keeps the session.
pub(crate) async fn end_session_if_empty(
    state: &MeetState,
    env: &Env,
    db: &PgPool,
    org_id: &str,
    session_id: &str,
    session: &Value,
    meeting_id: &str,
) -> Result<EndIfEmpty, sqlx::Error> {
    if let Some(room) = text(session, "cfAppId").filter(|r| !r.is_empty()) {
        match env.video.live_participant_count(room).await {
            Ok(0) => {}
            Ok(_) => return Ok(EndIfEmpty::Occupied),
            Err(error) => {
                tracing::error!(%error, session_id, room, "[MeetingLifecycle] RTK live participant check failed, keeping the session");
                return Ok(EndIfEmpty::Unknown);
            }
        }
    }
    end_session(state, env, db, org_id, session_id, session, meeting_id).await?;
    Ok(EndIfEmpty::Ended)
}

/// `supersededCfSessionId(previous, newCfSessionId)`: the still-live older
/// connection to evict, if any.
pub(crate) fn superseded_cf_session_id(previous: Option<&Value>, new_id: &str) -> Option<String> {
    let previous = previous?;
    if crate::js::truthy(previous.get("leftAt")) {
        return None;
    }
    let old = text(previous, "cfSessionId").filter(|id| !id.is_empty())?;
    (old != new_id).then(|| old.to_owned())
}

/// Disconnect one participant; best effort.
async fn evict(env: &Env, room: Option<&str>, participant: Option<&str>, session_id: &str) {
    let (Some(room), Some(participant)) = (
        room.filter(|r| !r.is_empty()),
        participant.filter(|p| !p.is_empty()),
    ) else {
        return;
    };
    if let Err(error) = env.video.remove_participant(room, participant).await {
        tracing::error!(%error, session_id, room, "[MeetingLeaveOthers] RTK participant removal failed");
    }
}

/// `evictSupersededConnection`: announce `call_superseded` with the evicted
/// id, then remove that older connection.
pub(crate) async fn evict_superseded(
    state: &MeetState,
    env: &Env,
    org_id: &str,
    user_id: &str,
    session: &Value,
    old_cf_session_id: &str,
) {
    let session_id = text(session, "id").unwrap_or_default();
    publish::call_superseded(
        state,
        org_id,
        user_id,
        json!({
            "kind": "meet",
            "id": session_id,
            "meetingId": session["meetingId"],
            "cfSessionId": old_cf_session_id,
        }),
    )
    .await;
    evict(
        env,
        text(session, "cfAppId"),
        Some(old_cf_session_id),
        session_id,
    )
    .await;
}

/// The latest moment an entry was (re)joined (`latestJoinMs`).
fn latest_join_ms(participant: &Value) -> i64 {
    let joined = text(participant, "joinedAt")
        .and_then(parse_ms)
        .unwrap_or(0);
    let last = text(participant, "lastJoinAt")
        .and_then(parse_ms)
        .unwrap_or(0);
    joined.max(last)
}

/// `leaveOtherMeetingSessions(db, env, orgId, userId, exceptSessionId, { triggeredAt })`.
pub(crate) async fn leave_other_sessions(
    state: &MeetState,
    env: &Env,
    db: &PgPool,
    org_id: &str,
    user_id: &str,
    except_session_id: Option<&str>,
    triggered_at: i64,
) {
    let needle = json!([{ "userId": user_id }]).to_string();
    let sessions: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from meeting_sessions t
         where t.status in ('waiting', 'active') and t.participants @> $1::jsonb",
    )
    .bind(&needle)
    .fetch_all(db)
    .await;
    let sessions = match sessions {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "[MeetingLeaveOthers] leaveOtherMeetingSessions failed");
            return;
        }
    };
    for session in sessions {
        let session = MEETING_SESSIONS.js(session);
        let id = text(&session, "id").unwrap_or_default().to_owned();
        if Some(id.as_str()) == except_session_id {
            continue;
        }
        if let Err(error) =
            leave_session(state, env, db, org_id, user_id, &session, triggered_at).await
        {
            tracing::error!(%error, session_id = %id, "[MeetingLeaveOthers] leaving session failed");
        }
    }
}

/// `leaveSession`: announce, evict, stamp `leftAt` on that connection, end
/// the session when nobody is left and the provider agrees.
async fn leave_session(
    state: &MeetState,
    env: &Env,
    db: &PgPool,
    org_id: &str,
    user_id: &str,
    session: &Value,
    triggered_at: i64,
) -> Result<(), sqlx::Error> {
    let participants = session["participants"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let Some(mine) = participants
        .iter()
        .find(|p| text(p, "userId") == Some(user_id) && !crate::js::truthy(p.get("leftAt")))
    else {
        return Ok(());
    };
    if latest_join_ms(mine) > triggered_at {
        return Ok(());
    }
    let session_id = text(session, "id").unwrap_or_default();
    let cf_session_id = text(mine, "cfSessionId").filter(|id| !id.is_empty());
    publish::call_superseded(
        state,
        org_id,
        user_id,
        json!({
            "kind": "meet",
            "id": session_id,
            "meetingId": session["meetingId"],
            "cfSessionId": cf_session_id,
        }),
    )
    .await;
    evict(env, text(session, "cfAppId"), cf_session_id, session_id).await;

    let left_at = now();
    let updated: Option<Option<Value>> = sqlx::query_scalar(
        "update meeting_sessions set participants = (
           select coalesce(
             jsonb_agg(
               case when e.p->>'userId' = $2
                      and coalesce(e.p->>'leftAt', '') = ''
                      and coalesce(e.p->>'cfSessionId', '') = $3
                 then e.p || jsonb_build_object('leftAt', $4::text)
                 else e.p
               end
               order by e.ord
             ),
             '[]'::jsonb
           )
           from jsonb_array_elements(coalesce(meeting_sessions.participants, '[]'::jsonb)) with ordinality as e(p, ord)
         ), updated_at = $4::timestamp
         where id = $1 and status <> 'ended'
         returning participants",
    )
    .bind(session_id)
    .bind(user_id)
    .bind(text(mine, "cfSessionId").unwrap_or_default())
    .bind(&left_at)
    .fetch_optional(db)
    .await?;
    let Some(participants) = updated else {
        return Ok(());
    };
    let participants = participants.unwrap_or_else(|| json!([]));
    let mut data = session.clone();
    data["participants"] = participants.clone();
    publish_system(
        state,
        org_id,
        "system",
        MEETING_SESSION_UPDATED,
        session_id,
        data,
    );

    let everyone_left = participants
        .as_array()
        .is_none_or(|all| all.iter().all(|p| crate::js::truthy(p.get("leftAt"))));
    if everyone_left {
        let meeting_id = text(session, "meetingId").unwrap_or_default().to_owned();
        end_session_if_empty(state, env, db, org_id, session_id, session, &meeting_id).await?;
    }
    Ok(())
}

/// A meeting row as Drizzle's `select()` returns it.
pub(crate) async fn meeting_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from meetings t where t.id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|row| MEETINGS.js(row)))
}

/// A session row as Drizzle's `select()` returns it (`loadSession`).
pub(crate) async fn session_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from meeting_sessions t where t.id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|row| MEETING_SESSIONS.js(row)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_each_linked_person_once() {
        let participants = vec![
            json!({ "personId": "p1" }),
            json!({ "contactId": "c2" }),
            json!({ "userId": "u1" }),
        ];
        let attendees = vec![
            json!({ "personId": "p1", "contactId": "c1" }),
            json!({ "contactId": "c1" }),
        ];
        let people = collect_linked_people(&participants, &attendees);
        assert_eq!(
            people,
            vec![
                LinkedPerson {
                    person_id: Some("p1".into()),
                    contact_id: Some("c1".into())
                },
                LinkedPerson {
                    person_id: None,
                    contact_id: Some("c2".into())
                },
            ]
        );
    }

    #[test]
    fn past_meetings_follow_their_schedule() {
        let now = parse_ms("2026-10-01T12:00:00.000Z").expect("ms");
        assert!(is_meeting_past(None, Some("2026-10-01T11:00:00.000Z"), now));
        assert!(!is_meeting_past(
            Some("2026-10-01T11:30:00.000Z"),
            None,
            now
        ));
        assert!(is_meeting_past(Some("2026-10-01T10:30:00.000Z"), None, now));
        assert!(!is_meeting_past(None, None, now));
        assert_eq!(
            superseded_cf_session_id(Some(&json!({ "cfSessionId": "old" })), "new"),
            Some("old".into())
        );
        assert_eq!(
            superseded_cf_session_id(Some(&json!({ "cfSessionId": "new" })), "new"),
            None
        );
    }
}
