/**
 * Whether this deployment offers WeldChat voice and video calls.
 *
 * Calls run on Cloudflare RealtimeKit: the backend creates its meetings and
 * the call UI connects with its client SDK. Only Global has it. The Rust
 * backend of the Kubernetes editions serves no `/api/chat-calls` and lists
 * `chat-calls` among its `unavailableFeatures`
 * (`rust/bins/weldsuite/src/edition.rs`). Until the runtime config carries
 * that list here, a deployment with a runtime config (Kubernetes) is one
 * without calls. Global loads none and keeps them.
 */

import { getRuntimeConfig } from '@/lib/runtime-config';

export function chatCallsAvailable(): boolean {
  return getRuntimeConfig() === null;
}
