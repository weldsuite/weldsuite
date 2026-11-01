//! Environment values a request brings with it, read before the process's
//! own. Conformance mode sends the test's `env` this way, so a module reads
//! the secret the TypeScript worker's test was given (`c.env.X`).

use std::collections::HashMap;
use std::sync::Arc;

/// A request extension; absent outside conformance mode.
#[derive(Debug, Clone, Default)]
pub struct RequestEnv(pub Arc<HashMap<String, String>>);

impl RequestEnv {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.get(name).map(String::as_str)
    }
}
