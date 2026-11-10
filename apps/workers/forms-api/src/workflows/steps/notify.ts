/**
 * Step `notify`: tells the members who follow the form about the new response.
 * Instant subscribers get a platform notification (and the `forms.response`
 * email through the notifications orchestrator); a daily subscriber marks the
 * workspace due for the digest. An edit of a completed response notifies nobody.
 */

import { notifySubscribers } from '../../services/notify';
import type { ProcessStep } from './types';

export const notifyStep: ProcessStep = {
  type: 'always',
  name: 'notify',
  async run(ctx) {
    if (ctx.params.mode === 'update' || ctx.response.status !== 'completed') return;
    await notifySubscribers({ env: ctx.env, db: ctx.db, clerkOrgId: ctx.params.clerkOrgId, form: ctx.form, response: ctx.response, definition: ctx.definition });
  },
};
