//! `POST /api/search` (`routes/search/index.ts`, `services/search.ts`): the
//! federated search behind Cmd+K. Each permitted record type is matched with
//! `LIKE` against its own columns in the tenant database and scored by rule
//! (exact 1.0, prefix 0.9, substring 0.6; e-mail columns 1.0 / 0.7 / 0.3).
//! Types the caller may not read are left out, not refused.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_core_domain::drive_access::{DriveFileRef, file_visible, load_drive_access_for_user};
use weldsuite_db::PgPool;
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_permissions::has_any_app_permission;
use weldsuite_ports::DynCache;
use weldsuite_subscribers::search::ai::{WorkspaceEmbeddings, index_model};
use weldsuite_subscribers::search::backfill::{BackfillCursor, backfill_batch};

use crate::understanding::{ModelTier, apply_permitted_types, understand_query_with};
use crate::{Caller, CoreFilesState, answer, encode_uri_component, json_response, validate};

/// A searchable record type (`SEARCH_ENTITY_TYPES`), in the canonical order
/// of the response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SearchType {
    Contact,
    Customer,
    Lead,
    Opportunity,
    Ticket,
    Article,
    KnowledgePage,
    Product,
    Order,
    Invoice,
    Bill,
    Project,
    Task,
    MergeIssue,
    MergePullRequest,
    Sheet,
    Board,
    Domain,
}

/// Every type with the permission that lets a caller search it
/// (`ENTITY_REGISTRY`), in canonical order.
const REGISTRY: [(SearchType, &str, &str); 18] = [
    (SearchType::Contact, "contact", "contacts:read"),
    (SearchType::Customer, "customer", "contacts:read"),
    (SearchType::Lead, "lead", "leads:read"),
    (SearchType::Opportunity, "opportunity", "opportunities:read"),
    (SearchType::Ticket, "ticket", "tickets:read"),
    (SearchType::Article, "article", "articles:read"),
    (
        SearchType::KnowledgePage,
        "knowledge_page",
        "knowledge:read",
    ),
    (SearchType::Product, "product", "products:read"),
    (SearchType::Order, "order", "orders:read"),
    (SearchType::Invoice, "invoice", "invoices:read"),
    (SearchType::Bill, "bill", "bills:read"),
    (SearchType::Project, "project", "projects:read"),
    (SearchType::Task, "task", "tasks:read"),
    (SearchType::MergeIssue, "merge_issue", "merge_issues:read"),
    (
        SearchType::MergePullRequest,
        "merge_pull_request",
        "merge_pull_requests:read",
    ),
    (SearchType::Sheet, "sheet", "sheets:read"),
    (SearchType::Board, "board", "boards:read"),
    (SearchType::Domain, "domain", "domains:read"),
];

/// `SEARCH_ENTITY_TYPES`: the names `types` accepts, in the schema's own
/// order (the enum's message lists them so), which is not the canonical one.
pub(crate) const ENTITY_TYPES: [&str; 18] = [
    "contact",
    "customer",
    "lead",
    "opportunity",
    "ticket",
    "article",
    "knowledge_page",
    "product",
    "order",
    "invoice",
    "bill",
    "project",
    "task",
    "sheet",
    "board",
    "domain",
    "merge_issue",
    "merge_pull_request",
];

impl SearchType {
    pub(crate) fn as_str(self) -> &'static str {
        REGISTRY
            .iter()
            .find(|(t, _, _)| *t == self)
            .map_or("", |(_, name, _)| name)
    }

    fn permission(self) -> &'static str {
        REGISTRY
            .iter()
            .find(|(t, _, _)| *t == self)
            .map_or("", |(_, _, permission)| permission)
    }

    pub(crate) fn parse(name: &str) -> Option<Self> {
        REGISTRY
            .iter()
            .find(|(_, n, _)| *n == name)
            .map(|(t, _, _)| *t)
    }

    fn all() -> impl Iterator<Item = Self> {
        REGISTRY.iter().map(|(t, _, _)| *t)
    }
}

/// Where a result opens in the platform (`buildResultUrl`).
pub(crate) fn build_result_url(
    kind: SearchType,
    id: &str,
    member_apps: Option<&[String]>,
) -> String {
    let encoded = encode_uri_component(id);
    match kind {
        SearchType::Contact => format!("/weldcrm/people?stack=person:{encoded}"),
        SearchType::Customer => format!("/weldcrm/companies?stack=company:{encoded}"),
        SearchType::Lead => format!("/weldcrm?entity=lead:{encoded}"),
        SearchType::Opportunity => format!("/weldcrm?entity=opportunity:{encoded}"),
        SearchType::Ticket => format!("/welddesk/inbox?entity=ticket:{encoded}"),
        SearchType::Article => format!("/welddesk/help-center/articles/{id}"),
        SearchType::KnowledgePage => format!("/weldknow/page/{id}"),
        SearchType::Product => {
            let has = |code: &str| member_apps.is_some_and(|apps| apps.iter().any(|a| a == code));
            let app = if member_apps.is_some() && !has("weldcommerce") && has("weldstash") {
                "weldstash"
            } else {
                "weldcommerce"
            };
            format!("/{app}/products?stack=product:{encoded}")
        }
        SearchType::Order => format!("/weldcommerce/orders?stack=order:{encoded}"),
        SearchType::Invoice => format!("/weldbooks/invoices/{id}"),
        SearchType::Bill => format!("/weldbooks/bills/{id}"),
        SearchType::Project => format!("/weldflow/project/{id}"),
        SearchType::Task => format!("/weldflow/task/{id}"),
        SearchType::Sheet => format!("/weldsheets/{id}"),
        SearchType::Board => format!("/weldboard/{id}"),
        SearchType::Domain => format!("/weldhost/domains/{id}"),
        SearchType::MergeIssue => format!("/weldmerge/issues/{encoded}"),
        SearchType::MergePullRequest => format!("/weldmerge/pull-requests/{encoded}"),
    }
}

// ── The per-type queries ───────────────────────────────────────────────────

/// What every query binds: `$1` the lower-cased term, `$2` the prefix
/// pattern, `$3` the substring pattern (the term is not escaped, as in
/// TypeScript), `$4` the row limit (one more than asked, for `hasMore`).
struct Term {
    lower: String,
    prefix: String,
    contains: String,
    limit: i64,
}

