//! [`CollectorProjectState`]: the [`PanelProjectState`] the collector calls
//! where panel-ingest calls the `PanelProject` object. It never opens a
//! tenant database (ADR DATA-008):
//!
//! - `identify`, `applyPeopleOps`, `applyGroupOps` and `ensureGroupTypes`
//!   are published to `panel.ops.v1.<workspace>` (`PANEL_STATE`), and
//!   `weldsuite consume`'s `panel-state` applies them to the tenant tables
//!   with the object's rules, in stream order, writing the `identities_v1`,
//!   `people_v1` and `groups_v1` rows;
//! - `touchLive` goes straight to the live view in Valkey (touches of
//!   erased ids are refused there while the erased ids are known);
//! - the group types the collector filters `$group_<type>` properties by
//!   come from the Valkey list, where a type takes a free slot at once (the
//!   object's rule); the applier takes the same slot in the tenant tables.
//!
//! What it can't answer at once:
//!
//! - `identify`'s `linked` is `true` once the link is queued (false only
//!   for an empty id): whether the anonymous id was linked to someone else
//!   first, or erased, is decided by the applier. The collector ignores the
//!   answer, as panel-ingest does.
//! - While a project's group types are not in Valkey (a new project, or
//!   the cache was lost), `applyGroupOps`, `ensureGroupTypes` and
//!   `groupTypes` fail after queueing what they were given: the collector
//!   then keeps `$group_` properties as sent, as panel-ingest does when the
//!   object call fails, and the applier fills the list within moments.
//! - `applyGroupOps`' `applied` counts the operations whose type has a slot
//!   and whose key fits; whether a profile would pass its size limit only
//!   the applier knows.
//!
//! panel-api's methods (people, groups, live, erasure) answer an error
//! here: they are [`super::TenantProjectState`]'s. Conformance builds use
//! the test's `PANEL_PROJECT` instead, so there it is never built.

#![cfg_attr(feature = "conformance", allow(dead_code))]

use std::sync::Arc;

use weldsuite_panel::project_state::{
    DeleteGroupInput, EraseInput, Erasure, Group, GroupOpsInput, GroupOpsResult, GroupsPage,
    Identified, IdentifyInput, ListGroupsInput, ListPeopleInput, Live, LiveTouch, PeopleOpsInput,
    PeoplePage, Person,
};
use weldsuite_panel::{PanelProjectState, ProjectRef};
use weldsuite_ports::{BoxFuture, BusMessage, DynEventBus, PortError};

use super::Clock;
use super::ops::{OpMessage, ProjectOp};
use super::rules::{group_op_fits, iso, op_group_types, valid_group_type};
use super::valkey::PanelValkey;

/// The collector's project state: operations on NATS, the live view and the
/// lists it reads in Valkey.
pub(crate) struct CollectorProjectState {
    pub(crate) bus: Arc<dyn DynEventBus>,
    pub(crate) valkey: PanelValkey,
    pub(crate) clock: Clock,
}

fn panel_api_only(method: &str) -> PortError {
    PortError::backend(format!(
        "PanelProject.{method} is panel-api's: the collector never opens a tenant database"
    ))
}

fn not_known_yet(project: ProjectRef<'_>) -> PortError {
    PortError::backend(format!(
        "the group types of project {} are not in the cache yet; the operations are queued",
        project.project_id
    ))
}

impl CollectorProjectState {
    /// Queues one call for the applier.
    async fn publish(&self, project: ProjectRef<'_>, op: ProjectOp) -> Result<(), PortError> {
        let message = OpMessage {
            workspace_id: project.workspace_id.to_owned(),
            project_id: project.project_id.to_owned(),
            at: iso((self.clock)()),
            op,
        };
        let message = BusMessage::json(
            message.subject(),
            weldsuite_kit::generate_id("pnop"),
            &message,
        )?;
        self.bus.publish_boxed(message).await
    }

    /// Asks the applier to fill the project's lists from the tenant tables,
    /// at most once per project every half minute. A failure is logged: the
    /// next call asks again.
    async fn warm(&self, project: ProjectRef<'_>) {
        let asked = async {
            if self.valkey.claim_warming(project.project_id).await? {
                self.publish(project, ProjectOp::Warm).await?;
            }
            Ok::<(), PortError>(())
        }
        .await;
        if let Err(error) = asked {
            tracing::warn!(project = project.project_id, %error, "panel: the project state warm-up was not queued");
        }
    }

    /// The valid types among `types`, in order.
    fn valid(types: impl IntoIterator<Item = String>) -> Vec<String> {
        types
            .into_iter()
            .filter(|group_type| valid_group_type(group_type))
            .collect()
    }
}

