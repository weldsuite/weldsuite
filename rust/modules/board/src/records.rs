//! Board records (`services/boards.ts`) and versions (`services/versions.ts`):
//! a drive `files` row paired with a `whiteboards` row, and the old WeldFlow
//! whiteboards (`project_whiteboards`) listed beside a project's boards until
//! someone opens one.

use serde_json::{Value, json};
use weldsuite_core_domain::drive_access::{
    DriveFileRef, DriveGeneralAccess, DriveRole, VisibleFiles,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::generate_id;

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

fn text(row: &Value, key: &str) -> Option<String> {
    row[key].as_str().map(str::to_owned)
}

fn stamp(row: &Value, key: &str) -> String {
    row[key].as_str().unwrap_or_default().to_owned()
}

impl BoardRecord {
    /// A `whiteboards` ⨝ `files` row (`toRecord`).
    fn live(row: Value) -> Self {
        let row = js_row(row);
        let file_id = text(&row, "fileId").unwrap_or_default();
        let board_updated = stamp(&row, "boardUpdatedAt");
        let file_updated = stamp(&row, "fileUpdatedAt");
        let project_id = (row["entityType"].as_str() == Some(PROJECT_ENTITY))
            .then(|| text(&row, "entityId"))
            .flatten();
        let template_category = (row["isTemplate"].as_bool() == Some(true))
            .then(|| text(&row, "templateCategory").unwrap_or_else(|| "other".to_owned()));
        Self {
            id: text(&row, "id").unwrap_or_default(),
            name: text(&row, "name").unwrap_or_default(),
            folder_id: text(&row, "folderId"),
            created_at: stamp(&row, "createdAt"),
            // ISO strings of one shape compare as the instants they are.
            updated_at: if board_updated > file_updated {
                board_updated
            } else {
                file_updated
            },
            created_by_id: text(&row, "createdById"),
            updated_by_id: text(&row, "updatedById"),
            revision: row["revision"].as_i64().unwrap_or(0),
            snapshot_key: text(&row, "snapshotKey"),
            project_id,
            template_category,
            legacy: false,
            file: Some(DriveFileRef {
                id: file_id.clone(),
                uploaded_by_id: text(&row, "createdById"),
                folder_id: text(&row, "folderId"),
                general_access: DriveGeneralAccess::parse(
                    row["generalAccess"].as_str().unwrap_or_default(),
                ),
                entity_type: text(&row, "entityType"),
            }),
            file_id: Some(file_id),
        }
    }

    /// A `project_whiteboards` row (`legacyRecord`).
    fn legacy(row: Value) -> Self {
        let row = js_row(row);
        Self {
            id: text(&row, "id").unwrap_or_default(),
            file_id: None,
            name: text(&row, "name").unwrap_or_default(),
            folder_id: None,
            created_at: stamp(&row, "createdAt"),
            updated_at: stamp(&row, "updatedAt"),
            created_by_id: None,
            updated_by_id: text(&row, "lastEditedBy"),
            revision: 0,
            snapshot_key: None,
            project_id: text(&row, "projectId"),
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

/// The columns of a live [`BoardRecord`], on `whiteboards w` joined with `files f`.
macro_rules! board_columns {
    () => {
        "w.id, w.file_id, f.file_name as name, f.folder_id, w.created_at,
         w.updated_at as board_updated_at, f.updated_at as file_updated_at,
         f.uploaded_by_id as created_by_id, w.updated_by_id, w.revision, w.snapshot_key,
         w.is_template, w.template_category, f.general_access, f.entity_type, f.entity_id"
    };
}

/// The columns of a legacy [`BoardRecord`], on `project_whiteboards p`.
macro_rules! legacy_columns {
    () => {
        "p.id, p.name, p.project_id, p.created_at, p.updated_at, p.last_edited_by, p.version"
    };
}

/// An old WeldFlow whiteboard not converted yet (converting keeps the id).
macro_rules! not_converted {
    () => {
        "not exists (select 1 from whiteboards w2 where w2.id = p.id)"
    };
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

/// `visibleFilesCondition`, on `$1` (no condition) … `$5` (open folders).
macro_rules! visible {
    () => {
        "($1::bool or f.entity_type is not null
          or ($2::text is not null and f.uploaded_by_id = $2)
          or f.id = any($3::text[]) or f.folder_id = any($4::text[])
          or (f.general_access <> 'restricted'
              and (f.folder_id is null or f.folder_id = any($5::text[]))))"
    };
}

/// `listBoards`' filter: not trashed, `$6` the search, `$7` the scope
/// (`drive`, `templates`, `project`, `projects`), `$8` the project and `$9`
/// whether `$10` (project ids) applies, plus the drive's visibility.
macro_rules! listed {
    () => {
        concat!(
            "f.deleted_at is null
              and (case $7::text
                     when 'drive' then f.entity_type is null
                     when 'templates' then w.is_template = true and f.entity_type is null
                     when 'project' then f.entity_type = 'project' and f.entity_id = $8
                     else f.entity_type = 'project'
                          and (case when $9::bool then f.entity_id = any($10::text[])
                                    else exists (select 1 from projects pr
                                                  where pr.id = f.entity_id and pr.deleted_at is null) end)
                   end)
              and ",
            visible!(),
            " and ($6::text is null or f.file_name ilike $6)"
        )
    };
}

/// `$1` the search, `$2` the scope (`project` or `projects`), `$3` the
/// project, `$4` whether `$5` (project ids) applies.
macro_rules! legacy_listed {
    () => {
        concat!(
            "p.deleted_at is null and ",
            not_converted!(),
            " and (case when $2::text = 'project' then p.project_id = $3
                       when $4::bool then p.project_id = any($5::text[])
                       else exists (select 1 from projects pr
                                     where pr.id = p.project_id and pr.deleted_at is null) end)
              and ($1::text is null or p.name ilike $1)"
        )
    };
}

impl BoardScope {
    fn kind(&self) -> &'static str {
        match self {
            Self::Drive => "drive",
            Self::Templates => "templates",
            Self::Project(_) => "project",
            Self::Projects(_) => "projects",
        }
    }

    fn project(&self) -> Option<&str> {
        match self {
            Self::Project(id) => Some(id),
            _ => None,
        }
    }

    /// `(whether the ids apply, the ids)`; `inArray(column, ids.length ? ids : [''])`.
    fn ids(&self) -> (bool, Vec<String>) {
        match self {
            Self::Projects(Some(ids)) if ids.is_empty() => (true, vec![String::new()]),
            Self::Projects(Some(ids)) => (true, ids.clone()),
            _ => (false, Vec::new()),
        }
    }
}

/// Boards not in the trash, most recently changed first (`listBoards`); a
/// project scope merges in its old WeldFlow whiteboards by last change.
pub(crate) async fn list_boards(
    db: &PgPool,
    params: &ListBoards,
) -> Result<(Vec<BoardRecord>, i64), sqlx::Error> {
    let visible = params.visible.clone().unwrap_or_default();
    let open = params.visible.is_none();
    let (has_ids, ids) = params.scope.ids();
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
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select to_jsonb(r) from (select ",
        board_columns!(),
        " from whiteboards w join files f on f.id = w.file_id where ",
        listed!(),
        " order by greatest(w.updated_at, f.updated_at) desc, w.id desc
          limit $11 offset $12) r
         order by greatest(r.board_updated_at, r.file_updated_at) desc, r.id desc"
    ))
    .bind(open)
    .bind(&visible.user_id)
    .bind(&visible.file_share_ids)
    .bind(&visible.granted_folder_ids)
    .bind(&visible.open_folder_ids)
    .bind(&params.search)
    .bind(params.scope.kind())
    .bind(params.scope.project())
    .bind(has_ids)
    .bind(&ids)
    .bind(limit)
    .bind(offset)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*)::bigint from whiteboards w join files f on f.id = w.file_id where ",
        listed!()
    ))
    .bind(open)
    .bind(&visible.user_id)
    .bind(&visible.file_share_ids)
    .bind(&visible.granted_folder_ids)
    .bind(&visible.open_folder_ids)
    .bind(&params.search)
    .bind(params.scope.kind())
    .bind(params.scope.project())
    .bind(has_ids)
    .bind(&ids)
    .fetch_one(db)
    .await?;
    let boards = rows.into_iter().map(BoardRecord::live);
    if !projects {
        return Ok((boards.collect(), total));
    }

    // Project boards and not-yet-converted whiteboards, merged by last change.
    let legacy: Vec<Value> = sqlx::query_scalar(concat!(
        "select to_jsonb(r) from (select ",
        legacy_columns!(),
        " from project_whiteboards p where ",
        legacy_listed!(),
        " order by p.updated_at desc, p.id desc limit $6) r
         order by r.updated_at desc, r.id desc"
    ))
    .bind(&params.search)
    .bind(params.scope.kind())
    .bind(params.scope.project())
    .bind(has_ids)
    .bind(&ids)
    .bind(limit)
    .fetch_all(db)
    .await?;
    let legacy_total: i64 = sqlx::query_scalar(concat!(
        "select count(*)::bigint from project_whiteboards p where ",
        legacy_listed!()
    ))
    .bind(&params.search)
    .bind(params.scope.kind())
    .bind(params.scope.project())
    .bind(has_ids)
    .bind(&ids)
    .fetch_one(db)
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
    Ok((page, (total + legacy_total).min(MAX_PROJECT_WINDOW)))
}