async fn fetch(db: &PgPool, sql: &'static str, term: &Term) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar(sql)
        .bind(&term.lower)
        .bind(&term.prefix)
        .bind(&term.contains)
        .bind(term.limit)
        .fetch_all(db)
        .await
}

const CONTACTS: &str = "select jsonb_build_object('row', row, 'score', score) from (
    select id, updated_at, greatest(
        case when lower(full_name) = $1 then 1.0 when lower(full_name) like $2 then 0.9
             when lower(full_name) like $3 then 0.6 else 0 end,
        case when lower(first_name) = $1 then 1.0 when lower(first_name) like $2 then 0.9
             when lower(first_name) like $3 then 0.6 else 0 end,
        case when lower(last_name) = $1 then 1.0 when lower(last_name) like $2 then 0.9
             when lower(last_name) like $3 then 0.6 else 0 end,
        case when lower(email) = $1 then 1.0 when lower(email) like $2 then 0.7
             when lower(email) like $3 then 0.3 else 0 end) as score,
      jsonb_build_object('id', id, 'firstName', first_name, 'lastName', last_name,
        'fullName', full_name, 'email', email, 'title', title) as row
    from people
    where deleted_at is null and (lower(full_name) like $3 or lower(first_name) like $3
      or lower(last_name) like $3 or lower(email) like $3)) s
  order by score desc, updated_at desc, id desc limit $4";

const CUSTOMERS: &str = "select jsonb_build_object('row', row, 'score', score) from (
    select id, updated_at, greatest(
        case when lower(name) = $1 then 1.0 when lower(name) like $2 then 0.9
             when lower(name) like $3 then 0.6 else 0 end,
        case when lower(trading_name) = $1 then 1.0 when lower(trading_name) like $2 then 0.9
             when lower(trading_name) like $3 then 0.6 else 0 end,
        case when lower(email) = $1 then 1.0 when lower(email) like $2 then 0.7
             when lower(email) like $3 then 0.3 else 0 end) as score,
      jsonb_build_object('id', id, 'name', name, 'tradingName', trading_name,
        'email', email) as row
    from companies
    where deleted_at is null and (lower(name) like $3 or lower(trading_name) like $3
      or lower(email) like $3)) s
  order by score desc, updated_at desc, id desc limit $4";

const LEADS: &str = "select jsonb_build_object('row', row, 'score', score) from (
    select id, updated_at, greatest(
        case when lower(full_name) = $1 then 1.0 when lower(full_name) like $2 then 0.9
             when lower(full_name) like $3 then 0.6 else 0 end,
        case when lower(first_name) = $1 then 1.0 when lower(first_name) like $2 then 0.9
             when lower(first_name) like $3 then 0.6 else 0 end,
        case when lower(last_name) = $1 then 1.0 when lower(last_name) like $2 then 0.9
             when lower(last_name) like $3 then 0.6 else 0 end,
        case when lower(company_name) = $1 then 1.0 when lower(company_name) like $2 then 0.9
             when lower(company_name) like $3 then 0.6 else 0 end,
        case when lower(email) = $1 then 1.0 when lower(email) like $2 then 0.7
             when lower(email) like $3 then 0.3 else 0 end) as score,
      jsonb_build_object('id', id, 'firstName', first_name, 'lastName', last_name,
        'fullName', full_name, 'companyName', company_name, 'email', email) as row
    from crm_leads
    where deleted_at is null and (lower(full_name) like $3 or lower(first_name) like $3
      or lower(last_name) like $3 or lower(company_name) like $3 or lower(email) like $3)) s
  order by score desc, updated_at desc, id desc limit $4";

const OPPORTUNITIES: &str = "select jsonb_build_object('row', row, 'score', score) from (
    select id, updated_at, greatest(
        case when lower(name) = $1 then 1.0 when lower(name) like $2 then 0.9
             when lower(name) like $3 then 0.6 else 0 end,
        case when lower(customer_name) = $1 then 1.0 when lower(customer_name) like $2 then 0.9
             when lower(customer_name) like $3 then 0.6 else 0 end) as score,
      jsonb_build_object('id', id, 'name', name, 'customerName', customer_name,
        'stage', stage) as row
    from crm_opportunities
    where deleted_at is null and (lower(name) like $3 or lower(customer_name) like $3)) s
  order by score desc, updated_at desc, id desc limit $4";

const TICKETS: &str = "select jsonb_build_object('row', row, 'score', score) from (
    select id, updated_at, greatest(
        case when lower(subject) = $1 then 1.0 when lower(subject) like $2 then 0.9
             when lower(subject) like $3 then 0.6 else 0 end,
        case when lower(ticket_number) = $1 then 1.0 when lower(ticket_number) like $2 then 0.9
             when lower(ticket_number) like $3 then 0.6 else 0 end,
        case when lower(customer_name) = $1 then 1.0 when lower(customer_name) like $2 then 0.9
             when lower(customer_name) like $3 then 0.6 else 0 end,
        case when lower(customer_email) = $1 then 1.0 when lower(customer_email) like $2 then 0.7
             when lower(customer_email) like $3 then 0.3 else 0 end) as score,
      jsonb_build_object('id', id, 'ticketNumber', ticket_number, 'subject', subject,
        'status', status, 'customerName', customer_name) as row
    from helpdesk_tickets
    where deleted_at is null and (lower(subject) like $3 or lower(ticket_number) like $3
      or lower(customer_name) like $3 or lower(customer_email) like $3)) s
  order by score desc, updated_at desc, id desc limit $4";

const ARTICLES: &str = "select jsonb_build_object('row', row, 'score', score) from (
    select id, updated_at, greatest(
        case when lower(title) = $1 then 1.0 when lower(title) like $2 then 0.9
             when lower(title) like $3 then 0.6 else 0 end,
        case when lower(slug) = $1 then 1.0 when lower(slug) like $2 then 0.9
             when lower(slug) like $3 then 0.6 else 0 end,
        case when lower(category_name) = $1 then 1.0 when lower(category_name) like $2 then 0.9
             when lower(category_name) like $3 then 0.6 else 0 end) as score,
      jsonb_build_object('id', id, 'title', title, 'slug', slug, 'excerpt', excerpt,
        'categoryName', category_name) as row
    from helpdesk_articles
    where deleted_at is null and (lower(title) like $3 or lower(slug) like $3
      or lower(category_name) like $3)) s
  order by score desc, updated_at desc, id desc limit $4";

