//! Where a request comes from (`packages/domains/sign/src/sources.ts`): a
//! WeldDrive file, or a CRM company, person or opportunity. Drive access goes
//! through the shared rules (`weldsuite_core_domain::drive_access`); CRM rows
//! are read from the tenant schema.

use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::{
    COMPANIES_READ, FILES_READ, OPPORTUNITIES_READ, PEOPLE_READ,
};
use weldsuite_core_domain::drive_access::{
    DriveFile, can_edit, container_role, file_role, get_file, load_drive_access_for_user,
};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Field, Issues, Presence};

use crate::{Caller, SignError, SignResult};

const SOURCE_TYPES: [&str; 4] = ["file", "company", "person", "opportunity"];

/// A source as sent (`signSourceSchema`).
#[derive(Debug, Clone)]
pub(crate) struct SourceInput {
    pub(crate) entity_type: String,
    pub(crate) entity_id: String,
}

/// `source: signSourceSchema.nullish()`.
pub(crate) fn read_source(issues: &mut Issues, fields: &Map<String, Value>) -> Field<SourceInput> {
    match issues.nested(fields, "source", Presence::Nullish, |issues, source| {
        let entity_type = issues.choice(source, "entityType", Presence::Required, &SOURCE_TYPES);
        let entity_id = issues.text(source, "entityId", Presence::Required, Some(1), Some(255));
        (entity_type.into_option(), entity_id.into_option())
    }) {
        Field::Set((Some(entity_type), Some(entity_id))) => Field::Set(SourceInput {
            entity_type,
            entity_id,
        }),
        Field::Null => Field::Null,
        _ => Field::Absent,
    }
}

/// The permission that lets a member read each kind of source
/// (`SOURCE_READ_PERMISSION`).
pub(crate) fn read_permission(entity_type: &str) -> Option<&'static str> {
    match entity_type {
        "file" => Some(FILES_READ),
        "company" => Some(COMPANIES_READ),
        "person" => Some(PEOPLE_READ),
        "opportunity" => Some(OPPORTUNITIES_READ),
        _ => None,
    }
}

