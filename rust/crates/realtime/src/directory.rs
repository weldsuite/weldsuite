//! Who a session is in its workspace, and the room gates, against the master
//! and tenant databases: what the realtime-worker reads from the Clerk
//! token's org claims and checks in `src/index.ts` (`assertChatChannelAccess`,
//! `assertConversationInWorkspace`, `workspaceHubKey`).

use std::fmt;
use std::sync::Arc;

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use weldsuite_db::{WorkspaceError, Workspaces, orm};
use weldsuite_ports::BoxFuture;
use weldsuite_schema::tenant::{
    chat_channel_members, chat_channels, desk_conversations, helpdesk_conversations,
    workspace_members,
};

/// A signed-in member of a workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    /// The session's organization claim, as the token had it.
    pub org: String,
    /// The hub key: `workspaces.clerk_org_id`, else `workspaces.id` (what
    /// publishers and entity events name the workspace by).
    pub hub: String,
    /// `workspaces.id`.
    pub workspace_id: String,
    /// `workspace_members.role` (`OWNER`, `ADMIN`, `MEMBER`, `VIEWER`).
    pub role: String,
    /// `workspace_members.name`, for room presence and typing.
    pub name: Option<String>,
}

/// Why a lookup failed.
#[derive(Debug)]
pub enum DirectoryError {
    /// No workspace has the session's organization.
    WorkspaceNotFound,
    /// The workspace is suspended.
    Suspended,
    /// A database could not be reached or refused the query.
    Failed(String),
}

impl fmt::Display for DirectoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WorkspaceNotFound => f.write_str("workspace not found"),
            Self::Suspended => f.write_str("workspace suspended"),
            Self::Failed(reason) => write!(f, "lookup failed: {reason}"),
        }
    }
}

impl std::error::Error for DirectoryError {}

/// The chat-channel gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatAccess {
    Allowed,
    ChannelNotFound,
    NotMember,
}

/// What the gateway asks about people and rooms.
pub trait Directory: Send + Sync + 'static {
    /// `user` as an active member of the workspace whose organization is
    /// `org`; `None` when they are not one.
    fn member<'a>(
        &'a self,
        org: &'a str,
        user: &'a str,
    ) -> BoxFuture<'a, Result<Option<Member>, DirectoryError>>;

    /// A public channel, or one `user` is a member of (not deleted).
    fn chat_access<'a>(
        &'a self,
        member: &'a Member,
        user: &'a str,
        channel: &'a str,
    ) -> BoxFuture<'a, Result<ChatAccess, DirectoryError>>;

    /// The conversation is in the member's workspace (WeldDesk's
    /// `desk_conversations`, or the older `helpdesk_conversations`).
    fn conversation_exists<'a>(
        &'a self,
        member: &'a Member,
        conversation: &'a str,
    ) -> BoxFuture<'a, Result<bool, DirectoryError>>;

    /// `workspaceHubKey`: the hub key of a workspace named by either id. An
    /// `org_…` id is the key; an unknown id is kept as it is.
    fn hub_key<'a>(&'a self, reference: &'a str) -> BoxFuture<'a, Result<String, DirectoryError>>;
}

/// [`Directory`] on the master database and the workspaces' own databases.
#[derive(Debug, Clone)]
pub struct DbDirectory {
    workspaces: Arc<Workspaces>,
}

impl DbDirectory {
    pub fn new(workspaces: Arc<Workspaces>) -> Self {
        Self { workspaces }
    }

    async fn tenant(&self, org: &str) -> Result<weldsuite_db::Tenant, DirectoryError> {
        match self.workspaces.tenant(org).await {
            Ok(tenant) if tenant.suspended => Err(DirectoryError::Suspended),
            Ok(tenant) => Ok(tenant),
            Err(WorkspaceError::NotFound) => Err(DirectoryError::WorkspaceNotFound),
            Err(error) => Err(DirectoryError::Failed(error.to_string())),
        }
    }
}

fn failed(error: &DbErr) -> DirectoryError {
    DirectoryError::Failed(error.to_string())
}

