//! `/api/chat-entity-channels` (`routes/chat-entity-channels/index.ts`):
//! record chats (ADR CHAT-003): one chat per record, created on its first
//! message or follow, readable by whoever may see the record. CRM's
//! `/api/companies/:id/chat/*` and `/api/people/:id/chat/*` reach these
//! routes at the same paths (ADR API-012, CHAT-006).

use std::collections::HashSet;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, JoinType, Order, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, Set,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    CHAT_CHANNEL_CREATED, CHAT_CHANNEL_JOINED, CHAT_CHANNEL_LEFT, CHAT_CHANNEL_UPDATED,
};
use weldsuite_chat_domain::Can;
use weldsuite_chat_domain::agents::{agent_viewer_for, inaccessible_agent_ids};
use weldsuite_chat_domain::entity::{self, Provider, can_access_entity, can_post_in_record_chat};
use weldsuite_chat_domain::members::{AddMembers, add_channel_members, channel_row};
use weldsuite_chat_domain::text::{mention_bodies, slugify_channel_name};
use weldsuite_db::{orm, utc_now, utc_timestamp};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    chat_channel_members as members, chat_channels as channels, chat_messages as messages,
};

use crate::ChatState;
use crate::access::{Caller, ChatError, ChatResult, answer, validate, validate_query};
use crate::followers::{
    add_followers, announce_new_followers, default_followers_who_may_open, remove_follower,
    set_followed_channels_muted,
};
use crate::post::{PostError, PostInput, post_chat_message};
use crate::util::{list_response, now};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<ChatState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require(["channels:read"]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/summary", get(summary).route_layer(read()))
        .route(
            "/{entity_type}/mute",
            patch(mute).route_layer(gate.require(["channels:update"])),
        )
        .route(
            "/{entity_type}/{entity_id}/channel",
            get(channel).route_layer(read()),
        )
        .route(
            "/{entity_type}/{entity_id}/comments",
            get(comments).route_layer(read()),
        )
        .route(
            "/{entity_type}/{entity_id}/messages",
            post(send).route_layer(gate.require(["messages:create"])),
        )
        .route(
            "/{entity_type}/{entity_id}/follow",
            post(follow).delete(unfollow).route_layer(read()),
        )
        .route(
            "/{entity_type}/{entity_id}/detail",
            get(detail).route_layer(read()),
        )
}

fn unknown_type(entity_type: &str) -> ChatError {
    ChatError::bad_request(format!("Unknown entity type: {entity_type}"))
}

/// `resolveAccess`: the provider, when the caller may see the record.
pub(super) async fn resolve_access(
    caller: &Caller,
    entity_type: &str,
    entity_id: &str,
) -> ChatResult<Provider> {
    let Some(provider) = entity::provider(entity_type) else {
        return Err(unknown_type(entity_type));
    };
    let can = caller.context_can();
    if !can_access_entity(provider, &caller.db, &caller.user_id, entity_id, &can).await? {
        return Err(ChatError::forbidden(
            "You do not have access to this entity",
        ));
    }
    Ok(provider)
}

