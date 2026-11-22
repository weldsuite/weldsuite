//! Why an order write was refused. The commerce module maps each to its
//! response (`code` is the API's error code); the connector ingest treats
//! them all as a failed record.

use std::fmt;

use sea_orm::DbErr;

use crate::discount::Problem;

/// An order line the catalogue could not give a price or a product for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineProblem {
    /// Position in the request's `items`.
    pub index: usize,
    /// `PRODUCT_NOT_FOUND`, `NO_PRICE`, `INACTIVE` or `CURRENCY_MISMATCH`.
    pub problem: &'static str,
}

#[derive(Debug)]
pub enum Error {
    /// A failed statement (ORM or SQL).
    Database(DbErr),
    /// `resource` with `id` is not there (404).
    NotFound { resource: &'static str, id: String },
    /// An input the rules refuse (400): the field and what is wrong.
    Invalid { field: String, message: String },
    /// Order lines with a problem (400).
    LineProblems(Vec<LineProblem>),
    /// The discount code does not apply (409 `DISCOUNT_NOT_APPLICABLE`).
    Discount(Problem),
    /// Items or customer may no longer change, or an item cannot go (409
    /// `ORDER_NOT_EDITABLE`).
    NotEditable(String),
    /// Fulfilled, cancelled or completed (409 `ORDER_NOT_CANCELLABLE`).
    NotCancellable,
    /// 409 `ALREADY_PAID`.
    AlreadyPaid,
    /// A status the order cannot move to (409 `INVALID_STATUS_TRANSITION`).
    InvalidTransition { from: String, to: String },
    /// `nextOrderNumber` below the sequence (409 `SEQUENCE_BACKWARDS`).
    SequenceBackwards { current: i64 },
    /// No seller entity: neither `commerce_settings.default_entity_id` nor
    /// the workspace's default legal entity names a live one (409
    /// `SELLER_ENTITY_REQUIRED`).
    SellerEntityRequired,
    /// The seller entity is outside the EU: milestone 1 has EU VAT rules only
    /// (409 `SELLER_ENTITY_NOT_EU`).
    SellerNotEu { country: String },
    /// The destination's VAT is not modelled (Northern Ireland, `XI`): the
    /// sale is refused, not zero-rated (409 `DESTINATION_NOT_SUPPORTED`).
    DestinationNotSupported { country: String },
    /// The VAT engine could not answer (503 `TAX_ENGINE_UNAVAILABLE`). The
    /// write stops: a failure never becomes zero tax.
    TaxEngineUnavailable(String),
    /// The order's tax is locked: it is not editable (409 `ORDER_TAX_LOCKED`).
    TaxLocked,
    /// The order has a Mollie payment in progress, so its total cannot
    /// change (409 `PAYMENT_IN_PROGRESS`).
    PaymentInProgress,
    /// The order waits for an approval and cannot move on (409
    /// `APPROVAL_PENDING`).
    ApprovalPending,
    /// The person is a buyer of the company already (409 `BUYER_EXISTS`).
    BuyerExists,
    /// The company's last admin cannot lose the role (409 `LAST_ADMIN`).
    LastAdmin,
    /// The shopper is not an active buyer of the company (403 `NOT_A_BUYER`).
    NotABuyer,
    /// The shopper may not decide this order (403 `NOT_AN_APPROVER`).
    NotAnApprover,
    /// The order is not waiting for an approval (409 `NOT_PENDING`).
    NotPending,
    /// A B2B channel orders for a company: sign in and pick one (409
    /// `COMPANY_REQUIRED`).
    CompanyRequired,
    /// The company's party has no payment terms (409 `NO_PAYMENT_TERMS`).
    NoPaymentTerms,
    /// The order would take the party past its credit limit (409
    /// `CREDIT_LIMIT_EXCEEDED`); what is left, in cents.
    CreditLimitExceeded { available: crate::money::Cents },
}

impl Error {
    /// A 400 on `field`.
    pub fn invalid(field: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Invalid {
            field: field.into(),
            message: message.into(),
        }
    }

    pub fn not_found(resource: &'static str, id: impl Into<String>) -> Self {
        Self::NotFound {
            resource,
            id: id.into(),
        }
    }
}

impl From<DbErr> for Error {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(crate::db::from_sqlx(error))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(error) => error.fmt(f),
            Self::NotFound { resource, id } => write!(f, "{resource} with ID '{id}' not found"),
            Self::Invalid { field, message } => write!(f, "{field}: {message}"),
            Self::LineProblems(problems) => {
                write!(f, "{} order line(s) cannot be priced", problems.len())
            }
            Self::Discount(problem) => {
                write!(f, "The discount code does not apply: {}", problem.as_str())
            }
            Self::NotEditable(reason) => f.write_str(reason),
            Self::NotCancellable => f.write_str("The order can no longer be cancelled"),
            Self::AlreadyPaid => f.write_str("The order is already paid"),
            Self::InvalidTransition { from, to } => {
                write!(f, "An order cannot move from {from} to {to}")
            }
            Self::SequenceBackwards { current } => {
                write!(f, "The next order number cannot go below {current}")
            }
            Self::SellerEntityRequired => f.write_str(
                "Orders need a seller: set up a legal entity in WeldBooks and make it the default",
            ),
            Self::SellerNotEu { country } => write!(
                f,
                "The seller entity is in {country}: WeldCommerce calculates VAT for EU sellers only"
            ),
            Self::DestinationNotSupported { country } => {
                write!(f, "VAT to {country} is not supported yet")
            }
            Self::TaxEngineUnavailable(why) => {
                write!(f, "The VAT could not be calculated: {why}")
            }
            Self::PaymentInProgress => f.write_str(
                "The order has a payment in progress: wait until it is paid, failed or expired before changing the order",
            ),
            Self::BuyerExists => f.write_str("This person is a buyer of the company already"),
            Self::LastAdmin => f.write_str("A company needs at least one admin"),
            Self::NotABuyer => f.write_str("You are not a buyer of that company"),
            Self::NotAnApprover => f.write_str("You cannot approve orders of this company"),
            Self::NotPending => f.write_str("The order is not waiting for an approval"),
            Self::CompanyRequired => {
                f.write_str("Sign in and choose the company you are ordering for")
            }
            Self::NoPaymentTerms => {
                f.write_str("The company has no payment terms, so it cannot pay on invoice")
            }
            Self::CreditLimitExceeded { .. } => {
                f.write_str("The order would take the company past its credit limit")
            }
            Self::ApprovalPending => {
                f.write_str("The order is waiting for approval and cannot move on yet")
            }
            Self::TaxLocked => f.write_str(
                "The VAT of this order is locked: it can no longer be edited, so it is not recalculated",
            ),
        }
    }
}

impl std::error::Error for Error {}
