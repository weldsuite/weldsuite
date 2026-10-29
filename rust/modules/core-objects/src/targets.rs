//! Built-in entities a custom object may link to, and how their records
//! resolve to a title and a link (`services/custom-object-targets.ts`).
//!
//! An allow-list: each entry names its table and title columns in literal
//! SQL, so a link's `targetEntityKey` (user input) never becomes a table
//! name. Adding a linkable entity is one entry here plus one in
//! `LINKABLE_BUILTIN_ENTITY_TYPES` and the TypeScript registry.

use std::collections::HashMap;

use weldsuite_db::PgPool;

/// One linkable built-in entity type.
pub(crate) struct Target {
    pub(crate) entity_type: &'static str,
    pub(crate) label: &'static str,
    /// Needed to see records of this type: linking reads the target.
    pub(crate) read_permission: &'static str,
    href: &'static str,
    /// `id, title, fallback` of the live rows whose id is in `$1`.
    sql: &'static str,
}

/// In the TypeScript registry's order.
pub(crate) const TARGETS: [Target; 12] = [
    Target {
        entity_type: "company",
        label: "Company",
        read_permission: "companies:read",
        href: "/crm/companies/",
        sql: "select id, name, display_name from companies where id = any($1) and deleted_at is null",
    },
    Target {
        entity_type: "person",
        label: "Person",
        read_permission: "people:read",
        href: "/crm/people/",
        sql: "select id, full_name, display_name from people where id = any($1) and deleted_at is null",
    },
    Target {
        entity_type: "lead",
        label: "Lead",
        read_permission: "leads:read",
        href: "/crm/leads/",
        sql: "select id, full_name, email from crm_leads where id = any($1) and deleted_at is null",
    },
    Target {
        entity_type: "opportunity",
        label: "Deal",
        read_permission: "opportunities:read",
        href: "/crm/opportunities/",
        sql: "select id, name, null::text from crm_opportunities where id = any($1) and deleted_at is null",
    },
    Target {
        entity_type: "quote",
        label: "Quote",
        read_permission: "quotes:read",
        href: "/crm/quotes/",
        sql: "select id, name, quote_number from crm_quotes where id = any($1) and deleted_at is null",
    },
    Target {
        entity_type: "ticket",
        label: "Ticket",
        read_permission: "tickets:read",
        href: "/welddesk/tickets/",
        sql: "select id, subject, null::text from helpdesk_tickets where id = any($1) and deleted_at is null",
    },
    Target {
        entity_type: "conversation",
        label: "Conversation",
        read_permission: "conversations:read",
        href: "/welddesk/inbox/",
        sql: "select id, title, null::text from desk_conversations where id = any($1)",
    },
    Target {
        entity_type: "project",
        label: "Project",
        read_permission: "projects:read",
        href: "/weldflow/projects/",
        sql: "select id, name, null::text from projects where id = any($1) and deleted_at is null",
    },
    Target {
        entity_type: "task",
        label: "Task",
        read_permission: "tasks:read",
        href: "/weldflow/task/",
        sql: "select id, title, null::text from tasks where id = any($1) and deleted_at is null",
    },
    Target {
        entity_type: "product",
        label: "Product",
        read_permission: "products:read",
        href: "/commerce/products/",
        sql: "select id, name, null::text from products where id = any($1) and deleted_at is null",
    },
    Target {
        entity_type: "order",
        label: "Order",
        read_permission: "orders:read",
        href: "/commerce/orders/",
        sql: "select id, order_number, null::text from orders where id = any($1) and deleted_at is null",
    },
    Target {
        entity_type: "invoice",
        label: "Invoice",
        read_permission: "invoices:read",
        href: "/weldbooks/invoices/",
        sql: "select id, invoice_number, null::text from invoices where id = any($1) and deleted_at is null",
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
) -> Result<HashMap<String, Resolved>, sqlx::Error> {
    let mut out = HashMap::new();
    let Some(target) = builtin(entity_type) else {
        return Ok(out);
    };
    if ids.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(String, Option<String>, Option<String>)> =
        sqlx::query_as(target.sql).bind(ids).fetch_all(db).await?;
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
