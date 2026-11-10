/**
 * A response as question/answer text for emails: in form order, through the
 * engine's `displayAnswer`, without files and signatures and, for a copy that
 * leaves the workspace, without the fields the author marked sensitive.
 */

import { displayAnswer, fieldsOf } from '@weldsuite/forms-engine';
import type { FormDefinition } from '@weldsuite/forms-engine/definition';
import type { QA } from './mail';

export const hasSensitiveFields = (def: FormDefinition): boolean => fieldsOf(def).some((f) => f.sensitive === true);

export function answerPairs(def: FormDefinition, answers: Record<string, unknown>, opts: { skipSensitive: boolean }): QA[] {
  const out: QA[] = [];
  for (const field of fieldsOf(def)) {
    if (field.type === 'file_upload' || field.type === 'signature') continue;
    if (opts.skipSensitive && field.sensitive === true) continue;
    const value = answers[field.id];
    if (value === undefined) continue;
    const answer = displayAnswer(field, value);
    if (answer !== '') out.push({ question: field.title || field.ref, answer });
  }
  return out;
}
