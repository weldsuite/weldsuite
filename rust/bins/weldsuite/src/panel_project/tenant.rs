//! The project state in the tenant tables (`panel_people`,
//! `panel_identity_links`, `panel_groups`, `panel_group_slots`,
//! `panel_erased_ids`, `panel_project_meta`): the `PanelProject` object's
//! statements on Postgres, scoped by workspace and project.
//!
//! Every function runs on the caller's connection. The writers run on a
//! transaction that first takes the project's lock ([`lock`]), as the
//! object runs one call at a time. Text is compared and ordered byte by
//! byte (`collate "C"`) and searched with ASCII case folding, as the
//! object's SQLite does; first and last seen are `timestamptz` (always the
//! server's clock), read back as the object writes them.

use std::collections::HashMap;
use std::fmt::Write as _;

use serde_json::Value;
use sqlx::PgConnection;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use weldsuite_kit::generate_id;
use weldsuite_panel::ProjectRef;
use weldsuite_panel::project_state::{
    Erasure, Group, GroupOp, GroupOpsResult, GroupsPage, ListGroupsInput, ListPeopleInput,
    PeopleOp, PeoplePage, Person,
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

#[derive(Debug, sqlx::FromRow)]
struct PersonRow {
    user_id: String,
    email: Option<String>,
    name: Option<String>,
    properties: String,
    first_seen: String,
    last_seen: String,
}

#[derive(Debug, sqlx::FromRow)]
struct GroupRow {
    group_type: String,
    group_key: String,
    properties: String,
    first_seen: String,
    last_seen: String,
}

/// Takes the project's lock until the transaction ends: one change at a
/// time per project, the object's single thread.
pub(crate) async fn lock(conn: &mut PgConnection, project: ProjectRef<'_>) -> sqlx::Result<()> {
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "weldpanel:{}:{}",
            project.workspace_id, project.project_id
        ))
        .execute(conn)
        .await
        .map(|_| ())
}

/// `nextVersion`: the project's change counter, one up.
async fn next_version(conn: &mut PgConnection, project: ProjectRef<'_>) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        "insert into panel_project_meta (id, workspace_id, project_id, version) values ($1, $2, $3, 1) \
         on conflict (workspace_id, project_id) \
         do update set version = panel_project_meta.version + 1, updated_at = now() \
         returning version",
    )
    .bind(generate_id("pnpm"))
    .bind(project.workspace_id)
    .bind(project.project_id)
    .fetch_one(conn)
    .await
}

/// Where the applier is in the operations stream for this project: the
/// stream (name and creation time) and the last sequence applied.
pub(crate) async fn applied(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
) -> sqlx::Result<Option<(Option<String>, i64)>> {
    sqlx::query_as(
        "select applied_stream, applied_seq from panel_project_meta \
         where workspace_id = $1 and project_id = $2",
    )
    .bind(project.workspace_id)
    .bind(project.project_id)
    .fetch_optional(conn)
    .await
}

/// Records the operation at `seq` of `stream` as applied.
pub(crate) async fn mark_applied(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    stream: &str,
    seq: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "insert into panel_project_meta (id, workspace_id, project_id, applied_stream, applied_seq) \
         values ($1, $2, $3, $4, $5) \
         on conflict (workspace_id, project_id) \
         do update set applied_stream = excluded.applied_stream, applied_seq = excluded.applied_seq, updated_at = now()",
    )
    .bind(generate_id("pnpm"))
    .bind(project.workspace_id)
    .bind(project.project_id)
    .bind(stream)
    .bind(seq)
    .execute(conn)
    .await
    .map(|_| ())
}

async fn is_erased(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    id: &str,
) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        "select exists (select 1 from panel_erased_ids \
         where workspace_id = $1 and project_id = $2 and erased_id = $3)",
    )
    .bind(project.workspace_id)
    .bind(project.project_id)
    .bind(id)
    .fetch_one(conn)
    .await
}

