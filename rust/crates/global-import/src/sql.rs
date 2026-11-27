//! The SQL the move runs that no entity can express: catalog reads, the
//! copy of a whole tenant database, and rows moved between two master
//! databases at different schema versions. Every statement is built from the
//! live catalog of the two databases, so each function here carries its own
//! `clippy::disallowed_methods` allowance (ADR DATA-019: SQL by nature).

use std::collections::BTreeMap;

use futures_util::StreamExt as _;
use serde_json::Value;
use sqlx::{AssertSqlSafe, PgConnection, Row as _};

/// `"name"`, with any quote inside doubled.
pub(crate) fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// `public."name"`.
pub(crate) fn qualified(table: &str) -> String {
    format!("public.{}", ident(table))
}

/// `"a", "b", "c"`.
pub(crate) fn column_list(columns: &[String]) -> String {
    columns
        .iter()
        .map(|column| ident(column))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The tables of the `public` schema with the columns a row can be written
/// to (not generated, not dropped), in column order. Partitions and tables an
/// extension owns are left out: a partitioned table is read and written
/// through its parent.
#[allow(
    clippy::disallowed_methods,
    reason = "a catalog read: which tables and columns this database has"
)]
pub(crate) async fn tables(
    conn: &mut PgConnection,
) -> Result<BTreeMap<String, Vec<String>>, sqlx::Error> {
    let rows: Vec<(String, Vec<String>)> = sqlx::query_as(
        "select c.relname::text,
                coalesce(array_agg(a.attname::text order by a.attnum)
                           filter (where a.attname is not null), '{}')
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
           left join pg_attribute a
             on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
          where c.relkind in ('r', 'p')
            and not c.relispartition
            and not exists (
                  select 1 from pg_depend d
                   where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
          group by c.relname
          order by c.relname",
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().collect())
}

/// One foreign key: its table, name and definition (`pg_get_constraintdef`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ForeignKey {
    pub(crate) table: String,
    pub(crate) name: String,
    pub(crate) definition: String,
}

/// The foreign keys of the `public` schema, the ones declared on a table
/// (a partition's copies follow their parent's).
#[allow(
    clippy::disallowed_methods,
    reason = "a catalog read: the foreign keys to lift while the rows load"
)]
pub(crate) async fn foreign_keys(conn: &mut PgConnection) -> Result<Vec<ForeignKey>, sqlx::Error> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "select c.relname::text, con.conname::text, pg_get_constraintdef(con.oid)
           from pg_constraint con
           join pg_class c on c.oid = con.conrelid
           join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
          where con.contype = 'f' and con.conparentid = 0
          order by 1, 2",
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(table, name, definition)| ForeignKey {
            table,
            name,
            definition,
        })
        .collect())
}

/// Tables (partitions included) of the `public` schema with triggers of
/// their own: the ones `DISABLE TRIGGER USER` has to reach.
#[allow(
    clippy::disallowed_methods,
    reason = "a catalog read: the tables whose triggers stay quiet while the rows load"
)]
pub(crate) async fn tables_with_triggers(
    conn: &mut PgConnection,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select distinct c.relname::text
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
          where not t.tgisinternal
          order by 1",
    )
    .fetch_all(&mut *conn)
    .await
}

/// The sequences of the `public` schema.
#[allow(
    clippy::disallowed_methods,
    reason = "a catalog read: the sequences to carry over"
)]
pub(crate) async fn sequences(conn: &mut PgConnection) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select c.relname::text
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
          where c.relkind = 'S'
          order by 1",
    )
    .fetch_all(&mut *conn)
    .await
}

/// A sequence's position: `last_value` and `is_called`.
#[allow(
    clippy::disallowed_methods,
    reason = "a sequence is read as a relation; its name comes from the catalog"
)]
pub(crate) async fn sequence_state(
    conn: &mut PgConnection,
    sequence: &str,
) -> Result<(i64, bool), sqlx::Error> {
    let row = sqlx::query(AssertSqlSafe(format!(
        "select last_value, is_called from {}",
        qualified(sequence)
    )))
    .fetch_one(&mut *conn)
    .await?;
    Ok((row.try_get(0)?, row.try_get(1)?))
}

/// `setval` to the position read from the other database.
#[allow(
    clippy::disallowed_methods,
    reason = "setval on a sequence named by the catalog"
)]
pub(crate) async fn set_sequence(
    conn: &mut PgConnection,
    sequence: &str,
    (last_value, is_called): (i64, bool),
) -> Result<(), sqlx::Error> {
    sqlx::query("select setval($1::regclass, $2, $3)")
        .bind(qualified(sequence))
        .bind(last_value)
        .bind(is_called)
        .execute(&mut *conn)
        .await
        .map(drop)
}

