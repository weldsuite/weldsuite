//! The Odoo syncs' writes into the WeldStash tables, linked to Odoo through `integration_entity_mappings` (`odoo_warehouse`,
//! `odoo_product`, `odoo_product_template`, `odoo_supplier`,
//! `odoo_supplierinfo`, `odoo_purchase_order`). A record whose mapping
//! carries the same checksum is skipped, as the generic ingest does.

use std::collections::{BTreeMap, HashMap, HashSet};

use sea_orm::sea_query::{Alias, Asterisk, Expr, Func, OnConflict, Order, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, JoinType, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_events::{EntityEvent, EventContext, EventSource, EventType};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    integration_entity_mappings as mappings, product_suppliers, product_variants, products,
    purchase_order_items, purchase_orders, stash_sales_history, suppliers, warehouses,
};

use super::mappers::{
    PoLineValues, ProductValues, SupplierInfoValues, SupplierValues, WarehouseValues,
    supplierinfo_rank,
};
use super::sync::Ctx;
use crate::js::now_iso;

pub(crate) const WAREHOUSE: &str = "odoo_warehouse";
pub(crate) const PRODUCT: &str = "odoo_product";
pub(crate) const TEMPLATE: &str = "odoo_product_template";
pub(crate) const SUPPLIER: &str = "odoo_supplier";
pub(crate) const SUPPLIER_INFO: &str = "odoo_supplierinfo";
pub(crate) const PURCHASE_ORDER: &str = "odoo_purchase_order";

/// What happened to one record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Action {
    Created,
    Updated,
    Skipped,
    Deleted,
}

/// A record's `integration_entity_mappings` row.
#[derive(Debug, Clone)]
pub(crate) struct Mapping {
    pub(crate) internal_type: String,
    pub(crate) internal_id: String,
    pub(crate) checksum: Option<String>,
}

pub(crate) async fn find_mapping(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
    external_id: i64,
) -> Result<Option<Mapping>, DbErr> {
    let row: Option<(String, String, Option<String>)> = mappings::Entity::find()
        .select_only()
        .columns([
            mappings::Column::InternalEntityType,
            mappings::Column::InternalEntityId,
            mappings::Column::SyncChecksum,
        ])
        .filter(mappings::Column::ConnectionId.eq(connection_id))
        .filter(mappings::Column::ExternalEntityType.eq(external_type))
        .filter(mappings::Column::ExternalEntityId.eq(external_id.to_string()))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.map(|(internal_type, internal_id, checksum)| Mapping {
        internal_type,
        internal_id,
        checksum,
    }))
}

/// Inserts or repoints a mapping.
pub(crate) async fn save_mapping(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
    external_id: i64,
    internal_type: &str,
    internal_id: &str,
    checksum: Option<&str>,
) -> Result<(), DbErr> {
    let now = utc_now();
    mappings::Entity::insert(mappings::ActiveModel {
        id: Set(generate_id("iem")),
        connection_id: Set(connection_id.to_owned()),
        external_entity_type: Set(external_type.to_owned()),
        external_entity_id: Set(external_id.to_string()),
        internal_entity_type: Set(internal_type.to_owned()),
        internal_entity_id: Set(internal_id.to_owned()),
        last_synced_at: Set(Some(now)),
        sync_checksum: Set(checksum.map(str::to_owned)),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::columns([
            mappings::Column::ConnectionId,
            mappings::Column::ExternalEntityType,
            mappings::Column::ExternalEntityId,
        ])
        .update_columns([
            mappings::Column::InternalEntityType,
            mappings::Column::InternalEntityId,
            mappings::Column::SyncChecksum,
            mappings::Column::LastSyncedAt,
        ])
        // `updated_at = excluded.last_synced_at`.
        .value(mappings::Column::UpdatedAt, Expr::value(now))
        .to_owned(),
    )
    .exec_without_returning(&orm(db))
    .await
    .map(|_| ())
}

async fn delete_mapping(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
    external_id: i64,
) -> Result<(), DbErr> {
    mappings::Entity::delete_many()
        .filter(mappings::Column::ConnectionId.eq(connection_id))
        .filter(mappings::Column::ExternalEntityType.eq(external_type))
        .filter(mappings::Column::ExternalEntityId.eq(external_id.to_string()))
        .exec(&orm(db))
        .await
        .map(|_| ())
}

/// Every mapping of one external type: Odoo id → (internal type, id).
pub(crate) async fn mappings_of(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
) -> Result<HashMap<i64, (String, String)>, DbErr> {
    let rows: Vec<(String, String, String)> = mappings::Entity::find()
        .select_only()
        .columns([
            mappings::Column::ExternalEntityId,
            mappings::Column::InternalEntityType,
            mappings::Column::InternalEntityId,
        ])
        .filter(mappings::Column::ConnectionId.eq(connection_id))
        .filter(mappings::Column::ExternalEntityType.eq(external_type))
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(external, kind, internal)| {
            external
                .parse::<i64>()
                .ok()
                .map(|id| (id, (kind, internal)))
        })
        .collect())
}

/// An Odoo product's WeldStash item: (product id, variant id).
pub(crate) type Item = (String, Option<String>);

/// Every `odoo_product` mapping as the item it names (a variant mapping
/// resolved to its product; one whose variant is gone is left out).
pub(crate) async fn product_items(
    db: &PgPool,
    connection_id: &str,
) -> Result<HashMap<i64, Item>, DbErr> {
    let rows: Vec<(String, String, String, Option<String>)> = mappings::Entity::find()
        .select_only()
        .columns([
            mappings::Column::ExternalEntityId,
            mappings::Column::InternalEntityType,
            mappings::Column::InternalEntityId,
        ])
        .column(product_variants::Column::ProductId)
        .join(
            JoinType::LeftJoin,
            mappings::Entity::belongs_to(product_variants::Entity)
                .from(mappings::Column::InternalEntityId)
                .to(product_variants::Column::Id)
                .into(),
        )
        .filter(mappings::Column::ConnectionId.eq(connection_id))
        .filter(mappings::Column::ExternalEntityType.eq(PRODUCT))
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(external, kind, internal, parent)| {
            let item = if kind == "product_variant" {
                (parent?, Some(internal))
            } else {
                (internal, None)
            };
            external.parse::<i64>().ok().map(|id| (id, item))
        })
        .collect())
}

/// `publishEntityEvent` for a synced row, `{ id }` as the generic ingest
/// sends it; an action the catalog lacks is skipped with a warning.
pub(crate) async fn publish(ctx: &Ctx<'_>, entity_type: &str, action: Action, entity_id: &str) {
    let action = match action {
        Action::Created => "created",
        Action::Updated => "updated",
        Action::Deleted => "deleted",
        Action::Skipped => return,
    };
    let event = match EventType::catalog(entity_type, action) {
        Ok(event) => event,
        Err(error) => {
            tracing::warn!(%error, "[connectors/odoo] event not in the catalog");
            return;
        }
    };
    let context = EventContext::new(ctx.workspace_id, ctx.owner_id, EventSource::System);
    ctx.events
        .publish_and_wait(
            &context,
            EntityEvent::new(event, entity_id, json!({ "id": entity_id })),
        )
        .await;
}

fn created_by(ctx: &Ctx<'_>) -> Option<String> {
    Some(ctx.owner_id.to_owned()).filter(|o| !o.is_empty())
}

/// `$n::numeric` of a JavaScript number: Postgres converts it, as it did.
fn numeric(value: Option<f64>) -> Expr {
    sea_orm::ExprTrait::cast_as(Expr::val(value), "numeric")
}

/// `$n::timestamp` of Odoo's datetime text: Postgres reads it, as it did.
fn timestamp(text: Option<&str>) -> Expr {
    sea_orm::ExprTrait::cast_as(Expr::val(text), "timestamp")
}

