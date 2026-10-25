import { describe, expect, it } from 'vitest';
import type { SignDocumentDto, SignFieldDto, SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';
import { readinessProblems } from './readiness';

const doc = { id: 'sgd_1' } as SignDocumentDto;
const signer = (id: string, name: string) => ({ id, name, email: `${id}@example.com`, role: 'signer' }) as SignRecipientDto;
const field = (recipientId: string, type: SignFieldDto['type']) => ({ id: `f_${recipientId}_${type}`, recipientId, type }) as SignFieldDto;

describe('readinessProblems', () => {
  it('asks for a document and a signer on an empty draft', () => {
    expect(readinessProblems({ documents: [], recipientList: [], fields: [] })).toEqual([{ kind: 'no_documents' }, { kind: 'no_signers' }]);
  });

  it('names every signer without a signature field, and ignores copy recipients', () => {
    const cc = { ...signer('c', 'Carl'), role: 'cc' } as SignRecipientDto;
    const problems = readinessProblems({
      documents: [doc],
      recipientList: [signer('a', 'Ann'), signer('b', 'Bob'), cc],
      fields: [field('a', 'signature'), field('b', 'initials')],
    });
    expect(problems).toEqual([{ kind: 'signer_without_signature', recipientId: 'b', name: 'Bob' }]);
  });

  it('is empty when every signer signs', () => {
    expect(readinessProblems({ documents: [doc], recipientList: [signer('a', 'Ann')], fields: [field('a', 'signature')] })).toEqual([]);
  });

  it('names a signer the way the caller says, for a template that names its roles', () => {
    const director = { ...signer('b', 'Dora'), roleName: 'Director' } as SignRecipientDto;
    const problems = readinessProblems(
      { documents: [doc], recipientList: [signer('a', 'Ann'), director], fields: [field('a', 'signature')] },
      (recipient) => recipient.roleName ?? '',
    );
    expect(problems).toEqual([{ kind: 'signer_without_signature', recipientId: 'b', name: 'Director' }]);
  });
});
