//! Record chats of WeldBooks' records (ADR BOOKS-015; Rust only, edition
//! feature `books-questions`): an invoice, a bill, a bank line, an inbox
//! document, a VAT return and a contact (`parties`).
//!
//! # Who may read the chat
//!
//! Access follows the record (ADR CHAT-006). The type's read permission opens
//! the type (`invoices:read`, `bills:read`, `banking:read`; a document and a
//! contact are read with `invoices:read`, a VAT return with `reports:read`,
//! the permission its routes check), and the record's legal entity must be one
//! the member sees (ADR SEC-015: owners see all, a listed member sees the
//! entity, anyone else sees it unless it is restricted), by
//! [`weldsuite_legal_entities::weldbooks_entity_scope`], the rule the search
//! uses too. The check is the same for one record and for a batch, so lists
//! and single checks cannot drift. A document without an entity belongs to the
//! default entity. A contact belongs to the workspace, not to an entity: the
//! permission is the whole rule.
//!
//! # Default followers
//!
//! The record's creator (where the record has one: invoices, bills and
//! documents; a contact's owner and account manager), and up to
//! [`MAX_MANAGERS`] members who manage the books in the record's entity:
//! active members who hold `journal:create` and see the entity. A contact has
//! no entity, so no managers. Followers get the chat's notifications, so the
//! group is kept small; whoever posts or is asked follows too (the questions
//! API adds the members a question is asked to), and a follower who may not
//! open the record is dropped (`default_followers_who_may_open`).

use std::collections::{HashMap, HashSet};

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::Value;
use weldsuite_db::{PgPool, orm};
use weldsuite_legal_entities::weldbooks_entity_scope;
use weldsuite_schema::tenant::{
    bank_transactions, bills, documents, invoices, parties, vat_returns, workspace_members,
};

use crate::access::Can;
use crate::entity::{Provider, ResolvedEntity};

/// Most managers added as followers of a new chat.
pub const MAX_MANAGERS: usize = 5;
/// Most members looked at when finding managers.
const MEMBERS_SCANNED: u64 = 100;
/// The permission that makes a member a manager of the books.
const MANAGES_BOOKS: &str = "journal:create";

/// A WeldBooks record behind a chat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BooksRecord {
    /// The record's legal entity (`None` for a contact, and for a document
    /// that has none: the default entity's).
    pub entity_id: Option<String>,
    /// What the chat is named.
    pub title: String,
}

impl Provider {
    /// Whether the type is a WeldBooks record's (the six of BOOKS-015).
    pub fn is_books(self) -> bool {
        matches!(
            self,
            Self::Invoice
                | Self::Bill
                | Self::BankTransaction
                | Self::AccountingDocument
                | Self::VatReturn
                | Self::Party
        )
    }

    /// The object panel's type for the record (`?stack=<type>:<id>`); a
    /// document has no panel and opens in the inbox ([`Provider::books_link`]).
    pub fn panel_type(self) -> Option<&'static str> {
        match self {
            Self::Invoice => Some("invoice"),
            Self::Bill => Some("bill"),
            Self::BankTransaction => Some("bank_transaction"),
            Self::VatReturn => Some("vat_return"),
            Self::Party => Some("weldbooks_contact"),
            _ => None,
        }
    }

    /// The platform URL that opens the record (the object panel's deep link,
    /// `/weldbooks/…?stack=<type>:<id>`; a document opens in the inbox).
    pub fn books_link(self, id: &str) -> Option<String> {
        let list = match self {
            Self::Invoice => "invoices",
            Self::Bill => "bills",
            Self::BankTransaction => "banking/transactions",
            Self::VatReturn => "vat",
            Self::Party => "contacts",
            Self::AccountingDocument => return Some(format!("/weldbooks/documents?document={id}")),
            _ => return None,
        };
        Some(format!(
            "/weldbooks/{list}?stack={}:{id}",
            self.panel_type()?
        ))
    }
}

