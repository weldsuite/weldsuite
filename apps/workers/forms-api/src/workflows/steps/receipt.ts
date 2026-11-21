/**
 * Step `receipt`: a copy of the answers to the respondent, when the form has
 * `sendReceipt` on. Only ever to a verified address: a verified-email form
 * (the address was proven with a code) or an invitation (the link went to it).
 * Never to an address typed into an anonymous form, which would let anyone make
 * a workspace mail a stranger. Fields the author marked sensitive, files and
 * signatures stay out of the copy.
 */

import { settingsOf } from '../../services/forms';
import { sendReceiptMail } from '../../services/mail';
import { answerPairs } from '../../services/response-text';
import type { ProcessStep } from './types';

export const receiptStep: ProcessStep = {
  type: 'always',
  name: 'receipt',
  async run(ctx) {
    const { form, response } = ctx;
    if (ctx.params.mode === 'update' || response.status !== 'completed') return;
    const settings = settingsOf(form);
    if (!settings.sendReceipt || !response.respondentEmail) return;
    const verified = settings.respondentMode === 'verified_email' || Boolean(response.invitationId);
    if (!verified || settings.respondentMode === 'members') return;
    const answers = answerPairs(ctx.definition, response.answers, { skipSensitive: true });
    await sendReceiptMail(
      { env: ctx.env, db: ctx.db, master: ctx.master, workspaceId: ctx.params.workspaceId },
      form,
      ctx.definition,
      response.respondentEmail,
      response.number,
      answers,
    );
  },
};
