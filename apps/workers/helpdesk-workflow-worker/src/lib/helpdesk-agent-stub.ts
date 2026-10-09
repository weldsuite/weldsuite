/**
 * Stub for helpdesk agent factory.
 * AI is currently unavailable — these AI handlers (classify, summarize,
 * translate, sentiment) all call this stub, catch the thrown error, and
 * return a graceful `{ success: false, error: '...' }` StepResult.
 */

import { asText } from '@weldsuite/text';

export function createHelpdeskAgent(_opts: Record<string, unknown>): any {
  throw new Error('AI is currently unavailable');
}

/**
 * Gateway model id for an AI step's `model` input: a bare name gets the
 * `openai/` provider prefix, an id that already names a provider is kept, and
 * no input means the default.
 */
export function resolveModelId(model: unknown): string {
  if (!model) return 'openai/gpt-4o';
  const id = asText(model);
  return id.includes('/') ? id : `openai/${id}`;
}
