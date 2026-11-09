//! Step `crm` (`workflows/steps/crm.ts`, ADR FORMS-006): per enabled `crm`
//! integration, as the member who set it up:
//!
//!  - find the person by email in the CRM, or create one (a hidden mail
//!    identity with that email is promoted into the CRM), or create a lead;
//!  - the company, from a company question or the email's domain;
//!  - the mapped fields, each "always overwrite" or "only fill empty",
//!    standard or `custom:<customFieldId>`;
//!  - a CRM list, tags, and an activity "Submitted <form>" linking to the
//!    response;
//!  - `form_responses.person_id`.
//!
//! Writes through `weldsuite-crm-domain` and `weldsuite-core-domain`. Safe
//! to run again: the person is found by email, the record made is
//! remembered on the action row, list members and the activity are not
//! duplicated. A response edit (mode `update`) updates the same person; a
//! lead is left as it was.

use std::collections::HashSet;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_core_domain::custom_field_values as cfv;
use weldsuite_core_domain::js::Js;
use weldsuite_crm_domain::DomainError;
use weldsuite_crm_domain::activities::create_activity;
use weldsuite_crm_domain::companies::create_company;
use weldsuite_crm_domain::leads::create_lead;
use weldsuite_crm_domain::people::{create_person_detailed, update_person};
use weldsuite_kit::validation::js_trim;
use weldsuite_ports::BoxFuture;

use crate::common::{Fail, FormsResult, js_slice, one, text};
use crate::creator_access::{CreatorAccess, CreatorForbidden, load_creator_access};
use crate::integration_config::{CrmConfig, crm_config};
use crate::integration_support::{
    StepFail, answer_text, email_answer, emit_record_event, find_person_by_email, recorded_entity,
    remember_entity, response_url,
};
use crate::process::{ProcessContext, ProcessStep, StepKind, StepResult};

pub(crate) struct CrmStep;

impl ProcessStep for CrmStep {
    fn name(&self) -> &'static str {
        "crm"
    }

    fn kind(&self) -> StepKind {
        StepKind::Integration("crm")
    }

    fn run<'a>(
        &'a self,
        ctx: &'a ProcessContext,
        integration: Option<&'a Value>,
    ) -> BoxFuture<'a, Result<StepResult, String>> {
        Box::pin(async move {
            let Some(integration) = integration else {
                return Err("forms: the CRM step runs per integration".to_owned());
            };
            run_crm_step(ctx, integration).await
        })
    }
}

/// `CRM_STANDARD_FIELDS`: the standard fields a mapping may fill.
pub(crate) const CRM_STANDARD_FIELDS: [&str; 7] = [
    "firstName",
    "lastName",
    "email",
    "directPhone",
    "mobilePhone",
    "title",
    "department",
];

/// Free mail providers: their domain says nothing about the person's company.
const FREE_MAIL: [&str; 14] = [
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "yahoo.com",
    "icloud.com",
    "me.com",
    "proton.me",
    "protonmail.com",
    "gmx.com",
    "gmx.net",
    "aol.com",
    "msn.com",
];

/// A custom field a mapping writes.
struct CustomValue {
    definition: cfv::Definition,
    value: Value,
    /// `overwrite` or `fill_empty`.
    mode: String,
}

/// `Mapped`: the standard fields (in mapping order, the last mapping of a
/// field winning), their modes, and the custom fields.
#[derive(Default)]
struct Mapped {
    standard: Vec<(&'static str, String, String)>,
    custom: Vec<CustomValue>,
}

impl Mapped {
    fn standard(&self, key: &str) -> Option<(&str, &str)> {
        self.standard
            .iter()
            .find(|(k, _, _)| *k == key)
            .map(|(_, value, mode)| (value.as_str(), mode.as_str()))
    }

    fn set_standard(&mut self, key: &'static str, value: String, mode: String) {
        if let Some(entry) = self.standard.iter_mut().find(|(k, _, _)| *k == key) {
            entry.1 = value;
            entry.2 = mode;
        } else {
            self.standard.push((key, value, mode));
        }
    }
}

/// `Number(text)` for a string: JavaScript's rules for the plain decimal
/// forms, `None` for anything that is not a finite number.
fn js_number(text: &str) -> Option<f64> {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return Some(0.0);
    }
    let lowered = trimmed.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = lowered.strip_prefix(prefix) {
            #[allow(clippy::cast_precision_loss)]
            return u64::from_str_radix(digits, radix).ok().map(|n| n as f64);
        }
    }
    if lowered.contains("inf") || lowered.contains("nan") || lowered.contains('_') {
        return None;
    }
    trimmed.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// A number as JSON the way `JSON.stringify` writes it (whole numbers