fn text(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

fn first(values: impl IntoIterator<Item = Option<String>>, fallback: &str) -> String {
    values
        .into_iter()
        .find_map(text)
        .unwrap_or_else(|| fallback.to_owned())
}

/// A chat name that fits a sidebar row.
fn short(name: String) -> String {
    const MAX: usize = 80;
    if name.chars().count() <= MAX {
        return name;
    }
    let cut: String = name.chars().take(MAX - 1).collect();
    format!("{cut}…")
}

/// The vendor and invoice number a document's OCR read, when it did.
fn ocr_title(ocr: Option<&Value>) -> Option<String> {
    let vendor = ocr?.get("vendor")?.get("name")?.as_str()?.trim();
    (!vendor.is_empty()).then(|| vendor.to_owned())
}

/// The record a provider's chat is about: its legal entity, name and creator.
struct Found {
    record: BooksRecord,
    created_by: Vec<Option<String>>,
}

#[allow(clippy::too_many_lines, reason = "one arm per record type")]
async fn find(kind: Provider, db: &PgPool, id: &str) -> Result<Option<Found>, DbErr> {
    let orm = orm(db);
    let found = match kind {
        Provider::Invoice => invoices::Entity::find()
            .select_only()
            .columns([
                invoices::Column::EntityId,
                invoices::Column::InvoiceNumber,
                invoices::Column::ContactName,
                invoices::Column::CreatedBy,
            ])
            .filter(invoices::Column::Id.eq(id))
            .filter(invoices::Column::DeletedAt.is_null())
            .into_tuple::<(String, Option<String>, Option<String>, Option<String>)>()
            .one(&orm)
            .await?
            .map(|(entity, number, contact, by)| Found {
                record: BooksRecord {
                    entity_id: Some(entity),
                    title: first([number, contact], "Invoice"),
                },
                created_by: vec![by],
            }),
        Provider::Bill => bills::Entity::find()
            .select_only()
            .columns([
                bills::Column::EntityId,
                bills::Column::BillNumber,
                bills::Column::ContactName,
                bills::Column::CreatedBy,
            ])
            .filter(bills::Column::Id.eq(id))
            .filter(bills::Column::DeletedAt.is_null())
            .into_tuple::<(String, Option<String>, Option<String>, Option<String>)>()
            .one(&orm)
            .await?
            .map(|(entity, number, contact, by)| Found {
                record: BooksRecord {
                    entity_id: Some(entity),
                    title: first([number, contact], "Bill"),
                },
                created_by: vec![by],
            }),
        Provider::BankTransaction => bank_transactions::Entity::find()
            .select_only()
            .columns([
                bank_transactions::Column::EntityId,
                bank_transactions::Column::CounterpartyName,
                bank_transactions::Column::MerchantName,
                bank_transactions::Column::Description,
            ])
            .filter(bank_transactions::Column::Id.eq(id))
            .filter(bank_transactions::Column::DeletedAt.is_null())
            .into_tuple::<(String, Option<String>, Option<String>, Option<String>)>()
            .one(&orm)
            .await?
            .map(|(entity, counterparty, merchant, description)| Found {
                record: BooksRecord {
                    entity_id: Some(entity),
                    title: short(first([counterparty, merchant, description], "Bank line")),
                },
                created_by: Vec::new(),
            }),
        Provider::AccountingDocument => documents::Entity::find()
            .select_only()
            .columns([
                documents::Column::EntityId,
                documents::Column::FileName,
                documents::Column::CreatedBy,
            ])
            .column(documents::Column::OcrResult)
            .filter(documents::Column::Id.eq(id))
            .filter(documents::Column::DeletedAt.is_null())
            .into_tuple::<(Option<String>, String, Option<String>, Option<Value>)>()
            .one(&orm)
            .await?
            .map(|(entity, file, by, ocr)| Found {
                record: BooksRecord {
                    entity_id: entity,
                    title: short(first([ocr_title(ocr.as_ref()), Some(file)], "Document")),
                },
                created_by: vec![by],
            }),
        Provider::VatReturn => vat_returns::Entity::find()
            .select_only()
            .columns([
                vat_returns::Column::EntityId,
                vat_returns::Column::PeriodLabel,
            ])
            .filter(vat_returns::Column::Id.eq(id))
            .filter(vat_returns::Column::DeletedAt.is_null())
            .into_tuple::<(String, Option<String>)>()
            .one(&orm)
            .await?
            .map(|(entity, label)| Found {
                record: BooksRecord {
                    entity_id: Some(entity),
                    title: first([label], "VAT return"),
                },
                created_by: Vec::new(),
            }),
        Provider::Party => parties::Entity::find()
            .select_only()
            .columns([
                parties::Column::DisplayName,
                parties::Column::OwnerId,
                parties::Column::AccountManagerId,
            ])
            .filter(parties::Column::Id.eq(id))
            .filter(parties::Column::DeletedAt.is_null())
            .into_tuple::<(Option<String>, Option<String>, Option<String>)>()
            .one(&orm)
            .await?
            .map(|(name, owner, manager)| Found {
                record: BooksRecord {
                    entity_id: None,
                    title: first([name], "Contact"),
                },
                created_by: vec![owner, manager],
            }),
        _ => None,
    };
    Ok(found)
}

/// The legal entity and name of each live record among `ids`, by id.
///
/// # Errors
///
/// The database's.
pub async fn records(
    kind: Provider,
    db: &PgPool,
    ids: &[String],
) -> Result<HashMap<String, BooksRecord>, DbErr> {
    let mut out = HashMap::new();
    for id in ids {
        if let Some(found) = find(kind, db, id).await? {
            out.insert(id.clone(), found.record);
        }
    }
    Ok(out)
}

/// Members who manage the books in `entity_id`: active, hold `journal:create`
/// and see the entity. At most [`MAX_MANAGERS`], oldest member first.
async fn managers(db: &PgPool, entity_id: &str) -> Result<Vec<String>, DbErr> {
    let members: Vec<String> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::UserId)
        .filter(workspace_members::Column::Status.eq("ACTIVE"))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .order_by_asc(workspace_members::Column::CreatedAt)
        .order_by_asc(workspace_members::Column::Id)
        .limit(MEMBERS_SCANNED)
        .into_tuple()
        .all(&orm(db))
        .await?;
    let mut managers = Vec::new();
    for user_id in members {
        if managers.len() >= MAX_MANAGERS {
            break;
        }
        let can = Can::user(db, &user_id);
        if !can.can(MANAGES_BOOKS).await? {
            continue;
        }
        let Some(resolved) = can.resolved().await? else {
            continue;
        };
        if weldbooks_entity_scope(db, &user_id, resolved)
            .await?
            .matches(Some(entity_id))
        {
            managers.push(user_id);
        }
    }
    Ok(managers)
}

