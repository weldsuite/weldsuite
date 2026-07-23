import { describe, it, expect } from 'vitest';
import { generateId } from './id';

describe('generateId', () => {
  it('produces an id with the prefix when given one', () => {
    const id = generateId('company');
    expect(id).toMatch(/^company_/);
  });

  it('returns an unprefixed id when no prefix is given', () => {
    expect(generateId()).not.toContain('_');
  });

  it('produces unique values across rapid calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(generateId('x'));
    expect(ids.size).toBe(200);
  });

  it('ids fit in varchar(30) for realistic prefixes', () => {
    // Schema columns use `varchar('id', { length: 30 })`. The id must
    // never overrun that, or inserts fail at the DB layer. The longest
    // prefix in use today is `company` (7 chars); `tkt`, `inv`, `wf`,
    // `pl`, `pls`, `task`, `lead`, `act` are all shorter.
    for (let i = 0; i < 50; i++) {
      expect(generateId('company').length).toBeLessThanOrEqual(30);
      expect(generateId('person').length).toBeLessThanOrEqual(30);
      expect(generateId('tkt').length).toBeLessThanOrEqual(30);
      expect(generateId('inv').length).toBeLessThanOrEqual(30);
    }
  });
});