/// A row as Drizzle returns it.
fn js<M: serde::Serialize>(model: M) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// `findEntityChannel`: the live chat of a record.
async fn find_entity_channel(
    caller: &Caller,
    entity_type: &str,
    entity_id: &str,
) -> Result<Option<Value>, DbErr> {
    channels::Entity::find()
        .filter(channels::Column::EntityType.eq(entity_type))
        .filter(channels::Column::EntityId.eq(entity_id))
        .filter(channels::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?
        .map(js)
        .transpose()
}

/// A soft-deleted chat still holding the record's slot, latest first.
async fn find_deleted_channel(
    caller: &Caller,
    entity_type: &str,
    entity_id: &str,
) -> Result<Option<String>, DbErr> {
    channels::Entity::find()
        .select_only()
        .column(channels::Column::Id)
        .filter(channels::Column::EntityType.eq(entity_type))
        .filter(channels::Column::EntityId.eq(entity_id))
        .filter(channels::Column::DeletedAt.is_not_null())
        .order_by_desc(channels::Column::DeletedAt)
        .into_tuple()
        .one(&orm(&caller.db))
        .await
}

/// `slugify` of the record chat (`<name>-<id>`).
fn record_slug(name: &str, suffix: &str) -> String {
    let base = slugify_channel_name(name);
    let base: String = base.chars().take(200).collect();
    let base = if base.is_empty() {
        "entity".to_owned()
    } else {
        base
    };
    format!("{base}-{suffix}").chars().take(255).collect()
}

/// `initialFollowerIds`: the default members who may open the record, then the acting user.
async fn initial_followers(
    caller: &Caller,
    entity_type: &str,
    entity_id: &str,
    defaults: &[String],
) -> Result<Vec<String>, DbErr> {
    let mut ids = default_followers_who_may_open(
        &caller.db,
        entity_type,
        entity_id,
        &caller.user_id,
        defaults,
    )
    .await?;
    ids.push(caller.user_id.clone());
    Ok(ids)
}

pub(super) struct GetOrCreate {
    pub(super) channel: Value,
    pub(super) created: bool,
    pub(super) new_followers: Vec<String>,
}

/// `getOrCreateEntityChannel`.
pub(super) async fn get_or_create(
    caller: &Caller,
    provider: Provider,
    entity_id: &str,
) -> ChatResult<GetOrCreate> {
    let entity_type = provider.type_name();
    if let Some(channel) = find_entity_channel(caller, entity_type, entity_id).await? {
        return Ok(GetOrCreate {
            channel,
            created: false,
            new_followers: Vec::new(),
        });
    }
    // `throw new Error(`Entity … not found`)`: the route's 500.
    let Some(resolved) = provider
        .resolve(&caller.db, &caller.user_id, entity_id)
        .await?
    else {
        return Err(ChatError::from(sqlx::Error::RowNotFound));
    };
    if let Some(deleted) = find_deleted_channel(caller, entity_type, entity_id).await? {
        let followers = add_followers(
            &caller.db,
            &deleted,
            &initial_followers(caller, entity_type, entity_id, &resolved.default_member_ids)
                .await?,
            Some(&caller.user_id),
        )
        .await?;
        channels::Entity::update_many()
            .col_expr(
                channels::Column::DeletedAt,
                Expr::value(Option::<PrimitiveDateTime>::None),
            )
            .col_expr(channels::Column::Name, Expr::value(&resolved.display_name))
            .col_expr(
                channels::Column::EntityDisplayName,
                Expr::value(&resolved.display_name),
            )
            .col_expr(channels::Column::Icon, Expr::value(Option::<String>::None))
            .col_expr(channels::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(channels::Column::Id.eq(&deleted))
            .exec(&orm(&caller.db))
            .await?;
        return Ok(GetOrCreate {
            channel: channel_row(&caller.db, &deleted)
                .await?
                .unwrap_or(Value::Null),
            created: false,
            new_followers: followers,
        });
    }
    let id = generate_id("ch");
    let at = utc_now();
    channels::Entity::insert(channels::ActiveModel {
        id: Set(id.clone()),
        name: Set(resolved.display_name.clone()),
        slug: Set(record_slug(&resolved.display_name, &id)),
        type_: Set("entity".to_owned()),
        entity_type: Set(Some(entity_type.to_owned())),
        entity_id: Set(Some(entity_id.to_owned())),
        entity_display_name: Set(Some(resolved.display_name.clone())),
        icon: Set(None),
        created_by: Set(Some(caller.user_id.clone())),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    })
    .exec_without_returning(&orm(&caller.db))
    .await?;
    let followers = add_followers(
        &caller.db,
        &id,
        &initial_followers(caller, entity_type, entity_id, &resolved.default_member_ids).await?,
        Some(&caller.user_id),
    )
    .await?;
    Ok(GetOrCreate {
        channel: channel_row(&caller.db, &id).await?.unwrap_or(Value::Null),
        created: true,
        new_followers: followers,
    })
}

/// `publishEntityEvent(chat_channel, action, { id, name, type })`.
pub(super) fn publish_channel_event(
    state: &ChatState,
    caller: &Caller,
    event: weldsuite_catalogs::entity_events::EventName,
    channel: &Value,
) {
    let id = channel["id"].as_str().unwrap_or_default();
    caller.publish(
        state,
        event,
        id,
        &json!({ "id": id, "name": channel["name"], "type": channel["type"] }),
    );
}

/// The providers whose permission the caller holds.
async fn permitted(providers: Vec<Provider>, can: &Can<'_>) -> Result<Vec<Provider>, DbErr> {
    let mut allowed = Vec::new();
    for provider in providers {
        if can.can(provider.required_permission()).await? {
            allowed.push(provider);
        }
    }
    Ok(allowed)
}

/// `keepVisible`: the rows whose record the caller may see.
async fn keep_visible(
    caller: &Caller,
    can: &Can<'_>,
    rows: Vec<Value>,
    providers: &[Provider],
) -> Result<Vec<Value>, DbErr> {
    let mut by_type: Vec<(String, Vec<String>)> = Vec::new();
    for row in &rows {
        let (Some(kind), Some(id)) = (row["entityType"].as_str(), row["entityId"].as_str()) else {
            continue;
        };
        if kind.is_empty() || id.is_empty() {
            continue;
        }
        match by_type.iter_mut().find(|(k, _)| k == kind) {
            Some((_, ids)) => ids.push(id.to_owned()),
            None => by_type.push((kind.to_owned(), vec![id.to_owned()])),
        }
    }
    let mut visible: Vec<(String, HashSet<String>)> = Vec::new();
    for (kind, ids) in by_type {
        let set = match providers.iter().find(|p| p.type_name() == kind) {
            Some(provider) => {
                let unique = weldsuite_chat_domain::access::unique_ids(&ids);
                provider
                    .filter_visible(&caller.db, &caller.user_id, can, &unique)
                    .await?
            }
            None => HashSet::new(),
        };
        visible.push((kind, set));
    }
    Ok(rows
        .into_iter()
        .filter(|row| {
            let (Some(kind), Some(id)) = (row["entityType"].as_str(), row["entityId"].as_str())
            else {
                return false;
            };
            visible
                .iter()
                .find(|(k, _)| k == kind)
                .is_some_and(|(_, set)| set.contains(id))
        })
        .collect())
}

const FILTERS: [&str; 4] = ["following", "unread", "mentions", "all"];

/// `RECORD_CHAT_SORTS`: `recent` (the sidebar) or `unread` (unread first, the records page).
const SORTS: [&str; 2] = ["recent", "unread"];

struct ListQuery {
    kind: Option<String>,
    filter: String,
    sort: String,
    search: Option<String>,
    cursor: Option<String>,
    limit: i64,
}

fn read_list(issues: &mut Issues, values: &Map<String, Value>) -> ListQuery {
    let kind = issues.string(values, "type", false, Some(1), Some(50));
    let filter = issues
        .choice(values, "filter", Presence::Optional, &FILTERS)
        .into_option()
        .unwrap_or_else(|| "following".to_owned());
    let sort = issues
        .choice(values, "sort", Presence::Optional, &SORTS)
        .into_option()
        .unwrap_or_else(|| "recent".to_owned());
    let search = issues
        .text_with(
            values,
            "search",
            Presence::Optional,
            Text::trimmed(None, Some(200)),
        )
        .into_option();
    let cursor = issues.string(values, "cursor", false, None, Some(30));
    let limit = issues
        .whole_number(
            values,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                min: Some(1.0),
                max: Some(100.0),
                ..Number::default()
            },
        )
        .into_option()
        .unwrap_or(25);
    ListQuery {
        kind,
        filter,
        sort,
        search,
        cursor,
        limit,
    }
}

/// `escapeLike`.
fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `coalesce(t.last_message_at, t.created_at)`: a record chat's last activity.
fn activity() -> Expr {
    Func::coalesce([
        Expr::col((channels::Entity, channels::Column::LastMessageAt)),
        Expr::col((channels::Entity, channels::Column::CreatedAt)),
    ])
    .into()
}

/// The caller's membership has a message they haven't read: not muted, and
/// `t.last_message_at` after `m.last_read_at` (or nothing read yet).
fn unread_membership() -> Condition {
    Condition::all()
        .add(members::Column::IsMuted.eq(false))
        .add(channels::Column::LastMessageAt.is_not_null())
        .add(
            Condition::any()
                .add(members::Column::LastReadAt.is_null())
                .add(sea_orm::ExprTrait::gt(
                    Expr::col((channels::Entity, channels::Column::LastMessageAt)),
                    Expr::col((members::Entity, members::Column::LastReadAt)),
                )),
        )
}

/// `exists (select 1 from chat_channel_members m where m.channel_id = t.id
/// and m.user_id = $user and …)`.
fn membership(user_id: &str, also: Option<Condition>) -> Expr {
    let mut condition = Condition::all()
        .add(sea_orm::ExprTrait::equals(
            Expr::col((members::Entity, members::Column::ChannelId)),
            (channels::Entity, channels::Column::Id),
        ))
        .add(members::Column::UserId.eq(user_id));
    if let Some(also) = also {
        condition = condition.add(also);
    }
    Expr::exists(
        Query::select()
            .expr(Expr::val(1))
            .from(members::Entity)
            .cond_where(condition)
            .to_owned(),
    )
}

/// The cursor chat (`cur`): its activity, id and rank.
type Cursor = (PrimitiveDateTime, String, i32);

/// `r.rank > cur.rank or (r.rank = cur.rank and (coalesce(t.last_message_at,
/// t.created_at), t.id) < (cur.at, cur.id))`; without a rank (`sort=recent`)
/// both ranks are 1.
fn after_cursor(rank: Option<Expr>, (at, id, cursor_rank): Cursor) -> Condition {
    let before = sea_orm::ExprTrait::lt(
        Expr::tuple([
            activity(),
            Expr::col((channels::Entity, channels::Column::Id)),
        ]),
        Expr::tuple([Expr::val(at), Expr::val(id)]),
    );
    match rank {
        Some(rank) => Condition::any()
            .add(sea_orm::ExprTrait::gt(rank.clone(), cursor_rank))
            .add(
                Condition::all()
                    .add(sea_orm::ExprTrait::eq(rank, cursor_rank))
                    .add(before),
            ),
        None => Condition::all().add(before),
    }
}

/// The list's query: its `where` (shared with its count), order and cursor.
struct Listing<'a> {
    types: &'a [String],
    filter: &'a str,
    user_id: &'a str,
    /// `%search%`, LIKE-escaped.
    search: Option<String>,
    /// `sort=unread`: the caller's unread chats first.
    unread_first: bool,
}