/// `resolve(ctx)`: the chat's name and first followers, or `None` when the
/// record is missing or deleted.
///
/// # Errors
///
/// The database's.
pub async fn resolve(
    kind: Provider,
    db: &PgPool,
    id: &str,
) -> Result<Option<ResolvedEntity>, DbErr> {
    let Some(found) = find(kind, db, id).await? else {
        return Ok(None);
    };
    let mut followers: Vec<String> = Vec::new();
    let mut add = |user: &str| {
        if !user.is_empty() && !followers.iter().any(|f| f == user) {
            followers.push(user.to_owned());
        }
    };
    for creator in found.created_by.iter().flatten() {
        add(creator);
    }
    if let Some(entity) = found.record.entity_id.as_deref() {
        for manager in managers(db, entity).await? {
            add(&manager);
        }
    } else if kind == Provider::AccountingDocument {
        // A document with no entity is the default entity's: its managers.
        if let Some(default) = weldsuite_legal_entities::default_entity_id_for(
            db,
            Some(weldsuite_legal_entities::LegalEntityApp::Weldbooks),
        )
        .await?
        {
            for manager in managers(db, &default).await? {
                add(&manager);
            }
        }
    }
    Ok(Some(ResolvedEntity {
        display_name: found.record.title,
        default_member_ids: followers,
    }))
}