/// A board not in the trash, or an old WeldFlow whiteboard not converted
/// yet; `None` when neither (`getBoard`).
pub(crate) async fn get_board(db: &PgPool, id: &str) -> Result<Option<BoardRecord>, sqlx::Error> {
    if let Some(board) = get_live_board(db, id).await? {
        return Ok(Some(board));
    }
    let legacy: Option<Value> = sqlx::query_scalar(concat!(
        "select to_jsonb(r) from (select ",
        legacy_columns!(),
        " from project_whiteboards p where p.id = $1 and p.deleted_at is null and ",
        not_converted!(),
        " limit 1) r"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(legacy.map(BoardRecord::legacy))
}

/// A converted board (never an old whiteboard), or `None` (`getLiveBoard`).
pub(crate) async fn get_live_board(
    db: &PgPool,
    id: &str,
) -> Result<Option<BoardRecord>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select to_jsonb(r) from (select ",
        board_columns!(),
        " from whiteboards w join files f on f.id = w.file_id
          where w.id = $1 and f.deleted_at is null limit 1) r"
    ))
    .bind(id)
    .fetch_optional(db)
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
    now: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into whiteboards (id, file_id, snapshot_key, revision, snapshot_revision,
                                  is_template, template_category, updated_by_id,
                                  created_at, updated_at)
         values ($1, $2, $3, 0, 0, $4, $5, $6, $7::timestamp, $7::timestamp)",
    )
    .bind(row.id)
    .bind(row.file_id)
    .bind(row.snapshot_key)
    .bind(row.template_category.is_some())
    .bind(row.template_category)
    .bind(row.user_id)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

