//! `/api/people` (`routes/people/index.ts`): individuals, on
//! `weldsuite_crm_domain::people`. Without `people:scope:all` a caller sees
//! only the people they own. The `/:id/chat` routes are [`crate::record_chat`].

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PERSON_ARCHIVED, PERSON_CREATED, PERSON_DELETED, PERSON_UNARCHIVED, PERSON_UPDATED,
};
use weldsuite_catalogs::permission_keys::PEOPLE_SCOPE_ALL;
use weldsuite_crm_domain::people::{self as service, DetailLimits, ListOptions, PeopleFilter};
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text, query_values};
use weldsuite_kit::{ApiError, Created, Data, NoContent};
use weldsuite_mail_domain::access::check_account_access;
use weldsuite_mail_domain::store::{MailboxStore, PostgresMailStore, RECENT_ADDRESS_SAMPLE};

use crate::identity_schema::{
    LIFECYCLE_STAGES, address, addresses, email_or_empty, emails, positive_int, url_field,
    url_refine,
};
use crate::schema::{self, Kind, NULLISH, OPT, STRINGS, Spec, partial, s};
use crate::{Answer, Caller, CrmState, Refusal, answer, page, validate};

const LOG: &str = "people";

const LINKEDIN_MESSAGE: &str = "LinkedIn must be a valid URL (e.g. linkedin.com/in/jane)";

/// `createPersonSchema` from `firstName` to `role`.
const HEAD: [Spec; 8] = [
    Spec::new("firstName", s(None, Some(100)), OPT),
    Spec::new("lastName", s(None, Some(100)), OPT),
    Spec::new("fullName", s(None, Some(255)), OPT),
    Spec::new("dateOfBirth", Kind::Datetime, OPT),
    Spec::new("gender", s(None, Some(20)), OPT),
    Spec::new("title", s(None, Some(100)), OPT),
    Spec::new("department", s(None, Some(100)), OPT),
    Spec::new("role", s(None, Some(30)), OPT),
];

/// From `directPhone` to `extension` (after `email`, `alternateEmails`).
const PHONES: [Spec; 3] = [
    Spec::new("directPhone", s(None, Some(50)), OPT),
    Spec::new("mobilePhone", s(None, Some(50)), OPT),
    Spec::new("extension", s(None, Some(20)), OPT),
];

/// `avatarUrl` (before `linkedinUrl`).
const AVATAR: [Spec; 1] = [Spec::new("avatarUrl", s(None, Some(1000)), OPT)];

/// From `twitterHandle` to `primaryCompanyId` (after `linkedinUrl`).
const TAIL: [Spec; 30] = [
    Spec::new("twitterHandle", s(None, Some(100)), OPT),
    Spec::new("ownerId", s(None, None), NULLISH),
    Spec::new("accountManagerId", s(None, None), NULLISH),
    Spec::new("status", s(None, None), OPT),
    Spec::new("lifecycleStage", Kind::Enum(LIFECYCLE_STAGES), NULLISH),
    Spec::new("rating", s(None, None), OPT),
    Spec::new("source", s(None, None), OPT),
    Spec::new("nextFollowUpDate", s(None, None), NULLISH),
    Spec::new("isSupplier", Kind::Bool, OPT),
    Spec::new("isLead", Kind::Bool, OPT),
    Spec::new("isFavorite", Kind::Bool, OPT),
    Spec::new("inCrm", Kind::Bool, OPT),
    Spec::new("isDecisionMaker", Kind::Bool, OPT),
    Spec::new("isBillingContact", Kind::Bool, OPT),
    Spec::new("isTechnicalContact", Kind::Bool, OPT),
    Spec::new("influenceLevel", s(None, None), OPT),
    Spec::new("preferredContactMethod", s(None, None), OPT),
    Spec::new("preferredLanguage", s(None, None), OPT),
    Spec::new("bestTimeToContact", s(None, None), OPT),
    Spec::new("marketingConsent", Kind::Bool, OPT),
    Spec::new("emailOptIn", Kind::Bool, OPT),
    Spec::new("smsOptIn", Kind::Bool, OPT),
    Spec::new("doNotCall", Kind::Bool, OPT),
    Spec::new("tags", STRINGS, OPT),
    Spec::new("interests", STRINGS, OPT),
    Spec::new("customFields", Kind::Record, OPT),
    Spec::new("notes", s(None, None), OPT),
    Spec::new("internalNotes", s(None, None), OPT),
    Spec::new("companyIds", STRINGS, OPT),
    Spec::new("primaryCompanyId", s(None, None), NULLISH),
];

