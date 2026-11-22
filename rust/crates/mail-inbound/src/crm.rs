//! WeldCRM's auto-add for incoming mail ([`weldsuite_crm_domain::auto_add`]).
//!
//! Receiving mail is not engaging with someone: anybody can write in. The
//! sender is added only when they answer: the message lands in a thread the
//! mailbox already sent a message into. Spam and promotions never count.
//! (The people a member writes to are added when the mail is sent, by the
//! mail module.)

use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use weldsuite_crm_domain::auto_add::{self, Candidate, Source};
use weldsuite_crm_domain::events::OrderedEvents;
use weldsuite_db::{PgPool, orm};
use weldsuite_events::{EventContext, EventSource};
use weldsuite_schema::tenant::mail_messages;

use crate::context::InboundContext;
use crate::parsed::ParsedEmail;
use crate::recipients::RecipientAccount;
use crate::store::Stored;

/// Whether the mailbox sent a message into the thread.
async fn mailbox_wrote_in_thread(
    db: &PgPool,
    account_id: &str,
    thread_id: &str,
) -> Result<bool, sea_orm::DbErr> {
    let sent: Option<String> = mail_messages::Entity::find()
        .select_only()
        .column(mail_messages::Column::Id)
        .filter(mail_messages::Column::AccountId.eq(account_id))
        .filter(mail_messages::Column::ThreadId.eq(thread_id))
        .filter(mail_messages::Column::Source.eq("sent"))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(sent.is_some())
}

/// The member a private mailbox belongs to, when it has exactly one.
fn mailbox_owner(account: &RecipientAccount) -> Option<&str> {
    match account.members.as_slice() {
        [only] if !account.is_shared => Some(only.user_id.as_str()),
        _ => None,
    }
}

/// Adds the sender to WeldCRM when the workspace's auto-add covers email and
/// the message answers mail the mailbox sent. Never fails the delivery.
pub async fn auto_add_sender(
    ctx: &InboundContext,
    account: &RecipientAccount,
    email: &ParsedEmail,
    stored: &Stored,
) {
    if stored.is_spam || stored.is_promotion || email.from.email.is_empty() {
        return;
    }
    let db = match ctx.tenants.tenant_db(&account.workspace_id).await {
        Ok(db) => db,
        Err(error) => {
            tracing::error!(%error, workspace = %account.workspace_id, "[crm-auto-add] no tenant database");
            return;
        }
    };
    match auto_add::load_settings(&db).await {
        Ok(settings) if settings.covers(Source::Email) => {}
        Ok(_) => return,
        Err(error) => {
            tracing::error!(error = %error.message(), "[crm-auto-add] could not read the settings");
            return;
        }
    }
    match mailbox_wrote_in_thread(&db, &account.account_id, &stored.thread_id).await {
        Ok(true) => {}
        Ok(false) => return,
        Err(error) => {
            tracing::error!(%error, "[crm-auto-add] could not read the thread");
            return;
        }
    }
    let events = OrderedEvents::new(
        ctx.events.clone(),
        EventContext::new(&account.clerk_org_id, "system", EventSource::System),
    );
    let sender = Candidate::new(&email.from.email, email.from.name.as_deref());
    auto_add::add_logged(
        &db,
        &events,
        Source::Email,
        &[sender],
        mailbox_owner(account),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recipients::Member;

    fn account(is_shared: bool, members: &[&str]) -> RecipientAccount {
        RecipientAccount {
            account_id: "macc_1".to_owned(),
            account_email: "sales@weldsuite.org".to_owned(),
            is_shared,
            workspace_id: "ws_1".to_owned(),
            clerk_org_id: "org_1".to_owned(),
            members: members
                .iter()
                .map(|id| Member {
                    user_id: (*id).to_owned(),
                    email: None,
                })
                .collect(),
        }
    }

    #[test]
    fn only_a_private_mailbox_of_one_member_has_an_owner() {
        assert_eq!(
            mailbox_owner(&account(false, &["user_ann"])),
            Some("user_ann")
        );
        assert_eq!(mailbox_owner(&account(true, &["user_ann"])), None);
        assert_eq!(
            mailbox_owner(&account(false, &["user_ann", "user_bob"])),
            None
        );
        assert_eq!(mailbox_owner(&account(false, &[])), None);
    }
}
