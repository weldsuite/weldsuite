//! `/api/account` (`app-api/src/routes/account`), behind the session only: no
//! workspace is needed. Not ported yet.

use axum::Router;

use crate::CoreTeamState;

pub(crate) fn router() -> Router<CoreTeamState> {
    Router::new()
}
