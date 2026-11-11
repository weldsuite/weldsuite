/**
 * Step `quota`: the response may have taken the workspace to 80 % or 100 % of
 * its monthly quota; admins get `forms.quota` once per threshold per month.
 */

import { sendQuotaNotices } from '../../services/quota-notice';
import type { ProcessStep } from './types';

export const quotaStep: ProcessStep = {
  type: 'always',
  name: 'quota',
  async run(ctx) {
    if (ctx.params.mode === 'update' || ctx.response.status !== 'completed') return;
    await sendQuotaNotices({ env: ctx.env, db: ctx.db, master: ctx.master, workspaceId: ctx.params.workspaceId, clerkOrgId: ctx.params.clerkOrgId });
  },
};
