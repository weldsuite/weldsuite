//! `parcels`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "parcels")]
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
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "trackingNumber")]
    pub tracking_number: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "referenceNumber")]
    pub reference_number: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "barcode")]
    pub barcode: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "statusHistory")]
    pub status_history: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "shipmentId")]
    pub shipment_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "orderId")]
    pub order_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "orderNumber")]
    pub order_number: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "returnId")]
    pub return_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "senderName")]
    pub sender_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "senderCompany")]
    pub sender_company: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "senderEmail")]
    pub sender_email: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "senderPhone")]
    pub sender_phone: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "senderAddress")]
    pub sender_address: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "recipientName")]
    pub recipient_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "recipientCompany")]
    pub recipient_company: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "recipientEmail")]
    pub recipient_email: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "recipientPhone")]
    pub recipient_phone: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "recipientAddress")]
    pub recipient_address: Option<Json>,
    #[sea_orm(column_type = "Decimal(Some((10, 3)))")]
    #[serde(
        rename = "weight",
        serialize_with = "crate::js::Numeric::<3>::serialize_option"
    )]
    pub weight: Option<BigDecimal>,
    #[sea_orm(column_type = "String(StringLen::N(5))")]
    #[serde(rename = "weightUnit")]
    pub weight_unit: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "dimensions")]
    pub dimensions: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "packageType")]
    pub package_type: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "contents")]
    pub contents: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "value")]
    pub value: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "carrierId")]
    pub carrier_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "carrierName")]
    pub carrier_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "serviceType")]
    pub service_type: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "serviceLevel")]
    pub service_level: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "shippingCost")]
    pub shipping_cost: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "insuranceAmount")]
    pub insurance_amount: Option<Json>,
    #[serde(rename = "signatureRequired")]
    pub signature_required: Option<bool>,
    #[serde(rename = "saturdayDelivery")]
    pub saturday_delivery: Option<bool>,
    #[serde(rename = "shippedAt", with = "crate::js::timestamp::option")]
    pub shipped_at: Option<TimeDateTime>,
    #[serde(
        rename = "estimatedDeliveryDate",
        with = "crate::js::timestamp::option"
    )]
    pub estimated_delivery_date: Option<TimeDateTime>,
    #[serde(rename = "actualDeliveryDate", with = "crate::js::timestamp::option")]
    pub actual_delivery_date: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "currentLocation")]
    pub current_location: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "lastScanLocation")]
    pub last_scan_location: Option<String>,
    #[serde(rename = "lastScanDate", with = "crate::js::timestamp::option")]
    pub last_scan_date: Option<TimeDateTime>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "deliveryProof")]
    pub delivery_proof: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "labelUrl")]
    pub label_url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "labelFormat")]
    pub label_format: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "invoiceUrl")]
    pub invoice_url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "customsFormUrl")]
    pub customs_form_url: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "customsInfo")]
    pub customs_info: Option<Json>,
    #[serde(rename = "isReturn")]
    pub is_return: Option<bool>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "returnLabelUrl")]
    pub return_label_url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "returnTrackingNumber")]
    pub return_tracking_number: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "tags")]
    pub tags: Option<Json>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "notes")]
    pub notes: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "customFields")]
    pub custom_fields: Option<Json>,
    /// The pick list the piece was packed for; every piece of a multi-collo
    /// shipment carries it (`pick_lists.parcel_id` keeps the first).
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "pickListId")]
    pub pick_list_id: Option<String>,
    /// The carrier adapter (`postnl`, `dhl_parcel_nl`) that made the label
    /// and tracks it, kept when the account is deleted.
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "carrierCode")]
    pub carrier_code: Option<String>,
    /// The carrier's own id for the piece when it is not the tracking number
    /// (DHL's label id).
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "carrierReference")]
    pub carrier_reference: Option<String>,
    /// The carrier's public track-and-trace page for the piece.
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "trackingUrl")]
    pub tracking_url: Option<String>,
    /// 1..n within the pick list.
    #[serde(rename = "colloNumber")]
    pub collo_number: Option<i32>,
    /// `{ id, name, carrier, address }` when delivered to a pickup point.
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "servicePoint")]
    pub service_point: Option<Json>,
    /// A return parcel's outbound parcel.
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "returnForParcelId")]
    pub return_for_parcel_id: Option<String>,
    /// When the tracking sweep polls the carrier next; null stops it.
    #[serde(
        rename = "trackingNextCheckAt",
        with = "crate::js::timestamp::option"
    )]
    pub tracking_next_check_at: Option<TimeDateTime>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "parcels",
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
            name: "weight_unit",
            sql_type: None,
            default: Some(DdlDefault::Sql("'kg'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "package_type",
            sql_type: None,
            default: Some(DdlDefault::Sql("'parcel'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "signature_required",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "saturday_delivery",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_return",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "parcels_tracking_number_idx",
            columns: &[IndexColumn {
                expression: "tracking_number",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "parcels_status_idx",
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
            name: "parcels_carrier_id_idx",
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
            name: "parcels_shipment_id_idx",
            columns: &[IndexColumn {
                expression: "shipment_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "parcels_order_id_idx",
            columns: &[IndexColumn {
                expression: "order_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "parcels_order_number_idx",
            columns: &[IndexColumn {
                expression: "order_number",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "parcels_created_at_idx",
            columns: &[IndexColumn {
                expression: "created_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "parcels_pick_list_id_idx",
            columns: &[IndexColumn {
                expression: "pick_list_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "parcels_return_for_parcel_id_idx",
            columns: &[IndexColumn {
                expression: "return_for_parcel_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "parcels_tracking_next_check_at_idx",
            columns: &[IndexColumn {
                expression: "tracking_next_check_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: Some("\"parcels\".\"tracking_next_check_at\" IS NOT NULL"),
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
