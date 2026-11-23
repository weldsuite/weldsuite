//! Record chats (`@weldsuite/chat-domain/entity-channels`): one provider per
//! record type decides who may read a record's chat (the workspace
//! permission for the type plus the record's own check), who follows a new
//! one, and what its detail panel shows.
//!
//! Registration order is the record chat group order: Companies, People,
//! Tasks, Projects, Domains, Sheets, Documents, Boards; `contact` is a legacy name
//! for a person's chat, left out of the lists.

use std::collections::HashSet;

use sea_orm::{
    ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect, RelationDef, Select,
};
use serde_json::{Map, Value};
use weldsuite_core_domain::drive_access::{
    DriveFileRef, DriveGeneralAccess, can_edit, file_role, load_drive_access_for_user,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{
    companies, docs, domains, files, people, project_members, projects, sheets, tasks, whiteboards,
};

use crate::access::{Can, string_list};
use crate::{flow, json_error};

/// A record type with a chat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Company,
    Person,
    Task,
    Project,
    Domain,
    Sheet,
    Doc,
    Board,
    /// Legacy name of a person's chat.
    Contact,
}

/// Every provider, in registration order.
pub const PROVIDERS: [Provider; 9] = [
    Provider::Company,
    Provider::Person,
    Provider::Task,
    Provider::Project,
    Provider::Domain,
    Provider::Sheet,
    Provider::Doc,
    Provider::Board,
    Provider::Contact,
];

/// `getEntityProvider(type)`.
pub fn provider(entity_type: &str) -> Option<Provider> {
    PROVIDERS.into_iter().find(|p| p.type_name() == entity_type)
}

/// `listRecordChatProviders()`: every provider but the legacy names.
pub fn record_chat_providers() -> impl Iterator<Item = Provider> {
    PROVIDERS.into_iter().filter(|p| !p.legacy())
}

/// `ResolvedEntityInfo`: a new chat's name and first followers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedEntity {
    pub display_name: String,
    pub default_member_ids: Vec<String>,
}

/// `new Set(ids)` kept in insertion order.
fn push_unique(list: &mut Vec<String>, id: &str) {
    if !list.iter().any(|existing| existing == id) {
        list.push(id.to_owned());
    }
}

/// `a || b`: the first non-empty string.
fn first_text<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Option<&'a str> {
    values.into_iter().flatten().find(|value| !value.is_empty())
}

/// `personDisplayName`.
fn person_display_name(
    display_name: Option<&str>,
    full_name: Option<&str>,
    first_name: Option<&str>,
    last_name: Option<&str>,
    email: Option<&str>,
) -> String {
    let from_parts = format!(
        "{} {}",
        first_name.unwrap_or_default(),
        last_name.unwrap_or_default()
    );
    let from_parts = crate::text::js_trim(&from_parts);
    first_text([display_name, full_name, Some(from_parts), email])
        .unwrap_or("Person")
        .to_owned()
}

/// A Drive file record behind a sheet or a document chat.
struct FileRecord {
    id: String,
    name: String,
    file: DriveFileRef,
    project_id: Option<String>,
}

type FileRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn file_record(row: FileRow) -> FileRecord {
    let (id, name, file_id, uploaded_by_id, folder_id, general_access, entity_type, entity_id) =
        row;
    let project_id = if entity_type.as_deref() == Some("project") {
        entity_id
    } else {
        None
    };
    FileRecord {
        id,
        name,
        file: DriveFileRef {
            id: file_id,
            uploaded_by_id,
            folder_id,
            general_access: DriveGeneralAccess::parse(general_access.as_deref().unwrap_or("")),
            entity_type,
        },
        project_id,
    }
}

/// `select x.id, f.file_name, f.id, f.uploaded_by_id, f.folder_id,
/// f.general_access, f.entity_type, f.entity_id from <x> inner join files f
/// on f.id = x.file_id where f.deleted_at is null`: a [`FileRow`] per record.
fn with_live_file<E: EntityTrait>(id: E::Column, file_id: E::Column) -> Select<E> {
    let file: RelationDef = E::belongs_to(files::Entity)
        .from(file_id)
        .to(files::Column::Id)
        .into();
    E::find()
        .select_only()
        .column(id)
        .columns([
            files::Column::FileName,
            files::Column::Id,
            files::Column::UploadedById,
            files::Column::FolderId,
            files::Column::GeneralAccess,
            files::Column::EntityType,
            files::Column::EntityId,
        ])
        .join(JoinType::InnerJoin, file)
        .filter(files::Column::DeletedAt.is_null())
}

