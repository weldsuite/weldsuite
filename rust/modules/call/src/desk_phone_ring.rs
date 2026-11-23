//! Ringing agents' browsers for a waiting WeldDesk phone call
//! (`services/desk-phone-ring.ts`).
//!
//! A round dials every ringable member (up to 10) on their own softphone
//! credential: `sip:<sipUsername>@sip.telnyx.com` on the voice connection,
//! one `desk_phone_call_legs` row per dialled leg. The legs carry a
//! `client_state` of `{ workspaceId, agentLegId, parentCallId }` (no
//! `callId`), so the call's own webhook dispatch never mistakes an agent leg
//! for the call.
//!
//! A member has at most one ringing leg per call (the partial unique index
//! `desk_phone_call_legs_ringing_uidx`): the leg's row is inserted first and
//! the browser is dialled only when the insert went in, so two webhooks that
//! start a round for one call at the same moment dial each member once. A
//! leg only ever goes from `ringing` to `answered` or `ended`.
//!
//! The worker rings a round's members at once (`Promise.all`); here they are
//! rung one after the other, in the same order, which dials and tells them
//! in the order the worker does.

use sea_orm::sea_query::{Expr, Func, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, EntityTrait, Order, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_desk_domain::assignment;
use weldsuite_kit::RequestEnv;
use weldsuite_kit::validation::js_trim;
use weldsuite_ports::PresenceReader;
use weldsuite_schema::tenant::{
    desk_conversations, desk_phone_agents, desk_phone_call_legs as legs, voip_calls,
    workspace_members,
};

use crate::desk_phone_options;
use crate::desk_phone_realtime::{online_user_ids, send_inbox_event, waiting_calls};
use crate::js::{self, Ordered};
use crate::telnyx::{Dial, Telnyx, encode_client_state};
use crate::{CallState, crm, env_value};

/// `PhoneCtx` (`{ env, db, workspaceId }`): what the phone flows work with.
#[derive(Clone, Copy)]
pub(crate) struct Phone<'a> {
    pub(crate) state: &'a CallState,
    /// The workspace's tenant database.
    pub(crate) db: &'a PgPool,
    /// The Clerk org id: what `client_state`, realtime and the tenant lookup
    /// key on.
    pub(crate) workspace: &'a str,
    pub(crate) telnyx: &'a Telnyx,
    /// The request's env (conformance), else the process's.
    pub(crate) env: Option<&'a RequestEnv>,
    /// The request's presence source (conformance), else the realtime
    /// publisher's.
    pub(crate) presence: Option<&'a PresenceReader>,
}

impl Phone<'_> {
    /// `env.<name>`.
    pub(crate) fn env(&self, name: &str) -> Option<String> {
        env_value(self.env, name)
    }
}

const SIP_DOMAIN: &str = "sip.telnyx.com";
/// A leg that rang less than this and hung up does not start another round
/// (a broken credential must not spin a dial loop).
pub(crate) const MIN_RING_MS_FOR_NEXT_ROUND: i64 = 10_000;
const MAX_LEGS_PER_CALL: i64 = 40;
const MAX_LEGS_PER_ROUND: usize = 10;
/// How far back an unfinished call or leg still makes a member busy.
const BUSY_WINDOW: time::Duration = time::Duration::hours(4);

/// `sipAddress(sipUsername)`.
fn sip_address(sip_username: &str) -> String {
    format!("sip:{sip_username}@{SIP_DOMAIN}")
}

/// `VoipCallRow`: what the phone flows read of a `voip_calls` row.
#[derive(Debug, Clone)]
pub(crate) struct Call {
    pub(crate) id: String,
    pub(crate) user_id: String,
    /// The caller leg's `call_control_id`.
    pub(crate) provider_call_id: Option<String>,
    pub(crate) desk_conversation_id: Option<String>,
    pub(crate) from_number: String,
    pub(crate) to_number: String,
    pub(crate) department_id: Option<String>,
    pub(crate) is_recorded: bool,
    pub(crate) answered_by_user_id: Option<String>,
    /// `(queueEnteredAt ?? initiatedAt).toISOString()`.
    waiting_since: Value,
    /// `isWaitingCall(call)`.
    pub(crate) waiting: bool,
}

impl Call {
    /// A `voip_calls` row.
    pub(crate) fn from_model(model: voip_calls::Model) -> Self {
        Self::from_js(&serde_json::to_value(model).unwrap_or_default())
    }

