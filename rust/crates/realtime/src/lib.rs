//! The realtime WebSocket gateway of the Kubernetes editions: what
//! `apps/workers/realtime-worker` does with Durable Objects (ADR EVT-006),
//! inside `weldsuite serve`, on every pod, with Valkey between the pods.
//!
//! Clients see the realtime-worker: the same paths, handshake (`?token=`, a
//! bearer header or the `authorization` subprotocol), messages, close codes
//! and topic rules, so `@weldsuite/realtime`'s `WorkspaceClient` and
//! `RoomClient` connect unchanged.
//!
//! | Path | Durable Object | Here |
//! |---|---|---|
//! | `/ws` | `WorkspaceHub` per organization | [`hub`]: fan-out per pod; replay log, presence and event ids in Valkey |
//! | `/ws/personal` | `WorkspaceHub` `personal:<user>` | the same, no presence |
//! | `/ws/chat/:id` | `ChatRoom` | [`room`], `seq` from Valkey |
//! | `/ws/support/:workspaceId` | `SupportRoom` | [`room`], members of the workspace only (see below) |
//! | `/ws/conversation/:id` | `ConversationRoom` | [`room`], agents only (widget visitors come with WeldDesk) |
//! | `/ws/whiteboard/:id`, `/ws/document/:id` | `WhiteboardRoom`, `DocumentRoom` | not served yet (Flow is not ported) |
//! | `POST /publish/*`, `GET /internal/presence` | the worker's internal routes | the same, behind `REALTIME_INTERNAL_SECRET`; ported Rust code uses the realtime port in process instead |
//!
//! Every pod subscribes to the Valkey channel of each hub and room it holds a
//! socket of; the publisher (`weldsuite_adapters_oss::ValkeyRealtime`, behind
//! the realtime port) publishes there, so an event reaches every pod that
//! has a subscriber. `weldsuite_adapters_oss::realtime` has the wire format.
//!
//! Differences from the realtime-worker, all on the side of stricter or of
//! what a pod can and a Durable Object could not:
//!
//! - The role and display name come from `workspace_members` (active rows),
//!   not the token's Clerk claims, so OIDC sessions work; someone without an
//!   active membership is refused (403) instead of joining.
//! - Event ids continue the hub's counter from the clock rather than from 1.
//! - Limits the Durable Objects did not have: sockets per pod and per
//!   person, topics per connection (`too_many_subscriptions`), and a send
//!   queue per socket (a client that falls behind is closed with 1013 and
//!   replays from its cursor). A lost Valkey subscription makes every hub
//!   socket `resync_required` and closes room sockets (1012) so their
//!   clients check for gaps.
//! - The support room's support side (tokens of the admin Clerk instance,
//!   role `support`) stays Global-only: the admin console runs there.
//!   Serving it here would take a second verifier for WeldSuite staff (an
//!   OIDC issuer and audience of their own, never inferred from an
//!   organization mismatch) and an admin console that knows each
//!   deployment's gateway.

mod config;
mod directory;
mod gateway;
mod hub;
mod outbox;
mod protocol;
mod room;
mod routes;
mod socket;
mod topics;

pub use config::GatewayConfig;
pub use directory::{ChatAccess, DbDirectory, Directory, DirectoryError, Member};
pub use gateway::{Authenticator, Gateway};
pub use routes::router;
