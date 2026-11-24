//! Filing back (`packages/domains/sign/src/filing.ts`): once a request is
//! completed, a copy of the signed PDF goes to WeldDrive and, for a request
//! started from a CRM record, onto that record with a note activity. The last
//! step of the `sign.finalize` job; idempotent through the `filed` evidence
//! event.
//!
//! - WeldDrive: the folder chosen for the request (`file_back_folder_id`),
//!   else the sender's own `WeldSign/<year>`: restricted folders the sender
//!   owns, created on first use (`ensureOwnedFolder`).
//! - CRM: a copy as a file of the company or person (an opportunity's goes
//!   on its company) and a completed note activity (`createActivity`).
//!
//! Each copy is its own object, so deleting it in Drive or on the record
//! never touches WeldSign's signed PDF, or the other copy.

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    ACTIVITY_CREATED, EventName, FILE_CREATED, FOLDER_CREATED,
};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_events::{EntityEvent, EventContext, EventSource};
use weldsuite_kit::generate_id;
use weldsuite_ports::PutOptions;
use weldsuite_schema::tenant::{
    crm_activities, crm_opportunities, files, folders, sign_envelopes, sign_recipients,
};

use crate::envelopes::{json_rows, latest_filing, row_json};
use crate::mail::safe_title;
use crate::sending::{SignEvent, record_sign_event};
use crate::sources::source_name;
use crate::{SendContext, SignError, SignResult, or_else, text};

/// The default folder in the sender's Drive; a subfolder per year sits under it.
const DEFAULT_FOLDER_NAME: &str = "WeldSign";

fn signed_file_name(title: &str) -> String {
    format!("{} (signed).pdf", safe_title(title, "Signed document"))
}

/// `publishEntityEventRaw({ userId: 'system', action: 'created', … })`.
async fn publish(ctx: &SendContext, event: EventName, id: &str, data: Value) {
    let context = EventContext::new(&ctx.clerk_org_id, "system", EventSource::System);
    ctx.services
        .events
        .publish_and_wait(&context, EntityEvent::new(event, id, data))
        .await;
}

/// The live folder called `name` (case-insensitive) under `parent` that
/// `owner` owns, created when there is none (`ensureOwnedFolder`).
async fn ensure_owned_folder(
    db: &PgPool,
    name: &str,
    parent: Option<&str>,
    owner: &str,
) -> SignResult<(Value, bool)> {
    let db = &orm(db);
    let existing = folders::Entity::find()
        .filter(folders::Column::CreatedById.eq(owner))
        .filter(match parent {
            None => folders::Column::ParentId.is_null(),
            Some(parent) => folders::Column::ParentId.eq(parent),
        })
        .filter(lower_eq(folders::Column::Name, name))
        .filter(folders::Column::DeletedAt.is_null())
        .one(db)
        .await?;
    if let Some(folder) = existing {
        return Ok((row_json(folder)?, false));
    }
    let folder = folders::Entity::insert(folders::ActiveModel {
        id: Set(generate_id("fld")),
        name: Set(name.to_owned()),
        parent_id: Set(parent.map(str::to_owned)),
        created_by_id: Set(Some(owner.to_owned())),
        general_access: Set("restricted".to_owned()),
        metadata: Set(Some(json!({ "weldsign": true }))),
        ..Default::default()
    })
    .exec_with_returning(db)
    .await?;
    Ok((row_json(folder)?, true))
}

/// `lower(column) = lower(value)`, both lowered by Postgres.
fn lower_eq(column: impl ColumnTrait, value: &str) -> Expr {
    sea_orm::ExprTrait::eq(
        Expr::expr(Func::lower(Expr::col(column.as_column_ref()))),
        Func::lower(Expr::val(value)),
    )
}