/// An old WeldFlow whiteboard's `elements` (as the JSON text Postgres keeps)
/// and who last changed it, for the converter (`legacyElements`).
pub(crate) async fn legacy_elements(
    db: &PgPool,
    id: &str,
) -> Result<Option<(Option<String>, Option<String>)>, sqlx::Error> {
    sqlx::query_as(
        "select elements::text, last_edited_by from project_whiteboards
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
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

/// Makes an old WeldFlow whiteboard a board, in place (`convertLegacy`): the
/// drive file, the board row and the old row's soft delete commit as one
/// unit. `None` when someone else converted it first (the board row's
/// insert then fails, and the rest with it).
pub(crate) async fn convert_legacy(
    db: &PgPool,
    params: &ConvertLegacy<'_>,
    now: &str,
) -> Result<Option<BoardRecord>, sqlx::Error> {
    let legacy = params.legacy;
    let file_id = generate_id("fil");
    let editor = legacy.updated_by_id.as_deref().unwrap_or(params.user_id);
    let metadata = json!({
        "weldBoardId": legacy.id,
        "convertedFrom": { "table": "project_whiteboards", "at": now },
    });
    let run = async {
        let mut tx = db.begin().await?;
        sqlx::query(
            "insert into files (id, file_name, original_name, mime_type, file_size, file_type,
                                storage_path, file_key, bucket, folder_id, uploaded_by_id,
                                is_public, entity_type, entity_id, metadata, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $7, 'private', null, $8, false, 'project', $9,
                     $10, $11::timestamp, $12::timestamp)",
        )
        .bind(&file_id)
        .bind(params.file_name)
        .bind(&legacy.name)
        .bind(WELDBOARD_MIME_TYPE)
        .bind(params.snapshot_size)
        .bind(BOARD_FILE_TYPE)
        .bind(params.snapshot_key)
        .bind(editor)
        .bind(&legacy.project_id)
        .bind(&metadata)
        .bind(&legacy.created_at)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "insert into whiteboards (id, file_id, snapshot_key, revision, snapshot_revision,
                                      is_template, template_category, updated_by_id,
                                      created_at, updated_at)
             values ($1, $2, $3, 0, 0, false, null, $4, $5::timestamp, $6::timestamp)",
        )
        .bind(&legacy.id)
        .bind(&file_id)
        .bind(params.snapshot_key)
        .bind(editor)
        .bind(&legacy.created_at)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "update project_whiteboards set deleted_at = $2::timestamp, updated_at = $2::timestamp
              where id = $1 and deleted_at is null",
        )
        .bind(&legacy.id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
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
    now: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update whiteboards set is_template = $2, template_category = $3,
                updated_at = $4::timestamp
          where id = $1",
    )
    .bind(board_id)
    .bind(category.is_some())
    .bind(category)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

