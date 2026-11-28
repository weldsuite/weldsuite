//! `POST /api/search` (`routes/search/index.ts`, `services/search.ts`): the
//! federated search behind Cmd+K. Each permitted record type is matched with
//! `LIKE` against its own columns in the tenant database and scored by rule
//! (exact 1.0, prefix 0.9, substring 0.6; e-mail columns 1.0 / 0.7 / 0.3).
//! Types the caller may not read are left out, not refused. WeldBooks'
//! invoices and bills belong to a legal entity, and are found only in the
//! entities the caller may read them in (ADR SEC-015,
//! [`Searcher::readable_entities`]).

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder, QuerySelect,
    Select,
};
use serde_json::{Map, Value, json};
use weldsuite_core_domain::drive_access::{
    VisibleFiles, load_drive_access_for_user, visible_files,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_legal_entities::{
    EntityAccess, EntityScopeCondition, LegalEntityApp, can_see_entity, default_entity_id_for,
    entity_role_id, load_entity_access, permissions_in_entity,
};
use weldsuite_permissions::{Permissions, ResolvedPermissions, has_any_app_permission};
use weldsuite_ports::DynCache;
use weldsuite_schema::tenant::enums::{HostDomainRegistrationStatus, HostDomainStatus};
use weldsuite_schema::tenant::{
    bank_transactions, bills, chat_channel_members, chat_channels, companies, crm_leads,
    crm_opportunities, desk_conversations, docs, documents, domains, files, form_access, forms,
    helpdesk_articles, helpdesk_tickets, invoices, knowledge_pages, knowledge_spaces, meetings,
    merge_issues, merge_pull_requests, merge_repositories, merge_teams, orders, panel_projects,
    parties, people, products, projects, reach_campaigns, sheets, sign_envelopes, sign_recipients,
    tasks, warehouses, weldagent_agent_members, weldagent_agents, welddata_lists, whiteboards,
    workflows, workspace_installed_apps, workspace_members,
};
use weldsuite_subscribers::search::ai::{WorkspaceEmbeddings, index_model};
use weldsuite_subscribers::search::backfill::{BackfillCursor, backfill_batch};

use crate::search_scope::entity_scope;
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
    Conversation,
    Article,
    KnowledgePage,
    Product,
    Order,
    Warehouse,
    Invoice,
    Bill,
    Project,
    Task,
    MergeIssue,
    MergePullRequest,
    Document,
    Sheet,
    Board,
    Form,
    SignEnvelope,
    DriveFile,
    Meeting,
    ChatChannel,
    ReachCampaign,
    DataList,
    PanelProject,
    Workflow,
    Agent,
    Domain,
    // WeldBooks records, searched only when asked for by name (`OPT_IN`).
    BankTransaction,
    AccountingContact,
    AccountingDocument,
}

/// Every type with the permission that lets a caller search it
/// (`ENTITY_REGISTRY`), in canonical order (`CANONICAL_ORDER`, which the
/// registry follows too). Where an object is shared between several apps the
/// key names the app the module's own routes are checked in.
const REGISTRY: [(SearchType, &str, &str); 31] = [
    (SearchType::Contact, "contact", "contacts:read"),
    (SearchType::Customer, "customer", "contacts:read"),
    (SearchType::Lead, "lead", "leads:read"),
    (SearchType::Opportunity, "opportunity", "opportunities:read"),
    (SearchType::Ticket, "ticket", "tickets:read"),
    (
        SearchType::Conversation,
        "conversation",
        "conversations:read",
    ),
    (SearchType::Article, "article", "articles:read"),
    (
        SearchType::KnowledgePage,
        "knowledge_page",
        "knowledge:read",
    ),
    (SearchType::Product, "product", "products:read"),
    // WeldCommerce's orders: app-qualified, so a WeldStash `orders` grant
    // doesn't surface sales orders in an app the member can't open. Also
    // needs WeldCommerce installed (`commerce_installed`).
    (SearchType::Order, "order", "weldcommerce:orders:read"),
    (SearchType::Warehouse, "warehouse", "warehouses:read"),
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
    (SearchType::Document, "document", "docs:read"),
    (SearchType::Sheet, "sheet", "sheets:read"),
    (SearchType::Board, "board", "boards:read"),
    (SearchType::Form, "form", "forms:read"),
    (
        SearchType::SignEnvelope,
        "sign_envelope",
        "sign_envelopes:read",
    ),
    (SearchType::DriveFile, "drive_file", "welddrive:files:read"),
    (SearchType::Meeting, "meeting", "weldmeet:meetings:read"),
    (
        SearchType::ChatChannel,
        "chat_channel",
        "weldchat:channels:read",
    ),
    (
        SearchType::ReachCampaign,
        "reach_campaign",
        "reach_campaigns:read",
    ),
    (SearchType::DataList, "data_list", "prospects:read"),
    (
        SearchType::PanelProject,
        "panel_project",
        "panel_projects:read",
    ),
    (
        SearchType::Workflow,
        "workflow",
        "weldconnect:workflows:read",
    ),
    (SearchType::Agent, "agent", "weldagent:read"),
    (SearchType::Domain, "domain", "domains:read"),
];

/// Types that are searched only when the client names them in `types`: a
/// default search (no `types`) and `permittedTypes` stay what the TypeScript
/// search answers (which does not know them). Entity-owned WeldBooks records,
/// each scoped to the legal entities the caller sees (`search_scope`).
const OPT_IN: [(SearchType, &str, &str); 3] = [
    (
        SearchType::BankTransaction,
        "bank_transaction",
        "banking:read",
    ),
    (
        SearchType::AccountingContact,
        "accounting_contact",
        "invoices:read",
    ),
    (
        SearchType::AccountingDocument,
        "accounting_document",
        "invoices:read",
    ),
];

/// `SEARCH_ENTITY_TYPES` of the types a default search covers: the names
/// `types` accepts, in the schema's own order (the enum's message lists them
/// so), which is not the canonical one.
pub(crate) const ENTITY_TYPES: [&str; 31] = [
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
    "document",
    "form",
    "drive_file",
    "conversation",
    "meeting",
    "sign_envelope",
    "warehouse",
    "workflow",
    "agent",
    "reach_campaign",
    "chat_channel",
    "data_list",
    "panel_project",
];

/// The names `types` accepts: [`ENTITY_TYPES`], then the opt-in ones (the
/// shared schema lists them last).
const INPUT_TYPES: [&str; 34] = [
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
    "document",
    "form",
    "drive_file",
    "conversation",
    "meeting",
    "sign_envelope",
    "warehouse",
    "workflow",
    "agent",
    "reach_campaign",
    "chat_channel",
    "data_list",
    "panel_project",
    "bank_transaction",
    "accounting_contact",
    "accounting_document",
];

impl SearchType {
    fn registration(self) -> Option<&'static (SearchType, &'static str, &'static str)> {
        REGISTRY
            .iter()
            .chain(OPT_IN.iter())
            .find(|(t, _, _)| *t == self)
    }

    pub(crate) fn as_str(self) -> &'static str {
        self.registration().map_or("", |(_, name, _)| name)
    }

    fn permission(self) -> &'static str {
        self.registration()
            .map_or("", |(_, _, permission)| permission)
    }

    pub(crate) fn parse(name: &str) -> Option<Self> {
        REGISTRY
            .iter()
            .chain(OPT_IN.iter())
            .find(|(_, n, _)| *n == name)
            .map(|(t, _, _)| *t)
    }

    /// Searched only when named in `types` ([`OPT_IN`]).
    fn is_opt_in(self) -> bool {
        OPT_IN.iter().any(|(t, _, _)| *t == self)
    }

    fn all() -> impl Iterator<Item = Self> {
        REGISTRY.iter().map(|(t, _, _)| *t)
    }
}

/// Where a result opens in the platform (`buildResultUrl`). Products open
/// as object panels on the WeldStash products list.
pub(crate) fn build_result_url(kind: SearchType, id: &str) -> String {
    build_result_url_for(kind, id, false)
}

/// [`build_result_url`] for a member who has the WeldCommerce app (`commerce`):
/// products open as object panels on its products page; orders always open
/// on WeldCommerce's orders page.
pub(crate) fn build_result_url_for(kind: SearchType, id: &str, commerce: bool) -> String {
    let encoded = encode_uri_component(id);
    match kind {
        SearchType::Contact => format!("/weldcrm/people?stack=person:{encoded}"),
        SearchType::Customer => format!("/weldcrm/companies?stack=company:{encoded}"),
        SearchType::Lead => format!("/weldcrm?entity=lead:{encoded}"),
        SearchType::Opportunity => format!("/weldcrm?entity=opportunity:{encoded}"),
        SearchType::Ticket => format!("/welddesk/inbox?entity=ticket:{encoded}"),
        SearchType::Article => format!("/welddesk/help-center/articles/{id}"),
        SearchType::KnowledgePage => format!("/weldknow/page/{id}"),
        SearchType::Product if commerce => {
            format!("/weldcommerce/products?stack=product:{encoded}")
        }
        SearchType::Product => format!("/weldstash/products?stack=product:{encoded}"),
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
        SearchType::Document => format!("/welddocs/{id}"),
        SearchType::Form => format!("/weldforms/{id}"),
        SearchType::DriveFile => format!("/welddrive?file={encoded}"),
        SearchType::Conversation => format!("/welddesk/inbox/{id}"),
        SearchType::Meeting => format!("/weldmeet/{id}"),
        SearchType::SignEnvelope => format!("/weldsign/{id}"),
        SearchType::Warehouse => format!("/weldstash/warehouses?stack=warehouse:{encoded}"),
        SearchType::Workflow => format!("/weldconnect/workflows/{id}"),
        SearchType::Agent => format!("/agents/{id}"),
        SearchType::ReachCampaign => format!("/weldreach/campaigns/{id}"),
        SearchType::ChatChannel => format!("/weldchat/{id}"),
        SearchType::DataList => format!("/welddata/lists/{id}"),
        SearchType::PanelProject => format!("/weldpanel/projects/{id}"),
        SearchType::BankTransaction => {
            format!("/weldbooks/banking/transactions?stack=bank_transaction:{encoded}")
        }
        // The contact panel is `weldbooks_contact`, on the one Contacts list.
        SearchType::AccountingContact => {
            format!("/weldbooks/contacts?stack=weldbooks_contact:{encoded}")
        }
        // An inbox document opens as a dialog on the documents page.
        SearchType::AccountingDocument => {
            format!("/weldbooks/documents?document={encoded}")
        }
    }
}