impl Listing<'_> {
    /// Live record chats of the permitted types, the `filter`, the search.
    fn condition(&self) -> Condition {
        let mut condition = Condition::all()
            .add(channels::Column::Type.eq("entity"))
            .add(channels::Column::DeletedAt.is_null())
            .add(channels::Column::EntityType.is_in(self.types));
        if self.filter != "all" {
            let also = match self.filter {
                "unread" => Some(unread_membership()),
                "mentions" => Some(Condition::all().add(members::Column::UnreadMentionCount.gt(0))),
                _ => None,
            };
            condition = condition.add(membership(self.user_id, also));
        }
        if let Some(search) = &self.search {
            let name: Expr = Func::coalesce([
                Expr::col((channels::Entity, channels::Column::EntityDisplayName)),
                Expr::col((channels::Entity, channels::Column::Name)),
            ])
            .into();
            condition = condition.add(sea_orm::sea_query::extension::postgres::PgExpr::ilike(
                name,
                search.as_str(),
            ));
        }
        condition
    }

    /// `rank`: 0 for a chat unread to the caller under `sort=unread`, else 1;
    /// `None` under `sort=recent`, where every chat is 1.
    fn rank(&self) -> Option<Expr> {
        self.unread_first.then(|| {
            Expr::case(membership(self.user_id, Some(unread_membership())), 0)
                .finally(1)
                .into()
        })
    }

    /// `cur`: the cursor chat's place in the order, when it still exists.
    async fn cursor(
        &self,
        db: &sea_orm::DatabaseConnection,
        id: &str,
    ) -> Result<Option<Cursor>, DbErr> {
        let select = channels::Entity::find_by_id(id.to_owned())
            .select_only()
            .column_as(activity(), "at")
            .column(channels::Column::Id);
        match self.rank() {
            Some(rank) => select.column_as(rank, "rank").into_tuple().one(db).await,
            None => Ok(select
                .into_tuple::<(PrimitiveDateTime, String)>()
                .one(db)
                .await?
                .map(|(at, id)| (at, id, 1))),
        }
    }

    /// The next `probe` chats after `after`, in the list's order; none when
    /// the cursor chat is gone (`exists (select 1 from cur …)` is false).
    async fn batch(
        &self,
        db: &sea_orm::DatabaseConnection,
        after: Option<&str>,
        probe: u64,
    ) -> Result<Vec<Value>, DbErr> {
        let mut select = channels::Entity::find().filter(self.condition());
        if let Some(after) = after {
            let Some(cursor) = self.cursor(db, after).await? else {
                return Ok(Vec::new());
            };
            select = select.filter(after_cursor(self.rank(), cursor));
        }
        if let Some(rank) = self.rank() {
            select = select.order_by(rank, Order::Asc);
        }
        select
            .order_by(activity(), Order::Desc)
            .order_by_desc(channels::Column::Id)
            .limit(probe)
            .all(db)
            .await?
            .into_iter()
            .map(js)
            .collect()
    }

    /// `count(*)` of the list without its cursor.
    async fn count(&self, db: &sea_orm::DatabaseConnection) -> Result<u64, DbErr> {
        channels::Entity::find()
            .filter(self.condition())
            .count(db)
            .await
    }
}