/// `coalesce(column, '{}'::jsonb) || patch`.
fn merged(column: Expr, patch: Value) -> Expr {
    sea_orm::sea_query::extension::postgres::PgExpr::concat(
        Expr::from(Func::coalesce([column, Expr::val(json!({}))])),
        Expr::val(patch),
    )
}

/// `not exists (select 1 from integration_entity_mappings m where
/// m.connection_id = $c and m.external_entity_type = $t [and
/// m.internal_entity_type = $k] and m.internal_entity_id = x.id)`, as `x.id
/// not in (this)`: a mapped id is never null.
fn mapped_ids(
    connection_id: &str,
    external_type: &str,
    internal_type: Option<&str>,
) -> sea_orm::sea_query::SelectStatement {
    let mut select = Query::select();
    select
        .column(mappings::Column::InternalEntityId)
        .from(mappings::Entity)
        .and_where(mappings::Column::ConnectionId.eq(connection_id))
        .and_where(mappings::Column::ExternalEntityType.eq(external_type));
    if let Some(kind) = internal_type {
        select.and_where(mappings::Column::InternalEntityType.eq(kind));
    }
    select
}

/// An insert the entity's `ActiveModel` can't express (values Postgres
/// converts), run as built.
async fn run_insert<C: ConnectionTrait>(
    db: &C,
    insert: &sea_orm::sea_query::InsertStatement,
) -> Result<u64, DbErr> {
    Ok(db.execute(insert).await?.rows_affected())
}

/// The columns and values of an insert, in step.
fn insert_into<T: sea_orm::sea_query::IntoIden>(
    table: T,
    values: Vec<(impl sea_orm::sea_query::IntoIden, Expr)>,
) -> Result<sea_orm::sea_query::InsertStatement, DbErr> {
    let (columns, exprs): (Vec<_>, Vec<_>) = values.into_iter().unzip();
    let mut insert = Query::insert();
    insert
        .into_table(table)
        .columns(columns)
        .values(exprs)
        .map_err(|error| DbErr::Custom(error.to_string()))?;
    Ok(insert)
}

// ── warehouses ───────────────────────────────────────────────────────────────

/// A synced warehouse: managed by the connection (its stock is Odoo's).
/// An unmapped Odoo warehouse always gets a new WeldStash warehouse, never an
/// existing one with the same code: the stock sync owns a managed
/// warehouse's buckets and zeroes what Odoo does not report.
pub(crate) async fn upsert_warehouse(
    ctx: &Ctx<'_>,
    values: &WarehouseValues,
    checksum: &str,
) -> Result<(Action, String), DbErr> {
    let now = utc_now();
    if let Some(mapping) =
        find_mapping(ctx.db, ctx.connection_id, WAREHOUSE, values.odoo_id).await?
    {
        if mapping.checksum.as_deref() == Some(checksum) {
            return Ok((Action::Skipped, mapping.internal_id));
        }
        let updated = warehouses::Entity::update_many()
            .col_expr(warehouses::Column::Name, Expr::value(values.name.as_str()))
            .col_expr(warehouses::Column::Code, Expr::value(values.code.clone()))
            .col_expr(warehouses::Column::IsActive, Expr::value(values.active))
            .col_expr(
                warehouses::Column::ManagedByConnectionId,
                Expr::value(ctx.connection_id),
            )
            .col_expr(
                warehouses::Column::Metadata,
                merged(
                    Expr::col(warehouses::Column::Metadata),
                    values.metadata.clone(),
                ),
            )
            .col_expr(warehouses::Column::UpdatedAt, Expr::value(now))
            .filter(warehouses::Column::Id.eq(mapping.internal_id.as_str()))
            .exec(&orm(ctx.db))
            .await?;
        if updated.rows_affected > 0 {
            save_mapping(
                ctx.db,
                ctx.connection_id,
                WAREHOUSE,
                values.odoo_id,
                "warehouse",
                &mapping.internal_id,
                Some(checksum),
            )
            .await?;
            return Ok((Action::Updated, mapping.internal_id));
        }
    }
    let id = generate_id("wh");
    warehouses::Entity::insert(warehouses::ActiveModel {
        id: Set(id.clone()),
        name: Set(values.name.clone()),
        code: Set(values.code.clone()),
        is_active: Set(Some(values.active)),
        is_default: Set(Some(false)),
        managed_by_connection_id: Set(Some(ctx.connection_id.to_owned())),
        metadata: Set(Some(values.metadata.clone())),
        ..Default::default()
    })
    .exec_without_returning(&orm(ctx.db))
    .await?;
    save_mapping(
        ctx.db,
        ctx.connection_id,
        WAREHOUSE,
        values.odoo_id,
        "warehouse",
        &id,
        Some(checksum),
    )
    .await?;
    Ok((Action::Created, id))
}

// ── products ─────────────────────────────────────────────────────────────────

fn product_status(active: bool) -> &'static str {
    if active { "active" } else { "archived" }
}

fn variant_status(active: bool) -> &'static str {
    if active { "active" } else { "inactive" }
}