async fn load_files(
    db: &PgPool,
    kind: Provider,
    ids: &[String],
) -> Result<Vec<FileRecord>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let db = orm(db);
    let ids = ids.iter().map(String::as_str);
    let rows: Vec<FileRow> = if kind == Provider::Board {
        with_live_file::<whiteboards::Entity>(whiteboards::Column::Id, whiteboards::Column::FileId)
            .filter(whiteboards::Column::Id.is_in(ids))
            .into_tuple()
            .all(&db)
            .await?
    } else if kind == Provider::Sheet {
        with_live_file::<sheets::Entity>(sheets::Column::Id, sheets::Column::FileId)
            .filter(sheets::Column::Id.is_in(ids))
            .into_tuple()
            .all(&db)
            .await?
    } else {
        with_live_file::<docs::Entity>(docs::Column::Id, docs::Column::FileId)
            .filter(docs::Column::Id.is_in(ids))
            .filter(docs::Column::SnapshotKey.is_not_null())
            .into_tuple()
            .all(&db)
            .await?
    };
    Ok(rows.into_iter().map(file_record).collect())
}

impl Provider {
    /// The `chat_channels.entity_type` value.
    pub fn type_name(self) -> &'static str {
        match self {
            Self::Company => "company",
            Self::Person => "person",
            Self::Task => "task",
            Self::Project => "project",
            Self::Domain => "domain",
            Self::Sheet => "sheet",
            Self::Doc => "doc",
            Self::Board => "board",
            Self::Contact => "contact",
        }
    }

    /// The group header label.
    pub fn label(self) -> &'static str {
        match self {
            Self::Company => "Companies",
            Self::Person => "People",
            Self::Task => "Tasks",
            Self::Project => "Projects",
            Self::Domain => "Domains",
            Self::Sheet => "Sheets",
            Self::Doc => "Documents",
            Self::Board => "Boards",
            Self::Contact => "Contacts",
        }
    }

    /// The workspace permission that opens the type's records.
    pub fn required_permission(self) -> &'static str {
        match self {
            Self::Company => "companies:read",
            Self::Person | Self::Contact => "people:read",
            Self::Task => "tasks:read",
            Self::Project => "projects:read",
            Self::Domain => "domains:read",
            Self::Sheet => "sheets:read",
            Self::Doc => "docs:read",
            Self::Board => "boards:read",
        }
    }

    pub fn legacy(self) -> bool {
        self == Self::Contact
    }

    /// Whether the type checks writing apart from reading (`canPost`).
    pub fn has_post_check(self) -> bool {
        matches!(self, Self::Sheet | Self::Doc | Self::Board)
    }

    /// `resolve(ctx)`: the new chat's display name and first followers, or
    /// `None` when the record is missing or deleted.
    #[allow(clippy::too_many_lines, clippy::type_complexity)]
    pub async fn resolve(
        self,
        db: &PgPool,
        acting_user_id: &str,
        entity_id: &str,
    ) -> Result<Option<ResolvedEntity>, DbErr> {
        let orm_db = orm(db);
        match self {
            Self::Company => {
                let row: Option<(
                    Option<String>,
                    Option<String>,
                    Option<String>,
                    Option<String>,
                )> = companies::Entity::find()
                    .select_only()
                    .columns([
                        companies::Column::DisplayName,
                        companies::Column::Name,
                        companies::Column::OwnerId,
                        companies::Column::AccountManagerId,
                    ])
                    .filter(companies::Column::Id.eq(entity_id))
                    .filter(companies::Column::DeletedAt.is_null())
                    .into_tuple()
                    .one(&orm_db)
                    .await?;
                Ok(row.map(|(display_name, name, owner, manager)| {
                    let mut members = Vec::new();
                    for id in [owner, manager]
                        .into_iter()
                        .flatten()
                        .filter(|i| !i.is_empty())
                    {
                        push_unique(&mut members, &id);
                    }
                    ResolvedEntity {
                        display_name: first_text([display_name.as_deref(), name.as_deref()])
                            .unwrap_or("Company")
                            .to_owned(),
                        default_member_ids: members,
                    }
                }))
            }
            Self::Person => {
                let row: Option<PersonRow> = people::Entity::find()
                    .select_only()
                    .columns([
                        people::Column::DisplayName,
                        people::Column::FullName,
                        people::Column::FirstName,
                        people::Column::LastName,
                        people::Column::Email,
                        people::Column::OwnerId,
                        people::Column::AccountManagerId,
                    ])
                    .filter(people::Column::Id.eq(entity_id))
                    .filter(people::Column::DeletedAt.is_null())
                    .into_tuple()
                    .one(&orm_db)
                    .await?;
                Ok(row.map(|row| {
                    let mut members = Vec::new();
                    for id in [row.5.clone(), row.6.clone()]
                        .into_iter()
                        .flatten()
                        .filter(|i| !i.is_empty())
                    {
                        push_unique(&mut members, &id);
                    }
                    ResolvedEntity {
                        display_name: person_display_name(
                            row.0.as_deref(),
                            row.1.as_deref(),
                            row.2.as_deref(),
                            row.3.as_deref(),
                            row.4.as_deref(),
                        ),
                        default_member_ids: members,
                    }
                }))
            }
            Self::Contact => {
                let row: Option<(
                    Option<String>,
                    Option<String>,
                    Option<String>,
                    Option<String>,
                    Option<String>,
                )> = people::Entity::find()
                    .select_only()
                    .columns([
                        people::Column::DisplayName,
                        people::Column::FirstName,
                        people::Column::LastName,
                        people::Column::FullName,
                        people::Column::Email,
                    ])
                    .filter(people::Column::Id.eq(entity_id))
                    .filter(people::Column::DeletedAt.is_null())
                    .into_tuple()
                    .one(&orm_db)
                    .await?;
                Ok(
                    row.map(|(display_name, first, last, full, email)| ResolvedEntity {
                        display_name: person_display_name(
                            display_name.as_deref(),
                            full.as_deref(),
                            first.as_deref(),
                            last.as_deref(),
                            email.as_deref(),
                        ),
                        default_member_ids: vec![acting_user_id.to_owned()],
                    }),
                )
            }
            Self::Domain => {
                let row: Option<String> = domains::Entity::find()
                    .select_only()
                    .column(domains::Column::FullDomain)
                    .filter(domains::Column::Id.eq(entity_id))
                    .filter(domains::Column::DeletedAt.is_null())
                    .into_tuple()
                    .one(&orm_db)
                    .await?;
                Ok(row.map(|full_domain| ResolvedEntity {
                    display_name: full_domain,
                    default_member_ids: vec![acting_user_id.to_owned()],
                }))
            }
            Self::Task => {
                let row: Option<(
                    String,
                    Option<String>,
                    Option<Value>,
                    Option<String>,
                    Option<Value>,
                )> = tasks::Entity::find()
                    .select_only()
                    .columns([
                        tasks::Column::Title,
                        tasks::Column::AssigneeId,
                        tasks::Column::AssigneeIds,
                        tasks::Column::ReporterId,
                        tasks::Column::Watchers,
                    ])
                    .filter(tasks::Column::Id.eq(entity_id))
                    .filter(tasks::Column::DeletedAt.is_null())
                    .into_tuple()
                    .one(&orm_db)
                    .await?;
                Ok(row.map(|(title, assignee, assignees, reporter, watchers)| {
                    let mut members = Vec::new();
                    if let Some(id) = assignee.filter(|i| !i.is_empty()) {
                        push_unique(&mut members, &id);
                    }
                    for id in string_list(&assignees.unwrap_or(Value::Null)) {
                        push_unique(&mut members, &id);
                    }
                    if let Some(id) = reporter.filter(|i| !i.is_empty()) {
                        push_unique(&mut members, &id);
                    }
                    for id in string_list(&watchers.unwrap_or(Value::Null)) {
                        push_unique(&mut members, &id);
                    }
                    ResolvedEntity {
                        display_name: title,
                        default_member_ids: members,
                    }
                }))
            }
            Self::Project => {
                let row: Option<(String, Option<String>)> = projects::Entity::find()
                    .select_only()
                    .columns([projects::Column::Name, projects::Column::ProjectManagerId])
                    .filter(projects::Column::Id.eq(entity_id))
                    .filter(projects::Column::DeletedAt.is_null())
                    .into_tuple()
                    .one(&orm_db)
                    .await?;
                let Some((name, manager)) = row else {
                    return Ok(None);
                };
                let members: Vec<String> = project_members::Entity::find()
                    .select_only()
                    .column(project_members::Column::UserId)
                    .filter(project_members::Column::ProjectId.eq(entity_id))
                    .filter(project_members::Column::IsActive.eq(true))
                    .filter(project_members::Column::DeletedAt.is_null())
                    .into_tuple()
                    .all(&orm_db)
                    .await?;
                let mut ids = Vec::new();
                for id in &members {
                    push_unique(&mut ids, id);
                }
                if let Some(manager) = manager.filter(|m| !m.is_empty()) {
                    push_unique(&mut ids, &manager);
                }
                Ok(Some(ResolvedEntity {
                    display_name: name,
                    default_member_ids: ids,
                }))
            }
            Self::Sheet | Self::Doc | Self::Board => {
                let records = load_files(db, self, &[entity_id.to_owned()]).await?;
                Ok(records.into_iter().next().map(|record| {
                    let owner = record.file.uploaded_by_id.filter(|o| !o.is_empty());
                    ResolvedEntity {
                        display_name: record.name,
                        default_member_ids: owner.into_iter().collect(),
                    }
                }))
            }
        }
    }

    /// `filterVisible(ctx, entityIds)`: the ids the acting user may see.
    pub async fn filter_visible(
        self,
        db: &PgPool,
        acting_user_id: &str,
        can: &Can<'_>,
        entity_ids: &[String],
    ) -> Result<HashSet<String>, DbErr> {
        if entity_ids.is_empty() {
            return Ok(HashSet::new());
        }
        let ids = entity_ids.iter().map(String::as_str);
        match self {
            Self::Company => {
                let scope_all = can.can("companies:scope:all").await?;
                // `$scope_all or owner_id = $user`.
                let mut find = companies::Entity::find()
                    .select_only()
                    .column(companies::Column::Id)
                    .filter(companies::Column::Id.is_in(ids))
                    .filter(companies::Column::DeletedAt.is_null());
                if !scope_all {
                    find = find.filter(companies::Column::OwnerId.eq(acting_user_id));
                }
                let ids: Vec<String> = find.into_tuple().all(&orm(db)).await?;
                Ok(ids.into_iter().collect())
            }
            Self::Person | Self::Contact => {
                let scope_all = can.can("people:scope:all").await?;
                let mut find = people::Entity::find()
                    .select_only()
                    .column(people::Column::Id)
                    .filter(people::Column::Id.is_in(ids))
                    .filter(people::Column::DeletedAt.is_null());
                if !scope_all {
                    find = find.filter(people::Column::OwnerId.eq(acting_user_id));
                }
                let ids: Vec<String> = find.into_tuple().all(&orm(db)).await?;
                Ok(ids.into_iter().collect())
            }
            Self::Domain => {
                let ids: Vec<String> = domains::Entity::find()
                    .select_only()
                    .column(domains::Column::Id)
                    .filter(domains::Column::Id.is_in(ids))
                    .filter(domains::Column::DeletedAt.is_null())
                    .into_tuple()
                    .all(&orm(db))
                    .await?;
                Ok(ids.into_iter().collect())
            }
            Self::Task => visible_tasks(db, acting_user_id, can, entity_ids).await,
            Self::Project => visible_projects(db, acting_user_id, can, entity_ids).await,
            Self::Sheet | Self::Doc | Self::Board => {
                visible_files(self, db, acting_user_id, can, entity_ids).await
            }
        }
    }

    /// `canPost(ctx)` for the types that have one: may comment on the file.
    pub async fn can_post(
        self,
        db: &PgPool,
        acting_user_id: &str,
        entity_id: &str,
        can: &Can<'_>,
    ) -> Result<bool, DbErr> {
        let (comment, update) = match self {
            Self::Sheet => ("sheets:comment", "sheets:update"),
            Self::Doc => ("docs:comment", "docs:update"),
            Self::Board => ("boards:comment", "boards:update"),
            _ => return Ok(true),
        };
        if can.can(comment).await? {
            return Ok(true);
        }
        if !can.can(update).await? {
            return Ok(false);
        }
        let records = load_files(db, self, &[entity_id.to_owned()]).await?;
        let Some(record) = records.into_iter().next() else {
            return Ok(false);
        };
        let index = load_drive_access_for_user(db, Some(acting_user_id)).await?;
        if !can_edit(file_role(&index, &record.file)) {
            return Ok(false);
        }
        let Some(project_id) = record.project_id else {
            return Ok(true);
        };
        let scope_all = can.can("projects:scope:all").await?;
        flow::can_write_project(db, acting_user_id, scope_all, &project_id).await
    }

    /// `resolveDetail(ctx)`: the record panel's details, or `None` (also for
    /// the types without a detail).
    pub async fn resolve_detail(
        self,
        db: &PgPool,
        entity_id: &str,
    ) -> Result<Option<Value>, DbErr> {
        let orm_db = orm(db);
        let row: Option<Map<String, Value>> = match self {
            Self::Company | Self::Person => return Ok(None),
            Self::Contact => {
                let row = people::Entity::find_by_id(entity_id)
                    .filter(people::Column::DeletedAt.is_null())
                    .one(&orm_db)
                    .await?;
                let row = row.map(serde_json::to_value).transpose().map_err(json_error)?;
                picked(row, CONTACT_DETAIL)
            }
            Self::Domain => {
                let row = domains::Entity::find_by_id(entity_id)
                    .filter(domains::Column::DeletedAt.is_null())
                    .one(&orm_db)
                    .await?;
                let row = row.map(serde_json::to_value).transpose().map_err(json_error)?;
                picked(row, DOMAIN_DETAIL).map(|mut row| {
                    let registrar = row
                        .get("registrar")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    row.insert(
                        "registrar".to_owned(),
                        public_domain_registrar(registrar.as_deref()),
                    );
                    row
                })
            }
            Self::Task => {
                let row = tasks::Entity::find_by_id(entity_id)
                    .filter(tasks::Column::DeletedAt.is_null())
                    .one(&orm_db)
                    .await?;
                let row = row.map(serde_json::to_value).transpose().map_err(json_error)?;
                picked(row, TASK_DETAIL)
            }
            Self::Project => return project_detail(db, entity_id).await,
            Self::Sheet | Self::Doc | Self::Board => {
                let records = load_files(db, self, &[entity_id.to_owned()]).await?;
                return Ok(records.into_iter().next().map(|record| {
                    serde_json::json!({
                        "id": record.id,
                        "name": record.name,
                        "fileId": record.file.id,
                        "projectId": record.project_id,
                    })
                }));
            }
        };
        Ok(row.map(Value::Object))
    }
}