/// `GET /`: record chats, most recent activity first; with `sort=unread` the
/// caller's unread chats first (`unreadRank`), each part in that order.
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match validate_query(raw.as_deref(), read_list) {
        Ok(query) => query,
        Err(error) => return error.respond(""),
    };
    let mut providers: Vec<Provider> = entity::record_chat_providers().collect();
    if let Some(kind) = query.kind.as_deref().filter(|k| !k.is_empty()) {
        match entity::provider(kind) {
            Some(provider) if !provider.legacy() => providers = vec![provider],
            _ => return unknown_type(kind).respond(""),
        }
    }
    let result = async {
        let can = caller.context_can();
        let providers = permitted(providers, &can).await?;
        if providers.is_empty() {
            return Ok(list_response(Vec::new(), 0, false, None));
        }
        let types: Vec<String> = providers.iter().map(|p| p.type_name().to_owned()).collect();
        let filter = query.filter.as_str();
        let search = query
            .search
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|s| format!("%{}%", escape_like(s)));
        let limit = query.limit;
        let listing = Listing {
            types: &types,
            filter,
            user_id: &caller.user_id,
            search,
            unread_first: query.sort == "unread",
        };
        let db = orm(&caller.db);
        let probe = u64::try_from(limit + 1)
            .map_err(|_| DbErr::Custom("LIMIT must not be negative".to_owned()))?;
        let mut page: Vec<Value> = Vec::new();
        let mut after = query.cursor.clone().filter(|c| !c.is_empty());
        let mut exhausted = false;
        for _ in 0..5 {
            if i64::try_from(page.len()).unwrap_or(i64::MAX) > limit {
                break;
            }
            let batch = listing.batch(&db, after.as_deref(), probe).await?;
            let full = i64::try_from(batch.len()).unwrap_or(i64::MAX) > limit;
            let last = batch
                .last()
                .and_then(|r| r["id"].as_str().map(str::to_owned));
            page.extend(keep_visible(&caller, &can, batch, &providers).await?);
            if !full {
                exhausted = true;
                break;
            }
            after = last;
        }
        let limit_len = usize::try_from(limit.max(0)).unwrap_or(0);
        let (items, has_more, cursor) = if page.len() > limit_len {
            page.truncate(limit_len);
            let cursor = page
                .last()
                .and_then(|r| r["id"].as_str().map(str::to_owned));
            (page, true, cursor)
        } else if exhausted {
            (page, false, None)
        } else {
            (page, true, after)
        };
        let total = listing.count(&db).await?;
        let ids: Vec<String> = items
            .iter()
            .filter_map(|r| r["id"].as_str().map(str::to_owned))
            .collect();
        let states = caller_state(&caller, &ids).await?;
        let items: Vec<Value> = items
            .into_iter()
            .map(|row| {
                let id = row["id"].as_str().unwrap_or_default().to_owned();
                let mut fields = match row {
                    Value::Object(map) => map,
                    _ => Map::new(),
                };
                let state = states.iter().find(|(c, _)| *c == id).map_or_else(
                    || {
                        json!({ "isFollowing": false, "isMuted": false, "lastReadAt": null,
                                "lastReadMessageId": null, "unreadMentionCount": 0 })
                    },
                    |(_, s)| s.clone(),
                );
                if let Value::Object(extra) = state {
                    fields.extend(extra);
                }
                Value::Object(fields)
            })
            .collect();
        Ok(list_response(
            items,
            i64::try_from(total).unwrap_or(i64::MAX),
            has_more,
            cursor,
        ))
    }
    .await;
    answer(result, "Failed to list entity channels")
}