async fn live_product(db: &PgPool, id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = products::Entity::find()
        .select_only()
        .column(products::Column::Id)
        .filter(products::Column::Id.eq(id))
        .filter(products::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

/// A live product with this SKU that no other Odoo product of the
/// connection is mapped to.
async fn product_by_sku(ctx: &Ctx<'_>, sku: Option<&str>) -> Result<Option<String>, DbErr> {
    let Some(sku) = sku else { return Ok(None) };
    products::Entity::find()
        .select_only()
        .column(products::Column::Id)
        .filter(products::Column::Sku.eq(sku))
        .filter(products::Column::DeletedAt.is_null())
        .filter(products::Column::Id.not_in_subquery(mapped_ids(
            ctx.connection_id,
            PRODUCT,
            Some("product"),
        )))
        .order_by_asc(products::Column::CreatedAt)
        .order_by_asc(products::Column::Id)
        .into_tuple()
        .one(&orm(ctx.db))
        .await
}

/// A live variant with this SKU (under `parent` first) that no other Odoo
/// product is mapped to: (variant id, product id).
async fn variant_by_sku(
    ctx: &Ctx<'_>,
    sku: Option<&str>,
    parent: Option<&str>,
) -> Result<Option<(String, String)>, DbErr> {
    use sea_orm::ExprTrait as _;
    let Some(sku) = sku else { return Ok(None) };
    product_variants::Entity::find()
        .select_only()
        .columns([
            product_variants::Column::Id,
            product_variants::Column::ProductId,
        ])
        .join(
            JoinType::InnerJoin,
            product_variants::Entity::belongs_to(products::Entity)
                .from(product_variants::Column::ProductId)
                .to(products::Column::Id)
                .into(),
        )
        .filter(products::Column::DeletedAt.is_null())
        .filter(product_variants::Column::Sku.eq(sku))
        .filter(product_variants::Column::DeletedAt.is_null())
        .filter(product_variants::Column::Id.not_in_subquery(mapped_ids(
            ctx.connection_id,
            PRODUCT,
            Some("product_variant"),
        )))
        // `order by (v.product_id = $4) desc, v.created_at, v.id`.
        .order_by(
            Expr::col((
                product_variants::Entity,
                product_variants::Column::ProductId,
            ))
            .eq(parent.unwrap_or_default()),
            Order::Desc,
        )
        .order_by_asc(product_variants::Column::CreatedAt)
        .order_by_asc(product_variants::Column::Id)
        .into_tuple()
        .one(&orm(ctx.db))
        .await
}

async fn insert_product(
    ctx: &Ctx<'_>,
    values: &ProductValues,
    sku: Option<&str>,
    has_variants: bool,
) -> Result<String, DbErr> {
    use products::Column;
    let id = generate_id("prod");
    let slug = Some(crate::mappers::slugify(&values.name))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id.clone());
    let insert = insert_into(
        products::Entity,
        vec![
            (Column::Id, Expr::val(id.as_str())),
            (Column::Name, Expr::val(values.name.as_str())),
            (Column::Slug, Expr::val(slug)),
            (Column::Sku, Expr::val(sku)),
            (
                Column::Barcode,
                Expr::val(if has_variants {
                    None
                } else {
                    values.barcode.as_deref()
                }),
            ),
            (
                Column::CostPrice,
                numeric(if has_variants { None } else { values.cost }),
            ),
            // `coalesce($7::numeric, 0)`.
            (
                Column::Price,
                Func::coalesce([numeric(values.price), Expr::val(0)]).into(),
            ),
            (
                Column::Weight,
                numeric(if has_variants { None } else { values.weight }),
            ),
            (Column::Status, Expr::val(product_status(values.active))),
            (Column::TrackInventory, Expr::val(true)),
            (Column::HasVariants, Expr::val(has_variants)),
            (Column::CreatedBy, Expr::val(created_by(ctx))),
        ],
    )?;
    run_insert(&orm(ctx.db), &insert).await?;
    Ok(id)
}

async fn update_single_product(
    ctx: &Ctx<'_>,
    id: &str,
    values: &ProductValues,
) -> Result<(), DbErr> {
    let mut update = products::Entity::update_many()
        .col_expr(products::Column::Name, Expr::value(values.name.as_str()))
        .col_expr(products::Column::Sku, Expr::value(values.sku.clone()))
        .col_expr(
            products::Column::Barcode,
            Expr::value(values.barcode.clone()),
        )
        .col_expr(products::Column::CostPrice, numeric(values.cost))
        .col_expr(
            products::Column::Status,
            Expr::value(product_status(values.active)),
        )
        .col_expr(products::Column::UpdatedAt, Expr::value(utc_now()));
    // `price = coalesce($6::numeric, price)`, `weight` likewise.
    if values.price.is_some() {
        update = update.col_expr(products::Column::Price, numeric(values.price));
    }
    if values.weight.is_some() {
        update = update.col_expr(products::Column::Weight, numeric(values.weight));
    }
    update
        .filter(products::Column::Id.eq(id))
        .exec(&orm(ctx.db))
        .await
        .map(|_| ())
}

async fn upsert_variant(
    ctx: &Ctx<'_>,
    existing: Option<&str>,
    parent: &str,
    values: &ProductValues,
) -> Result<(String, bool), DbErr> {
    use product_variants::Column;
    if let Some(id) = existing {
        let mut update = product_variants::Entity::update_many()
            .col_expr(Column::Name, Expr::value(values.variant_name.as_str()))
            .col_expr(Column::Sku, Expr::value(values.sku.clone()))
            .col_expr(Column::Barcode, Expr::value(values.barcode.clone()))
            .col_expr(Column::CostPrice, numeric(values.cost))
            .col_expr(Column::Status, Expr::value(variant_status(values.active)))
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()));
        // `price = coalesce($6::numeric, price)`, `weight` likewise.
        if values.price.is_some() {
            update = update.col_expr(Column::Price, numeric(values.price));
        }
        if values.weight.is_some() {
            update = update.col_expr(Column::Weight, numeric(values.weight));
        }
        let updated = update
            .filter(Column::Id.eq(id))
            .filter(Column::DeletedAt.is_null())
            .exec(&orm(ctx.db))
            .await?;
        if updated.rows_affected > 0 {
            return Ok((id.to_owned(), false));
        }
    }
    let id = generate_id("pvr");
    let insert = insert_into(
        product_variants::Entity,
        vec![
            (Column::Id, Expr::val(id.as_str())),
            (Column::ProductId, Expr::val(parent)),
            (Column::Name, Expr::val(values.variant_name.as_str())),
            (Column::Sku, Expr::val(values.sku.as_deref())),
            (Column::Barcode, Expr::val(values.barcode.as_deref())),
            (Column::CostPrice, numeric(values.cost)),
            (Column::Price, numeric(values.price)),
            (Column::Weight, numeric(values.weight)),
            (Column::Status, Expr::val(variant_status(values.active))),
            (Column::CreatedBy, Expr::val(created_by(ctx))),
        ],
    )?;
    run_insert(&orm(ctx.db), &insert).await?;
    Ok((id, true))
}

/// A `product.product`: the product itself for a single-variant template
/// (matched by SKU before one is created), or a variant under the
/// template's product. The template is mapped too (`odoo_product_template`),
/// for vendor lines that name only the template. Returns the product the
/// event is about.
///
/// A template that grows a second variant turns its product into the
/// parent: the first variant's mapping moves from the product to a new
/// variant row. Stock and sales already recorded on the product without a
/// variant stay there (an assumption: rare, and the next stock refresh
/// rewrites the buckets).
pub(crate) async fn upsert_product(
    ctx: &Ctx<'_>,
    values: &ProductValues,
    checksum: &str,
) -> Result<(Action, String), DbErr> {
    let mapping = find_mapping(ctx.db, ctx.connection_id, PRODUCT, values.odoo_id).await?;
    if let Some(m) = &mapping
        && m.checksum.as_deref() == Some(checksum)
    {
        return Ok((Action::Skipped, m.internal_id.clone()));
    }
    if !values.multi {
        if let Some(m) = &mapping
            && m.internal_type == "product_variant"
        {
            // The template went back to one variant: keep updating the
            // variant row it already is.
            let parent: Option<String> = product_variants::Entity::find()
                .select_only()
                .column(product_variants::Column::ProductId)
                .filter(product_variants::Column::Id.eq(m.internal_id.as_str()))
                .into_tuple()
                .one(&orm(ctx.db))
                .await?;
            if let Some(parent) = parent {
                upsert_variant(ctx, Some(&m.internal_id), &parent, values).await?;
                save_mapping(
                    ctx.db,
                    ctx.connection_id,
                    PRODUCT,
                    values.odoo_id,
                    "product_variant",
                    &m.internal_id,
                    Some(checksum),
                )
                .await?;
                return Ok((Action::Updated, parent));
            }
        }
        let mapped = match &mapping {
            Some(m)
                if m.internal_type == "product" && live_product(ctx.db, &m.internal_id).await? =>
            {
                Some(m.internal_id.clone())
            }
            _ => None,
        };
        let existing = match mapped {
            Some(id) => Some(id),
            None => product_by_sku(ctx, values.sku.as_deref()).await?,
        };
        let (id, action) = match existing {
            Some(id) => {
                update_single_product(ctx, &id, values).await?;
                (id, Action::Updated)
            }
            None => (
                insert_product(ctx, values, values.sku.as_deref(), false).await?,
                Action::Created,
            ),
        };
        save_mapping(
            ctx.db,
            ctx.connection_id,
            PRODUCT,
            values.odoo_id,
            "product",
            &id,
            Some(checksum),
        )
        .await?;
        if let Some(template) = values.template_id {
            save_mapping(
                ctx.db,
                ctx.connection_id,
                TEMPLATE,
                template,
                "product",
                &id,
                None,
            )
            .await?;
        }
        return Ok((action, id));
    }

    // A variant: find (or make) the template's product.
    let mut parent: Option<String> = None;
    if let Some(template) = values.template_id
        && let Some(m) = find_mapping(ctx.db, ctx.connection_id, TEMPLATE, template).await?
        && live_product(ctx.db, &m.internal_id).await?
    {
        parent = Some(m.internal_id);
    }
    let mut variant_id: Option<String> = None;
    let mut promoted_from_product = false;
    match &mapping {
        Some(m) if m.internal_type == "product_variant" => variant_id = Some(m.internal_id.clone()),
        Some(m) if m.internal_type == "product" && live_product(ctx.db, &m.internal_id).await? => {
            if parent.is_none() {
                parent = Some(m.internal_id.clone());
            }
            promoted_from_product = true;
        }
        _ => {}
    }
    if variant_id.is_none()
        && let Some((variant, product)) =
            variant_by_sku(ctx, values.sku.as_deref(), parent.as_deref()).await?
    {
        variant_id = Some(variant);
        if parent.is_none() {
            parent = Some(product);
        }
    }
    let (parent, parent_created) = match parent {
        Some(id) => (id, false),
        None => (insert_product(ctx, values, None, true).await?, true),
    };
    if promoted_from_product {
        // The product was this variant alone: its own SKU and barcode move
        // to the variant.
        products::Entity::update_many()
            .col_expr(products::Column::Sku, Expr::value(Option::<String>::None))
            .col_expr(
                products::Column::Barcode,
                Expr::value(Option::<String>::None),
            )
            .filter(products::Column::Id.eq(parent.as_str()))
            .exec(&orm(ctx.db))
            .await?;
    }
    let (variant, _) = upsert_variant(ctx, variant_id.as_deref(), &parent, values).await?;
    save_mapping(
        ctx.db,
        ctx.connection_id,
        PRODUCT,
        values.odoo_id,
        "product_variant",
        &variant,
        Some(checksum),
    )
    .await?;
    if let Some(template) = values.template_id {
        save_mapping(
            ctx.db,
            ctx.connection_id,
            TEMPLATE,
            template,
            "product",
            &parent,
            None,
        )
        .await?;
    }
    // `variant_count = (select count(*) from product_variants v where
    // v.product_id = p.id and v.deleted_at is null)`, `p.id` being the parent.
    let variant_count = Query::select()
        .expr(Func::count(Expr::col(Asterisk)))
        .from(product_variants::Entity)
        .and_where(product_variants::Column::ProductId.eq(parent.as_str()))
        .and_where(product_variants::Column::DeletedAt.is_null())
        .to_owned();
    let mut update = products::Entity::update_many()
        .col_expr(products::Column::Name, Expr::value(values.name.as_str()))
        .col_expr(products::Column::HasVariants, Expr::value(true))
        .col_expr(products::Column::VariantCount, Expr::from(variant_count))
        .col_expr(products::Column::UpdatedAt, Expr::value(utc_now()));
    // `status = case when $3 then 'active' else p.status end`.
    if values.active {
        update = update.col_expr(products::Column::Status, Expr::value("active"));
    }
    update
        .filter(products::Column::Id.eq(parent.as_str()))
        .exec(&orm(ctx.db))
        .await?;
    Ok((
        if parent_created {
            Action::Created
        } else {
            Action::Updated
        },
        parent,
    ))
}