// ── The per-type queries ───────────────────────────────────────────────────

/// What every query matches and scores on: the lower-cased term, the prefix
/// pattern, the substring pattern (the term is not escaped, as in
/// TypeScript), and the row limit (one more than asked, for `hasMore`).
struct Term {
    lower: String,
    prefix: String,
    contains: String,
    limit: i64,
}

/// How a column scores: `scoreText` (1.0 exact, 0.9 prefix, 0.6 substring)
/// or an e-mail column (1.0, 0.7, 0.3).
#[derive(Clone, Copy)]
enum Scored {
    Text,
    Email,
}

/// A column of the type's table as an expression.
fn col(column: impl ColumnTrait) -> Expr {
    column.into_expr()
}

/// `lower(expr)`.
fn lower(expr: Expr) -> Expr {
    Func::lower(expr).into()
}

/// `lower(expr) like pattern`.
fn like(expr: Expr, pattern: &str) -> Expr {
    sea_orm::ExprTrait::like(lower(expr), pattern)
}

/// `case when lower(col) = $1 then 1.0 when lower(col) like $2 then 0.9
/// when lower(col) like $3 then 0.6 else 0 end` (an e-mail column: 0.7, 0.3).
fn score(expr: &Expr, kind: Scored, term: &Term) -> Expr {
    let (prefix, contains) = match kind {
        Scored::Text => (0.9, 0.6),
        Scored::Email => (0.7, 0.3),
    };
    Expr::case(
        sea_orm::ExprTrait::eq(lower(expr.clone()), term.lower.as_str()),
        1.0,
    )
    .case(like(expr.clone(), &term.prefix), prefix)
    .case(like(expr.clone(), &term.contains), contains)
    .finally(0.0)
    .into()
}

/// `greatest(score(a), score(b), …)`, or the one column's score.
fn best_score(columns: &[(Expr, Scored)], term: &Term) -> Expr {
    let mut scores: Vec<Expr> = columns
        .iter()
        .map(|(expr, kind)| score(expr, *kind, term))
        .collect();
    if scores.len() == 1 {
        return scores.remove(0);
    }
    Func::greatest(scores).into()
}

/// `lower(a) like $3 or lower(b) like $3 or …`.
fn any_like(columns: &[(Expr, Scored)], pattern: &str) -> Condition {
    columns.iter().fold(Condition::any(), |any, (expr, _)| {
        any.add(like(expr.clone(), pattern))
    })
}

/// One type's rows, each `{ row, score }`: `rows` (the type's table, joins,
/// filters and the `row` fields under their names) by `score`, best first,
/// then by `then` (last change, id), newest first; `limit` of them.
async fn ranked<E: EntityTrait>(
    db: &PgPool,
    rows: Select<E>,
    score: Expr,
    then: [Expr; 2],
    limit: i64,
) -> Result<Vec<Value>, DbErr> {
    let [changed, id] = then;
    let rows = rows
        .expr_as(score.clone(), "score")
        .order_by_desc(score)
        .order_by_desc(changed)
        .order_by_desc(id)
        .limit(u64::try_from(limit).unwrap_or(0))
        .into_json()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|mut row| {
            let score = row
                .as_object_mut()
                .and_then(|fields| fields.remove("score"))
                .unwrap_or(Value::Null);
            json!({ "row": row, "score": score })
        })
        .collect())
}

/// People by name or e-mail.
async fn search_contacts(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use people::Column as C;
    let columns = [
        (col(C::FullName), Scored::Text),
        (col(C::FirstName), Scored::Text),
        (col(C::LastName), Scored::Text),
        (col(C::Email), Scored::Email),
    ];
    let rows = people::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::FirstName, "firstName")
        .column_as(C::LastName, "lastName")
        .column_as(C::FullName, "fullName")
        .column_as(C::Email, "email")
        .column_as(C::Title, "title")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// Companies by name, trading name or e-mail.
async fn search_customers(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use companies::Column as C;
    let columns = [
        (col(C::Name), Scored::Text),
        (col(C::TradingName), Scored::Text),
        (col(C::Email), Scored::Email),
    ];
    let rows = companies::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Name, "name")
        .column_as(C::TradingName, "tradingName")
        .column_as(C::Email, "email")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// Leads by name, company or e-mail.
async fn search_leads(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use crm_leads::Column as C;
    let columns = [
        (col(C::FullName), Scored::Text),
        (col(C::FirstName), Scored::Text),
        (col(C::LastName), Scored::Text),
        (col(C::CompanyName), Scored::Text),
        (col(C::Email), Scored::Email),
    ];
    let rows = crm_leads::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::FirstName, "firstName")
        .column_as(C::LastName, "lastName")
        .column_as(C::FullName, "fullName")
        .column_as(C::CompanyName, "companyName")
        .column_as(C::Email, "email")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// Opportunities by name or customer.
async fn search_opportunities(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use crm_opportunities::Column as C;
    let columns = [
        (col(C::Name), Scored::Text),
        (col(C::CustomerName), Scored::Text),
    ];
    let rows = crm_opportunities::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Name, "name")
        .column_as(C::CustomerName, "customerName")
        .column_as(C::Stage, "stage")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// Tickets by subject, number or customer.
async fn search_tickets(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use helpdesk_tickets::Column as C;
    let columns = [
        (col(C::Subject), Scored::Text),
        (col(C::TicketNumber), Scored::Text),
        (col(C::CustomerName), Scored::Text),
        (col(C::CustomerEmail), Scored::Email),
    ];
    let rows = helpdesk_tickets::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::TicketNumber, "ticketNumber")
        .column_as(C::Subject, "subject")
        .column_as(C::Status, "status")
        .column_as(C::CustomerName, "customerName")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// Help center articles by title, slug or category.
async fn search_articles(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use helpdesk_articles::Column as C;
    let columns = [
        (col(C::Title), Scored::Text),
        (col(C::Slug), Scored::Text),
        (col(C::CategoryName), Scored::Text),
    ];
    let rows = helpdesk_articles::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Title, "title")
        .column_as(C::Slug, "slug")
        .column_as(C::Excerpt, "excerpt")
        .column_as(C::CategoryName, "categoryName")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// Knowledge pages of open team spaces, by title or text.
async fn search_knowledge_pages(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use knowledge_pages::Column as C;
    use knowledge_spaces::Column as S;
    let columns = [
        (col(C::Title), Scored::Text),
        (col(C::ContentText), Scored::Text),
    ];
    let rows = knowledge_pages::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Title, "title")
        .column_as(C::ContentText, "contentText")
        .column_as(S::Name, "spaceName")
        .join(
            JoinType::InnerJoin,
            knowledge_pages::Entity::belongs_to(knowledge_spaces::Entity)
                .from(C::SpaceId)
                .to(S::Id)
                .into(),
        )
        .filter(C::DeletedAt.is_null())
        .filter(S::DeletedAt.is_null())
        .filter(S::Kind.eq("team"))
        .filter(S::Visibility.eq("open"))
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// Products by name, SKU or barcode.
async fn search_products(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use products::Column as C;
    let columns = [
        (col(C::Name), Scored::Text),
        (col(C::Sku), Scored::Text),
        (col(C::Barcode), Scored::Text),
    ];
    let rows = products::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Name, "name")
        .column_as(C::Sku, "sku")
        .column_as(C::ShortDescription, "shortDescription")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// Orders by number, customer or external id; the total as Postgres prints it.
async fn search_orders(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use orders::Column as C;
    let columns = [
        (col(C::OrderNumber), Scored::Text),
        (col(C::CustomerName), Scored::Text),
        (col(C::CustomerEmail), Scored::Email),
        (col(C::ExternalOrderId), Scored::Text),
    ];
    let rows = orders::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::OrderNumber, "orderNumber")
        .column_as(C::CustomerName, "customerName")
        .column_as(C::CustomerEmail, "customerEmail")
        .expr_as(Func::cast_as(col(C::Total), "text"), "total")
        .column_as(C::Currency, "currency")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// Invoices by number or contact, of the legal entities `entities` names