/// `createPersonSchema`, or `updatePersonSchema` (partial, a nullish
/// `primaryAddress`, `ifVersion`/`version`), in Zod's issue order: the plain
/// checks in key order, the `linkedinUrl` refinement, then the `email` union.
fn person_body(issues: &mut Issues, body: &Map<String, Value>, update: bool) -> Map<String, Value> {
    let specs = |list: &[Spec]| if update { partial(list) } else { list.to_vec() };
    let mut out = schema::read_sync(issues, body, &specs(&HEAD));
    // `email` (a union) settles after the plain checks; `alternateEmails` next.
    emails(issues, body, "alternateEmails", &mut out);
    out.extend(schema::read_sync(issues, body, &specs(&PHONES)));
    address(
        issues,
        body,
        "primaryAddress",
        if update {
            Presence::Nullish
        } else {
            Presence::Optional
        },
        &mut out,
    );
    addresses(issues, body, "addresses", &mut out);
    out.extend(schema::read_sync(issues, body, &specs(&AVATAR)));
    url_field(issues, body, "linkedinUrl", 500, &mut out);
    out.extend(schema::read_sync(issues, body, &specs(&TAIL)));
    if update {
        positive_int(issues, body, "ifVersion", &mut out);
        positive_int(issues, body, "version", &mut out);
    }
    url_refine(issues, body, "linkedinUrl", LINKEDIN_MESSAGE, &mut out);
    email_or_empty(issues, body, "email", &mut out);
    out
}

/// A text query value (`z.string().optional()`).
fn query_text(issues: &mut Issues, values: &Map<String, Value>, key: &str) -> Option<String> {
    issues
        .text_with(values, key, Presence::Optional, Text::default())
        .into_option()
}

/// `z.coerce.boolean().optional()`: `Boolean(value)` when the key is there.
fn query_flag(values: &Map<String, Value>, key: &str) -> Option<bool> {
    values
        .get(key)
        .map(|v| v.as_str().is_some_and(|s| !s.is_empty()) || v.is_array())
}

/// A `z.coerce.number().min(1).max(max).default(fallback)` query value.
fn query_number(
    issues: &mut Issues,
    values: &Map<String, Value>,
    key: &str,
    max: f64,
    fallback: f64,
) -> f64 {
    issues
        .number(
            values,
            key,
            Presence::Optional,
            Number {
                coerce: true,
                int: false,
                min: Some(1.0),
                max: Some(max),
            },
        )
        .into_option()
        .unwrap_or(fallback)
}

fn invalid(issues: Issues) -> Result<(), Refusal> {
    issues
        .finish()
        .map_err(|invalid| Refusal::Response(Box::new(invalid.into_response())))
}

/// `listPeopleQuery` (`export`: `exportPeopleQuery`, without cursor and
/// limit), in the schema's key order.
fn list_query(raw: Option<&str>, export: bool) -> Answer<(PeopleFilter, ListOptions)> {
    let values = query_values(raw);
    let mut issues = Issues::default();
    let cursor = if export {
        None
    } else {
        query_text(&mut issues, &values, "cursor")
    };
    let limit = if export {
        0.0
    } else {
        query_number(&mut issues, &values, "limit", 100.0, 25.0)
    };
    let search = query_text(&mut issues, &values, "search");
    let status = query_text(&mut issues, &values, "status");
    let owner_id = query_text(&mut issues, &values, "ownerId");
    let is_supplier = query_flag(&values, "isSupplier");
    let is_lead = query_flag(&values, "isLead");
    let company_id = query_text(&mut issues, &values, "companyId");
    let list_id = query_text(&mut issues, &values, "listId");
    let filter = PeopleFilter {
        search,
        status,
        owner_id,
        is_supplier,
        is_lead,
        company_id,
        list_id,
        in_crm: query_flag(&values, "inCrm"),
        has_phone: query_flag(&values, "hasPhone"),
    };
    let sort = query_text(&mut issues, &values, "sort");
    let sort_dir = issues
        .choice(&values, "sortDir", Presence::Optional, &["asc", "desc"])
        .into_option();
    invalid(issues)?;
    #[allow(clippy::cast_possible_truncation)]
    let options = ListOptions {
        limit: limit as i64,
        cursor,
        sort,
        sort_dir,
    };
    Ok((filter, options))
}

