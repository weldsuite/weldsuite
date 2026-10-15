import { describe, expect, it, vi } from 'vitest';
import { classifyLocally, isValidEmailSyntax, MAX_MX_LOOKUPS_PER_RUN, validateEmails } from './validation';
import { SuppressionIndex } from './suppressions';

const none = SuppressionIndex.empty();
const suppressed = new SuppressionIndex(
  new Map([['blocked@bigco.io', { value: 'blocked@bigco.io', type: 'email', reason: 'bounced' }]]),
  new Map([['corp.example', { value: 'corp.example', type: 'domain', reason: 'manual' }]]),
);

describe('isValidEmailSyntax', () => {
  it.each(['jane@bigco.io', 'jane.doe+tag@sub.bigco.co.uk', "o'brien@bigco.io", 'a@b.co'])('accepts %s', (email) => {
    expect(isValidEmailSyntax(email)).toBe(true);
  });

  it.each([
    'plain',
    'a@b',
    '@bigco.io',
    'jane@',
    'jane@@bigco.io',
    'jane doe@bigco.io',
    '.jane@bigco.io',
    'jane.@bigco.io',
    'ja..ne@bigco.io',
    'jane@-bigco.io',
    'jane@bigco..io',
    'jane@bigco.123',
    `${'a'.repeat(65)}@bigco.io`,
    `jane@${'a'.repeat(320)}.io`,
  ])('rejects %s', (email) => {
    expect(isValidEmailSyntax(email)).toBe(false);
  });
});

describe('classifyLocally', () => {
  const ctx = { allowConsumer: false, suppressed: none };

  it('puts the strongest verdict first: invalid, suppressed, consumer, role', () => {
    expect(classifyLocally('nope', ctx)).toBe('invalid');
    expect(classifyLocally('blocked@bigco.io', { ...ctx, suppressed })).toBe('suppressed');
    expect(classifyLocally('x@mail.corp.example', { ...ctx, suppressed })).toBe('suppressed');
    expect(classifyLocally('info@gmail.com', ctx)).toBe('consumer'); // consumer beats role
    expect(classifyLocally('sales@bigco.io', ctx)).toBe('role');
    expect(classifyLocally('jane@bigco.io', ctx)).toBeNull();
  });

  it('allows consumer addresses when the workspace may email them', () => {
    expect(classifyLocally('jane@gmail.com', { ...ctx, allowConsumer: true })).toBeNull();
    expect(classifyLocally('info@gmail.com', { ...ctx, allowConsumer: true })).toBe('role');
  });
});

describe('validateEmails', () => {
  const base = { allowConsumer: false, suppressed: none };

  it('adds no_mx for domains that cannot receive mail and keeps everything else valid', async () => {
    const mxLookup = vi.fn(async (domain: string) => domain !== 'nomx.test');
    const verdicts = await validateEmails(['a@bigco.io', 'b@nomx.test', 'c@gmail.com', 'd@bigco.io'], { ...base, mxLookup });
    expect(Object.fromEntries(verdicts)).toEqual({ 'a@bigco.io': 'valid', 'b@nomx.test': 'no_mx', 'c@gmail.com': 'consumer', 'd@bigco.io': 'valid' });
    // one lookup per distinct domain, none for addresses already ruled out locally
    expect(mxLookup.mock.calls.map(([d]) => d).sort()).toEqual(['bigco.io', 'nomx.test']);
  });

  it('leaves an address valid when the lookup is unknown (null)', async () => {
    const verdicts = await validateEmails(['a@flaky.io'], { ...base, mxLookup: async () => null });
    expect(verdicts.get('a@flaky.io')).toBe('valid');
  });

  it('can skip the network entirely', async () => {
    const mxLookup = vi.fn(async () => false);
    const verdicts = await validateEmails(['a@bigco.io'], { ...base, mxLookup, skipMx: true });
    expect(verdicts.get('a@bigco.io')).toBe('valid');
    expect(mxLookup).not.toHaveBeenCalled();
  });

  it('never looks up more domains than one run may', async () => {
    const mxLookup = vi.fn(async () => true);
    const emails = Array.from({ length: MAX_MX_LOOKUPS_PER_RUN + 50 }, (_, i) => `a@d${i}.io`);
    const verdicts = await validateEmails(emails, { ...base, mxLookup });
    expect(mxLookup).toHaveBeenCalledTimes(MAX_MX_LOOKUPS_PER_RUN);
    expect([...verdicts.values()].every((v) => v === 'valid')).toBe(true);
  });
});