// ── suppliers ────────────────────────────────────────────────────────────────

/// A vendor: its mapped supplier, else one with the same code (Odoo's
/// `ref`) or, without a code, the same name, that no other Odoo vendor is
/// mapped to; else a new supplier.
pub(crate) async fn upsert_supplier(
    ctx: &Ctx<'_>,
    values: &SupplierValues,
    checksum: &str,
) -> Result<(Action, String), DbErr> {
    use sea_orm::ExprTrait as _;
    use suppliers::Column;
    let mapping = find_mapping(ctx.db, ctx.connection_id, SUPPLIER, values.odoo_id).await?;
    if let Some(m) = &mapping
        && m.checksum.as_deref() == Some(checksum)
    {
        return Ok((Action::Skipped, m.internal_id.clone()));
    }
    let db = &orm(ctx.db);
    let mapped: Option<String> = match &mapping {
        Some(m) => {
            suppliers::Entity::find()
                .select_only()
                .column(Column::Id)
                .filter(Column::Id.eq(m.internal_id.as_str()))
                .filter(Column::DeletedAt.is_null())
                .into_tuple()
                .one(db)
                .await?
        }
        None => None,
    };
    let existing = match mapped {
        Some(id) => Some(id),
        None => {
            // `case when $1::text is not null then s.code = $1 else
            // lower(s.name) = lower($2) end`.
            let same = match &values.code {
                Some(code) => Column::Code.eq(code.as_str()),
                None => Expr::expr(Func::lower(Expr::col((suppliers::Entity, Column::Name))))
                    .eq(Func::lower(Expr::val(values.name.as_str()))),
            };
            suppliers::Entity::find()
                .select_only()
                .column(Column::Id)
                .filter(Column::DeletedAt.is_null())
                .filter(same)
                .filter(Column::Id.not_in_subquery(mapped_ids(ctx.connection_id, SUPPLIER, None)))
                .order_by_asc(Column::CreatedAt)
                .order_by_asc(Column::Id)
                .into_tuple()
                .one(db)
                .await?
        }
    };
    let status = if values.active { "active" } else { "inactive" };
    let (id, action) = if let Some(id) = existing {
        let mut update = suppliers::Entity::update_many()
            .col_expr(Column::Name, Expr::value(values.name.as_str()))
            .col_expr(Column::Email, Expr::value(values.email.clone()))
            .col_expr(Column::Phone, Expr::value(values.phone.clone()))
            .col_expr(Column::Website, Expr::value(values.website.clone()))
            .col_expr(
                Column::AddressLine1,
                Expr::value(values.address_line_1.clone()),
            )
            .col_expr(
                Column::AddressLine2,
                Expr::value(values.address_line_2.clone()),
            )
            .col_expr(Column::City, Expr::value(values.city.clone()))
            .col_expr(Column::State, Expr::value(values.state.clone()))
            .col_expr(Column::PostalCode, Expr::value(values.postal_code.clone()))
            .col_expr(Column::Country, Expr::value(values.country.clone()))
            .col_expr(Column::TaxId, Expr::value(values.tax_id.clone()))
            .col_expr(Column::IsActive, Expr::value(values.active))
            .col_expr(Column::Status, Expr::value(status))
            .col_expr(
                Column::Metadata,
                merged(Expr::col(Column::Metadata), values.metadata.clone()),
            )
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()));
        // `code = coalesce($3, code)`, `payment_terms` and `currency` likewise.
        if let Some(code) = &values.code {
            update = update.col_expr(Column::Code, Expr::value(code.as_str()));
        }
        if let Some(terms) = &values.payment_terms {
            update = update.col_expr(Column::PaymentTerms, Expr::value(terms.as_str()));
        }
        if let Some(currency) = &values.currency {
            update = update.col_expr(Column::Currency, Expr::value(currency.as_str()));
        }
        update.filter(Column::Id.eq(id.as_str())).exec(db).await?;
        (id, Action::Updated)
    } else {
        let id = generate_id("sup");
        suppliers::Entity::insert(suppliers::ActiveModel {
            id: Set(id.clone()),
            name: Set(values.name.clone()),
            code: Set(values.code.clone()),
            email: Set(values.email.clone()),
            phone: Set(values.phone.clone()),
            website: Set(values.website.clone()),
            address_line_1: Set(values.address_line_1.clone()),
            address_line_2: Set(values.address_line_2.clone()),
            city: Set(values.city.clone()),
            state: Set(values.state.clone()),
            postal_code: Set(values.postal_code.clone()),
            country: Set(values.country.clone()),
            tax_id: Set(values.tax_id.clone()),
            payment_terms: Set(values.payment_terms.clone()),
            // `coalesce($15, 'USD')`.
            currency: Set(Some(
                values.currency.clone().unwrap_or_else(|| "USD".to_owned()),
            )),
            is_active: Set(Some(values.active)),
            status: Set(Some(status.to_owned())),
            metadata: Set(Some(values.metadata.clone())),
            ..Default::default()
        })
        .exec_without_returning(db)
        .await?;
        (id, Action::Created)
    };
    save_mapping(
        ctx.db,
        ctx.connection_id,
        SUPPLIER,
        values.odoo_id,
        "supplier",
        &id,
        Some(checksum),
    )
    .await?;
    Ok((action, id))
}

