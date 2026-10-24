/**
 * What still stands between a draft and sending it. Shown on the review step;
 * sending itself (phase 2) runs the same checks on the server.
 */

import type { SignEnvelopeDetail } from '@weldsuite/app-api-client/schemas/weldsign';

export type ReadinessProblem =
  | { kind: 'no_documents' }
  | { kind: 'no_signers' }
  | { kind: 'signer_without_signature'; recipientId: string; name: string };

export function readinessProblems(envelope: Pick<SignEnvelopeDetail, 'documents' | 'recipientList' | 'fields'>): ReadinessProblem[] {
  const problems: ReadinessProblem[] = [];
  if (envelope.documents.length === 0) problems.push({ kind: 'no_documents' });
  const signers = envelope.recipientList.filter((r) => r.role === 'signer');
  if (signers.length === 0) problems.push({ kind: 'no_signers' });
  for (const signer of signers) {
    const signs = envelope.fields.some((f) => f.recipientId === signer.id && f.type === 'signature');
    if (!signs) problems.push({ kind: 'signer_without_signature', recipientId: signer.id, name: signer.name || signer.email || '' });
  }
  return problems;
}