/// without a fraction).
fn number_json(n: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        return json!(n as i64);
    }
    json!(n)
}

/// `typed(definition, text)`.
fn typed(definition: &cfv::Definition, text: &str) -> Value {
    match definition.field_type.as_str() {
        "number" | "currency" | "decimal" => {
            js_number(&text.replacen(',', ".", 1)).map_or_else(|| json!(text), number_json)
        }
        "boolean" | "checkbox" => {
            let lowered = text.to_lowercase();
            json!(matches!(
                lowered.as_str(),
                "yes" | "true" | "1" | "accepted"
            ))
        }
        _ => json!(text),
    }
}

async fn map_answers(
    ctx: &ProcessContext,
    config: &CrmConfig,
    entity: &str,
) -> FormsResult<Mapped> {
    let mut mapped = Mapped::default();
    let definitions = if config
        .mappings
        .iter()
        .any(|m| m.crm_field.starts_with("custom:"))
    {
        cfv::definitions(&ctx.db, entity).await?
    } else {
        Vec::new()
    };
    for mapping in &config.mappings {
        let value = answer_text(
            &ctx.definition,
            &ctx.response["answers"],
            &mapping.block_id,
            mapping.part.as_deref(),
        );
        if value.is_empty() {
            continue;
        }
        if let Some(key) = CRM_STANDARD_FIELDS
            .iter()
            .find(|key| **key == mapping.crm_field)
        {
            mapped.set_standard(key, value, mapping.mode.clone());
        } else if let Some(id) = mapping.crm_field.strip_prefix("custom:")
            && let Some(definition) = definitions.iter().find(|d| d.id == id)
        {
            mapped.custom.push(CustomValue {
                value: typed(definition, &value),
                definition: definition.clone(),
                mode: mapping.mode.clone(),
            });
        }
    }
    Ok(mapped)
}

/// `isEmpty(v)`: null, missing or a blank string.
fn is_empty(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => js_trim(text).is_empty(),
        Some(_) => false,
    }
}

// ── Company ──────────────────────────────────────────────────────────────────