// ── product suppliers ────────────────────────────────────────────────────────

/// A vendor line resolved to WeldStash terms.
pub(crate) struct ProductSupplierInput<'a> {
    pub(crate) info: &'a SupplierInfoValues,
    pub(crate) product_id: &'a str,
    pub(crate) variant_id: Option<&'a str>,
    pub(crate) supplier_id: &'a str,
    /// Per product unit.
    pub(crate) unit_cost: Option<f64>,
    /// In product units, at least 1.
    pub(crate) min_order_qty: Option<i64>,
}

async fn live_product_supplier(db: &PgPool, id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = product_suppliers::Entity::find()
        .select_only()
        .column(product_suppliers::Column::Id)
        .filter(product_suppliers::Column::Id.eq(id))
        .filter(product_suppliers::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

/// `metadata->'odoo'`.
fn odoo_meta() -> Expr {
    sea_orm::sea_query::extension::postgres::PgExpr::get_json_field(
        Expr::col((
            product_suppliers::Entity,
            product_suppliers::Column::Metadata,
        )),
        "odoo",
    )
}

/// Soft-deletes the row `id` while the vendor line `odoo_id` owns it
/// (`metadata->'odoo'->>'id'`): whether it did.
async fn release_owned_row(db: &PgPool, id: &str, odoo_id: i64) -> Result<bool, DbErr> {
    use sea_orm::ExprTrait as _;
    let now = utc_now();
    let released = product_suppliers::Entity::update_many()
        .col_expr(product_suppliers::Column::DeletedAt, Expr::value(now))
        .col_expr(product_suppliers::Column::UpdatedAt, Expr::value(now))
        .filter(product_suppliers::Column::Id.eq(id))
        .filter(product_suppliers::Column::DeletedAt.is_null())
        .filter(
            sea_orm::sea_query::extension::postgres::PgExpr::cast_json_field(odoo_meta(), "id")
                .eq(odoo_id.to_string()),
        )
        .exec(&orm(db))
        .await?;
    Ok(released.rows_affected > 0)
}

/// `coalesce(variant_id, '') = coalesce($v, '')`.
fn same_variant(variant_id: Option<&str>) -> Expr {
    use sea_orm::ExprTrait as _;
    Expr::from(Func::coalesce([
        Expr::col((
            product_suppliers::Entity,
            product_suppliers::Column::VariantId,
        )),
        Expr::val(""),
    ]))
    .eq(variant_id.unwrap_or_default())
}

fn owner_rank(odoo: &Value) -> Option<(i64, (i64, i64, i64))> {
    let id = odoo.get("id")?.as_i64()?;
    let sequence = odoo.get("sequence").and_then(Value::as_i64).unwrap_or(1);
    let min_qty = odoo.get("minQty").and_then(Value::as_f64).unwrap_or(0.0);
    Some((id, supplierinfo_rank(sequence, min_qty, id)))
}

/// Soft-deletes the row a vendor line owns (its `metadata.odoo.id`), and
/// drops the line's mapping. Another line for the same product and vendor
/// (still mapped to the released row) fills it again on its next change, or
/// a full sync: [`upsert_product_supplier`] skips an unchanged line only
/// while its row is live.
pub(crate) async fn remove_supplierinfo(
    ctx: &Ctx<'_>,
    odoo_id: i64,
) -> Result<Option<String>, DbErr> {
    let Some(mapping) = find_mapping(ctx.db, ctx.connection_id, SUPPLIER_INFO, odoo_id).await?
    else {
        return Ok(None);
    };
    let removed = release_owned_row(ctx.db, &mapping.internal_id, odoo_id)
        .await?
        .then(|| mapping.internal_id.clone());
    delete_mapping(ctx.db, ctx.connection_id, SUPPLIER_INFO, odoo_id).await?;
    Ok(removed)
}

/// A vendor line into `product_suppliers`, which keeps one row per product,
/// variant and supplier: the line Odoo ranks first ([`supplierinfo_rank`])
/// owns the row's terms; the others are only mapped to it. A new row is
/// preferred when the product (or variant) has no preferred supplier yet.
pub(crate) async fn upsert_product_supplier(
    ctx: &Ctx<'_>,
    input: &ProductSupplierInput<'_>,
    checksum: &str,
) -> Result<(Action, String), DbErr> {
    use product_suppliers::Column;
    let info = input.info;
    let mapping = find_mapping(ctx.db, ctx.connection_id, SUPPLIER_INFO, info.odoo_id).await?;
    // Unchanged, unless the row it maps to was released (by the line that
    // owned it, or in WeldStash): then this line fills it again.
    if let Some(m) = &mapping
        && m.checksum.as_deref() == Some(checksum)
        && live_product_supplier(ctx.db, &m.internal_id).await?
    {
        return Ok((Action::Skipped, m.internal_id.clone()));
    }
    let odoo = json!({
        "id": info.odoo_id,
        "sequence": info.sequence,
        "minQty": info.min_qty,
    });
    let row: Option<(String, Option<Value>)> = product_suppliers::Entity::find()
        .select_only()
        .column(Column::Id)
        .expr(odoo_meta())
        .filter(Column::ProductId.eq(input.product_id))
        .filter(same_variant(input.variant_id))
        .filter(Column::SupplierId.eq(input.supplier_id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(ctx.db))
        .await?;
    // The line moved (another product or vendor in Odoo): release the row it owned.
    if let Some(m) = &mapping
        && row.as_ref().is_none_or(|(id, _)| *id != m.internal_id)
    {
        release_owned_row(ctx.db, &m.internal_id, info.odoo_id).await?;
    }
    let mine = supplierinfo_rank(info.sequence, info.min_qty, info.odoo_id);
    let (id, action) = match row {
        Some((id, owner)) => {
            let owns = match owner.as_ref().and_then(owner_rank) {
                Some((owner_id, rank)) => owner_id == info.odoo_id || mine < rank,
                // A row made in WeldStash: Odoo's terms win.
                None => true,
            };
            if !owns {
                save_mapping(
                    ctx.db,
                    ctx.connection_id,
                    SUPPLIER_INFO,
                    info.odoo_id,
                    "product_supplier",
                    &id,
                    Some(checksum),
                )
                .await?;
                return Ok((Action::Skipped, id));
            }
            let mut update = product_suppliers::Entity::update_many()
                .col_expr(Column::SupplierSku, Expr::value(info.supplier_sku.clone()))
                .col_expr(
                    Column::SupplierProductName,
                    Expr::value(info.supplier_product_name.clone()),
                )
                .col_expr(Column::UnitCost, numeric(input.unit_cost))
                .col_expr(
                    Column::LeadTimeDays,
                    Expr::value(info.delay.and_then(|d| i32::try_from(d).ok())),
                )
                .col_expr(
                    Column::MinOrderQty,
                    Expr::value(input.min_order_qty.and_then(|q| i32::try_from(q).ok())),
                )
                .col_expr(
                    Column::Metadata,
                    merged(Expr::col(Column::Metadata), json!({ "odoo": odoo })),
                )
                .col_expr(Column::UpdatedAt, Expr::value(utc_now()));
            // `currency = coalesce($5, currency)`.
            if let Some(currency) = &info.currency {
                update = update.col_expr(Column::Currency, Expr::value(currency.as_str()));
            }
            update
                .filter(Column::Id.eq(id.as_str()))
                .exec(&orm(ctx.db))
                .await?;
            (id, Action::Updated)
        }
        None => {
            let id = generate_id("psup");
            // Preferred when the item has no live preferred supplier yet,
            // decided in the insert itself.
            let preferred = Query::select()
                .expr(Expr::val(1))
                .from(product_suppliers::Entity)
                .and_where(Column::ProductId.eq(input.product_id))
                .and_where(same_variant(input.variant_id))
                .and_where(Column::IsPreferred.eq(true))
                .and_where(Column::DeletedAt.is_null())
                .to_owned();
            let insert = insert_into(
                product_suppliers::Entity,
                vec![
                    (Column::Id, Expr::val(id.as_str())),
                    (Column::ProductId, Expr::val(input.product_id)),
                    (Column::VariantId, Expr::val(input.variant_id)),
                    (Column::SupplierId, Expr::val(input.supplier_id)),
                    (Column::SupplierSku, Expr::val(info.supplier_sku.as_deref())),
                    (
                        Column::SupplierProductName,
                        Expr::val(info.supplier_product_name.as_deref()),
                    ),
                    (Column::UnitCost, numeric(input.unit_cost)),
                    (Column::Currency, Expr::val(info.currency.as_deref())),
                    (
                        Column::LeadTimeDays,
                        Expr::val(info.delay.and_then(|d| i32::try_from(d).ok())),
                    ),
                    (
                        Column::MinOrderQty,
                        Expr::val(input.min_order_qty.and_then(|q| i32::try_from(q).ok())),
                    ),
                    (
                        Column::IsPreferred,
                        sea_orm::ExprTrait::not(Expr::exists(preferred)),
                    ),
                    (
                        Column::Metadata,
                        Expr::val(json!({ "source": "odoo", "odoo": odoo })),
                    ),
                ],
            )?;
            run_insert(&orm(ctx.db), &insert).await?;
            (id, Action::Created)
        }
    };
    save_mapping(
        ctx.db,
        ctx.connection_id,
        SUPPLIER_INFO,
        info.odoo_id,
        "product_supplier",
        &id,
        Some(checksum),
    )
    .await?;
    Ok((action, id))
}

// ── stock ────────────────────────────────────────────────────────────────────

/// One bucket of the snapshot: an item in a managed warehouse.
#[allow(clippy::struct_field_names)]
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct BucketKey {
    pub(crate) product_id: String,
    pub(crate) variant_id: Option<String>,
    pub(crate) warehouse_id: String,
}

/// What a stock refresh changed.
#[derive(Debug, Default)]
pub(crate) struct StockChanges {
    pub(crate) created: Vec<String>,
    pub(crate) updated: Vec<String>,
    pub(crate) zeroed: Vec<String>,
    pub(crate) unchanged: u64,
}

/// The managed warehouses of the connection.
pub(crate) async fn managed_warehouses(ctx: &Ctx<'_>) -> Result<Vec<String>, DbErr> {
    warehouses::Entity::find()
        .select_only()
        .column(warehouses::Column::Id)
        .filter(warehouses::Column::ManagedByConnectionId.eq(ctx.connection_id))
        .filter(warehouses::Column::DeletedAt.is_null())
        .order_by_asc(warehouses::Column::Id)
        .into_tuple()
        .all(&orm(ctx.db))
        .await
}

/// Writes the snapshot (`on hand`, `allocated` per bucket) into
/// `inventory` directly, not through the ledger (which refuses managed
/// warehouses by design): one bucket per item and warehouse, without a
/// location or lot. Every other bucket of the connection's managed
/// warehouses that holds stock goes to zero. Then the products' and
/// variants' `inventory_quantity` roll-ups, as the stash ledger computes
/// them.
#[allow(
    clippy::disallowed_methods,
    reason = "set-based over the whole snapshot, bound as arrays (more buckets than a statement takes parameters): a bulk upsert that merges on a partial unique index and tells inserts from updates by xmax, the zeroing of the rest, and the roll-ups of what changed"
)]
pub(crate) async fn refresh_stock(
    ctx: &Ctx<'_>,
    snapshot: &BTreeMap<BucketKey, (i64, i64)>,
    managed: &[String],
) -> Result<StockChanges, DbErr> {
    let now = now_iso();
    let mut ids = Vec::new();
    let mut products = Vec::new();
    let mut variants: Vec<Option<String>> = Vec::new();
    let mut warehouses = Vec::new();
    let mut on_hand = Vec::new();
    let mut allocated = Vec::new();
    let mut keys = Vec::new();
    for (key, (hand, alloc)) in snapshot {
        ids.push(generate_id("inv"));
        products.push(key.product_id.clone());
        variants.push(key.variant_id.clone());
        warehouses.push(key.warehouse_id.clone());
        on_hand.push(i32::try_from(*hand).unwrap_or(if *hand < 0 { i32::MIN } else { i32::MAX }));
        allocated.push(i32::try_from(*alloc).unwrap_or(if *alloc < 0 {
            i32::MIN
        } else {
            i32::MAX
        }));
        keys.push(format!(
            "{}|{}|{}",
            key.product_id,
            key.variant_id.as_deref().unwrap_or_default(),
            key.warehouse_id
        ));
    }
    let written: Vec<(String, bool)> = sqlx::query_as(
        "insert into inventory as i (id, warehouse_id, product_id, variant_id, quantity_on_hand,
           quantity_allocated, quantity_available, status, metadata)
         select t.id, t.warehouse_id, t.product_id, t.variant_id, t.on_hand, t.allocated,
           t.on_hand - t.allocated, 'available', '{\"source\":\"odoo\"}'::jsonb
         from unnest($1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[], $5::int[], $6::int[])
           as t(id, product_id, variant_id, warehouse_id, on_hand, allocated)
         on conflict (product_id, warehouse_id, variant_id, location_id, lot_number) where deleted_at is null
         do update set quantity_on_hand = excluded.quantity_on_hand,
           quantity_allocated = excluded.quantity_allocated,
           quantity_available = excluded.quantity_available,
           updated_at = $7::timestamp
         where (i.quantity_on_hand, coalesce(i.quantity_allocated, 0), coalesce(i.quantity_available, 0))
           is distinct from (excluded.quantity_on_hand, excluded.quantity_allocated, excluded.quantity_available)
         returning i.id, (xmax = 0)",
    )
    .bind(&ids)
    .bind(&products)
    .bind(&variants)
    .bind(&warehouses)
    .bind(&on_hand)
    .bind(&allocated)
    .bind(&now)
    .fetch_all(ctx.db)
    .await
    .map_err(weldsuite_db::orm_error)?;
    let zeroed: Vec<String> = sqlx::query_scalar(
        "update inventory i set quantity_on_hand = 0, quantity_allocated = 0, quantity_available = 0,
           updated_at = $3::timestamp
         where i.deleted_at is null and i.warehouse_id = any($1)
           and (i.quantity_on_hand <> 0 or coalesce(i.quantity_allocated, 0) <> 0
             or coalesce(i.quantity_available, 0) <> 0)
           and not (i.location_id is null and i.lot_number is null
             and (i.product_id || '|' || coalesce(i.variant_id, '') || '|' || i.warehouse_id) = any($2))
         returning i.id",
    )
    .bind(managed)
    .bind(&keys)
    .bind(&now)
    .fetch_all(ctx.db)
    .await
    .map_err(weldsuite_db::orm_error)?;
    let mut changes = StockChanges::default();
    for (id, inserted) in written {
        if inserted {
            changes.created.push(id);
        } else {
            changes.updated.push(id);
        }
    }
    changes.unchanged = (snapshot.len() as u64)
        .saturating_sub((changes.created.len() + changes.updated.len()) as u64);
    changes.zeroed = zeroed;
    let touched: Vec<String> = changes
        .created
        .iter()
        .chain(&changes.updated)
        .chain(&changes.zeroed)
        .cloned()
        .collect();
    if !touched.is_empty() {
        sqlx::query(
            "update products p set inventory_quantity = (select coalesce(sum(i.quantity_on_hand), 0)
               from inventory i where i.product_id = p.id and i.deleted_at is null),
               updated_at = $2::timestamp
             where p.id in (select product_id from inventory where id = any($1))",
        )
        .bind(&touched)
        .bind(&now)
        .execute(ctx.db)
        .await
        .map_err(weldsuite_db::orm_error)?;
        sqlx::query(
            "update product_variants v set inventory_quantity = (select coalesce(sum(i.quantity_on_hand), 0)
               from inventory i where i.variant_id = v.id and i.deleted_at is null),
               updated_at = $2::timestamp
             where v.id in (select variant_id from inventory where id = any($1) and variant_id is not null)",
        )
        .bind(&touched)
        .bind(&now)
        .execute(ctx.db)
        .await
        .map_err(weldsuite_db::orm_error)?;
    }
    Ok(changes)
}

