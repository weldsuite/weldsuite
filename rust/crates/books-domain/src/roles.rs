//! Accounting contact-role promotion (`@weldsuite/books-domain/accounting-roles`):
//! a contact's `role` moves forward when it gets its first invoice or bill.
//! Idempotent, so callers invoke it unconditionally after creating one:
//!
//! ```text
//! none     + customer -> customer
//! none     + supplier -> supplier
//! customer + supplier -> both
//! supplier + customer -> both
//! both     + *        -> both (no-op)
//! ```
//!
//! Used by the sales and purchases areas and by connect's ingest.

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_schema::tenant::parties;

/// What a contact is promoted to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromoteTo {
    Customer,
    Supplier,
}

impl PromoteTo {
    fn as_str(self) -> &'static str {
        match self {
            Self::Customer => "customer",
            Self::Supplier => "supplier",
        }
    }
}

/// The role after a promotion, `None` when it doesn't change.
pub fn promoted_role(current: Option<&str>, promote_to: PromoteTo) -> Option<&'static str> {
    let current = current.unwrap_or("none");
    if current == "both" || current == promote_to.as_str() {
        return None;
    }
    Some(if current == "none" {
        promote_to.as_str()
    } else {
        "both"
    })
}

/// `promoteAccountingRole(db, contactId, promoteTo)`: a no-op for an unknown
/// contact or one that already has the role.
pub async fn promote_accounting_role(
    db: &PgPool,
    contact_id: &str,
    promote_to: PromoteTo,
) -> Result<(), DbErr> {
    let db = orm(db);
    let contact: Option<String> = parties::Entity::find()
        .select_only()
        .column(parties::Column::Role)
        .filter(parties::Column::Id.eq(contact_id))
        .into_tuple()
        .one(&db)
        .await?;
    let Some(role) = contact else {
        return Ok(());
    };
    let Some(next) = promoted_role(Some(&role), promote_to) else {
        return Ok(());
    };
    parties::Entity::update_many()
        .col_expr(parties::Column::Role, Expr::value(next))
        .col_expr(parties::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(parties::Column::Id.eq(contact_id))
        .exec(&db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_only_move_forward() {
        assert_eq!(promoted_role(None, PromoteTo::Customer), Some("customer"));
        assert_eq!(
            promoted_role(Some("none"), PromoteTo::Supplier),
            Some("supplier")
        );
        assert_eq!(
            promoted_role(Some("customer"), PromoteTo::Supplier),
            Some("both")
        );
        assert_eq!(
            promoted_role(Some("supplier"), PromoteTo::Customer),
            Some("both")
        );
        assert_eq!(promoted_role(Some("customer"), PromoteTo::Customer), None);
        assert_eq!(promoted_role(Some("both"), PromoteTo::Supplier), None);
    }
}