/// (`None`: every entity; see [`Searcher::readable_entities`]).
async fn search_invoices(
    db: &PgPool,
    term: &Term,
    entities: Option<&[String]>,
) -> Result<Vec<Value>, DbErr> {
    use invoices::Column as C;
    if entities.is_some_and(<[String]>::is_empty) {
        return Ok(Vec::new());
    }
    let columns = [
        (col(C::InvoiceNumber), Scored::Text),
        (col(C::ContactName), Scored::Text),
        (col(C::ContactEmail), Scored::Email),
    ];
    let mut rows = invoices::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::InvoiceNumber, "invoiceNumber")
        .column_as(C::ContactName, "contactName")
        .column_as(C::Status, "status")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    if let Some(entities) = entities {
        rows = rows.filter(C::EntityId.is_in(entities.iter().map(String::as_str)));
    }
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// Bills by number or contact, of the legal entities `entities` names
/// (`None`: every entity; see [`Searcher::readable_entities`]).
async fn search_bills(
    db: &PgPool,
    term: &Term,
    entities: Option<&[String]>,
) -> Result<Vec<Value>, DbErr> {
    use bills::Column as C;
    if entities.is_some_and(<[String]>::is_empty) {
        return Ok(Vec::new());
    }
    let columns = [
        (col(C::BillNumber), Scored::Text),
        (col(C::ContactName), Scored::Text),
    ];
    let mut rows = bills::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::BillNumber, "billNumber")
        .column_as(C::ContactName, "contactName")
        .column_as(C::Status, "status")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    if let Some(entities) = entities {
        rows = rows.filter(C::EntityId.is_in(entities.iter().map(String::as_str)));
    }
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// Bank lines of the entities the caller sees, by counterparty, description,
/// reference or amount (as text).
async fn search_bank_transactions(
    db: &PgPool,
    term: &Term,
    scope: &EntityScopeCondition,
) -> Result<Vec<Value>, DbErr> {
    use bank_transactions::Column as C;
    let amount = || Func::cast_as(col(C::Amount), "text").into();
    let columns = [
        (col(C::CounterpartyName), Scored::Text),
        (col(C::Description), Scored::Text),
        (col(C::Reference), Scored::Text),
        (amount(), Scored::Text),
    ];
    let rows = bank_transactions::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .expr_as(Func::cast_as(col(C::Date), "text"), "date")
        .expr_as(amount(), "amount")
        .column_as(C::CounterpartyName, "counterpartyName")
        .column_as(C::Description, "description")
        .column_as(C::Reference, "reference")
        .column_as(C::Status, "status")
        .filter(C::DeletedAt.is_null())
        .filter(scope.condition(C::EntityId))
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::Date), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// WeldBooks contacts (`parties`) by name, e-mail, VAT number or `KvK` number.
/// Contacts belong to the workspace, not to an entity, as in the contacts list.
async fn search_accounting_contacts(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use parties::Column as C;
    let columns = [
        (col(C::DisplayName), Scored::Text),
        (col(companies::Column::Email), Scored::Email),
        (col(people::Column::Email), Scored::Email),
        (col(companies::Column::VatNumber), Scored::Text),
        (col(companies::Column::RegistrationNumber), Scored::Text),
    ];
    let rows = parties::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::DisplayName, "displayName")
        .column_as(C::Role, "role")
        .join(
            JoinType::LeftJoin,
            parties::Entity::belongs_to(companies::Entity)
                .from(C::CompanyId)
                .to(companies::Column::Id)
                .into(),
        )
        .join(
            JoinType::LeftJoin,
            parties::Entity::belongs_to(people::Entity)
                .from(C::PersonId)
                .to(people::Column::Id)
                .into(),
        )
        .filter(C::DeletedAt.is_null())
        .filter(C::ArchivedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// Inbox documents of the entities the caller sees (those with no entity
/// count for the default one), by file name and the OCR's vendor and invoice
/// number.
async fn search_accounting_documents(
    db: &PgPool,
    term: &Term,
    scope: &EntityScopeCondition,
) -> Result<Vec<Value>, DbErr> {
    use documents::Column as C;
    let columns = [
        (col(C::FileName), Scored::Text),
        (
            Expr::cust("documents.ocr_result -> 'vendor' ->> 'name'"),
            Scored::Text,
        ),
        (
            Expr::cust("documents.ocr_result ->> 'invoiceNumber'"),
            Scored::Text,
        ),
    ];
    let rows = documents::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::FileName, "fileName")
        .column_as(C::Type, "type")
        .column_as(C::Status, "status")
        .filter(C::DeletedAt.is_null())
        .filter(scope.condition(C::EntityId))
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::CreatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// Projects by name or code.
async fn search_projects(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use projects::Column as C;
    let columns = [(col(C::Name), Scored::Text), (col(C::Code), Scored::Text)];
    let rows = projects::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Name, "name")
        .column_as(C::Code, "code")
        .column_as(C::Status, "status")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// Domains by name, without the unpaid ones and the cancelled failures.
async fn search_domains(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use domains::Column as C;
    let columns = [
        (col(C::FullDomain), Scored::Text),
        (col(C::Name), Scored::Text),
        (col(C::Tld), Scored::Text),
    ];
    let rows = domains::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::FullDomain, "fullDomain")
        .column_as(C::Name, "name")
        .column_as(C::Tld, "tld")
        .column_as(C::Status, "status")
        .column_as(C::Registrar, "registrar")
        .filter(C::DeletedAt.is_null())
        // `registration_status is distinct from 'pending_payment'`
        .filter(
            Condition::any()
                .add(C::RegistrationStatus.is_null())
                .add(C::RegistrationStatus.ne(HostDomainRegistrationStatus::PendingPayment)),
        )
        // `not (status = 'cancelled' and registration_status is not distinct from 'failed')`
        .filter(
            Condition::any()
                .add(C::Status.ne(HostDomainStatus::Cancelled))
                .add(C::RegistrationStatus.is_null())
                .add(C::RegistrationStatus.ne(HostDomainRegistrationStatus::Failed)),
        )
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// WeldStash warehouses by name or code.
async fn search_warehouses(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use warehouses::Column as C;
    let columns = [(col(C::Name), Scored::Text), (col(C::Code), Scored::Text)];
    let rows = warehouses::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Name, "name")
        .column_as(C::Code, "code")
        .column_as(C::City, "city")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// WeldConnect workflows by name, without the CRM sequences that share the
/// table (`not (coalesce(tags, '[]') ? '__type:sequence')`, tags being an
/// array of strings).
async fn search_workflows(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use sea_orm::sea_query::extension::postgres::PgExpr;
    use workflows::Column as C;
    let columns = [(col(C::Name), Scored::Text)];
    let tags = Expr::from(Func::coalesce([col(C::Tags), Expr::val(json!([]))]));
    let rows = workflows::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Name, "name")
        .column_as(C::Status, "status")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains))
        .filter(
            Condition::all()
                .add(PgExpr::contains(
                    tags,
                    Expr::val(json!(["__type:sequence"])),
                ))
                .not(),
        );
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// WeldReach campaigns by name.
async fn search_reach_campaigns(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use reach_campaigns::Column as C;
    let columns = [(col(C::Name), Scored::Text)];
    let rows = reach_campaigns::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Name, "name")
        .column_as(C::Status, "status")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// WeldData lists by name.
async fn search_data_lists(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use welddata_lists::Column as C;
    let columns = [(col(C::Name), Scored::Text)];
    let rows = welddata_lists::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Name, "name")
        .column_as(C::Description, "description")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// WeldPanel tracked projects by name.
async fn search_panel_projects(db: &PgPool, term: &Term) -> Result<Vec<Value>, DbErr> {
    use panel_projects::Column as C;
    let columns = [(col(C::Name), Scored::Text)];
    let rows = panel_projects::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Name, "name")
        .column_as(C::Kind, "kind")
        .column_as(C::Status, "status")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// WeldDesk conversations by title, customer, e-mail or the number a query
