//! Folders (group forms on the home page) and themes (the workspace's looks,
//! one of them the default): `services/folders-themes.ts`.

use serde_json::{Value, json};
use sqlx::types::Json;
use sqlx::{Postgres, QueryBuilder};

use crate::common::{Ctx, FormsResult, all, iso, not_found, one, text};
use crate::model::parsed_theme;

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

fn folder_dto(row: &Value, form_count: i64) -> Value {
    json!({
        "id": row["id"],
        "name": row["name"],
        "position": row["position"],
        "formCount": form_count,
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    })
}

async fn form_count(ctx: &Ctx, folder_id: &str) -> FormsResult<i64> {
    Ok(
        sqlx::query_scalar("select count(*)::int8 from forms where folder_id = $1")
            .bind(folder_id)
            .fetch_one(&ctx.db)
            .await?,
    )
}

/// `listFolders(ctx)`: every folder with its form count.
pub(crate) async fn list_folders(ctx: &Ctx) -> FormsResult<Vec<Value>> {
    let rows = all(
        &ctx.db,
        sqlx::query_scalar(
            "select to_jsonb(f) from form_folders f order by position asc, name asc",
        ),
    )
    .await?;
    let counts: Vec<(Option<String>, i64)> =
        sqlx::query_as("select folder_id, count(*)::int8 from forms group by folder_id")
            .fetch_all(&ctx.db)
            .await?;
    Ok(rows
        .iter()
        .map(|row| {
            let count = counts
                .iter()
                .find(|(id, _)| id.as_deref() == Some(text(row, "id")))
                .map_or(0, |(_, n)| *n);
            folder_dto(row, count)
        })
        .collect())
}

/// `loadFolder(ctx, id)`: 404 `Folder not found`.
pub(crate) async fn load_folder(ctx: &Ctx, id: &str) -> FormsResult<Value> {
    one(
        &ctx.db,
        sqlx::query_scalar("select to_jsonb(f) from form_folders f where id = $1 limit 1").bind(id),
    )
    .await?
    .ok_or_else(|| not_found("Folder"))
}

/// `createFolder(ctx, input)`: at the end of the list.
pub(crate) async fn create_folder(ctx: &Ctx, name: &str) -> FormsResult<Value> {
    let last: Option<i32> = sqlx::query_scalar("select max(position) from form_folders")
        .fetch_one(&ctx.db)
        .await?;
    let id = weldsuite_kit::generate_id("ffd");
    sqlx::query("insert into form_folders (id, name, position) values ($1, $2, $3)")
        .bind(&id)
        .bind(name)
        .bind(last.unwrap_or(-1) + 1)
        .execute(&ctx.db)
        .await?;
    Ok(folder_dto(&load_folder(ctx, &id).await?, 0))
}

/// `updateFolder(ctx, folder, input)`: rename or reorder.
pub(crate) async fn update_folder(
    ctx: &Ctx,
    folder: &Value,
    name: Option<&str>,
    position: Option<i64>,
) -> FormsResult<Value> {
    let id = text(folder, "id").to_owned();
    let mut q = QueryBuilder::<Postgres>::new("update form_folders set updated_at = ");
    q.push_bind(iso(ctx.now_ms())).push("::timestamptz");
    if let Some(name) = name {
        q.push(", name = ").push_bind(name.to_owned());
    }
    if let Some(position) = position {
        q.push(", position = ")
            .push_bind(i32::try_from(position).unwrap_or(i32::MAX));
    }
    q.push(" where id = ").push_bind(id.clone());
    q.build().execute(&ctx.db).await?;
    let row = one(
        &ctx.db,
        sqlx::query_scalar("select to_jsonb(f) from form_folders f where id = $1 limit 1")
            .bind(&id),
    )
    .await?
    .unwrap_or_else(|| folder.clone());
    Ok(folder_dto(&row, form_count(ctx, &id).await?))
}

