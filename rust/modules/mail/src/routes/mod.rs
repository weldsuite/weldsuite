//! One module per mail-api route group (`apps/workers/mail-api/src/routes/<group>`),
//! each at its paths relative to `/api` (or to its own prefix outside it).

pub(crate) mod internal_outbound;
pub(crate) mod mail_accounts;
pub(crate) mod mail_attachments;
pub(crate) mod mail_campaigns;
pub(crate) mod mail_drafts;
pub(crate) mod mail_folders;
pub(crate) mod mail_labels;
pub(crate) mod mail_messages;
pub(crate) mod mail_rules;
pub(crate) mod mail_scheduled;
pub(crate) mod mail_sending;
pub(crate) mod mail_signatures;
pub(crate) mod mail_snooze;
pub(crate) mod mail_subscriptions;
pub(crate) mod mail_sync;
pub(crate) mod mail_templates;
pub(crate) mod mail_threads;
pub(crate) mod mailboxes;
