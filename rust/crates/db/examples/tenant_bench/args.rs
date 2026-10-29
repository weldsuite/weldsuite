//! `--key=value` arguments.

use std::collections::HashMap;
use std::str::FromStr;

pub(crate) struct Args(HashMap<String, String>);

impl Args {
    pub(crate) fn parse(raw: impl Iterator<Item = String>) -> Result<Self, String> {
        let mut values = HashMap::new();
        for arg in raw {
            let Some((key, value)) = arg.strip_prefix("--").and_then(|a| a.split_once('=')) else {
                return Err(format!("expected --key=value, got {arg}"));
            };
            values.insert(key.to_owned(), value.to_owned());
        }
        Ok(Self(values))
    }

    pub(crate) fn string(&self, key: &str) -> Result<String, String> {
        self.0
            .get(key)
            .cloned()
            .ok_or_else(|| format!("--{key} is required"))
    }

    pub(crate) fn get<T: FromStr>(&self, key: &str, default: T) -> Result<T, String> {
        match self.0.get(key) {
            None => Ok(default),
            Some(value) => value
                .parse()
                .map_err(|_| format!("--{key}: bad value {value}")),
        }
    }
}
