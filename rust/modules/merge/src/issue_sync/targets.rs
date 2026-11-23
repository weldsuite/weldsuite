//! What a sync call acts on (`services/issue-sync/targets.ts`): a tracked
//! repository with its live connection, and the link between an issue and
//! its provider issue.

use sea_orm::{
    ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect, SelectTwoRequired,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{merge_connections, merge_external_issues, merge_repositories};

use crate::db::{Row, json_row};

/// `SyncTarget`: a live repository on an active connection.
#[derive(Debug, Clone)]
pub(crate) struct SyncTarget {
    pub(crate) repository: Row,
    pub(crate) connection: Row,
}

/// `select to_jsonb(r), to_jsonb(c) from merge_repositories r inner join
/// merge_connections c on c.id = r.connection_id where r.deleted_at is null
/// and c.deleted_at is null`, for the caller's own conditions.
pub(crate) fn live_targets() -> SelectTwoRequired<merge_repositories::Entity, merge_connections::Entity>
{
    merge_repositories::Entity::find()
        .join(
            JoinType::InnerJoin,
            merge_repositories::Entity::belongs_to(merge_connections::Entity)
                .from(merge_repositories::Column::ConnectionId)
                .to(merge_connections::Column::Id)
                .into(),
        )
        .filter(merge_repositories::Column::DeletedAt.is_null())
        .filter(merge_connections::Column::DeletedAt.is_null())
        .select_two_required(merge_connections::Entity)
}

/// The first target `select` finds (`limit 1`).
pub(crate) async fn first_target(
    db: &PgPool,
    select: SelectTwoRequired<merge_repositories::Entity, merge_connections::Entity>,
) -> Result<Option<SyncTarget>, DbErr> {
    let Some((repository, connection)) = select.one(&orm(db)).await? else {
        return Ok(None);
    };
    Ok(Some(SyncTarget {
        repository: json_row(serde_json::to_value(repository))?,
        connection: json_row(serde_json::to_value(connection))?,
    }))
}

/// `loadTarget(db, repositoryId)`.
pub(crate) async fn load_target(
    db: &PgPool,
    repository_id: &str,
) -> Result<Option<SyncTarget>, DbErr> {
    first_target(
        db,
        live_targets()
            .filter(merge_repositories::Column::Id.eq(repository_id))
            .filter(merge_connections::Column::Status.eq("active")),
    )
    .await
}

/// `loadTargetByExternalId(db, provider, externalId)`.
pub(crate) async fn load_target_by_external_id(
    db: &PgPool,
    provider: &str,
    external_id: &str,
) -> Result<Option<SyncTarget>, DbErr> {
    first_target(
        db,
        live_targets()
            .filter(merge_repositories::Column::Provider.eq(provider))
            .filter(merge_repositories::Column::ExternalId.eq(external_id))
            .filter(merge_connections::Column::Status.eq("active")),
    )
    .await
}

fn link_row(link: Option<merge_external_issues::Model>) -> Result<Option<Row>, DbErr> {
    link.map(|link| json_row(serde_json::to_value(link)))
        .transpose()
}

/// `findLinkByIssue(db, issueId)`.
pub(crate) async fn find_link_by_issue(db: &PgPool, issue_id: &str) -> Result<Option<Row>, DbErr> {
    link_row(
        merge_external_issues::Entity::find()
            .filter(merge_external_issues::Column::IssueId.eq(issue_id))
            .one(&orm(db))
            .await?,
    )
}

/// `findLinkByNumber(db, repositoryId, number)`.
pub(crate) async fn find_link_by_number(
    db: &PgPool,
    repository_id: &str,
    number: i64,
) -> Result<Option<Row>, DbErr> {
    link_row(
        merge_external_issues::Entity::find()
            .filter(merge_external_issues::Column::RepositoryId.eq(repository_id))
            .filter(merge_external_issues::Column::Number.eq(number))
            .one(&orm(db))
            .await?,
    )
}
