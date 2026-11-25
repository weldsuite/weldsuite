//! Board records (`services/boards.ts`) and versions (`services/versions.ts`):
//! a drive `files` row paired with a `whiteboards` row, and the old WeldFlow
//! whiteboards (`project_whiteboards`) listed beside a project's boards until
//! someone opens one.

use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, FromQueryResult,
    JoinType, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, RelationDef, Select,
    TransactionTrait, UpdateMany,
};
use serde_json::{Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_core_domain::drive_access::{
    DriveFileRef, DriveGeneralAccess, DriveRole, VisibleFiles,
};
use weldsuite_db::{PgPool, orm, utc_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    board_versions, files, project_whiteboards, projects, whiteboards, workspace_members,
};

/// The mime type of a board's drive file (`WELDBOARD_MIME_TYPE`).
pub(crate) const WELDBOARD_MIME_TYPE: &str = "application/vnd.weldsuite.board+json";

/// `files.entity_type` of a WeldFlow project's files (`PROJECT_ENTITY`).
pub(crate) const PROJECT_ENTITY: &str = "project";

/// `files.file_type` of a board (`BOARD_FILE_TYPE`).
pub(crate) const BOARD_FILE_TYPE: &str = "whiteboard";

/// Most boards a project-scoped page may reach into (`MAX_PROJECT_WINDOW`):
/// legacy and new boards are merged in memory.
const MAX_PROJECT_WINDOW: i64 = 2000;

/// A board, or an old WeldFlow whiteboard not converted yet (`BoardRecord`).
#[derive(Debug, Clone)]
pub(crate) struct BoardRecord {
    pub(crate) id: String,
    /// `None` for an old WeldFlow whiteboard.
    pub(crate) file_id: Option<String>,
    pub(crate) name: String,
    pub(crate) folder_id: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) created_by_id: Option<String>,
    pub(crate) updated_by_id: Option<String>,
    pub(crate) revision: i64,
    pub(crate) snapshot_key: Option<String>,
    pub(crate) project_id: Option<String>,
    pub(crate) template_category: Option<String>,
    pub(crate) legacy: bool,
    /// What drive access needs about the file (`None` for an old whiteboard).
    pub(crate) file: Option<DriveFileRef>,
}

/// A `timestamp` as the `Date` Drizzle read it prints (`toISOString()`).
fn iso(at: PrimitiveDateTime) -> String {
    iso_timestamp(at.assume_utc())
}

/// A [`BoardRecord`]'s `toISOString()` stamp as the `timestamp` it names,
/// as Postgres reads `'…Z'::timestamp`.
fn timestamp_of(stamp: &str) -> Result<PrimitiveDateTime, DbErr> {
    OffsetDateTime::parse(stamp, &time::format_description::well_known::Rfc3339)
        .map(utc_timestamp)
        .map_err(|error| {
            DbErr::Type(format!(
                "invalid input syntax for type timestamp: {stamp:?} ({error})"
            ))
        })
}

/// The columns of a live [`BoardRecord`], on `whiteboards` joined with `files`.
#[derive(Debug, FromQueryResult)]
struct LiveRow {
    id: String,
    file_id: String,
    name: String,
    folder_id: Option<String>,
    created_at: PrimitiveDateTime,
    board_updated_at: PrimitiveDateTime,
    file_updated_at: PrimitiveDateTime,
    created_by_id: Option<String>,
    updated_by_id: Option<String>,
    revision: i32,
    snapshot_key: Option<String>,
    is_template: bool,
    template_category: Option<String>,
    general_access: String,
    entity_type: Option<String>,
    entity_id: Option<String>,
}

/// The columns of a legacy [`BoardRecord`], on `project_whiteboards`.
#[derive(Debug, FromQueryResult)]
struct LegacyRow {
    id: String,
    name: String,
    project_id: String,
    created_at: PrimitiveDateTime,
    updated_at: PrimitiveDateTime,
    last_edited_by: Option<String>,
}