/// names (as for pull requests). Every conversation, as desk-api's inbox
/// lists them.
async fn search_conversations(
    db: &PgPool,
    term: &Term,
    number: Option<i32>,
) -> Result<Vec<Value>, DbErr> {
    use desk_conversations::Column as C;
    let columns = [
        (col(C::Title), Scored::Text),
        (col(C::Name), Scored::Text),
        (col(C::Email), Scored::Email),
    ];
    let mut matching = any_like(&columns, &term.contains);
    let mut scores: Vec<Expr> = columns
        .iter()
        .map(|(expr, kind)| score(expr, *kind, term))
        .collect();
    // `case when $5 is not null and conversation_number = $5 then 1.0 else 0 end`:
    // without a number it is 0, which no greatest of scores falls below.
    if let Some(number) = number {
        matching = matching.add(C::ConversationNumber.eq(number));
        scores.push(
            Expr::case(C::ConversationNumber.eq(number), 1.0)
                .finally(0.0)
                .into(),
        );
    }
    let rows = desk_conversations::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Title, "title")
        .column_as(C::Name, "name")
        .column_as(C::Email, "email")
        .column_as(C::ConversationNumber, "conversationNumber")
        .filter(matching);
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, Func::greatest(scores).into(), then, term.limit).await
}

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
        SearchType::Order => (first(&[s("orderNumber")]).unwrap_or("Order").to_owned(), {
            let total = first(&[s("total")]).map(|total| match first(&[s("currency")]) {
                Some(currency) => format!("{total} {currency}"),
                None => total.to_owned(),
            });
            let parts: Vec<String> = first(&[s("customerName"), s("customerEmail")])
                .map(str::to_owned)
                .into_iter()
                .chain(total)
                .collect();
            (!parts.is_empty()).then(|| parts.join(" · "))
        }),
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
        SearchType::Document => (first(&[s("name")]).unwrap_or("Document").to_owned(), None),
        SearchType::DriveFile => (first(&[s("name")]).unwrap_or("File").to_owned(), None),
        SearchType::Form => (
            first(&[s("title")]).unwrap_or("Form").to_owned(),
            owned(first(&[s("status")])),
        ),
        SearchType::Conversation => {
            let number = match &row["conversationNumber"] {
                Value::Number(number) => number.to_string(),
                _ => "null".to_owned(),
            };
            let title = first(&[s("title"), s("name"), s("email")])
                .map_or_else(|| format!("Conversation #{number}"), str::to_owned);
            let subtitle = with_suffix(&format!("#{number}"), first(&[s("name"), s("email")]));
            (title, Some(subtitle))
        }
        SearchType::Meeting => (
            first(&[s("title")]).unwrap_or("Meeting").to_owned(),
            owned(first(&[s("status")])),
        ),
        SearchType::SignEnvelope => (
            first(&[s("title")])
                .unwrap_or("Signature request")
                .to_owned(),
            owned(first(&[s("status")])),
        ),
        SearchType::Warehouse => (
            first(&[s("name")]).unwrap_or("Warehouse").to_owned(),
            owned(first(&[s("code"), s("city")])),
        ),
        SearchType::Workflow => (
            first(&[s("name")]).unwrap_or("Workflow").to_owned(),
            owned(first(&[s("status")])),
        ),
        SearchType::Agent => (
            first(&[s("name")]).unwrap_or("Agent").to_owned(),
            first(&[s("description")]).map(excerpt),
        ),
        SearchType::ReachCampaign => (
            first(&[s("name")]).unwrap_or("Campaign").to_owned(),
            owned(first(&[s("status")])),
        ),
        SearchType::ChatChannel => (
            first(&[s("name")]).unwrap_or("Channel").to_owned(),
            first(&[s("topic"), s("description")]).map(excerpt),
        ),
        SearchType::DataList => (
            first(&[s("name")]).unwrap_or("List").to_owned(),
            first(&[s("description")]).map(excerpt),
        ),
        SearchType::PanelProject => (
            first(&[s("name")]).unwrap_or("Project").to_owned(),
            Some(with_suffix(s("kind").unwrap_or_default(), s("status"))),
        ),
        // Data, not sentences: the platform words them.
        SearchType::BankTransaction => (
            first(&[s("counterpartyName"), s("description"), s("reference")])
                .unwrap_or("Bank transaction")
                .to_owned(),
            Some(
                [
                    s("date").map(|date| date.chars().take(10).collect::<String>()),
                    s("amount").map(str::to_owned),
                    s("status").map(str::to_owned),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · "),
            ),
        ),
        SearchType::AccountingContact => (
            first(&[s("displayName")]).unwrap_or("Contact").to_owned(),
            owned(first(&[s("role")])),
        ),
        SearchType::AccountingDocument => (
            first(&[s("fileName")]).unwrap_or("Document").to_owned(),
            Some(with_suffix(s("type").unwrap_or_default(), s("status"))),
        ),
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
fn group(kind: SearchType, rows: &[Value], limit: usize, commerce: bool) -> Value {
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
                "url": build_result_url_for(kind, id, commerce),
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

/// Who is searching (`SearchCaller`): the user (`None`: no one, so the types
/// that are visible per person return nothing), a permission check against
/// the same any-app subject that gates the types themselves, the caller's
/// WeldDrive visibility, loaded once for every Drive-backed type of a search,
/// and their per-entity access, loaded once for WeldBooks' types.
struct Searcher<'a> {
    user_id: Option<&'a str>,
    /// The caller's workspace permissions, for the entities they see.
    permissions: Option<&'a Permissions>,
    can: &'a (dyn Fn(&str) -> bool + Sync),
    drive: Drive,
    /// The legal entities whose records the caller may see, loaded once.
    scope: Option<EntityScopeCondition>,
    /// The caller's workspace permissions, before any entity role (`None`:
    /// none resolved, so no entity is readable).
    workspace: Option<&'a ResolvedPermissions>,
    /// The per-entity access snapshot, once loaded.
    entities: Option<Arc<EntityAccess>>,
    /// The permissions inside each entity where the caller has an entity
    /// role, once resolved.
    in_entity: HashMap<String, ResolvedPermissions>,
}

/// The caller's WeldDrive visibility, as far as it has been loaded.
enum Drive {
    Unloaded,
    /// An admin sees every file.
    Admin,
    Limited(VisibleFiles),
}

impl<'a> Searcher<'a> {
    /// A searcher for `user_id` with `permissions`, nothing loaded yet.
    fn new(
        user_id: Option<&'a str>,
        permissions: Option<&'a Permissions>,
        can: &'a (dyn Fn(&str) -> bool + Sync),
    ) -> Self {
        Self {
            user_id,
            permissions,
            can,
            drive: Drive::Unloaded,
            scope: None,
            workspace: permissions.map(Permissions::resolved),
            entities: None,
            in_entity: HashMap::new(),
        }
    }

    /// Which legal entities' records this caller may be shown, for any
    /// entity-owned type (`search_scope::entity_scope`).
    async fn entity_scope(&mut self, db: &PgPool) -> Result<EntityScopeCondition, DbErr> {
        if self.scope.is_none() {
            self.scope = Some(entity_scope(db, self.user_id, self.permissions).await?);
        }
        Ok(self.scope.clone().unwrap_or(EntityScopeCondition::Nothing))
    }

    /// [`Self::entity_scope`] narrowed to the entities where the caller may
    /// read `permission` with the role they act with there
    /// ([`Self::readable_entities`], as for invoices and bills). Rows without
    /// an entity count as the default entity's, so they stay only when the
    /// default entity is readable.
    async fn readable_scope(
        &mut self,
        db: &PgPool,
        permission: &str,
    ) -> Result<EntityScopeCondition, DbErr> {
        let scope = self.entity_scope(db).await?;
        let Some(readable) = self.readable_entities(db, permission).await? else {
            return Ok(scope);
        };
        let default = default_entity_id_for(db, Some(LegalEntityApp::Weldbooks)).await?;
        let default_readable = default
            .as_deref()
            .is_some_and(|id| readable.iter().any(|entity| entity == id));
        Ok(match scope {
            EntityScopeCondition::Nothing => EntityScopeCondition::Nothing,
            EntityScopeCondition::All => EntityScopeCondition::In {
                ids: readable,
                include_unassigned: default_readable,
            },
            EntityScopeCondition::In {
                ids,
                include_unassigned,
            } => EntityScopeCondition::In {
                ids: ids.into_iter().filter(|id| readable.contains(id)).collect(),
                include_unassigned: include_unassigned && default_readable,
            },
        })
    }

    /// `visibleFilesCondition` for this caller (`None`: an admin sees every file).
    async fn visible_files(&mut self, db: &PgPool) -> Result<Option<VisibleFiles>, DbErr> {
        if matches!(self.drive, Drive::Unloaded) {
            let access = load_drive_access_for_user(db, self.user_id).await?;
            self.drive = match visible_files(&access) {
                Some(visible) => Drive::Limited(visible),
                None => Drive::Admin,
            };
        }
        Ok(match &self.drive {
            Drive::Limited(visible) => Some(visible.clone()),
            Drive::Unloaded | Drive::Admin => None,
        })
    }

    /// The legal entities whose records the caller may find with `permission`
    /// (WeldBooks' invoices and bills): the entities they see
    /// ([`can_see_entity`]: the open ones, the restricted ones they are listed
    /// on, every one for the owner), each with the role they act with there
    /// ([`permissions_in_entity`]: their entity role, or the workspace role).
    /// `None` when that is every entity, so no filter is needed.
    async fn readable_entities(
        &mut self,
        db: &PgPool,
        permission: &str,
    ) -> Result<Option<Vec<String>>, DbErr> {
        let Some(workspace) = self.workspace else {
            return Ok(Some(Vec::new()));
        };
        if self.entities.is_none() {
            let user_id = self.user_id.unwrap_or_default();
            let access = load_entity_access(db, user_id, workspace.clone()).await?;
            self.entities = Some(Arc::new(access));
        }
        let Some(access) = self.entities.clone() else {
            return Ok(Some(Vec::new()));
        };
        // The same access in every entity: the workspace role, which let the
        // type through, applies everywhere.
        if access.uniform {
            return Ok(None);
        }
        let mut readable = Vec::new();
        let mut hidden = false;
        for id in access.entity_ids() {
            if can_see_entity(&access, Some(id))
                && self.reads_in_entity(db, &access, id, permission).await?
            {
                readable.push(id.to_owned());
            } else {
                hidden = true;
            }
        }
        Ok(hidden.then_some(readable))
    }

    /// Whether `permission` holds inside an entity the caller sees, with the
    /// role they act with there.
    async fn reads_in_entity(
        &mut self,
        db: &PgPool,
        access: &EntityAccess,
        entity_id: &str,
        permission: &str,
    ) -> Result<bool, DbErr> {
        if entity_role_id(access, Some(entity_id)).is_none() {
            return Ok(has_any_app_permission(
                &access.workspace_permissions,
                &[permission],
                None,
            ));
        }
        if !self.in_entity.contains_key(entity_id) {
            let resolved = permissions_in_entity(db, access, entity_id).await?;
            self.in_entity.insert(entity_id.to_owned(), resolved);
        }
        Ok(self
            .in_entity
            .get(entity_id)
            .is_some_and(|resolved| has_any_app_permission(resolved, &[permission], None)))
    }
}

/// The term with its patterns escaped, so a typed `_` or `%` matches itself
/// (`likeTerms`). The older types bind it as typed, as TypeScript does.
fn escaped_term(q: &str, limit: usize) -> Term {
    let lower = q.to_lowercase();
    let escaped = escape_like(&lower);
    Term {
        prefix: format!("{escaped}%"),
        contains: format!("%{escaped}%"),
        lower,
        limit: i64::try_from(limit + 1).unwrap_or(i64::MAX),
    }
}

/// Whether the workspace has WeldCommerce installed (an active
/// `workspace_installed_apps` row), as `listMemberAppCodes` reads it.
async fn commerce_installed(db: &PgPool) -> Result<bool, DbErr> {
    use workspace_installed_apps::Column as C;
    let found: Option<String> = workspace_installed_apps::Entity::find()
        .select_only()
        .column(C::AppCode)
        .filter(C::AppCode.eq("weldcommerce"))
        .filter(C::IsActive.eq(true))
        .filter(C::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

/// The rows of one type, each `{ row, score }`.
async fn search_rows(
    db: &PgPool,
    kind: SearchType,
    q: &str,
    limit: usize,
    who: &mut Searcher<'_>,
) -> Result<Vec<Value>, DbErr> {
    let lower = q.to_lowercase();
    let term = Term {
        prefix: format!("{lower}%"),
        contains: format!("%{lower}%"),
        lower,
        limit: i64::try_from(limit + 1).unwrap_or(i64::MAX),
    };
    match kind {
        SearchType::Contact => search_contacts(db, &term).await,
        SearchType::Customer => search_customers(db, &term).await,
        SearchType::Lead => search_leads(db, &term).await,
        SearchType::Opportunity => search_opportunities(db, &term).await,
        SearchType::Ticket => search_tickets(db, &term).await,
        SearchType::Article => search_articles(db, &term).await,
        SearchType::KnowledgePage => search_knowledge_pages(db, &term).await,
        SearchType::Product => search_products(db, &term).await,
        SearchType::Order => search_orders(db, &term).await,
        SearchType::Invoice => {
            let entities = who.readable_entities(db, kind.permission()).await?;
            search_invoices(db, &term, entities.as_deref()).await
        }
        SearchType::Bill => {
            let entities = who.readable_entities(db, kind.permission()).await?;
            search_bills(db, &term, entities.as_deref()).await
        }
        SearchType::Project => search_projects(db, &term).await,
        SearchType::Domain => search_domains(db, &term).await,
        SearchType::Task => search_tasks(db, q, &term).await,
        SearchType::MergeIssue => search_merge_issues(db, q, &term).await,
        SearchType::MergePullRequest => search_merge_pull_requests(db, q, &term).await,
        SearchType::Sheet => search_files(db, FileKind::Sheet, q, limit, who).await,
        SearchType::Board => search_files(db, FileKind::Board, q, limit, who).await,
        SearchType::Document => search_files(db, FileKind::Document, q, limit, who).await,
        SearchType::DriveFile => search_files(db, FileKind::File, q, limit, who).await,
        SearchType::Warehouse => search_warehouses(db, &escaped_term(q, limit)).await,
        SearchType::Workflow => search_workflows(db, &escaped_term(q, limit)).await,
        SearchType::ReachCampaign => search_reach_campaigns(db, &escaped_term(q, limit)).await,
        SearchType::DataList => search_data_lists(db, &escaped_term(q, limit)).await,
        SearchType::PanelProject => search_panel_projects(db, &escaped_term(q, limit)).await,
        SearchType::Conversation => {
            // The number a query names ("#42"), as for pull requests.
            search_conversations(db, &escaped_term(q, limit), pull_request_number(q)).await
        }
        SearchType::Form => search_forms(db, q, limit, who).await,
        SearchType::Meeting => search_meetings(db, q, limit, who).await,
        SearchType::SignEnvelope => search_sign_envelopes(db, q, limit, who).await,
        SearchType::ChatChannel => search_chat_channels(db, q, limit, who).await,
        SearchType::Agent => search_agents(db, q, limit, who).await,
        SearchType::BankTransaction => {
            let scope = who.readable_scope(db, kind.permission()).await?;
            search_bank_transactions(db, &escaped_term(q, limit), &scope).await
        }
        SearchType::AccountingContact => {
            search_accounting_contacts(db, &escaped_term(q, limit)).await
        }
        SearchType::AccountingDocument => {
            let scope = who.readable_scope(db, kind.permission()).await?;
            search_accounting_documents(db, &escaped_term(q, limit), &scope).await
        }
    }
}

/// Forms by title (`searchForms`): `forms:manage` sees every form, anyone else
/// those open to the workspace, their own and their access list's.
async fn search_forms(
    db: &PgPool,
    q: &str,
    limit: usize,
    who: &Searcher<'_>,
) -> Result<Vec<Value>, DbErr> {
    use forms::Column as C;
    let Some(user) = who.user_id else {
        return Ok(Vec::new());
    };
    let term = escaped_term(q, limit);
    let columns = [(col(C::Title), Scored::Text)];
    let mut rows = forms::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Title, "title")
        .column_as(C::Status, "status")
        .filter(any_like(&columns, &term.contains));
    if !(who.can)("forms:manage") {
        rows = rows.filter(
            Condition::any()
                .add(C::Access.eq("workspace"))
                .add(C::OwnerUserId.eq(user))
                .add(
                    C::Id.in_subquery(
                        Query::select()
                            .column(form_access::Column::FormId)
                            .from(form_access::Entity)
                            .and_where(form_access::Column::UserId.eq(user))
                            .to_owned(),
                    ),
                ),
        );
    }
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, &term), then, term.limit).await
}

