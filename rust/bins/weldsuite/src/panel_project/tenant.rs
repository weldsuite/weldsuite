//! The project state in the tenant tables (`panel_people`,
//! `panel_identity_links`, `panel_groups`, `panel_group_slots`,
//! `panel_erased_ids`, `panel_project_meta`): the `PanelProject` object's
//! statements on Postgres, scoped by workspace and project.
//!
//! Every function runs on the caller's connection. The writers run on a
//! transaction that first takes the project's lock ([`lock`]), as the
//! object runs one call at a time. Text is compared and ordered byte by
//! byte (`collate "C"`, or Rust's own string order once the rows are read)
//! and searched with ASCII case folding, as the object's SQLite does; first
//! and last seen are `timestamptz` (always the server's clock), read back as
//! the object writes them.

use std::collections::HashMap;
use std::fmt::Write as _;

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Alias, Expr, Func, IntoColumnRef, OnConflict, Query, SelectStatement};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, FromQueryResult, QueryFilter,
    QuerySelect, Select,
};
use serde_json::Value;
use sqlx::PgConnection;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use weldsuite_db::{OrmConn, orm_error};
use weldsuite_kit::generate_id;
use weldsuite_panel::ProjectRef;
use weldsuite_panel::project_state::{
    Erasure, Group, GroupOp, GroupOpsResult, GroupsPage, ListGroupsInput, ListPeopleInput,
    PeopleOp, PeoplePage, Person,
};
use weldsuite_schema::tenant::{
    panel_erased_ids, panel_group_slots, panel_groups, panel_identity_links, panel_people,
    panel_project_meta,
};

use super::rows::{Emitted, group_row, identity_row, person_row};
use super::rules::{
    FIND_BY_EMAIL_LIMIT, MAX_PROFILE_BYTES, apply_op, created, decode_cursor, email_of,
    encode_cursor, group_of, group_op_fits, js_len, js_trim, name_of, op_group_types, page_limit,
    parse_props, person_of, props_text, search_pattern, take_group_types as take,
};