/// The folder for the Drive copy: the chosen one while it exists, else the
/// sender's `WeldSign/<year>`.
async fn drive_folder_for(ctx: &SendContext, envelope: &Value, year: i32) -> SignResult<String> {
    if let Some(chosen) = envelope["fileBackFolderId"].as_str() {
        let found: Option<String> = folders::Entity::find()
            .select_only()
            .column(folders::Column::Id)
            .filter(folders::Column::Id.eq(chosen))
            .filter(folders::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(&ctx.db))
            .await?;
        if let Some(id) = found {
            return Ok(id);
        }
    }
    let owner = text(envelope, "senderUserId");
    let root = ensure_owned_folder(&ctx.db, DEFAULT_FOLDER_NAME, None, owner).await?;
    let year_folder =
        ensure_owned_folder(&ctx.db, &year.to_string(), Some(text(&root.0, "id")), owner).await?;
    for (folder, created) in [&root, &year_folder] {
        if *created {
            publish(
                ctx,
                FOLDER_CREATED,
                text(folder, "id"),
                json!({ "id": folder["id"], "name": folder["name"], "parentId": folder["parentId"] }),
            )
            .await;
        }
    }
    Ok(text(&year_folder.0, "id").to_owned())
}

/// The CRM record that gets a copy: a company or person, or an
/// opportunity's company.
struct Record {
    kind: &'static str,
    id: String,
    opportunity_id: Option<String>,
}

async fn record_for(db: &PgPool, envelope: &Value) -> SignResult<Option<Record>> {
    let source = &envelope["source"];
    let (Some(kind), Some(id)) = (source["entityType"].as_str(), source["entityId"].as_str())
    else {
        return Ok(None);
    };
    match kind {
        "company" | "person" => {
            let named = source_name(db, kind, id)
                .await?
                .is_some_and(|n| !n.is_empty());
            Ok(named.then(|| Record {
                kind: if kind == "company" {
                    "company"
                } else {
                    "person"
                },
                id: id.to_owned(),
                opportunity_id: None,
            }))
        }
        "opportunity" => {
            let customer: Option<String> = crm_opportunities::Entity::find()
                .select_only()
                .column(crm_opportunities::Column::CustomerId)
                .filter(crm_opportunities::Column::Id.eq(id))
                .filter(crm_opportunities::Column::DeletedAt.is_null())
                .into_tuple()
                .one(&orm(db))
                .await?;
            Ok(customer.map(|customer| Record {
                kind: "company",
                id: customer,
                opportunity_id: Some(id.to_owned()),
            }))
        }
        _ => Ok(None),
    }
}

/// A copy an earlier, interrupted run already made (`existingCopy`).
async fn existing_copy(db: &PgPool, envelope_id: &str, copy: &str) -> SignResult<Option<Value>> {
    // `metadata->'weldsign'->>key`.
    let weldsign = |key: &str| {
        use sea_orm::sea_query::extension::postgres::PgExpr;
        PgExpr::cast_json_field(
            PgExpr::get_json_field(
                Expr::col((files::Entity, files::Column::Metadata)),
                "weldsign",
            ),
            key,
        )
    };
    let row = files::Entity::find()
        .filter(files::Column::DeletedAt.is_null())
        .filter(sea_orm::ExprTrait::eq(weldsign("envelopeId"), envelope_id))
        .filter(sea_orm::ExprTrait::eq(weldsign("copy"), copy))
        .one(&orm(db))
        .await?;
    Ok(row.map(row_json).transpose()?)
}

/// The note an earlier run already logged: it lists the record copy among
/// its attachments (`existingNote`).
async fn existing_note(db: &PgPool, record_file_id: &str) -> SignResult<Option<String>> {
    Ok(crm_activities::Entity::find()
        .select_only()
        .column(crm_activities::Column::Id)
        .filter(sea_orm::sea_query::extension::postgres::PgExpr::contains(
            Expr::col((crm_activities::Entity, crm_activities::Column::Attachments)),
            json!([record_file_id]),
        ))
        .into_tuple()
        .one(&orm(db))
        .await?)
}

