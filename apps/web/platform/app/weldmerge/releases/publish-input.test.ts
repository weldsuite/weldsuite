import { describe, expect, it } from 'vitest';
import { buildPublishInput, type PublishChoice } from './publish-input';

const choice = (over: Partial<PublishChoice> = {}): PublishChoice => ({
  toKnowledge: false,
  spaceId: '',
  toEmail: false,
  accountId: '',
  recipients: '',
  subject: '',
  ...over,
});

describe('buildPublishInput', () => {
  it('needs a destination, then notes', () => {
    expect(buildPublishInput(choice(), '## Notes')).toEqual({ problem: 'chooseOne' });
    expect(buildPublishInput(choice({ toKnowledge: true, spaceId: 'ksp_1' }), '  ')).toEqual({ problem: 'needNotes' });
    expect(buildPublishInput(choice({ toKnowledge: true, spaceId: 'ksp_1' }), null)).toEqual({ problem: 'needNotes' });
  });

  it('publishes to a WeldKnow space', () => {
    expect(buildPublishInput(choice({ toKnowledge: true }), 'x')).toEqual({ problem: 'selectSpace' });
    expect(buildPublishInput(choice({ toKnowledge: true, spaceId: 'ksp_1' }), 'x')).toEqual({ input: { knowledgeSpaceId: 'ksp_1' } });
  });

  it('sends an email to valid, distinct addresses', () => {
    const base = choice({ toEmail: true, recipients: 'a@x.com, A@x.com b@y.org', subject: ' Spring ' });
    expect(buildPublishInput(base, 'x')).toEqual({ problem: 'selectMailAccount' });
    expect(buildPublishInput({ ...base, accountId: 'mac_1' }, 'x')).toEqual({
      input: { email: { mailAccountId: 'mac_1', to: ['a@x.com', 'b@y.org'], subject: 'Spring' } },
    });
  });

  it('leaves the subject out when blank and rejects a bad address', () => {
    const ok = buildPublishInput(choice({ toEmail: true, accountId: 'mac_1', recipients: 'a@x.com' }), 'x');
    expect(ok).toEqual({ input: { email: { mailAccountId: 'mac_1', to: ['a@x.com'] } } });
    expect(buildPublishInput(choice({ toEmail: true, accountId: 'mac_1', recipients: 'a@x.com oops' }), 'x')).toEqual({
      problem: 'invalidRecipients',
    });
    expect(buildPublishInput(choice({ toEmail: true, accountId: 'mac_1', recipients: '' }), 'x')).toEqual({ problem: 'invalidRecipients' });
  });

  it('can do both at once', () => {
    const result = buildPublishInput(
      choice({ toKnowledge: true, spaceId: 'ksp_1', toEmail: true, accountId: 'mac_1', recipients: 'a@x.com' }),
      'x',
    );
    expect(result).toEqual({ input: { knowledgeSpaceId: 'ksp_1', email: { mailAccountId: 'mac_1', to: ['a@x.com'] } } });
  });
});
