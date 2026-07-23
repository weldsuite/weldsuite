/**
 * WeldChat agent @-mention dispatch (app-api) — STUBBED.
 *
 * AI has been physically removed from WeldSuite. This used to insert a
 * placeholder reply row for each @-mentioned agent and invoke agent-worker's
 * ChatAgent Durable Object over the CHAT_AGENT_WORKER service binding, which
 * would later overwrite the placeholder with a generated reply. That binding
 * (and agent-worker itself) no longer exist, so this is now a no-op: no
 * placeholder message is inserted, no agentRuns row is recorded, nothing is
 * dispatched. Callers (`postChatMessage`) already invoke this fire-and-forget
 * and tolerate it doing nothing.
 */

import type { Database } from '../../db';
import type { Env } from '../../types';

export interface DispatchAgentMentionsContext {
  db: Database;
  env: Env;
  orgId: string;
  /** The user whose message mentioned the agent(s). */
  invokerUserId: string;
}

export interface DispatchAgentMentionsInput {
  /** Mention ids already filtered to the `agt_` prefix. */
  agentMentionIds: string[];
  channelId: string;
  /** The triggering user message id. */
  messageId: string;
  messageContent: string;
}

export async function dispatchAgentMentions(
  _ctx: DispatchAgentMentionsContext,
  input: DispatchAgentMentionsInput,
): Promise<void> {
  if (input.agentMentionIds.length === 0) return;
  console.warn(
    '[ai] AI is currently unavailable — skipping agent-mention dispatch for channel',
    input.channelId,
  );
}