/// A `timestamptz` column as the object writes times: `2026-11-18T10:00:00.000Z`.
macro_rules! iso {
    ($column:literal) => {
        concat!(
            "to_char(",
            $column,
            " at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        )
    };
}

/// A text column with ASCII letters lower-cased (SQLite's `LIKE` folding).
macro_rules! fold {
    ($column:expr) => {
        format!(
            "translate({}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')",
            $column
        )
    };
}

macro_rules! person_columns {
    () => {
        concat!(
            "user_id, email, name, properties::text as properties, ",
            iso!("first_seen"),
            " as first_seen, ",
            iso!("last_seen"),
            " as last_seen"
        )
    };
}

macro_rules! group_columns {
    () => {
        concat!(
            "group_type, group_key, properties::text as properties, ",
            iso!("first_seen"),
            " as first_seen, ",
            iso!("last_seen"),
            " as last_seen"
        )
    };
}

#[derive(Debug, sqlx::FromRow, FromQueryResult)]
struct PersonRow {
    user_id: String,
    email: Option<String>,
    name: Option<String>,
    properties: String,
    first_seen: String,
    last_seen: String,
}

#[derive(Debug, sqlx::FromRow, FromQueryResult)]
struct GroupRow {
    group_type: String,
    group_key: String,
    properties: String,
    first_seen: String,
    last_seen: String,
}

/// `workspace_id = … and project_id = …` on a table's own two columns.
fn in_project<C: ColumnTrait>(
    workspace_id: C,
    project_id: C,
    project: ProjectRef<'_>,
) -> Condition {
    Condition::all()
        .add(workspace_id.eq(project.workspace_id))
        .add(project_id.eq(project.project_id))
}

/// `to_char(<column> at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
/// (`iso!`): a `timestamptz` column as the object writes times.
fn iso_of(column: impl IntoColumnRef) -> Expr {
    Func::cust("to_char")
        .arg(Func::cust("timezone").arg("UTC").arg(Expr::col(column)))
        .arg("YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"")
        .into()
}

/// `<column>::text`: a `json` column's text as stored.
fn text_of(column: impl IntoColumnRef) -> Expr {
    Func::cast_as(Expr::col(column), Alias::new("text")).into()
}

/// `$n::json`: a profile's text stored as is.
fn json_text(text: &str) -> Expr {
    Func::cast_as(Expr::val(text), Alias::new("json")).into()
}

/// `$n::timestamptz`: a time as the object writes it.
fn at(now: &str) -> Expr {
    Func::cast_as(Expr::val(now), Alias::new("timestamptz")).into()
}

/// A SeaQuery statement the builder refused (a column without its value).
fn built(error: &sea_orm::sea_query::error::Error) -> DbErr {
    DbErr::Custom(error.to_string())
}

/// `select exists (<query>)`.
async fn exists(conn: &mut PgConnection, query: SelectStatement) -> Result<bool, DbErr> {
    let mut select = Query::select();
    select.expr_as(Expr::exists(query), Alias::new("value"));
    let row = OrmConn::new(conn)
        .query_one(&select)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("select exists".to_owned()))?;
    row.try_get("", "value")
}

/// The columns of a profile as `person_columns!` reads them.
fn person_select() -> Select<panel_people::Entity> {
    use panel_people::Column;
    panel_people::Entity::find()
        .select_only()
        .columns([Column::UserId, Column::Email, Column::Name])
        .column_as(text_of(Column::Properties), "properties")
        .column_as(iso_of(Column::FirstSeen), "first_seen")
        .column_as(iso_of(Column::LastSeen), "last_seen")
}

/// The columns of a group as `group_columns!` reads them.
fn group_select() -> Select<panel_groups::Entity> {
    use panel_groups::Column;
    panel_groups::Entity::find()
        .select_only()
        .columns([Column::GroupType, Column::GroupKey])
        .column_as(text_of(Column::Properties), "properties")
        .column_as(iso_of(Column::FirstSeen), "first_seen")
        .column_as(iso_of(Column::LastSeen), "last_seen")
}

/// Takes the project's lock until the transaction ends: one change at a
/// time per project, the object's single thread
/// (`select pg_advisory_xact_lock(hashtextextended($1, 0))`).
pub(crate) async fn lock(conn: &mut PgConnection, project: ProjectRef<'_>) -> Result<(), DbErr> {
    let key = format!("weldpanel:{}:{}", project.workspace_id, project.project_id);
    let mut lock = Query::select();
    lock.expr(
        Func::cust("pg_advisory_xact_lock").arg(Func::cust("hashtextextended").arg(key).arg(0_i64)),
    );
    OrmConn::new(conn).execute(&lock).await.map(|_| ())
}

/// `nextVersion`: the project's change counter, one up.
async fn next_version(conn: &mut PgConnection, project: ProjectRef<'_>) -> Result<i64, DbErr> {
    use panel_project_meta::{ActiveModel, Column, Entity};
    let meta = Entity::insert(ActiveModel {
        id: Set(generate_id("pnpm")),
        workspace_id: Set(project.workspace_id.to_owned()),
        project_id: Set(project.project_id.to_owned()),
        version: Set(1),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::columns([Column::WorkspaceId, Column::ProjectId])
            .value(
                Column::Version,
                sea_orm::ExprTrait::add(Expr::col((Entity, Column::Version)), 1),
            )
            .value(Column::UpdatedAt, Expr::current_timestamp())
            .to_owned(),
    )
    .exec_with_returning(&OrmConn::new(conn))
    .await?;
    Ok(meta.version)
}

/// Where the applier is in the operations stream for this project: the
/// stream (name and creation time) and the last sequence applied.
pub(crate) async fn applied(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
) -> Result<Option<(Option<String>, i64)>, DbErr> {
    use panel_project_meta::{Column, Entity};
    Entity::find()
        .select_only()
        .columns([Column::AppliedStream, Column::AppliedSeq])
        .filter(in_project(Column::WorkspaceId, Column::ProjectId, project))
        .into_tuple()
        .one(&OrmConn::new(conn))
        .await
}

/// Records the operation at `seq` of `stream` as applied.
pub(crate) async fn mark_applied(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    stream: &str,
    seq: i64,
) -> Result<(), DbErr> {
    use panel_project_meta::{ActiveModel, Column, Entity};
    Entity::insert(ActiveModel {
        id: Set(generate_id("pnpm")),
        workspace_id: Set(project.workspace_id.to_owned()),
        project_id: Set(project.project_id.to_owned()),
        applied_stream: Set(Some(stream.to_owned())),
        applied_seq: Set(seq),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::columns([Column::WorkspaceId, Column::ProjectId])
            .update_columns([Column::AppliedStream, Column::AppliedSeq])
            .value(Column::UpdatedAt, Expr::current_timestamp())
            .to_owned(),
    )
    .exec_without_returning(&OrmConn::new(conn))
    .await
    .map(|_| ())
}

async fn is_erased(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    id: &str,
) -> Result<bool, DbErr> {
    use panel_erased_ids::{Column, Entity};
    let query = Query::select()
        .expr(Expr::val(1))
        .from(Entity)
        .cond_where(
            in_project(Column::WorkspaceId, Column::ProjectId, project)
                .add(Column::ErasedId.eq(id)),
        )
        .to_owned();
    exists(conn, query).await
}

async fn find_person(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    user_id: &str,
) -> Result<Option<PersonRow>, DbErr> {
    use panel_people::Column;
    person_select()
        .filter(in_project(Column::WorkspaceId, Column::ProjectId, project))
        .filter(Column::UserId.eq(user_id))
        .into_model()
        .one(&OrmConn::new(conn))
        .await
}

/// The user an anonymous id is linked to.
async fn linked_user(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    anon_id: &str,
) -> Result<Option<String>, DbErr> {
    use panel_identity_links::{Column, Entity};
    Entity::find()
        .select_only()
        .column(Column::UserId)
        .filter(in_project(Column::WorkspaceId, Column::ProjectId, project))
        .filter(Column::AnonId.eq(anon_id))
        .into_tuple()
        .one(&OrmConn::new(conn))
        .await
}

async fn touch_person(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    user_id: &str,
    now: &str,
) -> Result<(), DbErr> {
    use panel_people::{Column, Entity};
    Entity::update_many()
        .col_expr(Column::LastSeen, at(now))
        .filter(in_project(Column::WorkspaceId, Column::ProjectId, project))
        .filter(Column::UserId.eq(user_id))
        .exec(&OrmConn::new(conn))
        .await
        .map(|_| ())
}

async fn insert_person(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    user_id: &str,
    props: &serde_json::Map<String, Value>,
    text: &str,
    now: &str,
) -> Result<(), DbErr> {
    use panel_people::{Column, Entity};
    let mut insert = Query::insert();
    insert
        .into_table(Entity)
        .columns([
            Column::Id,
            Column::WorkspaceId,
            Column::ProjectId,
            Column::UserId,
            Column::Email,
            Column::Name,
            Column::Properties,
            Column::FirstSeen,
            Column::LastSeen,
        ])
        .values([
            Expr::val(generate_id("pnpe")),
            Expr::val(project.workspace_id),
            Expr::val(project.project_id),
            Expr::val(user_id),
            Expr::val(email_of(props)),
            Expr::val(name_of(props)),
            json_text(text),
            at(now),
            at(now),
        ])
        .map_err(|error| built(&error))?;
    OrmConn::new(conn).execute(&insert).await.map(|_| ())
}

// ---------------------------------------------------------------------------
// The collector's side
// ---------------------------------------------------------------------------

/// `identify`: links the anonymous id to the user (the first link wins;
/// erased ids never link). A new link writes an `identities_v1` row, a new
/// person a `people_v1` row.
pub(crate) async fn identify(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    anon_id: &str,
    user_id: &str,
    ts: &str,
    now: &str,
) -> Result<(bool, Emitted), DbErr> {
    let mut rows = Emitted::default();
    if anon_id.is_empty() || user_id.is_empty() {
        return Ok((false, rows));
    }
    if is_erased(conn, project, anon_id).await? || is_erased(conn, project, user_id).await? {
        return Ok((false, rows));
    }
    let linked = if let Some(existing) = linked_user(conn, project, anon_id).await? {
        // The first link wins: an anonymous id never moves to another user.
        existing == user_id
    } else {
        panel_identity_links::Entity::insert(panel_identity_links::ActiveModel {
            id: Set(generate_id("pnil")),
            workspace_id: Set(project.workspace_id.to_owned()),
            project_id: Set(project.project_id.to_owned()),
            anon_id: Set(anon_id.to_owned()),
            user_id: Set(user_id.to_owned()),
            ts: Set(ts.to_owned()),
        })
        .exec_without_returning(&OrmConn::new(&mut *conn))
        .await?;
        rows.identities
            .push(identity_row(project, anon_id, user_id, ts));
        true
    };
    if !linked {
        return Ok((false, rows));
    }
    if find_person(conn, project, user_id).await?.is_some() {
        touch_person(conn, project, user_id, now).await?;
    } else {
        let props = created(ts);
        let text = props_text(&props);
        insert_person(conn, project, user_id, &props, &text, now).await?;
        let version = next_version(conn, project).await?;
        rows.people
            .push(person_row(project, user_id, version, now, &text, false));
    }
    Ok((true, rows))
}

/// `applyPeopleOps`: the operations in order; one `people_v1` row per
/// changed profile (its state after the last of its operations).
pub(crate) async fn apply_people_ops(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    ops: &[PeopleOp],
    now: &str,
) -> Result<Emitted, DbErr> {
    let mut changed: Vec<(String, Value)> = Vec::new();
    for op in ops {
        let (user_id, ts) = person_of(op);
        if user_id.is_empty() || is_erased(conn, project, user_id).await? {
            continue;
        }
        let existing = find_person(conn, project, user_id).await?;
        let mut props = existing
            .as_ref()
            .map_or_else(|| created(ts), |row| parse_props(&row.properties));
        let before = props_text(&props);
        apply_op(&mut props, op.into());
        let after = props_text(&props);
        if js_len(&after) > MAX_PROFILE_BYTES {
            continue;
        }
        if existing.is_some() && before == after {
            touch_person(conn, project, user_id, now).await?;
            continue;
        }
        if existing.is_some() {
            use panel_people::{Column, Entity};
            Entity::update_many()
                .col_expr(Column::Email, Expr::value(email_of(&props)))
                .col_expr(Column::Name, Expr::value(name_of(&props)))
                .col_expr(Column::Properties, json_text(&after))
                .col_expr(Column::LastSeen, at(now))
                .filter(in_project(Column::WorkspaceId, Column::ProjectId, project))
                .filter(Column::UserId.eq(user_id))
                .exec(&OrmConn::new(&mut *conn))
                .await?;
        } else {
            insert_person(conn, project, user_id, &props, &after, now).await?;
        }
        let version = next_version(conn, project).await?;
        let row = person_row(project, user_id, version, now, &after, false);
        match changed.iter_mut().find(|(id, _)| id == user_id) {
            Some(entry) => entry.1 = row,
            None => changed.push((user_id.to_owned(), row)),
        }
    }
    Ok(Emitted {
        people: changed.into_iter().map(|(_, row)| row).collect(),
        ..Emitted::default()
    })
}

// ---------------------------------------------------------------------------
// People: reads
// ---------------------------------------------------------------------------

/// The profiles of `rows`, each with its anonymous ids (by link time, then
/// id, byte by byte: `order by ts collate "C", anon_id collate "C"`).
async fn to_people(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    rows: Vec<PersonRow>,
) -> Result<Vec<Person>, DbErr> {
    use panel_identity_links::{Column, Entity};
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let users: Vec<&str> = rows.iter().map(|row| row.user_id.as_str()).collect();
    // (ts, anon_id, user_id): Rust orders strings byte by byte.
    let mut links: Vec<(String, String, String)> = Entity::find()
        .select_only()
        .columns([Column::Ts, Column::AnonId, Column::UserId])
        .filter(in_project(Column::WorkspaceId, Column::ProjectId, project))
        .filter(Column::UserId.is_in(users))
        .into_tuple()
        .all(&OrmConn::new(&mut *conn))
        .await?;
    links.sort();
    let mut anon_ids: HashMap<String, Vec<String>> = HashMap::new();
    for (_, anon_id, user_id) in links {
        anon_ids.entry(user_id).or_default().push(anon_id);
    }
    Ok(rows
        .into_iter()
        .map(|row| Person {
            anon_ids: anon_ids.remove(&row.user_id).unwrap_or_default(),
            properties: parse_props(&row.properties),
            user_id: row.user_id,
            email: row.email,
            name: row.name,
            first_seen: row.first_seen,
            last_seen: row.last_seen,
        })
        .collect())
}

/// `getPerson`: a user id's profile, or that of the user an anonymous id is
/// linked to.
pub(crate) async fn get_person(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    id: &str,
) -> Result<Option<Person>, DbErr> {
    let row = match find_person(conn, project, id).await? {
        Some(row) => Some(row),
        None => match linked_user(conn, project, id).await? {
            Some(user_id) => find_person(conn, project, &user_id).await?,
            None => None,
        },
    };
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(to_people(conn, project, vec![row]).await?.pop())
}

/// Whether a cursor's time is one `first_seen` / `last_seen` reads back as
/// (then it is compared as a time, on the index; else as text, as the
/// object compares it).
fn canonical_time(text: &str) -> bool {
    OffsetDateTime::parse(text, &Rfc3339)
        .is_ok_and(|at| weldsuite_events::iso_timestamp(at) == text)
}

/// The cursor condition on (`last_seen`, `key`), with its two parameters
/// numbered `at` and `at + 1`.
fn after_condition(key: &str, at: usize, typed: bool) -> String {
    let next = at + 1;
    if typed {
        format!(
            " and (last_seen < ${at}::timestamptz or (last_seen = ${at}::timestamptz and {key} collate \"C\" < ${next}))"
        )
    } else {
        let seen = iso!("last_seen");
        format!(
            " and ({seen} collate \"C\" < ${at} or ({seen} = ${at} and {key} collate \"C\" < ${next}))"
        )
    }
}

/// `listPeople`: a page, most recently seen first; `search` matches the user
/// id, the email and the name.
pub(crate) async fn list_people(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    input: &ListPeopleInput,
) -> Result<PeoplePage, DbErr> {
    let limit = page_limit(input.limit);
    let (total_count, mut rows) = people_page(conn, project, input, limit)
        .await
        .map_err(orm_error)?;
    let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
    rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
    let cursor = rows
        .last()
        .filter(|_| has_more)
        .map(|row| encode_cursor(&row.last_seen, &row.user_id));
    Ok(PeoplePage {
        people: to_people(conn, project, rows).await?,
        cursor,
        total_count: u64::try_from(total_count).unwrap_or_default(),
    })
}

/// [`list_people`]'s count and its page of `limit + 1` profiles.
#[allow(
    clippy::disallowed_methods,
    reason = "a keyset page in byte order (`collate \"C\"`), on its text or its time, and its \
              count on the same search with SQLite's ASCII case folding (`translate … like`), \
              which the ORM cannot express"
)]
async fn people_page(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    input: &ListPeopleInput,
    limit: i64,
) -> sqlx::Result<(i64, Vec<PersonRow>)> {
    let pattern = search_pattern(input.search.as_deref());
    let mut conditions = String::new();
    let mut next = 3;
    if pattern.is_some() {
        let _ = write!(
            conditions,
            " and ({} like $3 escape '\\' or {} like $3 escape '\\' or {} like $3 escape '\\')",
            fold!("user_id"),
            fold!("email"),
            fold!("name")
        );
        next = 4;
    }
    let mut count = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
        "select count(*) from panel_people where workspace_id = $1 and project_id = $2{conditions}"
    )))
    .bind(project.workspace_id)
    .bind(project.project_id);
    if let Some(pattern) = &pattern {
        count = count.bind(pattern);
    }
    let total_count = count.fetch_one(&mut *conn).await?;

    let after = decode_cursor(input.cursor.as_ref().and_then(Option::as_deref));
    if let Some((last_seen, _)) = &after {
        conditions.push_str(&after_condition("user_id", next, canonical_time(last_seen)));
        next += 2;
    }
    let mut page = sqlx::query_as::<_, PersonRow>(sqlx::AssertSqlSafe(format!(
        "select {} from panel_people where workspace_id = $1 and project_id = $2{conditions} \
         order by last_seen desc, user_id collate \"C\" desc limit ${next}",
        person_columns!()
    )))
    .bind(project.workspace_id)
    .bind(project.project_id);
    if let Some(pattern) = &pattern {
        page = page.bind(pattern);
    }
    if let Some((last_seen, user_id)) = &after {
        page = page.bind(last_seen).bind(user_id);
    }
    let rows = page.bind(limit + 1).fetch_all(&mut *conn).await?;
    Ok((total_count, rows))
}

