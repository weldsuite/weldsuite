//! Auto-add to WeldCRM: a workspace setting that puts the people the
//! workspace really deals with into the CRM by itself.
//!
//! Other modules already keep everyone they meet in `people`: every address
//! on a received or sent email, every WeldMeet guest, every WeldDesk
//! requester. Those rows are created with `in_crm = false`, so they stay out
//! of WeldCRM until someone clicks "Add to CRM". With auto-add on, a module
//! calls [`add`] at the moment the workspace has engaged with a person (it
//! emailed them or they answered an email it sent, they joined a meeting, an
//! agent replied to their ticket), and the person is added as if someone had
//! clicked the button: `in_crm` on, the engaging member as owner when the
//! person has none, `person:updated` (or `person:created`) published.
//!
//! Never added: workspace members, addresses on the workspace's own domains
//! (the domains of its members and mail accounts, free mail providers
//! aside) and automated senders (`noreply@`, `mailer-daemon@`, …).
//!
//! With `createCompanies` on, the person is also linked to the company of
//! their email domain (`jan@acme.com` → Acme, matched on the company's
//! website), which is created when the workspace has none. Free mail domains
//! never become companies.
//!
//! The setting is `workspace_settings.custom_settings.crm.autoAdd` (next to
//! `sso` and `social`), read and written by `/api/crm-settings`.

use std::collections::HashSet;

use sea_orm::sea_query::{Expr, ExprTrait, Func};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{
    COMPANY_CREATED, COMPANY_UPDATED, CONTACT_LINK_CREATED, PERSON_CREATED, PERSON_UPDATED,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    companies, mail_accounts, people, person_companies, workspace_members, workspace_settings,
};

use crate::events::OrderedEvents;
use crate::{DomainError, DomainResult};

/// The key under `custom_settings` that holds the CRM's settings.
const SETTINGS_KEY: &str = "crm";
/// The key under `custom_settings.crm` that holds auto-add.
const AUTO_ADD_KEY: &str = "autoAdd";

// ── Settings ─────────────────────────────────────────────────────────────────

/// Where the people come from; each can be switched off on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// WeldMail: people the workspace emailed, or who answered its email.
    Email,
    /// WeldMeet: external guests who joined a meeting.
    Meetings,
    /// WeldDesk: requesters an agent has replied to.
    Helpdesk,
}

impl Source {
    pub const ALL: [Self; 3] = [Self::Email, Self::Meetings, Self::Helpdesk];

    /// The key in `sources`.
    pub fn key(self) -> &'static str {
        match self {
            Self::Email => "email",
            Self::Meetings => "meetings",
            Self::Helpdesk => "helpdesk",
        }
    }

    /// `people.source` / `companies.source` of the rows it creates.
    fn record_source(self) -> &'static str {
        match self {
            Self::Email => "weldmail",
            Self::Meetings => "weldmeet",
            Self::Helpdesk => "welddesk",
        }
    }
}

/// `custom_settings.crm.autoAdd`. Off by default; once on, every source is
/// on unless switched off.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Settings {
    pub enabled: bool,
    pub create_companies: bool,
    pub sources: Sources,
}

/// Which sources add people (`autoAdd.sources`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sources {
    pub email: bool,
    pub meetings: bool,
    pub helpdesk: bool,
}

impl Default for Sources {
    fn default() -> Self {
        Self {
            email: true,
            meetings: true,
            helpdesk: true,
        }
    }
}

impl Sources {
    fn get(self, source: Source) -> bool {
        match source {
            Source::Email => self.email,
            Source::Meetings => self.meetings,
            Source::Helpdesk => self.helpdesk,
        }
    }
}

