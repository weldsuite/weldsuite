//! The send engine (`apps/workers/reach-api`'s `services/scheduler.ts`,
//! `services/send-tick.ts` and `services/guardrails.ts`): the planning
//! rules, one workspace's send tick and the auto-pause guardrails. The
//! sweep and the queue consumer around it are the module's
//! (`weldsuite_reach::send`).

pub mod guardrails;
pub mod scheduler;
pub mod tick;
