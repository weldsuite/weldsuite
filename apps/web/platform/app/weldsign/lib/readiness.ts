/**
 * What still stands between a draft and sending it. Shown in the request editor;
 * sending itself runs the same checks on the server. A template is checked the
 * same way, with its roles in place of people.
 */

import type { SignEnvelopeDetail, SignFieldInput, SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';

export type ReadinessProblem =
  | { kind: 'no_documents' }
  | { kind: 'no_signers' }
  | { kind: 'signer_without_signature'; recipientId: string; name: string };

/** How a signer is named in a problem: the person, unless the caller says otherwise (a template names its roles). */
const personLabel = (recipient: SignRecipientDto): string => recipient.name || recipient.email || '';

export function readinessProblems(
  // The fields may be saved or still being placed.
  envelope: Pick<SignEnvelopeDetail, 'documents' | 'recipientList'> & { fields: readonly Pick<SignFieldInput, 'recipientId' | 'type'>[] },
  label: (recipient: SignRecipientDto) => string = personLabel,
): ReadinessProblem[] {
  const problems: ReadinessProblem[] = [];
  if (envelope.documents.length === 0) problems.push({ kind: 'no_documents' });
  const signers = envelope.recipientList.filter((r) => r.role === 'signer');
  if (signers.length === 0) problems.push({ kind: 'no_signers' });
  for (const signer of signers) {
    const signs = envelope.fields.some((f) => f.recipientId === signer.id && f.type === 'signature');
    if (!signs) problems.push({ kind: 'signer_without_signature', recipientId: signer.id, name: label(signer) });
  }
  return problems;
}
