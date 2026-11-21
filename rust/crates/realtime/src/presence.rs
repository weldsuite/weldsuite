//! Live presence for the API's own routes: what the gateway's
//! `GET /internal/presence` answers (`RealtimePublisher#getPresence` in
//! TypeScript), read in process instead of over HTTP, behind the
//! [`DynPresence`] port that WeldChat's `/api/chat-status`, the notification
//! email gate and the other presence readers take.
//!
//! The state is the backplane's, not this pod's: every pod writes what its
//! own sockets add up to and Valkey folds the live pods into one status per
//! member (`weldsuite_adapters_oss::realtime`), so any pod answers for a
//! socket held by any other.
//!
//! Callers name the workspace by either id (`orgId`, `workspaceId`), while
//! the hub is keyed by `workspaces.clerk_org_id`, else `workspaces.id`; the
//! [`Directory`] maps one onto the other as `/internal/presence` does
//! (`workspaceHubKey`).

use std::sync::Arc;

use weldsuite_ports::{BoxFuture, DynPresence, DynRealtimePublisher, PortError, PresenceReader};

use crate::directory::Directory;

/// [`DynPresence`] over the realtime publisher's presence.
pub struct GatewayPresence {
    publisher: Arc<dyn DynRealtimePublisher>,
    directory: Arc<dyn Directory>,
}

impl GatewayPresence {
    /// Presence from `publisher` (the Valkey publisher of `weldsuite serve`),
    /// with workspace references resolved to hub keys by `directory`.
    pub fn new(publisher: Arc<dyn DynRealtimePublisher>, directory: Arc<dyn Directory>) -> Self {
        Self {
            publisher,
            directory,
        }
    }

    /// As the [`PresenceReader`] the modules' states hold.
    pub fn reader(self) -> PresenceReader {
        PresenceReader(Arc::new(self))
    }
}

impl std::fmt::Debug for GatewayPresence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GatewayPresence")
    }
}

impl DynPresence for GatewayPresence {
    fn presence<'a>(
        &'a self,
        workspace_id: &'a str,
        user_ids: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<(String, String)>, PortError>> {
        Box::pin(async move {
            // A lookup that failed is "unknown", never "nobody is online".
            let hub = self
                .directory
                .hub_key(workspace_id)
                .await
                .map_err(PortError::backend)?;
            let live = self.publisher.presence_boxed(&hub, user_ids).await?;
            Ok(live.into_iter().collect())
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use weldsuite_ports::{LivePresence, RealtimeMessage, RealtimePublisher};

    use super::*;
    use crate::directory::{ChatAccess, DirectoryError, Member};

    /// `ws_a` is the workspace of hub `org_a`; `ws_broken` fails to resolve;
    /// anything else is its own key (an `org_…` id, or an unknown id).
    struct Hubs;

    impl Directory for Hubs {
        fn member<'a>(
            &'a self,
            _org: &'a str,
            _user: &'a str,
        ) -> BoxFuture<'a, Result<Option<Member>, DirectoryError>> {
            Box::pin(std::future::ready(Ok(None)))
        }

        fn chat_access<'a>(
            &'a self,
            _member: &'a Member,
            _user: &'a str,
            _channel: &'a str,
        ) -> BoxFuture<'a, Result<ChatAccess, DirectoryError>> {
            Box::pin(std::future::ready(Ok(ChatAccess::ChannelNotFound)))
        }