/// `deduplicateFileName`: `name (1).pdf`, `name (2).pdf`, … until no live
/// file in the folder has the name (case-insensitive).
async fn deduplicate_file_name(
    db: &PgPool,
    name: &str,
    folder: Option<&str>,
) -> SignResult<String> {
    let db = &orm(db);
    let taken = |candidate: String| async move {
        let found: Option<String> = files::Entity::find()
            .select_only()
            .column(files::Column::Id)
            .filter(lower_eq(files::Column::FileName, &candidate))
            .filter(files::Column::DeletedAt.is_null())
            .filter(match folder {
                None => files::Column::FolderId.is_null(),
                Some(folder) => files::Column::FolderId.eq(folder),
            })
            .into_tuple()
            .one(db)
            .await?;
        Ok::<_, SignError>((found.is_some(), candidate))
    };
    let (conflict, _) = taken(name.to_owned()).await?;
    if !conflict {
        return Ok(name.to_owned());
    }
    let (base, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    for n in 1.. {
        let (conflict, candidate) = taken(format!("{base} ({n}){ext}")).await?;
        if !conflict {
            return Ok(candidate);
        }
    }
    unreachable!("the loop above returns")
}

/// Where a copy goes.
struct Place<'a> {
    folder: Option<&'a str>,
    entity: Option<(&'a str, &'a str)>,
}