/// `callerState`: following, mute, read cursor and mentions per channel.
async fn caller_state(caller: &Caller, ids: &[String]) -> Result<Vec<(String, Value)>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, bool, Option<PrimitiveDateTime>, Option<String>, i32)> =
        members::Entity::find()
            .select_only()
            .column(members::Column::ChannelId)
            .column(members::Column::IsMuted)
            .column(members::Column::LastReadAt)
            .column(members::Column::LastReadMessageId)
            .column(members::Column::UnreadMentionCount)
            .filter(members::Column::UserId.eq(&caller.user_id))
            .filter(members::Column::ChannelId.is_in(ids))
            .into_tuple()
            .all(&orm(&caller.db))
            .await?;
    Ok(rows
        .into_iter()
        .map(|(channel, muted, read_at, read_id, mentions)| {
            (
                channel,
                json!({
                    "isFollowing": true,
                    "isMuted": muted,
                    "lastReadAt": read_at.map(|at| weldsuite_events::iso_timestamp(at.assume_utc())),
                    "lastReadMessageId": read_id,
                    "unreadMentionCount": mentions,
                }),
            )
        })
        .collect())
}

/// The caller's followed record chats of `types`: `{ entityType, entityId,
/// unread, unreadMentionCount }`, unread comparing the times to the
/// millisecond (`date_trunc('milliseconds', …)`).
async fn followed_states(caller: &Caller, types: &[String]) -> Result<Vec<Value>, DbErr> {
    type Row = (
        Option<String>,
        Option<String>,
        bool,
        Option<PrimitiveDateTime>,
        Option<PrimitiveDateTime>,
        i32,
    );
    let rows: Vec<Row> = channels::Entity::find()
        .select_only()
        .column(channels::Column::EntityType)
        .column(channels::Column::EntityId)
        .column(members::Column::IsMuted)
        .column(channels::Column::LastMessageAt)
        .column(members::Column::LastReadAt)
        .column(members::Column::UnreadMentionCount)
        .join(
            JoinType::InnerJoin,
            channels::Entity::belongs_to(members::Entity)
                .from(channels::Column::Id)
                .to(members::Column::ChannelId)
                .into(),
        )
        .filter(members::Column::UserId.eq(&caller.user_id))
        .filter(channels::Column::Type.eq("entity"))
        .filter(channels::Column::DeletedAt.is_null())
        .filter(channels::Column::EntityType.is_in(types))
        .into_tuple()
        .all(&orm(&caller.db))
        .await?;
    let millis = |at: PrimitiveDateTime| utc_timestamp(at.assume_utc());
    Ok(rows
        .into_iter()
        .map(
            |(entity_type, entity_id, muted, message_at, read_at, mentions)| {
                let unread = !muted
                    && message_at.is_some_and(|message_at| {
                        read_at.is_none_or(|read_at| millis(message_at) > millis(read_at))
                    });
                json!({
                    "entityType": entity_type,
                    "entityId": entity_id,
                    "unread": unread,
                    "unreadMentionCount": mentions,
                })
            },
        )
        .collect())
}