/// `escapeLike(s)`.
fn escape_like(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `new URL(url).hostname` for the plain `http(s)://host[:port]/…` forms;
/// `None` where the URL would not parse.
fn url_hostname(url: &str) -> Option<String> {
    let lowered = url.to_ascii_lowercase();
    let rest = if lowered.starts_with("https://") {
        &url[8..]
    } else if lowered.starts_with("http://") {
        &url[7..]
    } else {
        return None;
    };
    let authority = rest.split(['/', '?', '#', '\\']).next().unwrap_or_default();
    let host_port = authority.rsplit('@').next().unwrap_or_default();
    let host = if host_port.starts_with('[') {
        host_port.split(']').next().map(|h| format!("{h}]"))?
    } else {
        host_port.split(':').next().unwrap_or_default().to_owned()
    };
    if host.is_empty() || host.chars().any(|c| c.is_whitespace() || c == '%') {
        return None;
    }
    Some(host.to_lowercase())
}

/// `hostOf(website)`.
fn host_of(website: Option<&str>) -> String {
    let Some(website) = website.filter(|w| !w.is_empty()) else {
        return String::new();
    };
    let lowered = website.to_ascii_lowercase();
    let url = if lowered.starts_with("http://") || lowered.starts_with("https://") {
        website.to_owned()
    } else {
        format!("https://{website}")
    };
    match url_hostname(&url) {
        Some(host) => host
            .strip_prefix("www.")
            .map_or(host.clone(), str::to_owned),
        None => website.to_lowercase(),
    }
}

async fn find_company(
    db: &PgPool,
    name: Option<&str>,
    domain: Option<&str>,
) -> FormsResult<Option<String>> {
    if let Some(name) = name {
        let by_name: Option<String> = sqlx::query_scalar(
            "select id from companies where deleted_at is null and lower(display_name) = $1 limit 1",
        )
        .bind(name.to_lowercase())
        .fetch_optional(db)
        .await?;
        if by_name.is_some() {
            return Ok(by_name);
        }
    }
    if let Some(domain) = domain {
        let candidates: Vec<(String, Option<String>)> = sqlx::query_as(
            "select id, website from companies where deleted_at is null and website ilike $1 limit 20",
        )
        .bind(format!("%{}%", escape_like(domain)))
        .fetch_all(db)
        .await?;
        if let Some((id, _)) = candidates
            .into_iter()
            .find(|(_, website)| host_of(website.as_deref()) == domain)
        {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

async fn ensure_company(
    ctx: &ProcessContext,
    config: &CrmConfig,
    email: &str,
    user_id: &str,
) -> Result<Option<String>, StepFail> {
    let from_field = config
        .company_field_id
        .as_deref()
        .map_or_else(String::new, |id| {
            answer_text(
                &ctx.definition,
                &ctx.response["answers"],
                id,
                Some("company"),
            )
        });
    let name = (!from_field.is_empty()).then_some(from_field);
    let domain = email.split('@').nth(1).unwrap_or_default();
    let usable_domain = (!domain.is_empty() && !FREE_MAIL.contains(&domain)).then_some(domain);
    if name.is_none() && usable_domain.is_none() {
        return Ok(None);
    }
    if let Some(found) = find_company(&ctx.db, name.as_deref(), usable_domain).await? {
        return Ok(Some(found));
    }
    let mut input = Map::new();
    input.insert(
        "name".to_owned(),
        json!(name.as_deref().or(usable_domain).unwrap_or_default()),
    );
    if let Some(domain) = usable_domain {
        input.insert("website".to_owned(), json!(format!("https://{domain}")));
    }
    input.insert("ownerId".to_owned(), json!(user_id));
    input.insert("source".to_owned(), json!("weldforms"));
    let created = create_company(&ctx.db, &input, Some(user_id))
        .await
        .map_err(domain_fail)?;
    Ok(Some(text(&created, "id").to_owned()))
}

// ── Person ───────────────────────────────────────────────────────────────────

async fn person_by_id(db: &PgPool, id: &str) -> FormsResult<Option<Value>> {
    one(
        db,
        sqlx::query_scalar(
            "select to_jsonb(p) from people p where p.id = $1 and p.deleted_at is null limit 1",
        )
        .bind(id),
    )
    .await
}

/// `writable(existing, mapped)`: every field on a new record, only the ones
/// the mode allows on an existing one.
fn writable(existing: Option<&Value>, mapped: &Mapped) -> Map<String, Value> {
    let mut out = Map::new();
    for key in CRM_STANDARD_FIELDS {
        if key == "email" {
            continue;
        }
        let Some((value, mode)) = mapped.standard(key) else {
            continue;
        };
        if let Some(existing) = existing
            && mode != "overwrite"
            && !is_empty(existing.get(key))
        {
            continue;
        }
        out.insert(key.to_owned(), json!(value));
    }
    out
}

/// `customBlob(existing, mapped)`.
fn custom_blob(existing: Option<&Value>, mapped: &Mapped) -> Option<Map<String, Value>> {
    if mapped.custom.is_empty() {
        return None;
    }
    let current = existing
        .and_then(|e| e.get("customFields"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut next = current.clone();
    for custom in &mapped.custom {
        if custom.mode == "fill_empty" && !is_empty(current.get(&custom.definition.slug)) {
            continue;
        }
        next.insert(custom.definition.slug.clone(), custom.value.clone());
    }
    Some(next)
}

/// `personEvent(row)`.
fn person_event(row: &Value) -> Value {
    let field = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": field("id"),
        "firstName": field("firstName"),
        "lastName": field("lastName"),
        "fullName": field("fullName"),
        "displayName": field("displayName"),
        "email": field("email"),
        "title": field("title"),
    })
}

fn tags_of(row: &Value) -> Vec<String> {
    row.get("tags")
        .and_then(Value::as_array)
        .map(|tags| {
            tags.iter()
                .map(|t| t.as_str().map_or_else(|| t.to_string(), str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn creator_of(integration: &Value) -> &str {
    text(integration, "createdByUserId")
}

async fn update_existing(
    ctx: &ProcessContext,
    integration: &Value,
    existing: Value,
    mapped: &Mapped,
    tags: &[String],
) -> Result<Value, StepFail> {
    let fields = writable(Some(&existing), mapped);
    let custom = custom_blob(Some(&existing), mapped);
    let current_tags = tags_of(&existing);
    let merged_tags = (!tags.is_empty()).then(|| {
        let mut seen = HashSet::new();
        current_tags
            .iter()
            .chain(tags.iter())
            .filter(|tag| seen.insert((*tag).clone()))
            .cloned()
            .collect::<Vec<_>>()
    });
    let changed = !fields.is_empty()
        || custom.is_some()
        || merged_tags
            .as_ref()
            .is_some_and(|merged| merged.len() != current_tags.len());
    let id = text(&existing, "id").to_owned();
    remember_entity(
        &ctx.db,
        text(&ctx.response, "id"),
        text(integration, "id"),
        "person",
        &id,
    )
    .await?;
    if !changed {
        return Ok(existing);
    }
    let mut input = fields;
    if let Some(merged) = merged_tags {
        input.insert("tags".to_owned(), json!(merged));
    }
    if let Some(custom) = custom {
        input.insert("customFields".to_owned(), Value::Object(custom));
    }
    let updated = update_person(&ctx.db, &id, &input, None)
        .await
        .map_err(domain_fail)?;
    let row = updated.map_or(existing, |(row, _)| row);
    emit_record_event(
        &ctx.ctx,
        creator_of(integration),
        "person",
        "updated",
        text(&row, "id"),
        &person_event(&row),
    )
    .await;
    Ok(row)
}

async fn upsert_person(
    ctx: &ProcessContext,
    integration: &Value,
    config: &CrmConfig,
    email: &str,
    mapped: &Mapped,
    user_id: &str,
    recorded: Option<&(String, String)>,
) -> Result<Value, StepFail> {
    let by_record = match recorded {
        Some((kind, id)) if kind == "person" => person_by_id(&ctx.db, id).await?,
        _ => None,
    };
    let existing = match by_record {
        Some(row) => Some(row),
        None => find_person_by_email(&ctx.db, email).await?,
    };
    if let Some(existing) = existing {
        return update_existing(ctx, integration, existing, mapped, &config.tags).await;
    }
    let mut input = Map::new();
    input.insert("email".to_owned(), json!(email));
    input.extend(writable(None, mapped));
    input.insert("inCrm".to_owned(), json!(true));
    input.insert("source".to_owned(), json!("weldforms"));
    input.insert("ownerId".to_owned(), json!(user_id));
    if !config.tags.is_empty() {
        input.insert("tags".to_owned(), json!(config.tags));
    }
    if let Some(custom) = custom_blob(None, mapped) {
        input.insert("customFields".to_owned(), Value::Object(custom));
    }
    match create_person_detailed(&ctx.db, &input).await {
        Ok((row, promoted)) => {
            remember_entity(
                &ctx.db,
                text(&ctx.response, "id"),
                text(integration, "id"),
                "person",
                text(&row, "id"),
            )
            .await?;
            emit_record_event(
                &ctx.ctx,
                creator_of(integration),
                "person",
                if promoted { "updated" } else { "created" },
                text(&row, "id"),
                &person_event(&row),
            )
            .await;
            Ok(row)
        }
        // Someone created them between the lookup and the write: update that person.
        Err(DomainError::DuplicateEmail {
            existing_person_id,
            message,
        }) => match person_by_id(&ctx.db, &existing_person_id).await? {
            Some(raced) => update_existing(ctx, integration, raced, mapped, &config.tags).await,
            None => Err(StepFail::Error(message)),
        },
        Err(error) => Err(domain_fail(error)),
    }
}

async fn link_company(db: &PgPool, person_id: &str, company_id: &str) -> FormsResult<()> {
    let linked: Option<String> = sqlx::query_scalar(
        "select id from person_companies \
         where person_id = $1 and company_id = $2 and ended_at is null limit 1",
    )
    .bind(person_id)
    .bind(company_id)
    .fetch_optional(db)
    .await?;
    if linked.is_some() {
        return Ok(());
    }
    let primary: Option<String> = sqlx::query_scalar(
        "select id from person_companies \
         where person_id = $1 and is_primary = true and ended_at is null limit 1",
    )
    .bind(person_id)
    .fetch_optional(db)
    .await?;
    let now = weldsuite_crm_domain::now();
    sqlx::query(
        "insert into person_companies (id, created_at, updated_at, person_id, company_id, is_primary) \
         values ($1, $2::timestamp, $2::timestamp, $3, $4, $5)",
    )
    .bind(weldsuite_kit::generate_id("pc"))
    .bind(&now)
    .bind(person_id)
    .bind(company_id)
    .bind(primary.is_none())
    .execute(db)
    .await?;
    Ok(())
}

async fn add_to_list(
    db: &PgPool,
    list_id: &str,
    person_id: &str,
    user_id: &str,
) -> FormsResult<()> {
    let kind: Option<String> =
        sqlx::query_scalar("select kind from lists where id = $1 and deleted_at is null limit 1")
            .bind(list_id)
            .fetch_optional(db)
            .await?;
    // A list that is gone or holds companies is left alone: the rest of the step still counts.
    if kind.as_deref() != Some("person") {
        return Ok(());
    }
    sqlx::query(
        "insert into list_members (id, list_id, entity_id, added_by) values ($1, $2, $3, $4) \
         on conflict do nothing",
    )
    .bind(weldsuite_kit::generate_id("lm"))
    .bind(list_id)
    .bind(person_id)
    .bind(user_id)
    .execute(db)
    .await?;
    Ok(())
}

// ── Activity ─────────────────────────────────────────────────────────────────

/// The record the activity is about.
enum Target<'a> {
    Person { id: &'a str, name: &'a str },
    Lead { id: &'a str, name: &'a str },
}

/// `logActivity(ctx, integration, target)`: the note on the record, once
/// per response and kind of run.
async fn log_activity(
    ctx: &ProcessContext,
    integration: &Value,
    target: Target<'_>,
) -> Result<(), StepFail> {
    let mode = ctx.params.mode.as_str();
    let response_id = text(&ctx.response, "id");
    let form_id = text(&ctx.form, "id");
    let key = format!("{response_id}:{mode}:{}", text(integration, "id"));
    let existing: Option<String> = sqlx::query_scalar(
        "select id from crm_activities where custom_fields->>'formResponse' = $1 limit 1",
    )
    .bind(&key)
    .fetch_optional(&ctx.db)
    .await
    .map_err(Fail::from)?;
    if existing.is_some() {
        return Ok(());
    }
    let url = response_url(ctx.ctx.env(), form_id, response_id);
    let title = text(&ctx.form, "title");
    let subject = if mode == "update" {
        format!("Updated response to {title}")
    } else {
        format!("Submitted {title}")
    };
    let (related_to, related_id, name) = match &target {
        Target::Lead { id, name } => ("lead", *id, *name),
        Target::Person { id, name } => ("contact", *id, *name),
    };
    let mut input = Map::new();
    input.insert("type".to_owned(), json!("note"));
    input.insert("subject".to_owned(), json!(js_slice(&subject, 255)));
    input.insert("description".to_owned(), json!(url));
    input.insert("relatedTo".to_owned(), json!(related_to));
    input.insert("relatedToId".to_owned(), json!(related_id));
    input.insert("relatedToName".to_owned(), json!(js_slice(name, 255)));
    match &target {
        Target::Person { id, .. } => input.insert("personId".to_owned(), json!(id)),
        Target::Lead { id, .. } => input.insert("leadId".to_owned(), json!(id)),
    };
    input.insert("status".to_owned(), json!("completed"));
    input.insert(
        "customFields".to_owned(),
        json!({ "formResponse": key, "formId": form_id, "responseId": response_id }),
    );
    let creator = creator_of(integration);
    let created = create_activity(&ctx.db, &input, Some(creator))
        .await
        .map_err(domain_fail)?;
    emit_record_event(
        &ctx.ctx,
        creator,
        "activity",
        "created",
        &created.id,
        &created.event_data,
    )
    .await;
    Ok(())
}

// ── Lead ─────────────────────────────────────────────────────────────────────

async fn create_lead_for(
    ctx: &ProcessContext,
    integration: &Value,
    email: &str,
    mapped: &Mapped,
    company_name: Option<&str>,
    user_id: &str,
) -> Result<(String, String), StepFail> {
    let standard = |key: &str| mapped.standard(key).map(|(value, _)| json!(value));
    let mut input = Map::new();
    input.insert("email".to_owned(), json!(email));
    for (to, from) in [
        ("firstName", "firstName"),
        ("lastName", "lastName"),
        ("title", "title"),
        ("phone", "directPhone"),
        ("mobile", "mobilePhone"),
    ] {
        if let Some(value) = standard(from) {
            input.insert(to.to_owned(), value);
        }
    }
    if let Some(company) = company_name {
        input.insert("companyName".to_owned(), json!(company));
    }
    // The lead has no department column: keep what the respondent said where a person reads it.
    if let Some((department, _)) = mapped.standard("department") {
        input.insert(
            "notes".to_owned(),
            json!(format!("Department: {department}")),
        );
    }
    input.insert("source".to_owned(), json!("website"));
    input.insert("channel".to_owned(), json!("weldforms"));
    input.insert(
        "campaign".to_owned(),
        json!(js_slice(text(&ctx.form, "title"), 255)),
    );
    let created = create_lead(&ctx.db, &input, Some(user_id))
        .await
        .map_err(domain_fail)?;
    remember_entity(
        &ctx.db,
        text(&ctx.response, "id"),
        text(integration, "id"),
        "lead",
        &created.id,
    )
    .await?;
    if !mapped.custom.is_empty() {
        // `Object.fromEntries(...)`: a repeated slug keeps its first place and its last value.
        let mut values: Vec<(String, Js)> = Vec::new();
        for custom in &mapped.custom {
            let value = Js::from_jsonb(&custom.value);
            match values
                .iter_mut()
                .find(|(slug, _)| *slug == custom.definition.slug)
            {
                Some(entry) => entry.1 = value,
                None => values.push((custom.definition.slug.clone(), value)),
            }
        }
        let definitions = cfv::definitions(&ctx.db, "lead")
            .await
            .map_err(Fail::from)?;
        cfv::set_values(
            &ctx.db,
            "lead",
            &created.id,
            &values,
            &definitions,
            true,
            false,
        )
        .await
        .map_err(|error| match error {
            cfv::ValuesError::Invalid(message) => StepFail::Error(message),
            cfv::ValuesError::Database(error) => StepFail::Error(error.to_string()),
        })?;
    }
    emit_record_event(
        &ctx.ctx,
        creator_of(integration),
        "lead",
        "created",
        &created.id,
        &created.event_data,
    )
    .await;
    let row = &created.row;
    let name = [row.get("firstName"), row.get("lastName")]
        .into_iter()
        .filter_map(|v| v.and_then(Value::as_str))
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let name = if name.is_empty() {
        email.to_owned()
    } else {
        name
    };
    Ok((created.id, name))
}

// ── The step ─────────────────────────────────────────────────────────────────

/// Everything the run writes, checked before it writes anything.
fn require_permissions(
    access: &CreatorAccess,
    config: &CrmConfig,
    person_exists: bool,
) -> Result<(), CreatorForbidden> {
    if config.target == "lead" {
        access.require("leads:create", "weldcrm", "create leads")?;
    } else if person_exists {
        access.require("people:update", "weldcrm", "update people")?;
    } else {
        access.require("people:create", "weldcrm", "create people")?;
    }
    if config.create_company {
        access.require("companies:create", "weldcrm", "create companies")?;
    }
    if config.list_id.is_some() {
        access.require("companies:update", "weldcrm", "add people to lists")?;
    }
    if config.log_activity {
        access.require("activities:create", "weldcrm", "log activities")?;
    }
    Ok(())
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "a `map_err` callback: the error is owned"
)]
fn domain_fail(error: DomainError) -> StepFail {
    StepFail::Error(error.message())
}

/// `runCrmStep(ctx, integration)`.
pub(crate) async fn run_crm_step(
    ctx: &ProcessContext,
    integration: &Value,
) -> Result<StepResult, String> {
    let Some(config) = crm_config(&integration["config"]) else {
        return Ok(StepResult::Skipped(
            "The CRM integration is not set up correctly".to_owned(),
        ));
    };
    let user_id = creator_of(integration);
    let email = email_answer(
        &ctx.definition,
        &ctx.response["answers"],
        &config.email_field_id,
    );
    if email.is_empty() {
        return Ok(StepResult::Skipped(
            "The response has no email address in the chosen question".to_owned(),
        ));
    }
    match crm_body(ctx, integration, &config, &email, user_id).await {
        Ok(result) => Ok(result),
        Err(StepFail::Forbidden(reason)) => Ok(StepResult::Skipped(reason.0)),
        Err(StepFail::Error(message)) => Err(message),
    }
}

#[allow(clippy::too_many_lines, reason = "the worker's steps, in its order")]
async fn crm_body(
    ctx: &ProcessContext,
    integration: &Value,
    config: &CrmConfig,
    email: &str,
    user_id: &str,
) -> Result<StepResult, StepFail> {
    let access = load_creator_access(&ctx.db, ctx.ctx.env(), user_id).await?;
    let response_id = text(&ctx.response, "id");
    let recorded = recorded_entity(&ctx.db, response_id, text(integration, "id")).await?;

    if config.target == "lead" {
        if let Some((kind, id)) = &recorded
            && kind == "lead"
        {
            let lead: Option<String> = sqlx::query_scalar(
                "select id from crm_leads where id = $1 and deleted_at is null limit 1",
            )
            .bind(id)
            .fetch_optional(&ctx.db)
            .await
            .map_err(Fail::from)?;
            if let Some(lead) = lead {
                return Ok(if ctx.params.mode == "update" {
                    StepResult::Skipped(
                        "A lead is not changed when the response is edited".to_owned(),
                    )
                } else {
                    done("lead", lead)
                });
            }
        }
        require_permissions(&access, config, false)?;
        let mapped = map_answers(ctx, config, "lead").await?;
        let company_name = match (config.create_company, config.company_field_id.as_deref()) {
            (true, Some(field)) => Some(answer_text(
                &ctx.definition,
                &ctx.response["answers"],
                field,
                Some("company"),
            ))
            .filter(|name| !name.is_empty()),
            _ => None,
        };
        let (lead_id, name) = create_lead_for(
            ctx,
            integration,
            email,
            &mapped,
            company_name.as_deref(),
            user_id,
        )
        .await?;
        if config.log_activity {
            log_activity(
                ctx,
                integration,
                Target::Lead {
                    id: &lead_id,
                    name: &name,
                },
            )
            .await?;
        }
        return Ok(done("lead", lead_id));
    }

    let by_record = match &recorded {
        Some((kind, id)) if kind == "person" => person_by_id(&ctx.db, id).await?,
        _ => None,
    };
    let known = match by_record {
        Some(row) => Some(row),
        None => find_person_by_email(&ctx.db, email).await?,
    };
    require_permissions(&access, config, known.is_some())?;

    let mapped = map_answers(ctx, config, "person").await?;
    let person = upsert_person(
        ctx,
        integration,
        config,
        email,
        &mapped,
        user_id,
        recorded.as_ref(),
    )
    .await?;
    let person_id = text(&person, "id").to_owned();
    if config.create_company
        && let Some(company_id) = ensure_company(ctx, config, email, user_id).await?
    {
        link_company(&ctx.db, &person_id, &company_id).await?;
    }
    if let Some(list_id) = &config.list_id {
        add_to_list(&ctx.db, list_id, &person_id, user_id).await?;
    }
    sqlx::query("update form_responses set person_id = $2 where id = $1")
        .bind(response_id)
        .bind(&person_id)
        .execute(&ctx.db)
        .await
        .map_err(Fail::from)?;
    if config.log_activity {
        let name = person["displayName"]
            .as_str()
            .map_or_else(|| email.to_owned(), str::to_owned);
        log_activity(
            ctx,
            integration,
            Target::Person {
                id: &person_id,
                name: &name,
            },
        )
        .await?;
    }
    Ok(done("person", person_id))
}

fn done(entity_type: &str, entity_id: String) -> StepResult {
    StepResult::Done {
        entity_type: Some(entity_type.to_owned()),
        entity_id: Some(entity_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_and_numbers_read_as_javascript_does() {
        assert_eq!(host_of(Some("https://www.acme-corp.com")), "acme-corp.com");
        assert_eq!(host_of(Some("acme-corp.com/about")), "acme-corp.com");
        assert_eq!(host_of(Some("HTTP://User@Acme.COM:8080/x")), "acme.com");
        assert_eq!(host_of(None), "");
        assert_eq!(js_number(" 4,5 ".replacen(',', ".", 1).as_str()), Some(4.5));
        assert_eq!(js_number("0x10"), Some(16.0));
        assert_eq!(js_number("Infinity"), None);
        assert_eq!(js_number("abc"), None);
        assert_eq!(number_json(5.0), json!(5));
        assert_eq!(escape_like("a_b%c"), "a\\_b\\%c");
    }
}
