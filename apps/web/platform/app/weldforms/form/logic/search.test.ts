import { describe, expect, it } from 'vitest';
import { ENDINGS, parseLogicSearch } from './search';

describe('parseLogicSearch', () => {
  it('keeps a block id', () => {
    expect(parseLogicSearch({ block: 'blk_1' })).toEqual({ block: 'blk_1' });
  });

  it('keeps the endings marker', () => {
    expect(ENDINGS).toBe('endings');
    expect(parseLogicSearch({ block: ENDINGS })).toEqual({ block: 'endings' });
  });

  it('drops an empty block', () => {
    expect(parseLogicSearch({ block: '' })).toEqual({});
  });

  it('drops a block that is not a string', () => {
    expect(parseLogicSearch({ block: 3 })).toEqual({});
    expect(parseLogicSearch({ block: null })).toEqual({});
  });

  it('ignores other keys and a missing block', () => {
    expect(parseLogicSearch({})).toEqual({});
    expect(parseLogicSearch({ tab: 'logic' })).toEqual({});
  });
});