/// `publishEntityEvent`'s `data` for a person write.
fn person_event(row: &Value, keys: &[&str]) -> Value {
    let mut data = Map::new();
    for key in keys {
        data.insert(
            (*key).to_owned(),
            row.get(*key).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(data)
}

const WRITE_KEYS: [&str; 7] = [
    "id",
    "firstName",
    "lastName",
    "fullName",
    "displayName",
    "email",
    "title",
];

fn id_of(row: &Value) -> String {
    row.get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn not_found(id: &str) -> Response {
    ApiError::not_found("Person", Some(id)).into_response()
}

// ── GET / and /export ───────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let (filter, options) = match list_query(query.as_deref(), false) {
        Ok(q) => q,
        Err(refusal) => return refusal.respond(LOG, "Invalid query"),
    };
    let result = async {
        let scope = caller.scope(PEOPLE_SCOPE_ALL);
        let found = service::list_people(&caller.db, &filter, &options, scope.as_deref()).await?;
        Ok(page(
            found.data,
            found.total_count,
            found.has_more,
            found.cursor,
        ))
    }
    .await;
    answer(result, LOG, "Failed to list people")
}

pub(crate) async fn export(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let (filter, _) = match list_query(query.as_deref(), true) {
        Ok(q) => q,
        Err(refusal) => return refusal.respond(LOG, "Invalid query"),
    };
    let result = async {
        let scope = caller.scope(PEOPLE_SCOPE_ALL);
        let rows = service::export_people(&caller.db, &filter, scope.as_deref()).await?;
        Ok(Data(rows).into_response())
    }
    .await;
    answer(result, LOG, "Failed to export people")
}

// ── POST /resolve-by-emails ─────────────────────────────────────────────────

/// `{ emails: z.array(z.string().email()).min(1).max(100) }`.
fn resolve_body(issues: &mut Issues, body: &Map<String, Value>) -> Vec<String> {
    let rules = Text {
        format: Some(Format::Email),
        ..Text::default()
    };
    issues
        .list(
            body,
            "emails",
            Presence::Required,
            Some(1),
            Some(100),
            |issues, item| issues.item_text(item, rules),
        )
        .into_option()
        .unwrap_or_default()
}

pub(crate) async fn resolve_by_emails(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let emails = match validate(&headers, &body, resolve_body) {
        Ok(emails) => emails,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let people = service::resolve_by_emails(&caller.db, &emails).await?;
        Ok(Data(people).into_response())
    }
    .await;
    answer(result, LOG, "Failed to resolve people by email")
}

// ── POST /import ────────────────────────────────────────────────────────────

/// `importPersonRecordSchema`.
const RECORD: [Spec; 31] = [
    Spec::new("partyCode", s(None, Some(50)), OPT),
    Spec::new("firstName", s(None, Some(100)), OPT),
    Spec::new("lastName", s(None, Some(100)), OPT),
    Spec::new("fullName", s(None, Some(255)), OPT),
    Spec::new("dateOfBirth", s(None, None), OPT),
    Spec::new("gender", s(None, Some(20)), OPT),
    Spec::new("email", s(None, Some(255)), OPT),
    Spec::new("alternateEmails", STRINGS, OPT),
    Spec::new("directPhone", s(None, Some(50)), OPT),
    Spec::new("mobilePhone", s(None, Some(50)), OPT),
    Spec::new("extension", s(None, Some(20)), OPT),
    Spec::new("title", s(None, Some(100)), OPT),
    Spec::new("department", s(None, Some(100)), OPT),
    Spec::new("role", s(None, Some(30)), OPT),
    Spec::new("status", s(None, Some(50)), OPT),
    Spec::new("lifecycleStage", s(None, Some(50)), OPT),
    Spec::new("rating", s(None, Some(10)), OPT),
    Spec::new("source", s(None, Some(100)), OPT),
    Spec::new("influenceLevel", s(None, Some(10)), OPT),
    Spec::new("linkedinUrl", s(None, Some(500)), OPT),
    Spec::new("twitterHandle", s(None, Some(100)), OPT),
    Spec::new("preferredContactMethod", s(None, Some(20)), OPT),
    Spec::new("preferredLanguage", s(None, Some(10)), OPT),
    Spec::new("bestTimeToContact", s(None, Some(100)), OPT),
    Spec::new("tags", STRINGS, OPT),
    Spec::new("interests", STRINGS, OPT),
    Spec::new("notes", s(None, Some(10000)), OPT),
    Spec::new("internalNotes", s(None, Some(10000)), OPT),
    Spec::new("isSupplier", Kind::Bool, OPT),
    Spec::new("isLead", Kind::Bool, OPT),
    Spec::new("customFields", Kind::Record, OPT),
];

/// `importPeopleSchema`.
fn import_body(issues: &mut Issues, body: &Map<String, Value>) -> Vec<Map<String, Value>> {
    issues
        .list(
            body,
            "records",
            Presence::Required,
            Some(1),
            Some(500),
            |issues, item| {
                let fields = issues.object(item)?.clone();
                Some(schema::read(issues, &fields, &RECORD))
            },
        )
        .into_option()
        .unwrap_or_default()
}

pub(crate) async fn import(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let records = match validate(&headers, &body, import_body) {
        Ok(records) => records,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let result = service::import_people(&caller.db, &records).await?;
        for changed in &result.changed {
            let event = if changed.created {
                PERSON_CREATED
            } else {
                PERSON_UPDATED
            };
            caller.publish(
                &state,
                event,
                &changed.id,
                &person_event(&changed.row, &WRITE_KEYS),
            );
        }
        Ok(Data(json!({
            "imported": result.imported,
            "updated": result.updated,
            "failed": result.failed,
            "total": result.total,
            "errors": result.errors,
        }))
        .into_response())
    }
    .await;
    answer(result, LOG, "Failed to import people")
}

// ── GET /recent-correspondents ──────────────────────────────────────────────

pub(crate) async fn recent_correspondents(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let values = query_values(query.as_deref());
    let mut issues = Issues::default();
    let account_id = query_text(&mut issues, &values, "accountId").filter(|a| !a.is_empty());
    let limit = query_number(&mut issues, &values, "limit", 50.0, 10.0);
    if let Err(invalid) = issues.finish() {
        return invalid.into_response();
    }
    let result = async {
        if let Some(account_id) = &account_id
            && !check_account_access(&caller.db, account_id, &caller.user_id).await?
        {
            return Ok(ApiError::forbidden()
                .with_message("Access to this mail account is not allowed")
                .into_response());
        }
        let emails = match &account_id {
            Some(account_id) => Some(
                PostgresMailStore::new(caller.db.clone())
                    .mailbox(account_id)
                    .recent_addresses(usize::try_from(RECENT_ADDRESS_SAMPLE).unwrap_or(200))
                    .await?,
            ),
            None => None,
        };
        #[allow(clippy::cast_possible_truncation)]
        let people =
            service::list_recent_correspondents(&caller.db, emails.as_deref(), limit as i64)
                .await?;
        Ok(Data(people).into_response())
    }
    .await;
    answer(result, LOG, "Failed to list recent correspondents")
}

// ── GET /:id ────────────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let scope = caller.scope(PEOPLE_SCOPE_ALL);
        Ok(
            match service::get_person(&caller.db, &id, scope.as_deref()).await? {
                Some(row) => Data(row).into_response(),
                None => not_found(&id),
            },
        )
    }
    .await;
    answer(result, LOG, "Failed to fetch person")
}