const KNOWLEDGE_PAGES: &str = "select jsonb_build_object('row', row, 'score', score) from (
    select p.id, p.updated_at, greatest(
        case when lower(p.title) = $1 then 1.0 when lower(p.title) like $2 then 0.9
             when lower(p.title) like $3 then 0.6 else 0 end,
        case when lower(p.content_text) = $1 then 1.0 when lower(p.content_text) like $2 then 0.9
             when lower(p.content_text) like $3 then 0.6 else 0 end) as score,
      jsonb_build_object('id', p.id, 'title', p.title, 'contentText', p.content_text,
        'spaceName', s.name) as row
    from knowledge_pages p
    join knowledge_spaces s on p.space_id = s.id
    where p.deleted_at is null and s.deleted_at is null and s.kind = 'team'
      and s.visibility = 'open'
      and (lower(p.title) like $3 or lower(p.content_text) like $3)) s
  order by score desc, updated_at desc, id desc limit $4";

const PRODUCTS: &str = "select jsonb_build_object('row', row, 'score', score) from (
    select id, updated_at, greatest(
        case when lower(name) = $1 then 1.0 when lower(name) like $2 then 0.9
             when lower(name) like $3 then 0.6 else 0 end,
        case when lower(sku) = $1 then 1.0 when lower(sku) like $2 then 0.9
             when lower(sku) like $3 then 0.6 else 0 end,
        case when lower(barcode) = $1 then 1.0 when lower(barcode) like $2 then 0.9
             when lower(barcode) like $3 then 0.6 else 0 end) as score,
      jsonb_build_object('id', id, 'name', name, 'sku', sku,
        'shortDescription', short_description) as row
    from products
    where deleted_at is null and (lower(name) like $3 or lower(sku) like $3
      or lower(barcode) like $3)) s
  order by score desc, updated_at desc, id desc limit $4";

const ORDERS: &str = "select jsonb_build_object('row', row, 'score', score) from (
    select id, updated_at, greatest(
        case when lower(order_number) = $1 then 1.0 when lower(order_number) like $2 then 0.9
             when lower(order_number) like $3 then 0.6 else 0 end,
        case when lower(customer_name) = $1 then 1.0 when lower(customer_name) like $2 then 0.9
             when lower(customer_name) like $3 then 0.6 else 0 end,
        case when lower(customer_email) = $1 then 1.0 when lower(customer_email) like $2 then 0.7
             when lower(customer_email) like $3 then 0.3 else 0 end) as score,
      jsonb_build_object('id', id, 'orderNumber', order_number,
        'customerName', customer_name, 'status', status) as row
    from orders
    where deleted_at is null and (lower(order_number) like $3 or lower(customer_name) like $3
      or lower(customer_email) like $3)) s
  order by score desc, updated_at desc, id desc limit $4";

const INVOICES: &str = "select jsonb_build_object('row', row, 'score', score) from (
    select id, updated_at, greatest(
        case when lower(invoice_number) = $1 then 1.0 when lower(invoice_number) like $2 then 0.9
             when lower(invoice_number) like $3 then 0.6 else 0 end,
        case when lower(contact_name) = $1 then 1.0 when lower(contact_name) like $2 then 0.9
             when lower(contact_name) like $3 then 0.6 else 0 end,
        case when lower(contact_email) = $1 then 1.0 when lower(contact_email) like $2 then 0.7
             when lower(contact_email) like $3 then 0.3 else 0 end) as score,
      jsonb_build_object('id', id, 'invoiceNumber', invoice_number,
        'contactName', contact_name, 'status', status) as row
    from invoices
    where deleted_at is null and (lower(invoice_number) like $3 or lower(contact_name) like $3
      or lower(contact_email) like $3)) s
  order by score desc, updated_at desc, id desc limit $4";

const BILLS: &str = "select jsonb_build_object('row', row, 'score', score) from (
    select id, updated_at, greatest(
        case when lower(bill_number) = $1 then 1.0 when lower(bill_number) like $2 then 0.9
             when lower(bill_number) like $3 then 0.6 else 0 end,
        case when lower(contact_name) = $1 then 1.0 when lower(contact_name) like $2 then 0.9
             when lower(contact_name) like $3 then 0.6 else 0 end) as score,
      jsonb_build_object('id', id, 'billNumber', bill_number, 'contactName', contact_name,
        'status', status) as row
    from bills
    where deleted_at is null and (lower(bill_number) like $3 or lower(contact_name) like $3)) s
  order by score desc, updated_at desc, id desc limit $4";

const PROJECTS: &str = "select jsonb_build_object('row', row, 'score', score) from (
    select id, updated_at, greatest(
        case when lower(name) = $1 then 1.0 when lower(name) like $2 then 0.9
             when lower(name) like $3 then 0.6 else 0 end,
        case when lower(code) = $1 then 1.0 when lower(code) like $2 then 0.9
             when lower(code) like $3 then 0.6 else 0 end) as score,
      jsonb_build_object('id', id, 'name', name, 'code', code, 'status', status) as row
    from projects
    where deleted_at is null and (lower(name) like $3 or lower(code) like $3)) s
  order by score desc, updated_at desc, id desc limit $4";

const TASKS: &str = "select jsonb_build_object('row', row, 'score', score) from (
    select id, updated_at, greatest(
        case when lower(title) = $1 then 1.0 when lower(title) like $2 then 0.9
             when lower(title) like $3 then 0.6 else 0 end,
        case when lower(key) = $1 then 1.0 when lower(key) like $2 then 0.9
             when lower(key) like $3 then 0.6 else 0 end) as score,
      jsonb_build_object('id', id, 'title', title, 'key', key, 'number', number,
        'status', status) as row
    from tasks
    where deleted_at is null and (lower(title) like $3 or lower(key) like $3
      or ($5::bigint is not null and number = $5))) s
  order by score desc, updated_at desc, id desc limit $4";