/// Meetings by title (`searchMeetings`): the organiser's own, unless the caller
/// holds `meetings:scope:all`.
async fn search_meetings(
    db: &PgPool,
    q: &str,
    limit: usize,
    who: &Searcher<'_>,
) -> Result<Vec<Value>, DbErr> {
    use meetings::Column as C;
    let all = (who.can)("weldmeet:meetings:scope:all");
    if who.user_id.is_none() && !all {
        return Ok(Vec::new());
    }
    let term = escaped_term(q, limit);
    let columns = [(col(C::Title), Scored::Text)];
    let mut rows = meetings::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Title, "title")
        .column_as(C::Status, "status")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    if !all {
        rows = rows.filter(C::OrganizerId.eq(who.user_id));
    }
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, &term), then, term.limit).await
}

/// Signature requests by title (`searchSignEnvelopes`): the sender's own and
/// the sent ones with a recipient at the caller's e-mail address (the one their
/// member row holds), unless the caller holds `sign_envelopes:manage`.
async fn search_sign_envelopes(
    db: &PgPool,
    q: &str,
    limit: usize,
    who: &Searcher<'_>,
) -> Result<Vec<Value>, DbErr> {
    use sign_envelopes::Column as C;
    let manage = (who.can)("sign_envelopes:manage");
    if who.user_id.is_none() && !manage {
        return Ok(Vec::new());
    }
    let mut email: Option<String> = None;
    if let (false, Some(user)) = (manage, who.user_id) {
        let member: Option<Option<String>> = workspace_members::Entity::find()
            .select_only()
            .column(workspace_members::Column::Email)
            .filter(workspace_members::Column::UserId.eq(user))
            .filter(workspace_members::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(db))
            .await?;
        email = member.flatten().map(|email| email.to_lowercase());
    }
    let term = escaped_term(q, limit);
    let columns = [(col(C::Title), Scored::Text)];
    let mut rows = sign_envelopes::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Title, "title")
        .column_as(C::Status, "status")
        .filter(C::Kind.eq("envelope"))
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    if !manage {
        let mut theirs = Condition::any().add(C::SenderUserId.eq(who.user_id));
        if let Some(email) = email {
            theirs = theirs.add(
                Condition::all().add(C::Status.ne("draft")).add(
                    C::Id.in_subquery(
                        Query::select()
                            .column(sign_recipients::Column::EnvelopeId)
                            .from(sign_recipients::Entity)
                            .and_where(sign_recipients::Column::Email.eq(email))
                            .to_owned(),
                    ),
                ),
            );
        }
        rows = rows.filter(theirs);
    }
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, &term), then, term.limit).await
}

/// Channels by name (`searchChatChannels`): public ones and the private ones
/// the caller has joined. Direct messages and record channels are no channels
/// here.
async fn search_chat_channels(
    db: &PgPool,
    q: &str,
    limit: usize,
    who: &Searcher<'_>,
) -> Result<Vec<Value>, DbErr> {
    use chat_channels::Column as C;
    let Some(user) = who.user_id else {
        return Ok(Vec::new());
    };
    let term = escaped_term(q, limit);
    let columns = [(col(C::Name), Scored::Text)];
    let joined = C::Id.in_subquery(
        Query::select()
            .column(chat_channel_members::Column::ChannelId)
            .from(chat_channel_members::Entity)
            .and_where(chat_channel_members::Column::UserId.eq(user))
            .to_owned(),
    );
    let rows = chat_channels::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Name, "name")
        .column_as(C::Topic, "topic")
        .column_as(C::Description, "description")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains))
        .filter(
            Condition::any()
                .add(C::Type.eq("public"))
                .add(Condition::all().add(C::Type.eq("private")).add(joined)),
        );
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, &term), then, term.limit).await
}

/// Agents by name (`searchAgents`): `agentVisibleTo` for the caller (their
/// own, the workspace's, and the `members` agents they are listed on).
async fn search_agents(
    db: &PgPool,
    q: &str,
    limit: usize,
    who: &Searcher<'_>,
) -> Result<Vec<Value>, DbErr> {
    use weldagent_agents::Column as C;
    let manage = (who.can)("weldagent:manage");
    if who.user_id.is_none() && !manage {
        return Ok(Vec::new());
    }
    let user = who.user_id.unwrap_or_default();
    let term = escaped_term(q, limit);
    let columns = [(col(C::Name), Scored::Text)];
    let mut rows = weldagent_agents::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Name, "name")
        .column_as(C::Description, "description")
        .filter(C::DeletedAt.is_null())
        .filter(any_like(&columns, &term.contains));
    if !manage {
        let listed = C::Id.in_subquery(
            Query::select()
                .column(weldagent_agent_members::Column::AgentId)
                .from(weldagent_agent_members::Entity)
                .and_where(weldagent_agent_members::Column::UserId.eq(user))
                .to_owned(),
        );
        rows = rows.filter(
            Condition::any()
                .add(C::OwnerId.eq(user))
                .add(C::Visibility.eq("workspace"))
                .add(
                    Condition::all()
                        .add(C::Visibility.eq("members"))
                        .add(listed),
                ),
        );
    }
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, &term), then, term.limit).await
}