/// Deletes an old WeldFlow whiteboard nobody converted (`trashLegacy`, a
/// soft delete as WeldFlow did); whether there was one.
pub(crate) async fn trash_legacy(db: &PgPool, id: &str, now: &str) -> Result<bool, sqlx::Error> {
    let done = sqlx::query(
        "update project_whiteboards set deleted_at = $2::timestamp, updated_at = $2::timestamp
          where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(now)
    .execute(db)
    .await?;
    Ok(done.rows_affected() > 0)
}

/// Display name and picture of a workspace member (`memberProfile`).
pub(crate) async fn member_profile(
    db: &PgPool,
    user_id: &str,
) -> Result<(Option<String>, Option<String>), sqlx::Error> {
    let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "select name, email, picture from workspace_members
         where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let (name, email, picture) = row.unwrap_or_default();
    let name = name
        .filter(|name| !name.is_empty())
        .or(email.filter(|email| !email.is_empty()));
    Ok((name, picture))
}

/// Whether a project exists and is not deleted (`projectExists`).
pub(crate) async fn project_exists(db: &PgPool, project_id: &str) -> Result<bool, sqlx::Error> {
    let found: Option<String> =
        sqlx::query_scalar("select id from projects where id = $1 and deleted_at is null limit 1")
            .bind(project_id)
            .fetch_optional(db)
            .await?;
    Ok(found.is_some())
}

// ── versions ────────────────────────────────────────────────────────────────

/// A `board_versions` row as Drizzle returns it.
pub(crate) async fn get_version(
    db: &PgPool,
    board_id: &str,
    version_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(v) from board_versions v where board_id = $1 and id = $2 limit 1",
    )
    .bind(board_id)
    .bind(version_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
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

pub(crate) async fn insert_version(
    db: &PgPool,
    version: &NewVersion<'_>,
    now: &str,
) -> Result<Value, sqlx::Error> {
    let row: Value = sqlx::query_scalar(
        "insert into board_versions (id, board_id, revision, name, snapshot_key, size,
                                     created_by_id, created_at)
         values ($1, $2, ($3::jsonb #>> '{}')::int, $4, $5, ($6::jsonb #>> '{}')::int, $7,
                 $8::timestamp)
         returning to_jsonb(board_versions)",
    )
    .bind(version.id)
    .bind(version.board_id)
    .bind(version.revision)
    .bind(version.name)
    .bind(version.snapshot_key)
    .bind(version.size)
    .bind(version.created_by_id)
    .bind(now)
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

/// How many versions a board has.
pub(crate) async fn count_versions(db: &PgPool, board_id: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("select count(*)::bigint from board_versions where board_id = $1")
        .bind(board_id)
        .fetch_one(db)
        .await
}

/// A page of a board's versions, newest first, after `after` (a keyset
/// cursor); one more than `limit`, to tell whether there are more.
pub(crate) async fn list_versions(
    db: &PgPool,
    board_id: &str,
    limit: i64,
    after: Option<&Value>,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(v) from board_versions v
          where v.board_id = $1
            and ($2::text is null
                 or v.created_at < (select created_at from board_versions where id = $2)
                 or (v.created_at = (select created_at from board_versions where id = $2)
                     and v.id < $2))
          order by v.created_at desc, v.id desc
          limit $3",
    )
    .bind(board_id)
    .bind(after.and_then(|row| row["id"].as_str()))
    .bind(limit.saturating_add(1))
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// Renames a version; `None` when the board has no such version.
pub(crate) async fn rename_version(
    db: &PgPool,
    board_id: &str,
    version_id: &str,
    name: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "update board_versions set name = $3 where board_id = $1 and id = $2
         returning to_jsonb(board_versions)",
    )
    .bind(board_id)
    .bind(version_id)
    .bind(name)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
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
