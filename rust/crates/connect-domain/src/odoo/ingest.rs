//! The Odoo syncs' writes: literal SQL into the WeldStash tables, linked to
//! Odoo through `integration_entity_mappings` (`odoo_warehouse`,
//! `odoo_product`, `odoo_product_template`, `odoo_supplier`,
//! `odoo_supplierinfo`, `odoo_purchase_order`). A record whose mapping
//! carries the same checksum is skipped, as the generic ingest does.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_events::{EntityEvent, EventContext, EventSource, EventType};
use weldsuite_kit::generate_id;

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
) -> Result<Option<Mapping>, sqlx::Error> {
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(
        "select internal_entity_type, internal_entity_id, sync_checksum from integration_entity_mappings
         where connection_id = $1 and external_entity_type = $2 and external_entity_id = $3 limit 1",
    )
    .bind(connection_id)
    .bind(external_type)
    .bind(external_id.to_string())
    .fetch_optional(db)
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
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into integration_entity_mappings
           (id, connection_id, external_entity_type, external_entity_id, internal_entity_type,
            internal_entity_id, last_synced_at, sync_checksum)
         values ($1, $2, $3, $4, $5, $6, $7::timestamp, $8)
         on conflict (connection_id, external_entity_type, external_entity_id) do update set
           internal_entity_type = excluded.internal_entity_type,
           internal_entity_id = excluded.internal_entity_id,
           sync_checksum = excluded.sync_checksum,
           last_synced_at = excluded.last_synced_at,
           updated_at = excluded.last_synced_at",
    )
    .bind(generate_id("iem"))
    .bind(connection_id)
    .bind(external_type)
    .bind(external_id.to_string())
    .bind(internal_type)
    .bind(internal_id)
    .bind(now_iso())
    .bind(checksum)
    .execute(db)
    .await
    .map(|_| ())
}

async fn delete_mapping(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
    external_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "delete from integration_entity_mappings
         where connection_id = $1 and external_entity_type = $2 and external_entity_id = $3",
    )
    .bind(connection_id)
    .bind(external_type)
    .bind(external_id.to_string())
    .execute(db)
    .await
    .map(|_| ())
}