// ── POST / ──────────────────────────────────────────────────────────────────

pub(crate) async fn create(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut data = match validate(&headers, &body, |issues, fields| {
        person_body(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    if data.get("ownerId").is_none_or(Value::is_null) {
        data.insert("ownerId".into(), json!(caller.user_id));
    }
    let result = async {
        let (row, promoted) = service::create_person_detailed(&caller.db, &data).await?;
        let event = if promoted {
            PERSON_UPDATED
        } else {
            PERSON_CREATED
        };
        caller.publish(
            &state,
            event,
            &id_of(&row),
            &person_event(&row, &WRITE_KEYS),
        );
        Ok(if promoted {
            Data(row).into_response()
        } else {
            Created(row).into_response()
        })
    }
    .await;
    answer(result, LOG, "Failed to create person")
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

pub(crate) async fn update(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        person_body(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let scope = caller.scope(PEOPLE_SCOPE_ALL);
        let Some((row, changes)) =
            service::update_person(&caller.db, &id, &data, scope.as_deref()).await?
        else {
            return Ok(not_found(&id));
        };
        caller.publish_with_changes(
            &state,
            PERSON_UPDATED,
            &id_of(&row),
            person_event(&row, &WRITE_KEYS),
            changes,
        );
        Ok(Data(row).into_response())
    }
    .await;
    answer(result, LOG, "Failed to update person")
}

// ── DELETE /:id, archive, unarchive, add-to-crm ─────────────────────────────

pub(crate) async fn remove(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let scope = caller.scope(PEOPLE_SCOPE_ALL);
        if !service::delete_person(&caller.db, &id, scope.as_deref()).await? {
            return Ok(not_found(&id));
        }
        caller.publish(&state, PERSON_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, LOG, "Failed to delete person")
}

async fn set_archived(state: &CrmState, caller: &Caller, id: &str, archived: bool) -> Answer {
    let scope = caller.scope(PEOPLE_SCOPE_ALL);
    let Some(row) = service::set_archived(&caller.db, id, archived, scope.as_deref()).await? else {
        return Ok(not_found(id));
    };
    let event = if archived {
        PERSON_ARCHIVED
    } else {
        PERSON_UNARCHIVED
    };
    caller.publish(
        state,
        event,
        &id_of(&row),
        &person_event(&row, &["id", "displayName"]),
    );
    Ok(Data(row).into_response())
}

pub(crate) async fn archive(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        set_archived(&state, &caller, &id, true).await,
        LOG,
        "Failed to archive person",
    )
}

pub(crate) async fn unarchive(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        set_archived(&state, &caller, &id, false).await,
        LOG,
        "Failed to unarchive person",
    )
}

pub(crate) async fn add_to_crm(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let scope = caller.scope(PEOPLE_SCOPE_ALL);
        let Some(row) =
            service::add_person_to_crm(&caller.db, &id, Some(&caller.user_id), scope.as_deref())
                .await?
        else {
            return Ok(not_found(&id));
        };
        caller.publish(
            &state,
            PERSON_UPDATED,
            &id_of(&row),
            &person_event(&row, &["id", "displayName"]),
        );
        Ok(Data(row).into_response())
    }
    .await;
    answer(result, LOG, "Failed to add person to CRM")
}

// ── GET /:id/companies ──────────────────────────────────────────────────────

pub(crate) async fn companies(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let scope = caller.scope(PEOPLE_SCOPE_ALL);
        let rows = service::list_person_companies(&caller.db, &id, scope.as_deref()).await?;
        Ok(Data(rows).into_response())
    }
    .await;
    answer(result, LOG, "Failed to list person companies")
}