/// `findByEmail`: the profiles whose `$email` is the address (trimmed and
/// lower-cased), most recently seen first, at most 50.
pub(crate) async fn find_by_email(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    email: &str,
) -> Result<Vec<Person>, DbErr> {
    let rows = by_email(conn, project, email).await.map_err(orm_error)?;
    to_people(conn, project, rows).await
}

/// [`find_by_email`]'s profiles.
#[allow(
    clippy::disallowed_methods,
    reason = "ordered and limited in byte order (`user_id collate \"C\"`), which the ORM cannot express"
)]
async fn by_email(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    email: &str,
) -> sqlx::Result<Vec<PersonRow>> {
    sqlx::query_as(concat!(
        "select ",
        person_columns!(),
        " from panel_people where workspace_id = $1 and project_id = $2 and email = $3 \
         order by last_seen desc, user_id collate \"C\" desc limit $4"
    ))
    .bind(project.workspace_id)
    .bind(project.project_id)
    .bind(js_trim(email).to_lowercase())
    .bind(FIND_BY_EMAIL_LIMIT)
    .fetch_all(&mut *conn)
    .await
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

/// `erase`: the id names a user, or an anonymous id linked to one; the
/// profile and its links go at once and every id joins the erased list.
/// A `people_v1` row marks the profile deleted. (The live view is the
/// caller's: it is in Valkey.)
pub(crate) async fn erase(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    given: &str,
    now: &str,
) -> Result<(Erasure, Emitted), DbErr> {
    let user_id = if find_person(conn, project, given).await?.is_some() {
        Some(given.to_owned())
    } else if let Some(user_id) = linked_user(conn, project, given).await? {
        Some(user_id)
    } else {
        use panel_identity_links::{Column, Entity};
        let query = Query::select()
            .expr(Expr::val(1))
            .from(Entity)
            .cond_where(
                in_project(Column::WorkspaceId, Column::ProjectId, project)
                    .add(Column::UserId.eq(given)),
            )
            .to_owned();
        let has_links = exists(conn, query).await?;
        has_links.then(|| given.to_owned())
    };

    let mut ids = vec![given.to_owned()];
    let mut rows = Emitted::default();
    if let Some(user_id) = &user_id {
        let anon_ids = linked_anon_ids(conn, project, user_id).await?;
        for id in std::iter::once(user_id.clone()).chain(anon_ids) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        {
            use panel_people::{Column, Entity};
            Entity::delete_many()
                .filter(in_project(Column::WorkspaceId, Column::ProjectId, project))
                .filter(Column::UserId.eq(user_id))
                .exec(&OrmConn::new(&mut *conn))
                .await?;
        }
        {
            use panel_identity_links::{Column, Entity};
            Entity::delete_many()
                .filter(in_project(Column::WorkspaceId, Column::ProjectId, project))
                .filter(Column::UserId.eq(user_id))
                .exec(&OrmConn::new(&mut *conn))
                .await?;
        }
    }
    for id in &ids {
        use panel_erased_ids::{Column, Entity};
        let mut insert = Query::insert();
        insert
            .into_table(Entity)
            .columns([
                Column::Id,
                Column::WorkspaceId,
                Column::ProjectId,
                Column::ErasedId,
                Column::ErasedAt,
            ])
            .values([
                Expr::val(generate_id("pnei")),
                Expr::val(project.workspace_id),
                Expr::val(project.project_id),
                Expr::val(id),
                at(now),
            ])
            .map_err(|error| built(&error))?
            .on_conflict(
                OnConflict::columns([Column::WorkspaceId, Column::ProjectId, Column::ErasedId])
                    .do_nothing()
                    .to_owned(),
            );
        OrmConn::new(&mut *conn).execute(&insert).await?;
    }
    if let Some(user_id) = &user_id {
        let version = next_version(conn, project).await?;
        rows.people
            .push(person_row(project, user_id, version, now, "{}", true));
    }
    Ok((
        Erasure {
            user_id,
            erased_ids: ids,
        },
        rows,
    ))
}

/// The anonymous ids linked to the user, by link id byte by byte
/// (`order by id collate "C"`).
async fn linked_anon_ids(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    user_id: &str,
) -> Result<Vec<String>, DbErr> {
    use panel_identity_links::{Column, Entity};
    let mut links: Vec<(String, String)> = Entity::find()
        .select_only()
        .columns([Column::Id, Column::AnonId])
        .filter(in_project(Column::WorkspaceId, Column::ProjectId, project))
        .filter(Column::UserId.eq(user_id))
        .into_tuple()
        .all(&OrmConn::new(conn))
        .await?;
    // By id (the key), byte by byte as Rust orders strings.
    links.sort();
    Ok(links.into_iter().map(|(_, anon_id)| anon_id).collect())
}

/// `erasedIds`: in byte order (`order by erased_id collate "C"`).
pub(crate) async fn erased_ids(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
) -> Result<Vec<String>, DbErr> {
    use panel_erased_ids::{Column, Entity};
    let mut ids: Vec<String> = Entity::find()
        .select_only()
        .column(Column::ErasedId)
        .filter(in_project(Column::WorkspaceId, Column::ProjectId, project))
        .into_tuple()
        .all(&OrmConn::new(conn))
        .await?;
    ids.sort();
    Ok(ids)
}

/// `hasIdentifiedUsers`: whether any link exists.
pub(crate) async fn has_identified_users(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
) -> Result<bool, DbErr> {
    use panel_identity_links::{Column, Entity};
    let query = Query::select()
        .expr(Expr::val(1))
        .from(Entity)
        .cond_where(in_project(Column::WorkspaceId, Column::ProjectId, project))
        .to_owned();
    exists(conn, query).await
}

/// `clearErased`: the ids no longer need excluding.
pub(crate) async fn clear_erased(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    ids: &[String],
) -> Result<(), DbErr> {
    use panel_erased_ids::{Column, Entity};
    Entity::delete_many()
        .filter(in_project(Column::WorkspaceId, Column::ProjectId, project))
        .filter(Column::ErasedId.is_in(ids))
        .exec(&OrmConn::new(conn))
        .await
        .map(|_| ())
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/// The project's group types, in the order they were taken
/// (`order by position, group_type collate "C"`).
pub(crate) async fn group_types(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
) -> Result<Vec<String>, DbErr> {
    use panel_group_slots::{Column, Entity};
    let mut slots: Vec<(i32, String)> = Entity::find()
        .select_only()
        .columns([Column::Position, Column::GroupType])
        .filter(in_project(Column::WorkspaceId, Column::ProjectId, project))
        .into_tuple()
        .all(&OrmConn::new(conn))
        .await?;
    slots.sort();
    Ok(slots
        .into_iter()
        .map(|(_, group_type)| group_type)
        .collect())
}

/// `takeGroupTypes`: each new valid type gets the next slot while fewer than
/// `MAX_GROUP_TYPES` are taken. Returns the types after, and whether any
/// was taken.
pub(crate) async fn take_group_types(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    types: &[String],
    now: &str,
) -> Result<(Vec<String>, bool), DbErr> {
    use panel_group_slots::{Column, Entity};
    let mut current = group_types(conn, project).await?;
    let before = current.len();
    let changed = take(&mut current, types);
    for group_type in &current[before..] {
        // `(select coalesce(max(position), 0) + 1 from panel_group_slots
        // where workspace_id = … and project_id = …)`.
        let position = Query::select()
            .expr(sea_orm::ExprTrait::add(
                Expr::from(Func::coalesce([
                    Func::max(Expr::col(Column::Position)).into(),
                    Expr::val(0),
                ])),
                1,
            ))
            .from(Entity)
            .cond_where(in_project(Column::WorkspaceId, Column::ProjectId, project))
            .to_owned();
        let mut insert = Query::insert();
        insert
            .into_table(Entity)
            .columns([
                Column::Id,
                Column::WorkspaceId,
                Column::ProjectId,
                Column::GroupType,
                Column::Position,
                Column::TakenAt,
            ])
            .values([
                Expr::val(generate_id("pngs")),
                Expr::val(project.workspace_id),
                Expr::val(project.project_id),
                Expr::val(group_type),
                Expr::from(position),
                at(now),
            ])
            .map_err(|error| built(&error))?;
        OrmConn::new(&mut *conn).execute(&insert).await?;
    }
    Ok((current, changed))
}

/// `releaseGroupType`: frees the type's slot; true when it had one.
pub(crate) async fn release_group_type(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    group_type: &str,
) -> Result<bool, DbErr> {
    use panel_group_slots::{Column, Entity};
    let done = Entity::delete_many()
        .filter(in_project(Column::WorkspaceId, Column::ProjectId, project))
        .filter(Column::GroupType.eq(group_type))
        .exec(&OrmConn::new(conn))
        .await?;
    Ok(done.rows_affected > 0)
}

async fn find_group(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    group_type: &str,
    group_key: &str,
) -> Result<Option<GroupRow>, DbErr> {
    use panel_groups::Column;
    group_select()
        .filter(in_project(Column::WorkspaceId, Column::ProjectId, project))
        .filter(Column::GroupType.eq(group_type))
        .filter(Column::GroupKey.eq(group_key))
        .into_model()
        .one(&OrmConn::new(conn))
        .await
}

fn to_group(row: GroupRow) -> Group {
    Group {
        properties: parse_props(&row.properties),
        group_type: row.group_type,
        group_key: row.group_key,
        first_seen: row.first_seen,
        last_seen: row.last_seen,
    }
}

/// `update panel_groups set …` of one group.
async fn update_group(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    (group_type, group_key): (&str, &str),
    properties: Option<&str>,
    now: &str,
) -> Result<(), DbErr> {
    use panel_groups::{Column, Entity};
    let mut update = Entity::update_many();
    if let Some(properties) = properties {
        update = update.col_expr(Column::Properties, json_text(properties));
    }
    update
        .col_expr(Column::LastSeen, at(now))
        .filter(in_project(Column::WorkspaceId, Column::ProjectId, project))
        .filter(Column::GroupType.eq(group_type))
        .filter(Column::GroupKey.eq(group_key))
        .exec(&OrmConn::new(conn))
        .await
        .map(|_| ())
}

/// `insert into panel_groups …` of a new group.
async fn insert_group(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    (group_type, group_key): (&str, &str),
    properties: &str,
    now: &str,
) -> Result<(), DbErr> {
    use panel_groups::{Column, Entity};
    let mut insert = Query::insert();
    insert
        .into_table(Entity)
        .columns([
            Column::Id,
            Column::WorkspaceId,
            Column::ProjectId,
            Column::GroupType,
            Column::GroupKey,
            Column::Properties,
            Column::FirstSeen,
            Column::LastSeen,
        ])
        .values([
            Expr::val(generate_id("pngr")),
            Expr::val(project.workspace_id),
            Expr::val(project.project_id),
            Expr::val(group_type),
            Expr::val(group_key),
            json_text(properties),
            at(now),
            at(now),
        ])
        .map_err(|error| built(&error))?;
    OrmConn::new(conn).execute(&insert).await.map(|_| ())
}

/// `applyGroupOps`: the operations' types take free slots, then each
/// operation of a type with a slot applies; one `groups_v1` row per changed
/// group. Also answers whether the project's types changed.
pub(crate) async fn apply_group_ops(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    ops: &[GroupOp],
    now: &str,
) -> Result<(GroupOpsResult, Emitted, bool), DbErr> {
    let (types, types_changed) = take_group_types(conn, project, &op_group_types(ops), now).await?;
    let mut changed: Vec<((String, String), Value)> = Vec::new();
    let mut applied = 0_u64;
    for op in ops {
        if !group_op_fits(op, &types) {
            continue;
        }
        let (group_type, group_key) = group_of(op);
        let existing = find_group(conn, project, group_type, group_key).await?;
        let mut props = existing
            .as_ref()
            .map(|row| parse_props(&row.properties))
            .unwrap_or_default();
        let before = props_text(&props);
        apply_op(&mut props, op.into());
        let after = props_text(&props);
        if js_len(&after) > MAX_PROFILE_BYTES {
            continue;
        }
        applied += 1;
        let group = (group_type, group_key);
        if existing.is_some() && before == after {
            update_group(conn, project, group, None, now).await?;
            continue;
        }
        if existing.is_some() {
            update_group(conn, project, group, Some(&after), now).await?;
        } else {
            insert_group(conn, project, group, &after, now).await?;
        }
        let version = next_version(conn, project).await?;
        let row = group_row(project, group_type, group_key, version, now, &after, false);
        let key = (group_type.to_owned(), group_key.to_owned());
        match changed.iter_mut().find(|(known, _)| *known == key) {
            Some(entry) => entry.1 = row,
            None => changed.push((key, row)),
        }
    }
    let total = u64::try_from(ops.len()).unwrap_or(u64::MAX);
    Ok((
        GroupOpsResult {
            applied,
            dropped: total - applied,
            types,
        },
        Emitted {
            groups: changed.into_iter().map(|(_, row)| row).collect(),
            ..Emitted::default()
        },
        types_changed,
    ))
}

/// `getGroup`.
pub(crate) async fn get_group(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    group_type: &str,
    group_key: &str,
) -> Result<Option<Group>, DbErr> {
    Ok(find_group(conn, project, group_type, group_key)
        .await?
        .map(to_group))
}

/// A property as SQLite's `json_extract` reads it for `LIKE`: `true` and
/// `false` are 1 and 0.
fn property_text(key: &str) -> String {
    format!(
        "(case json_typeof(properties -> '{key}') when 'boolean' \
         then (case when (properties ->> '{key}') = 'true' then '1' else '0' end) \
         else properties ->> '{key}' end)"
    )
}

/// `listGroups`: one type's groups, most recently seen first; `search`
/// matches the key and the `$name` / `name` property.
pub(crate) async fn list_groups(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    input: &ListGroupsInput,
) -> Result<GroupsPage, DbErr> {
    let limit = page_limit(input.limit);
    let (total_count, mut rows) = groups_page(conn, project, input, limit)
        .await
        .map_err(orm_error)?;
    let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
    rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
    let cursor = rows
        .last()
        .filter(|_| has_more)
        .map(|row| encode_cursor(&row.last_seen, &row.group_key));
    Ok(GroupsPage {
        groups: rows.into_iter().map(to_group).collect(),
        cursor,
        total_count: u64::try_from(total_count).unwrap_or_default(),
    })
}

/// [`list_groups`]' count and its page of `limit + 1` groups.
#[allow(
    clippy::disallowed_methods,
    reason = "a keyset page in byte order (`collate \"C\"`), on its text or its time, and its \
              count on the same search with SQLite's ASCII case folding and `json_extract` \
              reading (`translate … like`), which the ORM cannot express"
)]
async fn groups_page(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    input: &ListGroupsInput,
    limit: i64,
) -> sqlx::Result<(i64, Vec<GroupRow>)> {
    let pattern = search_pattern(input.search.as_deref());
    let mut conditions = String::new();
    let mut next = 4;
    if pattern.is_some() {
        let _ = write!(
            conditions,
            " and ({} like $4 escape '\\' or {} like $4 escape '\\' or {} like $4 escape '\\')",
            fold!("group_key"),
            fold!(property_text("$name")),
            fold!(property_text("name"))
        );
        next = 5;
    }
    let mut count = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
        "select count(*) from panel_groups where workspace_id = $1 and project_id = $2 and group_type = $3{conditions}"
    )))
    .bind(project.workspace_id)
    .bind(project.project_id)
    .bind(&input.group_type);
    if let Some(pattern) = &pattern {
        count = count.bind(pattern);
    }
    let total_count = count.fetch_one(&mut *conn).await?;

    let after = decode_cursor(input.cursor.as_ref().and_then(Option::as_deref));
    if let Some((last_seen, _)) = &after {
        conditions.push_str(&after_condition(
            "group_key",
            next,
            canonical_time(last_seen),
        ));
        next += 2;
    }
    let mut page = sqlx::query_as::<_, GroupRow>(sqlx::AssertSqlSafe(format!(
        "select {} from panel_groups where workspace_id = $1 and project_id = $2 and group_type = $3{conditions} \
         order by last_seen desc, group_key collate \"C\" desc limit ${next}",
        group_columns!()
    )))
    .bind(project.workspace_id)
    .bind(project.project_id)
    .bind(&input.group_type);
    if let Some(pattern) = &pattern {
        page = page.bind(pattern);
    }
    if let Some((last_seen, group_key)) = &after {
        page = page.bind(last_seen).bind(group_key);
    }
    let rows = page.bind(limit + 1).fetch_all(conn).await?;
    Ok((total_count, rows))
}

/// `deleteGroup`: removes the profile and writes a `deleted` row to
/// `groups_v1`; false when there was none.
pub(crate) async fn delete_group(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    group_type: &str,
    group_key: &str,
    now: &str,
) -> Result<(bool, Emitted), DbErr> {
    use panel_groups::{Column, Entity};
    if find_group(conn, project, group_type, group_key)
        .await?
        .is_none()
    {
        return Ok((false, Emitted::default()));
    }
    Entity::delete_many()
        .filter(in_project(Column::WorkspaceId, Column::ProjectId, project))
        .filter(Column::GroupType.eq(group_type))
        .filter(Column::GroupKey.eq(group_key))
        .exec(&OrmConn::new(&mut *conn))
        .await?;
    let version = next_version(conn, project).await?;
    Ok((
        true,
        Emitted {
            groups: vec![group_row(
                project, group_type, group_key, version, now, "{}", true,
            )],
            ..Emitted::default()
        },
    ))
}