/// `value` when it is a boolean, else `fallback`.
fn flag(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

impl Settings {
    /// The stored object over the defaults; anything not a boolean reads as
    /// the default.
    pub fn from_stored(stored: Option<&Value>) -> Self {
        let defaults = Self::default();
        let field = |key: &str| stored.and_then(|s| s.get(key));
        let source =
            |key: &str, fallback: bool| flag(field("sources").and_then(|s| s.get(key)), fallback);
        Self {
            enabled: flag(field("enabled"), defaults.enabled),
            create_companies: flag(field("createCompanies"), defaults.create_companies),
            sources: Sources {
                email: source("email", defaults.sources.email),
                meetings: source("meetings", defaults.sources.meetings),
                helpdesk: source("helpdesk", defaults.sources.helpdesk),
            },
        }
    }

    /// The API's and the stored shape.
    pub fn to_json(&self) -> Value {
        json!({
            "enabled": self.enabled,
            "createCompanies": self.create_companies,
            "sources": {
                "email": self.sources.email,
                "meetings": self.sources.meetings,
                "helpdesk": self.sources.helpdesk,
            },
        })
    }

    /// Whether people from `source` are added.
    pub fn covers(&self, source: Source) -> bool {
        self.enabled && self.sources.get(source)
    }

    /// These settings with the keys `patch` gives (the PUT body's
    /// `autoAdd`, already validated).
    #[must_use]
    pub fn merged(&self, patch: &Patch) -> Self {
        Self {
            enabled: patch.enabled.unwrap_or(self.enabled),
            create_companies: patch.create_companies.unwrap_or(self.create_companies),
            sources: Sources {
                email: patch.email.unwrap_or(self.sources.email),
                meetings: patch.meetings.unwrap_or(self.sources.meetings),
                helpdesk: patch.helpdesk.unwrap_or(self.sources.helpdesk),
            },
        }
    }

    /// The patch that sets every key to these settings' value.
    pub fn as_patch(&self) -> Patch {
        Patch {
            enabled: Some(self.enabled),
            create_companies: Some(self.create_companies),
            email: Some(self.sources.email),
            meetings: Some(self.sources.meetings),
            helpdesk: Some(self.sources.helpdesk),
        }
    }
}

/// The keys a PUT changes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Patch {
    pub enabled: Option<bool>,
    pub create_companies: Option<bool>,
    pub email: Option<bool>,
    pub meetings: Option<bool>,
    pub helpdesk: Option<bool>,
}

/// A settings row's id and `custom_settings`: all auto-add reads, so it
/// never depends on the row's other columns.
type SettingsRow = (String, Option<Value>);

/// The workspace's settings rows, oldest first.
async fn settings_rows(db: &PgPool) -> DomainResult<Vec<SettingsRow>> {
    Ok(workspace_settings::Entity::find()
        .select_only()
        .column(workspace_settings::Column::Id)
        .column(workspace_settings::Column::CustomSettings)
        .filter(workspace_settings::Column::DeletedAt.is_null())
        .order_by_asc(workspace_settings::Column::CreatedAt)
        .order_by_asc(workspace_settings::Column::Id)
        .into_tuple()
        .all(&orm(db))
        .await?)
}

fn crm_section(row: &SettingsRow) -> Option<&Value> {
    row.1
        .as_ref()
        .and_then(|custom| custom.get(SETTINGS_KEY))
        .filter(|crm| crm.is_object())
}

/// The row that holds the CRM's settings: the oldest with a `crm` object,
/// else the oldest.
fn settings_row(rows: &[SettingsRow]) -> Option<&SettingsRow> {
    rows.iter()
        .find(|row| crm_section(row).is_some())
        .or_else(|| rows.first())
}

/// The workspace's auto-add settings.
///
/// # Errors
///
/// The tenant database's.
pub async fn load_settings(db: &PgPool) -> DomainResult<Settings> {
    let rows = settings_rows(db).await?;
    let stored = settings_row(&rows)
        .and_then(crm_section)
        .and_then(|crm| crm.get(AUTO_ADD_KEY));
    Ok(Settings::from_stored(stored))
}