// ── POST /bulk-update ───────────────────────────────────────────────────────

/// `bulkUpdatePeopleSchema`.
fn bulk_body(issues: &mut Issues, body: &Map<String, Value>) -> (Vec<String>, Map<String, Value>) {
    let ids = issues
        .list(
            body,
            "personIds",
            Presence::Required,
            Some(1),
            Some(500),
            |issues, item| issues.item_text(item, Text::default()),
        )
        .into_option()
        .unwrap_or_default();
    let mut refine_failed = false;
    let updates = issues
        .nested(body, "updates", Presence::Required, |issues, fields| {
            let specs = [
                Spec::new("ownerId", s(None, None), NULLISH),
                Spec::new("accountManagerId", s(None, None), NULLISH),
                Spec::new("status", s(None, None), OPT),
                Spec::new("lifecycleStage", Kind::Enum(LIFECYCLE_STAGES), OPT),
            ];
            let before = issues.count();
            let out = schema::read(issues, fields, &specs);
            // A field that failed aborts the object, so its `.refine()` never runs.
            refine_failed = issues.count() == before
                && ["ownerId", "accountManagerId", "status", "lifecycleStage"]
                    .iter()
                    .all(|key| !out.contains_key(*key));
            out
        })
        .into_option()
        .unwrap_or_default();
    if refine_failed {
        issues.custom("updates", "At least one field must be provided");
    }
    (ids, updates)
}