impl BoardRecord {
    /// A `whiteboards` ⨝ `files` row (`toRecord`).
    fn live(row: LiveRow) -> Self {
        let board_updated = iso(row.board_updated_at);
        let file_updated = iso(row.file_updated_at);
        let project_id = (row.entity_type.as_deref() == Some(PROJECT_ENTITY))
            .then(|| row.entity_id.clone())
            .flatten();
        let template_category = row.is_template.then(|| {
            row.template_category
                .clone()
                .unwrap_or_else(|| "other".to_owned())
        });
        let file = DriveFileRef {
            id: row.file_id.clone(),
            uploaded_by_id: row.created_by_id.clone(),
            folder_id: row.folder_id.clone(),
            general_access: DriveGeneralAccess::parse(&row.general_access),
            entity_type: row.entity_type,
        };
        Self {
            id: row.id,
            name: row.name,
            folder_id: row.folder_id,
            created_at: iso(row.created_at),
            // ISO strings of one shape compare as the instants they are.
            updated_at: if board_updated > file_updated {
                board_updated
            } else {
                file_updated
            },
            created_by_id: row.created_by_id,
            updated_by_id: row.updated_by_id,
            revision: i64::from(row.revision),
            snapshot_key: row.snapshot_key,
            project_id,
            template_category,
            legacy: false,
            file: Some(file),
            file_id: Some(row.file_id),
        }
    }

    /// A `project_whiteboards` row (`legacyRecord`).
    fn legacy(row: LegacyRow) -> Self {
        Self {
            id: row.id,
            file_id: None,
            name: row.name,
            folder_id: None,
            created_at: iso(row.created_at),
            updated_at: iso(row.updated_at),
            created_by_id: None,
            updated_by_id: row.last_edited_by,
            revision: 0,
            snapshot_key: None,
            project_id: Some(row.project_id),
            template_category: None,
            legacy: true,
            file: None,
        }
    }

    /// A converted board, with its drive file (`isLive`).
    pub(crate) fn is_live(&self) -> bool {
        !self.legacy && self.file_id.is_some() && self.file.is_some()
    }

    pub(crate) fn file_id(&self) -> &str {
        self.file_id.as_deref().unwrap_or_default()
    }

    /// `toSummary(board, role, mayEdit)`.
    pub(crate) fn summary(&self, role: DriveRole, may_edit: bool) -> Value {
        json!({
            "id": self.id,
            "fileId": self.file_id,
            "name": self.name,
            "folderId": self.folder_id,
            "projectId": self.project_id,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "createdById": self.created_by_id,
            "updatedById": self.updated_by_id,
            "revision": self.revision,
            "role": role.as_str(),
            "canEdit": may_edit && matches!(role, DriveRole::Owner | DriveRole::Editor),
            "templateCategory": self.template_category,
            "legacy": self.legacy,
        })
    }

    /// `eventData(board)`.
    pub(crate) fn event_data(&self) -> Value {
        json!({
            "id": self.id,
            "fileId": self.file_id,
            "name": self.name,
            "projectId": self.project_id,
            "revision": self.revision,
            "updatedById": self.updated_by_id,
        })
    }

    /// `fileEventData(board, fileSize?)`.
    pub(crate) fn file_event_data(&self, file_size: Option<i64>) -> Value {
        let mut data = json!({
            "id": self.file_id,
            "name": self.name,
            "folderId": self.folder_id,
            "fileType": BOARD_FILE_TYPE,
        });
        if let Some(size) = file_size {
            data["fileSize"] = json!(size);
        }
        data
    }

    /// Where its checkpoint is (`roomMeta(board, workspaceId).snapshotKey`).
    pub(crate) fn snapshot_key_in(&self, workspace: &str) -> String {
        self.snapshot_key
            .clone()
            .unwrap_or_else(|| snapshot_key_for(workspace, &self.id))
    }

    /// `roomMeta(board, workspaceId)`.
    pub(crate) fn room_meta(&self, workspace: &str) -> Value {
        json!({
            "workspaceId": workspace,
            "boardId": self.id,
            "snapshotKey": self.snapshot_key_in(workspace),
        })
    }
}

/// The room of a board: one per board, named by workspace and id (`roomFor`).
pub(crate) fn room_name(workspace: &str, board_id: &str) -> String {
    format!("{workspace}:{board_id}")
}