const DOMAINS: &str = "select jsonb_build_object('row', row, 'score', score) from (
    select id, updated_at, greatest(
        case when lower(full_domain) = $1 then 1.0 when lower(full_domain) like $2 then 0.9
             when lower(full_domain) like $3 then 0.6 else 0 end,
        case when lower(name) = $1 then 1.0 when lower(name) like $2 then 0.9
             when lower(name) like $3 then 0.6 else 0 end,
        case when lower(tld) = $1 then 1.0 when lower(tld) like $2 then 0.9
             when lower(tld) like $3 then 0.6 else 0 end) as score,
      jsonb_build_object('id', id, 'fullDomain', full_domain, 'name', name, 'tld', tld,
        'status', status, 'registrar', registrar) as row
    from domains
    where deleted_at is null
      and registration_status is distinct from 'pending_payment'
      and not (status = 'cancelled' and registration_status is not distinct from 'failed')
      and (lower(full_domain) like $3 or lower(name) like $3 or lower(tld) like $3)) s
  order by score desc, updated_at desc, id desc limit $4";

/// WeldMerge issues by title or key (`PLAT-209`, or a part of it); `$5` is
/// the escaped substring pattern (`escapeLike`), the scores use the raw term.
const MERGE_ISSUES: &str = "select jsonb_build_object('row', row, 'score', score) from (
    select i.id, i.updated_at, greatest(
        case when lower(i.title) = $1 then 1.0 when lower(i.title) like $2 then 0.9
             when lower(i.title) like $3 then 0.6 else 0 end,
        case when lower(t.key || '-' || i.number::text) = $1 then 1.0
             when lower(t.key || '-' || i.number::text) like $2 then 0.9
             when lower(t.key || '-' || i.number::text) like $3 then 0.6 else 0 end) as score,
      jsonb_build_object('id', i.id, 'title', i.title, 'key', t.key || '-' || i.number::text,
        'status', i.status) as row
    from merge_issues i
    join merge_teams t on t.id = i.team_id
    where i.deleted_at is null and t.deleted_at is null
      and (lower(i.title) like $5 or lower(t.key || '-' || i.number::text) like $5)) s
  order by score desc, updated_at desc, id desc limit $4";

/// WeldMerge pull requests of repositories still connected, by title, branch
/// or number (`#123`, `123`: `$6`); `$5` as for issues.
const MERGE_PULL_REQUESTS: &str = "select jsonb_build_object('row', row, 'score', score) from (
    select p.id, p.provider_updated_at, greatest(
        case when lower(p.title) = $1 then 1.0 when lower(p.title) like $2 then 0.9
             when lower(p.title) like $3 then 0.6 else 0 end,
        case when lower(p.head_ref) = $1 then 1.0 when lower(p.head_ref) like $2 then 0.9
             when lower(p.head_ref) like $3 then 0.6 else 0 end) as score,
      jsonb_build_object('id', p.id, 'title', p.title, 'number', p.number, 'state', p.state,
        'repository', r.full_name) as row
    from merge_pull_requests p
    join merge_repositories r on r.id = p.repository_id
    where r.deleted_at is null
      and (lower(p.title) like $5 or lower(p.head_ref) like $5
        or ($6::int is not null and p.number = $6))) s
  order by score desc, provider_updated_at desc, id desc limit $4";

/// `a || b || …`: the first non-empty string, else `None`.
fn first<'a>(values: &[Option<&'a str>]) -> Option<&'a str> {
    values.iter().flatten().copied().find(|v| !v.is_empty())
}

fn field<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row[key].as_str()
}

/// `withSuffix(head, tail)`.
fn with_suffix(head: &str, tail: Option<&str>) -> String {
    match tail.filter(|t| !t.is_empty()) {
        Some(tail) => format!("{head} · {tail}"),
        None => head.to_owned(),
    }
}

/// `text.slice(0, 80)` in UTF-16 units.
fn excerpt(text: &str) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 80
        })
        .collect()
}

/// `[a, b].filter(Boolean).join(' ').trim()`.
fn full_name(row: &Value) -> String {
    let parts: Vec<&str> = [field(row, "firstName"), field(row, "lastName")]
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty())
        .collect();
    parts.join(" ").trim().to_owned()
}

/// `MANAGED_DOMAIN_REGISTRARS` show as WeldSuite (`publicDomainRegistrar`).
fn public_registrar(registrar: &str) -> &str {
    if ["realtimeregister", "cloudflare", "WeldHost", "WeldSuite"].contains(&registrar) {
        "WeldSuite"
    } else {
        registrar
    }
}

