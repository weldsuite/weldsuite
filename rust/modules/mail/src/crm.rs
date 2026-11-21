//! WeldCRM's auto-add for the mail members send
//! ([`weldsuite_crm_domain::auto_add`]): everyone a member emails is someone
//! the workspace deals with, so with the workspace's setting on they go into
//! the CRM. Handed to every send as [`SendDeps::after_send`]
//! (`weldsuite_mail_domain::send`), apart from the ones that are no
//! conversation (unsubscribe mail).

use weldsuite_crm_domain::auto_add::{self, Candidate, Source};
use weldsuite_crm_domain::events::OrderedEvents;
use weldsuite_db::PgPool;
use weldsuite_events::{EntityEventPublisher, EventContext};
use weldsuite_mail_domain::send::AfterSend;
use weldsuite_ports::BoxFuture;

/// The auto-add of one request's (or job's) sends.
pub(crate) struct CrmAutoAdd {
    events: EntityEventPublisher,
    context: EventContext,
}

impl CrmAutoAdd {
    pub(crate) fn new(events: EntityEventPublisher, context: EventContext) -> Self {
        Self { events, context }
    }
}

impl AfterSend for CrmAutoAdd {
    fn sent<'a>(
        &'a self,
        db: &'a PgPool,
        user_id: &'a str,
        recipients: Vec<String>,
    ) -> BoxFuture<'a, ()> {
        let db = db.clone();
        let owner = user_id.to_owned();
        let events = OrderedEvents::new(self.events.clone(), self.context.clone());
        let work = async move {
            let candidates: Vec<Candidate> = recipients
                .iter()
                .map(|email| Candidate::new(email, None))
                .collect();
            auto_add::add_logged(&db, &events, Source::Email, &candidates, Some(&owner)).await;
        };
        // In the background: the send answers without waiting for the CRM.
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                self.events.tracker().spawn_on(work, &runtime);
                Box::pin(std::future::ready(()))
            }
            Err(_) => Box::pin(work),
        }
    }
}