    /// A `to_jsonb(voip_calls)` row.
    #[cfg(test)]
    fn from_row(row: Value) -> Self {
        Self::from_js(&weldsuite_db::js_row(row))
    }

    /// The row as Drizzle returns it.
    fn from_js(row: &Value) -> Self {
        let text = |key: &str| row[key].as_str().map(str::to_owned);
        let queued = &row["queueEnteredAt"];
        Self {
            id: text("id").unwrap_or_default(),
            user_id: text("userId").unwrap_or_default(),
            provider_call_id: text("providerCallId"),
            desk_conversation_id: text("deskConversationId"),
            from_number: text("fromNumber").unwrap_or_default(),
            to_number: text("toNumber").unwrap_or_default(),
            department_id: text("departmentId"),
            is_recorded: row["isRecorded"] == true,
            answered_by_user_id: text("answeredByUserId"),
            waiting_since: if queued.is_null() {
                row["initiatedAt"].clone()
            } else {
                queued.clone()
            },
            waiting: js::truthy(queued)
                && !js::truthy(&row["agentAnsweredAt"])
                && !js::truthy(&row["endedAt"])
                && !js::truthy(&row["outcome"]),
        }
    }

    /// The caller leg's `call_control_id`, when it has one.
    pub(crate) fn control(&self) -> Option<&str> {
        self.provider_call_id.as_deref().filter(|id| !id.is_empty())
    }

    /// The call's desk conversation, when it has one.
    pub(crate) fn conversation(&self) -> Option<&str> {
        self.desk_conversation_id
            .as_deref()
            .filter(|id| !id.is_empty())
    }
}

/// `loadCall(db, callId)`.
pub(crate) async fn load_call(db: &PgPool, call_id: &str) -> Result<Option<Call>, String> {
    let row = voip_calls::Entity::find()
        .filter(voip_calls::Column::Id.eq(call_id))
        .one(&orm(db))
        .await
        .map_err(|error| error.to_string())?;
    Ok(row.map(Call::from_model))
}

/// `loadWaitingCall(db, callId)`: the call, when it is still waiting for an
/// agent.
pub(crate) async fn load_waiting_call(db: &PgPool, call_id: &str) -> Result<Option<Call>, String> {
    let row = voip_calls::Entity::find()
        .filter(voip_calls::Column::Id.eq(call_id))
        .filter(waiting_calls())
        .one(&orm(db))
        .await
        .map_err(|error| error.to_string())?;
    Ok(row.map(Call::from_model))
}

/// `floor(extract(epoch from at) * 1000)`: a `timestamp` (UTC) in
/// milliseconds since the epoch.
pub(crate) fn epoch_ms(at: PrimitiveDateTime) -> i64 {
    let nanos = at.assume_utc().unix_timestamp_nanos().div_euclid(1_000_000);
    i64::try_from(nanos).unwrap_or(i64::MAX)
}

/// `StaffedAgent`: a member who could be rung, and their SIP username.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StaffedAgent {
    pub(crate) user_id: String,
    pub(crate) sip_username: String,
}

/// `staffedAgents(db, departmentId)`: members who could take a call of this
/// team before presence and busy are looked at: `available`, with a
/// credential, an active internal member, not marked away, and in the team
/// when the team has members.
pub(crate) async fn staffed_agents(
    db: &PgPool,
    department_id: Option<&str>,
) -> Result<Vec<StaffedAgent>, String> {
    let rows: Vec<(String, Option<String>)> = desk_phone_agents::Entity::find()
        .select_only()
        .columns([
            desk_phone_agents::Column::UserId,
            desk_phone_agents::Column::SipUsername,
        ])
        .filter(desk_phone_agents::Column::Available.eq(true))
        .filter(desk_phone_agents::Column::SipUsername.is_not_null())
        .into_tuple()
        .all(&orm(db))
        .await
        .map_err(|error| error.to_string())?;
    let with_sip: Vec<StaffedAgent> = rows
        .into_iter()
        .filter_map(|(user_id, sip_username)| {
            sip_username
                .filter(|sip| !sip.is_empty())
                .map(|sip_username| StaffedAgent {
                    user_id,
                    sip_username,
                })
        })
        .collect();
    if with_sip.is_empty() {
        return Ok(Vec::new());
    }
    let settings = assignment::settings(db)
        .await
        .map_err(|error| error.to_string())?;
    let team = assignment::team_member_ids(db, department_id)
        .await
        .map_err(|error| error.to_string())?;
    let wanted: Vec<StaffedAgent> = with_sip
        .into_iter()
        .filter(|agent| {
            !settings.away_member_ids.contains(&agent.user_id)
                && team
                    .as_ref()
                    .is_none_or(|team| team.contains(&agent.user_id))
        })
        .collect();
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = wanted.iter().map(|agent| agent.user_id.clone()).collect();
    let upper = |column: workspace_members::Column| Expr::from(Func::upper(Expr::col(column)));
    let active: Vec<String> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::UserId)
        .filter(workspace_members::Column::UserId.is_in(ids))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .filter(sea_orm::ExprTrait::eq(
            upper(workspace_members::Column::Status),
            "ACTIVE",
        ))
        .filter(sea_orm::ExprTrait::eq(
            upper(workspace_members::Column::MemberType),
            "INTERNAL",
        ))
        .into_tuple()
        .all(&orm(db))
        .await
        .map_err(|error| error.to_string())?;
    Ok(wanted
        .into_iter()
        .filter(|agent| active.contains(&agent.user_id))
        .collect())
}

