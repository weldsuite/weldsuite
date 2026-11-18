//! The `PanelProject` state port: what Global keeps in the `PanelProject`
//! Durable Object (ADR PANEL-004, `PanelProjectObjectApi` in
//! `packages/domains/panel/src/project-object.ts`, implemented in
//! `apps/workers/panel-ingest/src/durable-objects/panel-project.ts`), one
//! object per project:
//!
//! - people (the latest profile of each identified user), identity links
//!   (anonymous id to user id, the first link wins), groups and the project's
//!   group types (at most `MAX_GROUP_TYPES`, in the order they were taken);
//! - the erased ids every query excludes until the Iceberg rows are rewritten;
//! - the live view (sessions seen in the last five minutes).
//!
//! On the Kubernetes editions ([`PanelProjectState`]'s production adapter)
//! people, links, groups, group types and erased ids are tenant tables,
//! written by `weldsuite consume panel-writer` (only the producing
//! workspace's database is opened), and the live view is a Valkey sorted set
//! per project (plan `weldpanel-eu.md`, "What the Durable Objects hold on
//! Global"). Conformance builds use the test's `PANEL_PROJECT` namespace
//! through the harness's ledger bridge.
//!
//! The wire types serialize to the JSON shapes of `project-object.ts`, field
//! for field: the conformance adapter sends them as the RPC arguments and
//! reads the answers with them, and both backends' calls are compared. An
//! optional input field left out is left out of the JSON (`undefined`), not
//! sent as `null`.
//!
//! Callers: panel-api's routes (queries read [`PanelProjectState::erased_ids`]
//! and [`PanelProjectState::has_identified_users`]; people, groups, live and
//! erasure the rest) and the collector (`collector::project`: identify,
//! profile and group operations, live touches).

use std::sync::Arc;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use weldsuite_ports::{BoxFuture, PortError};

/// `PanelPropertyValue`: a string, a number, a boolean or `null`.
pub type PropertyValue = Value;

/// A profile's or a group's properties.
pub type Properties = Map<String, PropertyValue>;

/// Which project's state a call is about. The object is addressed by the
/// project id (Global's `idFromName(projectId)`); the workspace tells an
/// adapter whose tenant database and cache keys hold it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectRef<'a> {
    /// `workspaces.id`.
    pub workspace_id: &'a str,
    pub project_id: &'a str,
}

// ---------------------------------------------------------------------------
// People and identities
// ---------------------------------------------------------------------------

/// `PanelPeopleOp`: a profile operation from `people.set()` and friends
/// (SDK or `/v1/track`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PeopleOp {
    Set {
        user_id: String,
        ts: String,
        props: Properties,
    },
    SetOnce {
        user_id: String,
        ts: String,
        props: Properties,
    },
    Unset {
        user_id: String,
        ts: String,
        keys: Vec<String>,
    },
    /// `props` are numbers.
    Increment {
        user_id: String,
        ts: String,
        props: Map<String, Value>,
    },
}

/// `PanelPerson`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub user_id: String,
    /// The `$email` property, lower-cased, if set.
    pub email: Option<String>,
    /// The `$name` property, if set.
    pub name: Option<String>,
    pub properties: Properties,
    /// Anonymous ids linked to this user (devices, visits before login).
    pub anon_ids: Vec<String>,
    pub first_seen: String,
    pub last_seen: String,
}

/// `PanelPeoplePage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeoplePage {
    pub people: Vec<Person>,
    pub cursor: Option<String>,
    pub total_count: u64,
}

/// `identify`'s input: link `anon_id` to `user_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentifyInput {
    pub workspace_id: String,
    pub project_id: String,
    pub anon_id: String,
    pub user_id: String,
    pub ts: String,
}

/// `identify`'s answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identified {
    /// The anonymous id is linked to this user (now or already).
    pub linked: bool,
}

/// `applyPeopleOps`' input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeopleOpsInput {
    pub workspace_id: String,
    pub project_id: String,
    pub ops: Vec<PeopleOp>,
}

/// `listPeople`'s input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPeopleInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    /// Absent, `null` or a cursor of the previous page.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullish"
    )]
    pub cursor: Option<Option<String>>,
    pub limit: u32,
}

/// `erase`'s input: a user id or an anonymous id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EraseInput {
    pub workspace_id: String,
    pub project_id: String,
    pub user_id_or_anon_id: String,
}

/// `PanelErasure`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Erasure {
    /// The user id erased, when the request named or resolved to one.
    pub user_id: Option<String>,
    /// Every id now excluded from queries (the user id and its anonymous ids).
    pub erased_ids: Vec<String>,
}

// ---------------------------------------------------------------------------
// Live view
// ---------------------------------------------------------------------------

/// `PanelLiveTouch`: what the collector reports for the live view, at most
/// once per session every few seconds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTouch {
    pub session_id: String,
    pub distinct_id: String,
    pub path: String,
    pub title: Option<String>,
    pub country: Option<String>,
    /// `desktop`, `mobile` or `tablet`.
    pub device_type: Option<String>,
    pub ts: String,
}