/// A live WeldDrive file the member may open (`visibleDriveFile`).
pub(crate) async fn visible_drive_file(
    db: &PgPool,
    user_id: &str,
    file_id: &str,
) -> SignResult<Option<DriveFile>> {
    let Some(file) = get_file(db, file_id).await? else {
        return Ok(None);
    };
    let access = load_drive_access_for_user(db, Some(user_id)).await?;
    Ok(file_role(&access, &file.r#ref).is_some().then_some(file))
}

/// Whether the member may add files to this live folder (`canFileInto`).
pub(crate) async fn can_file_into(db: &PgPool, user_id: &str, folder_id: &str) -> SignResult<bool> {
    let folder: Option<String> =
        sqlx::query_scalar("select id from folders where id = $1 and deleted_at is null limit 1")
            .bind(folder_id)
            .fetch_optional(db)
            .await?;
    if folder.is_none() {
        return Ok(false);
    }
    let access = load_drive_access_for_user(db, Some(user_id)).await?;
    Ok(can_edit(container_role(&access, Some(folder_id))))
}

async fn name_of(db: &PgPool, sql: &'static str, id: &str) -> SignResult<Option<String>> {
    let row: Option<Option<String>> = sqlx::query_scalar(sql).bind(id).fetch_optional(db).await?;
    Ok(row.flatten())
}

/// The source's display name, or `None` when the file or record is gone
/// (`sourceName`).
async fn source_name(
    db: &PgPool,
    entity_type: &str,
    entity_id: &str,
) -> SignResult<Option<String>> {
    match entity_type {
        "file" => Ok(get_file(db, entity_id).await?.map(|f| f.file_name)),
        "company" => {
            name_of(
                db,
                "select name from companies where id = $1 and deleted_at is null limit 1",
                entity_id,
            )
            .await
        }
        "person" => {
            name_of(
                db,
                "select display_name from people where id = $1 and deleted_at is null limit 1",
                entity_id,
            )
            .await
        }
        "opportunity" => {
            name_of(
                db,
                "select name from crm_opportunities where id = $1 and deleted_at is null limit 1",
                entity_id,
            )
            .await
        }
        _ => Ok(None),
    }
}

/// `toSourceDto`: the stored source with its current name.
pub(crate) async fn source_dto(db: &PgPool, source: &Value) -> SignResult<Value> {
    let (Some(entity_type), Some(entity_id)) =
        (source["entityType"].as_str(), source["entityId"].as_str())
    else {
        return Ok(Value::Null);
    };
    let name = source_name(db, entity_type, entity_id).await?;
    Ok(json!({ "entityType": entity_type, "entityId": entity_id, "name": name }))
}

/// A checked source (`checkSource`): its name, and for a Drive file the
/// folder it is in when the member may add files there.
pub(crate) struct CheckedSource {
    pub(crate) folder_for_copy: Option<String>,
}

/// Check a source a member starts a request from: it exists and they may
/// read it. Anything else is `not_found`.
pub(crate) async fn check_source(
    caller: &Caller,
    source: &SourceInput,
) -> SignResult<CheckedSource> {
    let missing = || SignError::NotFound("Source");
    if !read_permission(&source.entity_type).is_some_and(|key| caller.can(key)) {
        return Err(missing());
    }
    let db = &caller.db;
    if source.entity_type == "file" {
        let Some(file) = visible_drive_file(db, &caller.user_id, &source.entity_id).await? else {
            return Err(missing());
        };
        let folder_for_copy = match file.r#ref.folder_id.as_deref() {
            Some(folder)
                if !folder.is_empty() && can_file_into(db, &caller.user_id, folder).await? =>
            {
                Some(folder.to_owned())
            }
            _ => None,
        };
        return Ok(CheckedSource { folder_for_copy });
    }
    if source_name(db, &source.entity_type, &source.entity_id)
        .await?
        .is_none()
    {
        return Err(missing());
    }
    Ok(CheckedSource {
        folder_for_copy: None,
    })
}

/// People with an email address, by id (`peopleByIds`).
async fn people_by_ids(
    db: &PgPool,
    ids: &[String],
) -> SignResult<Vec<(String, Option<String>, String, Option<String>)>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(sqlx::query_as(
        "select id, display_name, email, title from people
         where id = any($1) and deleted_at is null and email is not null",
    )
    .bind(ids)
    .fetch_all(db)
    .await?)
}

/// People on a CRM source who have an email address, offered as recipients
/// (`recipientSuggestions`). A file has none.
pub(crate) async fn recipient_suggestions(db: &PgPool, source: &Value) -> SignResult<Vec<Value>> {
    let entity_id = source["entityId"].as_str().unwrap_or_default();
    let ids: Vec<String> = match source["entityType"].as_str() {
        Some("person") => vec![entity_id.to_owned()],
        Some("company") => {
            sqlx::query_scalar("select person_id from person_companies where company_id = $1")
                .bind(entity_id)
                .fetch_all(db)
                .await?
        }
        Some("opportunity") => {
            let row: Option<(Option<String>, Option<Value>)> = sqlx::query_as(
                "select primary_contact_id, to_jsonb(person_ids) from crm_opportunities
                 where id = $1 and deleted_at is null limit 1",
            )
            .bind(entity_id)
            .fetch_optional(db)
            .await?;
            let mut ids = Vec::new();
            if let Some((primary, people)) = row {
                ids.extend(primary.filter(|id| !id.is_empty()));
                let people = people
                    .and_then(|p| p.as_array().cloned())
                    .unwrap_or_default();
                ids.extend(
                    people
                        .iter()
                        .filter_map(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned),
                );
            }
            // `[...new Set(ids)]`: first occurrence wins.
            let mut unique: Vec<String> = Vec::new();
            for id in ids {
                if !unique.contains(&id) {
                    unique.push(id);
                }
            }
            unique
        }
        _ => Vec::new(),
    };
    let people = people_by_ids(db, &ids).await?;
    let mut seen: Vec<String> = Vec::new();
    Ok(people
        .into_iter()
        .filter_map(|(id, name, email, title)| {
            let email = email.to_lowercase();
            if seen.contains(&email) {
                return None;
            }
            seen.push(email.clone());
            Some(json!({ "personId": id, "name": name, "email": email, "title": title }))
        })
        .collect())
}