/// The key a board's checkpoints are written to (`snapshotKeyFor`).
pub(crate) fn snapshot_key_for(workspace: &str, board_id: &str) -> String {
    format!("workspaces/{workspace}/boards/{board_id}/board.json.gz")
}

/// The directory of a board's checkpoint, with its trailing slash.
fn key_dir(snapshot_key: &str) -> &str {
    snapshot_key
        .rfind('/')
        .map_or("", |slash| &snapshot_key[..=slash])
}

/// Where a board's thumbnail sits, next to its checkpoint (`thumbnailKeyFor`).
pub(crate) fn thumbnail_key_for(snapshot_key: &str) -> String {
    format!("{}thumbnail.svg", key_dir(snapshot_key))
}

/// Where a version's snapshot goes, next to the checkpoint (`versionKeyFor`).
pub(crate) fn version_key_for(board_snapshot_key: &str, version_id: &str) -> String {
    format!(
        "{}versions/{version_id}.json.gz",
        key_dir(board_snapshot_key)
    )
}

/// `join(files, eq(files.id, whiteboards.fileId))`.
fn board_file() -> RelationDef {
    whiteboards::Entity::belongs_to(files::Entity)
        .from(whiteboards::Column::FileId)
        .to(files::Column::Id)
        .into()
}

/// The [`LiveRow`] columns of `whiteboards` joined with `files`.
fn live_rows() -> Select<whiteboards::Entity> {
    whiteboards::Entity::find()
        .select_only()
        .columns([whiteboards::Column::Id, whiteboards::Column::FileId])
        .column_as(files::Column::FileName, "name")
        .column(files::Column::FolderId)
        .column(whiteboards::Column::CreatedAt)
        .column_as(whiteboards::Column::UpdatedAt, "board_updated_at")
        .column_as(files::Column::UpdatedAt, "file_updated_at")
        .column_as(files::Column::UploadedById, "created_by_id")
        .columns([
            whiteboards::Column::UpdatedById,
            whiteboards::Column::Revision,
            whiteboards::Column::SnapshotKey,
            whiteboards::Column::IsTemplate,
            whiteboards::Column::TemplateCategory,
        ])
        .columns([
            files::Column::GeneralAccess,
            files::Column::EntityType,
            files::Column::EntityId,
        ])
        .join(JoinType::InnerJoin, board_file())
}

/// The [`LegacyRow`] columns of `project_whiteboards`.
fn legacy_rows() -> Select<project_whiteboards::Entity> {
    use project_whiteboards::Column;
    project_whiteboards::Entity::find().select_only().columns([
        Column::Id,
        Column::Name,
        Column::ProjectId,
        Column::CreatedAt,
        Column::UpdatedAt,
        Column::LastEditedBy,
    ])
}

/// An old WeldFlow whiteboard not converted yet (converting keeps the id):
/// `not exists (select 1 from whiteboards w2 where w2.id = p.id)`.
fn not_converted() -> Expr {
    project_whiteboards::Column::Id.not_in_subquery(
        Query::select()
            .column(whiteboards::Column::Id)
            .from(whiteboards::Entity)
            .to_owned(),
    )
}

/// `column` among the projects a list covers: the caller's
/// (`inArray(column, ids.length ? ids : [''])`), or, for `None`, every live
/// project.
fn in_projects(column: impl ColumnTrait, ids: Option<&[String]>) -> Expr {
    match ids {
        Some([]) => column.is_in([String::new()]),
        Some(ids) => column.is_in(ids),
        None => column.in_subquery(
            Query::select()
                .column(projects::Column::Id)
                .from(projects::Entity)
                .and_where(projects::Column::DeletedAt.is_null())
                .to_owned(),
        ),
    }
}

/// Which boards a list shows (`BoardScope`).
#[derive(Debug, Clone)]
pub(crate) enum BoardScope {
    /// Boards that belong to no project.
    Drive,
    /// The workspace's templates.
    Templates,
    /// One project's.
    Project(String),
    /// Every project's the caller may open: the ids, or `None` for all live projects.
    Projects(Option<Vec<String>>),
}

