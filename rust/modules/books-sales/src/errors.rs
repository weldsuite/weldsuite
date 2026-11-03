//! A sales route's failures and how it answers them
//! (`accountingErrorResponse` in `routes/invoices/index.ts`): a sales tax
//! refusal with its own code, a compliance refusal with the entity fields it
//! is about, a closed period, lock date, posting rule or tax rate as a 400,
//! anything else the route's 500.

use serde_json::json;
use weldsuite_books_domain::http::Refusal;
use weldsuite_books_domain::posting::PostError;
use weldsuite_books_domain::tax::TaxError;

#[derive(Debug)]
pub(crate) enum SalesError {
    Post(PostError),
    Tax(TaxError),
    /// `InvoiceComplianceError`.
    Compliance {
        message: String,
        missing_fields: Vec<String>,
    },
    Refusal(Refusal),
}

impl From<PostError> for SalesError {
    fn from(error: PostError) -> Self {
        Self::Post(error)
    }
}

impl From<TaxError> for SalesError {
    fn from(error: TaxError) -> Self {
        Self::Tax(error)
    }
}

impl From<sqlx::Error> for SalesError {
    fn from(error: sqlx::Error) -> Self {
        Self::Refusal(Refusal::Database(error))
    }
}

impl From<Refusal> for SalesError {
    fn from(error: Refusal) -> Self {
        Self::Refusal(error)
    }
}

impl From<weldsuite_books_domain::table::WriteError> for SalesError {
    fn from(error: weldsuite_books_domain::table::WriteError) -> Self {
        Self::Refusal(error.into())
    }
}

impl SalesError {
    /// `new PostingError(message)`.
    pub(crate) fn posting(message: impl Into<String>) -> Self {
        Self::Post(PostError::Posting(message.into()))
    }

    /// The message of an `Error` (`err.message`), as recurring generation
    /// stores a failed finalize.
    pub(crate) fn message(&self) -> String {
        match self {
            Self::Post(error) => error.to_string(),
            Self::Tax(TaxError::SalesTax(error)) => sales_tax_message(error),
            Self::Tax(error) => error.to_string(),
            Self::Compliance { message, .. } => message.clone(),
            Self::Refusal(refusal) => format!("{refusal:?}"),
        }
    }
}

fn sales_tax_message(error: &weldsuite_books_domain::sales_tax::errors::SalesTaxError) -> String {
    use weldsuite_books_domain::sales_tax::errors::SalesTaxError;
    match error {
        SalesTaxError::Engine(e) => e.message.clone(),
        SalesTaxError::Document(e) => e.message.clone(),
        SalesTaxError::Setup(e) => e.message.clone(),
    }
}

/// `accountingErrorResponse(c, err)`, else the route's 500.
impl From<SalesError> for Refusal {
    fn from(error: SalesError) -> Self {
        match error {
            SalesError::Tax(error) => error.into(),
            SalesError::Compliance {
                message,
                missing_fields,
            } => {
                if missing_fields.is_empty() {
                    Self::bad_request(message)
                } else {
                    Self::bad_request_with(
                        message,
                        json!({ "code": "ENTITY_INVOICE_FIELDS_MISSING", "missingFields": missing_fields }),
                    )
                }
            }
            SalesError::Post(error) => match error.user_message() {
                Some(message) => Self::bad_request(message),
                None => match error {
                    PostError::Database(error) => Self::Database(error),
                    other => Self::Internal(other.to_string()),
                },
            },
            SalesError::Refusal(refusal) => refusal,
        }
    }
}
