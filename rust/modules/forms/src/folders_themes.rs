//! Folders (group forms on the home page) and themes (the workspace's looks,
//! one of them the default): `services/folders-themes.ts`.

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, UpdateMany,
};
use serde_json::{Value, json};
use weldsuite_db::{OrmConn, orm};
use weldsuite_schema::tenant::{form_folders, form_settings, form_themes, forms};

use crate::common::{Ctx, Fail, FormsResult, instant, not_found, row_json, rows_json, text};
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
    let count = forms::Entity::find()
        .filter(forms::Column::FolderId.eq(folder_id))
        .count(&orm(&ctx.db))
        .await?;
    Ok(i64::try_from(count).unwrap_or(i64::MAX))
}

/// `listFolders(ctx)`: every folder with its form count.
pub(crate) async fn list_folders(ctx: &Ctx) -> FormsResult<Vec<Value>> {
    let db = orm(&ctx.db);
    let rows = rows_json(
        form_folders::Entity::find()
            .order_by_asc(form_folders::Column::Position)
            .order_by_asc(form_folders::Column::Name)
            .all(&db)
            .await?,
    )?;
    let counts: Vec<(Option<String>, i64)> = forms::Entity::find()
        .select_only()
        .column(forms::Column::FolderId)
        .column_as(forms::Column::Id.count(), "count")
        .group_by(forms::Column::FolderId)
        .into_tuple()
        .all(&db)
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

/// A folder row by id, as Drizzle returns it.
async fn folder_row(ctx: &Ctx, id: &str) -> FormsResult<Option<Value>> {
    form_folders::Entity::find_by_id(id)
        .one(&orm(&ctx.db))
        .await?
        .map(row_json)
        .transpose()
}

/// `loadFolder(ctx, id)`: 404 `Folder not found`.
pub(crate) async fn load_folder(ctx: &Ctx, id: &str) -> FormsResult<Value> {
    folder_row(ctx, id)
        .await?
        .ok_or_else(|| not_found("Folder"))
}

/// `createFolder(ctx, input)`: at the end of the list.
pub(crate) async fn create_folder(ctx: &Ctx, name: &str) -> FormsResult<Value> {
    let db = orm(&ctx.db);
    let last: Option<i32> = form_folders::Entity::find()
        .select_only()
        .column_as(form_folders::Column::Position.max(), "max")
        .into_tuple::<Option<i32>>()
        .one(&db)
        .await?
        .flatten();
    let id = weldsuite_kit::generate_id("ffd");
    form_folders::Entity::insert(form_folders::ActiveModel {
        id: Set(id.clone()),
        name: Set(name.to_owned()),
        position: Set(last.unwrap_or(-1) + 1),
        ..Default::default()
    })
    .exec_without_returning(&db)
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
    let mut update = form_folders::Entity::update_many().col_expr(
        form_folders::Column::UpdatedAt,
        Expr::value(instant(ctx.now_ms())),
    );
    if let Some(name) = name {
        update = update.col_expr(form_folders::Column::Name, Expr::value(name));
    }
    if let Some(position) = position {
        update = update.col_expr(
            form_folders::Column::Position,
            Expr::value(i32::try_from(position).unwrap_or(i32::MAX)),
        );
    }
    update
        .filter(form_folders::Column::Id.eq(id.as_str()))
        .exec(&orm(&ctx.db))
        .await?;
    let row = folder_row(ctx, &id)
        .await?
        .unwrap_or_else(|| folder.clone());
    Ok(folder_dto(&row, form_count(ctx, &id).await?))
}

/// `deleteFolder(ctx, folder)`: forms in it move to "no folder".
pub(crate) async fn delete_folder(ctx: &Ctx, folder: &Value) -> FormsResult<()> {
    let id = text(folder, "id").to_owned();
    weldsuite_db::atomically_with(&ctx.db, move |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            forms::Entity::update_many()
                .col_expr(forms::Column::FolderId, Expr::value(Option::<String>::None))
                .filter(forms::Column::FolderId.eq(id.as_str()))
                .exec(&tx)
                .await?;
            form_folders::Entity::delete_by_id(id.as_str())
                .exec(&tx)
                .await?;
            Ok::<_, Fail>(())
        })
    })
    .await
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
    let rows = rows_json(
        form_themes::Entity::find()
            .order_by_asc(form_themes::Column::Name)
            .order_by_asc(form_themes::Column::Id)
            .all(&orm(&ctx.db))
            .await?,
    )?;
    Ok(rows.iter().map(theme_dto).collect())
}

