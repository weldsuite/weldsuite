//! One module per mail-api route group (`apps/workers/mail-api/src/routes/<group>`),
//! each at its paths relative to `/api` (or to its own prefix outside it).

pub(crate) mod internal_outbound;
pub(crate) mod mail_sending;
