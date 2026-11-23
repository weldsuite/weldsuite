//! Built-in entities a custom object may link to, and how their records
//! resolve to a title and a link (`services/custom-object-targets.ts`).
//!
//! An allow-list: each entry names its table and title columns through the
//! table's entity, so a link's `targetEntityKey` (user input) never becomes
//! a table name. Adding a linkable entity is one entry here plus one in
//! `LINKABLE_BUILTIN_ENTITY_TYPES` and the TypeScript registry.

use std::collections::HashMap;

use sea_orm::{ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QuerySelect};
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{
    companies, crm_leads, crm_opportunities, crm_quotes, desk_conversations, helpdesk_tickets,
    invoices, orders, people, products, projects, tasks,
};

/// One linkable built-in entity type.
pub(crate) struct Target {
    pub(crate) entity_type: &'static str,
    pub(crate) label: &'static str,
    /// Needed to see records of this type: linking reads the target.
    pub(crate) read_permission: &'static str,
    href: &'static str,
    /// Where its records, their title and its fallback are read.
    table: Table,
}

/// The table of a linkable built-in entity type.
#[derive(Debug, Clone, Copy)]
enum Table {
    Companies,
    People,
    Leads,
    Opportunities,
    Quotes,
    Tickets,
    Conversations,
    Projects,
    Tasks,
    Products,
    Orders,
    Invoices,
}

/// In the TypeScript registry's order.
pub(crate) const TARGETS: [Target; 12] = [
    Target {
        entity_type: "company",
        label: "Company",
        read_permission: "companies:read",
        href: "/crm/companies/",
        table: Table::Companies,
    },
    Target {
        entity_type: "person",
        label: "Person",
        read_permission: "people:read",
        href: "/crm/people/",
        table: Table::People,
    },
    Target {
        entity_type: "lead",
        label: "Lead",
        read_permission: "leads:read",
        href: "/crm/leads/",
        table: Table::Leads,
    },
    Target {
        entity_type: "opportunity",
        label: "Deal",
        read_permission: "opportunities:read",
        href: "/crm/opportunities/",
        table: Table::Opportunities,
    },
    Target {
        entity_type: "quote",
        label: "Quote",
        read_permission: "quotes:read",
        href: "/crm/quotes/",
        table: Table::Quotes,
    },
    Target {
        entity_type: "ticket",
        label: "Ticket",
        read_permission: "tickets:read",
        href: "/welddesk/tickets/",
        table: Table::Tickets,
    },
    Target {
        entity_type: "conversation",
        label: "Conversation",
        read_permission: "conversations:read",
        href: "/welddesk/inbox/",
        table: Table::Conversations,
    },
    Target {
        entity_type: "project",
        label: "Project",
        read_permission: "projects:read",
        href: "/weldflow/projects/",
        table: Table::Projects,
    },
    Target {
        entity_type: "task",
        label: "Task",
        read_permission: "tasks:read",
        href: "/weldflow/task/",
        table: Table::Tasks,
    },
    Target {
        entity_type: "product",
        label: "Product",
        read_permission: "products:read",
        href: "/commerce/products/",
        table: Table::Products,
    },
    Target {
        entity_type: "order",
        label: "Order",
        read_permission: "orders:read",
        href: "/commerce/orders/",
        table: Table::Orders,
    },
    Target {
        entity_type: "invoice",
        label: "Invoice",
        read_permission: "invoices:read",
        href: "/weldbooks/invoices/",
        table: Table::Invoices,
    },
];

pub(crate) fn builtin(entity_type: &str) -> Option<&'static Target> {
    TARGETS.iter().find(|t| t.entity_type == entity_type)
}

/// `^co_[a-z][a-z0-9_]{0,23}$` → the slug (`customObjectSlugFromEntityKey`).
pub(crate) fn custom_object_slug(entity_key: &str) -> Option<&str> {
    weldsuite_events::is_custom_object_entity_key(entity_key).then(|| &entity_key[3..])
}

/// The permission that reads records of a link target
/// (`targetReadPermission`); `None` for an unknown type, which denies.
pub(crate) fn read_permission(target_entity_key: &str) -> Option<String> {
    if let Some(target) = builtin(target_entity_key) {
        return Some(target.read_permission.to_owned());
    }
    custom_object_slug(target_entity_key).map(|slug| format!("weldobjects:{slug}:read"))
}

