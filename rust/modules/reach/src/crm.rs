//! `services/crm-handoff.ts`: WeldReach to WeldCRM. A CRM person (and their
//! company) appears when a user adds a thread to the CRM; everything goes
//! through `weldsuite-crm-domain`, so the rows and events are WeldCRM's own.

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{COMPANY_CREATED, OPPORTUNITY_CREATED, PERSON_CREATED};
use weldsuite_crm_domain::DomainError;
use weldsuite_kit::generate_id;
use weldsuite_reach_domain::schemas::{email_domain, is_consumer_email};
use weldsuite_reach_domain::{
    EventSink, ReachError, ReachEvent, ReachResult, iso, js_slice, now, text,
};

/// The prospect side of a hand-off (`CrmProspect`).
pub(crate) struct CrmProspect {
    pub(crate) id: Option<String>,
    pub(crate) email: String,
    pub(crate) first_name: Option<String>,
    pub(crate) last_name: Option<String>,
    pub(crate) company_name: Option<String>,
    pub(crate) title: Option<String>,
}

impl CrmProspect {
    /// `toCrmProspect(prospect)`.
    pub(crate) fn from_row(row: &Value) -> Self {
        let opt = |key: &str| text(row, key).map(str::to_owned);
        Self {
            id: opt("id"),
            email: opt("email").unwrap_or_default(),
            first_name: opt("firstName"),
            last_name: opt("lastName"),
            company_name: opt("companyName"),
            title: opt("title"),
        }
    }
}

/// A `CrmHandoffError` (answered 400 with `{ reason: code }`), or a failure.
pub(crate) enum HandoffError {
    Refused(&'static str, &'static str),
    Failed(ReachError),
}

impl From<ReachError> for HandoffError {
    fn from(error: ReachError) -> Self {
        Self::Failed(error)
    }
}

impl From<sqlx::Error> for HandoffError {
    fn from(error: sqlx::Error) -> Self {
        Self::Failed(error.into())
    }
}

#[allow(clippy::needless_pass_by_value)] // used as a `map_err` function
fn crm_failure(error: DomainError) -> HandoffError {
    HandoffError::Failed(ReachError::unexpected(&format!("{error:?}")))
}

/// `isValidWorkspaceMember(db, userId)`.
async fn is_member(db: &PgPool, user_id: &str) -> ReachResult<bool> {
    let row: Option<String> = sqlx::query_scalar(
        "select user_id from workspace_members where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(row.is_some())
}

/// `resolveCrmOwner(db, campaign)`: the owner, else the creator, if a member.
pub(crate) async fn resolve_owner(
    db: &PgPool,
    campaign: Option<&Value>,
) -> ReachResult<Option<String>> {
    for key in ["ownerId", "createdBy"] {
        if let Some(candidate) = campaign
            .and_then(|c| text(c, key))
            .filter(|c| !c.is_empty())
            && is_member(db, candidate).await?
        {
            return Ok(Some(candidate.to_owned()));
        }
    }
    Ok(None)
}

/// `hostOf(website)`.
fn host_of(website: Option<&str>) -> String {
    let Some(website) = website else {
        return String::new();
    };
    let trimmed = weldsuite_reach_domain::text::js_trim(website).to_lowercase();
    let without_scheme = match trimmed.find("://") {
        Some(at)
            if at > 0
                && trimmed[..at].starts_with(|c: char| c.is_ascii_lowercase())
                && trimmed[..at].chars().all(|c| {
                    c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '.' | '-')
                }) =>
        {
            &trimmed[at + 3..]
        }
        _ => trimmed.as_str(),
    };
    let host = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    host.strip_prefix("www.").unwrap_or(host).to_owned()
}