/// `busyUserIds(db, userIds, exceptCallIds)`: members already on a call, i.e.
/// a leg of theirs ringing or answered, or an unfinished call of theirs
/// started in the last 4 hours (a caller still waiting for an agent is not
/// "theirs" yet, whoever the number is assigned to).
async fn busy_user_ids(
    db: &PgPool,
    user_ids: &[String],
    except_call_ids: &[&str],
) -> Result<Vec<String>, String> {
    if user_ids.is_empty() {
        return Ok(Vec::new());
    }
    let cutoff = utc_timestamp(OffsetDateTime::now_utc() - BUSY_WINDOW);
    let orm = orm(db);
    let mut busy: Vec<String> = legs::Entity::find()
        .select_only()
        .column(legs::Column::UserId)
        .filter(legs::Column::UserId.is_in(user_ids.iter().cloned()))
        .filter(legs::Column::Status.is_in(["ringing", "answered"]))
        .filter(legs::Column::CreatedAt.gt(cutoff))
        .into_tuple()
        .all(&orm)
        .await
        .map_err(|error| error.to_string())?;
    let mut on_calls = voip_calls::Entity::find()
        .select_only()
        .column(voip_calls::Column::UserId)
        .filter(voip_calls::Column::UserId.is_in(user_ids.iter().cloned()))
        .filter(voip_calls::Column::EndedAt.is_null())
        .filter(voip_calls::Column::InitiatedAt.gt(cutoff));
    // `id <> all('{}')` holds for every call.
    if !except_call_ids.is_empty() {
        on_calls = on_calls.filter(voip_calls::Column::Id.is_not_in(except_call_ids.iter().copied()));
    }
    let on_calls: Vec<String> = on_calls
        .filter(
            sea_orm::Condition::any()
                .add(voip_calls::Column::QueueEnteredAt.is_null())
                .add(voip_calls::Column::AgentAnsweredAt.is_not_null()),
        )
        .into_tuple()
        .all(&orm)
        .await
        .map_err(|error| error.to_string())?;
    busy.extend(on_calls);
    Ok(busy)
}

/// `byIdleTime(db, agents)`: longest idle first (never answered a call
/// counts as longest), then by user id.
async fn by_idle_time(db: &PgPool, agents: Vec<StaffedAgent>) -> Result<Vec<StaffedAgent>, String> {
    if agents.len() <= 1 {
        return Ok(agents);
    }
    let ids: Vec<String> = agents.iter().map(|agent| agent.user_id.clone()).collect();
    let last: Vec<(Option<String>, Option<PrimitiveDateTime>)> = voip_calls::Entity::find()
        .select_only()
        .column(voip_calls::Column::AnsweredByUserId)
        .column_as(voip_calls::Column::AgentAnsweredAt.max(), "last_answered_at")
        .filter(voip_calls::Column::AnsweredByUserId.is_in(ids))
        .group_by(voip_calls::Column::AnsweredByUserId)
        .into_tuple()
        .all(&orm(db))
        .await
        .map_err(|error| error.to_string())?;
    let last_answer = |agent: &StaffedAgent| {
        last.iter()
            .find(|(user, _)| user.as_deref() == Some(agent.user_id.as_str()))
            .and_then(|(_, at)| *at)
            .map_or(0, epoch_ms)
    };
    let mut sorted = agents;
    sorted.sort_by(|x, y| {
        last_answer(x)
            .cmp(&last_answer(y))
            .then_with(|| js::locale_compare(&x.user_id, &y.user_id))
    });
    Ok(sorted)
}

