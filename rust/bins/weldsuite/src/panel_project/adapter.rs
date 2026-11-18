//! [`TenantProjectState`]: the production [`PanelProjectState`] of the
//! serve role (panel-api's side): the tenant tables, the rows on NATS and the
//! live view in Valkey. It opens the workspace's tenant database, so the
//! collector never uses it (that is [`super::CollectorProjectState`]).
//!
//! An erasure's Iceberg rewrite is queued by the people route
//! (`weldsuite_panel::ErasureQueue`, the master `panel_erasure_ledger`), not
//! here; `weldsuite cron panel-maintenance` releases the ids it rewrote
//! through [`PanelProjectState::clear_erased`], opening only the tenant
//! databases of the workspaces whose erasures it applied.

use std::collections::HashSet;
use std::sync::Arc;

use sqlx::pool::PoolConnection;
use sqlx::{PgPool, Postgres, Transaction};
use weldsuite_panel::project_state::{
    DeleteGroupInput, EraseInput, Erasure, Group, GroupOpsInput, GroupOpsResult, GroupsPage,
    Identified, IdentifyInput, ListGroupsInput, ListPeopleInput, Live, LiveTouch, PeopleOpsInput,
    PeoplePage, Person,
};
use weldsuite_panel::{PanelProjectState, ProjectRef};
use weldsuite_ports::{BoxFuture, PortError};

use super::rows::RowSink;
use super::rules::{LIVE_SESSIONS_RETURNED, iso};
use super::tenant;
use super::valkey::PanelValkey;
use super::{Clock, TenantPools};

pub(crate) fn db(error: sqlx::Error) -> PortError {
    PortError::backend(error)
}

/// The project state in the workspace's tenant database.
pub(crate) struct TenantProjectState {
    pub(crate) pools: Arc<dyn TenantPools>,
    pub(crate) rows: RowSink,
    /// The live view and the collector's caches; without Valkey the live
    /// view is empty and the caches are not kept.
    pub(crate) valkey: Option<PanelValkey>,
    pub(crate) clock: Clock,
}

impl TenantProjectState {
    async fn pool(&self, project: ProjectRef<'_>) -> Result<PgPool, PortError> {
        self.pools.pool(project.workspace_id).await?.ok_or_else(|| {
            PortError::backend(format!("workspace {} not found", project.workspace_id))
        })
    }

    fn now(&self) -> String {
        iso((self.clock)())
    }

    /// A pooled connection to the workspace's database, for a read.
    async fn conn(&self, project: ProjectRef<'_>) -> Result<PoolConnection<Postgres>, PortError> {
        self.pool(project).await?.acquire().await.map_err(db)
    }

    /// A transaction holding the project's lock, for a change.
    async fn begin(
        &self,
        project: ProjectRef<'_>,
    ) -> Result<Transaction<'static, Postgres>, PortError> {
        let mut tx = self.pool(project).await?.begin().await.map_err(db)?;
        tenant::lock(&mut tx, project).await.map_err(db)?;
        Ok(tx)
    }

    /// The collector's copy of the erased ids, from the tenant's list.
    async fn refresh_erased(&self, project: ProjectRef<'_>) {
        let Some(valkey) = &self.valkey else {
            return;
        };
        let refreshed = async {
            let mut conn = self.conn(project).await?;
            let ids = tenant::erased_ids(&mut conn, project).await.map_err(db)?;
            valkey.set_erased(project.project_id, &ids).await
        }
        .await;
        if let Err(error) = refreshed {
            tracing::warn!(project = project.project_id, %error, "panel: the erased ids cache was not refreshed");
        }
    }

    /// The collector's copy of the group types.
    async fn refresh_group_types(&self, project: ProjectRef<'_>, types: &[String]) {
        let Some(valkey) = &self.valkey else {
            return;
        };
        if let Err(error) = valkey.set_group_types(project.project_id, types).await {
            tracing::warn!(project = project.project_id, %error, "panel: the group types cache was not refreshed");
        }
    }
}