        fn conversation_exists<'a>(
            &'a self,
            _member: &'a Member,
            _conversation: &'a str,
        ) -> BoxFuture<'a, Result<bool, DirectoryError>> {
            Box::pin(std::future::ready(Ok(false)))
        }

        fn hub_key<'a>(
            &'a self,
            reference: &'a str,
        ) -> BoxFuture<'a, Result<String, DirectoryError>> {
            let hub = match reference {
                "ws_a" => Ok("org_a".to_owned()),
                "ws_broken" => Err(DirectoryError::Failed("master down".to_owned())),
                other => Ok(other.to_owned()),
            };
            Box::pin(std::future::ready(hub))
        }
    }

    /// The backplane's presence per hub, and what each read asked for.
    #[derive(Default)]
    struct Backplane {
        hubs: BTreeMap<String, LivePresence>,
        fails: bool,
        reads: Mutex<Vec<(String, Vec<String>)>>,
    }

    impl Backplane {
        fn with(hub: &str, members: &[(&str, &str)]) -> Self {
            let live = members
                .iter()
                .map(|(user, live)| ((*user).to_owned(), (*live).to_owned()))
                .collect();
            Self {
                hubs: BTreeMap::from([(hub.to_owned(), live)]),
                ..Self::default()
            }
        }

        fn reads(&self) -> Vec<(String, Vec<String>)> {
            self.reads.lock().expect("reads").clone()
        }
    }

    impl RealtimePublisher for Backplane {
        fn publish(
            &self,
            _message: &RealtimeMessage,
        ) -> impl Future<Output = Result<(), PortError>> + Send {
            std::future::ready(Ok(()))
        }

        fn presence(
            &self,
            workspace: &str,
            user_ids: &[String],
        ) -> impl Future<Output = Result<LivePresence, PortError>> + Send {
            self.reads
                .lock()
                .expect("reads")
                .push((workspace.to_owned(), user_ids.to_vec()));
            let read = if self.fails {
                Err(PortError::backend("valkey down"))
            } else {
                Ok(self
                    .hubs
                    .get(workspace)
                    .map(|live| {
                        live.iter()
                            .filter(|(user, _)| user_ids.is_empty() || user_ids.contains(user))
                            .map(|(user, live)| (user.clone(), live.clone()))
                            .collect()
                    })
                    .unwrap_or_default())
            };
            std::future::ready(read)
        }
    }

    fn presence(backplane: &Arc<Backplane>) -> PresenceReader {
        let publisher: Arc<dyn DynRealtimePublisher> = Arc::clone(backplane) as _;
        GatewayPresence::new(publisher, Arc::new(Hubs)).reader()
    }

    fn pairs(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(user, live)| ((*user).to_owned(), (*live).to_owned()))
            .collect()
    }

    #[tokio::test]
    async fn a_workspace_id_reads_its_hub() {
        let backplane = Arc::new(Backplane::with(
            "org_a",
            &[("user_2", "away"), ("user_1", "online")],
        ));
        let live = presence(&backplane)
            .0
            .presence("ws_a", &[])
            .await
            .expect("presence");
        assert_eq!(live, pairs(&[("user_1", "online"), ("user_2", "away")]));
        assert_eq!(backplane.reads(), [("org_a".to_owned(), Vec::new())]);
    }

    #[tokio::test]
    async fn an_organization_id_is_the_hub_key() {
        let backplane = Arc::new(Backplane::with("org_a", &[("user_1", "busy")]));
        let live = presence(&backplane)
            .0
            .presence("org_a", &[])
            .await
            .expect("presence");
        assert_eq!(live, pairs(&[("user_1", "busy")]));
    }

    #[tokio::test]
    async fn only_the_members_asked_for() {
        let backplane = Arc::new(Backplane::with(
            "org_a",
            &[("user_1", "online"), ("user_2", "away")],
        ));
        let asked = ["user_2".to_owned(), "user_3".to_owned()];
        let live = presence(&backplane)
            .0
            .presence("ws_a", &asked)
            .await
            .expect("presence");
        assert_eq!(live, pairs(&[("user_2", "away")]));
        assert_eq!(backplane.reads(), [("org_a".to_owned(), asked.to_vec())]);
    }

    #[tokio::test]
    async fn nobody_connected_is_an_empty_answer() {
        let backplane = Arc::new(Backplane::default());
        let live = presence(&backplane)
            .0
            .presence("ws_a", &[])
            .await
            .expect("presence");
        assert_eq!(live, pairs(&[]));
    }

    #[tokio::test]
    async fn a_failed_hub_lookup_is_unknown() {
        let backplane = Arc::new(Backplane::with("org_a", &[("user_1", "online")]));
        let read = presence(&backplane).0.presence("ws_broken", &[]).await;
        assert!(read.is_err());
        assert_eq!(backplane.reads(), [], "no read without a hub");
    }

    #[tokio::test]
    async fn a_failed_backplane_read_is_unknown() {
        let backplane = Arc::new(Backplane {
            fails: true,
            ..Backplane::default()
        });
        let read = presence(&backplane).0.presence("ws_a", &[]).await;
        assert!(read.is_err());
    }
}