/// The record panels' columns (`jsonb_build_object` of them): the keys of the
/// entity's row, which serializes each as Drizzle returned it.
const CONTACT_DETAIL: &[&str] = &[
    "id",
    "firstName",
    "lastName",
    "fullName",
    "email",
    "directPhone",
    "mobilePhone",
    "title",
    "department",
    "avatarUrl",
    "status",
];
const DOMAIN_DETAIL: &[&str] = &[
    "id",
    "name",
    "tld",
    "fullDomain",
    "status",
    "registrar",
    "registeredAt",
    "expiresAt",
    "autoRenew",
    "nameservers",
];
const TASK_DETAIL: &[&str] = &[
    "id",
    "title",
    "description",
    "status",
    "priority",
    "type",
    "assigneeId",
    "assigneeIds",
    "reporterId",
    "projectId",
    "startDate",
    "dueDate",
    "tags",
    "labels",
];
/// `budgetedHours`, `budgetedAmount`, `actualAmount` and `hourlyRate` were
/// `::text`: the entity prints them with the column's two decimals, as
/// Postgres does.
const PROJECT_DETAIL: &[&str] = &[
    "id",
    "code",
    "name",
    "description",
    "status",
    "priority",
    "health",
    "type",
    "methodology",
    "visibility",
    "projectManagerId",
    "leaderId",
    "customerId",
    "startDate",
    "endDate",
    "actualStartDate",
    "actualEndDate",
    "budgetedHours",
    "budgetedAmount",
    "actualAmount",
    "budgetCurrency",
    "billingMethod",
    "hourlyRate",
    "isBillable",
    "trackTime",
    "color",
    "icon",
    "createdAt",
    "updatedAt",
];