/// `GET /summary`: per type, followed chats, unread and mentions.
async fn summary(caller: Caller) -> Response {
    let result = async {
        let can = caller.context_can();
        let providers = permitted(entity::record_chat_providers().collect(), &can).await?;
        if providers.is_empty() {
            return Ok(Data(Vec::<Value>::new()).into_response());
        }
        let types: Vec<String> = providers.iter().map(|p| p.type_name().to_owned()).collect();
        let rows = followed_states(&caller, &types).await?;
        let visible = keep_visible(&caller, &can, rows, &providers).await?;
        let summary: Vec<Value> = providers
            .iter()
            .map(|provider| {
                let of_type: Vec<&Value> = visible
                    .iter()
                    .filter(|row| row["entityType"].as_str() == Some(provider.type_name()))
                    .collect();
                let unread = of_type.iter().filter(|row| row["unread"] == true).count();
                let mentions: i64 = of_type
                    .iter()
                    .map(|row| row["unreadMentionCount"].as_i64().unwrap_or(0))
                    .sum();
                json!({
                    "type": provider.type_name(),
                    "label": provider.label(),
                    "followed": of_type.len(),
                    "unread": unread,
                    "mentions": mentions,
                })
            })
            .collect();
        Ok(Data(summary).into_response())
    }
    .await;
    answer(result, "Failed to summarise entity channels")
}

/// `PATCH /:entityType/mute`: mute or unmute every followed chat of a type.
async fn mute(
    State(state): State<ChatState>,
    caller: Caller,
    Path(entity_type): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(provider) = entity::provider(&entity_type).filter(|p| !p.legacy()) else {
        return unknown_type(&entity_type).respond("");
    };
    if !caller.can(provider.required_permission()) {
        return ChatError::forbidden("You do not have access to this record type").respond("");
    }
    let muted = validate(&headers, &body, |issues, body| {
        issues
            .boolean(body, "isMuted", Presence::Required)
            .into_option()
            .unwrap_or_default()
    });
    let muted = match muted {
        Ok(muted) => muted,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let ids =
            set_followed_channels_muted(&caller.db, &caller.user_id, provider.type_name(), muted)
                .await?;
        for id in &ids {
            caller.publish(&state, CHAT_CHANNEL_UPDATED, id, &json!({ "id": id }));
        }
        Ok(Data(json!({ "updated": ids.len() })).into_response())
    }
    .await;
    answer(result, "Failed to update record chats")
}

/// `GET /:entityType/:entityId/channel`: the chat, or `null` before its first message.
async fn channel(
    caller: Caller,
    Path((entity_type, entity_id)): Path<(String, String)>,
) -> Response {
    let result = async {
        let provider = resolve_access(&caller, &entity_type, &entity_id).await?;
        let channel = find_entity_channel(&caller, provider.type_name(), &entity_id).await?;
        Ok(Data(channel.unwrap_or(Value::Null)).into_response())
    }
    .await;
    answer(result, "Failed to fetch entity channel")
}

/// `GET /:entityType/:entityId/comments`: the comment threads (messages with
/// `metadata.anchor`), oldest first, then their replies.
async fn comments(
    caller: Caller,
    Path((entity_type, entity_id)): Path<(String, String)>,
) -> Response {
    let result = async {
        let provider = resolve_access(&caller, &entity_type, &entity_id).await?;
        let channel = find_entity_channel(&caller, provider.type_name(), &entity_id).await?;
        let mut messages: Vec<Value> = Vec::new();
        if let Some(channel_id) = channel.as_ref().and_then(|c| c["id"].as_str()) {
            let db = orm(&caller.db);
            // `(m.metadata -> 'anchor') is not null`.
            let anchored = sea_orm::ExprTrait::is_not_null(
                sea_orm::sea_query::extension::postgres::PgExpr::get_json_field(
                    Expr::col((messages::Entity, messages::Column::Metadata)),
                    "anchor",
                ),
            );
            let mut threads = messages::Entity::find()
                .filter(messages::Column::ChannelId.eq(channel_id))
                .filter(messages::Column::DeletedAt.is_null())
                .filter(messages::Column::ParentId.is_null())
                .filter(anchored)
                .order_by_desc(messages::Column::CreatedAt)
                .limit(500)
                .all(&db)
                .await?;
            if !threads.is_empty() {
                threads.reverse();
                let ids: Vec<String> = threads.iter().map(|t| t.id.clone()).collect();
                let mut replies = messages::Entity::find()
                    .filter(messages::Column::ChannelId.eq(channel_id))
                    .filter(messages::Column::DeletedAt.is_null())
                    .filter(messages::Column::ParentId.is_in(&ids))
                    .order_by_desc(messages::Column::CreatedAt)
                    .limit(2000)
                    .all(&db)
                    .await?;
                replies.reverse();
                messages = threads
                    .into_iter()
                    .chain(replies)
                    .map(js)
                    .collect::<Result<_, _>>()?;
            }
        }
        Ok(Data(json!({ "channel": channel, "messages": messages })).into_response())
    }
    .await;
    answer(result, "Failed to fetch comments")
}

