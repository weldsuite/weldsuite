/**
 * AI Auto-Reply Step Handler
 *
 * AI is currently unavailable. Previously streamed a WeldAgent-generated
 * reply via the AI gateway; now short-circuits and escalates to a human
 * agent the same way the pre-existing "insufficient credits" path already
 * did, so callers (the workflow engine / step-executor) see the same
 * success:false + escalated:true shape they already tolerate.
 */

import type { StepHandler, StepContext, StepResult } from '../types';

export const aiAutoReplyHandler: StepHandler = {
  type: 'ai_auto_reply',

  async execute(_ctx: StepContext): Promise<StepResult> {
    console.warn('[ai] AI is currently unavailable — skipping ai_auto_reply step, escalating to human');
    return { success: false, error: 'AI is currently unavailable', escalated: true };
  },
};