/// Merges `patch` into the stored settings; returns the result and the id of
/// the settings row. The workspace's settings row gets
/// `custom_settings.crm.autoAdd`; without a row, one is created with id
/// `new_row_id`.
///
/// # Errors
///
/// The tenant database's.
pub async fn save_settings(
    db: &PgPool,
    patch: &Patch,
    new_row_id: &str,
) -> DomainResult<(Settings, String)> {
    let rows = settings_rows(db).await?;
    let row = settings_row(&rows);
    let current = Settings::from_stored(
        row.and_then(crm_section)
            .and_then(|crm| crm.get(AUTO_ADD_KEY)),
    );
    let next = current.merged(patch);
    let now = OffsetDateTime::now_utc();
    let row_id = row.map_or_else(|| new_row_id.to_owned(), |row| row.0.clone());
    if let Some((id, stored)) = row {
        let mut custom = match stored.clone() {
            Some(Value::Object(custom)) => custom,
            _ => Map::new(),
        };
        let mut crm = match custom.remove(SETTINGS_KEY) {
            Some(Value::Object(crm)) => crm,
            _ => Map::new(),
        };
        crm.insert(AUTO_ADD_KEY.to_owned(), next.to_json());
        custom.insert(SETTINGS_KEY.to_owned(), Value::Object(crm));
        workspace_settings::Entity::update_many()
            .col_expr(
                workspace_settings::Column::CustomSettings,
                Expr::value(Value::Object(custom)),
            )
            .col_expr(workspace_settings::Column::UpdatedAt, Expr::value(now))
            .filter(workspace_settings::Column::Id.eq(id))
            .exec(&orm(db))
            .await?;
    } else {
        let active = workspace_settings::ActiveModel {
            id: sea_orm::ActiveValue::Set(new_row_id.to_owned()),
            custom_settings: sea_orm::ActiveValue::Set(Some(
                json!({ SETTINGS_KEY: { AUTO_ADD_KEY: next.to_json() } }),
            )),
            created_at: sea_orm::ActiveValue::Set(now),
            updated_at: sea_orm::ActiveValue::Set(now),
            ..Default::default()
        };
        workspace_settings::Entity::insert(active)
            .exec_without_returning(&orm(db))
            .await?;
    }
    Ok((next, row_id))
}

// ── Who is never added ───────────────────────────────────────────────────────

/// Free mail providers: their domain says nothing about the person's
/// company, and they are never the workspace's own domain.
pub const FREE_MAIL_DOMAINS: &[&str] = &[
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "outlook.nl",
    "hotmail.com",
    "hotmail.nl",
    "hotmail.co.uk",
    "live.com",
    "live.nl",
    "msn.com",
    "yahoo.com",
    "yahoo.co.uk",
    "yahoo.fr",
    "yahoo.de",
    "ymail.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "aol.com",
    "gmx.com",
    "gmx.de",
    "gmx.net",
    "web.de",
    "proton.me",
    "protonmail.com",
    "pm.me",
    "zoho.com",
    "mail.com",
    "yandex.com",
    "yandex.ru",
    "fastmail.com",
    "hey.com",
    "ziggo.nl",
    "kpnmail.nl",
    "kpnplanet.nl",
    "planet.nl",
    "home.nl",
    "xs4all.nl",
    "telenet.be",
    "skynet.be",
    "orange.fr",
    "free.fr",
    "laposte.net",
    "t-online.de",
    "freenet.de",
    "libero.it",
    "qq.com",
    "163.com",
    "naver.com",
];

/// Local parts of automated senders. `bounce+abc@` counts as `bounce@`.
const AUTOMATED_LOCAL_PARTS: &[&str] = &[
    "noreply",
    "no-reply",
    "no_reply",
    "donotreply",
    "do-not-reply",
    "do_not_reply",
    "mailer-daemon",
    "mailerdaemon",
    "postmaster",
    "bounce",
    "bounces",
    "notification",
    "notifications",
    "notify",
    "alerts",
    "newsletter",
    "unsubscribe",
    "auto-confirm",
    "autoreply",
    "auto-reply",
];