/// Tasks by title or key, and by number: "TASK-1042", "#1042" or "1042".
async fn search_tasks(db: &PgPool, q: &str, term: &Term) -> Result<Vec<Value>, DbErr> {
    use tasks::Column as C;
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
    let columns = [(col(C::Title), Scored::Text), (col(C::Key), Scored::Text)];
    let mut matching = any_like(&columns, &term.contains);
    if let Some(number) = number {
        matching = matching.add(C::Number.eq(number));
    }
    let rows = tasks::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Title, "title")
        .column_as(C::Key, "key")
        .column_as(C::Number, "number")
        .column_as(C::Status, "status")
        .filter(C::DeletedAt.is_null())
        .filter(matching);
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// WeldMerge issues by title or key (`PLAT-209`, or a part of it)
/// (`searchMergeIssues`): the `WHERE` matches the escaped term, the score
/// the raw one, as in TypeScript.
async fn search_merge_issues(db: &PgPool, q: &str, term: &Term) -> Result<Vec<Value>, DbErr> {
    use merge_issues::Column as C;
    use merge_teams::Column as T;
    use sea_orm::sea_query::extension::postgres::PgExpr;
    let contains = format!("%{}%", escape_like(&q.to_lowercase()));
    // `t.key || '-' || i.number::text`
    let key = || {
        PgExpr::concat(
            PgExpr::concat(col(T::Key), Expr::val("-")),
            Func::cast_as(col(C::Number), "text"),
        )
    };
    let columns = [(col(C::Title), Scored::Text), (key(), Scored::Text)];
    let rows = merge_issues::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Title, "title")
        .expr_as(key(), "key")
        .column_as(C::Status, "status")
        .join(
            JoinType::InnerJoin,
            merge_issues::Entity::belongs_to(merge_teams::Entity)
                .from(C::TeamId)
                .to(T::Id)
                .into(),
        )
        .filter(C::DeletedAt.is_null())
        .filter(T::DeletedAt.is_null())
        .filter(any_like(&columns, &contains));
    let then = [col(C::UpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
}

/// WeldMerge pull requests of repositories still connected, by title, branch
/// or number (`#123`, `123`) (`searchMergePullRequests`): the `WHERE`
/// matches the escaped term, the score the raw one, as in TypeScript.
async fn search_merge_pull_requests(
    db: &PgPool,
    q: &str,
    term: &Term,
) -> Result<Vec<Value>, DbErr> {
    use merge_pull_requests::Column as C;
    use merge_repositories::Column as R;
    let contains = format!("%{}%", escape_like(&q.to_lowercase()));
    let columns = [
        (col(C::Title), Scored::Text),
        (col(C::HeadRef), Scored::Text),
    ];
    let mut matching = any_like(&columns, &contains);
    if let Some(number) = pull_request_number(q) {
        matching = matching.add(C::Number.eq(number));
    }
    let rows = merge_pull_requests::Entity::find()
        .select_only()
        .column_as(C::Id, "id")
        .column_as(C::Title, "title")
        .column_as(C::Number, "number")
        .column_as(C::State, "state")
        .column_as(R::FullName, "repository")
        .join(
            JoinType::InnerJoin,
            merge_pull_requests::Entity::belongs_to(merge_repositories::Entity)
                .from(C::RepositoryId)
                .to(R::Id)
                .into(),
        )
        .filter(R::DeletedAt.is_null())
        .filter(matching);
    let then = [col(C::ProviderUpdatedAt), col(C::Id)];
    ranked(db, rows, best_score(&columns, term), then, term.limit).await
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

/// What is searched by the name of its Drive file.
#[derive(Clone, Copy)]
enum FileKind {
    Sheet,
    Board,
    Document,
    /// The Drive uploads themselves, not the files behind the other three.
    File,
}

/// A kind's rows on their Drive file (the record joined with `files`, or the
/// files themselves): the id a result carries and when the record last
/// changed.
struct FileRows<E: EntityTrait> {
    rows: Select<E>,
    id: Expr,
    changed: Expr,
}

/// A record kind (`sheets`, `whiteboards`, `docs`) joined with its file:
/// the record's id, and `greatest(s.updated_at, f.updated_at)`.
fn record_files<E: EntityTrait>(
    id: E::Column,
    file_id: E::Column,
    updated_at: E::Column,
) -> FileRows<E> {
    FileRows {
        rows: E::find().select_only().join(
            JoinType::InnerJoin,
            E::belongs_to(files::Entity)
                .from(file_id)
                .to(files::Column::Id)
                .into(),
        ),
        id: col(id),
        changed: Func::greatest([col(updated_at), col(files::Column::UpdatedAt)]).into(),
    }
}

/// `visibleFilesCondition`: a project's file, the caller's own, one shared
/// with them, one in a folder that grants them a role, or one open to the
/// workspace outside any folder or in an open one.
fn visible_condition(visible: &VisibleFiles) -> Condition {
    let mut any = Condition::any().add(files::Column::EntityType.is_not_null());
    if let Some(user_id) = &visible.user_id {
        any = any.add(files::Column::UploadedById.eq(user_id));
    }
    // `= any('{}')` matches nothing: an empty list adds no way in.
    if !visible.file_share_ids.is_empty() {
        any = any.add(files::Column::Id.is_in(&visible.file_share_ids));
    }
    if !visible.granted_folder_ids.is_empty() {
        any = any.add(files::Column::FolderId.is_in(&visible.granted_folder_ids));
    }
    let mut folder = Condition::any().add(files::Column::FolderId.is_null());
    if !visible.open_folder_ids.is_empty() {
        folder = folder.add(files::Column::FolderId.is_in(&visible.open_folder_ids));
    }
    any.add(
        Condition::all()
            .add(files::Column::GeneralAccess.ne("restricted"))
            .add(folder),
    )
}

/// A file none of the record kinds stands on:
/// `not exists (select 1 from docs d where d.file_id = f.id)`, and for
/// sheets and boards (`file_id` is never null in any of them).
fn no_record() -> Condition {
    Condition::all()
        .add(
            files::Column::Id.not_in_subquery(
                Query::select()
                    .column(docs::Column::FileId)
                    .from(docs::Entity)
                    .to_owned(),
            ),
        )
        .add(
            files::Column::Id.not_in_subquery(
                Query::select()
                    .column(sheets::Column::FileId)
                    .from(sheets::Entity)
                    .to_owned(),
            ),
        )
        .add(
            files::Column::Id.not_in_subquery(
                Query::select()
                    .column(whiteboards::Column::FileId)
                    .from(whiteboards::Entity)
                    .to_owned(),
            ),
        )
}

/// Spreadsheets, boards, documents or files, by the name of their Drive file,
/// as far as the WeldDrive rules let the caller see them (`searchSheets`,
/// `searchBoards`, `searchDocuments`, `searchFiles`). Without a user, none.
async fn search_files(
    db: &PgPool,
    kind: FileKind,
    q: &str,
    limit: usize,
    who: &mut Searcher<'_>,
) -> Result<Vec<Value>, DbErr> {
    if who.user_id.is_none() {
        return Ok(Vec::new());
    }
    let term = escaped_term(q, limit);
    match kind {
        FileKind::Sheet => {
            use sheets::Column as C;
            let rows = record_files::<sheets::Entity>(C::Id, C::FileId, C::UpdatedAt);
            search_file_rows(db, rows, Condition::all(), &term, who).await
        }
        FileKind::Board => {
            use whiteboards::Column as C;
            let rows = record_files::<whiteboards::Entity>(C::Id, C::FileId, C::UpdatedAt);
            search_file_rows(db, rows, Condition::all(), &term, who).await
        }
        FileKind::Document => {
            use docs::Column as C;
            let rows = record_files::<docs::Entity>(C::Id, C::FileId, C::UpdatedAt);
            // A document has a checkpoint (older ones of WeldFlow do not).
            let only = Condition::all().add(C::SnapshotKey.is_not_null());
            search_file_rows(db, rows, only, &term, who).await
        }
        FileKind::File => {
            let rows = FileRows {
                rows: files::Entity::find().select_only(),
                id: col(files::Column::Id),
                changed: col(files::Column::UpdatedAt),
            };
            search_file_rows(db, rows, no_record(), &term, who).await
        }
    }
}

/// [`search_files`] on one kind's rows; `only` is what else makes a row one
/// of the kind.
async fn search_file_rows<E: EntityTrait>(
    db: &PgPool,
    source: FileRows<E>,
    only: Condition,
    term: &Term,
    who: &mut Searcher<'_>,
) -> Result<Vec<Value>, DbErr> {
    let name = || col(files::Column::FileName);
    let matching = Condition::all()
        .add(files::Column::DeletedAt.is_null())
        .add(files::Column::EntityType.is_null())
        .add(only)
        .add(like(name(), &term.contains));
    // Most keystrokes match nothing: skip the access rules until a row does.
    let candidate: Option<String> = source
        .rows
        .clone()
        .expr_as(source.id.clone(), "id")
        .filter(matching.clone())
        .into_tuple()
        .one(&orm(db))
        .await?;
    if candidate.is_none() {
        return Ok(Vec::new());
    }
    let mut filter = matching;
    if let Some(visible) = who.visible_files(db).await? {
        filter = filter.add(visible_condition(&visible));
    }
    let rows = source
        .rows
        .expr_as(source.id.clone(), "id")
        .column_as(files::Column::FileName, "name")
        .filter(filter);
    let score = score(&name(), Scored::Text, term);
    ranked(db, rows, score, [source.changed, source.id], term.limit).await
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
    let names: Vec<&str> = INPUT_TYPES.to_vec();
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
            // WeldCommerce (EU edition) joins search once the workspace has
            // installed it: its orders, and its products page as the link.
            // Global never has it, so the TypeScript search answers alike there.
            let commerce = commerce_installed(&caller.db).await?;
            let permitted: Vec<SearchType> = SearchType::all()
                .filter(|t| allowed(*t) && (commerce || *t != SearchType::Order))
                .collect();
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
            let mut filtered: Vec<SearchType> = permitted
                .iter()
                .copied()
                .filter(|t| scoped.contains(t))
                .collect();
            // The WeldBooks record types a client asked for by name, after the
            // others (never part of a default search or `permittedTypes`).
            filtered.extend(
                input
                    .types
                    .iter()
                    .flatten()
                    .copied()
                    .filter(|t| t.is_opt_in() && allowed(*t))
                    .fold(Vec::new(), |mut unique, t| {
                        if !unique.contains(&t) {
                            unique.push(t);
                        }
                        unique
                    }),
            );
            let term = match parsed.lexical_term.trim() {
                "" => input.q.as_str(),
                term => term,
            };
            let mut groups = Vec::with_capacity(filtered.len());
            // `SearchCaller`: no user, no per-person records (an empty id is no user).
            let can = |key: &str| {
                caller.permissions.as_ref().is_some_and(|permissions| {
                    has_any_app_permission(permissions.resolved(), &[key], None)
                })
            };
            let mut who = Searcher::new(
                caller.user_id.as_deref().filter(|id| !id.is_empty()),
                caller.permissions.as_ref(),
                &can,
            );
            for kind in &filtered {
                let rows = search_rows(&caller.db, *kind, term, input.limit, &mut who).await?;
                groups.push((
                    *kind,
                    group(
                        *kind,
                        &rows,
                        input.limit,
                        commerce && can("weldcommerce:products:read"),
                    ),
                ));
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
                .choice(fields, "entityType", Presence::Required, &INPUT_TYPES)
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
            build_result_url(SearchType::Contact, "per 1"),
            "/weldcrm/people?stack=person:per%201"
        );
        assert_eq!(
            build_result_url(SearchType::Product, "p1"),
            "/weldstash/products?stack=product:p1"
        );
        assert_eq!(
            build_result_url_for(SearchType::Product, "p1", true),
            "/weldcommerce/products?stack=product:p1"
        );
        assert_eq!(
            build_result_url(SearchType::Order, "ord_1"),
            "/weldcommerce/orders?stack=order:ord_1"
        );
        let (title, subtitle) = describe(
            SearchType::Order,
            &json!({ "orderNumber": "WC-1001", "customerName": "Ann", "customerEmail": null, "total": "12.50", "currency": "EUR" }),
        );
        assert_eq!(title, "WC-1001");
        assert_eq!(subtitle.as_deref(), Some("Ann · 12.50 EUR"));
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
    fn the_registry_is_in_canonical_order_and_named_by_the_schema() {
        let names: Vec<&str> = REGISTRY.iter().map(|(_, name, _)| *name).collect();
        assert_eq!(
            names,
            [
                "contact",
                "customer",
                "lead",
                "opportunity",
                "ticket",
                "conversation",
                "article",
                "knowledge_page",
                "product",
                "order",
                "warehouse",
                "invoice",
                "bill",
                "project",
                "task",
                "merge_issue",
                "merge_pull_request",
                "document",
                "sheet",
                "board",
                "form",
                "sign_envelope",
                "drive_file",
                "meeting",
                "chat_channel",
                "reach_campaign",
                "data_list",
                "panel_project",
                "workflow",
                "agent",
                "domain",
            ]
        );
    }

    #[test]
    fn other_modules_results() {
        for (kind, id, url) in [
            (SearchType::Document, "doc_1", "/welddocs/doc_1"),
            (SearchType::Form, "frm_1", "/weldforms/frm_1"),
            (SearchType::DriveFile, "fil 1", "/welddrive?file=fil%201"),
            (SearchType::Conversation, "dcv_1", "/welddesk/inbox/dcv_1"),
            (SearchType::Meeting, "mtg_1", "/weldmeet/mtg_1"),
            (SearchType::SignEnvelope, "sgn_1", "/weldsign/sgn_1"),
            (
                SearchType::Warehouse,
                "whs_1",
                "/weldstash/warehouses?stack=warehouse:whs_1",
            ),
            (
                SearchType::Workflow,
                "wfl_1",
                "/weldconnect/workflows/wfl_1",
            ),
            (SearchType::Agent, "agt_1", "/agents/agt_1"),
            (
                SearchType::ReachCampaign,
                "rcmp_1",
                "/weldreach/campaigns/rcmp_1",
            ),
            (SearchType::ChatChannel, "chn_1", "/weldchat/chn_1"),
            (SearchType::DataList, "wdl_1", "/welddata/lists/wdl_1"),
            (
                SearchType::PanelProject,
                "pnp_1",
                "/weldpanel/projects/pnp_1",
            ),
        ] {
            assert_eq!(build_result_url(kind, id), url);
        }
        let (title, subtitle) = describe(
            SearchType::Conversation,
            &json!({ "title": null, "name": "Zeta Corp", "email": null, "conversationNumber": 4202 }),
        );
        assert_eq!(title, "Zeta Corp");
        assert_eq!(subtitle.as_deref(), Some("#4202 · Zeta Corp"));
        let (title, subtitle) = describe(
            SearchType::Conversation,
            &json!({ "title": "", "name": "", "email": null, "conversationNumber": 7 }),
        );
        assert_eq!(title, "Conversation #7");
        assert_eq!(subtitle.as_deref(), Some("#7"));
        let (title, subtitle) = describe(
            SearchType::Warehouse,
            &json!({ "name": "Zeta", "code": "", "city": "Rotterdam" }),
        );
        assert_eq!(
            (title.as_str(), subtitle.as_deref()),
            ("Zeta", Some("Rotterdam"))
        );
        let (_, subtitle) = describe(
            SearchType::PanelProject,
            &json!({ "name": "Site", "kind": "website", "status": "active" }),
        );
        assert_eq!(subtitle.as_deref(), Some("website · active"));
        let (_, subtitle) = describe(
            SearchType::ChatChannel,
            &json!({ "name": "general", "topic": null, "description": "All things" }),
        );
        assert_eq!(subtitle.as_deref(), Some("All things"));
        let (title, subtitle) = describe(
            SearchType::SignEnvelope,
            &json!({ "title": "", "status": "sent" }),
        );
        assert_eq!(
            (title.as_str(), subtitle.as_deref()),
            ("Signature request", Some("sent"))
        );
        let (title, subtitle) = describe(SearchType::Document, &json!({ "name": "" }));
        assert_eq!((title.as_str(), subtitle), ("Document", None));
    }

    #[test]
    fn typed_patterns_match_themselves() {
        let term = escaped_term("50%_A", 5);
        assert_eq!(term.lower, "50%_a");
        assert_eq!(term.prefix, "50\\%\\_a%");
        assert_eq!(term.contains, "%50\\%\\_a%");
        assert_eq!(term.limit, 6);
    }

    #[test]
    fn weldmerge_results() {
        assert_eq!(
            build_result_url(SearchType::MergeIssue, "mis_1"),
            "/weldmerge/issues/mis_1"
        );
        assert_eq!(
            build_result_url(SearchType::MergePullRequest, "mpr 1"),
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

/// The WeldBooks types against the real tenant schema (built from the
/// journaled migrations by `scripts/rust-test-db.ts`): what each one matches
/// and returns, and that bank lines and inbox documents come only from the
/// legal entities the caller sees (ADR SEC-015).
///
/// Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.
#[cfg(test)]
#[allow(
    clippy::disallowed_methods,
    clippy::too_many_lines,
    reason = "test fixtures are written in SQL, one scenario per test"
)]
mod books_tests {
    use std::collections::BTreeSet;

    use weldsuite_kit::generate_id;
    use weldsuite_permissions::ResolvedPermissions;

    use super::*;

    fn pool() -> Option<PgPool> {
        let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
            eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
            return None;
        };
        Some(weldsuite_db::master_pool(&url, 2).expect("tenant pool"))
    }

    async fn run(db: &PgPool, sql: &'static str, binds: &[&str]) {
        let mut query = sqlx::query(sql);
        for bind in binds {
            query = query.bind(*bind);
        }
        query.execute(db).await.expect(sql);
    }

    async fn entity(db: &PgPool, restricted: bool) -> String {
        let id = generate_id("ent");
        sqlx::query(
            "insert into entities (id, name, jurisdiction_code, base_currency, is_active, access_restricted) \
             values ($1, 'Search test', 'NL', 'EUR', true, $2)",
        )
        .bind(&id)
        .bind(restricted)
        .execute(db)
        .await
        .expect("entity");
        id
    }

    async fn member(db: &PgPool, entity: &str, user: &str) {
        run(
            db,
            "insert into legal_entity_members (id, entity_id, user_id) values ($1, $2, $3)",
            &[&generate_id("lem"), entity, user],
        )
        .await;
    }

    async fn line(db: &PgPool, entity: &str, counterparty: &str, amount: &str) -> String {
        let id = generate_id("btx");
        let bank = generate_id("bac");
        run(
            db,
            "insert into bank_accounts (id, entity_id, name, currency) values ($1, $2, 'Account', 'EUR')",
            &[&bank, entity],
        )
        .await;
        sqlx::query(
            "insert into bank_transactions (id, entity_id, bank_account_id, date, amount, description, \
               counterparty_name, reference, status) \
             values ($1, $2, $3, '2026-11-02', $4::numeric, 'Invoice settlement', $5, 'REF-77', 'unreconciled')",
        )
        .bind(&id)
        .bind(entity)
        .bind(&bank)
        .bind(amount)
        .bind(counterparty)
        .execute(db)
        .await
        .expect("bank line");
        id
    }

    async fn document(
        db: &PgPool,
        entity: Option<&str>,
        file_name: &str,
        ocr: Option<&str>,
    ) -> String {
        let id = generate_id("doc");
        sqlx::query(
            "insert into documents (id, entity_id, type, file_name, file_key, source, status, ocr_result) \
             values ($1, $2, 'purchase_invoice', $3, 'key', 'upload', 'processed', $4::jsonb)",
        )
        .bind(&id)
        .bind(entity)
        .bind(file_name)
        .bind(ocr)
        .execute(db)
        .await
        .expect("document");
        id
    }

    fn permissions(owner: bool, user: &str) -> Permissions {
        Permissions::new(
            ResolvedPermissions {
                is_owner: owner,
                ..ResolvedPermissions::default()
            },
            None,
            false,
            user.to_owned(),
        )
    }

    /// The legal entities `user` sees, as a searcher loads them.
    async fn scope_of(
        db: &PgPool,
        user: Option<&str>,
        permissions: Option<&Permissions>,
    ) -> EntityScopeCondition {
        let can = |_: &str| true;
        let mut who = Searcher::new(user, permissions, &can);
        who.entity_scope(db).await.expect("scope")
    }

    fn ids(rows: &[Value]) -> BTreeSet<String> {
        rows.iter()
            .filter_map(|r| r["row"]["id"].as_str().map(str::to_owned))
            .collect()
    }

    fn set<const N: usize>(values: [&String; N]) -> BTreeSet<String> {
        values.into_iter().cloned().collect()
    }

    #[tokio::test]
    async fn bank_lines_and_documents_come_only_from_visible_entities() {
        let Some(db) = pool() else { return };
        let marker = generate_id("zq").replace('_', "");
        let (open, secret, shared) = (
            entity(&db, false).await,
            entity(&db, true).await,
            entity(&db, true).await,
        );
        member(&db, &shared, "user_listed").await;
        let lines = [
            line(&db, &open, &marker, "10.00").await,
            line(&db, &secret, &marker, "10.00").await,
            line(&db, &shared, &marker, "10.00").await,
        ];
        let docs = [
            document(&db, Some(&open), &format!("{marker}-open.pdf"), None).await,
            document(&db, Some(&secret), &format!("{marker}-secret.pdf"), None).await,
            document(&db, Some(&shared), &format!("{marker}-shared.pdf"), None).await,
        ];
        let term = escaped_term(&marker, 20);
        let found = |scope: EntityScopeCondition| {
            let (db, term) = (&db, &term);
            async move {
                let lines = search_bank_transactions(db, term, &scope)
                    .await
                    .expect("lines");
                let docs = search_accounting_documents(db, term, &scope)
                    .await
                    .expect("docs");
                (ids(&lines), ids(&docs))
            }
        };

        // A member with workspace-wide read: the open entity, and the restricted one they are listed on.
        let plain = permissions(false, "user_listed");
        let listed = found(scope_of(&db, Some("user_listed"), Some(&plain)).await).await;
        assert_eq!(listed.0, set([&lines[0], &lines[2]]));
        assert_eq!(listed.1, set([&docs[0], &docs[2]]));

        // Not listed anywhere: the open entity only.
        let other = permissions(false, "user_other");
        let unlisted = found(scope_of(&db, Some("user_other"), Some(&other)).await).await;
        assert_eq!(unlisted.0, set([&lines[0]]));
        assert_eq!(unlisted.1, set([&docs[0]]));

        // The owner sees every entity.
        let owner = permissions(true, "user_owner");
        let all = found(scope_of(&db, Some("user_owner"), Some(&owner)).await).await;
        assert_eq!(all.0, set([&lines[0], &lines[1], &lines[2]]));
        assert_eq!(all.1, set([&docs[0], &docs[1], &docs[2]]));

        // No one: nothing.
        let nobody = found(scope_of(&db, None, None).await).await;
        assert!(nobody.0.is_empty() && nobody.1.is_empty());
    }

    #[tokio::test]
    async fn a_document_with_no_entity_is_the_default_entitys() {
        let Some(db) = pool() else { return };
        let marker = generate_id("zq").replace('_', "");
        let (default, secret) = (entity(&db, false).await, entity(&db, true).await);
        run(
            &db,
            "update entities set is_default = false where is_default",
            &[],
        )
        .await;
        run(
            &db,
            "update entities set is_default = true where id = $1",
            &[&default],
        )
        .await;
        run(
            &db,
            "insert into accounting_entity_settings (entity_id) values ($1)",
            &[&default],
        )
        .await;
        let unassigned = document(&db, None, &format!("{marker}.pdf"), None).await;
        let term = escaped_term(&marker, 20);
        let plain = permissions(false, "user_plain");
        let scope = scope_of(&db, Some("user_plain"), Some(&plain)).await;
        let rows = search_accounting_documents(&db, &term, &scope)
            .await
            .expect("docs");
        assert_eq!(ids(&rows), set([&unassigned]));

        // The default entity is restricted to others: its unassigned rows go with it.
        run(
            &db,
            "update entities set access_restricted = true where id = $1",
            &[&default],
        )
        .await;
        let scope = scope_of(&db, Some("user_plain"), Some(&plain)).await;
        let rows = search_accounting_documents(&db, &term, &scope)
            .await
            .expect("docs");
        assert!(rows.is_empty(), "{rows:?}");
        run(
            &db,
            "update entities set is_default = false where id = $1",
            &[&default],
        )
        .await;
        let _ = secret;
    }

    #[tokio::test]
    async fn bank_lines_match_on_counterparty_description_reference_and_amount() {
        let Some(db) = pool() else { return };
        let marker = generate_id("zq").replace('_', "");
        let open = entity(&db, false).await;
        let id = line(&db, &open, &format!("Vendor {marker} BV"), "1234.50").await;
        let gone = line(&db, &open, &format!("Vendor {marker} Deleted"), "1.00").await;
        run(
            &db,
            "update bank_transactions set deleted_at = now() where id = $1",
            &[&gone],
        )
        .await;
        let scope = EntityScopeCondition::All;
        let search = |q: String| {
            let (db, scope) = (&db, &scope);
            async move {
                let rows = search_bank_transactions(db, &escaped_term(&q, 20), scope)
                    .await
                    .expect("search");
                ids(&rows)
            }
        };
        assert_eq!(search(marker.clone()).await, set([&id]), "counterparty");
        assert_eq!(search(format!("{marker} bv")).await, set([&id]));
        assert!(search("zznomatch".into()).await.is_empty());
        for q in ["settlement", "ref-77", "1234.50"] {
            assert!(search(q.into()).await.contains(&id), "{q}");
        }

        let rows = search_bank_transactions(&db, &escaped_term(&marker, 20), &scope)
            .await
            .expect("search");
        let row = &rows[0]["row"];
        assert_eq!(row["id"], id.as_str());
        assert_eq!(row["amount"], "1234.50");
        assert_eq!(row["status"], "unreconciled");
        assert_eq!(
            row["counterpartyName"],
            format!("Vendor {marker} BV").as_str()
        );
        let g = group(SearchType::BankTransaction, &rows, 5, false);
        let item = &g["items"][0];
        assert_eq!(item["type"], "bank_transaction");
        assert_eq!(item["title"], format!("Vendor {marker} BV").as_str());
        assert_eq!(item["subtitle"], "2026-11-02 · 1234.50 · unreconciled");
        assert_eq!(
            item["url"],
            format!("/weldbooks/banking/transactions?stack=bank_transaction:{id}").as_str()
        );
    }

    #[tokio::test]
    async fn contacts_match_on_name_email_vat_and_kvk() {
        let Some(db) = pool() else { return };
        let marker = generate_id("zq").replace('_', "");
        let company = generate_id("cmp");
        sqlx::query(
            "insert into companies (id, name, display_name, email, vat_number, registration_number) \
             values ($1, $2, $2, $3, $4, $5)",
        )
        .bind(&company)
        .bind(format!("Acme {marker}"))
        .bind(format!("books@{marker}.example"))
        .bind(format!("NL{marker}B01"))
        .bind(format!("KVK{marker}"))
        .execute(&db)
        .await
        .expect("company");
        let person = generate_id("per");
        sqlx::query("insert into people (id, display_name, email) values ($1, $2, $3)")
            .bind(&person)
            .bind(format!("Jane {marker}"))
            .bind(format!("jane@{marker}-person.example"))
            .execute(&db)
            .await
            .expect("person");
        let by_company = generate_id("acn");
        let by_person = generate_id("acn");
        let archived = generate_id("acn");
        sqlx::query(
            "insert into parties (id, kind, display_name, role, company_id) values ($1, 'company', $2, 'supplier', $3)",
        )
        .bind(&by_company)
        .bind(format!("Acme {marker} BV"))
        .bind(&company)
        .execute(&db)
        .await
        .expect("party");
        sqlx::query(
            "insert into parties (id, kind, display_name, role, person_id) values ($1, 'person', $2, 'customer', $3)",
        )
        .bind(&by_person)
        .bind(format!("J. {marker}"))
        .bind(&person)
        .execute(&db)
        .await
        .expect("party");
        sqlx::query(
            "insert into parties (id, kind, display_name, role, archived_at) values ($1, 'company', $2, 'none', now())",
        )
        .bind(&archived)
        .bind(format!("Old {marker}"))
        .execute(&db)
        .await
        .expect("party");

        let search = |q: String| {
            let db = &db;
            async move {
                let rows = search_accounting_contacts(db, &escaped_term(&q, 20))
                    .await
                    .expect("search");
                ids(&rows)
            }
        };
        // The name (the archived one stays out), the company's e-mail, VAT and KvK, the person's e-mail.
        assert_eq!(search(marker.clone()).await, set([&by_company, &by_person]));
        assert_eq!(search(format!("books@{marker}")).await, set([&by_company]));
        assert_eq!(search(format!("nl{marker}b01")).await, set([&by_company]));
        assert_eq!(search(format!("kvk{marker}")).await, set([&by_company]));
        assert_eq!(search(format!("jane@{marker}")).await, set([&by_person]));
        assert!(search("zznomatch".into()).await.is_empty());

        let rows = search_accounting_contacts(&db, &escaped_term(&format!("kvk{marker}"), 20))
            .await
            .expect("search");
        let g = group(SearchType::AccountingContact, &rows, 5, false);
        assert_eq!(g["items"][0]["title"], format!("Acme {marker} BV").as_str());
        assert_eq!(g["items"][0]["subtitle"], "supplier");
        assert_eq!(g["items"][0]["type"], "accounting_contact");
    }

    #[tokio::test]
    async fn documents_match_on_file_name_and_ocr_vendor_and_invoice_number() {
        let Some(db) = pool() else { return };
        let marker = generate_id("zq").replace('_', "");
        let open = entity(&db, false).await;
        let by_name = document(&db, Some(&open), &format!("{marker}-scan.pdf"), None).await;
        let by_vendor = document(
            &db,
            Some(&open),
            "a.pdf",
            Some(&format!(
                r#"{{"vendor": {{"name": "Vendor {marker}"}}, "invoiceNumber": "F-1"}}"#
            )),
        )
        .await;
        let by_number = document(
            &db,
            Some(&open),
            "b.pdf",
            Some(&format!(
                r#"{{"vendor": {{"name": null}}, "invoiceNumber": "{marker}-INV"}}"#
            )),
        )
        .await;
        let gone = document(&db, Some(&open), &format!("{marker}-deleted.pdf"), None).await;
        run(
            &db,
            "update documents set deleted_at = now() where id = $1",
            &[&gone],
        )
        .await;
        let scope = EntityScopeCondition::All;
        let rows = search_accounting_documents(&db, &escaped_term(&marker, 20), &scope)
            .await
            .expect("search");
        assert_eq!(ids(&rows), set([&by_name, &by_vendor, &by_number]));
        let g = group(SearchType::AccountingDocument, &rows, 5, false);
        let first = g["items"]
            .as_array()
            .and_then(|items| items.iter().find(|i| i["id"] == by_name.as_str()))
            .expect("the file name's hit")
            .clone();
        assert_eq!(first["title"], format!("{marker}-scan.pdf").as_str());
        assert_eq!(first["subtitle"], "purchase_invoice · processed");
        assert_eq!(first["type"], "accounting_document");
        let none = search_accounting_documents(&db, &escaped_term("zznomatch", 20), &scope)
            .await
            .expect("search");
        assert_eq!(none, Vec::<Value>::new());
    }

    #[test]
    fn the_books_types_are_opt_in() {
        // A default search and `permittedTypes` stay what TypeScript answers.
        assert!(SearchType::all().all(|t| !t.is_opt_in()));
        assert_eq!(SearchType::all().count(), ENTITY_TYPES.len());
        for (kind, name, permission) in OPT_IN {
            assert!(kind.is_opt_in());
            assert_eq!(SearchType::parse(name), Some(kind));
            assert_eq!(kind.as_str(), name);
            assert_eq!(kind.permission(), permission);
            assert!(INPUT_TYPES.contains(&name), "{name}");
        }
        // The schema's list: the older types in their order, then these.
        assert_eq!(INPUT_TYPES[..ENTITY_TYPES.len()], ENTITY_TYPES);
        assert_eq!(INPUT_TYPES.len(), ENTITY_TYPES.len() + OPT_IN.len());
    }
}