/// Every mapping of one external type: Odoo id → (internal type, id).
pub(crate) async fn mappings_of(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
) -> Result<HashMap<i64, (String, String)>, sqlx::Error> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "select external_entity_id, internal_entity_type, internal_entity_id
         from integration_entity_mappings where connection_id = $1 and external_entity_type = $2",
    )
    .bind(connection_id)
    .bind(external_type)
    .fetch_all(db)
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
/// resolved to its product).
pub(crate) async fn product_items(
    db: &PgPool,
    connection_id: &str,
) -> Result<HashMap<i64, Item>, sqlx::Error> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "select m.external_entity_id,
                case when m.internal_entity_type = 'product_variant' then v.product_id else m.internal_entity_id end,
                case when m.internal_entity_type = 'product_variant' then m.internal_entity_id end
         from integration_entity_mappings m
         left join product_variants v on m.internal_entity_type = 'product_variant' and v.id = m.internal_entity_id
         where m.connection_id = $1 and m.external_entity_type = $2
           and (m.internal_entity_type <> 'product_variant' or v.id is not null)",
    )
    .bind(connection_id)
    .bind(PRODUCT)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(external, product, variant)| {
            external
                .parse::<i64>()
                .ok()
                .map(|id| (id, (product, variant)))
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

// ── warehouses ───────────────────────────────────────────────────────────────

/// A synced warehouse: managed by the connection (its stock is Odoo's).
/// An unmapped Odoo warehouse always gets a new WeldStash warehouse, never an
/// existing one with the same code: the stock sync owns a managed
/// warehouse's buckets and zeroes what Odoo does not report.
pub(crate) async fn upsert_warehouse(
    ctx: &Ctx<'_>,
    values: &WarehouseValues,
    checksum: &str,
) -> Result<(Action, String), sqlx::Error> {
    let now = now_iso();
    if let Some(mapping) =
        find_mapping(ctx.db, ctx.connection_id, WAREHOUSE, values.odoo_id).await?
    {
        if mapping.checksum.as_deref() == Some(checksum) {
            return Ok((Action::Skipped, mapping.internal_id));
        }
        let updated = sqlx::query(
            "update warehouses set name = $2, code = $3, is_active = $4, managed_by_connection_id = $5,
               metadata = coalesce(metadata, '{}'::jsonb) || $6::jsonb, updated_at = $7::timestamp
             where id = $1",
        )
        .bind(&mapping.internal_id)
        .bind(&values.name)
        .bind(&values.code)
        .bind(values.active)
        .bind(ctx.connection_id)
        .bind(&values.metadata)
        .bind(&now)
        .execute(ctx.db)
        .await?;
        if updated.rows_affected() > 0 {
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
    sqlx::query(
        "insert into warehouses (id, name, code, is_active, is_default, managed_by_connection_id, metadata)
         values ($1, $2, $3, $4, false, $5, $6)",
    )
    .bind(&id)
    .bind(&values.name)
    .bind(&values.code)
    .bind(values.active)
    .bind(ctx.connection_id)
    .bind(&values.metadata)
    .execute(ctx.db)
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

async fn live_product(db: &PgPool, id: &str) -> Result<bool, sqlx::Error> {
    let found: Option<String> =
        sqlx::query_scalar("select id from products where id = $1 and deleted_at is null")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(found.is_some())
}

/// A live product with this SKU that no other Odoo product of the
/// connection is mapped to.
async fn product_by_sku(ctx: &Ctx<'_>, sku: Option<&str>) -> Result<Option<String>, sqlx::Error> {
    let Some(sku) = sku else { return Ok(None) };
    sqlx::query_scalar(
        "select p.id from products p
         where p.sku = $1 and p.deleted_at is null
           and not exists (select 1 from integration_entity_mappings m
             where m.connection_id = $2 and m.external_entity_type = $3
               and m.internal_entity_type = 'product' and m.internal_entity_id = p.id)
         order by p.created_at, p.id limit 1",
    )
    .bind(sku)
    .bind(ctx.connection_id)
    .bind(PRODUCT)
    .fetch_optional(ctx.db)
    .await
}

/// A live variant with this SKU (under `parent` first) that no other Odoo
/// product is mapped to: (variant id, product id).
async fn variant_by_sku(
    ctx: &Ctx<'_>,
    sku: Option<&str>,
    parent: Option<&str>,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let Some(sku) = sku else { return Ok(None) };
    sqlx::query_as(
        "select v.id, v.product_id from product_variants v
         join products p on p.id = v.product_id and p.deleted_at is null
         where v.sku = $1 and v.deleted_at is null
           and not exists (select 1 from integration_entity_mappings m
             where m.connection_id = $2 and m.external_entity_type = $3
               and m.internal_entity_type = 'product_variant' and m.internal_entity_id = v.id)
         order by (v.product_id = $4) desc, v.created_at, v.id limit 1",
    )
    .bind(sku)
    .bind(ctx.connection_id)
    .bind(PRODUCT)
    .bind(parent.unwrap_or_default())
    .fetch_optional(ctx.db)
    .await
}

async fn insert_product(
    ctx: &Ctx<'_>,
    values: &ProductValues,
    sku: Option<&str>,
    has_variants: bool,
) -> Result<String, sqlx::Error> {
    let id = generate_id("prod");
    let slug = Some(crate::mappers::slugify(&values.name))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id.clone());
    sqlx::query(
        "insert into products (id, name, slug, sku, barcode, cost_price, price, weight, status,
           track_inventory, has_variants, created_by)
         values ($1, $2, $3, $4, $5, $6::numeric, coalesce($7::numeric, 0), $8::numeric, $9, true, $10, $11)",
    )
    .bind(&id)
    .bind(&values.name)
    .bind(slug)
    .bind(sku)
    .bind(if has_variants { None } else { values.barcode.as_deref() })
    .bind(if has_variants { None } else { values.cost })
    .bind(values.price)
    .bind(if has_variants { None } else { values.weight })
    .bind(product_status(values.active))
    .bind(has_variants)
    .bind(created_by(ctx))
    .execute(ctx.db)
    .await?;
    Ok(id)
}

async fn update_single_product(
    ctx: &Ctx<'_>,
    id: &str,
    values: &ProductValues,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update products set name = $2, sku = $3, barcode = $4, cost_price = $5::numeric,
           price = coalesce($6::numeric, price), weight = coalesce($7::numeric, weight),
           status = $8, updated_at = $9::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(&values.name)
    .bind(&values.sku)
    .bind(&values.barcode)
    .bind(values.cost)
    .bind(values.price)
    .bind(values.weight)
    .bind(product_status(values.active))
    .bind(now_iso())
    .execute(ctx.db)
    .await
    .map(|_| ())
}

async fn upsert_variant(
    ctx: &Ctx<'_>,
    existing: Option<&str>,
    parent: &str,
    values: &ProductValues,
) -> Result<(String, bool), sqlx::Error> {
    if let Some(id) = existing {
        let updated = sqlx::query(
            "update product_variants set name = $2, sku = $3, barcode = $4, cost_price = $5::numeric,
               price = coalesce($6::numeric, price), weight = coalesce($7::numeric, weight),
               status = $8, updated_at = $9::timestamp
             where id = $1 and deleted_at is null",
        )
        .bind(id)
        .bind(&values.variant_name)
        .bind(&values.sku)
        .bind(&values.barcode)
        .bind(values.cost)
        .bind(values.price)
        .bind(values.weight)
        .bind(variant_status(values.active))
        .bind(now_iso())
        .execute(ctx.db)
        .await?;
        if updated.rows_affected() > 0 {
            return Ok((id.to_owned(), false));
        }
    }
    let id = generate_id("pvr");
    sqlx::query(
        "insert into product_variants (id, product_id, name, sku, barcode, cost_price, price, weight,
           status, created_by)
         values ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9, $10)",
    )
    .bind(&id)
    .bind(parent)
    .bind(&values.variant_name)
    .bind(&values.sku)
    .bind(&values.barcode)
    .bind(values.cost)
    .bind(values.price)
    .bind(values.weight)
    .bind(variant_status(values.active))
    .bind(created_by(ctx))
    .execute(ctx.db)
    .await?;
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
) -> Result<(Action, String), sqlx::Error> {
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
            let parent: Option<String> =
                sqlx::query_scalar("select product_id from product_variants where id = $1")
                    .bind(&m.internal_id)
                    .fetch_optional(ctx.db)
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
        sqlx::query("update products set sku = null, barcode = null where id = $1")
            .bind(&parent)
            .execute(ctx.db)
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
    sqlx::query(
        "update products p set name = $2, has_variants = true, status = case when $3 then 'active' else p.status end,
           variant_count = (select count(*) from product_variants v where v.product_id = p.id and v.deleted_at is null),
           updated_at = $4::timestamp
         where p.id = $1",
    )
    .bind(&parent)
    .bind(&values.name)
    .bind(values.active)
    .bind(now_iso())
    .execute(ctx.db)
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
) -> Result<(Action, String), sqlx::Error> {
    let mapping = find_mapping(ctx.db, ctx.connection_id, SUPPLIER, values.odoo_id).await?;
    if let Some(m) = &mapping
        && m.checksum.as_deref() == Some(checksum)
    {
        return Ok((Action::Skipped, m.internal_id.clone()));
    }
    let mapped: Option<String> = match &mapping {
        Some(m) => {
            sqlx::query_scalar("select id from suppliers where id = $1 and deleted_at is null")
                .bind(&m.internal_id)
                .fetch_optional(ctx.db)
                .await?
        }
        None => None,
    };
    let existing = match mapped {
        Some(id) => Some(id),
        None => {
            sqlx::query_scalar(
                "select s.id from suppliers s
                 where s.deleted_at is null
                   and (case when $1::text is not null then s.code = $1 else lower(s.name) = lower($2) end)
                   and not exists (select 1 from integration_entity_mappings m
                     where m.connection_id = $3 and m.external_entity_type = $4 and m.internal_entity_id = s.id)
                 order by s.created_at, s.id limit 1",
            )
            .bind(&values.code)
            .bind(&values.name)
            .bind(ctx.connection_id)
            .bind(SUPPLIER)
            .fetch_optional(ctx.db)
            .await?
        }
    };
    let (id, action) = if let Some(id) = existing {
        sqlx::query(
            "update suppliers set name = $2, code = coalesce($3, code), email = $4, phone = $5, website = $6,
               address_line_1 = $7, address_line_2 = $8, city = $9, state = $10, postal_code = $11,
               country = $12, tax_id = $13, payment_terms = coalesce($14, payment_terms),
               currency = coalesce($15, currency), is_active = $16,
               status = case when $16 then 'active' else 'inactive' end,
               metadata = coalesce(metadata, '{}'::jsonb) || $17::jsonb, updated_at = $18::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(&values.name)
        .bind(&values.code)
        .bind(&values.email)
        .bind(&values.phone)
        .bind(&values.website)
        .bind(&values.address_line_1)
        .bind(&values.address_line_2)
        .bind(&values.city)
        .bind(&values.state)
        .bind(&values.postal_code)
        .bind(&values.country)
        .bind(&values.tax_id)
        .bind(&values.payment_terms)
        .bind(&values.currency)
        .bind(values.active)
        .bind(&values.metadata)
        .bind(now_iso())
        .execute(ctx.db)
        .await?;
        (id, Action::Updated)
    } else {
        let id = generate_id("sup");
        sqlx::query(
            "insert into suppliers (id, name, code, email, phone, website, address_line_1, address_line_2,
               city, state, postal_code, country, tax_id, payment_terms, currency, is_active, status, metadata)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, coalesce($15, 'USD'), $16,
               case when $16 then 'active' else 'inactive' end, $17)",
        )
        .bind(&id)
        .bind(&values.name)
        .bind(&values.code)
        .bind(&values.email)
        .bind(&values.phone)
        .bind(&values.website)
        .bind(&values.address_line_1)
        .bind(&values.address_line_2)
        .bind(&values.city)
        .bind(&values.state)
        .bind(&values.postal_code)
        .bind(&values.country)
        .bind(&values.tax_id)
        .bind(&values.payment_terms)
        .bind(&values.currency)
        .bind(values.active)
        .bind(&values.metadata)
        .execute(ctx.db)
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

fn owner_rank(odoo: &Value) -> Option<(i64, (i64, i64, i64))> {
    let id = odoo.get("id")?.as_i64()?;
    let sequence = odoo.get("sequence").and_then(Value::as_i64).unwrap_or(1);
    let min_qty = odoo.get("minQty").and_then(Value::as_f64).unwrap_or(0.0);
    Some((id, supplierinfo_rank(sequence, min_qty, id)))
}

/// Soft-deletes the row a vendor line owns (its `metadata.odoo.id`), and
/// drops the line's mapping. Another line for the same product and vendor
/// fills the row again on its next change (or a full sync).
pub(crate) async fn remove_supplierinfo(
    ctx: &Ctx<'_>,
    odoo_id: i64,
) -> Result<Option<String>, sqlx::Error> {
    let Some(mapping) = find_mapping(ctx.db, ctx.connection_id, SUPPLIER_INFO, odoo_id).await?
    else {
        return Ok(None);
    };
    let removed: Option<String> = sqlx::query_scalar(
        "update product_suppliers set deleted_at = $2::timestamp, updated_at = $2::timestamp
         where id = $1 and deleted_at is null and (metadata->'odoo'->>'id') = $3
         returning id",
    )
    .bind(&mapping.internal_id)
    .bind(now_iso())
    .bind(odoo_id.to_string())
    .fetch_optional(ctx.db)
    .await?;
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
) -> Result<(Action, String), sqlx::Error> {
    let info = input.info;
    let mapping = find_mapping(ctx.db, ctx.connection_id, SUPPLIER_INFO, info.odoo_id).await?;
    if let Some(m) = &mapping
        && m.checksum.as_deref() == Some(checksum)
    {
        return Ok((Action::Skipped, m.internal_id.clone()));
    }
    let odoo = json!({
        "id": info.odoo_id,
        "sequence": info.sequence,
        "minQty": info.min_qty,
    });
    let row: Option<(String, Option<Value>)> = sqlx::query_as(
        "select id, metadata->'odoo' from product_suppliers
         where product_id = $1 and coalesce(variant_id, '') = coalesce($2, '') and supplier_id = $3
           and deleted_at is null
         limit 1",
    )
    .bind(input.product_id)
    .bind(input.variant_id)
    .bind(input.supplier_id)
    .fetch_optional(ctx.db)
    .await?;
    // The line moved (another product or vendor in Odoo): release the row it owned.
    if let Some(m) = &mapping
        && row.as_ref().is_none_or(|(id, _)| *id != m.internal_id)
    {
        sqlx::query(
            "update product_suppliers set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1 and deleted_at is null and (metadata->'odoo'->>'id') = $3",
        )
        .bind(&m.internal_id)
        .bind(now_iso())
        .bind(info.odoo_id.to_string())
        .execute(ctx.db)
        .await?;
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
            sqlx::query(
                "update product_suppliers set supplier_sku = $2, supplier_product_name = $3,
                   unit_cost = $4::numeric, currency = coalesce($5, currency), lead_time_days = $6,
                   min_order_qty = $7,
                   metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('odoo', $8::jsonb),
                   updated_at = $9::timestamp
                 where id = $1",
            )
            .bind(&id)
            .bind(&info.supplier_sku)
            .bind(&info.supplier_product_name)
            .bind(input.unit_cost)
            .bind(&info.currency)
            .bind(info.delay.and_then(|d| i32::try_from(d).ok()))
            .bind(input.min_order_qty.and_then(|q| i32::try_from(q).ok()))
            .bind(&odoo)
            .bind(now_iso())
            .execute(ctx.db)
            .await?;
            (id, Action::Updated)
        }
        None => {
            let id = generate_id("psup");
            sqlx::query(
                "insert into product_suppliers (id, product_id, variant_id, supplier_id, supplier_sku,
                   supplier_product_name, unit_cost, currency, lead_time_days, min_order_qty, is_preferred, metadata)
                 values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10,
                   not exists (select 1 from product_suppliers o where o.product_id = $2
                     and coalesce(o.variant_id, '') = coalesce($3, '') and o.is_preferred and o.deleted_at is null),
                   jsonb_build_object('source', 'odoo', 'odoo', $11::jsonb))",
            )
            .bind(&id)
            .bind(input.product_id)
            .bind(input.variant_id)
            .bind(input.supplier_id)
            .bind(&info.supplier_sku)
            .bind(&info.supplier_product_name)
            .bind(input.unit_cost)
            .bind(&info.currency)
            .bind(info.delay.and_then(|d| i32::try_from(d).ok()))
            .bind(input.min_order_qty.and_then(|q| i32::try_from(q).ok()))
            .bind(&odoo)
            .execute(ctx.db)
            .await?;
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
pub(crate) async fn managed_warehouses(ctx: &Ctx<'_>) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select id from warehouses where managed_by_connection_id = $1 and deleted_at is null order by id",
    )
    .bind(ctx.connection_id)
    .fetch_all(ctx.db)
    .await
}