/// `filterVisible(ctx, ids)`: the live records among `ids` the member may see
/// (the type's permission is checked by the caller, as for every provider).
///
/// # Errors
///
/// The database's.
pub async fn visible(
    kind: Provider,
    db: &PgPool,
    user_id: &str,
    can: &Can<'_>,
    ids: &[String],
) -> Result<HashSet<String>, DbErr> {
    let orm = orm(db);
    if kind == Provider::Party {
        let live: Vec<String> = parties::Entity::find()
            .select_only()
            .column(parties::Column::Id)
            .filter(parties::Column::Id.is_in(ids.iter().map(String::as_str)))
            .filter(parties::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&orm)
            .await?;
        return Ok(live.into_iter().collect());
    }
    let Some(resolved) = can.resolved().await? else {
        return Ok(HashSet::new());
    };
    let scope = weldbooks_entity_scope(db, user_id, resolved).await?;
    let ids = ids.iter().map(String::as_str);
    let found: Vec<String> = match kind {
        Provider::Invoice => {
            invoices::Entity::find()
                .select_only()
                .column(invoices::Column::Id)
                .filter(invoices::Column::Id.is_in(ids))
                .filter(invoices::Column::DeletedAt.is_null())
                .filter(scope.condition(invoices::Column::EntityId))
                .into_tuple()
                .all(&orm)
                .await?
        }
        Provider::Bill => {
            bills::Entity::find()
                .select_only()
                .column(bills::Column::Id)
                .filter(bills::Column::Id.is_in(ids))
                .filter(bills::Column::DeletedAt.is_null())
                .filter(scope.condition(bills::Column::EntityId))
                .into_tuple()
                .all(&orm)
                .await?
        }
        Provider::BankTransaction => {
            bank_transactions::Entity::find()
                .select_only()
                .column(bank_transactions::Column::Id)
                .filter(bank_transactions::Column::Id.is_in(ids))
                .filter(bank_transactions::Column::DeletedAt.is_null())
                .filter(scope.condition(bank_transactions::Column::EntityId))
                .into_tuple()
                .all(&orm)
                .await?
        }
        Provider::AccountingDocument => {
            // A document with no entity is the default entity's (the scope's
            // `include_unassigned`).
            documents::Entity::find()
                .select_only()
                .column(documents::Column::Id)
                .filter(documents::Column::Id.is_in(ids))
                .filter(documents::Column::DeletedAt.is_null())
                .filter(scope.condition(documents::Column::EntityId))
                .into_tuple()
                .all(&orm)
                .await?
        }
        Provider::VatReturn => {
            vat_returns::Entity::find()
                .select_only()
                .column(vat_returns::Column::Id)
                .filter(vat_returns::Column::Id.is_in(ids))
                .filter(vat_returns::Column::DeletedAt.is_null())
                .filter(scope.condition(vat_returns::Column::EntityId))
                .into_tuple()
                .all(&orm)
                .await?
        }
        _ => Vec::new(),
    };
    Ok(found.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_six_types_have_panels_and_links() {
        let links: Vec<(Provider, Option<&str>, Option<String>)> = [
            Provider::Invoice,
            Provider::Bill,
            Provider::BankTransaction,
            Provider::AccountingDocument,
            Provider::VatReturn,
            Provider::Party,
        ]
        .into_iter()
        .map(|p| (p, p.panel_type(), p.books_link("x_1")))
        .collect();
        assert_eq!(
            links
                .iter()
                .map(|(_, panel, link)| (*panel, link.as_deref()))
                .collect::<Vec<_>>(),
            [
                (
                    Some("invoice"),
                    Some("/weldbooks/invoices?stack=invoice:x_1")
                ),
                (Some("bill"), Some("/weldbooks/bills?stack=bill:x_1")),
                (
                    Some("bank_transaction"),
                    Some("/weldbooks/banking/transactions?stack=bank_transaction:x_1")
                ),
                (None, Some("/weldbooks/documents?document=x_1")),
                (
                    Some("vat_return"),
                    Some("/weldbooks/vat?stack=vat_return:x_1")
                ),
                (
                    Some("weldbooks_contact"),
                    Some("/weldbooks/contacts?stack=weldbooks_contact:x_1")
                ),
            ]
        );
        assert!(links.iter().all(|(p, _, _)| p.is_books()));
        assert!(!Provider::Company.is_books());
        assert_eq!(Provider::Company.books_link("c"), None);
    }

    #[test]
    fn a_name_fits_a_row() {
        assert_eq!(short("Acme".to_owned()), "Acme");
        let long = short("x".repeat(200));
        assert_eq!(long.chars().count(), 80);
        assert!(long.ends_with('…'));
        assert_eq!(first([None, Some("  ".to_owned())], "Bill"), "Bill");
        assert_eq!(
            ocr_title(Some(
                &serde_json::json!({ "vendor": { "name": " Paper Co " } })
            )),
            Some("Paper Co".to_owned())
        );
    }
}
