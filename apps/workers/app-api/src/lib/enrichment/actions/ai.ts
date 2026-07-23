/**
 * AI enrichment action — STUBBED.
 *
 * AI has been physically removed from WeldSuite. This used to resolve the
 * prompt template and proxy the Anthropic call to agent-worker via the
 * AGENT_WORKER service binding; that binding no longer exists. The action
 * now always returns an empty result after logging a warning — the enrich
 * workflow (`workflows/welddata-enrich.ts`) writes this as a `done` cell with
 * an empty value, same as any other action that finds nothing.
 */

import { resolveTemplate } from '../template';
import type { ActionContext, ActionResult, EnrichmentAction } from './types';

interface AiConfig {
  prompt?: string;
  model?: string;
  maxTokens?: number;
  webSearch?: boolean;
}

export const aiAction: EnrichmentAction = {
  type: 'ai',
  async run(ctx: ActionContext): Promise<ActionResult> {
    const cfg = (ctx.column.config as AiConfig | null) ?? {};
    const prompt = resolveTemplate(cfg.prompt ?? '', ctx.lead, ctx.siblingValues);
    console.warn(
      '[ai] AI is currently unavailable — skipping AI enrichment column for lead',
      ctx.lead.id,
    );
    return { value: '', data: { unavailable: true, promptResolved: Boolean(prompt.trim()) } };
  },
};