/// Writes the snapshot (`on hand`, `allocated` per bucket) into
/// `inventory` directly, not through the ledger (which refuses managed
/// warehouses by design): one bucket per item and warehouse, without a
/// location or lot. Every other bucket of the connection's managed
/// warehouses that holds stock goes to zero. Then the products' and
/// variants' `inventory_quantity` roll-ups, as the stash ledger computes
/// them.
pub(crate) async fn refresh_stock(
    ctx: &Ctx<'_>,
    snapshot: &BTreeMap<BucketKey, (i64, i64)>,
    managed: &[String],
) -> Result<StockChanges, sqlx::Error> {
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
    .await?;
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
    .await?;
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
        .await?;
        sqlx::query(
            "update product_variants v set inventory_quantity = (select coalesce(sum(i.quantity_on_hand), 0)
               from inventory i where i.variant_id = v.id and i.deleted_at is null),
               updated_at = $2::timestamp
             where v.id in (select variant_id from inventory where id = any($1) and variant_id is not null)",
        )
        .bind(&touched)
        .bind(&now)
        .execute(ctx.db)
        .await?;
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
) -> Result<(Action, String), sqlx::Error> {
    let now = now_iso();
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
    let existing: Option<String> = match &mapping {
        Some(m) => {
            sqlx::query_scalar(
                "select id from purchase_orders where id = $1 and deleted_at is null",
            )
            .bind(&m.internal_id)
            .fetch_optional(ctx.db)
            .await?
        }
        None => None,
    };
    let (id, action) = if let Some(id) = existing {
        sqlx::query(
            "update purchase_orders set supplier_id = coalesce($2, supplier_id),
               supplier_name = coalesce($3, supplier_name), warehouse_id = coalesce($4, warehouse_id),
               warehouse_name = coalesce($5, warehouse_name), status = $6,
               order_date = $7::timestamp, expected_date = $8::timestamp,
               received_date = case when $6 = 'received' then coalesce(received_date, $16::timestamp) else received_date end,
               currency = coalesce($9, currency), subtotal = $10::numeric, tax_total = $11::numeric,
               total = $12::numeric, item_count = $13, total_quantity_ordered = $14,
               total_quantity_received = $15,
               metadata = coalesce(metadata, '{}'::jsonb)
                 || jsonb_build_object('odoo', coalesce(metadata->'odoo', '{}'::jsonb) || $17::jsonb),
               updated_at = $16::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(&input.supplier_id)
        .bind(&input.supplier_name)
        .bind(&input.warehouse_id)
        .bind(&input.warehouse_name)
        .bind(input.status)
        .bind(&input.order_date)
        .bind(&input.expected_date)
        .bind(&input.currency)
        .bind(input.subtotal)
        .bind(input.tax_total)
        .bind(input.total)
        .bind(i32::try_from(count).unwrap_or(i32::MAX))
        .bind(i32::try_from(ordered).unwrap_or(i32::MAX))
        .bind(i32::try_from(received).unwrap_or(i32::MAX))
        .bind(&now)
        .bind(&odoo)
        .execute(ctx.db)
        .await?;
        (id, Action::Updated)
    } else {
        let id = generate_id("po");
        sqlx::query(
            "insert into purchase_orders (id, po_number, supplier_id, supplier_name, warehouse_id,
               warehouse_name, status, order_date, expected_date, received_date, currency, subtotal,
               tax_total, total, item_count, total_quantity_ordered, total_quantity_received,
               created_by, metadata)
             values ($1, $2, $3, $4, $5, $6, $7, $8::timestamp, $9::timestamp,
               case when $7 = 'received' then $17::timestamp end, coalesce($10, 'USD'),
               $11::numeric, $12::numeric, $13::numeric, $14, $15, $16, $18,
               jsonb_build_object('source', 'odoo', 'odoo', $19::jsonb))",
        )
        .bind(&id)
        .bind(input.name)
        .bind(&input.supplier_id)
        .bind(&input.supplier_name)
        .bind(&input.warehouse_id)
        .bind(&input.warehouse_name)
        .bind(input.status)
        .bind(&input.order_date)
        .bind(&input.expected_date)
        .bind(&input.currency)
        .bind(input.subtotal)
        .bind(input.tax_total)
        .bind(input.total)
        .bind(i32::try_from(count).unwrap_or(i32::MAX))
        .bind(i32::try_from(ordered).unwrap_or(i32::MAX))
        .bind(i32::try_from(received).unwrap_or(i32::MAX))
        .bind(&now)
        .bind(created_by(ctx))
        .bind(&odoo)
        .execute(ctx.db)
        .await?;
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
) -> Result<(), sqlx::Error> {
    let now = now_iso();
    let existing: Vec<(String, Option<String>)> = sqlx::query_as(
        "select id, metadata->>'odooLineId' from purchase_order_items where purchase_order_id = $1",
    )
    .bind(po_id)
    .fetch_all(ctx.db)
    .await?;
    let by_line: HashMap<String, String> = existing
        .iter()
        .filter_map(|(id, line)| line.clone().map(|l| (l, id.clone())))
        .collect();
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
        sqlx::query(
            "insert into purchase_order_items (id, purchase_order_id, product_id, variant_id, sku, name,
               quantity_ordered, quantity_received, quantity_pending, quantity_rejected, unit_price,
               discount_percent, tax_amount, total, metadata)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10::numeric, $11::numeric, $12::numeric,
               $13::numeric, $14)
             on conflict (id) do update set product_id = excluded.product_id, variant_id = excluded.variant_id,
               sku = coalesce(excluded.sku, purchase_order_items.sku), name = excluded.name,
               quantity_ordered = excluded.quantity_ordered, quantity_received = excluded.quantity_received,
               quantity_pending = excluded.quantity_pending, unit_price = excluded.unit_price,
               discount_percent = excluded.discount_percent, tax_amount = excluded.tax_amount,
               total = excluded.total,
               metadata = coalesce(purchase_order_items.metadata, '{}'::jsonb) || excluded.metadata,
               updated_at = $15::timestamp",
        )
        .bind(&id)
        .bind(po_id)
        .bind(&product_id)
        .bind(&variant_id)
        .bind(sku)
        .bind(&line.name)
        .bind(i32::try_from(line.ordered).unwrap_or(i32::MAX))
        .bind(i32::try_from(line.received).unwrap_or(i32::MAX))
        .bind(i32::try_from(pending).unwrap_or(i32::MAX))
        .bind(line.unit_price)
        .bind(line.discount_percent)
        .bind(line.tax_amount)
        .bind(line.total)
        .bind(&metadata)
        .bind(&now)
        .execute(ctx.db)
        .await?;
        kept.insert(id);
    }
    let stale: Vec<String> = existing
        .into_iter()
        .map(|(id, _)| id)
        .filter(|id| !kept.contains(id))
        .collect();
    if !stale.is_empty() {
        sqlx::query("delete from purchase_order_items where id = any($1)")
            .bind(&stale)
            .execute(ctx.db)
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
pub(crate) async fn upsert_sale(
    ctx: &Ctx<'_>,
    sale: &SaleInput<'_>,
) -> Result<Action, sqlx::Error> {
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
    .await?;
    Ok(match inserted {
        Some(true) => Action::Created,
        Some(false) => Action::Updated,
        None => Action::Skipped,
    })
}

/// Removes a line that no longer counts (cancelled, back to quotation, a
/// product that no longer keeps stock).
pub(crate) async fn delete_sale(ctx: &Ctx<'_>, odoo_id: i64) -> Result<Action, sqlx::Error> {
    let removed = sqlx::query(
        "delete from stash_sales_history where connection_id = $1 and external_ref = $2",
    )
    .bind(ctx.connection_id)
    .bind(odoo_id.to_string())
    .execute(ctx.db)
    .await?;
    Ok(if removed.rows_affected() > 0 {
        Action::Deleted
    } else {
        Action::Skipped
    })
}