/// The address trimmed and lowercased, when it is one.
pub fn normalize_email(raw: &str) -> Option<String> {
    let email = raw.trim().to_lowercase();
    let (local, domain) = email.rsplit_once('@')?;
    if local.is_empty() || domain.is_empty() || !domain.contains('.') || email.len() > 255 {
        return None;
    }
    Some(email)
}

/// The domain of a normalized address.
fn domain_of(email: &str) -> &str {
    email.rsplit_once('@').map_or("", |(_, domain)| domain)
}

/// Whether the domain is a free mail provider's.
pub fn is_free_mail_domain(domain: &str) -> bool {
    FREE_MAIL_DOMAINS.contains(&domain)
}

/// Whether a normalized address is an automated sender's.
pub fn is_automated(email: &str) -> bool {
    let local = email.rsplit_once('@').map_or(email, |(local, _)| local);
    let base = local.split('+').next().unwrap_or(local);
    AUTOMATED_LOCAL_PARTS.contains(&base)
        || [
            "noreply",
            "no-reply",
            "donotreply",
            "do-not-reply",
            "mailer-daemon",
        ]
        .iter()
        .any(|part| base.contains(part))
}

/// Second-level suffixes under which the company name is the third label
/// from the right (`acme.co.uk`).
const SECOND_LEVEL_SUFFIXES: &[&str] = &[
    "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "com.au", "net.au", "org.au",
    "co.nz", "co.za", "com.br", "com.mx", "com.ar", "co.jp", "co.kr", "com.cn", "com.hk", "com.sg",
    "com.tr", "co.in", "co.il", "com.pl", "com.es", "com.pt",
];

/// The registrable domain of a host: `mail.acme.co.uk` → `acme.co.uk`,
/// `eu.acme.com` → `acme.com`.
pub fn registrable_domain(host: &str) -> String {
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    let keep = match labels.as_slice() {
        [.., second, last]
            if SECOND_LEVEL_SUFFIXES.contains(&format!("{second}.{last}").as_str()) =>
        {
            3
        }
        _ => 2,
    };
    labels[labels.len().saturating_sub(keep)..].join(".")
}

/// The company name a domain suggests: `acme.co.uk` → `Acme`.
pub fn company_name_for(domain: &str) -> String {
    let registrable = registrable_domain(domain);
    let label = registrable.split('.').next().unwrap_or(&registrable);
    let mut chars = label.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// The host of a website as people type it: `https://www.Acme.com/about` →
/// `acme.com`.
pub fn website_host(website: &str) -> String {
    let trimmed = website.trim().to_lowercase();
    let without_scheme = trimmed
        .split_once("://")
        .map_or(trimmed.as_str(), |(_, rest)| rest);
    let host = without_scheme
        .split(['/', '?', '#', ':'])
        .next()
        .unwrap_or_default();
    host.strip_prefix("www.").unwrap_or(host).to_owned()
}

/// The workspace's own people and domains.
#[derive(Debug, Default)]
struct Internal {
    member_ids: HashSet<String>,
    emails: HashSet<String>,
    domains: HashSet<String>,
}

impl Internal {
    async fn load(db: &PgPool) -> DomainResult<Self> {
        let members: Vec<(String, Option<String>)> = workspace_members::Entity::find()
            .select_only()
            .column(workspace_members::Column::UserId)
            .column(workspace_members::Column::Email)
            .filter(workspace_members::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&orm(db))
            .await?;
        let accounts: Vec<String> = mail_accounts::Entity::find()
            .select_only()
            .column(mail_accounts::Column::Email)
            .filter(mail_accounts::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&orm(db))
            .await?;
        let mut internal = Self::default();
        for (user_id, email) in members {
            internal.member_ids.insert(user_id);
            if let Some(email) = email.as_deref().and_then(normalize_email) {
                internal.add(email);
            }
        }
        for email in accounts.iter().filter_map(|e| normalize_email(e)) {
            internal.add(email);
        }
        Ok(internal)
    }

    fn add(&mut self, email: String) {
        let domain = domain_of(&email).to_owned();
        if !is_free_mail_domain(&domain) {
            self.domains.insert(registrable_domain(&domain));
        }
        self.emails.insert(email);
    }

    fn excludes(&self, email: &str) -> bool {
        self.emails.contains(email) || self.domains.contains(&registrable_domain(domain_of(email)))
    }
}

// ── Adding ───────────────────────────────────────────────────────────────────

/// Someone the workspace engaged with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub email: String,
    pub name: Option<String>,
}