fn title_case_domain_name(domain: &str) -> String {
    let label = domain.split('.').next().unwrap_or(domain);
    let mut chars = label.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

async fn find_company(
    db: &PgPool,
    domain: &str,
    name: Option<&str>,
) -> ReachResult<Option<(String, String)>> {
    if !domain.is_empty() && !is_consumer_email(&format!("x@{domain}")) {
        let candidates: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "select id, name, website from companies where deleted_at is null and lower(website) like $1 limit 25",
        )
        .bind(format!("%{domain}%"))
        .fetch_all(db)
        .await?;
        if let Some((id, name, _)) = candidates
            .into_iter()
            .find(|(_, _, w)| host_of(w.as_deref()) == domain)
        {
            return Ok(Some((id, name)));
        }
    }
    if let Some(name) = name
        .map(weldsuite_reach_domain::text::js_trim)
        .filter(|n| !n.is_empty())
    {
        let found: Option<(String, String)> = sqlx::query_as(
            "select id, name from companies where deleted_at is null and lower(name) = $1 limit 1",
        )
        .bind(name.to_lowercase())
        .fetch_optional(db)
        .await?;
        return Ok(found);
    }
    Ok(None)
}

async fn create_company_row(
    db: &PgPool,
    sink: &dyn EventSink,
    name: &str,
    domain: Option<&str>,
    owner: Option<&str>,
) -> Result<(String, bool), HandoffError> {
    let mut input = Map::new();
    input.insert("name".to_owned(), json!(js_slice(name, 255)));
    if let Some(domain) = domain {
        input.insert("website".to_owned(), json!(format!("https://{domain}")));
    }
    input.insert("source".to_owned(), json!("weldreach"));
    if let Some(owner) = owner {
        input.insert("ownerId".to_owned(), json!(owner));
    }
    let created = weldsuite_crm_domain::companies::create_company(db, &input, None)
        .await
        .map_err(crm_failure)?;
    let id = text(&created, "id").unwrap_or_default().to_owned();
    sink.emit(ReachEvent::new(
        COMPANY_CREATED,
        &id,
        json!({
            "id": id,
            "name": created.get("name"),
            "website": created.get("website"),
            "industry": created.get("industry"),
        }),
    ));
    Ok((id, true))
}