impl Directory for DbDirectory {
    fn member<'a>(
        &'a self,
        org: &'a str,
        user: &'a str,
    ) -> BoxFuture<'a, Result<Option<Member>, DirectoryError>> {
        Box::pin(async move {
            let tenant = self.tenant(org).await?;
            let row: Option<(String, Option<String>)> = workspace_members::Entity::find()
                .select_only()
                .column(workspace_members::Column::Role)
                .column(workspace_members::Column::Name)
                .filter(workspace_members::Column::UserId.eq(user))
                .filter(workspace_members::Column::DeletedAt.is_null())
                .filter(workspace_members::Column::Status.eq("ACTIVE"))
                .limit(1)
                .into_tuple()
                .one(&orm(&tenant.db))
                .await
                .map_err(|error| failed(&error))?;
            Ok(row.map(|(role, name)| Member {
                org: org.to_owned(),
                hub: tenant
                    .clerk_org_id
                    .clone()
                    .unwrap_or_else(|| tenant.workspace_id.clone()),
                workspace_id: tenant.workspace_id.clone(),
                role,
                name: name.filter(|name| !name.is_empty()),
            }))
        })
    }

    fn chat_access<'a>(
        &'a self,
        member: &'a Member,
        user: &'a str,
        channel: &'a str,
    ) -> BoxFuture<'a, Result<ChatAccess, DirectoryError>> {
        Box::pin(async move {
            let tenant = self.tenant(&member.org).await?;
            let db = orm(&tenant.db);
            let kind: Option<Option<String>> = chat_channels::Entity::find()
                .select_only()
                .column(chat_channels::Column::Type)
                .filter(chat_channels::Column::Id.eq(channel))
                .filter(chat_channels::Column::DeletedAt.is_null())
                .limit(1)
                .into_tuple()
                .one(&db)
                .await
                .map_err(|error| failed(&error))?;
            let Some(kind) = kind else {
                return Ok(ChatAccess::ChannelNotFound);
            };
            if kind.as_deref() == Some("public") {
                return Ok(ChatAccess::Allowed);
            }
            let membership: Option<String> = chat_channel_members::Entity::find()
                .select_only()
                .column(chat_channel_members::Column::Id)
                .filter(chat_channel_members::Column::ChannelId.eq(channel))
                .filter(chat_channel_members::Column::UserId.eq(user))
                .limit(1)
                .into_tuple()
                .one(&db)
                .await
                .map_err(|error| failed(&error))?;
            Ok(if membership.is_some() {
                ChatAccess::Allowed
            } else {
                ChatAccess::NotMember
            })
        })
    }

    fn conversation_exists<'a>(
        &'a self,
        member: &'a Member,
        conversation: &'a str,
    ) -> BoxFuture<'a, Result<bool, DirectoryError>> {
        Box::pin(async move {
            let tenant = self.tenant(&member.org).await?;
            let db = orm(&tenant.db);
            let desk: Option<String> = desk_conversations::Entity::find()
                .select_only()
                .column(desk_conversations::Column::Id)
                .filter(desk_conversations::Column::Id.eq(conversation))
                .limit(1)
                .into_tuple()
                .one(&db)
                .await
                .map_err(|error| failed(&error))?;
            if desk.is_some() {
                return Ok(true);
            }
            let helpdesk: Option<String> = helpdesk_conversations::Entity::find()
                .select_only()
                .column(helpdesk_conversations::Column::Id)
                .filter(helpdesk_conversations::Column::Id.eq(conversation))
                .limit(1)
                .into_tuple()
                .one(&db)
                .await
                .map_err(|error| failed(&error))?;
            Ok(helpdesk.is_some())
        })
    }

    fn hub_key<'a>(&'a self, reference: &'a str) -> BoxFuture<'a, Result<String, DirectoryError>> {
        Box::pin(async move {
            if reference.starts_with("org_") {
                return Ok(reference.to_owned());
            }
            match self.workspaces.tenant(reference).await {
                Ok(tenant) => Ok(tenant.clerk_org_id.unwrap_or(tenant.workspace_id)),
                Err(WorkspaceError::NotFound) => Ok(reference.to_owned()),
                Err(error) => Err(DirectoryError::Failed(error.to_string())),
            }
        })
    }
}
