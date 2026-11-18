//! WeldPanel's store on this install (ADR EVT-019): the bucket
//! (`S3_BUCKET_PANEL`) holding the Iceberg tables under `lake/`, the
//! collector's recording chunks under `replays/<tier>/…` and its heatmap
//! snapshots under `snapshots/…` (`weldsuite_panel::PanelBucketReplays`),
//! the catalog on the master database,
//! and the NATS streams the collector publishes rows to and `panel-writer`
//! reads.
//!
//! WeldPanel analytics is off on an install without the bucket: nothing
//! writes the tables, and `weldsuite cron panel-maintenance` does nothing.
//!
//! | Variable | |
//! |---|---|
//! | `S3_BUCKET_PANEL` | the bucket; on `S3_ENDPOINT` with `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_FORCE_PATH_STYLE`, as the files buckets |
//! | `NATS_PANEL_EVENTS_STREAM`, `NATS_PANEL_EVENTS_SUBJECT` | the events stream (default `PANEL_EVENTS` on `panel.events.v1.<workspace>`) |
//! | `NATS_PANEL_STATE_STREAM` | the other rows' stream (default `PANEL_STATE` on `panel.{identities,people,groups,replays}.v1.<workspace>`) |
//! | `NATS_PANEL_EVENTS_MAX_AGE_DAYS` | how long both streams keep rows (0: no age limit). The chart sets 7: how long the writer may be down without losing rows |

use std::time::Duration;

use async_nats::jetstream::stream;
use weldsuite_adapters_oss::{S3FileStore, S3Options};
use weldsuite_db::PgPool;
use weldsuite_lakehouse::{Lakehouse, LakehouseConfig, S3Store};

/// The panel bucket and how to reach it (`S3_BUCKET_PANEL` set).
#[derive(Clone)]
pub(crate) struct PanelStoreConfig {
    pub(crate) s3: S3Options,
}

impl std::fmt::Debug for PanelStoreConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PanelStoreConfig")
            .field("bucket", &self.s3.bucket)
            .field("endpoint", &self.s3.endpoint)
            .finish_non_exhaustive()
    }
}

impl PanelStoreConfig {
    /// `S3_BUCKET_PANEL` unset or empty is no store; set, the S3 endpoint
    /// and keys must be too, and the bucket a plain bucket name.
    pub(crate) fn from_lookup(
        lookup: &impl Fn(&str) -> Option<String>,
        problems: &mut Vec<String>,
    ) -> Option<Self> {
        let bucket = lookup("S3_BUCKET_PANEL").filter(|bucket| !bucket.trim().is_empty())?;
        if bucket.contains(['/', ' ', ':']) || bucket.len() > 63 {
            problems.push(format!(
                "S3_BUCKET_PANEL must be a bucket name, not {bucket:?}"
            ));
        }
        let mut required = |name: &str| {
            lookup(name)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| {
                    problems.push(format!("{name} is required with S3_BUCKET_PANEL"));
                    String::new()
                })
        };
        let endpoint = required("S3_ENDPOINT");
        let access_key_id = required("S3_ACCESS_KEY_ID");
        let secret_access_key = required("S3_SECRET_ACCESS_KEY");
        let path_style = match lookup("S3_FORCE_PATH_STYLE").as_deref() {
            None | Some("false") => false,
            Some("true") => true,
            Some(_) => {
                problems.push("S3_FORCE_PATH_STYLE must be true or false".to_owned());
                false
            }
        };
        Some(Self {
            s3: S3Options {
                endpoint,
                region: lookup("S3_REGION").unwrap_or_else(|| "us-east-1".to_owned()),
                bucket,
                access_key_id,
                secret_access_key,
                path_style,
            },
        })
    }

    /// The tables' settings: `s3://<bucket>/lake`, catalog `weldsuite`.
    pub(crate) fn lakehouse_config(&self) -> LakehouseConfig {
        LakehouseConfig::s3(&S3Store {
            endpoint: self.s3.endpoint.clone(),
            region: self.s3.region.clone(),
            bucket: self.s3.bucket.clone(),
            access_key_id: self.s3.access_key_id.clone(),
            secret_access_key: self.s3.secret_access_key.clone(),
            path_style: self.s3.path_style,
        })
    }

    /// The store on the master database (the catalog's tables are there).
    /// Nothing is sent until the first call; must run inside the runtime.
    pub(crate) fn lakehouse(
        &self,
        master: PgPool,
    ) -> Result<Lakehouse, weldsuite_lakehouse::LakehouseError> {
        Lakehouse::new(master, &self.lakehouse_config())
    }

    /// The bucket as a file store: listing for the orphan sweep, and the
    /// bucket check of `S3_ENSURE_BUCKETS`.
    pub(crate) fn file_store(&self) -> Result<S3FileStore, weldsuite_ports::PortError> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(weldsuite_ports::PortError::backend)?;
        S3FileStore::new(&self.s3, client)
    }

    /// The object key of a path in the bucket (`s3://<bucket>/<key>`), if it
    /// is in the bucket.
    pub(crate) fn key_of<'a>(&self, path: &'a str) -> Option<&'a str> {
        path.strip_prefix("s3://")?
            .strip_prefix(self.s3.bucket.as_str())?
            .strip_prefix('/')
    }

    /// The path the tables' metadata names an object by.
    pub(crate) fn path_of(&self, key: &str) -> String {
        format!("s3://{}/{key}", self.s3.bucket)
    }
}