/// The list's filters (`listBoards`' params).
pub(crate) struct ListBoards {
    pub(crate) scope: BoardScope,
    /// `visibleFilesCondition`; `None` for no condition (an admin, or a scope
    /// that is not the drive).
    pub(crate) visible: Option<VisibleFiles>,
    /// The `ilike` pattern, already escaped and wrapped in `%`.
    pub(crate) search: Option<String>,
    pub(crate) limit: i64,
    pub(crate) offset: i64,
}

/// `visibleFilesCondition`: a project's file, the caller's own, one shared
/// with them, one in a folder that grants them a role, or one open to the
/// workspace outside any folder or in an open one.
fn visible_condition(visible: &VisibleFiles) -> Condition {
    let mut any = Condition::any().add(files::Column::EntityType.is_not_null());
    if let Some(user_id) = &visible.user_id {
        any = any.add(files::Column::UploadedById.eq(user_id));
    }
    // `= any('{}')` matches nothing: an empty list adds no way in.
    if !visible.file_share_ids.is_empty() {
        any = any.add(files::Column::Id.is_in(&visible.file_share_ids));
    }
    if !visible.granted_folder_ids.is_empty() {
        any = any.add(files::Column::FolderId.is_in(&visible.granted_folder_ids));
    }
    let mut folder = Condition::any().add(files::Column::FolderId.is_null());
    if !visible.open_folder_ids.is_empty() {
        folder = folder.add(files::Column::FolderId.is_in(&visible.open_folder_ids));
    }
    any.add(
        Condition::all()
            .add(files::Column::GeneralAccess.ne("restricted"))
            .add(folder),
    )
}

/// `listBoards`' filter on `whiteboards` ⨝ `files`: not trashed, in the
/// scope, visible on the drive, matching the search.
fn listed(params: &ListBoards) -> Condition {
    let condition = Condition::all().add(files::Column::DeletedAt.is_null());
    let mut condition = match &params.scope {
        BoardScope::Drive => condition.add(files::Column::EntityType.is_null()),
        BoardScope::Templates => condition
            .add(whiteboards::Column::IsTemplate.eq(true))
            .add(files::Column::EntityType.is_null()),
        BoardScope::Project(project_id) => condition
            .add(files::Column::EntityType.eq(PROJECT_ENTITY))
            .add(files::Column::EntityId.eq(project_id)),
        BoardScope::Projects(ids) => condition
            .add(files::Column::EntityType.eq(PROJECT_ENTITY))
            .add(in_projects(files::Column::EntityId, ids.as_deref())),
    };
    if let Some(visible) = &params.visible {
        condition = condition.add(visible_condition(visible));
    }
    if let Some(search) = &params.search {
        condition = condition.add(files::Column::FileName.ilike(search));
    }
    condition
}

/// The old WeldFlow whiteboards a project scope lists beside its boards: not
/// deleted, not converted, of the scope's projects, matching the search.
fn legacy_listed(params: &ListBoards) -> Condition {
    let column = project_whiteboards::Column::ProjectId;
    let mut condition = Condition::all()
        .add(project_whiteboards::Column::DeletedAt.is_null())
        .add(not_converted())
        .add(match &params.scope {
            BoardScope::Project(project_id) => column.eq(project_id),
            BoardScope::Projects(ids) => in_projects(column, ids.as_deref()),
            BoardScope::Drive | BoardScope::Templates => in_projects(column, None),
        });
    if let Some(search) = &params.search {
        condition = condition.add(project_whiteboards::Column::Name.ilike(search));
    }
    condition
}

/// A row count as the `count(*)::bigint` it was.
fn count_of(count: u64) -> i64 {
    i64::try_from(count).unwrap_or(i64::MAX)
}

/// A `limit` / `offset` as SeaQuery takes it (the routes never send a
/// negative one).
fn rows_of(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
}