/// The entity row's JSON (as Drizzle returns it), cut to `keys`: the
/// `jsonb_build_object` of those columns.
fn picked(row: Option<Value>, keys: &[&str]) -> Option<Map<String, Value>> {
    let row = row?;
    Some(
        keys.iter()
            .map(|key| ((*key).to_owned(), row.get(*key).cloned().unwrap_or(Value::Null)))
            .collect(),
    )
}

type PersonRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// `publicDomainRegistrar`: a managed registrar reads `WeldSuite`.
fn public_domain_registrar(registrar: Option<&str>) -> Value {
    const MANAGED: [&str; 4] = ["realtimeregister", "cloudflare", "WeldHost", "WeldSuite"];
    match registrar {
        None | Some("") => Value::String("WeldSuite".to_owned()),
        Some(name) if MANAGED.contains(&name) => Value::String("WeldSuite".to_owned()),
        Some(name) => Value::String(name.to_owned()),
    }
}

/// The project panel: its columns, computed counters and active members.
async fn project_detail(db: &PgPool, entity_id: &str) -> Result<Option<Value>, DbErr> {
    let orm_db = orm(db);
    let row = projects::Entity::find_by_id(entity_id)
        .filter(projects::Column::DeletedAt.is_null())
        .one(&orm_db)
        .await?;
    let row = row.map(serde_json::to_value).transpose().map_err(json_error)?;
    let Some(mut detail) = picked(row, PROJECT_DETAIL) else {
        return Ok(None);
    };
    let members: Vec<(String, String)> = project_members::Entity::find()
        .select_only()
        .columns([project_members::Column::UserId, project_members::Column::Role])
        .filter(project_members::Column::ProjectId.eq(entity_id))
        .filter(project_members::Column::IsActive.eq(true))
        .filter(project_members::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm_db)
        .await?;
    let members: Vec<Value> = members
        .into_iter()
        .map(|(user_id, role)| serde_json::json!({ "userId": user_id, "role": role }))
        .collect();
    let stats = flow::project_stats(db, entity_id).await?;
    if let Value::Object(stats) = stats {
        detail.extend(stats);
    }
    detail.insert("members".to_owned(), Value::Array(members));
    Ok(Some(Value::Object(detail)))
}