/// `deleteFolder(ctx, folder)`: forms in it move to "no folder".
pub(crate) async fn delete_folder(ctx: &Ctx, folder: &Value) -> FormsResult<()> {
    let id = text(folder, "id").to_owned();
    weldsuite_db::atomically(
        &ctx.db,
        [
            sqlx::query("update forms set folder_id = null where folder_id = $1").bind(id.clone()),
            sqlx::query("delete from form_folders where id = $1").bind(id.clone()),
        ],
    )
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

fn theme_dto(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "name": row["name"],
        "tokens": parsed_theme(&row["tokens"]),
        "isDefault": row["isDefault"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    })
}

/// `listThemes(ctx)`.
pub(crate) async fn list_themes(ctx: &Ctx) -> FormsResult<Vec<Value>> {
    let rows = all(
        &ctx.db,
        sqlx::query_scalar("select to_jsonb(t) from form_themes t order by name asc, id asc"),
    )
    .await?;
    Ok(rows.iter().map(theme_dto).collect())
}

/// `loadTheme(ctx, id)`: 404 `Theme not found`.
pub(crate) async fn load_theme(ctx: &Ctx, id: &str) -> FormsResult<Value> {
    one(
        &ctx.db,
        sqlx::query_scalar("select to_jsonb(t) from form_themes t where id = $1 limit 1").bind(id),
    )
    .await?
    .ok_or_else(|| not_found("Theme"))
}

/// `createTheme(ctx, userId, input)`: making it the default clears the flag
/// elsewhere in the same step.
pub(crate) async fn create_theme(
    ctx: &Ctx,
    user_id: &str,
    name: &str,
    tokens: &Value,
    is_default: Option<bool>,
) -> FormsResult<Value> {
    let id = weldsuite_kit::generate_id("fth");
    let mut statements = Vec::new();
    if is_default == Some(true) {
        statements.push(sqlx::query(
            "update form_themes set is_default = false where is_default = true",
        ));
    }
    statements.push(
        sqlx::query(
            "insert into form_themes (id, name, tokens, is_default, created_by_user_id) values ($1, $2, $3, $4, $5)",
        )
        .bind(id.clone())
        .bind(name.to_owned())
        .bind(Json(tokens.clone()))
        .bind(is_default.unwrap_or(false))
        .bind(user_id.to_owned()),
    );
    weldsuite_db::atomically(&ctx.db, statements).await?;
    Ok(theme_dto(&load_theme(ctx, &id).await?))
}

/// `updateTheme(ctx, theme, input)`.
pub(crate) async fn update_theme(
    ctx: &Ctx,
    theme: &Value,
    name: Option<&str>,
    tokens: Option<&Value>,
    is_default: Option<bool>,
) -> FormsResult<Value> {
    let id = text(theme, "id").to_owned();
    let mut update = QueryBuilder::<Postgres>::new("update form_themes set updated_at = ");
    update.push_bind(iso(ctx.now_ms())).push("::timestamptz");
    if let Some(name) = name {
        update.push(", name = ").push_bind(name.to_owned());
    }
    if let Some(tokens) = tokens {
        update.push(", tokens = ").push_bind(Json(tokens.clone()));
    }
    if let Some(is_default) = is_default {
        update.push(", is_default = ").push_bind(is_default);
    }
    update.push(" where id = ").push_bind(id.clone());
    let mut tx = ctx.db.begin().await?;
    if is_default == Some(true) {
        sqlx::query("update form_themes set is_default = false where is_default = true")
            .execute(&mut *tx)
            .await?;
    }
    update.build().execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(theme_dto(&load_theme(ctx, &id).await?))
}

/// `deleteTheme(ctx, theme)`: forms using it fall back to the default;
/// published versions keep their snapshot.
pub(crate) async fn delete_theme(ctx: &Ctx, theme: &Value) -> FormsResult<()> {
    let id = text(theme, "id").to_owned();
    weldsuite_db::atomically(
        &ctx.db,
        [
            sqlx::query("update forms set theme_id = null where theme_id = $1").bind(id.clone()),
            sqlx::query(
                "update form_settings set default_theme_id = null where default_theme_id = $1",
            )
            .bind(id.clone()),
            sqlx::query("delete from form_themes where id = $1").bind(id.clone()),
        ],
    )
    .await?;
    Ok(())
}