/// Boards not in the trash, most recently changed first (`listBoards`); a
/// project scope merges in its old WeldFlow whiteboards by last change.
pub(crate) async fn list_boards(
    db: &PgPool,
    params: &ListBoards,
) -> Result<(Vec<BoardRecord>, i64), DbErr> {
    let db = &orm(db);
    let projects = matches!(
        params.scope,
        BoardScope::Project(_) | BoardScope::Projects(_)
    );
    let (limit, offset) = if projects {
        (
            (params.offset.saturating_add(params.limit)).min(MAX_PROJECT_WINDOW),
            0,
        )
    } else {
        (params.limit, params.offset)
    };
    let filter = listed(params);
    let rows = live_rows()
        .filter(filter.clone())
        .order_by_desc(Func::greatest([
            Expr::col((whiteboards::Entity, whiteboards::Column::UpdatedAt)),
            Expr::col((files::Entity, files::Column::UpdatedAt)),
        ]))
        .order_by_desc(whiteboards::Column::Id)
        .limit(rows_of(limit))
        .offset(rows_of(offset))
        .into_model::<LiveRow>()
        .all(db)
        .await?;
    let total = whiteboards::Entity::find()
        .join(JoinType::InnerJoin, board_file())
        .filter(filter)
        .count(db)
        .await?;
    let total = count_of(total);
    let boards = rows.into_iter().map(BoardRecord::live);
    if !projects {
        return Ok((boards.collect(), total));
    }

    // Project boards and not-yet-converted whiteboards, merged by last change.
    let filter = legacy_listed(params);
    let legacy = legacy_rows()
        .filter(filter.clone())
        .order_by_desc(project_whiteboards::Column::UpdatedAt)
        .order_by_desc(project_whiteboards::Column::Id)
        .limit(rows_of(limit))
        .into_model::<LegacyRow>()
        .all(db)
        .await?;
    let legacy_total = project_whiteboards::Entity::find()
        .filter(filter)
        .count(db)
        .await?;
    let mut merged: Vec<BoardRecord> = boards
        .chain(legacy.into_iter().map(BoardRecord::legacy))
        .collect();
    merged.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    let start = usize::try_from(params.offset).unwrap_or(usize::MAX);
    let take = usize::try_from(params.limit).unwrap_or(0);
    let page = merged.into_iter().skip(start).take(take).collect();
    // No page reaches past the window, so neither does the total: a cursor
    // past it would answer an empty page that still says there is more.
    Ok((
        page,
        (total + count_of(legacy_total)).min(MAX_PROJECT_WINDOW),
    ))
}

/// A board not in the trash, or an old WeldFlow whiteboard not converted
/// yet; `None` when neither (`getBoard`).
pub(crate) async fn get_board(db: &PgPool, id: &str) -> Result<Option<BoardRecord>, DbErr> {
    if let Some(board) = get_live_board(db, id).await? {
        return Ok(Some(board));
    }
    let legacy = legacy_rows()
        .filter(project_whiteboards::Column::Id.eq(id))
        .filter(project_whiteboards::Column::DeletedAt.is_null())
        .filter(not_converted())
        .into_model::<LegacyRow>()
        .one(&orm(db))
        .await?;
    Ok(legacy.map(BoardRecord::legacy))
}

/// A converted board (never an old whiteboard), or `None` (`getLiveBoard`).
pub(crate) async fn get_live_board(db: &PgPool, id: &str) -> Result<Option<BoardRecord>, DbErr> {
    let row = live_rows()
        .filter(whiteboards::Column::Id.eq(id))
        .filter(files::Column::DeletedAt.is_null())
        .into_model::<LiveRow>()
        .one(&orm(db))
        .await?;
    Ok(row.map(BoardRecord::live))
}

/// The `whiteboards` row of a new board (`createBoard`, after its drive file).
pub(crate) struct NewBoardRow<'a> {
    pub(crate) id: &'a str,
    pub(crate) file_id: &'a str,
    pub(crate) snapshot_key: &'a str,
    pub(crate) template_category: Option<&'a str>,
    pub(crate) user_id: &'a str,
}