/// `canAccessEntity(provider, ctx)`: the type's permission, then the record.
pub async fn can_access_entity(
    provider: Provider,
    db: &PgPool,
    acting_user_id: &str,
    entity_id: &str,
    can: &Can<'_>,
) -> Result<bool, DbErr> {
    if !can.can(provider.required_permission()).await? {
        return Ok(false);
    }
    let visible = provider
        .filter_visible(db, acting_user_id, can, &[entity_id.to_owned()])
        .await?;
    Ok(visible.contains(entity_id))
}

/// `canPostInRecordChat(provider, ctx)`: `canPost`, else yes.
pub async fn can_post_in_record_chat(
    provider: Provider,
    db: &PgPool,
    acting_user_id: &str,
    entity_id: &str,
    can: &Can<'_>,
) -> Result<bool, DbErr> {
    if !provider.has_post_check() {
        return Ok(true);
    }
    provider.can_post(db, acting_user_id, entity_id, can).await
}

/// Live projects the user may open: `projects:scope:all`, the manager, or an
/// active member.
async fn visible_projects(
    db: &PgPool,
    user_id: &str,
    can: &Can<'_>,
    entity_ids: &[String],
) -> Result<HashSet<String>, DbErr> {
    let live = live_projects(db, entity_ids).await?;
    if can.can("projects:scope:all").await? {
        return Ok(live.into_iter().map(|(id, _)| id).collect());
    }
    let mut visible = HashSet::new();
    let mut others = Vec::new();
    for (id, manager) in live {
        if manager.as_deref() == Some(user_id) {
            visible.insert(id);
        } else {
            others.push(id);
        }
    }
    if !others.is_empty() {
        visible.extend(member_of_projects(db, user_id, &others).await?);
    }
    Ok(visible)
}