/// `PanelLiveSession`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession {
    #[serde(flatten)]
    pub touch: LiveTouch,
    pub started_at: String,
    pub pageviews: u64,
}

/// `live()`'s answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Live {
    pub visitors: u64,
    pub sessions: Vec<LiveSession>,
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/// `PanelGroupOp`: a group profile operation (`group(type, key, props)`,
/// `groups.set()` and friends).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum GroupOp {
    Set {
        group_type: String,
        group_key: String,
        props: Properties,
    },
    SetOnce {
        group_type: String,
        group_key: String,
        props: Properties,
    },
    Unset {
        group_type: String,
        group_key: String,
        keys: Vec<String>,
    },
}

/// `PanelGroup`: a company, an account, a workspace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub group_type: String,
    pub group_key: String,
    pub properties: Properties,
    /// First and last profile operation for the group.
    pub first_seen: String,
    pub last_seen: String,
}

/// `PanelGroupsPage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupsPage {
    pub groups: Vec<Group>,
    pub cursor: Option<String>,
    pub total_count: u64,
}

/// `applyGroupOps`' input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupOpsInput {
    pub workspace_id: String,
    pub project_id: String,
    pub ops: Vec<GroupOp>,
}

/// `PanelGroupOpsResult`: operations of a type past the project's group
/// type slots are dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupOpsResult {
    pub applied: u64,
    pub dropped: u64,
    /// The project's group types after the call, in the order they were taken.
    pub types: Vec<String>,
}

/// `listGroups`' input: one type's groups, most recently seen first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListGroupsInput {
    pub group_type: String,
    /// Matches the key and the `$name` / `name` property.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullish"
    )]
    pub cursor: Option<Option<String>>,
    pub limit: u32,
}

/// `deleteGroup`'s input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteGroupInput {
    pub workspace_id: String,
    pub project_id: String,
    pub group_type: String,
    pub group_key: String,
}

/// A `.nullish()` field: absent (`None`), `null` (`Some(None)`) or a value.
#[allow(
    clippy::option_option,
    reason = "Zod's three states of a nullish field"
)]
fn nullish<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/// A project's people, identities, groups, erased ids and live view
/// (`PanelProjectObjectApi`). Every method names the project it is about;
/// the TypeScript method each one stands for is in its doc, and the
/// conformance adapter calls it by that name with the arguments in that
/// order. An error is the backing store failing (the Durable Object's call
/// throwing on Global): the routes answer as panel-api does when the call
/// throws.
pub trait PanelProjectState: Send + Sync {
    // --- collector side -------------------------------------------------

    /// `identify(input)`: link the anonymous id to the user id. An
    /// anonymous id links to at most one user (the first link wins); erased
    /// ids are never linked. Writes an `identities_v1` row for a new link
    /// and a `people_v1` row for a new person.
    fn identify<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a IdentifyInput,
    ) -> BoxFuture<'a, Result<Identified, PortError>>;

    /// `applyPeopleOps(input)`: profile operations in order, one
    /// `people_v1` snapshot row per changed profile.
    fn apply_people_ops<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a PeopleOpsInput,
    ) -> BoxFuture<'a, Result<(), PortError>>;

    /// `touchLive(touches)`: keeps sessions seen in the last five minutes.
    fn touch_live<'a>(
        &'a self,
        project: ProjectRef<'a>,
        touches: &'a [LiveTouch],
    ) -> BoxFuture<'a, Result<(), PortError>>;

    // --- panel-api side -------------------------------------------------

    /// `getPerson(userIdOrAnonId)`: the profile of a user id, or of the user
    /// an anonymous id is linked to.
    fn get_person<'a>(
        &'a self,
        project: ProjectRef<'a>,
        user_id_or_anon_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<Person>, PortError>>;

    /// `listPeople(input)`: a page of profiles, `search` matching the user
    /// id, email and name.
    fn list_people<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a ListPeopleInput,
    ) -> BoxFuture<'a, Result<PeoplePage, PortError>>;

    /// `findByEmail(email)`: profiles whose `$email` matches
    /// (case-insensitive), for the WeldCRM person card.
    fn find_by_email<'a>(
        &'a self,
        project: ProjectRef<'a>,
        email: &'a str,
    ) -> BoxFuture<'a, Result<Vec<Person>, PortError>>;

    /// `live()`: the sessions seen in the last five minutes.
    fn live<'a>(&'a self, project: ProjectRef<'a>) -> BoxFuture<'a, Result<Live, PortError>>;

    /// `erase(input)`: removes the profile and links at once and adds the
    /// ids to the erased list every query excludes (GDPR).
    fn erase<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a EraseInput,
    ) -> BoxFuture<'a, Result<Erasure, PortError>>;

    /// `erasedIds()`: the ids every query excludes until the maintenance job
    /// has rewritten their rows.
    fn erased_ids<'a>(
        &'a self,
        project: ProjectRef<'a>,
    ) -> BoxFuture<'a, Result<Vec<String>, PortError>>;

    /// `hasIdentifiedUsers()`: whether any identity link exists; the query
    /// compiler adds the identity join only then.
    fn has_identified_users<'a>(
        &'a self,
        project: ProjectRef<'a>,
    ) -> BoxFuture<'a, Result<bool, PortError>>;

    /// `clearErased(ids)`: the maintenance job rewrote these ids' rows; they
    /// no longer need excluding.
    fn clear_erased<'a>(
        &'a self,
        project: ProjectRef<'a>,
        ids: &'a [String],
    ) -> BoxFuture<'a, Result<(), PortError>>;

    // --- groups ---------------------------------------------------------

    /// `applyGroupOps(input)`: one `groups_v1` snapshot row per changed
    /// group; operations of a type without a slot are dropped.
    fn apply_group_ops<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a GroupOpsInput,
    ) -> BoxFuture<'a, Result<GroupOpsResult, PortError>>;

    /// `ensureGroupTypes(types)`: gives the named types a slot while there
    /// is room; answers the project's types in the order they were taken.
    fn ensure_group_types<'a>(
        &'a self,
        project: ProjectRef<'a>,
        types: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<String>, PortError>>;

    /// `groupTypes()`: the project's group types, in the order they were taken.
    fn group_types<'a>(
        &'a self,
        project: ProjectRef<'a>,
    ) -> BoxFuture<'a, Result<Vec<String>, PortError>>;

    /// `releaseGroupType(groupType)`: frees a type's slot (its profiles stay,
    /// and come back if the type is taken again).
    fn release_group_type<'a>(
        &'a self,
        project: ProjectRef<'a>,
        group_type: &'a str,
    ) -> BoxFuture<'a, Result<(), PortError>>;

    /// `getGroup(groupType, groupKey)`.
    fn get_group<'a>(
        &'a self,
        project: ProjectRef<'a>,
        group_type: &'a str,
        group_key: &'a str,
    ) -> BoxFuture<'a, Result<Option<Group>, PortError>>;

    /// `listGroups(input)`: one type's groups, most recently seen first.
    fn list_groups<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a ListGroupsInput,
    ) -> BoxFuture<'a, Result<GroupsPage, PortError>>;

    /// `deleteGroup(input)`: removes the profile and writes a `deleted` row
    /// to `groups_v1`; false when there was none.
    fn delete_group<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a DeleteGroupInput,
    ) -> BoxFuture<'a, Result<bool, PortError>>;
}