pub(crate) async fn insert_board(
    db: &PgPool,
    row: &NewBoardRow<'_>,
    now: PrimitiveDateTime,
) -> Result<(), DbErr> {
    whiteboards::Entity::insert(whiteboards::ActiveModel {
        id: Set(row.id.to_owned()),
        file_id: Set(row.file_id.to_owned()),
        snapshot_key: Set(Some(row.snapshot_key.to_owned())),
        revision: Set(0),
        snapshot_revision: Set(0),
        is_template: Set(row.template_category.is_some()),
        template_category: Set(row.template_category.map(str::to_owned)),
        updated_by_id: Set(Some(row.user_id.to_owned())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    Ok(())
}

/// An old WeldFlow whiteboard's `elements` (as the JSON text Postgres keeps)
/// and who last changed it, for the converter (`legacyElements`).
pub(crate) async fn legacy_elements(
    db: &PgPool,
    id: &str,
) -> Result<Option<(Option<String>, Option<String>)>, DbErr> {
    use project_whiteboards::Column;
    project_whiteboards::Entity::find()
        .select_only()
        // `elements::text`: the converter reads Postgres's own text of the jsonb.
        .column_as(
            Expr::from(Func::cast_as(
                Expr::col((project_whiteboards::Entity, Column::Elements)),
                "text",
            )),
            "elements",
        )
        .column(Column::LastEditedBy)
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await
}

/// What a conversion stores (`convertLegacy`'s params).
pub(crate) struct ConvertLegacy<'a> {
    pub(crate) legacy: &'a BoardRecord,
    pub(crate) snapshot_key: &'a str,
    pub(crate) snapshot_size: i64,
    pub(crate) user_id: &'a str,
    /// `deduplicateFileName(db, legacy.name, null) || legacy.name`.
    pub(crate) file_name: &'a str,
}

/// `update project_whiteboards set deleted_at = now, updated_at = now` on
/// an old WeldFlow whiteboard not deleted yet (WeldFlow's soft delete).
fn retire_legacy(id: &str, now: PrimitiveDateTime) -> UpdateMany<project_whiteboards::Entity> {
    use project_whiteboards::Column;
    project_whiteboards::Entity::update_many()
        .col_expr(Column::DeletedAt, Expr::value(now))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
}

/// Makes an old WeldFlow whiteboard a board, in place (`convertLegacy`): the
/// drive file, the board row and the old row's soft delete commit as one
/// unit. `None` when someone else converted it first (the board row's
/// insert then fails, and the rest with it).
pub(crate) async fn convert_legacy(
    db: &PgPool,
    params: &ConvertLegacy<'_>,
    at: OffsetDateTime,
) -> Result<Option<BoardRecord>, DbErr> {
    let legacy = params.legacy;
    let file_id = generate_id("fil");
    let editor = legacy.updated_by_id.as_deref().unwrap_or(params.user_id);
    let now = utc_timestamp(at);
    let metadata = json!({
        "weldBoardId": legacy.id,
        "convertedFrom": { "table": "project_whiteboards", "at": iso_timestamp(at) },
    });
    let run = async {
        let created_at = timestamp_of(&legacy.created_at)?;
        let tx = orm(db).begin().await?;
        files::Entity::insert(files::ActiveModel {
            id: Set(file_id.clone()),
            file_name: Set(params.file_name.to_owned()),
            original_name: Set(Some(legacy.name.clone())),
            mime_type: Set(WELDBOARD_MIME_TYPE.to_owned()),
            file_size: Set(i32::try_from(params.snapshot_size)
                .map_err(|_| DbErr::Type("integer out of range".to_owned()))?),
            file_type: Set(BOARD_FILE_TYPE.to_owned()),
            storage_path: Set(params.snapshot_key.to_owned()),
            file_key: Set(Some(params.snapshot_key.to_owned())),
            bucket: Set(Some("private".to_owned())),
            folder_id: Set(None),
            uploaded_by_id: Set(Some(editor.to_owned())),
            is_public: Set(false),
            entity_type: Set(Some(PROJECT_ENTITY.to_owned())),
            entity_id: Set(legacy.project_id.clone()),
            metadata: Set(Some(metadata)),
            created_at: Set(created_at),
            updated_at: Set(now),
            ..Default::default()
        })
        .exec_without_returning(&tx)
        .await?;
        whiteboards::Entity::insert(whiteboards::ActiveModel {
            id: Set(legacy.id.clone()),
            file_id: Set(file_id.clone()),
            snapshot_key: Set(Some(params.snapshot_key.to_owned())),
            revision: Set(0),
            snapshot_revision: Set(0),
            is_template: Set(false),
            template_category: Set(None),
            updated_by_id: Set(Some(editor.to_owned())),
            created_at: Set(created_at),
            updated_at: Set(now),
            ..Default::default()
        })
        .exec_without_returning(&tx)
        .await?;
        retire_legacy(&legacy.id, now).exec(&tx).await?;
        tx.commit().await
    };
    if let Err(error) = run.await {
        // Lost the race: the other convert's board stands.
        if get_live_board(db, &legacy.id).await?.is_some() {
            return Ok(None);
        }
        return Err(error);
    }
    get_live_board(db, &legacy.id).await
}

/// Makes the board a workspace template or not (`updateBoard`'s `template`).
pub(crate) async fn set_template(
    db: &PgPool,
    board_id: &str,
    category: Option<&str>,
    now: PrimitiveDateTime,
) -> Result<(), DbErr> {
    use whiteboards::Column;
    whiteboards::Entity::update_many()
        .col_expr(Column::IsTemplate, Expr::value(category.is_some()))
        .col_expr(
            Column::TemplateCategory,
            Expr::value(category.map(str::to_owned)),
        )
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(board_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// Deletes an old WeldFlow whiteboard nobody converted (`trashLegacy`, a
/// soft delete as WeldFlow did); whether there was one.
pub(crate) async fn trash_legacy(
    db: &PgPool,
    id: &str,
    now: PrimitiveDateTime,
) -> Result<bool, DbErr> {
    let done = retire_legacy(id, now).exec(&orm(db)).await?;
    Ok(done.rows_affected > 0)
}

/// Display name and picture of a workspace member (`memberProfile`).
pub(crate) async fn member_profile(
    db: &PgPool,
    master: Option<&PgPool>,
    user_id: &str,
) -> Result<(Option<String>, Option<String>), DbErr> {
    use workspace_members::Column;
    let row: Option<(Option<String>, Option<String>)> = workspace_members::Entity::find()
        .select_only()
        .columns([Column::Name, Column::Email])
        .filter(Column::UserId.eq(user_id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let (name, email) = row.unwrap_or_default();
    let name = name
        .filter(|name| !name.is_empty())
        .or(email.filter(|email| !email.is_empty()));
    // The avatar is the account picture, not the member row's copy.
    let picture = weldsuite_db::load_account_picture(master, user_id).await;
    Ok((name, picture))
}

/// Whether a project exists and is not deleted (`projectExists`).
pub(crate) async fn project_exists(db: &PgPool, project_id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = projects::Entity::find()
        .select_only()
        .column(projects::Column::Id)
        .filter(projects::Column::Id.eq(project_id))
        .filter(projects::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

// ── versions ────────────────────────────────────────────────────────────────

/// A `board_versions` row in the JSON Drizzle gave it (`to_jsonb`): the
/// entity serializes as Drizzle did.
fn version_json(row: board_versions::Model) -> Result<Value, DbErr> {
    serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string()))
}

/// A `board_versions` row as Drizzle returns it.
pub(crate) async fn get_version(
    db: &PgPool,
    board_id: &str,
    version_id: &str,
) -> Result<Option<Value>, DbErr> {
    board_versions::Entity::find()
        .filter(board_versions::Column::BoardId.eq(board_id))
        .filter(board_versions::Column::Id.eq(version_id))
        .one(&orm(db))
        .await?
        .map(version_json)
        .transpose()
}

/// `toVersion(row)`.
pub(crate) fn to_version(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "boardId": row["boardId"],
        "revision": row["revision"],
        "name": row["name"],
        "size": row["size"],
        "createdAt": row["createdAt"],
        "createdById": row["createdById"],
    })
}

/// `versionEventData(row)`.
pub(crate) fn version_event_data(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "boardId": row["boardId"],
        "name": row["name"],
        "revision": row["revision"],
        "createdById": row["createdById"],
    })
}

/// A new version (`insertVersion`): `revision` and `size` as the room answered them.
pub(crate) struct NewVersion<'a> {
    pub(crate) id: &'a str,
    pub(crate) board_id: &'a str,
    pub(crate) revision: &'a Value,
    pub(crate) name: &'a str,
    pub(crate) snapshot_key: &'a str,
    pub(crate) size: &'a Value,
    pub(crate) created_by_id: &'a str,
}

/// `($n::jsonb #>> '{}')::int`: the room's JSON value as the text Postgres
/// casts to an integer (a string's own text, null as null), cast there, so
/// what it accepts and refuses is Postgres's.
fn json_int(value: &Value) -> Expr {
    let text = match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    };
    Func::cast_as(Expr::val(text), "int").into()
}

