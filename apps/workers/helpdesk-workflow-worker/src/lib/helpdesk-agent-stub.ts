/**
 * Stub for helpdesk agent factory.
 * AI is currently unavailable — these AI handlers (classify, summarize,
 * translate, sentiment) all call this stub, catch the thrown error, and
 * return a graceful `{ success: false, error: '...' }` StepResult.
 */

export function createHelpdeskAgent(_opts: Record<string, unknown>): any {
  throw new Error('AI is currently unavailable');
}