async fn find_person(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    user_id: &str,
) -> sqlx::Result<Option<PersonRow>> {
    sqlx::query_as(concat!(
        "select ",
        person_columns!(),
        " from panel_people where workspace_id = $1 and project_id = $2 and user_id = $3"
    ))
    .bind(project.workspace_id)
    .bind(project.project_id)
    .bind(user_id)
    .fetch_optional(conn)
    .await
}

/// The user an anonymous id is linked to.
async fn linked_user(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    anon_id: &str,
) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar(
        "select user_id from panel_identity_links \
         where workspace_id = $1 and project_id = $2 and anon_id = $3",
    )
    .bind(project.workspace_id)
    .bind(project.project_id)
    .bind(anon_id)
    .fetch_optional(conn)
    .await
}

async fn touch_person(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    user_id: &str,
    now: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "update panel_people set last_seen = $4::timestamptz \
         where workspace_id = $1 and project_id = $2 and user_id = $3",
    )
    .bind(project.workspace_id)
    .bind(project.project_id)
    .bind(user_id)
    .bind(now)
    .execute(conn)
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
) -> sqlx::Result<()> {
    sqlx::query(
        "insert into panel_people (id, workspace_id, project_id, user_id, email, name, properties, first_seen, last_seen) \
         values ($1, $2, $3, $4, $5, $6, $7::json, $8::timestamptz, $8::timestamptz)",
    )
    .bind(generate_id("pnpe"))
    .bind(project.workspace_id)
    .bind(project.project_id)
    .bind(user_id)
    .bind(email_of(props))
    .bind(name_of(props))
    .bind(text)
    .bind(now)
    .execute(conn)
    .await
    .map(|_| ())
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
) -> sqlx::Result<(bool, Emitted)> {
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
        sqlx::query(
            "insert into panel_identity_links (id, workspace_id, project_id, anon_id, user_id, ts) \
             values ($1, $2, $3, $4, $5, $6)",
        )
        .bind(generate_id("pnil"))
        .bind(project.workspace_id)
        .bind(project.project_id)
        .bind(anon_id)
        .bind(user_id)
        .bind(ts)
        .execute(&mut *conn)
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
) -> sqlx::Result<Emitted> {
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
            sqlx::query(
                "update panel_people set email = $4, name = $5, properties = $6::json, last_seen = $7::timestamptz \
                 where workspace_id = $1 and project_id = $2 and user_id = $3",
            )
            .bind(project.workspace_id)
            .bind(project.project_id)
            .bind(user_id)
            .bind(email_of(&props))
            .bind(name_of(&props))
            .bind(&after)
            .bind(now)
            .execute(&mut *conn)
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

/// The profiles of `rows`, each with its anonymous ids (by link time).
async fn to_people(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    rows: Vec<PersonRow>,
) -> sqlx::Result<Vec<Person>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let users: Vec<&str> = rows.iter().map(|row| row.user_id.as_str()).collect();
    let links: Vec<(String, String)> = sqlx::query_as(
        "select user_id, anon_id from panel_identity_links \
         where workspace_id = $1 and project_id = $2 and user_id = any($3) \
         order by ts collate \"C\", anon_id collate \"C\"",
    )
    .bind(project.workspace_id)
    .bind(project.project_id)
    .bind(&users)
    .fetch_all(conn)
    .await?;
    let mut anon_ids: HashMap<String, Vec<String>> = HashMap::new();
    for (user_id, anon_id) in links {
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
) -> sqlx::Result<Option<Person>> {
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
) -> sqlx::Result<PeoplePage> {
    let limit = page_limit(input.limit);
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
    let mut rows = page.bind(limit + 1).fetch_all(&mut *conn).await?;

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

/// `findByEmail`: the profiles whose `$email` is the address (trimmed and
/// lower-cased), most recently seen first, at most 50.
pub(crate) async fn find_by_email(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    email: &str,
) -> sqlx::Result<Vec<Person>> {
    let rows: Vec<PersonRow> = sqlx::query_as(concat!(
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
    .await?;
    to_people(conn, project, rows).await
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
) -> sqlx::Result<(Erasure, Emitted)> {
    let user_id = if find_person(conn, project, given).await?.is_some() {
        Some(given.to_owned())
    } else if let Some(user_id) = linked_user(conn, project, given).await? {
        Some(user_id)
    } else {
        let has_links: bool = sqlx::query_scalar(
            "select exists (select 1 from panel_identity_links \
             where workspace_id = $1 and project_id = $2 and user_id = $3)",
        )
        .bind(project.workspace_id)
        .bind(project.project_id)
        .bind(given)
        .fetch_one(&mut *conn)
        .await?;
        has_links.then(|| given.to_owned())
    };

    let mut ids = vec![given.to_owned()];
    let mut rows = Emitted::default();
    if let Some(user_id) = &user_id {
        let anon_ids: Vec<String> = sqlx::query_scalar(
            "select anon_id from panel_identity_links \
             where workspace_id = $1 and project_id = $2 and user_id = $3 order by id collate \"C\"",
        )
        .bind(project.workspace_id)
        .bind(project.project_id)
        .bind(user_id)
        .fetch_all(&mut *conn)
        .await?;
        for id in std::iter::once(user_id.clone()).chain(anon_ids) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        for table in ["panel_people", "panel_identity_links"] {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "delete from {table} where workspace_id = $1 and project_id = $2 and user_id = $3"
            )))
            .bind(project.workspace_id)
            .bind(project.project_id)
            .bind(user_id)
            .execute(&mut *conn)
            .await?;
        }
    }
    for id in &ids {
        sqlx::query(
            "insert into panel_erased_ids (id, workspace_id, project_id, erased_id, erased_at) \
             values ($1, $2, $3, $4, $5::timestamptz) \
             on conflict (workspace_id, project_id, erased_id) do nothing",
        )
        .bind(generate_id("pnei"))
        .bind(project.workspace_id)
        .bind(project.project_id)
        .bind(id)
        .bind(now)
        .execute(&mut *conn)
        .await?;
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

/// `erasedIds`: in byte order.
pub(crate) async fn erased_ids(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar(
        "select erased_id from panel_erased_ids where workspace_id = $1 and project_id = $2 \
         order by erased_id collate \"C\"",
    )
    .bind(project.workspace_id)
    .bind(project.project_id)
    .fetch_all(conn)
    .await
}

/// `hasIdentifiedUsers`: whether any link exists.
pub(crate) async fn has_identified_users(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        "select exists (select 1 from panel_identity_links where workspace_id = $1 and project_id = $2)",
    )
    .bind(project.workspace_id)
    .bind(project.project_id)
    .fetch_one(conn)
    .await
}

/// `clearErased`: the ids no longer need excluding.
pub(crate) async fn clear_erased(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    ids: &[String],
) -> sqlx::Result<()> {
    sqlx::query(
        "delete from panel_erased_ids where workspace_id = $1 and project_id = $2 and erased_id = any($3)",
    )
    .bind(project.workspace_id)
    .bind(project.project_id)
    .bind(ids)
    .execute(conn)
    .await
    .map(|_| ())
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/// The project's group types, in the order they were taken.
pub(crate) async fn group_types(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar(
        "select group_type from panel_group_slots where workspace_id = $1 and project_id = $2 \
         order by position, group_type collate \"C\"",
    )
    .bind(project.workspace_id)
    .bind(project.project_id)
    .fetch_all(conn)
    .await
}

/// `takeGroupTypes`: each new valid type gets the next slot while fewer than
/// `MAX_GROUP_TYPES` are taken. Returns the types after, and whether any
/// was taken.
pub(crate) async fn take_group_types(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    types: &[String],
    now: &str,
) -> sqlx::Result<(Vec<String>, bool)> {
    let mut current = group_types(conn, project).await?;
    let before = current.len();
    let changed = take(&mut current, types);
    for group_type in &current[before..] {
        sqlx::query(
            "insert into panel_group_slots (id, workspace_id, project_id, group_type, position, taken_at) \
             values ($1, $2, $3, $4, \
               (select coalesce(max(position), 0) + 1 from panel_group_slots where workspace_id = $2 and project_id = $3), \
               $5::timestamptz)",
        )
        .bind(generate_id("pngs"))
        .bind(project.workspace_id)
        .bind(project.project_id)
        .bind(group_type)
        .bind(now)
        .execute(&mut *conn)
        .await?;
    }
    Ok((current, changed))
}

/// `releaseGroupType`: frees the type's slot; true when it had one.
pub(crate) async fn release_group_type(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    group_type: &str,
) -> sqlx::Result<bool> {
    sqlx::query(
        "delete from panel_group_slots where workspace_id = $1 and project_id = $2 and group_type = $3",
    )
    .bind(project.workspace_id)
    .bind(project.project_id)
    .bind(group_type)
    .execute(conn)
    .await
    .map(|done| done.rows_affected() > 0)
}

async fn find_group(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    group_type: &str,
    group_key: &str,
) -> sqlx::Result<Option<GroupRow>> {
    sqlx::query_as(concat!(
        "select ",
        group_columns!(),
        " from panel_groups where workspace_id = $1 and project_id = $2 and group_type = $3 and group_key = $4"
    ))
    .bind(project.workspace_id)
    .bind(project.project_id)
    .bind(group_type)
    .bind(group_key)
    .fetch_optional(conn)
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

/// `applyGroupOps`: the operations' types take free slots, then each
/// operation of a type with a slot applies; one `groups_v1` row per changed
/// group. Also answers whether the project's types changed.
pub(crate) async fn apply_group_ops(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    ops: &[GroupOp],
    now: &str,
) -> sqlx::Result<(GroupOpsResult, Emitted, bool)> {
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
        if existing.is_some() && before == after {
            sqlx::query(
                "update panel_groups set last_seen = $5::timestamptz \
                 where workspace_id = $1 and project_id = $2 and group_type = $3 and group_key = $4",
            )
            .bind(project.workspace_id)
            .bind(project.project_id)
            .bind(group_type)
            .bind(group_key)
            .bind(now)
            .execute(&mut *conn)
            .await?;
            continue;
        }
        if existing.is_some() {
            sqlx::query(
                "update panel_groups set properties = $5::json, last_seen = $6::timestamptz \
                 where workspace_id = $1 and project_id = $2 and group_type = $3 and group_key = $4",
            )
            .bind(project.workspace_id)
            .bind(project.project_id)
            .bind(group_type)
            .bind(group_key)
            .bind(&after)
            .bind(now)
            .execute(&mut *conn)
            .await?;
        } else {
            sqlx::query(
                "insert into panel_groups (id, workspace_id, project_id, group_type, group_key, properties, first_seen, last_seen) \
                 values ($1, $2, $3, $4, $5, $6::json, $7::timestamptz, $7::timestamptz)",
            )
            .bind(generate_id("pngr"))
            .bind(project.workspace_id)
            .bind(project.project_id)
            .bind(group_type)
            .bind(group_key)
            .bind(&after)
            .bind(now)
            .execute(&mut *conn)
            .await?;
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
) -> sqlx::Result<Option<Group>> {
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
) -> sqlx::Result<GroupsPage> {
    let limit = page_limit(input.limit);
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
    let mut rows = page.bind(limit + 1).fetch_all(conn).await?;

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

/// `deleteGroup`: removes the profile and writes a `deleted` row to
/// `groups_v1`; false when there was none.
pub(crate) async fn delete_group(
    conn: &mut PgConnection,
    project: ProjectRef<'_>,
    group_type: &str,
    group_key: &str,
    now: &str,
) -> sqlx::Result<(bool, Emitted)> {
    if find_group(conn, project, group_type, group_key)
        .await?
        .is_none()
    {
        return Ok((false, Emitted::default()));
    }
    sqlx::query(
        "delete from panel_groups where workspace_id = $1 and project_id = $2 and group_type = $3 and group_key = $4",
    )
    .bind(project.workspace_id)
    .bind(project.project_id)
    .bind(group_type)
    .bind(group_key)
    .execute(&mut *conn)
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