// ── purchase orders ──────────────────────────────────────────────────────────

/// A `purchase.order` resolved to WeldStash terms.
pub(crate) struct PurchaseOrderInput<'a> {
    pub(crate) odoo_id: i64,
    pub(crate) name: &'a str,
    pub(crate) supplier_id: Option<String>,
    pub(crate) supplier_name: Option<String>,
    pub(crate) warehouse_id: Option<String>,
    pub(crate) warehouse_name: Option<String>,
    pub(crate) status: &'a str,
    pub(crate) order_date: Option<String>,
    pub(crate) expected_date: Option<String>,
    pub(crate) currency: Option<String>,
    pub(crate) subtotal: f64,
    pub(crate) tax_total: f64,
    pub(crate) total: f64,
    pub(crate) lines: Vec<(PoLineValues, Option<Item>, Option<String>)>,
}

/// A purchase order and its lines. A pushed RFQ (`odoo_purchase_order`
/// mapping from the push) is updated in place, keeping its WeldStash number;
/// an order made in Odoo becomes a purchase order numbered as in Odoo.
/// Lines are matched by `metadata.odooLineId`, so item ids stay stable;
/// lines Odoo no longer has are deleted.
pub(crate) async fn upsert_purchase_order(
    ctx: &Ctx<'_>,
    input: &PurchaseOrderInput<'_>,
    checksum: &str,
) -> Result<(Action, String), DbErr> {
    use purchase_orders::Column;
    let now = utc_now();
    let mapping = find_mapping(ctx.db, ctx.connection_id, PURCHASE_ORDER, input.odoo_id).await?;
    if let Some(m) = &mapping
        && m.checksum.as_deref() == Some(checksum)
    {
        return Ok((Action::Skipped, m.internal_id.clone()));
    }
    let ordered: i64 = input.lines.iter().map(|(l, ..)| l.ordered).sum();
    let received: i64 = input.lines.iter().map(|(l, ..)| l.received).sum();
    let count = i64::try_from(input.lines.len()).unwrap_or(i64::MAX);
    let odoo = json!({ "id": input.odoo_id, "name": input.name });
    let db = &orm(ctx.db);
    let existing: Option<String> = match &mapping {
        Some(m) => {
            purchase_orders::Entity::find()
                .select_only()
                .column(Column::Id)
                .filter(Column::Id.eq(m.internal_id.as_str()))
                .filter(Column::DeletedAt.is_null())
                .into_tuple()
                .one(db)
                .await?
        }
        None => None,
    };
    let received_now = input.status == "received";
    let (id, action) = if let Some(id) = existing {
        let mut update = purchase_orders::Entity::update_many()
            .col_expr(Column::Status, Expr::value(input.status))
            .col_expr(Column::OrderDate, timestamp(input.order_date.as_deref()))
            .col_expr(
                Column::ExpectedDate,
                timestamp(input.expected_date.as_deref()),
            )
            .col_expr(Column::Subtotal, numeric(Some(input.subtotal)))
            .col_expr(Column::TaxTotal, numeric(Some(input.tax_total)))
            .col_expr(Column::Total, numeric(Some(input.total)))
            .col_expr(
                Column::ItemCount,
                Expr::value(i32::try_from(count).unwrap_or(i32::MAX)),
            )
            .col_expr(
                Column::TotalQuantityOrdered,
                Expr::value(i32::try_from(ordered).unwrap_or(i32::MAX)),
            )
            .col_expr(
                Column::TotalQuantityReceived,
                Expr::value(i32::try_from(received).unwrap_or(i32::MAX)),
            )
            // `metadata || jsonb_build_object('odoo', coalesce(metadata->'odoo', '{}') || $odoo)`.
            .col_expr(
                Column::Metadata,
                sea_orm::sea_query::extension::postgres::PgExpr::concat(
                    Expr::from(Func::coalesce([
                        Expr::col(Column::Metadata),
                        Expr::val(json!({})),
                    ])),
                    Expr::from(Func::cust("jsonb_build_object").arg(Expr::val("odoo")).arg(
                        merged(
                            sea_orm::sea_query::extension::postgres::PgExpr::get_json_field(
                                Expr::col(Column::Metadata),
                                "odoo",
                            ),
                            odoo,
                        ),
                    )),
                ),
            )
            .col_expr(Column::UpdatedAt, Expr::value(now));
        // `supplier_id = coalesce($2, supplier_id)`, and the same for the
        // supplier's and warehouse's names and ids and the currency.
        for (column, value) in [
            (Column::SupplierId, &input.supplier_id),
            (Column::SupplierName, &input.supplier_name),
            (Column::WarehouseId, &input.warehouse_id),
            (Column::WarehouseName, &input.warehouse_name),
            (Column::Currency, &input.currency),
        ] {
            if let Some(value) = value {
                update = update.col_expr(column, Expr::value(value.as_str()));
            }
        }
        // `received_date = case when $6 = 'received' then
        // coalesce(received_date, now) else received_date end`.
        if received_now {
            update = update.col_expr(
                Column::ReceivedDate,
                Func::coalesce([Expr::col(Column::ReceivedDate), Expr::value(now)]).into(),
            );
        }
        update.filter(Column::Id.eq(id.as_str())).exec(db).await?;
        (id, Action::Updated)
    } else {
        let id = generate_id("po");
        let insert = insert_into(
            purchase_orders::Entity,
            vec![
                (Column::Id, Expr::val(id.as_str())),
                (Column::PoNumber, Expr::val(input.name)),
                (Column::SupplierId, Expr::val(input.supplier_id.as_deref())),
                (
                    Column::SupplierName,
                    Expr::val(input.supplier_name.as_deref()),
                ),
                (
                    Column::WarehouseId,
                    Expr::val(input.warehouse_id.as_deref()),
                ),
                (
                    Column::WarehouseName,
                    Expr::val(input.warehouse_name.as_deref()),
                ),
                (Column::Status, Expr::val(input.status)),
                (Column::OrderDate, timestamp(input.order_date.as_deref())),
                (
                    Column::ExpectedDate,
                    timestamp(input.expected_date.as_deref()),
                ),
                (Column::ReceivedDate, Expr::val(received_now.then_some(now))),
                (
                    Column::Currency,
                    Expr::val(input.currency.as_deref().unwrap_or("USD")),
                ),
                (Column::Subtotal, numeric(Some(input.subtotal))),
                (Column::TaxTotal, numeric(Some(input.tax_total))),
                (Column::Total, numeric(Some(input.total))),
                (
                    Column::ItemCount,
                    Expr::val(i32::try_from(count).unwrap_or(i32::MAX)),
                ),
                (
                    Column::TotalQuantityOrdered,
                    Expr::val(i32::try_from(ordered).unwrap_or(i32::MAX)),
                ),
                (
                    Column::TotalQuantityReceived,
                    Expr::val(i32::try_from(received).unwrap_or(i32::MAX)),
                ),
                (Column::CreatedBy, Expr::val(created_by(ctx))),
                (
                    Column::Metadata,
                    Expr::val(json!({ "source": "odoo", "odoo": odoo })),
                ),
            ],
        )?;
        run_insert(db, &insert).await?;
        (id, Action::Created)
    };
    // A received or cancelled order expects nothing more, short or not.
    let settled = matches!(input.status, "received" | "cancelled");
    replace_po_lines(ctx, &id, &input.lines, settled).await?;
    save_mapping(
        ctx.db,
        ctx.connection_id,
        PURCHASE_ORDER,
        input.odoo_id,
        "purchase_order",
        &id,
        Some(checksum),
    )
    .await?;
    Ok((action, id))
}