/// The title and subtitle of a row of `kind`.
#[allow(clippy::too_many_lines)] // one arm per record type, as in TypeScript
fn describe(kind: SearchType, row: &Value) -> (String, Option<String>) {
    let s = |key: &str| field(row, key);
    let owned = |v: Option<&str>| v.map(str::to_owned);
    match kind {
        SearchType::Contact | SearchType::Lead => {
            let trimmed = s("fullName").map(str::trim);
            let joined = full_name(row);
            let fallback = if kind == SearchType::Contact {
                "Person"
            } else {
                "Lead"
            };
            let title = first(&[trimmed, Some(joined.as_str()), s("email")]).unwrap_or(fallback);
            let subtitle = if kind == SearchType::Contact {
                first(&[s("title"), s("email")])
            } else {
                first(&[s("companyName"), s("email")])
            };
            (title.to_owned(), owned(subtitle))
        }
        SearchType::Customer => {
            let title = first(&[
                s("name").map(str::trim),
                s("tradingName").map(str::trim),
                s("email"),
            ])
            .unwrap_or("Company");
            let trading = s("tradingName").filter(|t| !t.is_empty());
            let subtitle = match trading {
                Some(trading) if Some(trading) != s("name") => Some(trading),
                _ => first(&[s("email")]),
            };
            (title.to_owned(), owned(subtitle))
        }
        SearchType::Opportunity => (
            first(&[s("name")]).unwrap_or("Opportunity").to_owned(),
            owned(first(&[s("customerName"), s("stage")])),
        ),
        SearchType::Ticket => {
            let number = s("ticketNumber").filter(|n| !n.is_empty());
            let title = first(&[s("subject")]).map_or_else(
                || format!("Ticket {}", s("ticketNumber").unwrap_or("null")),
                str::to_owned,
            );
            let subtitle = match number {
                Some(number) => Some(with_suffix(&format!("#{number}"), s("customerName"))),
                None => owned(first(&[s("customerName"), s("status")])),
            };
            (title, subtitle)
        }
        SearchType::Article => (
            first(&[s("title")]).unwrap_or("Article").to_owned(),
            first(&[s("categoryName")])
                .map(str::to_owned)
                .or_else(|| first(&[s("excerpt")]).map(excerpt)),
        ),
        SearchType::KnowledgePage => (
            first(&[s("title")]).unwrap_or("Untitled").to_owned(),
            first(&[s("spaceName")])
                .map(str::to_owned)
                .or_else(|| first(&[s("contentText")]).map(excerpt)),
        ),
        SearchType::Product => (
            first(&[s("name")]).unwrap_or("Product").to_owned(),
            match first(&[s("sku")]) {
                Some(sku) => Some(format!("SKU: {sku}")),
                None => owned(s("shortDescription")),
            },
        ),
        SearchType::Order => (
            first(&[s("orderNumber")]).map_or_else(|| "Order".to_owned(), |n| format!("Order {n}")),
            owned(first(&[s("customerName"), s("status")])),
        ),
        SearchType::Invoice => (
            first(&[s("invoiceNumber")])
                .map_or_else(|| "Invoice".to_owned(), |n| format!("Invoice {n}")),
            owned(first(&[s("contactName"), s("status")])),
        ),
        SearchType::Bill => (
            first(&[s("billNumber")]).map_or_else(|| "Bill".to_owned(), |n| format!("Bill {n}")),
            owned(first(&[s("contactName"), s("status")])),
        ),
        SearchType::Project => (
            first(&[s("name")]).unwrap_or("Project").to_owned(),
            match first(&[s("code")]) {
                Some(code) => Some(with_suffix(code, s("status"))),
                None => owned(first(&[s("status")])),
            },
        ),
        SearchType::Task => {
            let reference = match &row["number"] {
                Value::Number(number) => Some(number.to_string()),
                _ => first(&[s("key")]).map(str::to_owned),
            };
            let subtitle = match reference {
                Some(reference) => Some(with_suffix(&reference, s("status"))),
                None => owned(first(&[s("status")])),
            };
            (first(&[s("title")]).unwrap_or("Task").to_owned(), subtitle)
        }
        SearchType::Sheet => (
            first(&[s("name")]).unwrap_or("Spreadsheet").to_owned(),
            None,
        ),
        SearchType::Board => (first(&[s("name")]).unwrap_or("Board").to_owned(), None),
        SearchType::MergeIssue => {
            let key = s("key").unwrap_or("null");
            (
                first(&[s("title"), Some(key)])
                    .unwrap_or_default()
                    .to_owned(),
                Some(with_suffix(key, s("status"))),
            )
        }
        SearchType::MergePullRequest => {
            let number = match &row["number"] {
                Value::Number(number) => number.to_string(),
                _ => "null".to_owned(),
            };
            let title = first(&[s("title")]).map_or_else(|| format!("#{number}"), str::to_owned);
            let head = format!("{}#{number}", s("repository").unwrap_or("null"));
            (title, Some(with_suffix(&head, s("state"))))
        }
        SearchType::Domain => {
            let title = first(&[s("fullDomain")]).map_or_else(
                || {
                    format!(
                        "{}.{}",
                        s("name").unwrap_or("null"),
                        s("tld").unwrap_or("null")
                    )
                },
                str::to_owned,
            );
            let subtitle = match first(&[s("registrar")]) {
                Some(registrar) => Some(with_suffix(public_registrar(registrar), s("status"))),
                None => owned(first(&[s("status")])),
            };
            (title, subtitle)
        }
    }
}

/// `typeof score === 'number' ? score : Number(score) || null`.
fn score_of(row: &Value) -> Value {
    match row["score"].as_f64() {
        Some(score) if score != 0.0 => json!(score),
        _ => Value::Null,
    }
}

/// One type's group from its rows (`limit + 1` of them at most).
fn group(kind: SearchType, rows: &[Value], limit: usize) -> Value {
    let items: Vec<Value> = rows
        .iter()
        .take(limit)
        .map(|wrapped| {
            let row = &wrapped["row"];
            let id = field(row, "id").unwrap_or_default();
            let (title, subtitle) = describe(kind, row);
            json!({
                "id": id,
                "type": kind.as_str(),
                "title": title,
                "subtitle": subtitle,
                "url": build_result_url(kind, id, None),
                "score": score_of(wrapped),
            })
        })
        .collect();
    json!({
        "type": kind.as_str(),
        "totalCount": items.len(),
        "items": items,
        "hasMore": rows.len() > limit,
    })
}

/// The rows of one type, each `{ row, score }`.
async fn search_rows(
    db: &PgPool,
    kind: SearchType,
    q: &str,
    limit: usize,
    user_id: Option<&str>,
) -> Result<Vec<Value>, sqlx::Error> {
    let lower = q.to_lowercase();
    let term = Term {
        prefix: format!("{lower}%"),
        contains: format!("%{lower}%"),
        lower,
        limit: i64::try_from(limit + 1).unwrap_or(i64::MAX),
    };
    let sql = match kind {
        SearchType::Contact => CONTACTS,
        SearchType::Customer => CUSTOMERS,
        SearchType::Lead => LEADS,
        SearchType::Opportunity => OPPORTUNITIES,
        SearchType::Ticket => TICKETS,
        SearchType::Article => ARTICLES,
        SearchType::KnowledgePage => KNOWLEDGE_PAGES,
        SearchType::Product => PRODUCTS,
        SearchType::Order => ORDERS,
        SearchType::Invoice => INVOICES,
        SearchType::Bill => BILLS,
        SearchType::Project => PROJECTS,
        SearchType::Domain => DOMAINS,
        SearchType::Task => return search_tasks(db, q, &term).await,
        SearchType::MergeIssue | SearchType::MergePullRequest => {
            return search_merge(db, kind, q, &term).await;
        }
        SearchType::Sheet => return search_files(db, FileKind::Sheet, q, limit, user_id).await,
        SearchType::Board => return search_files(db, FileKind::Board, q, limit, user_id).await,
    };
    let rows = fetch(db, sql, &term).await?;
    Ok(rows)
}