impl PanelProjectState for CollectorProjectState {
    fn identify<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a IdentifyInput,
    ) -> BoxFuture<'a, Result<Identified, PortError>> {
        Box::pin(async move {
            if input.anon_id.is_empty() || input.user_id.is_empty() {
                return Ok(Identified { linked: false });
            }
            self.publish(
                project,
                ProjectOp::Identify {
                    anon_id: input.anon_id.clone(),
                    user_id: input.user_id.clone(),
                    ts: input.ts.clone(),
                },
            )
            .await?;
            Ok(Identified { linked: true })
        })
    }

    fn apply_people_ops<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a PeopleOpsInput,
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            if input.ops.is_empty() {
                return Ok(());
            }
            self.publish(
                project,
                ProjectOp::PeopleOps {
                    ops: input.ops.clone(),
                },
            )
            .await
        })
    }

    fn touch_live<'a>(
        &'a self,
        project: ProjectRef<'a>,
        touches: &'a [LiveTouch],
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            let known = self
                .valkey
                .touch(project.project_id, touches, (self.clock)())
                .await?;
            if !known && !touches.is_empty() {
                self.warm(project).await;
            }
            Ok(())
        })
    }

    fn apply_group_ops<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a GroupOpsInput,
    ) -> BoxFuture<'a, Result<GroupOpsResult, PortError>> {
        Box::pin(async move {
            let wanted = Self::valid(op_group_types(&input.ops));
            let taken = self
                .valkey
                .take_group_types(project.project_id, &wanted)
                .await?;
            if !input.ops.is_empty() {
                self.publish(
                    project,
                    ProjectOp::GroupOps {
                        ops: input.ops.clone(),
                    },
                )
                .await?;
            }
            let Some((types, _)) = taken else {
                if input.ops.is_empty() {
                    self.warm(project).await;
                }
                return Err(not_known_yet(project));
            };
            let applied = input
                .ops
                .iter()
                .filter(|op| group_op_fits(op, &types))
                .count();
            let total = input.ops.len();
            Ok(GroupOpsResult {
                applied: u64::try_from(applied).unwrap_or(u64::MAX),
                dropped: u64::try_from(total - applied).unwrap_or(u64::MAX),
                types,
            })
        })
    }

    fn ensure_group_types<'a>(
        &'a self,
        project: ProjectRef<'a>,
        types: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<String>, PortError>> {
        Box::pin(async move {
            let wanted = Self::valid(types.iter().cloned());
            let taken = self
                .valkey
                .take_group_types(project.project_id, &wanted)
                .await?;
            if let Some((types, changed)) = taken {
                if changed {
                    self.publish(project, ProjectOp::EnsureGroupTypes { types: wanted })
                        .await?;
                }
                return Ok(types);
            }
            if wanted.is_empty() {
                self.warm(project).await;
            } else {
                self.publish(project, ProjectOp::EnsureGroupTypes { types: wanted })
                    .await?;
            }
            Err(not_known_yet(project))
        })
    }

    fn group_types<'a>(
        &'a self,
        project: ProjectRef<'a>,
    ) -> BoxFuture<'a, Result<Vec<String>, PortError>> {
        Box::pin(async move {
            if let Some(types) = self.valkey.group_types(project.project_id).await? {
                return Ok(types);
            }
            self.warm(project).await;
            Err(not_known_yet(project))
        })
    }

    fn get_person<'a>(
        &'a self,
        _project: ProjectRef<'a>,
        _user_id_or_anon_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<Person>, PortError>> {
        Box::pin(std::future::ready(Err(panel_api_only("getPerson"))))
    }

    fn list_people<'a>(
        &'a self,
        _project: ProjectRef<'a>,
        _input: &'a ListPeopleInput,
    ) -> BoxFuture<'a, Result<PeoplePage, PortError>> {
        Box::pin(std::future::ready(Err(panel_api_only("listPeople"))))
    }

    fn find_by_email<'a>(
        &'a self,
        _project: ProjectRef<'a>,
        _email: &'a str,
    ) -> BoxFuture<'a, Result<Vec<Person>, PortError>> {
        Box::pin(std::future::ready(Err(panel_api_only("findByEmail"))))
    }

    fn live<'a>(&'a self, _project: ProjectRef<'a>) -> BoxFuture<'a, Result<Live, PortError>> {
        Box::pin(std::future::ready(Err(panel_api_only("live"))))
    }

    fn erase<'a>(
        &'a self,
        _project: ProjectRef<'a>,
        _input: &'a EraseInput,
    ) -> BoxFuture<'a, Result<Erasure, PortError>> {
        Box::pin(std::future::ready(Err(panel_api_only("erase"))))
    }

    fn erased_ids<'a>(
        &'a self,
        _project: ProjectRef<'a>,
    ) -> BoxFuture<'a, Result<Vec<String>, PortError>> {
        Box::pin(std::future::ready(Err(panel_api_only("erasedIds"))))
    }

    fn has_identified_users<'a>(
        &'a self,
        _project: ProjectRef<'a>,
    ) -> BoxFuture<'a, Result<bool, PortError>> {
        Box::pin(std::future::ready(Err(panel_api_only(
            "hasIdentifiedUsers",
        ))))
    }

    fn clear_erased<'a>(
        &'a self,
        _project: ProjectRef<'a>,
        _ids: &'a [String],
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(std::future::ready(Err(panel_api_only("clearErased"))))
    }

    fn release_group_type<'a>(
        &'a self,
        _project: ProjectRef<'a>,
        _group_type: &'a str,
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(std::future::ready(Err(panel_api_only("releaseGroupType"))))
    }

    fn get_group<'a>(
        &'a self,
        _project: ProjectRef<'a>,
        _group_type: &'a str,
        _group_key: &'a str,
    ) -> BoxFuture<'a, Result<Option<Group>, PortError>> {
        Box::pin(std::future::ready(Err(panel_api_only("getGroup"))))
    }

    fn list_groups<'a>(
        &'a self,
        _project: ProjectRef<'a>,
        _input: &'a ListGroupsInput,
    ) -> BoxFuture<'a, Result<GroupsPage, PortError>> {
        Box::pin(std::future::ready(Err(panel_api_only("listGroups"))))
    }

    fn delete_group<'a>(
        &'a self,
        _project: ProjectRef<'a>,
        _input: &'a DeleteGroupInput,
    ) -> BoxFuture<'a, Result<bool, PortError>> {
        Box::pin(std::future::ready(Err(panel_api_only("deleteGroup"))))
    }
}
