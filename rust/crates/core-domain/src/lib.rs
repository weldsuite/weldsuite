//! Core platform rules other modules share, from `@weldsuite/core-domain`
//! (`packages/domains/core`): WeldDrive's access rules and sharing, its file
//! store and its folder tree. WeldSign reads the access rules to check the
//! Drive file a request starts from; `/api/files`, `/api/folders` and
//! `/api/drive` (`weldsuite-core-files`) are built on all of it. Also the
//! plan limits ([`plan_limits`]): what a workspace's plan allows per feature
//! (WeldForms' monthly response quota).

pub mod custom_field_query;
pub mod custom_field_values;
pub mod drive_access;
pub mod drive_sharing;
pub mod files;
pub mod folders;
pub mod js;
pub mod plan_limits;
