//! Why an order write was refused. The commerce module maps each to its
//! response (`code` is the API's error code); the connector ingest treats
//! them all as a failed record.

use std::fmt;

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
    Database(sqlx::Error),
    /// `resource` with `id` is not there (404).
    NotFound {
        resource: &'static str,
        id: String,
    },
    /// An input the rules refuse (400): the field and what is wrong.
    Invalid {
        field: String,
        message: String,
    },
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
    InvalidTransition {
        from: String,
        to: String,
    },
    /// `nextOrderNumber` below the sequence (409 `SEQUENCE_BACKWARDS`).
    SequenceBackwards {
        current: i64,
    },
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

impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
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
        }
    }
}

impl std::error::Error for Error {}