pub(crate) async fn bulk_update(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (ids, updates) = match validate(&headers, &body, bulk_body) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let scope = caller.scope(PEOPLE_SCOPE_ALL);
        let (count, failed, rows) =
            service::bulk_update_people(&caller.db, &ids, &updates, scope.as_deref()).await?;
        for (id, before, after) in rows {
            let mut data = Map::new();
            data.insert("id".into(), json!(id));
            let mut diff = Map::new();
            for (key, value) in &after {
                data.insert(key.clone(), value.clone());
                diff.insert(
                    key.clone(),
                    json!({ "old": before.get(key).cloned().unwrap_or(Value::Null), "new": value }),
                );
            }
            caller.publish_with_changes(
                &state,
                PERSON_UPDATED,
                &id,
                Value::Object(data),
                Some(diff),
            );
        }
        Ok(Data(json!({ "updated": count, "failed": failed })).into_response())
    }
    .await;
    answer(result, LOG, "Failed to bulk-update people")
}

// ── GET /:id/detail and /:id/navigation ─────────────────────────────────────

pub(crate) async fn aggregate(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let values = query_values(query.as_deref());
    let mut issues = Issues::default();
    #[allow(clippy::cast_possible_truncation)]
    let limits = DetailLimits {
        activities: query_number(&mut issues, &values, "activitiesLimit", 50.0, 10.0) as i64,
        tickets: query_number(&mut issues, &values, "ticketsLimit", 50.0, 10.0) as i64,
        companies: query_number(&mut issues, &values, "companiesLimit", 50.0, 20.0) as i64,
    };
    if let Err(invalid) = issues.finish() {
        return invalid.into_response();
    }
    let result = async {
        let scope = caller.scope(PEOPLE_SCOPE_ALL);
        Ok(
            match service::get_person_detail(&caller.db, &id, limits, scope.as_deref()).await? {
                Some(detail) => Data(detail).into_response(),
                None => not_found(&id),
            },
        )
    }
    .await;
    answer(result, LOG, "Failed to fetch person detail")
}

pub(crate) async fn navigation(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let values = query_values(query.as_deref());
    let mut issues = Issues::default();
    let list_id = query_text(&mut issues, &values, "listId").filter(|l| !l.is_empty());
    if let Err(invalid) = issues.finish() {
        return invalid.into_response();
    }
    let result = async {
        let scope = caller.scope(PEOPLE_SCOPE_ALL);
        Ok(
            match service::get_person_navigation(
                &caller.db,
                &id,
                list_id.as_deref(),
                scope.as_deref(),
            )
            .await?
            {
                Some(nav) => Data(nav).into_response(),
                None => not_found(&id),
            },
        )
    }
    .await;
    answer(result, LOG, "Failed to fetch person navigation")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(body: &Value, update: bool) -> Result<Map<String, Value>, Vec<Value>> {
        let mut issues = Issues::default();
        let fields = body.as_object().cloned().unwrap_or_default();
        let out = person_body(&mut issues, &fields, update);
        issues
            .finish()
            .map(|()| out)
            .map_err(|invalid| invalid.issues().to_vec())
    }

    #[test]
    fn a_person_body_normalises_linkedin_and_keeps_an_empty_email() {
        let out = read(
            &json!({ "firstName": "Ann", "email": "", "linkedinUrl": "linkedin.com/in/ann", "extra": 1 }),
            false,
        )
        .unwrap_or_default();
        assert_eq!(out["linkedinUrl"], "https://linkedin.com/in/ann");
        assert_eq!(out["email"], "");
        assert!(!out.contains_key("extra"));
    }

    #[test]
    fn issues_come_in_zod_order() {
        let issues = read(
            &json!({ "email": "nope", "linkedinUrl": "not-a-url", "lifecycleStage": "zzz", "version": 0 }),
            true,
        )
        .err()
        .unwrap_or_default();
        let paths: Vec<&str> = issues
            .iter()
            .map(|issue| issue["path"][0].as_str().unwrap_or_default())
            .collect();
        assert_eq!(paths, ["lifecycleStage", "version", "linkedinUrl", "email"]);
    }
}