/// `conversationCallerName(name, fromNumber)`: the conversation's name when
/// it is a name, not just the number.
pub(crate) fn conversation_caller_name(name: Option<&str>, from_number: &str) -> Option<String> {
    name.map(js_trim)
        .filter(|name| !name.is_empty() && *name != from_number)
        .map(str::to_owned)
}

/// `describeCaller(db, call)`: the caller as the rung members see them,
/// `(callerName, customerName)`.
async fn describe_caller(
    db: &PgPool,
    call: &Call,
) -> Result<(Option<String>, Option<String>), String> {
    let mut caller_name = None;
    let mut customer_name = None;
    if let Some(conversation) = call.conversation() {
        let name: Option<Option<String>> = desk_conversations::Entity::find()
            .select_only()
            .column(desk_conversations::Column::Name)
            .filter(desk_conversations::Column::Id.eq(conversation))
            .limit(1)
            .into_tuple()
            .one(&orm(db))
            .await
            .map_err(|error| error.to_string())?;
        caller_name = conversation_caller_name(name.flatten().as_deref(), &call.from_number);
    }
    match crm::match_caller(db, &call.from_number).await {
        Ok(matched) => {
            caller_name = matched.caller_name.or(caller_name);
            customer_name = matched.customer_name;
        }
        Err(error) => tracing::error!(%error, "[desk-phone] CRM caller match failed"),
    }
    Ok((caller_name, customer_name))
}

/// `incomingEvent(ctx, call)`: the `phone.incoming` event of a call
/// (`PhoneIncomingEvent`).
async fn incoming_event(phone: &Phone<'_>, call: &Call) -> Result<Value, String> {
    let (caller_name, customer_name) = describe_caller(phone.db, call).await?;
    Ok(json!({
        "callId": call.id,
        "conversationId": call.desk_conversation_id,
        "fromNumber": call.from_number,
        "callerName": caller_name,
        "customerName": customer_name,
        "departmentId": call.department_id,
        "waitingSince": call.waiting_since,
    }))
}

/// `endLeg(db, legId)`: mark a leg ended; true when this call did it (a
/// duplicate or a later event finds it ended already).
pub(crate) async fn end_leg(db: &PgPool, leg_id: &str) -> Result<bool, String> {
    let ended = legs::Entity::update_many()
        .col_expr(legs::Column::Status, Expr::value("ended"))
        .col_expr(legs::Column::EndedAt, Expr::value(utc_now()))
        .filter(legs::Column::Id.eq(leg_id))
        .filter(legs::Column::Status.ne("ended"))
        .exec(&orm(db))
        .await
        .map_err(|error| error.to_string())?;
    Ok(ended.rows_affected > 0)
}

/// `hangupBestEffort(env, callControlId)`: hang up a Telnyx leg; a leg that
/// is already gone is not an error.
pub(crate) async fn hangup_best_effort(phone: &Phone<'_>, call_control_id: Option<&str>) {
    let Some(call_control_id) = call_control_id.filter(|id| !id.is_empty()) else {
        return;
    };
    if let Err(error) = phone.telnyx.hangup(call_control_id, None).await {
        tracing::warn!(%error, call_control_id, "[desk-phone] hangup failed (call probably gone)");
    }
}

/// `RingLegResult`: what dialling one member for a call came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MemberRing {
    /// Their browser rings.
    Ringing,
    /// A leg of theirs for this call rings already.
    Already,
    /// The dial failed.
    Failed,
}

