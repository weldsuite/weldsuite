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

use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    ACTIVITY_CREATED, EventName, FILE_CREATED, FOLDER_CREATED,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_events::{EntityEvent, EventContext, EventSource};
use weldsuite_kit::generate_id;
use weldsuite_ports::PutOptions;

use crate::envelopes::latest_filing;
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
    let existing: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from folders f
         where created_by_id = $1
           and (case when $2::text is null then parent_id is null else parent_id = $2 end)
           and lower(name) = lower($3) and deleted_at is null
         limit 1",
    )
    .bind(owner)
    .bind(parent)
    .bind(name)
    .fetch_optional(db)
    .await?;
    if let Some(folder) = existing {
        return Ok((js_row(folder), false));
    }
    let folder: Value = sqlx::query_scalar(
        "insert into folders (id, name, parent_id, created_by_id, general_access, metadata)
         values ($1, $2, $3, $4, 'restricted', '{\"weldsign\":true}'::jsonb)
         returning to_jsonb(folders)",
    )
    .bind(generate_id("fld"))
    .bind(name)
    .bind(parent)
    .bind(owner)
    .fetch_one(db)
    .await?;
    Ok((js_row(folder), true))
}

/// The folder for the Drive copy: the chosen one while it exists, else the
/// sender's `WeldSign/<year>`.
async fn drive_folder_for(ctx: &SendContext, envelope: &Value, year: i32) -> SignResult<String> {
    if let Some(chosen) = envelope["fileBackFolderId"].as_str() {
        let found: Option<String> = sqlx::query_scalar(
            "select id from folders where id = $1 and deleted_at is null limit 1",
        )
        .bind(chosen)
        .fetch_optional(&ctx.db)
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
            let customer: Option<String> = sqlx::query_scalar(
                "select customer_id from crm_opportunities where id = $1 and deleted_at is null limit 1",
            )
            .bind(id)
            .fetch_optional(db)
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
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from files f
         where deleted_at is null
           and metadata->'weldsign'->>'envelopeId' = $1
           and metadata->'weldsign'->>'copy' = $2
         limit 1",
    )
    .bind(envelope_id)
    .bind(copy)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// The note an earlier run already logged: it lists the record copy among
/// its attachments (`existingNote`).
async fn existing_note(db: &PgPool, record_file_id: &str) -> SignResult<Option<String>> {
    Ok(sqlx::query_scalar(
        "select id from crm_activities where attachments @> jsonb_build_array($1::text) limit 1",
    )
    .bind(record_file_id)
    .fetch_optional(db)
    .await?)
}

/// `deduplicateFileName`: `name (1).pdf`, `name (2).pdf`, … until no live
/// file in the folder has the name (case-insensitive).
async fn deduplicate_file_name(
    db: &PgPool,
    name: &str,
    folder: Option<&str>,
) -> SignResult<String> {
    let taken = |candidate: String| async move {
        let found: Option<String> = sqlx::query_scalar(
            "select id from files
             where lower(file_name) = lower($1) and deleted_at is null
               and (case when $2::text is null then folder_id is null else folder_id = $2 end)
             limit 1",
        )
        .bind(&candidate)
        .bind(folder)
        .fetch_optional(db)
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
    let now = crate::now();
    let file_id = generate_id("fil");
    let (entity_type, entity_id) = place.entity.unzip();
    let row: Value = sqlx::query_scalar(
        "insert into files
             (id, file_name, original_name, mime_type, file_size, file_type, storage_path, file_key,
              bucket, url, thumbnail_url, folder_id, uploaded_by_id, is_public, entity_type,
              entity_id, metadata, created_at, updated_at)
         values ($1, $2, $3, 'application/pdf', $4, 'file', $5, $5, 'private', null, null, $6, $7,
                 false, $8, $9, $10::jsonb, $11::timestamp, $11::timestamp)
         returning to_jsonb(files)",
    )
    .bind(&file_id)
    .bind(&unique)
    .bind(&name)
    .bind(i32::try_from(pdf.len()).unwrap_or(i32::MAX))
    .bind(&key)
    .bind(place.folder)
    .bind(text(envelope, "senderUserId"))
    .bind(entity_type)
    .bind(entity_id)
    .bind(metadata)
    .bind(&now)
    .fetch_one(&ctx.db)
    .await?;
    let file = js_row(row);
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
    let recipients: Vec<Value> =
        sqlx::query_scalar("select to_jsonb(r) from sign_recipients r where envelope_id = $1")
            .bind(text(envelope, "id"))
            .fetch_all(&ctx.db)
            .await?;
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
    let stamp = crate::now();
    sqlx::query(
        "insert into crm_activities
             (id, type, subject, description, related_to, related_to_id, related_to_name,
              customer_id, person_id, opportunity_id, assigned_to_id, status, priority,
              attachments, created_at, updated_at)
         values ($1, 'note', $2, $3, $4, $5, $6, $7, $8, $9, $10, 'completed', 'medium',
                 jsonb_build_array($11::text), $12::timestamp, $12::timestamp)",
    )
    .bind(&id)
    .bind(&subject)
    .bind(&description)
    .bind(related_to)
    .bind(record.opportunity_id.as_deref().unwrap_or(&record.id))
    .bind(related_name)
    .bind(customer)
    .bind(person)
    .bind(record.opportunity_id.as_deref())
    .bind(assignee)
    .bind(record_file_id)
    .bind(&stamp)
    .execute(&ctx.db)
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
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(e) from sign_envelopes e where id = $1 limit 1")
            .bind(envelope_id)
            .fetch_optional(&ctx.db)
            .await?;
    let Some(envelope) = row.map(js_row) else {
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