/// WeldPanel's two row streams.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PanelStreams {
    /// `PANEL_EVENTS`.
    pub(crate) events: String,
    /// `panel.events.v1`.
    pub(crate) events_subject: String,
    /// `PANEL_STATE`.
    pub(crate) state: String,
    /// Both streams' max age; zero is none.
    pub(crate) max_age: Duration,
}

impl PanelStreams {
    pub(crate) fn from_lookup(
        lookup: &impl Fn(&str) -> Option<String>,
        problems: &mut Vec<String>,
    ) -> Self {
        let days = match lookup("NATS_PANEL_EVENTS_MAX_AGE_DAYS") {
            None => 0,
            Some(raw) => raw.parse::<u64>().unwrap_or_else(|_| {
                problems.push("NATS_PANEL_EVENTS_MAX_AGE_DAYS must be a whole number".to_owned());
                0
            }),
        };
        Self {
            events: lookup("NATS_PANEL_EVENTS_STREAM")
                .unwrap_or_else(|| weldsuite_adapters_oss::DEFAULT_PANEL_EVENTS_STREAM.to_owned()),
            events_subject: lookup("NATS_PANEL_EVENTS_SUBJECT")
                .unwrap_or_else(|| weldsuite_adapters_oss::DEFAULT_PANEL_EVENTS_SUBJECT.to_owned()),
            state: lookup("NATS_PANEL_STATE_STREAM")
                .unwrap_or_else(|| weldsuite_adapters_oss::DEFAULT_PANEL_STATE_STREAM.to_owned()),
            max_age: Duration::from_hours(days.saturating_mul(24)),
        }
    }

    /// The two streams' configurations, with `replicas`.
    pub(crate) fn configs(&self, replicas: usize) -> [stream::Config; 2] {
        let mut events = weldsuite_adapters_oss::panel_events_stream_config(
            &self.events,
            &self.events_subject,
            self.max_age,
        );
        events.num_replicas = replicas.max(1);
        let mut state =
            weldsuite_adapters_oss::panel_state_stream_config(&self.state, self.max_age);
        state.num_replicas = replicas.max(1);
        [events, state]
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn store(vars: &[(&str, &str)]) -> (Option<PanelStoreConfig>, Vec<String>) {
        let vars: HashMap<&str, &str> = vars.iter().copied().collect();
        let mut problems = Vec::new();
        let config = PanelStoreConfig::from_lookup(
            &|name| vars.get(name).map(|value| (*value).to_owned()),
            &mut problems,
        );
        (config, problems)
    }

    #[test]
    fn the_bucket_turns_the_store_on_and_needs_the_s3_settings() {
        assert!(store(&[]).0.is_none());
        assert!(store(&[("S3_BUCKET_PANEL", "")]).0.is_none());
        let (config, problems) = store(&[
            ("S3_BUCKET_PANEL", "weldsuite-panel"),
            ("S3_ENDPOINT", "http://rustfs:9000"),
            ("S3_ACCESS_KEY_ID", "k"),
            ("S3_SECRET_ACCESS_KEY", "s"),
            ("S3_FORCE_PATH_STYLE", "true"),
        ]);
        assert!(problems.is_empty(), "{problems:?}");
        let config = config.expect("a store");
        assert_eq!(
            config.lakehouse_config().warehouse,
            "s3://weldsuite-panel/lake"
        );
        assert_eq!(
            config
                .lakehouse_config()
                .storage
                .get("s3.path-style-access")
                .map(String::as_str),
            Some("true")
        );
        assert_eq!(
            config.key_of("s3://weldsuite-panel/lake/panel/events_v1/data/x.parquet"),
            Some("lake/panel/events_v1/data/x.parquet")
        );
        assert_eq!(config.key_of("s3://other/lake/x"), None);
        assert_eq!(config.path_of("lake/x"), "s3://weldsuite-panel/lake/x");
        assert!(!format!("{config:?}").contains("\"s\""));

        let (_, problems) = store(&[("S3_BUCKET_PANEL", "a/b"), ("S3_FORCE_PATH_STYLE", "yes")]);
        assert_eq!(problems.len(), 5, "{problems:?}");
    }

    #[test]
    fn both_streams_keep_rows_as_long_as_configured() {
        let mut problems = Vec::new();
        let streams = PanelStreams::from_lookup(
            &|name| (name == "NATS_PANEL_EVENTS_MAX_AGE_DAYS").then(|| "7".to_owned()),
            &mut problems,
        );
        assert!(problems.is_empty(), "{problems:?}");
        let [events, state] = streams.configs(3);
        assert_eq!(events.name, "PANEL_EVENTS");
        assert_eq!(events.subjects, ["panel.events.v1.>"]);
        assert_eq!(state.name, "PANEL_STATE");
        assert_eq!(
            state.subjects,
            [
                "panel.identities.v1.>",
                "panel.people.v1.>",
                "panel.groups.v1.>",
                "panel.replays.v1.>"
            ]
        );
        assert_eq!(events.max_age, Duration::from_hours(7 * 24));
        assert_eq!(state.max_age, events.max_age);
        assert_eq!((events.num_replicas, state.num_replicas), (3, 3));
    }
}
