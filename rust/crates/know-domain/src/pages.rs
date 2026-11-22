//! WeldKnow pages created from outside WeldKnow (`packages/domains/know/src/pages.ts`):
//! another module (WeldFlow publishing a project's lessons learned) writes a
//! page into a teamspace the caller may write in. The teamspace rules are
//! [`crate::access`] (a space the caller cannot see is a 404, one they can read
//! but not write a 403); this adds the page itself: its position among its
//! siblings, its block content and the plain-text copy search reads.
//!
//! The caller publishes the `knowledge_page` `created` entity event, as
//! know-api's own route does.

use sea_orm::{ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde_json::Value;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::{generate_id, validation::js_trim};
use weldsuite_schema::tenant::knowledge_pages as pages;

use crate::access::{assert_can_write, require_space};
use crate::{KnowError, row};

/// Recursively flatten `BlockNote` blocks into the plain text search matches on
/// (`blocksToText`).
pub fn blocks_to_text(blocks: &Value) -> String {
    let mut parts: Vec<&str> = Vec::new();
    walk(blocks, &mut parts);
    collapse_whitespace(&parts.join(" "))
}

fn walk<'a>(node: &'a Value, parts: &mut Vec<&'a str>) {
    match node {
        Value::Array(items) => items.iter().for_each(|item| walk(item, parts)),
        Value::Object(object) => {
            if let Some(Value::String(text)) = object.get("text") {
                parts.push(text);
            }
            for key in ["content", "children"] {
                if let Some(child) = object.get(key) {
                    walk(child, parts);
                }
            }
        }
        _ => {}
    }
}

/// `text.replace(/\s+/g, ' ').trim()`, with JavaScript's idea of whitespace.
fn collapse_whitespace(text: &str) -> String {
    let is_space = |c: char| c.is_whitespace() || c == '\u{feff}';
    let mut out = String::with_capacity(text.len());
    let mut pending_gap = false;
    for c in text.chars() {
        if is_space(c) {
            pending_gap = true;
        } else {
            if pending_gap {
                out.push(' ');
                pending_gap = false;
            }
            out.push(c);
        }
    }
    if pending_gap {
        out.push(' ');
    }
    js_trim(&out).to_owned()
}

/// The position that appends a page to the end of its siblings (a top-level
/// page when there is no parent): `nextPagePosition`.
pub async fn next_page_position(
    db: &PgPool,
    space_id: &str,
    parent_id: Option<&str>,
) -> Result<i64, sea_orm::DbErr> {
    let parent = match parent_id {
        Some(parent_id) => pages::Column::ParentId.eq(parent_id),
        None => pages::Column::ParentId.is_null(),
    };
    let max: Option<Option<i32>> = pages::Entity::find()
        .select_only()
        .column_as(pages::Column::Position.max(), "max")
        .filter(pages::Column::SpaceId.eq(space_id))
        .filter(parent)
        .filter(pages::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(max.flatten().map_or(-1, i64::from) + 1)
}

/// A position as the `integer` column holds it.
pub fn position(value: i64) -> i32 {
    i32::try_from(value).unwrap_or(if value < 0 { i32::MIN } else { i32::MAX })
}

/// What a page is created from.
pub struct CreatePageInput<'a> {
    pub space_id: &'a str,
    pub title: &'a str,
    pub content_json: &'a [Value],
    /// `knowledge:manage`: makes every teamspace visible and manageable (not
    /// readable: that takes joining it).
    pub can_manage_all: bool,
}

/// Create a top-level page in a teamspace the caller may write in
/// (`createKnowledgePage`): the page row as Drizzle reads it. Answers a
/// [`KnowError`] 404 when the space does not exist for the caller and a 403
/// when they can see it but are not an editor.
pub async fn create_knowledge_page(
    db: &PgPool,
    user_id: &str,
    input: &CreatePageInput<'_>,
) -> Result<Value, KnowError> {
    let access = require_space(db, Some(user_id), input.space_id, input.can_manage_all).await?;
    assert_can_write(&access)?;

    let id = generate_id("kpag");
    let position = next_page_position(db, input.space_id, None).await?;
    let title = if input.title.is_empty() {
        "Untitled"
    } else {
        input.title
    };
    let content = Value::Array(input.content_json.to_vec());
    let now = utc_now();
    let page = pages::Entity::insert(pages::ActiveModel {
        id: Set(id),
        space_id: Set(input.space_id.to_owned()),
        parent_id: Set(None),
        position: Set(self::position(position)),
        title: Set(title.to_owned()),
        icon: Set(None),
        cover_image: Set(None),
        content_text: Set(Some(blocks_to_text(&content))),
        content_json: Set(Some(content)),
        created_by: Set(Some(user_id.to_owned())),
        last_edited_by: Set(Some(user_id.to_owned())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    Ok(row(page))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn blocks_flatten_into_one_line_of_text() {
        let blocks = json!([
            { "type": "heading", "content": [{ "type": "text", "text": "Went well", "styles": {} }], "children": [] },
            { "type": "bulletListItem", "content": [{ "type": "text", "text": "Weekly   reports (2 votes)", "styles": {} }],
              "children": [{ "type": "paragraph", "content": [{ "text": "nested\ttext" }], "children": [] }] },
        ]);
        assert_eq!(
            blocks_to_text(&blocks),
            "Went well Weekly reports (2 votes) nested text"
        );
        assert_eq!(blocks_to_text(&json!([])), "");
        assert_eq!(blocks_to_text(&json!("text")), "");
        assert_eq!(blocks_to_text(&json!({ "text": "  a \n b  " })), "a b");
    }
}