/// Tasks also match by number: "TASK-1042", "#1042" or "1042".
async fn search_tasks(db: &PgPool, q: &str, term: &Term) -> Result<Vec<Value>, sqlx::Error> {
    let reference = q.trim();
    let reference = reference.strip_prefix('#').unwrap_or(reference);
    let reference = if reference.len() >= 5 && reference[..5].eq_ignore_ascii_case("task-") {
        &reference[5..]
    } else {
        reference
    };
    let number = (!reference.is_empty() && reference.bytes().all(|b| b.is_ascii_digit()))
        .then(|| reference.parse::<i64>().ok())
        .flatten();
    sqlx::query_scalar(TASKS)
        .bind(&term.lower)
        .bind(&term.prefix)
        .bind(&term.contains)
        .bind(term.limit)
        .bind(number)
        .fetch_all(db)
        .await
}

/// WeldMerge issues and pull requests (`searchMergeIssues`,
/// `searchMergePullRequests`): the `WHERE` matches the escaped term, the
/// score the raw one, as in TypeScript.
async fn search_merge(
    db: &PgPool,
    kind: SearchType,
    q: &str,
    term: &Term,
) -> Result<Vec<Value>, sqlx::Error> {
    let contains = format!("%{}%", escape_like(&q.to_lowercase()));
    let query = sqlx::query_scalar(if kind == SearchType::MergeIssue {
        MERGE_ISSUES
    } else {
        MERGE_PULL_REQUESTS
    })
    .bind(&term.lower)
    .bind(&term.prefix)
    .bind(&term.contains)
    .bind(term.limit)
    .bind(&contains);
    if kind == SearchType::MergeIssue {
        return query.fetch_all(db).await;
    }
    query.bind(pull_request_number(q)).fetch_all(db).await
}

/// `/^#?(\d{1,9})$/.exec(q.trim())`: the number a query names.
fn pull_request_number(q: &str) -> Option<i32> {
    let trimmed = q.trim();
    let digits = trimmed.strip_prefix('#').unwrap_or(trimmed);
    (!digits.is_empty() && digits.len() <= 9 && digits.bytes().all(|b| b.is_ascii_digit()))
        .then(|| digits.parse().ok())
        .flatten()
}

/// `escapeLike`: `\`, `%` and `_` match themselves.
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

/// The record tables that are Drive files, searched by their file's name.
#[derive(Clone, Copy)]
enum FileKind {
    Sheet,
    Board,
}

impl FileKind {
    /// The table, joined to `files` as `f` on `s.file_id`.
    fn table(self) -> &'static str {
        match self {
            Self::Sheet => "sheets",
            Self::Board => "whiteboards",
        }
    }
}

/// Spreadsheets or boards, by the name of their Drive file, as far as the
/// WeldDrive rules let `user_id` see them (`searchSheets`, `searchBoards`).
/// Without a user, none.
async fn search_files(
    db: &PgPool,
    kind: FileKind,
    q: &str,
    limit: usize,
    user_id: Option<&str>,
) -> Result<Vec<Value>, sqlx::Error> {
    // The table comes from the closed `FileKind` set, never from input.
    let table = kind.table();
    let Some(user_id) = user_id else {
        return Ok(Vec::new());
    };
    let term = q.to_lowercase();
    let escaped = escape_like(&term);
    let contains = format!("%{escaped}%");
    let starts_with = format!("{escaped}%");
    // Most keystrokes match nothing: skip the access rules until a row does.
    let candidate: Option<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select s.id from {table} s join files f on f.id = s.file_id
         where f.deleted_at is null and f.entity_type is null and lower(f.file_name) like $1
         limit 1"
    )))
    .bind(&contains)
    .fetch_optional(db)
    .await?;
    if candidate.is_none() {
        return Ok(Vec::new());
    }
    let access = load_drive_access_for_user(db, Some(user_id)).await?;
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select jsonb_build_object(
                'row', jsonb_build_object('id', s.id, 'name', f.file_name),
                'score', case when lower(f.file_name) = $1 then 1.0
                              when lower(f.file_name) like $2 then 0.9
                              when lower(f.file_name) like $3 then 0.6 else 0 end,
                'file', jsonb_build_object('id', f.id, 'uploadedById', f.uploaded_by_id,
                    'folderId', f.folder_id, 'generalAccess', f.general_access,
                    'entityType', f.entity_type))
         from {table} s join files f on f.id = s.file_id
         where f.deleted_at is null and f.entity_type is null and lower(f.file_name) like $3
         order by case when lower(f.file_name) = $1 then 1.0
                       when lower(f.file_name) like $2 then 0.9
                       when lower(f.file_name) like $3 then 0.6 else 0 end desc,
                  greatest(s.updated_at, f.updated_at) desc, s.id desc"
    )))
    .bind(&term)
    .bind(&starts_with)
    .bind(&contains)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|row| file_visible(&access, &DriveFileRef::from_row(&row["file"])))
        .take(limit + 1)
        .collect())
}

// ── Member apps ────────────────────────────────────────────────────────────

/// The apps an EMPLOYEE member opens, whatever their assignments say.
const EMPLOYEE_MEMBER_APPS: [&str; 2] = ["weldhr", "weldchat"];

/// The apps a member can open (`listMemberAppCodes`), in installed order.
async fn list_member_app_codes(db: &PgPool, user_id: &str) -> Result<Vec<String>, sqlx::Error> {
    let installed: Vec<String> = sqlx::query_scalar(
        "select app_code from workspace_installed_apps
         where is_active = true and deleted_at is null
         order by display_order asc, created_at asc, app_code asc",
    )
    .fetch_all(db)
    .await?;
    let member: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "select role, role_id, member_type::text from workspace_members
         where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let (role, role_id, member_type) = member.unwrap_or_default();
    let role = role.map(|r| r.to_uppercase());
    if matches!(role.as_deref(), Some("OWNER" | "ADMIN")) {
        return Ok(installed);
    }
    if member_type.as_deref() == Some("EMPLOYEE") {
        return Ok(installed
            .into_iter()
            .filter(|code| EMPLOYEE_MEMBER_APPS.contains(&code.as_str()))
            .collect());
    }
    if installed.is_empty() {
        return Ok(installed);
    }
    let mut effective = std::collections::HashSet::new();
    if let Some(role_id) = role_id.filter(|id| !id.is_empty()) {
        let apps: Option<Option<Value>> = sqlx::query_scalar(
            "select apps from roles where id = $1 and deleted_at is null limit 1",
        )
        .bind(&role_id)
        .fetch_optional(db)
        .await?;
        if let Some(Value::Array(apps)) = apps.flatten() {
            for code in apps.iter().filter_map(Value::as_str) {
                if installed.iter().any(|i| i == code) {
                    effective.insert(code.to_owned());
                }
            }
        }
    }
    let assigned: Vec<String> = sqlx::query_scalar(
        "select app_code from user_app_assignments
         where user_id = $1 and is_active = true and app_code = any($2)",
    )
    .bind(user_id)
    .bind(&installed)
    .fetch_all(db)
    .await?;
    effective.extend(assigned);
    Ok(installed
        .into_iter()
        .filter(|code| effective.contains(code))
        .collect())
}