fn read_send(issues: &mut Issues, body: &Map<String, Value>) -> PostInput {
    let content = issues
        .string(body, "content", true, Some(1), None)
        .unwrap_or_default();
    let html_content = issues.string(body, "htmlContent", false, None, None);
    let parent_id = issues
        .text(body, "parentId", Presence::Nullish, None, None)
        .into_option();
    let mentions = issues
        .list(
            body,
            "mentions",
            Presence::Optional,
            None,
            None,
            |issues, item| issues.item_text(item, Text::default()),
        )
        .into_option();
    let _ = issues.boolean(body, "mentionsEveryone", Presence::Optional);
    let attachments = issues
        .records(body, "attachments", Presence::Optional)
        .into_option();
    let metadata = match issues.nested(body, "metadata", Presence::Optional, |_, fields| {
        fields.clone()
    }) {
        Field::Set(fields) => Some(Value::Object(fields)),
        _ => None,
    };
    PostInput {
        content,
        html_content,
        parent_id,
        attachments,
        mentions,
        metadata,
        reply_to_id: None,
        reply_mention: None,
    }
}

/// `extractChatMentions(content, extra)`: user and agent ids.
fn extract_chat_mentions(content: &str, extra: &[String]) -> Vec<String> {
    const SEARCH_ENTITY_TYPES: [&str; 15] = [
        "contact",
        "customer",
        "lead",
        "opportunity",
        "ticket",
        "article",
        "product",
        "order",
        "invoice",
        "bill",
        "project",
        "task",
        "sheet",
        "board",
        "domain",
    ];
    let mut found: Vec<String> = extra.to_vec();
    for body in mention_bodies(content) {
        let (id, had_colon) = body
            .split_once(':')
            .map_or((body.as_str(), false), |(id, _)| (id, true));
        if !id.is_empty()
            && id != "everyone"
            && !id.starts_with("entity:")
            && (!had_colon || !SEARCH_ENTITY_TYPES.contains(&id))
            && !found.iter().any(|f| f == id)
        {
            found.push(id.to_owned());
        }
    }
    found
}

/// `addMentionedAgents`: agents tagged in a record chat join it.
async fn add_mentioned_agents(
    caller: &Caller,
    state: &ChatState,
    channel_id: &str,
    input: &PostInput,
) -> ChatResult<()> {
    if !caller.can("weldagent:use") {
        return Ok(());
    }
    let mentioned: Vec<String> = extract_chat_mentions(
        &input.content,
        input.mentions.as_deref().unwrap_or_default(),
    )
    .into_iter()
    .filter(|id| id.starts_with("agt_"))
    .collect();
    if mentioned.is_empty() {
        return Ok(());
    }
    let existing: Vec<String> = members::Entity::find()
        .select_only()
        .column(members::Column::UserId)
        .filter(members::Column::ChannelId.eq(channel_id))
        .filter(members::Column::MemberType.eq("agent"))
        .into_tuple()
        .all(&orm(&caller.db))
        .await?;
    let candidates: Vec<String> = mentioned
        .into_iter()
        .filter(|id| !existing.contains(id))
        .collect();
    if candidates.is_empty() {
        return Ok(());
    }
    let viewer = agent_viewer_for(
        &caller.user_id,
        caller
            .permissions
            .as_ref()
            .map(weldsuite_permissions::Permissions::resolved),
    );
    let blocked = inaccessible_agent_ids(&caller.db, &candidates, &viewer).await?;
    let allowed: Vec<String> = candidates
        .into_iter()
        .filter(|id| !blocked.contains(id))
        .collect();
    if allowed.is_empty() {
        return Ok(());
    }
    if let AddMembers::Added { added_user_ids } =
        add_channel_members(&caller.db, channel_id, &allowed, "agent", &now()).await?
    {
        let realtime = Caller::realtime(state);
        for agent in added_user_ids {
            realtime.member(channel_id, &agent, "joined").await;
        }
    }
    Ok(())
}