impl PanelProjectState for TenantProjectState {
    fn identify<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a IdentifyInput,
    ) -> BoxFuture<'a, Result<Identified, PortError>> {
        Box::pin(async move {
            let now = self.now();
            let mut tx = self.begin(project).await?;
            let (linked, rows) = tenant::identify(
                &mut tx,
                project,
                &input.anon_id,
                &input.user_id,
                &input.ts,
                &now,
            )
            .await
            .map_err(db)?;
            tx.commit().await.map_err(db)?;
            self.rows.emit(project.workspace_id, &rows).await;
            Ok(Identified { linked })
        })
    }

    fn apply_people_ops<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a PeopleOpsInput,
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            let now = self.now();
            let mut tx = self.begin(project).await?;
            let rows = tenant::apply_people_ops(&mut tx, project, &input.ops, &now)
                .await
                .map_err(db)?;
            tx.commit().await.map_err(db)?;
            self.rows.emit(project.workspace_id, &rows).await;
            Ok(())
        })
    }

    fn touch_live<'a>(
        &'a self,
        project: ProjectRef<'a>,
        touches: &'a [LiveTouch],
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            match &self.valkey {
                Some(valkey) => valkey
                    .touch(project.project_id, touches, (self.clock)())
                    .await
                    .map(|_| ()),
                None => Ok(()),
            }
        })
    }

    fn get_person<'a>(
        &'a self,
        project: ProjectRef<'a>,
        user_id_or_anon_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<Person>, PortError>> {
        Box::pin(async move {
            let mut conn = self.conn(project).await?;
            tenant::get_person(&mut conn, project, user_id_or_anon_id)
                .await
                .map_err(db)
        })
    }

    fn list_people<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a ListPeopleInput,
    ) -> BoxFuture<'a, Result<PeoplePage, PortError>> {
        Box::pin(async move {
            let mut conn = self.conn(project).await?;
            tenant::list_people(&mut conn, project, input)
                .await
                .map_err(db)
        })
    }

    fn find_by_email<'a>(
        &'a self,
        project: ProjectRef<'a>,
        email: &'a str,
    ) -> BoxFuture<'a, Result<Vec<Person>, PortError>> {
        Box::pin(async move {
            let mut conn = self.conn(project).await?;
            tenant::find_by_email(&mut conn, project, email)
                .await
                .map_err(db)
        })
    }

    fn live<'a>(&'a self, project: ProjectRef<'a>) -> BoxFuture<'a, Result<Live, PortError>> {
        Box::pin(async move {
            let Some(valkey) = &self.valkey else {
                return Ok(Live {
                    visitors: 0,
                    sessions: Vec::new(),
                });
            };
            let mut sessions = valkey.sessions(project.project_id, (self.clock)()).await?;
            if !sessions.is_empty() {
                // An erasure drops its sessions at once; a touch that came
                // while the collector couldn't know the id was erased is
                // left out here.
                let mut conn = self.conn(project).await?;
                let erased: HashSet<String> = tenant::erased_ids(&mut conn, project)
                    .await
                    .map_err(db)?
                    .into_iter()
                    .collect();
                sessions.retain(|session| {
                    !erased.contains(&session.touch.distinct_id)
                        && !erased.contains(&session.touch.session_id)
                });
            }
            let visitors = sessions
                .iter()
                .map(|session| session.touch.distinct_id.as_str())
                .collect::<HashSet<_>>()
                .len();
            sessions.truncate(LIVE_SESSIONS_RETURNED);
            Ok(Live {
                visitors: u64::try_from(visitors).unwrap_or(u64::MAX),
                sessions,
            })
        })
    }

    fn erase<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a EraseInput,
    ) -> BoxFuture<'a, Result<Erasure, PortError>> {
        Box::pin(async move {
            let now = self.now();
            let mut tx = self.begin(project).await?;
            let (erasure, rows) = tenant::erase(&mut tx, project, &input.user_id_or_anon_id, &now)
                .await
                .map_err(db)?;
            tx.commit().await.map_err(db)?;
            self.rows.emit(project.workspace_id, &rows).await;
            if let Some(valkey) = &self.valkey
                && let Err(error) = valkey.forget(project.project_id, &erasure.erased_ids).await
            {
                tracing::warn!(project = project.project_id, %error, "panel: an erasure's live sessions were not dropped");
            }
            self.refresh_erased(project).await;
            Ok(erasure)
        })
    }

    fn erased_ids<'a>(
        &'a self,
        project: ProjectRef<'a>,
    ) -> BoxFuture<'a, Result<Vec<String>, PortError>> {
        Box::pin(async move {
            let mut conn = self.conn(project).await?;
            tenant::erased_ids(&mut conn, project).await.map_err(db)
        })
    }

    fn has_identified_users<'a>(
        &'a self,
        project: ProjectRef<'a>,
    ) -> BoxFuture<'a, Result<bool, PortError>> {
        Box::pin(async move {
            let mut conn = self.conn(project).await?;
            tenant::has_identified_users(&mut conn, project)
                .await
                .map_err(db)
        })
    }

    fn clear_erased<'a>(
        &'a self,
        project: ProjectRef<'a>,
        ids: &'a [String],
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            let mut tx = self.begin(project).await?;
            tenant::clear_erased(&mut tx, project, ids)
                .await
                .map_err(db)?;
            tx.commit().await.map_err(db)?;
            self.refresh_erased(project).await;
            Ok(())
        })
    }

    fn apply_group_ops<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a GroupOpsInput,
    ) -> BoxFuture<'a, Result<GroupOpsResult, PortError>> {
        Box::pin(async move {
            let now = self.now();
            let mut tx = self.begin(project).await?;
            let (result, rows, changed) =
                tenant::apply_group_ops(&mut tx, project, &input.ops, &now)
                    .await
                    .map_err(db)?;
            tx.commit().await.map_err(db)?;
            self.rows.emit(project.workspace_id, &rows).await;
            if changed {
                self.refresh_group_types(project, &result.types).await;
            }
            Ok(result)
        })
    }

    fn ensure_group_types<'a>(
        &'a self,
        project: ProjectRef<'a>,
        types: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<String>, PortError>> {
        Box::pin(async move {
            let now = self.now();
            let mut tx = self.begin(project).await?;
            let (types, changed) = tenant::take_group_types(&mut tx, project, types, &now)
                .await
                .map_err(db)?;
            tx.commit().await.map_err(db)?;
            if changed {
                self.refresh_group_types(project, &types).await;
            }
            Ok(types)
        })
    }

    fn group_types<'a>(
        &'a self,
        project: ProjectRef<'a>,
    ) -> BoxFuture<'a, Result<Vec<String>, PortError>> {
        Box::pin(async move {
            let mut conn = self.conn(project).await?;
            tenant::group_types(&mut conn, project).await.map_err(db)
        })
    }

    fn release_group_type<'a>(
        &'a self,
        project: ProjectRef<'a>,
        group_type: &'a str,
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            let mut tx = self.begin(project).await?;
            let released = tenant::release_group_type(&mut tx, project, group_type)
                .await
                .map_err(db)?;
            let types = tenant::group_types(&mut tx, project).await.map_err(db)?;
            tx.commit().await.map_err(db)?;
            if released {
                self.refresh_group_types(project, &types).await;
            }
            Ok(())
        })
    }

    fn get_group<'a>(
        &'a self,
        project: ProjectRef<'a>,
        group_type: &'a str,
        group_key: &'a str,
    ) -> BoxFuture<'a, Result<Option<Group>, PortError>> {
        Box::pin(async move {
            let mut conn = self.conn(project).await?;
            tenant::get_group(&mut conn, project, group_type, group_key)
                .await
                .map_err(db)
        })
    }

    fn list_groups<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a ListGroupsInput,
    ) -> BoxFuture<'a, Result<GroupsPage, PortError>> {
        Box::pin(async move {
            let mut conn = self.conn(project).await?;
            tenant::list_groups(&mut conn, project, input)
                .await
                .map_err(db)
        })
    }

    fn delete_group<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a DeleteGroupInput,
    ) -> BoxFuture<'a, Result<bool, PortError>> {
        Box::pin(async move {
            let now = self.now();
            let mut tx = self.begin(project).await?;
            let (deleted, rows) =
                tenant::delete_group(&mut tx, project, &input.group_type, &input.group_key, &now)
                    .await
                    .map_err(db)?;
            tx.commit().await.map_err(db)?;
            self.rows.emit(project.workspace_id, &rows).await;
            Ok(deleted)
        })
    }
}