// ── The route ──────────────────────────────────────────────────────────────

struct SearchInput {
    q: String,
    types: Option<Vec<SearchType>>,
    limit: usize,
}

/// `searchInputSchema`.
fn read_input(issues: &mut Issues, body: &Map<String, Value>) -> SearchInput {
    let q = issues
        .text_with(
            body,
            "q",
            Presence::Required,
            Text::trimmed(Some(1), Some(200)),
        )
        .into_option()
        .unwrap_or_default();
    let names: Vec<&str> = ENTITY_TYPES.to_vec();
    let types = issues
        .list(
            body,
            "types",
            Presence::Optional,
            None,
            None,
            |issues, item| issues.item_choice(item, &names),
        )
        .into_option()
        .map(|names| names.iter().filter_map(|n| SearchType::parse(n)).collect());
    let limit = issues
        .whole_number(
            body,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                min: Some(1.0),
                max: Some(20.0),
                ..Number::default()
            },
        )
        .into_option()
        .unwrap_or(5);
    SearchInput {
        q,
        types,
        limit: usize::try_from(limit).unwrap_or(5),
    }
}

pub(crate) async fn search(
    State(state): State<CoreFilesState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = validate(&headers, &body, read_input)?;
            // Global search spans every app: a type is allowed when any app
            // grants it.
            let allowed = |kind: SearchType| {
                caller.permissions.as_ref().is_some_and(|permissions| {
                    has_any_app_permission(permissions.resolved(), &[kind.permission()], None)
                })
            };
            let permitted: Vec<SearchType> = SearchType::all().filter(|t| allowed(*t)).collect();
            // Structure the query first ("Invoice from Acme Corp" becomes
            // invoices matching "Acme Corp"). Never fails: no AI, an empty
            // wallet or a refusal all leave the raw query.
            let tier = ModelTier {
                ai: caller.ai(&state),
                call: {
                    let call = ModelTier::call(&caller.workspace_id)
                        .tenant(caller.db.clone())
                        .master(caller.master(&state));
                    match &caller.user_id {
                        Some(user) => call.user(user),
                        None => call,
                    }
                },
                cache: caller.cache(&state),
                // The parse cache stays under the Clerk org id, as TypeScript keeps it.
                cache_workspace: caller.clerk_org_id.clone().unwrap_or_default(),
            };
            let parsed = understand_query_with(&input.q, &tier).await;
            let scoped = match &input.types {
                Some(types) if !types.is_empty() => types.clone(),
                _ => apply_permitted_types(&parsed, &permitted),
            };
            let filtered: Vec<SearchType> = permitted
                .iter()
                .copied()
                .filter(|t| scoped.contains(t))
                .collect();
            let term = match parsed.lexical_term.trim() {
                "" => input.q.as_str(),
                term => term,
            };
            let mut groups = Vec::with_capacity(filtered.len());
            for kind in &filtered {
                let rows = search_rows(
                    &caller.db,
                    *kind,
                    term,
                    input.limit,
                    caller.user_id.as_deref(),
                )
                .await?;
                groups.push((*kind, group(*kind, &rows, input.limit)));
            }
            // Products link to WeldStash when that is the app the member has.
            let has_products = groups.iter().any(|(kind, group)| {
                *kind == SearchType::Product
                    && group["items"].as_array().is_some_and(|i| !i.is_empty())
            });
            if has_products && let Some(user_id) = &caller.user_id {
                match list_member_app_codes(&caller.db, user_id).await {
                    Ok(apps) => {
                        for (kind, group) in &mut groups {
                            if *kind != SearchType::Product {
                                continue;
                            }
                            if let Some(items) = group["items"].as_array_mut() {
                                for item in items {
                                    let id = item["id"].as_str().unwrap_or_default().to_owned();
                                    item["url"] = json!(build_result_url(
                                        SearchType::Product,
                                        &id,
                                        Some(&apps)
                                    ));
                                }
                            }
                        }
                    }
                    Err(error) => tracing::error!(%error, "search: resolving member apps failed"),
                }
            }
            let entity_types: Vec<&str> = parsed.entity_types.iter().map(|t| t.as_str()).collect();
            Ok(json_response(
                StatusCode::OK,
                json!({
                    "data": groups.into_iter().map(|(_, group)| group).collect::<Vec<_>>(),
                    "query": input.q,
                    "permittedTypes": permitted.iter().map(|t| t.as_str()).collect::<Vec<_>>(),
                    "understanding": {
                        "source": parsed.source.as_str(),
                        "entityTypes": entity_types,
                        "lexicalTerm": parsed.lexical_term,
                    },
                }),
            ))
        }
        .await,
        "Failed to run search",
    )
}

// ── POST /api/search/reindex ───────────────────────────────────────────────

/// `REINDEX_LOCK_PREFIX`: the advisory lease, per workspace.
const REINDEX_LOCK_PREFIX: &str = "search-reindex-lock:";
/// Longer than one page, short enough to heal after a crash.
const REINDEX_LOCK_TTL: std::time::Duration = std::time::Duration::from_secs(120);

/// `reindexInputSchema`: `{ cursor?: { entityType, afterId } | null }`.
fn read_reindex(issues: &mut Issues, body: &Map<String, Value>) -> Option<BackfillCursor> {
    issues
        .nested(body, "cursor", Presence::Nullish, |issues, fields| {
            let entity_type = issues
                .choice(fields, "entityType", Presence::Required, &ENTITY_TYPES)
                .into_option();
            let after_id = issues
                .text(fields, "afterId", Presence::Nullable, None, None)
                .into_option();
            BackfillCursor {
                entity_type: entity_type.unwrap_or_default(),
                after_id,
            }
        })
        .into_option()
}

