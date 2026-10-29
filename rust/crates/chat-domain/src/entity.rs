//! Record chats (`@weldsuite/chat-domain/entity-channels`): one provider per
//! record type decides who may read a record's chat (the workspace
//! permission for the type plus the record's own check), who follows a new
//! one, and what its detail panel shows.
//!
//! Registration order is the record chat group order: Companies, People,
//! Tasks, Projects, Domains, Sheets, Documents; `contact` is a legacy name
//! for a person's chat, left out of the lists.

use std::collections::HashSet;

use serde_json::{Map, Value};
use sqlx::PgPool;
use weldsuite_core_domain::drive_access::{
    DriveFileRef, DriveGeneralAccess, can_edit, file_role, load_drive_access_for_user,
};

use crate::access::{Can, string_list};
use crate::flow;

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
    /// Legacy name of a person's chat.
    Contact,
}

/// Every provider, in registration order.
pub const PROVIDERS: [Provider; 8] = [
    Provider::Company,
    Provider::Person,
    Provider::Task,
    Provider::Project,
    Provider::Domain,
    Provider::Sheet,
    Provider::Doc,
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

async fn load_files(db: &PgPool, kind: Provider, ids: &[String]) -> Result<Vec<FileRecord>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<FileRow> = if kind == Provider::Sheet {
        sqlx::query_as(
            "select s.id, f.file_name, f.id, f.uploaded_by_id, f.folder_id, f.general_access::text,
                    f.entity_type, f.entity_id
             from sheets s inner join files f on f.id = s.file_id
             where s.id = any($1) and f.deleted_at is null",
        )
        .bind(ids)
        .fetch_all(db)
        .await?
    } else {
        sqlx::query_as(
            "select d.id, f.file_name, f.id, f.uploaded_by_id, f.folder_id, f.general_access::text,
                    f.entity_type, f.entity_id
             from docs d inner join files f on f.id = d.file_id
             where d.id = any($1) and d.snapshot_key is not null and f.deleted_at is null",
        )
        .bind(ids)
        .fetch_all(db)
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
        }
    }

    pub fn legacy(self) -> bool {
        self == Self::Contact
    }

    /// Whether the type checks writing apart from reading (`canPost`).
    pub fn has_post_check(self) -> bool {
        matches!(self, Self::Sheet | Self::Doc)
    }

    /// `resolve(ctx)`: the new chat's display name and first followers, or
    /// `None` when the record is missing or deleted.
    pub async fn resolve(
        self,
        db: &PgPool,
        acting_user_id: &str,
        entity_id: &str,
    ) -> Result<Option<ResolvedEntity>, sqlx::Error> {
        match self {
            Self::Company => {
                let row: Option<(Option<String>, Option<String>, Option<String>, Option<String>)> =
                    sqlx::query_as(
                        "select display_name, name, owner_id, account_manager_id from companies
                         where id = $1 and deleted_at is null limit 1",
                    )
                    .bind(entity_id)
                    .fetch_optional(db)
                    .await?;
                Ok(row.map(|(display_name, name, owner, manager)| {
                    let mut members = Vec::new();
                    for id in [owner, manager].into_iter().flatten().filter(|i| !i.is_empty()) {
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
                let row: Option<PersonRow> = sqlx::query_as(
                    "select display_name, full_name, first_name, last_name, email, owner_id,
                            account_manager_id
                     from people where id = $1 and deleted_at is null limit 1",
                )
                .bind(entity_id)
                .fetch_optional(db)
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
                let row: Option<(Option<String>, Option<String>, Option<String>, Option<String>, Option<String>)> =
                    sqlx::query_as(
                        "select display_name, first_name, last_name, full_name, email from people
                         where id = $1 and deleted_at is null limit 1",
                    )
                    .bind(entity_id)
                    .fetch_optional(db)
                    .await?;
                Ok(row.map(|(display_name, first, last, full, email)| ResolvedEntity {
                    display_name: person_display_name(
                        display_name.as_deref(),
                        full.as_deref(),
                        first.as_deref(),
                        last.as_deref(),
                        email.as_deref(),
                    ),
                    default_member_ids: vec![acting_user_id.to_owned()],
                }))
            }
            Self::Domain => {
                let row: Option<String> = sqlx::query_scalar(
                    "select full_domain from domains where id = $1 and deleted_at is null limit 1",
                )
                .bind(entity_id)
                .fetch_optional(db)
                .await?;
                Ok(row.map(|full_domain| ResolvedEntity {
                    display_name: full_domain,
                    default_member_ids: vec![acting_user_id.to_owned()],
                }))
            }
            Self::Task => {
                let row: Option<(String, Option<String>, Option<Value>, Option<String>, Option<Value>)> =
                    sqlx::query_as(
                        "select title, assignee_id, assignee_ids, reporter_id, watchers from tasks
                         where id = $1 and deleted_at is null limit 1",
                    )
                    .bind(entity_id)
                    .fetch_optional(db)
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
                let row: Option<(String, Option<String>)> = sqlx::query_as(
                    "select name, project_manager_id from projects
                     where id = $1 and deleted_at is null limit 1",
                )
                .bind(entity_id)
                .fetch_optional(db)
                .await?;
                let Some((name, manager)) = row else {
                    return Ok(None);
                };
                let members: Vec<String> = sqlx::query_scalar(
                    "select user_id from project_members
                     where project_id = $1 and is_active = true and deleted_at is null",
                )
                .bind(entity_id)
                .fetch_all(db)
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
            Self::Sheet | Self::Doc => {
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
    ) -> Result<HashSet<String>, sqlx::Error> {
        if entity_ids.is_empty() {
            return Ok(HashSet::new());
        }
        match self {
            Self::Company => {
                let scope_all = can.can("companies:scope:all").await?;
                let ids: Vec<String> = sqlx::query_scalar(
                    "select id from companies
                     where id = any($1) and deleted_at is null and ($2 or owner_id = $3)",
                )
                .bind(entity_ids)
                .bind(scope_all)
                .bind(acting_user_id)
                .fetch_all(db)
                .await?;
                Ok(ids.into_iter().collect())
            }
            Self::Person | Self::Contact => {
                let scope_all = can.can("people:scope:all").await?;
                let ids: Vec<String> = sqlx::query_scalar(
                    "select id from people
                     where id = any($1) and deleted_at is null and ($2 or owner_id = $3)",
                )
                .bind(entity_ids)
                .bind(scope_all)
                .bind(acting_user_id)
                .fetch_all(db)
                .await?;
                Ok(ids.into_iter().collect())
            }
            Self::Domain => {
                let ids: Vec<String> = sqlx::query_scalar(
                    "select id from domains where id = any($1) and deleted_at is null",
                )
                .bind(entity_ids)
                .fetch_all(db)
                .await?;
                Ok(ids.into_iter().collect())
            }
            Self::Task => visible_tasks(db, acting_user_id, can, entity_ids).await,
            Self::Project => visible_projects(db, acting_user_id, can, entity_ids).await,
            Self::Sheet | Self::Doc => visible_files(self, db, acting_user_id, can, entity_ids).await,
        }
    }

    /// `canPost(ctx)` for the types that have one: may comment on the file.
    pub async fn can_post(
        self,
        db: &PgPool,
        acting_user_id: &str,
        entity_id: &str,
        can: &Can<'_>,
    ) -> Result<bool, sqlx::Error> {
        let (comment, update) = match self {
            Self::Sheet => ("sheets:comment", "sheets:update"),
            Self::Doc => ("docs:comment", "docs:update"),
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
    ) -> Result<Option<Value>, sqlx::Error> {
        let row: Option<Value> = match self {
            Self::Company | Self::Person => return Ok(None),
            Self::Contact => {
                sqlx::query_scalar(
                    "select jsonb_build_object('id', id, 'firstName', first_name, 'lastName', last_name,
                        'fullName', full_name, 'email', email, 'directPhone', direct_phone,
                        'mobilePhone', mobile_phone, 'title', title, 'department', department,
                        'avatarUrl', avatar_url, 'status', status)
                     from people where id = $1 and deleted_at is null limit 1",
                )
                .bind(entity_id)
                .fetch_optional(db)
                .await?
            }
            Self::Domain => {
                let row: Option<Value> = sqlx::query_scalar(
                    "select jsonb_build_object('id', id, 'name', name, 'tld', tld,
                        'fullDomain', full_domain, 'status', status, 'registrar', registrar,
                        'registeredAt', registered_at, 'expiresAt', expires_at,
                        'autoRenew', auto_renew, 'nameservers', nameservers)
                     from domains where id = $1 and deleted_at is null limit 1",
                )
                .bind(entity_id)
                .fetch_optional(db)
                .await?;
                row.map(|mut row| {
                    let registrar = row["registrar"].as_str().map(str::to_owned);
                    row["registrar"] = public_domain_registrar(registrar.as_deref());
                    row
                })
            }
            Self::Task => {
                sqlx::query_scalar(
                    "select jsonb_build_object('id', id, 'title', title, 'description', description,
                        'status', status, 'priority', priority, 'type', type,
                        'assigneeId', assignee_id, 'assigneeIds', assignee_ids,
                        'reporterId', reporter_id, 'projectId', project_id,
                        'startDate', start_date, 'dueDate', due_date, 'tags', tags, 'labels', labels)
                     from tasks where id = $1 and deleted_at is null limit 1",
                )
                .bind(entity_id)
                .fetch_optional(db)
                .await?
            }
            Self::Project => return project_detail(db, entity_id).await,
            Self::Sheet | Self::Doc => {
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
        Ok(row.map(weldsuite_db::js_row))
    }
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
async fn project_detail(db: &PgPool, entity_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'code', code, 'name', name,
            'description', description, 'status', status, 'priority', priority,
            'health', health, 'type', type, 'methodology', methodology,
            'visibility', visibility, 'projectManagerId', project_manager_id,
            'leaderId', leader_id, 'customerId', customer_id, 'startDate', start_date,
            'endDate', end_date, 'actualStartDate', actual_start_date,
            'actualEndDate', actual_end_date, 'budgetedHours', budgeted_hours::text,
            'budgetedAmount', budgeted_amount::text, 'actualAmount', actual_amount::text,
            'budgetCurrency', budget_currency, 'billingMethod', billing_method,
            'hourlyRate', hourly_rate::text, 'isBillable', is_billable,
            'trackTime', track_time, 'color', color, 'icon', icon,
            'createdAt', created_at, 'updatedAt', updated_at)
         from projects where id = $1 and deleted_at is null limit 1",
    )
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let members: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('userId', user_id, 'role', role) from project_members
         where project_id = $1 and is_active = true and deleted_at is null",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let stats = flow::project_stats(db, entity_id).await?;
    let mut detail = match weldsuite_db::js_row(row) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
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
) -> Result<bool, sqlx::Error> {
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
) -> Result<bool, sqlx::Error> {
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
) -> Result<HashSet<String>, sqlx::Error> {
    let live: Vec<(String, Option<String>)> = sqlx::query_as(
        "select id, project_manager_id from projects where id = any($1) and deleted_at is null",
    )
    .bind(entity_ids)
    .fetch_all(db)
    .await?;
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
        let member_of: Vec<String> = sqlx::query_scalar(
            "select project_id from project_members
             where project_id = any($1) and user_id = $2 and is_active = true and deleted_at is null",
        )
        .bind(&others)
        .bind(user_id)
        .fetch_all(db)
        .await?;
        visible.extend(member_of);
    }
    Ok(visible)
}

/// `openProjectIds`: of `project_ids`, the ones the user may open.
async fn open_project_ids(
    db: &PgPool,
    user_id: &str,
    project_ids: &[String],
    scope_all: bool,
) -> Result<HashSet<String>, sqlx::Error> {
    let live: Vec<(String, Option<String>)> = sqlx::query_as(
        "select id, project_manager_id from projects where id = any($1) and deleted_at is null",
    )
    .bind(project_ids)
    .fetch_all(db)
    .await?;
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
    let member_of: Vec<String> = sqlx::query_scalar(
        "select project_id from project_members
         where project_id = any($1) and user_id = $2 and is_active = true and deleted_at is null",
    )
    .bind(&others)
    .bind(user_id)
    .fetch_all(db)
    .await?;
    open.extend(member_of);
    Ok(open)
}

/// A project task opens to those who may open its project; a task without
/// one to the people involved in it.
async fn visible_tasks(
    db: &PgPool,
    user_id: &str,
    can: &Can<'_>,
    entity_ids: &[String],
) -> Result<HashSet<String>, sqlx::Error> {
    type TaskRow = (
        String,
        Option<String>,
        Option<Value>,
        Option<String>,
        Option<Value>,
        Option<String>,
    );
    let rows: Vec<TaskRow> = sqlx::query_as(
        "select id, assignee_id, assignee_ids, reporter_id, watchers, project_id from tasks
         where id = any($1) and deleted_at is null",
    )
    .bind(entity_ids)
    .fetch_all(db)
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
            &via_project.iter().map(|(_, p)| p.clone()).collect::<Vec<_>>(),
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
) -> Result<HashSet<String>, sqlx::Error> {
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
            &in_projects.iter().map(|(_, p)| p.clone()).collect::<Vec<_>>(),
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