/// The materialized views of the `public` schema.
#[allow(
    clippy::disallowed_methods,
    reason = "a catalog read: the materialized views to refresh after the copy"
)]
pub(crate) async fn materialized_views(
    conn: &mut PgConnection,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select c.relname::text
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
          where c.relkind = 'm'
          order by 1",
    )
    .fetch_all(&mut *conn)
    .await
}

/// `select count(*)` of a table, read through its parent when partitioned.
#[allow(
    clippy::disallowed_methods,
    reason = "a row count of a table named by the catalog"
)]
pub(crate) async fn count_rows(conn: &mut PgConnection, table: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(AssertSqlSafe(format!(
        "select count(*) from {}",
        qualified(table)
    )))
    .fetch_one(&mut *conn)
    .await
}

/// One statement without parameters or rows (DDL, `SET`, `TRUNCATE`).
pub(crate) async fn execute(conn: &mut PgConnection, statement: &str) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(AssertSqlSafe(statement))
        .execute(&mut *conn)
        .await
        .map(drop)
}

/// What [`copy_table`] moved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Copied {
    /// Rows the target took (`COPY`'s count).
    pub(crate) rows: u64,
    /// Bytes streamed.
    pub(crate) bytes: u64,
}

/// Stream every row of `table` (the listed `columns`) from `source` into
/// the same table of `target` with `COPY`, in the text format, which both
/// servers parse alike whatever their versions. A failure mid-stream aborts
/// the target's `COPY`; the caller's transaction is then dead anyway.
pub(crate) async fn copy_table(
    source: &mut PgConnection,
    target: &mut PgConnection,
    table: &str,
    columns: &[String],
) -> Result<Copied, sqlx::Error> {
    let list = column_list(columns);
    let name = qualified(table);
    let mut sink = target
        .copy_in_raw(&format!("COPY {name} ({list}) FROM STDIN"))
        .await?;
    let mut stream = match source
        .copy_out_raw(&format!("COPY (SELECT {list} FROM {name}) TO STDOUT"))
        .await
    {
        Ok(stream) => stream,
        Err(error) => {
            let _ = sink.abort("the source could not be read").await;
            return Err(error);
        }
    };
    let mut bytes = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                drop(stream);
                let _ = sink.abort("the source failed mid-copy").await;
                return Err(error);
            }
        };
        bytes += chunk.len() as u64;
        if let Err(error) = sink.send(chunk).await {
            drop(stream);
            return Err(error);
        }
    }
    drop(stream);
    let rows = sink.finish().await?;
    Ok(Copied { rows, bytes })
}

/// The rows of `table` that `filter` selects (`<column> ... $1`, bound to
/// `values`), the `columns` only, as JSON objects (`row_to_json`).
#[allow(
    clippy::disallowed_methods,
    reason = "rows of a master table named by the move's table list, read from a schema older than the entities"
)]
pub(crate) async fn read_rows(
    conn: &mut PgConnection,
    table: &str,
    columns: &[String],
    filter: &str,
    values: &[String],
) -> Result<Vec<Value>, sqlx::Error> {
    let statement = format!(
        "select coalesce(json_agg(row_to_json(x)), '[]'::json)
           from (select {} from {} where ({filter})) x",
        column_list(columns),
        qualified(table),
    );
    let rows: sqlx::types::Json<Vec<Value>> = sqlx::query_scalar(AssertSqlSafe(statement))
        .bind(values)
        .fetch_one(&mut *conn)
        .await?;
    Ok(rows.0)
}

/// How [`write_rows`] treats a row whose key is taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OnConflict {
    /// Refuse: the statement fails.
    Fail,
    /// Keep the row there (`on conflict (key) do nothing`).
    Keep(&'static str),
    /// Update these columns (`on conflict (key) do update`).
    Update(&'static str, Vec<String>),
}

/// Insert `rows` (JSON objects) into `table`, the `columns` only, typed by
/// the target's own row type (`json_populate_recordset`), so every column
/// converts as Postgres converts it, whatever the source's version wrote.
#[allow(
    clippy::disallowed_methods,
    reason = "rows into a master table named by the move's table list, typed by the target's catalog"
)]
pub(crate) async fn write_rows(
    conn: &mut PgConnection,
    table: &str,
    columns: &[String],
    rows: &[Value],
    on_conflict: &OnConflict,
) -> Result<u64, sqlx::Error> {
    const BATCH: usize = 500;
    if rows.is_empty() || columns.is_empty() {
        return Ok(0);
    }
    let list = column_list(columns);
    let name = qualified(table);
    let conflict = match on_conflict {
        OnConflict::Fail => String::new(),
        OnConflict::Keep(key) => format!(" on conflict ({}) do nothing", ident(key)),
        OnConflict::Update(key, update) if update.is_empty() => {
            format!(" on conflict ({}) do nothing", ident(key))
        }
        OnConflict::Update(key, update) => format!(
            " on conflict ({}) do update set {}",
            ident(key),
            update
                .iter()
                .map(|column| format!("{0} = excluded.{0}", ident(column)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    };
    let statement = format!(
        "insert into {name} ({list}) select {list} from json_populate_recordset(null::{name}, $1::json){conflict}"
    );
    let mut written = 0;
    for batch in rows.chunks(BATCH) {
        written += sqlx::query(AssertSqlSafe(statement.as_str()))
            .bind(sqlx::types::Json(batch))
            .execute(&mut *conn)
            .await?
            .rows_affected();
    }
    Ok(written)
}

/// Delete the rows of `table` that `filter` selects, bound to `values`.
#[allow(
    clippy::disallowed_methods,
    reason = "rows of a master table named by the move's table list"
)]
pub(crate) async fn delete_rows(
    conn: &mut PgConnection,
    table: &str,
    filter: &str,
    values: &[String],
) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(AssertSqlSafe(format!(
        "delete from {} where ({filter})",
        qualified(table)
    )))
    .bind(values)
    .execute(&mut *conn)
    .await?
    .rows_affected())
}

