//! The shapes of `@weldsuite/app-api-client/schemas/weldpanel-*`: the query
//! specs as their Zod schemas parse them (every default filled in, unknown
//! keys dropped), the definitions the context carries and the results.
//!
//! Serializing a parsed spec gives back what Zod's parse gives (an absent
//! optional key stays absent), so the cache key of a spec is the same on
//! both sides. The refinements Zod adds on raw API input (patterns, ranges,
//! cross-field rules) are not checked here; the routes validate first.

pub mod analysis;
pub mod collab;
pub mod query;
pub mod results;

pub use analysis::*;
pub use collab::*;
pub use query::*;
pub use results::*;

/// `#[serde(default = "…")]` helpers for Zod's `.default(…)`.
pub(crate) mod defaults {
    pub(crate) fn utc() -> String {
        "UTC".to_owned()
    }
    pub(crate) fn ten() -> i64 {
        10
    }
}

/// A `.nullish()` field: absent (`None`), `null` (`Some(None)`) or a value.
pub(crate) mod nullish {
    use serde::{Deserialize, Deserializer};

    pub(crate) fn deserialize<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}
