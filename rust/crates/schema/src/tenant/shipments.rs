//! `shipments`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "shipments")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
    #[serde(rename = "deletedAt", with = "crate::js::timestamp::option")]
    pub deleted_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "shipmentNumber")]
    pub shipment_number: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_name = "type", column_type = "String(StringLen::N(20))")]
    #[serde(rename = "type")]
    pub type_: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "parcelIds")]
    pub parcel_ids: Option<Json>,
    #[serde(rename = "totalParcels")]
    pub total_parcels: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "carrierId")]
    pub carrier_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "carrierName")]
    pub carrier_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "serviceType")]
    pub service_type: Option<String>,
    #[sea_orm(column_type = "Decimal(Some((10, 3)))")]
    #[serde(
        rename = "totalWeight",
        serialize_with = "crate::js::Numeric::<3>::serialize_option"
    )]
    pub total_weight: Option<BigDecimal>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "totalCost")]
    pub total_cost: Option<Json>,
    #[serde(rename = "shippedAt", with = "crate::js::timestamp::option")]
    pub shipped_at: Option<TimeDateTime>,
    #[serde(rename = "deliveredAt", with = "crate::js::timestamp::option")]
    pub delivered_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "pickupId")]
    pub pickup_id: Option<String>,
    #[serde(rename = "pickupDate", with = "crate::js::timestamp::option")]
    pub pickup_date: Option<TimeDateTime>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "pickupTimeWindow")]
    pub pickup_time_window: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "manifestUrl")]
    pub manifest_url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "bolUrl")]
    pub bol_url: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "specialInstructions")]
    pub special_instructions: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "internalNotes")]
    pub internal_notes: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "shipments",
    columns: &[
        DdlColumn {
            name: "created_at",
            sql_type: None,
            default: Some(DdlDefault::Sql("now()")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "updated_at",
            sql_type: None,
            default: Some(DdlDefault::Sql("now()")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'draft'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "type",
            sql_type: None,
            default: Some(DdlDefault::Sql("'outbound'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "total_parcels",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "shipments_shipment_number_idx",
            columns: &[IndexColumn {
                expression: "shipment_number",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "shipments_status_idx",
            columns: &[IndexColumn {
                expression: "status",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "shipments_carrier_id_idx",
            columns: &[IndexColumn {
                expression: "carrier_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "shipments_created_at_idx",
            columns: &[IndexColumn {
                expression: "created_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
