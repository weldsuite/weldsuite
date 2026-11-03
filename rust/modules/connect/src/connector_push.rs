//! The WeldBooks → Moneybird push from connect-api: a pass in the background
//! (`c.executionCtx.waitUntil(pushToMoneybird(…))`), and another one asked
//! of the cron while a backlog remains (`scheduleMoneybirdPushBacklog`).

use serde_json::Value;
use weldsuite_connect_domain::moneybird_push::push_to_moneybird;
use weldsuite_connect_domain::sync::SyncEnv;
use weldsuite_db::PgPool;

use crate::ConnectState;

/// A push pass on the tracker; a pass that leaves work schedules the next.
pub(crate) fn spawn_push(
    state: &ConnectState,
    db: PgPool,
    env: SyncEnv,
    connection: Value,
    force: bool,
) {
    let trigger = "manual";
    state.events.tracker().spawn(async move {
        match push_to_moneybird(&db, &env, &connection, trigger, force).await {
            Ok(result) if result.remaining => {
                tracing::info!("[connect-api/moneybird-push] backlog left for the next pass");
            }
            Ok(_) => {}
            Err(error) => tracing::error!(%error, "[connect-api/moneybird-push] push failed"),
        }
    });
}