pub(crate) async fn insert_version(
    db: &PgPool,
    version: &NewVersion<'_>,
    now: PrimitiveDateTime,
) -> Result<Value, DbErr> {
    use board_versions::Column;
    let mut insert = Query::insert();
    insert
        .into_table(board_versions::Entity)
        .columns([
            Column::Id,
            Column::BoardId,
            Column::Revision,
            Column::Name,
            Column::SnapshotKey,
            Column::Size,
            Column::CreatedById,
            Column::CreatedAt,
        ])
        .values([
            Expr::val(version.id),
            Expr::val(version.board_id),
            json_int(version.revision),
            Expr::val(version.name),
            Expr::val(version.snapshot_key),
            json_int(version.size),
            Expr::val(version.created_by_id),
            Expr::val(now),
        ])
        .map_err(|error| DbErr::Custom(error.to_string()))?
        .returning_all();
    let row = orm(db)
        .query_one(&insert)
        .await?
        .ok_or(DbErr::RecordNotInserted)?;
    version_json(board_versions::Model::from_query_result(&row, "")?)
}

/// How many versions a board has.
pub(crate) async fn count_versions(db: &PgPool, board_id: &str) -> Result<i64, DbErr> {
    let count = board_versions::Entity::find()
        .filter(board_versions::Column::BoardId.eq(board_id))
        .count(&orm(db))
        .await?;
    Ok(count_of(count))
}