/// `loadTheme(ctx, id)`: 404 `Theme not found`.
pub(crate) async fn load_theme(ctx: &Ctx, id: &str) -> FormsResult<Value> {
    form_themes::Entity::find_by_id(id)
        .one(&orm(&ctx.db))
        .await?
        .map(row_json)
        .transpose()?
        .ok_or_else(|| not_found("Theme"))
}

/// `update(formThemes).set({ isDefault: false }).where(eq(isDefault, true))`.
fn clear_default() -> UpdateMany<form_themes::Entity> {
    form_themes::Entity::update_many()
        .col_expr(form_themes::Column::IsDefault, Expr::value(false))
        .filter(form_themes::Column::IsDefault.eq(true))
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
    let clear = (is_default == Some(true)).then(clear_default);
    let insert = form_themes::Entity::insert(form_themes::ActiveModel {
        id: Set(id.clone()),
        name: Set(name.to_owned()),
        tokens: Set(tokens.clone()),
        is_default: Set(is_default.unwrap_or(false)),
        created_by_user_id: Set(user_id.to_owned()),
        ..Default::default()
    });
    weldsuite_db::atomically_with(&ctx.db, move |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            if let Some(clear) = clear {
                clear.exec(&tx).await?;
            }
            insert.exec_without_returning(&tx).await?;
            Ok::<_, Fail>(())
        })
    })
    .await?;
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
    let mut update = form_themes::Entity::update_many().col_expr(
        form_themes::Column::UpdatedAt,
        Expr::value(instant(ctx.now_ms())),
    );
    if let Some(name) = name {
        update = update.col_expr(form_themes::Column::Name, Expr::value(name));
    }
    if let Some(tokens) = tokens {
        update = update.col_expr(form_themes::Column::Tokens, Expr::value(tokens.clone()));
    }
    if let Some(is_default) = is_default {
        update = update.col_expr(form_themes::Column::IsDefault, Expr::value(is_default));
    }
    let update = update.filter(form_themes::Column::Id.eq(id.as_str()));
    let clear = (is_default == Some(true)).then(clear_default);
    weldsuite_db::atomically_with(&ctx.db, move |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            if let Some(clear) = clear {
                clear.exec(&tx).await?;
            }
            update.exec(&tx).await?;
            Ok::<_, Fail>(())
        })
    })
    .await?;
    Ok(theme_dto(&load_theme(ctx, &id).await?))
}

/// `deleteTheme(ctx, theme)`: forms using it fall back to the default;
/// published versions keep their snapshot.
pub(crate) async fn delete_theme(ctx: &Ctx, theme: &Value) -> FormsResult<()> {
    let id = text(theme, "id").to_owned();
    weldsuite_db::atomically_with(&ctx.db, move |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            forms::Entity::update_many()
                .col_expr(forms::Column::ThemeId, Expr::value(Option::<String>::None))
                .filter(forms::Column::ThemeId.eq(id.as_str()))
                .exec(&tx)
                .await?;
            form_settings::Entity::update_many()
                .col_expr(
                    form_settings::Column::DefaultThemeId,
                    Expr::value(Option::<String>::None),
                )
                .filter(form_settings::Column::DefaultThemeId.eq(id.as_str()))
                .exec(&tx)
                .await?;
            form_themes::Entity::delete_by_id(id.as_str())
                .exec(&tx)
                .await?;
            Ok::<_, Fail>(())
        })
    })
    .await
}