/// `POST /:entityType/:entityId/messages`: post in the record's chat,
/// creating it on the first message.
async fn send(
    State(state): State<ChatState>,
    caller: Caller,
    Path((entity_type, entity_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_send) {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    let mut channel_id: Option<String> = None;
    let result: ChatResult<Response> = async {
        let provider = resolve_access(&caller, &entity_type, &entity_id).await?;
        let can = caller.context_can();
        if !can_post_in_record_chat(provider, &caller.db, &caller.user_id, &entity_id, &can).await?
        {
            return Err(ChatError::forbidden(
                "You may read this chat but not write in it",
            ));
        }
        let got = get_or_create(&caller, provider, &entity_id).await?;
        let id = got.channel["id"].as_str().unwrap_or_default().to_owned();
        channel_id = Some(id.clone());
        add_mentioned_agents(&caller, &state, &id, &input).await?;
        let message = match post_chat_message(&caller, &state, &org, &id, input).await {
            Ok(message) => message,
            Err(PostError::Feature(404, _)) => {
                return Err(ChatError::not_found("Channel", channel_id.as_deref()));
            }
            Err(PostError::Feature(403, message)) => return Err(ChatError::forbidden(message)),
            Err(PostError::Feature(_, message)) => return Err(ChatError::bad_request(message)),
            Err(PostError::Database(error)) => return Err(ChatError::from(error)),
        };
        let name = got.channel["name"].as_str().unwrap_or_default().to_owned();
        announce_new_followers(
            &Caller::realtime(&state),
            &org,
            &id,
            &name,
            &got.new_followers,
        )
        .await;
        if got.created {
            publish_channel_event(&state, &caller, CHAT_CHANNEL_CREATED, &got.channel);
        }
        Ok(Created(
            json!({ "channel": got.channel, "message": message, "createdChannel": got.created }),
        )
        .into_response())
    }
    .await;
    answer(result, "Failed to post entity message")
}

/// `POST /:entityType/:entityId/follow`.
async fn follow(
    State(state): State<ChatState>,
    caller: Caller,
    Path((entity_type, entity_id)): Path<(String, String)>,
) -> Response {
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    let result = async {
        let provider = resolve_access(&caller, &entity_type, &entity_id).await?;
        let got = get_or_create(&caller, provider, &entity_id).await?;
        let id = got.channel["id"].as_str().unwrap_or_default().to_owned();
        let added =
            add_followers(&caller.db, &id, std::slice::from_ref(&caller.user_id), None).await?;
        let mut announced: Vec<String> = Vec::new();
        for user in got.new_followers.iter().chain(added.iter()) {
            if !announced.contains(user) {
                announced.push(user.clone());
            }
        }
        let name = got.channel["name"].as_str().unwrap_or_default().to_owned();
        announce_new_followers(&Caller::realtime(&state), &org, &id, &name, &announced).await;
        if got.created {
            publish_channel_event(&state, &caller, CHAT_CHANNEL_CREATED, &got.channel);
        }
        if got.created || !added.is_empty() {
            publish_channel_event(&state, &caller, CHAT_CHANNEL_JOINED, &got.channel);
        }
        Ok(Data(
            json!({ "channel": got.channel, "following": true, "createdChannel": got.created }),
        )
        .into_response())
    }
    .await;
    answer(result, "Failed to follow entity channel")
}

/// `DELETE /:entityType/:entityId/follow`.
async fn unfollow(
    State(state): State<ChatState>,
    caller: Caller,
    Path((entity_type, entity_id)): Path<(String, String)>,
) -> Response {
    if entity::provider(&entity_type).is_none() {
        return unknown_type(&entity_type).respond("");
    }
    let result = async {
        if let Some(channel) = find_entity_channel(&caller, &entity_type, &entity_id).await? {
            let id = channel["id"].as_str().unwrap_or_default().to_owned();
            if remove_follower(&caller.db, &id, &caller.user_id).await? {
                Caller::realtime(&state)
                    .member(&id, &caller.user_id, "left")
                    .await;
                publish_channel_event(&state, &caller, CHAT_CHANNEL_LEFT, &channel);
            }
        }
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to unfollow entity channel")
}

/// `GET /:entityType/:entityId/detail`: the record panel.
async fn detail(
    caller: Caller,
    Path((entity_type, entity_id)): Path<(String, String)>,
) -> Response {
    if let Some(provider) = entity::provider(&entity_type)
        && matches!(provider, Provider::Company | Provider::Person)
    {
        return ChatError::bad_request(format!(
            "Provider {} does not expose detail data",
            provider.type_name()
        ))
        .respond("");
    }
    let result = async {
        let provider = resolve_access(&caller, &entity_type, &entity_id).await?;
        let detail = provider.resolve_detail(&caller.db, &entity_id).await?;
        Ok(Data(detail.unwrap_or(Value::Null)).into_response())
    }
    .await;
    answer(result, "Failed to fetch entity detail")
}