/// A page of a board's versions, newest first, after `after` (a keyset
/// cursor); one more than `limit`, to tell whether there are more.
pub(crate) async fn list_versions(
    db: &PgPool,
    board_id: &str,
    limit: i64,
    after: Option<&Value>,
) -> Result<Vec<Value>, DbErr> {
    use board_versions::Column;
    let mut query = board_versions::Entity::find().filter(Column::BoardId.eq(board_id));
    if let Some(after) = after.and_then(|row| row["id"].as_str()) {
        // `(select created_at from board_versions where id = $2)`.
        let cursor_at = || {
            Expr::from(
                Query::select()
                    .column(Column::CreatedAt)
                    .from(board_versions::Entity)
                    .and_where(Column::Id.eq(after))
                    .to_owned(),
            )
        };
        let created_at = Expr::col((board_versions::Entity, Column::CreatedAt));
        query = query.filter(
            Condition::any()
                .add(sea_orm::ExprTrait::lt(created_at.clone(), cursor_at()))
                .add(
                    Condition::all()
                        .add(sea_orm::ExprTrait::eq(created_at, cursor_at()))
                        .add(Column::Id.lt(after)),
                ),
        );
    }
    let rows = query
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(rows_of(limit.saturating_add(1)))
        .all(&orm(db))
        .await?;
    rows.into_iter().map(version_json).collect()
}

/// Renames a version; `None` when the board has no such version.
pub(crate) async fn rename_version(
    db: &PgPool,
    board_id: &str,
    version_id: &str,
    name: &str,
) -> Result<Option<Value>, DbErr> {
    let rows = board_versions::Entity::update_many()
        .col_expr(board_versions::Column::Name, Expr::value(name))
        .filter(board_versions::Column::BoardId.eq(board_id))
        .filter(board_versions::Column::Id.eq(version_id))
        .exec_with_returning(&orm(db))
        .await?;
    rows.into_iter().next().map(version_json).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_sit_next_to_the_checkpoint() {
        let key = snapshot_key_for("org_1", "brd_1");
        assert_eq!(key, "workspaces/org_1/boards/brd_1/board.json.gz");
        assert_eq!(
            thumbnail_key_for(&key),
            "workspaces/org_1/boards/brd_1/thumbnail.svg"
        );
        assert_eq!(
            version_key_for(&key, "brdv_1"),
            "workspaces/org_1/boards/brd_1/versions/brdv_1.json.gz"
        );
        assert_eq!(room_name("org_1", "brd_1"), "org_1:brd_1");
    }
}