/// `acquireReindexLease(env, orgId)`: whether this walk may run. Advisory,
/// as TypeScript's: a cache that can't be read lets the walk run rather than
/// block an admin action.
async fn acquire_reindex_lease(cache: Option<&Arc<dyn DynCache>>, key: &str) -> bool {
    let Some(cache) = cache else {
        return true;
    };
    match cache.get_boxed(key).await {
        Ok(Some(held)) if !held.is_empty() => false,
        Ok(_) => {
            let now = weldsuite_events::iso_timestamp(time::OffsetDateTime::now_utc());
            if let Err(error) = cache.put_boxed(key, &now, Some(REINDEX_LOCK_TTL)).await {
                tracing::debug!(%error, "[app-api/search] reindex lease unavailable");
            }
            true
        }
        Err(_) => true,
    }
}

/// `POST /api/search/reindex` (`settings:general:update`): one page of the
/// semantic backfill, its embeddings through the install's AI
/// (`search-index`, the indexer's own code: [`backfill_batch`]), charged to
/// the workspace once per page. The caller loops on the returned cursor
/// until `done`; two walks of one workspace at once get a 409.
pub(crate) async fn reindex(
    State(state): State<CoreFilesState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let cursor = validate(&headers, &body, read_reindex)?;
            let embeddings = caller
                .ai(&state)
                .and_then(|ai| index_model(&ai).map(|model| (ai, model)));
            let Some((ai, model)) = embeddings else {
                tracing::error!("[app-api/search] reindex: AI is not configured");
                return Ok(json_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({ "error": { "code": "AI_NOT_CONFIGURED", "message": "AI gateway is not configured" } }),
                ));
            };
            let cache = caller.cache(&state);
            let key = format!(
                "{REINDEX_LOCK_PREFIX}{}",
                caller.clerk_org_id.as_deref().unwrap_or_default()
            );
            if !acquire_reindex_lease(cache.as_ref(), &key).await {
                return Ok(json_response(
                    StatusCode::CONFLICT,
                    json!({ "error": { "code": "REINDEX_IN_PROGRESS", "message": "A reindex is already running for this workspace" } }),
                ));
            }
            let embedder = WorkspaceEmbeddings::new(ai, model, &caller.workspace_id);
            let cursor = cursor.unwrap_or_else(BackfillCursor::initial);
            let progress = backfill_batch(&caller.db, &embedder, &cursor).await;
            embedder.settle(caller.master(&state).as_ref()).await;
            if let Some(cache) = &cache {
                let _ = cache.delete_boxed(&key).await;
            }
            match progress {
                Ok(progress) => Ok(json_response(
                    StatusCode::OK,
                    json!({ "data": progress.to_json() }),
                )),
                Err(error) => {
                    tracing::error!(%error, "[app-api/search] reindex batch failed");
                    Ok(ApiError::internal()
                        .with_message("Failed to run reindex batch")
                        .into_response())
                }
            }
        }
        .await,
        "Failed to run reindex batch",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_titles() {
        assert_eq!(
            build_result_url(SearchType::Contact, "per 1", None),
            "/weldcrm/people?stack=person:per%201"
        );
        let stash = vec!["weldstash".to_owned()];
        assert_eq!(
            build_result_url(SearchType::Product, "p1", Some(&stash)),
            "/weldstash/products?stack=product:p1"
        );
        assert_eq!(
            build_result_url(SearchType::Product, "p1", None),
            "/weldcommerce/products?stack=product:p1"
        );
        let (title, subtitle) = describe(
            SearchType::Contact,
            &json!({ "fullName": " ", "firstName": "Ann", "lastName": null, "email": "a@b.c", "title": "" }),
        );
        assert_eq!(
            (title.as_str(), subtitle.as_deref()),
            ("Ann", Some("a@b.c"))
        );
        let (title, subtitle) = describe(
            SearchType::Ticket,
            &json!({ "subject": "", "ticketNumber": "T-1", "customerName": "Acme" }),
        );
        assert_eq!(title, "Ticket T-1");
        assert_eq!(subtitle.as_deref(), Some("#T-1 · Acme"));
        let (_, subtitle) = describe(
            SearchType::Domain,
            &json!({ "fullDomain": "a.nl", "registrar": "cloudflare", "status": "active" }),
        );
        assert_eq!(subtitle.as_deref(), Some("WeldSuite · active"));
        assert_eq!(escape_like("50%_a\\"), "50\\%\\_a\\\\");
    }

    #[test]
    fn the_schema_names_every_registered_type() {
        assert_eq!(ENTITY_TYPES.len(), REGISTRY.len());
        for (_, name, _) in REGISTRY {
            assert!(ENTITY_TYPES.contains(&name), "{name}");
        }
    }

    #[test]
    fn weldmerge_results() {
        assert_eq!(
            build_result_url(SearchType::MergeIssue, "mis_1", None),
            "/weldmerge/issues/mis_1"
        );
        assert_eq!(
            build_result_url(SearchType::MergePullRequest, "mpr 1", None),
            "/weldmerge/pull-requests/mpr%201"
        );
        let (title, subtitle) = describe(
            SearchType::MergeIssue,
            &json!({ "title": "", "key": "PLAT-209", "status": "in_progress" }),
        );
        assert_eq!(title, "PLAT-209");
        assert_eq!(subtitle.as_deref(), Some("PLAT-209 · in_progress"));
        let (title, subtitle) = describe(
            SearchType::MergePullRequest,
            &json!({ "title": "Bump deps", "number": 124, "repository": "acme/web", "state": "open" }),
        );
        assert_eq!(title, "Bump deps");
        assert_eq!(subtitle.as_deref(), Some("acme/web#124 · open"));
        assert_eq!(pull_request_number(" #124 "), Some(124));
        assert_eq!(pull_request_number("123"), Some(123));
        assert_eq!(pull_request_number("1234567890"), None);
        assert_eq!(pull_request_number("#"), None);
        assert_eq!(pull_request_number("chore/"), None);
    }
}