/// `select count(*) from table where filter`, bound to `values`.
#[allow(
    clippy::disallowed_methods,
    reason = "a row count of a master table named by the move's table list"
)]
pub(crate) async fn count_matching(
    conn: &mut PgConnection,
    table: &str,
    filter: &str,
    values: &[String],
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(AssertSqlSafe(format!(
        "select count(*) from {} where ({filter})",
        qualified(table)
    )))
    .bind(values)
    .fetch_one(&mut *conn)
    .await
}

/// Distinct non-null values of `column` among the rows `filter` selects.
#[allow(
    clippy::disallowed_methods,
    reason = "the values one master table refers to, for the next table's filter"
)]
pub(crate) async fn distinct_values(
    conn: &mut PgConnection,
    table: &str,
    column: &str,
    filter: &str,
    values: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(AssertSqlSafe(format!(
        "select distinct {col}::text from {} where ({filter}) and {col} is not null order by 1",
        qualified(table),
        col = ident(column),
    )))
    .bind(values)
    .fetch_all(&mut *conn)
    .await
}

/// Where a tenant keeps its connections to other services: the table, the
/// provider and status expressions, and which rows count (the Global
/// inventory's `INTEGRATION_SOURCES`, with the phone numbers).
const INTEGRATION_SOURCES: &[(&str, &str, &str, &str)] = &[
    (
        "integration_connections",
        "provider",
        "status",
        "deleted_at is null",
    ),
    (
        "connector_connections",
        "provider",
        "status",
        "deleted_at is null",
    ),
    ("product_connections", "platform", "sync_status", "true"),
    (
        "workflow_integrations",
        "coalesce(oauth_provider, type)",
        "status",
        "deleted_at is null",
    ),
    (
        "bank_connections",
        "provider",
        "status",
        "deleted_at is null",
    ),
    ("ad_platform_connections", "platform", "status", "true"),
    ("github_connections", "'github'", "status", "true"),
    ("merge_connections", "provider", "status", "true"),
    (
        "helpdesk_channel_integrations",
        "provider",
        "status",
        "true",
    ),
    ("social_accounts", "platform", "status", "true"),
    (
        "voip_phone_numbers",
        "provider",
        "'active'",
        "deleted_at is null",
    ),
];

/// The services a tenant has connected: `(provider, status)` pairs from
/// every connection table it has. A table that can't be read is reported in
/// the second list, not fatal: its services can still be switched on by
/// hand (`weldsuite admin outside-eu on`).
#[allow(
    clippy::disallowed_methods,
    reason = "the Global inventory's connection queries, over tables the tenant may not have"
)]
pub(crate) async fn connected_providers(
    conn: &mut PgConnection,
) -> Result<(Vec<(String, String)>, Vec<String>), sqlx::Error> {
    let present = tables(conn).await?;
    let mut found = Vec::new();
    let mut problems = Vec::new();
    for (table, provider, status, filter) in INTEGRATION_SOURCES {
        if !present.contains_key(*table) {
            continue;
        }
        let statement = format!(
            "select distinct ({provider})::text, coalesce(({status})::text, '') from {} where {filter}",
            qualified(table)
        );
        match sqlx::query_as::<_, (Option<String>, String)>(AssertSqlSafe(statement))
            .fetch_all(&mut *conn)
            .await
        {
            Ok(rows) => found.extend(
                rows.into_iter()
                    .filter_map(|(provider, status)| Some((provider?, status))),
            ),
            Err(error) => problems.push(format!("{table}: {error}")),
        }
    }
    Ok((found, problems))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_identifiers() {
        assert_eq!(ident("workspaces"), "\"workspaces\"");
        assert_eq!(ident("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(qualified("users"), "public.\"users\"");
        assert_eq!(
            column_list(&["id".to_owned(), "name".to_owned()]),
            "\"id\", \"name\""
        );
    }
}