/// `select id, project_manager_id from projects where id = any($1) and
/// deleted_at is null`.
async fn live_projects(
    db: &PgPool,
    project_ids: &[String],
) -> Result<Vec<(String, Option<String>)>, DbErr> {
    projects::Entity::find()
        .select_only()
        .columns([projects::Column::Id, projects::Column::ProjectManagerId])
        .filter(projects::Column::Id.is_in(project_ids.iter().map(String::as_str)))
        .filter(projects::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await
}

/// Of `project_ids`, those the user is an active member of.
async fn member_of_projects(
    db: &PgPool,
    user_id: &str,
    project_ids: &[String],
) -> Result<Vec<String>, DbErr> {
    project_members::Entity::find()
        .select_only()
        .column(project_members::Column::ProjectId)
        .filter(project_members::Column::ProjectId.is_in(project_ids.iter().map(String::as_str)))
        .filter(project_members::Column::UserId.eq(user_id))
        .filter(project_members::Column::IsActive.eq(true))
        .filter(project_members::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await
}

/// `openProjectIds`: of `project_ids`, the ones the user may open.
async fn open_project_ids(
    db: &PgPool,
    user_id: &str,
    project_ids: &[String],
    scope_all: bool,
) -> Result<HashSet<String>, DbErr> {
    let live = live_projects(db, project_ids).await?;
    let mut open = HashSet::new();
    let mut others = Vec::new();
    for (id, manager) in live {
        if scope_all || manager.as_deref() == Some(user_id) {
            open.insert(id);
        } else {
            others.push(id);
        }
    }
    if others.is_empty() {
        return Ok(open);
    }
    open.extend(member_of_projects(db, user_id, &others).await?);
    Ok(open)
}

/// A project task opens to those who may open its project; a task without
/// one to the people involved in it.
async fn visible_tasks(
    db: &PgPool,
    user_id: &str,
    can: &Can<'_>,
    entity_ids: &[String],
) -> Result<HashSet<String>, DbErr> {
    type TaskRow = (
        String,
        Option<String>,
        Option<Value>,
        Option<String>,
        Option<Value>,
        Option<String>,
    );
    let rows: Vec<TaskRow> = tasks::Entity::find()
        .select_only()
        .columns([
            tasks::Column::Id,
            tasks::Column::AssigneeId,
            tasks::Column::AssigneeIds,
            tasks::Column::ReporterId,
            tasks::Column::Watchers,
            tasks::Column::ProjectId,
        ])
        .filter(tasks::Column::Id.is_in(entity_ids.iter().map(String::as_str)))
        .filter(tasks::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    let mut visible = HashSet::new();
    let mut via_project: Vec<(String, String)> = Vec::new();
    for (id, assignee, assignees, reporter, watchers, project) in rows {
        if let Some(project) = project.filter(|p| !p.is_empty()) {
            via_project.push((id, project));
            continue;
        }
        let involved = assignee.as_deref() == Some(user_id)
            || reporter.as_deref() == Some(user_id)
            || string_list(&assignees.unwrap_or(Value::Null))
                .iter()
                .any(|a| a == user_id)
            || string_list(&watchers.unwrap_or(Value::Null))
                .iter()
                .any(|w| w == user_id);
        if involved {
            visible.insert(id);
        }
    }
    if !via_project.is_empty() {
        let project_ids: Vec<String> = crate::access::unique_ids(
            &via_project
                .iter()
                .map(|(_, p)| p.clone())
                .collect::<Vec<_>>(),
        );
        let scope_all = can.can("projects:scope:all").await?;
        let open = open_project_ids(db, user_id, &project_ids, scope_all).await?;
        for (id, project) in via_project {
            if open.contains(&project) {
                visible.insert(id);
            }
        }
    }
    Ok(visible)
}

/// Sheets and documents: a Drive role on the file, and for a project's file
/// the project's own rule.
async fn visible_files(
    kind: Provider,
    db: &PgPool,
    user_id: &str,
    can: &Can<'_>,
    entity_ids: &[String],
) -> Result<HashSet<String>, DbErr> {
    let records = load_files(db, kind, entity_ids).await?;
    let mut visible = HashSet::new();
    if records.is_empty() {
        return Ok(visible);
    }
    let index = load_drive_access_for_user(db, Some(user_id)).await?;
    let mut in_projects = Vec::new();
    for record in records {
        if file_role(&index, &record.file).is_none() {
            continue;
        }
        if let Some(project) = record.project_id.clone().filter(|p| !p.is_empty()) {
            in_projects.push((record.id, project));
        } else {
            visible.insert(record.id);
        }
    }
    if !in_projects.is_empty() {
        let project_ids = crate::access::unique_ids(
            &in_projects
                .iter()
                .map(|(_, p)| p.clone())
                .collect::<Vec<_>>(),
        );
        let projects = visible_projects(db, user_id, can, &project_ids).await?;
        for (id, project) in in_projects {
            if projects.contains(&project) {
                visible.insert(id);
            }
        }
    }
    Ok(visible)
}