/// Store one copy of the PDF under its own key and record it as a `files`
/// row (`storeCopy`, `createFile`).
async fn store_copy(
    ctx: &SendContext,
    envelope: &Value,
    pdf: &[u8],
    copy: &str,
    place: Place<'_>,
) -> SignResult<Value> {
    let files = ctx
        .services
        .files
        .clone()
        .ok_or_else(|| SignError::Internal("sign: no file storage".to_owned()))?;
    let id = text(envelope, "id");
    let key = format!(
        "workspaces/{}/weldsign/{id}/copies/{}.pdf",
        ctx.clerk_org_id,
        random_uuid()
    );
    files
        .private
        .put_boxed(
            &key,
            pdf.to_vec(),
            &PutOptions::content_type("application/pdf"),
        )
        .await
        .map_err(|e| SignError::Internal(e.to_string()))?;
    let name = signed_file_name(text(envelope, "title"));
    let unique = deduplicate_file_name(&ctx.db, &name, place.folder).await?;
    let metadata = json!({ "weldsign": { "envelopeId": id, "copy": copy, "sha256": envelope["finalSha256"] } });
    let now = utc_now();
    let file_id = generate_id("fil");
    let (entity_type, entity_id) = place.entity.unzip();
    let row = files::Entity::insert(files::ActiveModel {
        id: Set(file_id.clone()),
        file_name: Set(unique),
        original_name: Set(Some(name)),
        mime_type: Set("application/pdf".to_owned()),
        file_size: Set(i32::try_from(pdf.len()).unwrap_or(i32::MAX)),
        file_type: Set("file".to_owned()),
        storage_path: Set(key.clone()),
        file_key: Set(Some(key)),
        bucket: Set(Some("private".to_owned())),
        url: Set(None),
        thumbnail_url: Set(None),
        folder_id: Set(place.folder.map(str::to_owned)),
        uploaded_by_id: Set(Some(text(envelope, "senderUserId").to_owned())),
        is_public: Set(false),
        entity_type: Set(entity_type.map(str::to_owned)),
        entity_id: Set(entity_id.map(str::to_owned)),
        metadata: Set(Some(metadata)),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_with_returning(&orm(&ctx.db))
    .await?;
    let file = row_json(row)?;
    publish(
        ctx,
        FILE_CREATED,
        &file_id,
        json!({
            "id": file["id"],
            "name": file["fileName"],
            "folderId": file["folderId"],
            "fileType": file["fileType"],
            "fileSize": file["fileSize"],
            "mimeType": file["mimeType"],
        }),
    )
    .await;
    Ok(file)
}

/// A random UUID v4 (`crypto.randomUUID()`).
fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    aws_lc_rs::rand::fill(&mut bytes).expect("the system random source works");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// `text.slice(0, n)` in UTF-16 units.
fn utf16_prefix(text: &str, units: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        used += c.len_utf16();
        if used > units {
            break;
        }
        out.push(c);
    }
    out
}

/// The note on the CRM record: what was signed, by whom and when
/// (`logActivity`).
async fn log_activity(
    ctx: &SendContext,
    envelope: &Value,
    record: &Record,
    record_file_id: &str,
    now: OffsetDateTime,
) -> SignResult<String> {
    let recipients = sign_recipients::Entity::find()
        .filter(sign_recipients::Column::EnvelopeId.eq(text(envelope, "id")))
        .all(&orm(&ctx.db))
        .await?;
    let recipients = json_rows(recipients)?;
    let names: Vec<String> = recipients
        .iter()
        .filter(|r| r["role"] == "signer")
        .map(|r| {
            or_else(&r["name"], &r["email"])
                .as_str()
                .unwrap_or_default()
                .to_owned()
        })
        .filter(|n| !n.is_empty())
        .collect();
    let source = &envelope["source"];
    let related_name = source_name(
        &ctx.db,
        text(source, "entityType"),
        text(source, "entityId"),
    )
    .await?;
    let related_to = match (&record.opportunity_id, record.kind) {
        (Some(_), _) => "opportunity",
        (None, "company") => "customer",
        _ => "contact",
    };
    let subject = utf16_prefix(&format!("Signed: {}", text(envelope, "title")), 255);
    let signed_on = weldsuite_events::iso_timestamp(now)[..10].to_owned();
    let description = format!(
        "Signed by {} on {signed_on} with WeldSign. The signed PDF is in the files of this record.",
        names.join(", ")
    );
    let customer = (record.kind == "company").then_some(record.id.as_str());
    let person = (record.kind == "person").then_some(record.id.as_str());
    let assignee = text(envelope, "senderUserId");
    let id = generate_id("act");
    let stamp = utc_now();
    crm_activities::Entity::insert(crm_activities::ActiveModel {
        id: Set(id.clone()),
        type_: Set("note".to_owned()),
        subject: Set(subject.clone()),
        description: Set(Some(description)),
        related_to: Set(Some(related_to.to_owned())),
        related_to_id: Set(Some(
            record
                .opportunity_id
                .clone()
                .unwrap_or_else(|| record.id.clone()),
        )),
        related_to_name: Set(related_name),
        customer_id: Set(customer.map(str::to_owned)),
        person_id: Set(person.map(str::to_owned)),
        opportunity_id: Set(record.opportunity_id.clone()),
        assigned_to_id: Set(assignee.to_owned()),
        status: Set("completed".to_owned()),
        priority: Set(Some("medium".to_owned())),
        attachments: Set(Some(json!([record_file_id]))),
        created_at: Set(stamp),
        updated_at: Set(stamp),
        ..Default::default()
    })
    .exec_without_returning(&orm(&ctx.db))
    .await?;
    // `createActivity`'s event data; keys that are `undefined` there stay out.
    let mut data = json!({ "id": id, "type": "note", "subject": subject, "status": "completed" });
    if let Some(customer) = customer {
        data["customerId"] = json!(customer);
    }
    data["assigneeId"] = json!(assignee);
    data["dueDate"] = Value::Null;
    publish(ctx, ACTIVITY_CREATED, &id, data).await;
    Ok(id)
}

/// The signed PDF, read once when a copy needs it.
struct SignedPdf {
    key: String,
    bytes: Option<Vec<u8>>,
}

impl SignedPdf {
    async fn get(&mut self, ctx: &SendContext) -> SignResult<Vec<u8>> {
        if let Some(bytes) = &self.bytes {
            return Ok(bytes.clone());
        }
        let files = ctx
            .services
            .files
            .clone()
            .ok_or_else(|| SignError::Internal("sign: no file storage".to_owned()))?;
        let object = files
            .private
            .get_boxed(&self.key)
            .await
            .map_err(|e| SignError::Internal(e.to_string()))?
            .ok_or_else(|| {
                SignError::Internal(format!("The signed PDF {} is missing", self.key))
            })?;
        self.bytes = Some(object.bytes.clone());
        Ok(object.bytes)
    }
}

/// File a completed request's signed PDF: where it went, or `None` when the
/// request is not completed yet (`fileSignedPdf`). Each part is made once: a
/// run that stopped half way reuses the copies and the note it already made,
/// and once the `filed` event exists nothing runs again.
pub(crate) async fn file_signed_pdf(
    ctx: &SendContext,
    envelope_id: &str,
) -> SignResult<Option<Value>> {
    let now = OffsetDateTime::now_utc();
    let row = sign_envelopes::Entity::find_by_id(envelope_id)
        .one(&orm(&ctx.db))
        .await?;
    let Some(envelope) = row.map(row_json).transpose()? else {
        return Ok(None);
    };
    let final_key = text(&envelope, "finalStorageKey").to_owned();
    if text(&envelope, "status") != "completed" || final_key.is_empty() {
        return Ok(None);
    }
    let done = latest_filing(&ctx.db, envelope_id).await?;
    if !done.is_null() {
        return Ok(Some(done));
    }

    let mut pdf = SignedPdf {
        key: final_key,
        bytes: None,
    };
    let drive_file = if let Some(file) = existing_copy(&ctx.db, envelope_id, "drive").await? {
        file
    } else {
        let year = crate::schedule::timestamp(&envelope["completedAt"])
            .unwrap_or(now)
            .year();
        let folder = drive_folder_for(ctx, &envelope, year).await?;
        let place = Place {
            folder: Some(&folder),
            entity: None,
        };
        store_copy(ctx, &envelope, &pdf.get(ctx).await?, "drive", place).await?
    };

    let record = record_for(&ctx.db, &envelope).await?;
    let (mut record_file_id, mut activity_id) = (None, None);
    if let Some(record) = &record {
        let record_file = if let Some(file) = existing_copy(&ctx.db, envelope_id, "record").await? {
            file
        } else {
            let place = Place {
                folder: None,
                entity: Some((record.kind, &record.id)),
            };
            store_copy(ctx, &envelope, &pdf.get(ctx).await?, "record", place).await?
        };
        let file_id = text(&record_file, "id").to_owned();
        activity_id = Some(if let Some(id) = existing_note(&ctx.db, &file_id).await? {
            id
        } else {
            log_activity(ctx, &envelope, record, &file_id, now).await?
        });
        record_file_id = Some(file_id);
    }

    let details = json!({
        "driveFileId": drive_file["id"],
        "driveFolderId": drive_file["folderId"],
        "recordFileId": record_file_id,
        "recordType": record.as_ref().map(|r| r.kind),
        "recordId": record.as_ref().map(|r| r.id.clone()),
        "activityId": activity_id,
    });
    record_sign_event(
        &ctx.db,
        SignEvent {
            envelope_id,
            kind: "filed",
            details: Some(details),
            ..SignEvent::default()
        },
    )
    .await?;
    Ok(Some(latest_filing(&ctx.db, envelope_id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_ids() {
        assert_eq!(signed_file_name("NDA: v2"), "NDA  v2 (signed).pdf");
        assert_eq!(signed_file_name("::"), "Signed document (signed).pdf");
        let uuid = random_uuid();
        assert_eq!(uuid.len(), 36);
        assert_eq!(&uuid[14..15], "4");
        assert_eq!(utf16_prefix("abc😀d", 4), "abc");
    }
}
