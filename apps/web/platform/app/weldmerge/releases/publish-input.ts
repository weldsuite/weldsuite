import type { PublishMergeReleaseInput } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import { parseRecipients } from './recipients';

export interface PublishChoice {
  toKnowledge: boolean;
  spaceId: string;
  toEmail: boolean;
  accountId: string;
  /** Addresses as typed. */
  recipients: string;
  subject: string;
}

/** The label (under `releases.publish`) of the first thing the choice gets wrong. */
export type PublishProblem = 'chooseOne' | 'needNotes' | 'selectSpace' | 'selectMailAccount' | 'invalidRecipients';

export type PublishInputResult = { input: PublishMergeReleaseInput } | { problem: PublishProblem };

/** Turns what the dialog holds into the publish request, or names what is missing, checked in the order the dialog shows it. */
export function buildPublishInput(choice: PublishChoice, notes: string | null): PublishInputResult {
  if (!choice.toKnowledge && !choice.toEmail) return { problem: 'chooseOne' };
  if (!notes?.trim()) return { problem: 'needNotes' };
  const input: PublishMergeReleaseInput = {};
  if (choice.toKnowledge) {
    if (!choice.spaceId) return { problem: 'selectSpace' };
    input.knowledgeSpaceId = choice.spaceId;
  }
  if (choice.toEmail) {
    if (!choice.accountId) return { problem: 'selectMailAccount' };
    const { valid, invalid } = parseRecipients(choice.recipients);
    if (valid.length === 0 || invalid.length > 0) return { problem: 'invalidRecipients' };
    const subject = choice.subject.trim();
    input.email = { mailAccountId: choice.accountId, to: valid, ...(subject ? { subject } : {}) };
  }
  return { input };
}
