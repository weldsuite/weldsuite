import { describe, expect, it } from 'vitest';
import { tagQueryAt, tagsAsText, withTagTokens } from './record-tags';

describe('the @query the caret is in', () => {
  it('starts at an @ at the start of the text or after a space', () => {
    expect(tagQueryAt('@bud', 4)).toEqual({ start: 0, end: 4, query: 'bud' });
    expect(tagQueryAt('Fill @bud', 9)).toEqual({ start: 5, end: 9, query: 'bud' });
    expect(tagQueryAt('Fill @', 6)).toEqual({ start: 5, end: 6, query: '' });
  });

  it('is not an e-mail address, a finished word or text after the caret', () => {
    expect(tagQueryAt('mail me@acme.com', 16)).toBeNull();
    expect(tagQueryAt('Fill @budget now', 16)).toBeNull();
    expect(tagQueryAt('Fill @budget now', 12)).toEqual({ start: 5, end: 12, query: 'budget' });
  });
});

describe('sending tags', () => {
  const budget = { label: 'Budget', token: '<@sheet:sht_1|Budget>' };
  const budget2026 = { label: 'Budget 2026', token: '<@sheet:sht_2|Budget 2026>' };

  it('turns each picked @Name into its token', () => {
    expect(withTagTokens('Add totals to @Budget please', [budget])).toBe('Add totals to <@sheet:sht_1|Budget> please');
  });

  it('does not let a short name take the start of a longer one', () => {
    expect(withTagTokens('Copy @Budget 2026 into @Budget', [budget, budget2026])).toBe(
      'Copy <@sheet:sht_2|Budget 2026> into <@sheet:sht_1|Budget>',
    );
  });

  it('leaves a tag the user deleted or retyped as text', () => {
    expect(withTagTokens('Add totals to the budget', [budget])).toBe('Add totals to the budget');
  });

  it('reads back as @Name for titles', () => {
    expect(tagsAsText('Fix <@sheet:sht_1|Budget> for <@user_1:Ann>')).toBe('Fix @Budget for @Ann');
  });
});