/// `ringLeg(ctx, call, agent, ringSeconds, incoming)`: dial one member for
/// the call.
async fn ring_leg(
    phone: &Phone<'_>,
    call: &Call,
    agent: &StaffedAgent,
    ring_seconds: &Value,
    incoming: &Value,
) -> Result<MemberRing, String> {
    let leg_id = weldsuite_kit::generate_id("dleg");
    // The insert is the guard: a leg of this member already ringing for the
    // call refuses it, and then nothing is dialled and nobody is told.
    // `on conflict (call_id, user_id) where status = 'ringing' do nothing`:
    // the leg's id is new, so only that index can refuse it.
    let inserted = legs::Entity::insert(legs::ActiveModel {
        id: Set(leg_id.clone()),
        call_id: Set(call.id.clone()),
        user_id: Set(agent.user_id.clone()),
        status: Set("ringing".to_owned()),
        ..Default::default()
    })
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(&orm(phone.db))
    .await
    .map_err(|error| error.to_string())?;
    if inserted == 0 {
        return Ok(MemberRing::Already);
    }
    let Some(connection_id) = phone.env("TELNYX_CONNECTION_ID") else {
        tracing::error!("[desk-phone] TELNYX_CONNECTION_ID is not set, cannot ring agents");
        end_leg(phone.db, &leg_id).await?;
        return Ok(MemberRing::Failed);
    };
    let client_state = encode_client_state(
        &Ordered::new()
            .with("workspaceId", phone.workspace)
            .with("agentLegId", leg_id.as_str())
            .with("parentCallId", call.id.as_str()),
    );
    let dialled = async {
        let control = phone
            .telnyx
            .dial(Dial {
                connection_id: &connection_id,
                to: &sip_address(&agent.sip_username),
                from: &call.from_number,
                timeout_secs: ring_seconds,
                client_state: Some(&client_state),
            })
            .await
            .map_err(|error| error.to_string())?;
        if js::truthy(&control) {
            set_leg_control(phone.db, &leg_id, &js::string(&control))
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok::<_, String>(())
    }
    .await;
    if let Err(error) = dialled {
        tracing::error!(%error, user = %agent.user_id, "[desk-phone] dial failed");
        end_leg(phone.db, &leg_id).await?;
        return Ok(MemberRing::Failed);
    }
    send_inbox_event(phone, &agent.user_id, "phone.incoming", incoming.clone()).await;
    Ok(MemberRing::Ringing)
}

/// A leg's `call_control_id`, once: a leg that has one keeps it.
pub(crate) async fn set_leg_control(
    db: &PgPool,
    leg_id: &str,
    control: &str,
) -> Result<(), sea_orm::DbErr> {
    legs::Entity::update_many()
        .col_expr(legs::Column::ProviderCallId, Expr::value(control))
        .filter(legs::Column::Id.eq(leg_id))
        .filter(legs::Column::ProviderCallId.is_null())
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// The legs of a call, `ringing` ones only when asked.
async fn count_legs(db: &PgPool, call_id: &str, ringing_only: bool) -> Result<i64, String> {
    let mut found = legs::Entity::find().filter(legs::Column::CallId.eq(call_id));
    if ringing_only {
        found = found.filter(legs::Column::Status.eq("ringing"));
    }
    let count = found
        .count(&orm(db))
        .await
        .map_err(|error| error.to_string())?;
    Ok(i64::try_from(count).unwrap_or(i64::MAX))
}

/// `select count(*) … where call_id = $1 and status = 'ringing'`: the legs
/// of a call still ringing.
pub(crate) async fn ringing_legs(db: &PgPool, call_id: &str) -> Result<i64, String> {
    count_legs(db, call_id, true).await
}

/// `RingResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RingResult {
    /// Members who could take the call before presence and busy (0 = nobody
    /// is staffed).
    pub(crate) staffed: usize,
    /// Legs dialled this round.
    pub(crate) rung: usize,
}

/// `ringAgents(ctx, call, { ringSeconds, ignoreCallIds })`: one round, i.e.
/// ring every staffed member who is online and free (at most 10, longest
/// idle first). `ignore_call_ids` are calls that just ended and must not
/// make their members busy.
pub(crate) async fn ring_agents(
    phone: &Phone<'_>,
    call: &Call,
    ring_seconds: &Value,
    ignore_call_ids: &[&str],
) -> Result<RingResult, String> {
    let staffed = staffed_agents(phone.db, call.department_id.as_deref()).await?;
    if staffed.is_empty() {
        return Ok(RingResult {
            staffed: 0,
            rung: 0,
        });
    }
    let staffed_ids: Vec<String> = staffed.iter().map(|agent| agent.user_id.clone()).collect();
    let online = online_user_ids(phone, &staffed_ids).await;
    let online_agents: Vec<StaffedAgent> = staffed
        .iter()
        .filter(|agent| online.contains(&agent.user_id))
        .cloned()
        .collect();
    let online_ids: Vec<String> = online_agents
        .iter()
        .map(|agent| agent.user_id.clone())
        .collect();
    let mut except = vec![call.id.as_str()];
    except.extend_from_slice(ignore_call_ids);
    let busy = busy_user_ids(phone.db, &online_ids, &except).await?;
    let free: Vec<StaffedAgent> = online_agents
        .into_iter()
        .filter(|agent| !busy.contains(&agent.user_id))
        .collect();
    let leg_count = count_legs(phone.db, &call.id, false).await?;
    let room = usize::try_from((MAX_LEGS_PER_CALL - leg_count).max(0)).unwrap_or(0);
    let mut chosen = by_idle_time(phone.db, free).await?;
    chosen.truncate(MAX_LEGS_PER_ROUND.min(room));
    if chosen.is_empty() {
        return Ok(RingResult {
            staffed: staffed.len(),
            rung: 0,
        });
    }
    let incoming = incoming_event(phone, call).await?;
    let mut rung = 0;
    for agent in &chosen {
        if ring_leg(phone, call, agent, ring_seconds, &incoming).await? == MemberRing::Ringing {
            rung += 1;
        }
    }
    Ok(RingResult {
        staffed: staffed.len(),
        rung,
    })
}

/// `ringMember(ctx, call, agent, ringSeconds)`: ring one member for a call
/// (queue pickup), without the presence or busy filter: the member asked.
/// `Already` when a leg of theirs rings for the call, however close together
/// they asked.
pub(crate) async fn ring_member(
    phone: &Phone<'_>,
    call: &Call,
    agent: &StaffedAgent,
    ring_seconds: &Value,
) -> Result<MemberRing, String> {
    let incoming = incoming_event(phone, call).await?;
    ring_leg(phone, call, agent, ring_seconds, &incoming).await
}

/// `endRingingLegs(ctx, callId, exceptLegId)`: end every leg of the call
/// that is still ringing (optionally all but one). Each is marked ended
/// first, then hung up, so the leg's own `call.hangup` finds it ended and
/// starts nothing. Answers the members whose leg it was: they are free
/// again, and it is the caller's job to offer them the next waiting caller
/// (`ring_waiting_calls`) once its own call is dealt with.
pub(crate) async fn end_ringing_legs(
    phone: &Phone<'_>,
    call_id: &str,
    except_leg_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut ringing = legs::Entity::find()
        .select_only()
        .columns([
            legs::Column::Id,
            legs::Column::UserId,
            legs::Column::ProviderCallId,
        ])
        .filter(legs::Column::CallId.eq(call_id))
        .filter(legs::Column::Status.eq("ringing"));
    if let Some(except) = except_leg_id {
        ringing = ringing.filter(legs::Column::Id.ne(except));
    }
    let ringing: Vec<(String, String, Option<String>)> = ringing
        .into_tuple()
        .all(&orm(phone.db))
        .await
        .map_err(|error| error.to_string())?;
    let mut ended = Vec::new();
    for (leg_id, user_id, provider_call_id) in ringing {
        if !end_leg(phone.db, &leg_id).await? {
            continue;
        }
        ended.push(user_id);
        hangup_best_effort(phone, provider_call_id.as_deref()).await;
    }
    Ok(ended)
}

/// `notifyPhoneEnded(ctx, callId, members, reason)`: tell the members whose
/// browsers were ringing that it stopped (`answered_elsewhere`,
/// `caller_hung_up` or `timeout`), each once.
pub(crate) async fn notify_phone_ended(
    phone: &Phone<'_>,
    call_id: &str,
    members: &[String],
    reason: &str,
) {
    let mut told: Vec<&String> = Vec::new();
    for user_id in members {
        if told.contains(&user_id) {
            continue;
        }
        told.push(user_id);
        send_inbox_event(
            phone,
            user_id,
            "phone.ended",
            json!({ "callId": call_id, "reason": reason }),
        )
        .await;
    }
}

/// `ringWaitingCalls(ctx, { finishedCallId })`: an agent became free
/// (finished a call, switched "take calls" on, or their browser stopped
/// ringing for another call: it was answered by a colleague, abandoned, or
/// went unanswered), so ring a round for the oldest waiting call that has no
/// leg ringing. One call per trigger. A call whose newest leg ended less than
/// 10 s after it was dialled is skipped (instantly failing credentials must
/// not spin), and a call nobody can be rung for is left alone. Best effort.
pub(crate) async fn ring_waiting_calls(phone: &Phone<'_>, finished_call_id: Option<&str>) {
    if let Err(error) = try_ring_waiting_calls(phone, finished_call_id).await {
        tracing::error!(%error, "[desk-phone] ringing waiting calls failed");
    }
}

async fn try_ring_waiting_calls(
    phone: &Phone<'_>,
    finished_call_id: Option<&str>,
) -> Result<(), String> {
    let db = phone.db;
    let rows = voip_calls::Entity::find()
        .filter(waiting_calls())
        .order_by(voip_calls::Column::QueueEnteredAt, Order::Asc)
        .order_by(voip_calls::Column::Id, Order::Asc)
        .limit(10)
        .all(&orm(db))
        .await
        .map_err(|error| error.to_string())?;
    let ignore: Vec<&str> = finished_call_id.into_iter().collect();
    for call in rows.into_iter().map(Call::from_model) {
        if call.control().is_none() {
            continue;
        }
        if ringing_legs(db, &call.id).await? > 0 {
            continue;
        }
        // How long the newest leg rang, when it has ended.
        let newest: Option<(PrimitiveDateTime, Option<PrimitiveDateTime>)> = legs::Entity::find()
            .select_only()
            .columns([legs::Column::CreatedAt, legs::Column::EndedAt])
            .filter(legs::Column::CallId.eq(&call.id))
            .order_by(legs::Column::CreatedAt, Order::Desc)
            .limit(1)
            .into_tuple()
            .one(&orm(db))
            .await
            .map_err(|error| error.to_string())?;
        let rang = newest.and_then(|(created, ended)| {
            ended.map(|ended| epoch_ms(ended) - epoch_ms(created))
        });
        if rang.is_some_and(|rang| rang < MIN_RING_MS_FOR_NEXT_ROUND) {
            continue;
        }
        let options = desk_phone_options::for_number(db, &call.to_number)
            .await
            .map_err(|error| error.to_string())?;
        let result = ring_agents(phone, &call, &options.ring_seconds, &ignore).await?;
        if result.rung > 0 {
            return Ok(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_call_row_reads_like_the_workers() {
        let waiting = Call::from_row(json!({
            "id": "vcall_1",
            "user_id": "system",
            "provider_call_id": "cc-1",
            "desk_conversation_id": "dconv_1",
            "from_number": "+31612340001",
            "to_number": "+31201270001",
            "department_id": null,
            "is_recorded": true,
            "initiated_at": "2026-10-10T09:59:58.5",
            "queue_entered_at": "2026-10-10T10:00:00",
            "agent_answered_at": null,
            "ended_at": null,
            "outcome": null,
            "answered_by_user_id": null,
        }));
        assert!(waiting.waiting && waiting.is_recorded);
        assert_eq!(waiting.control(), Some("cc-1"));
        assert_eq!(waiting.conversation(), Some("dconv_1"));
        assert_eq!(waiting.waiting_since, json!("2026-10-10T10:00:00.000Z"));

        let plain = Call::from_row(json!({
            "id": "vcall_2",
            "user_id": "user_a",
            "provider_call_id": "",
            "from_number": "+31",
            "to_number": "+32",
            "is_recorded": null,
            "initiated_at": "2026-10-10T09:59:58.5",
            "queue_entered_at": null,
            "outcome": "missed",
        }));
        assert!(!plain.waiting && !plain.is_recorded);
        assert_eq!(plain.control(), None);
        assert_eq!(plain.conversation(), None);
        assert_eq!(plain.waiting_since, json!("2026-10-10T09:59:58.500Z"));
        let answered = Call::from_row(json!({
            "queue_entered_at": "2026-10-10T10:00:00",
            "agent_answered_at": "2026-10-10T10:00:05",
        }));
        assert!(!answered.waiting);
    }

    #[test]
    fn a_conversation_named_after_the_number_has_no_caller_name() {
        assert_eq!(
            conversation_caller_name(Some(" Eve Caller "), "+31612343001").as_deref(),
            Some("Eve Caller")
        );
        assert_eq!(
            conversation_caller_name(Some("+31612343002"), "+31612343002"),
            None
        );
        assert_eq!(conversation_caller_name(Some("  "), "+31"), None);
        assert_eq!(conversation_caller_name(None, "+31"), None);
        assert_eq!(sip_address("sip_anna"), "sip:sip_anna@sip.telnyx.com");
    }
}