/// The project state a request uses, when the request brings one
/// (conformance builds: the test's `PANEL_PROJECT`, or `None` when the test
/// binds none). Without the extension the routes use [`crate::PanelState`]'s.
#[derive(Clone, Default)]
pub struct RequestProjectState(pub Option<Arc<dyn PanelProjectState>>);

impl std::fmt::Debug for RequestProjectState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("RequestProjectState")
            .field(&self.0.is_some())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn writes_the_shapes_of_project_object_ts() {
        let op = PeopleOp::SetOnce {
            user_id: "u_1".into(),
            ts: "2026-11-14T10:00:00.000Z".into(),
            props: Map::from_iter([("plan".to_owned(), json!("pro"))]),
        };
        assert_eq!(
            serde_json::to_value(&op).expect("json"),
            json!({ "op": "set_once", "userId": "u_1", "ts": "2026-11-14T10:00:00.000Z", "props": { "plan": "pro" } })
        );
        let group = GroupOp::Unset {
            group_type: "company".into(),
            group_key: "acme".into(),
            keys: vec!["plan".into()],
        };
        assert_eq!(
            serde_json::to_value(&group).expect("json"),
            json!({ "op": "unset", "groupType": "company", "groupKey": "acme", "keys": ["plan"] })
        );
        let list = ListPeopleInput {
            search: None,
            cursor: Some(None),
            limit: 50,
        };
        assert_eq!(
            serde_json::to_value(&list).expect("json"),
            json!({ "cursor": null, "limit": 50 })
        );
        let list = ListPeopleInput {
            search: Some("ann".into()),
            cursor: None,
            limit: 50,
        };
        assert_eq!(
            serde_json::to_value(&list).expect("json"),
            json!({ "search": "ann", "limit": 50 })
        );
    }

    #[test]
    fn reads_the_answers_of_project_object_ts() {
        let session: LiveSession = serde_json::from_value(json!({
            "sessionId": "s_1", "distinctId": "a_1", "path": "/", "title": null, "country": "NL",
            "deviceType": "mobile", "ts": "2026-11-14T10:00:00.000Z", "startedAt": "2026-11-14T09:58:00.000Z",
            "pageviews": 3
        }))
        .expect("a live session");
        assert_eq!(session.touch.country.as_deref(), Some("NL"));
        assert_eq!(session.pageviews, 3);
        let erasure: Erasure =
            serde_json::from_value(json!({ "userId": null, "erasedIds": ["a_1"] }))
                .expect("an erasure");
        assert_eq!(erasure.erased_ids, ["a_1"]);
        let page: ListGroupsInput =
            serde_json::from_value(json!({ "groupType": "company", "cursor": null, "limit": 20 }))
                .expect("a list input");
        assert_eq!(page.cursor, Some(None));
    }
}
