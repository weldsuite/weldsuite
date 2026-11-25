//! What a carrier call fails with.

/// A failed carrier call, in the words the stash routes answer with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CarrierError {
    /// The carrier refused the credentials (401/403): the API key, user id
    /// or customer number is wrong or lacks the right.
    Unauthorized(String),
    /// The carrier refused the request: its validation messages, one per
    /// problem.
    Rejected(Vec<String>),
    /// The carrier could not be reached or failed (5xx, timeout, an answer
    /// that is not what its documentation says).
    Unavailable(String),
    /// The carrier doesn't offer this (a product, an option, voiding a
    /// label).
    NotSupported(String),
    /// The request is incomplete before it reaches the carrier (no house
    /// number, no pieces).
    Invalid(String),
}

impl CarrierError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::Unavailable(message.into())
    }

    pub fn not_supported(message: impl Into<String>) -> Self {
        Self::NotSupported(message.into())
    }

    /// One message for a person to read.
    pub fn message(&self) -> String {
        match self {
            Self::Unauthorized(message)
            | Self::Unavailable(message)
            | Self::NotSupported(message)
            | Self::Invalid(message) => message.clone(),
            Self::Rejected(messages) => messages.join("; "),
        }
    }

    /// A stable code for the API (`CARRIER_REJECTED`, …).
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unauthorized(_) => "CARRIER_UNAUTHORIZED",
            Self::Rejected(_) => "CARRIER_REJECTED",
            Self::Unavailable(_) => "CARRIER_UNAVAILABLE",
            Self::NotSupported(_) => "CARRIER_NOT_SUPPORTED",
            Self::Invalid(_) => "SHIPMENT_INVALID",
        }
    }
}

impl std::fmt::Display for CarrierError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for CarrierError {}