impl Candidate {
    pub fn new(email: &str, name: Option<&str>) -> Self {
        Self {
            email: email.to_owned(),
            name: name.map(str::to_owned),
        }
    }
}

/// A person [`add`] put in the CRM.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Added {
    pub person_id: String,
    /// A new row (no hidden row had the address).
    pub created: bool,
    pub company_id: Option<String>,
    pub company_created: bool,
}

/// Adds the candidates to WeldCRM when the workspace's auto-add covers
/// `source`. `owner` (a member's user id) owns the people and companies that
/// have no owner yet. Skips members, the workspace's own domains, automated
/// senders and people already in the CRM. Publishes the entity events of
/// every write on `events`.
///
/// # Errors
///
/// The tenant database's, and the CRM services'.
pub async fn add(
    db: &PgPool,
    events: &OrderedEvents,
    source: Source,
    candidates: &[Candidate],
    owner: Option<&str>,
) -> DomainResult<Vec<Added>> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let settings = load_settings(db).await?;
    if !settings.covers(source) {
        return Ok(Vec::new());
    }
    let internal = Internal::load(db).await?;
    let owner = owner.filter(|o| internal.member_ids.contains(*o));
    let mut seen = HashSet::new();
    let mut added = Vec::new();
    for candidate in candidates {
        let Some(email) = normalize_email(&candidate.email) else {
            continue;
        };
        if !seen.insert(email.clone()) || is_automated(&email) || internal.excludes(&email) {
            continue;
        }
        if let Some(person) =
            add_one(db, events, source, &settings, &email, candidate, owner).await?
        {
            added.push(person);
        }
    }
    Ok(added)
}

/// [`add`] for callers whose own work must not fail on it: errors are logged.
pub async fn add_logged(
    db: &PgPool,
    events: &OrderedEvents,
    source: Source,
    candidates: &[Candidate],
    owner: Option<&str>,
) {
    if let Err(error) = add(db, events, source, candidates, owner).await {
        tracing::error!(error = %error.message(), source = source.key(), "[crm-auto-add] failed");
    }
}

/// The live person with this address: `(id, in CRM)`.
async fn find_person(db: &PgPool, email: &str) -> DomainResult<Option<(String, bool)>> {
    Ok(people::Entity::find()
        .select_only()
        .column(people::Column::Id)
        .column(people::Column::InCrm)
        .filter(people::Column::DeletedAt.is_null())
        .filter(Func::lower(Expr::col(people::Column::Email)).eq(email))
        .order_by_asc(people::Column::CreatedAt)
        .into_tuple()
        .one(&orm(db))
        .await?)
}

fn split_name(email: &str, name: Option<&str>) -> (Option<String>, Option<String>) {
    let name = name
        .map(str::trim)
        .filter(|n| !n.is_empty() && !n.contains('@'));
    if let Some(name) = name {
        let tokens: Vec<&str> = name.split_whitespace().collect();
        return match tokens.as_slice() {
            [] => (None, None),
            [one] => (Some((*one).to_owned()), None),
            [rest @ .., last] => (Some(rest.join(" ")), Some((*last).to_owned())),
        };
    }
    let local = email.split('@').next().unwrap_or(email);
    (Some(local.to_owned()), None)
}

