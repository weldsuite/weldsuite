//! S8 of the ORM plan (`rust/docs/spikes.md`): the S3 rounds through SeaORM
//! instead of hand-written sqlx, on the same pool. The member and role reads
//! are entity queries, the note is an ORM upsert and read inside
//! `atomically_with` (through `OrmConn`), and the churn is a raw SeaORM
//! statement with one of `distinct` texts, so both statement caches turn over
//! as in S3.

use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, QueryFilter, Statement,
};
use sqlx::PgPool;
use weldsuite_db::{OrmConn, atomically_with, orm};

use crate::stats::Errors;

// The derive makes `pub` items in a private module.
#[allow(unreachable_pub)]
mod workspace_members {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "workspace_members")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub user_id: String,
        pub role: String,
        pub role_id: Option<String>,
        pub permissions: Option<Json>,
        pub permission_denies: Option<Json>,
        pub status: String,
        pub member_type: String,
        pub deleted_at: Option<TimeDateTimeWithTimeZone>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

// The derive makes `pub` items in a private module.
#[allow(unreachable_pub)]
mod roles {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "roles")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub name: String,
        pub is_system: bool,
        pub permissions: Option<Json>,
        pub deleted_at: Option<TimeDateTimeWithTimeZone>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

// The derive makes `pub` items in a private module.
#[allow(unreachable_pub)]
mod notes {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "notes")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: i64,
        pub client: i32,
        pub body: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

#[derive(Debug)]
enum Failure {
    Sql(sqlx::Error),
    Orm(sea_orm::DbErr),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sql(error) => error.fmt(f),
            Self::Orm(error) => error.fmt(f),
        }
    }
}

impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        Self::Sql(error)
    }
}

impl From<sea_orm::DbErr> for Failure {
    fn from(error: sea_orm::DbErr) -> Self {
        Self::Orm(error)
    }
}

/// One client: `iterations` rounds. Returns (right answers, wrong answers, errors).
pub(crate) async fn client_loop(
    pool: &PgPool,
    client: u32,
    iterations: u32,
    distinct: u32,
) -> (u64, u64, Errors) {
    let db = orm(pool);
    let mut ok = 0u64;
    let mut wrong = 0u64;
    let mut errors = Errors::default();
    for i in 0..iterations {
        let n = (client * 7 + i) % 100;
        let results = [
            member(&db, n).await,
            role(&db, n % 5).await,
            note(pool, client, i).await,
            churn(&db, i64::from(n), (client + i) % distinct.max(1)).await,
        ];
        for result in results {
            match result {
                Ok(true) => ok += 1,
                Ok(false) => wrong += 1,
                Err(error) => errors.add(&error.to_string()),
            }
        }
    }
    (ok, wrong, errors)
}

async fn member(db: &sea_orm::DatabaseConnection, n: u32) -> Result<bool, Failure> {
    let row = workspace_members::Entity::find()
        .filter(workspace_members::Column::UserId.eq(format!("user_{n}")))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .filter(workspace_members::Column::Status.eq("ACTIVE"))
        .one(db)
        .await?;
    Ok(row.is_some_and(|m| {
        m.id == format!("mem_{n}") && m.role_id == Some(format!("role_{}", n % 5))
    }))
}

async fn role(db: &sea_orm::DatabaseConnection, r: u32) -> Result<bool, Failure> {
    let row = roles::Entity::find_by_id(format!("role_{r}"))
        .filter(roles::Column::DeletedAt.is_null())
        .one(db)
        .await?;
    Ok(row.is_some_and(|role| role.name == format!("Role {r}") && !role.is_system))
}

/// An ORM upsert and read inside a transaction `atomically_with` opened.
async fn note(pool: &PgPool, client: u32, i: u32) -> Result<bool, Failure> {
    let id = i64::from(client) * 1_000_000 + i64::from(i);
    let body = format!("note {client}/{i}");
    let expected = body.clone();
    let read = atomically_with(pool, |tx| {
        Box::pin(async move {
            let db = OrmConn::new(tx);
            notes::Entity::insert(notes::ActiveModel {
                id: Set(id),
                client: Set(i32::try_from(client).unwrap_or(i32::MAX)),
                body: Set(body),
            })
            .on_conflict(
                OnConflict::column(notes::Column::Id)
                    .update_column(notes::Column::Body)
                    .to_owned(),
            )
            .exec_without_returning(&db)
            .await?;
            let read = notes::Entity::find_by_id(id).one(&db).await?;
            Ok::<_, Failure>(read.map(|note| note.body))
        })
    })
    .await?;
    Ok(read.as_deref() == Some(expected.as_str()))
}

/// One of `distinct` statement texts through SeaORM's raw statement path.
async fn churn(db: &sea_orm::DatabaseConnection, n: i64, k: u32) -> Result<bool, Failure> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!("select $1::int8 + {k} as value"),
            [n.into()],
        ))
        .await?;
    let value: Option<i64> = match row {
        Some(row) => Some(row.try_get("", "value")?),
        None => None,
    };
    Ok(value == Some(n + i64::from(k)))
}
