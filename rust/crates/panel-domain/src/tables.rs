//! The Basin tables of WeldPanel (`tables.ts`, ADR PANEL-002): the namespace
//! and the table names the compiler reads.

/// Basin namespace of the WeldPanel tables.
pub const PANEL_BASIN_NAMESPACE: &str = "panel";

/// `events_v1`: one row per event.
pub const EVENTS: &str = "events_v1";
/// `identities_v1`: anonymous id → user id links.
pub const IDENTITIES: &str = "identities_v1";
/// `people_v1`: one row per profile change.
pub const PEOPLE: &str = "people_v1";
/// `groups_v1`: one row per group profile change.
pub const GROUPS: &str = "groups_v1";
/// `replay_chunks_v1`: one row per recording chunk.
pub const REPLAY_CHUNKS: &str = "replay_chunks_v1";