async fn replace_po_lines(
    ctx: &Ctx<'_>,
    po_id: &str,
    lines: &[(PoLineValues, Option<Item>, Option<String>)],
    settled: bool,
) -> Result<(), DbErr> {
    use purchase_order_items::Column;
    let now = utc_now();
    let db = &orm(ctx.db);
    let existing: Vec<(String, Option<String>)> = purchase_order_items::Entity::find()
        .select_only()
        .column(Column::Id)
        .expr(
            sea_orm::sea_query::extension::postgres::PgExpr::cast_json_field(
                Expr::col((purchase_order_items::Entity, Column::Metadata)),
                "odooLineId",
            ),
        )
        .filter(Column::PurchaseOrderId.eq(po_id))
        .into_tuple()
        .all(db)
        .await?;
    let by_line: HashMap<String, String> = existing
        .iter()
        .filter_map(|(id, line)| line.clone().map(|l| (l, id.clone())))
        .collect();
    let table = || Expr::col((purchase_order_items::Entity, Column::Metadata));
    let excluded = |column: Column| Expr::col((Alias::new("excluded"), column));
    let mut kept: HashSet<String> = HashSet::new();
    for (line, item, sku) in lines {
        let (product_id, variant_id) = match item {
            Some((product, variant)) => (Some(product.clone()), variant.clone()),
            None => (None, None),
        };
        let pending = if settled {
            0
        } else {
            (line.ordered - line.received).max(0)
        };
        let metadata = json!({ "odooLineId": line.odoo_id.to_string() });
        let id = by_line
            .get(&line.odoo_id.to_string())
            .cloned()
            .unwrap_or_else(|| generate_id("poi"));
        let mut insert = insert_into(
            purchase_order_items::Entity,
            vec![
                (Column::Id, Expr::val(id.as_str())),
                (Column::PurchaseOrderId, Expr::val(po_id)),
                (Column::ProductId, Expr::val(product_id)),
                (Column::VariantId, Expr::val(variant_id)),
                (Column::Sku, Expr::val(sku.as_deref())),
                (Column::Name, Expr::val(line.name.as_str())),
                (
                    Column::QuantityOrdered,
                    Expr::val(i32::try_from(line.ordered).unwrap_or(i32::MAX)),
                ),
                (
                    Column::QuantityReceived,
                    Expr::val(i32::try_from(line.received).unwrap_or(i32::MAX)),
                ),
                (
                    Column::QuantityPending,
                    Expr::val(i32::try_from(pending).unwrap_or(i32::MAX)),
                ),
                (Column::QuantityRejected, Expr::val(0)),
                (Column::UnitPrice, numeric(Some(line.unit_price))),
                (
                    Column::DiscountPercent,
                    numeric(Some(line.discount_percent)),
                ),
                (Column::TaxAmount, numeric(Some(line.tax_amount))),
                (Column::Total, numeric(Some(line.total))),
                (Column::Metadata, Expr::val(metadata)),
            ],
        )?;
        insert.on_conflict(
            OnConflict::column(Column::Id)
                .update_columns([
                    Column::ProductId,
                    Column::VariantId,
                    Column::Name,
                    Column::QuantityOrdered,
                    Column::QuantityReceived,
                    Column::QuantityPending,
                    Column::UnitPrice,
                    Column::DiscountPercent,
                    Column::TaxAmount,
                    Column::Total,
                ])
                // `sku = coalesce(excluded.sku, purchase_order_items.sku)`.
                .value(
                    Column::Sku,
                    Func::coalesce([
                        excluded(Column::Sku),
                        Expr::col((purchase_order_items::Entity, Column::Sku)),
                    ]),
                )
                // `metadata = coalesce(metadata, '{}') || excluded.metadata`.
                .value(
                    Column::Metadata,
                    sea_orm::sea_query::extension::postgres::PgExpr::concat(
                        Expr::from(Func::coalesce([table(), Expr::val(json!({}))])),
                        excluded(Column::Metadata),
                    ),
                )
                .value(Column::UpdatedAt, Expr::value(now))
                .to_owned(),
        );
        run_insert(db, &insert).await?;
        kept.insert(id);
    }
    let stale: Vec<String> = existing
        .into_iter()
        .map(|(id, _)| id)
        .filter(|id| !kept.contains(id))
        .collect();
    if !stale.is_empty() {
        purchase_order_items::Entity::delete_many()
            .filter(Column::Id.is_in(stale))
            .exec(db)
            .await?;
    }
    Ok(())
}