fn pick(row: &Value, keys: &[&str]) -> Value {
    let mut data = Map::new();
    for key in keys {
        data.insert(
            (*key).to_owned(),
            row.get(*key).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(data)
}

const PERSON_EVENT_KEYS: [&str; 7] = [
    "id",
    "firstName",
    "lastName",
    "fullName",
    "displayName",
    "email",
    "title",
];

async fn add_one(
    db: &PgPool,
    events: &OrderedEvents,
    source: Source,
    settings: &Settings,
    email: &str,
    candidate: &Candidate,
    owner: Option<&str>,
) -> DomainResult<Option<Added>> {
    // The person first: someone already in the CRM is left alone, and so is
    // their company, which must not be created for nobody.
    let person_id = match find_person(db, email).await? {
        Some((_, true)) => return Ok(None),
        Some((id, false)) => {
            if !promote(db, events, &id, owner).await? {
                return Ok(None);
            }
            id
        }
        None => {
            // A new person is created linked to their company.
            let company = company_for(db, events, source, settings, email, owner).await?;
            return match create_person(
                db,
                events,
                source,
                email,
                candidate,
                owner,
                company.as_ref(),
            )
            .await?
            {
                Created::New(id) => Ok(Some(Added {
                    person_id: id,
                    created: true,
                    company_id: company.as_ref().map(|(id, _)| id.clone()),
                    company_created: company.is_some_and(|(_, created)| created),
                })),
                // Someone else's write won: add theirs, with the company
                // this run may just have created.
                Created::Raced(id) => {
                    promote(db, events, &id, owner).await?;
                    if let Some((company_id, _)) = &company {
                        link_to_company(db, events, &id, company_id).await?;
                    }
                    Ok(Some(Added {
                        person_id: id,
                        created: false,
                        company_id: company.as_ref().map(|(id, _)| id.clone()),
                        company_created: company.is_some_and(|(_, created)| created),
                    }))
                }
            };
        }
    };
    let company = company_for(db, events, source, settings, email, owner).await?;
    if let Some((company_id, _)) = &company {
        link_to_company(db, events, &person_id, company_id).await?;
    }
    Ok(Some(Added {
        person_id,
        created: false,
        company_id: company.as_ref().map(|(id, _)| id.clone()),
        company_created: company.is_some_and(|(_, created)| created),
    }))
}

/// The company of the address's domain when the settings add companies.
async fn company_for(
    db: &PgPool,
    events: &OrderedEvents,
    source: Source,
    settings: &Settings,
    email: &str,
    owner: Option<&str>,
) -> DomainResult<Option<(String, bool)>> {
    if settings.create_companies {
        ensure_company(db, events, source, email, owner).await
    } else {
        Ok(None)
    }
}

/// Puts a hidden person in the CRM as **Add to CRM** does; `false` when
/// they are gone.
async fn promote(
    db: &PgPool,
    events: &OrderedEvents,
    id: &str,
    owner: Option<&str>,
) -> DomainResult<bool> {
    let Some(row) = crate::people::add_person_to_crm(db, id, owner, None).await? else {
        return Ok(false);
    };
    events.publish(PERSON_UPDATED, id, pick(&row, &["id", "displayName"]));
    Ok(true)
}

/// What [`create_person`] did.
enum Created {
    New(String),
    /// A person with the address appeared meanwhile: their id.
    Raced(String),
}

/// A new person in the CRM, linked to `company` when there is one.
async fn create_person(
    db: &PgPool,
    events: &OrderedEvents,
    source: Source,
    email: &str,
    candidate: &Candidate,
    owner: Option<&str>,
    company: Option<&(String, bool)>,
) -> DomainResult<Created> {
    let (first, last) = split_name(email, candidate.name.as_deref());
    let mut input = Map::new();
    input.insert("email".to_owned(), json!(email));
    if let Some(first) = first {
        input.insert("firstName".to_owned(), json!(first));
    }
    if let Some(last) = last {
        input.insert("lastName".to_owned(), json!(last));
    }
    input.insert("inCrm".to_owned(), json!(true));
    input.insert("source".to_owned(), json!(source.record_source()));
    if let Some(owner) = owner {
        input.insert("ownerId".to_owned(), json!(owner));
    }
    if let Some((company_id, _)) = company {
        input.insert("companyIds".to_owned(), json!([company_id]));
        input.insert("primaryCompanyId".to_owned(), json!(company_id));
    }
    match crate::people::create_person_detailed(db, &input).await {
        Ok((row, _)) => {
            let id = crate::str_field(&row, "id").unwrap_or_default().to_owned();
            events.publish(PERSON_CREATED, &id, pick(&row, &PERSON_EVENT_KEYS));
            if let Some((company_id, _)) = company {
                // `createPerson` linked it.
                events.publish(COMPANY_UPDATED, company_id, json!({ "id": company_id }));
            }
            Ok(Created::New(id))
        }
        Err(DomainError::DuplicateEmail {
            existing_person_id, ..
        }) => Ok(Created::Raced(existing_person_id)),
        Err(error) => Err(error),
    }
}

/// The company of the address's domain: `(id, created)`. `None` for free
/// mail.
async fn ensure_company(
    db: &PgPool,
    events: &OrderedEvents,
    source: Source,
    email: &str,
    owner: Option<&str>,
) -> DomainResult<Option<(String, bool)>> {
    let domain = domain_of(email);
    if is_free_mail_domain(domain) {
        return Ok(None);
    }
    let registrable = registrable_domain(domain);
    if registrable.is_empty() {
        return Ok(None);
    }
    let candidates: Vec<(String, Option<String>)> = companies::Entity::find()
        .select_only()
        .column(companies::Column::Id)
        .column(companies::Column::Website)
        .filter(companies::Column::DeletedAt.is_null())
        .filter(Func::lower(Expr::col(companies::Column::Website)).like(format!("%{registrable}%")))
        .order_by_asc(companies::Column::CreatedAt)
        .limit(25)
        .into_tuple()
        .all(&orm(db))
        .await?;
    if let Some((id, _)) = candidates.into_iter().find(|(_, website)| {
        website.as_deref().is_some_and(|w| {
            let host = website_host(w);
            host == domain || registrable_domain(&host) == registrable
        })
    }) {
        return Ok(Some((id, false)));
    }
    let mut input = Map::new();
    input.insert("name".to_owned(), json!(company_name_for(&registrable)));
    input.insert(
        "website".to_owned(),
        json!(format!("https://{registrable}")),
    );
    input.insert("source".to_owned(), json!(source.record_source()));
    if let Some(owner) = owner {
        input.insert("ownerId".to_owned(), json!(owner));
    }
    let created = crate::companies::create_company(db, &input, owner).await?;
    let id = crate::str_field(&created, "id")
        .unwrap_or_default()
        .to_owned();
    events.publish(
        COMPANY_CREATED,
        &id,
        pick(&created, &["id", "name", "website", "industry"]),
    );
    Ok(Some((id, true)))
}

/// Links the person to the company unless they already are; the first
/// active link is the primary one.
async fn link_to_company(
    db: &PgPool,
    events: &OrderedEvents,
    person_id: &str,
    company_id: &str,
) -> DomainResult<()> {
    let active: Vec<(String, bool)> = person_companies::Entity::find()
        .select_only()
        .column(person_companies::Column::CompanyId)
        .column(person_companies::Column::IsPrimary)
        .filter(person_companies::Column::PersonId.eq(person_id))
        .filter(person_companies::Column::EndedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    if active.iter().any(|(id, _)| id == company_id) {
        return Ok(());
    }
    let now = OffsetDateTime::now_utc();
    let now = PrimitiveDateTime::new(now.date(), now.time());
    let id = generate_id("pc");
    let link = person_companies::ActiveModel {
        id: sea_orm::ActiveValue::Set(id.clone()),
        created_at: sea_orm::ActiveValue::Set(now),
        updated_at: sea_orm::ActiveValue::Set(now),
        person_id: sea_orm::ActiveValue::Set(person_id.to_owned()),
        company_id: sea_orm::ActiveValue::Set(company_id.to_owned()),
        is_primary: sea_orm::ActiveValue::Set(!active.iter().any(|(_, primary)| *primary)),
        ..Default::default()
    };
    person_companies::Entity::insert(link)
        .exec_without_returning(&orm(db))
        .await?;
    events.publish(
        CONTACT_LINK_CREATED,
        &id,
        json!({ "id": id, "personId": person_id, "companyId": company_id }),
    );
    events.publish(PERSON_UPDATED, person_id, json!({ "id": person_id }));
    events.publish(COMPANY_UPDATED, company_id, json!({ "id": company_id }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_off_with_every_source_on() {
        let settings = Settings::from_stored(None);
        assert!(!settings.enabled);
        assert!(!settings.create_companies);
        assert!(!settings.covers(Source::Email));
        let on = settings.merged(&Patch {
            enabled: Some(true),
            ..Patch::default()
        });
        for source in Source::ALL {
            assert!(on.covers(source), "{}", source.key());
        }
    }

    #[test]
    fn settings_read_what_is_stored_and_ignore_the_rest() {
        let stored = json!({
            "enabled": true,
            "createCompanies": "yes",
            "sources": { "email": false, "meetings": true },
        });
        let settings = Settings::from_stored(Some(&stored));
        assert!(settings.enabled);
        assert!(!settings.create_companies);
        assert!(!settings.covers(Source::Email));
        assert!(settings.covers(Source::Meetings));
        assert!(settings.covers(Source::Helpdesk));
        assert_eq!(Settings::from_stored(Some(&settings.to_json())), settings);
    }

    #[test]
    fn automated_senders() {
        for email in [
            "noreply@acme.com",
            "no-reply@acme.com",
            "bounce+abc123@mail.acme.com",
            "mailer-daemon@acme.com",
            "github-noreply@github.com",
            "notifications@acme.com",
        ] {
            assert!(is_automated(email), "{email}");
        }
        for email in ["jan@acme.com", "info@acme.com", "sales@acme.com"] {
            assert!(!is_automated(email), "{email}");
        }
    }

    #[test]
    fn domains_and_company_names() {
        assert_eq!(registrable_domain("mail.acme.co.uk"), "acme.co.uk");
        assert_eq!(registrable_domain("eu.acme.com"), "acme.com");
        assert_eq!(registrable_domain("acme.nl"), "acme.nl");
        assert_eq!(company_name_for("eu.acme.com"), "Acme");
        assert_eq!(company_name_for("acme.co.uk"), "Acme");
        assert_eq!(website_host("https://www.Acme.com/about"), "acme.com");
        assert_eq!(website_host("acme.com:8080"), "acme.com");
        assert!(is_free_mail_domain("gmail.com"));
        assert!(!is_free_mail_domain("acme.com"));
    }

    #[test]
    fn internal_addresses_and_domains() {
        let mut internal = Internal::default();
        internal.add("ann@weldsuite.org".to_owned());
        internal.add("bob@gmail.com".to_owned());
        assert!(internal.excludes("ann@weldsuite.org"));
        assert!(internal.excludes("someone@eu.weldsuite.org"));
        assert!(internal.excludes("bob@gmail.com"));
        assert!(!internal.excludes("carol@gmail.com"));
        assert!(!internal.excludes("jan@acme.com"));
    }

    #[test]
    fn names_from_the_display_name_or_the_address() {
        assert_eq!(
            split_name("jan@acme.com", Some("Jan de Vries")),
            (Some("Jan de".to_owned()), Some("Vries".to_owned()))
        );
        assert_eq!(
            split_name("jan@acme.com", Some("jan@acme.com")),
            (Some("jan".to_owned()), None)
        );
        assert_eq!(
            split_name("jan@acme.com", None),
            (Some("jan".to_owned()), None)
        );
        assert_eq!(
            normalize_email(" Jan@Acme.COM "),
            Some("jan@acme.com".to_owned())
        );
        assert_eq!(normalize_email("jan@localhost"), None);
        assert_eq!(normalize_email("nobody"), None);
    }
}
