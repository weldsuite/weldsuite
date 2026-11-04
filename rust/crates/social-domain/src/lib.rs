//! WeldSocial's PostPeer publishing, the one implementation behind every
//! social surface (`@weldsuite/social-publishing`: social-api, external-api
//! and mcp-server on Global): the PostPeer client, connecting and syncing
//! channels, publishing and scheduling with credit metering, cancelling,
//! the delivery webhook's reconciliation and the analytics sync; and the
//! prepaid credits it meters against (`@weldsuite/credits`).
//!
//! PostPeer is reached through [`weldsuite_ports::OutboundHttp`]: a plain
//! HTTP client on Kubernetes, the harness's outbound bridge in conformance
//! builds, so the calls both backends make are compared.

pub mod credits;
pub mod postpeer;
pub mod publishing;
