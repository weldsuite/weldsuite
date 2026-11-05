//! WeldChat posting (`services/chat/*`): what a subscribed channel hears when
//! something happens in WeldMerge. [`subscriptions`] are the routes and the
//! matching, [`post`] one card, [`hooks`] what `crate::hooks` calls, and
//! [`digest`] the daily digest and its due-index sweep.

pub(crate) mod digest;
pub(crate) mod hooks;
pub(crate) mod post;
pub(crate) mod subscriptions;