/// A related record as a panel shows it.
#[derive(Debug, Clone)]
pub(crate) struct Resolved {
    pub(crate) id: String,
    pub(crate) entity_type: String,
    pub(crate) title: String,
    pub(crate) href: String,
}

/// Built-in records of one type by id (`resolveBuiltinTargets`); ids that
/// don't resolve are left out.
pub(crate) async fn resolve_builtin(
    db: &PgPool,
    entity_type: &str,
    ids: &[String],
) -> Result<HashMap<String, Resolved>, DbErr> {
    let mut out = HashMap::new();
    let Some(target) = builtin(entity_type) else {
        return Ok(out);
    };
    if ids.is_empty() {
        return Ok(out);
    }
    let rows = titles_of(&orm(db), target.table, ids).await?;
    for (id, title, fallback) in rows {
        // `row.title || row.fallback || row.id`: empty strings fall through.
        let title = title
            .filter(|t| !t.is_empty())
            .or(fallback.filter(|f| !f.is_empty()))
            .unwrap_or_else(|| id.clone());
        out.insert(
            id.clone(),
            Resolved {
                href: format!("{}{id}", target.href),
                id,
                entity_type: entity_type.to_owned(),
                title,
            },
        );
    }
    Ok(out)
}

/// `id, title, fallback` of a record.
type Titled = (String, Option<String>, Option<String>);

/// `id, title, fallback` of the rows of `table` whose id is in `ids` (not
/// empty), live ones only where the table soft-deletes.
async fn titles_of(
    db: &DatabaseConnection,
    table: Table,
    ids: &[String],
) -> Result<Vec<Titled>, DbErr> {
    // `id, <title>, <fallback>` of the table's live rows (`deleted_at is null`).
    macro_rules! live {
        ($table:ident, $title:ident, $fallback:ident) => {{
            use $table::{Column, Entity};
            titled::<Entity>(
                db,
                ids,
                Column::Id,
                Column::$title,
                Some(Column::$fallback),
                Some(Column::DeletedAt),
            )
            .await
        }};
        ($table:ident, $title:ident) => {{
            use $table::{Column, Entity};
            titled::<Entity>(
                db,
                ids,
                Column::Id,
                Column::$title,
                None,
                Some(Column::DeletedAt),
            )
            .await
        }};
    }
    match table {
        Table::Companies => live!(companies, Name, DisplayName),
        Table::People => live!(people, FullName, DisplayName),
        Table::Leads => live!(crm_leads, FullName, Email),
        Table::Opportunities => live!(crm_opportunities, Name),
        Table::Quotes => live!(crm_quotes, Name, QuoteNumber),
        Table::Tickets => live!(helpdesk_tickets, Subject),
        // Conversations are not soft-deleted: every row counts.
        Table::Conversations => {
            use desk_conversations::{Column, Entity};
            titled::<Entity>(db, ids, Column::Id, Column::Title, None, None).await
        }
        Table::Projects => live!(projects, Name),
        Table::Tasks => live!(tasks, Title),
        Table::Products => live!(products, Name),
        Table::Orders => live!(orders, OrderNumber),
        Table::Invoices => live!(invoices, InvoiceNumber),
    }
}

/// `select id, title, fallback from … where id = any(ids) [and deleted_at
/// is null]`; a table without a fallback reads it as `null`.
async fn titled<E: EntityTrait>(
    db: &DatabaseConnection,
    ids: &[String],
    id: E::Column,
    title: E::Column,
    fallback: Option<E::Column>,
    deleted_at: Option<E::Column>,
) -> Result<Vec<Titled>, DbErr> {
    let mut query = E::find()
        .select_only()
        .column(id)
        .column(title)
        .filter(id.is_in(ids.iter().map(String::as_str)));
    if let Some(deleted_at) = deleted_at {
        query = query.filter(deleted_at.is_null());
    }
    if let Some(fallback) = fallback {
        return query.column(fallback).into_tuple().all(db).await;
    }
    let rows: Vec<(String, Option<String>)> = query.into_tuple().all(db).await?;
    Ok(rows
        .into_iter()
        .map(|(id, title)| (id, title, None))
        .collect())
}
