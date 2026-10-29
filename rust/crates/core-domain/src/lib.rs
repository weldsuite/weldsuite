//! Core platform rules other modules share, from `@weldsuite/core-domain`
//! (`packages/domains/core`). Today: WeldDrive's access rules, which WeldSign
//! reads to check the Drive file a request starts from and the folder its
//! signed copy goes to; the drive port (P4) builds on the same module.

pub mod drive_access;