/// `ensureCompany(ctx, prospect, owner, { forceCreate })`: (id, created).
async fn ensure_company(
    db: &PgPool,
    sink: &dyn EventSink,
    prospect: &CrmProspect,
    owner: Option<&str>,
    force_create: bool,
) -> Result<Option<(String, bool)>, HandoffError> {
    let domain = email_domain(&prospect.email);
    if let Some((id, _)) = find_company(db, &domain, prospect.company_name.as_deref()).await? {
        return Ok(Some((id, false)));
    }
    let consumer = is_consumer_email(&prospect.email);
    if consumer && !force_create {
        return Ok(None);
    }
    if prospect.company_name.as_deref().is_none_or(str::is_empty) && consumer {
        let person = [
            prospect.first_name.as_deref(),
            prospect.last_name.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
        let name = if person.is_empty() {
            prospect.email.clone()
        } else {
            person
        };
        return create_company_row(db, sink, &name, None, owner)
            .await
            .map(Some);
    }
    let name = prospect
        .company_name
        .as_deref()
        .map(weldsuite_reach_domain::text::js_trim)
        .filter(|n| !n.is_empty())
        .map_or_else(|| title_case_domain_name(&domain), str::to_owned);
    create_company_row(
        db,
        sink,
        &name,
        (!consumer).then_some(domain.as_str()),
        owner,
    )
    .await
    .map(Some)
}

async fn link_person_to_company(db: &PgPool, person_id: &str, company_id: &str) -> ReachResult<()> {
    let links: Vec<(String, Option<bool>, Option<String>)> = sqlx::query_as(
        "select company_id, is_primary, ended_at::text from person_companies where person_id = $1",
    )
    .bind(person_id)
    .fetch_all(db)
    .await?;
    let active: Vec<&(String, Option<bool>, Option<String>)> =
        links.iter().filter(|l| l.2.is_none()).collect();
    if active.iter().any(|l| l.0 == company_id) {
        return Ok(());
    }
    let at = iso(now());
    sqlx::query(
        "insert into person_companies (id, created_at, updated_at, person_id, company_id, is_primary)
         values ($1, $2::timestamptz, $2::timestamptz, $3, $4, $5)",
    )
    .bind(generate_id("pc"))
    .bind(&at)
    .bind(person_id)
    .bind(company_id)
    .bind(!active.iter().any(|l| l.1 == Some(true)))
    .execute(db)
    .await?;
    Ok(())
}

/// `ensurePerson(ctx, prospect, owner, companyId)`: (id, created).
async fn ensure_person(
    db: &PgPool,
    sink: &dyn EventSink,
    acting_user: Option<&str>,
    prospect: &CrmProspect,
    owner: Option<&str>,
    company_id: Option<&str>,
) -> Result<(String, bool), HandoffError> {
    let existing: Option<(String, Option<bool>)> = sqlx::query_as(
        "select id, in_crm from people where lower(email) = $1 and deleted_at is null limit 1",
    )
    .bind(prospect.email.to_lowercase())
    .fetch_optional(db)
    .await?;
    if let Some((id, in_crm)) = existing {
        if in_crm != Some(true) {
            weldsuite_crm_domain::people::add_person_to_crm(db, &id, owner.or(acting_user), None)
                .await
                .map_err(crm_failure)?;
        }
        return Ok((id, false));
    }
    let mut input = Map::new();
    input.insert("email".to_owned(), json!(prospect.email));
    for (key, value) in [
        ("firstName", &prospect.first_name),
        ("lastName", &prospect.last_name),
        ("title", &prospect.title),
    ] {
        if let Some(value) = value {
            input.insert(key.to_owned(), json!(value));
        }
    }
    input.insert("source".to_owned(), json!("weldreach"));
    input.insert("inCrm".to_owned(), json!(true));
    if let Some(owner) = owner {
        input.insert("ownerId".to_owned(), json!(owner));
    }
    if let Some(company_id) = company_id {
        input.insert("companyIds".to_owned(), json!([company_id]));
        input.insert("primaryCompanyId".to_owned(), json!(company_id));
    }
    match weldsuite_crm_domain::people::create_person_detailed(db, &input).await {
        Ok((row, _)) => {
            let id = text(&row, "id").unwrap_or_default().to_owned();
            sink.emit(ReachEvent::new(
                PERSON_CREATED,
                &id,
                json!({
                    "id": id,
                    "firstName": row.get("firstName"),
                    "lastName": row.get("lastName"),
                    "fullName": row.get("fullName"),
                    "displayName": row.get("displayName"),
                    "email": row.get("email"),
                    "title": row.get("title"),
                }),
            ));
            Ok((id, true))
        }
        Err(DomainError::DuplicateEmail {
            existing_person_id, ..
        }) => Ok((existing_person_id, false)),
        Err(error) => Err(crm_failure(error)),
    }
}

/// `ensureCrmContact(ctx, prospect, campaign, { forceCompany })`:
/// (person id, company id).
async fn ensure_contact(
    db: &PgPool,
    sink: &dyn EventSink,
    acting_user: Option<&str>,
    prospect: &CrmProspect,
    campaign: Option<&Value>,
    force_company: bool,
) -> Result<(String, Option<String>), HandoffError> {
    let owner = resolve_owner(db, campaign).await?;
    let company = ensure_company(db, sink, prospect, owner.as_deref(), force_company).await?;
    let (person_id, created) = ensure_person(
        db,
        sink,
        acting_user,
        prospect,
        owner.as_deref(),
        company.as_ref().map(|(id, _)| id.as_str()),
    )
    .await?;
    if let Some((company_id, _)) = &company
        && !created
    {
        link_person_to_company(db, &person_id, company_id).await?;
    }
    if let Some(prospect_id) = &prospect.id {
        sqlx::query(
            "update reach_prospects set person_id = $2, updated_at = $3::timestamptz where id = $1 and person_id is null",
        )
        .bind(prospect_id)
        .bind(&person_id)
        .bind(iso(now()))
        .execute(db)
        .await?;
    }
    Ok((person_id, company.map(|(id, _)| id)))
}

/// The opportunity a user asked for (`reachAddToCrmSchema.opportunity`).
pub(crate) struct OpportunityInput {
    pub(crate) pipeline_id: String,
    pub(crate) stage_id: String,
    pub(crate) name: Option<String>,
}

/// `addThreadToCrm(ctx, input)`: (person id, opportunity id).
pub(crate) async fn add_thread_to_crm(
    db: &PgPool,
    sink: &dyn EventSink,
    acting_user: &str,
    prospect: Option<&Value>,
    sender_email: &str,
    campaign: Option<&Value>,
    opportunity: Option<&OpportunityInput>,
) -> Result<(String, Option<String>), HandoffError> {
    let stage = match opportunity {
        Some(input) => {
            let stage = weldsuite_crm_domain::opportunities::load_stage(db, &input.stage_id)
                .await
                .map_err(crm_failure)?;
            let Some(stage) = stage else {
                return Err(HandoffError::Refused(
                    "UNKNOWN_STAGE",
                    "Unknown pipeline stage",
                ));
            };
            if stage
                .pipeline
                .as_deref()
                .is_some_and(|p| !p.is_empty() && p != input.pipeline_id)
            {
                return Err(HandoffError::Refused(
                    "STAGE_PIPELINE_MISMATCH",
                    "The stage does not belong to that pipeline",
                ));
            }
            Some(stage)
        }
        None => None,
    };
    let prospect = match prospect {
        Some(row) => CrmProspect::from_row(row),
        None => CrmProspect {
            id: None,
            email: sender_email.to_owned(),
            first_name: None,
            last_name: None,
            company_name: None,
            title: None,
        },
    };
    let (person_id, company_id) = ensure_contact(
        db,
        sink,
        Some(acting_user),
        &prospect,
        campaign,
        opportunity.is_some(),
    )
    .await?;
    let (Some(input), Some(stage)) = (opportunity, stage) else {
        return Ok((person_id, None));
    };
    let Some(company_id) = company_id else {
        return Err(HandoffError::Refused(
            "NO_COMPANY",
            "An opportunity needs a company",
        ));
    };
    let owner = resolve_owner(db, campaign)
        .await?
        .unwrap_or_else(|| acting_user.to_owned());
    let person_name = [
        prospect.first_name.as_deref(),
        prospect.last_name.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter(|p| !p.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    let person_name = if person_name.is_empty() {
        prospect.email.clone()
    } else {
        person_name
    };
    let suffix = campaign
        .and_then(|c| text(c, "name"))
        .map(|name| format!(" ({name})"))
        .unwrap_or_default();
    let default_name = format!(
        "{}{suffix}",
        prospect.company_name.clone().unwrap_or(person_name)
    );
    let mut fields = Map::new();
    fields.insert(
        "name".to_owned(),
        json!(js_slice(
            input.name.as_deref().unwrap_or(&default_name),
            255
        )),
    );
    fields.insert("customerId".to_owned(), json!(company_id));
    fields.insert("primaryContactId".to_owned(), json!(person_id));
    fields.insert("stage".to_owned(), json!(stage.id));
    fields.insert("stageId".to_owned(), json!(stage.id));
    fields.insert(
        "pipeline".to_owned(),
        json!(
            stage
                .pipeline
                .clone()
                .unwrap_or_else(|| input.pipeline_id.clone())
        ),
    );
    fields.insert("leadSource".to_owned(), json!("weldreach"));
    fields.insert("ownerId".to_owned(), json!(owner));
    let created =
        weldsuite_crm_domain::opportunities::create_opportunity(db, &fields, Some(acting_user))
            .await
            .map_err(crm_failure)?;
    sink.emit(ReachEvent::new(
        OPPORTUNITY_CREATED,
        &created.id,
        created.event_data.clone(),
    ));
    Ok((person_id, Some(created.id)))
}
