/**
 * WeldAgent AI proxy — STUBBED.
 *
 * AI has been physically removed from WeldSuite; the AGENT_WORKER service
 * binding this file used to proxy through no longer exists. `WeldAgentAiError`
 * is kept so `routes/weldagent/index.ts`'s `instanceof` check still compiles.
 * `generateConversationTitle` now always resolves to an empty string instead
 * of throwing — the route already falls back to a title derived from the
 * first user message whenever the generated title comes back empty, so this
 * degrades gracefully with no caller changes needed.
 */

import type { Env } from '../types';

export class WeldAgentAiError extends Error {
  constructor(
    public readonly code: 'AGENT_WORKER_BINDING_MISSING' | 'AGENT_WORKER_REQUEST_FAILED',
    message: string,
    public readonly status?: number,
    public readonly upstream?: unknown,
  ) {
    super(message);
    this.name = 'WeldAgentAiError';
  }
}

export type WeldAgentAiOp = 'auto-title';

export interface AutoTitleInput {
  workspaceId: string;
  firstUserMessage: string;
  firstAssistantMessage?: string;
  modelId?: string;
}

/**
 * AI is currently unavailable. Always resolves to an empty string; the
 * caller (`routes/weldagent/index.ts`) treats an empty title as "generate a
 * fallback from the first user message" — no AI call is attempted.
 */
export async function generateConversationTitle(
  _env: Env,
  _input: AutoTitleInput,
): Promise<string> {
  console.warn('[ai] AI is currently unavailable — skipping conversation auto-title');
  return '';
}