// ── sales ────────────────────────────────────────────────────────────────────

/// One line of demand.
pub(crate) struct SaleInput<'a> {
    pub(crate) odoo_id: i64,
    pub(crate) date: &'a str,
    pub(crate) product_id: &'a str,
    pub(crate) variant_id: Option<&'a str>,
    pub(crate) warehouse_id: Option<&'a str>,
    pub(crate) quantity: i64,
}

/// Upserts a line on `(connection_id, external_ref)`.
#[allow(
    clippy::disallowed_methods,
    reason = "a merging upsert that writes only a changed line and tells an insert from an update by xmax, in one statement"
)]
pub(crate) async fn upsert_sale(ctx: &Ctx<'_>, sale: &SaleInput<'_>) -> Result<Action, DbErr> {
    let inserted: Option<bool> = sqlx::query_scalar(
        "insert into stash_sales_history as s (id, date, product_id, variant_id, warehouse_id, quantity,
           source, connection_id, external_ref)
         values ($1, $2::date, $3, $4, $5, $6, 'odoo', $7, $8)
         on conflict (connection_id, external_ref) do update set date = excluded.date,
           product_id = excluded.product_id, variant_id = excluded.variant_id,
           warehouse_id = excluded.warehouse_id, quantity = excluded.quantity
         where (s.date, s.product_id, s.variant_id, s.warehouse_id, s.quantity)
           is distinct from (excluded.date, excluded.product_id, excluded.variant_id,
             excluded.warehouse_id, excluded.quantity)
         returning (xmax = 0)",
    )
    .bind(generate_id("sh"))
    .bind(sale.date)
    .bind(sale.product_id)
    .bind(sale.variant_id)
    .bind(sale.warehouse_id)
    .bind(i32::try_from(sale.quantity).unwrap_or(i32::MAX))
    .bind(ctx.connection_id)
    .bind(sale.odoo_id.to_string())
    .fetch_optional(ctx.db)
    .await
    .map_err(weldsuite_db::orm_error)?;
    Ok(match inserted {
        Some(true) => Action::Created,
        Some(false) => Action::Updated,
        None => Action::Skipped,
    })
}

/// Removes a line that no longer counts (cancelled, back to quotation, a
/// product that no longer keeps stock).
pub(crate) async fn delete_sale(ctx: &Ctx<'_>, odoo_id: i64) -> Result<Action, DbErr> {
    let removed = stash_sales_history::Entity::delete_many()
        .filter(stash_sales_history::Column::ConnectionId.eq(ctx.connection_id))
        .filter(stash_sales_history::Column::ExternalRef.eq(odoo_id.to_string()))
        .exec(&orm(ctx.db))
        .await?;
    Ok(if removed.rows_affected > 0 {
        Action::Deleted
    } else {
        Action::Skipped
    })
}
