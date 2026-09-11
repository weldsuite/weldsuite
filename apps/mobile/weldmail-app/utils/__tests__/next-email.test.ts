import {
  getNextEmailId,
  getNextVisibleMessageId,
  getVisibleMessageIds,
  idsFromSections,
  setVisibleMessageIds,
} from '../next-email';

describe('getNextEmailId', () => {
  it('returns the following id in visual order', () => {
    expect(getNextEmailId(['a', 'b', 'c'], 'a')).toBe('b');
    expect(getNextEmailId(['a', 'b', 'c'], 'b')).toBe('c');
  });

  it('returns null on the last row so triage can close the pane', () => {
    expect(getNextEmailId(['a', 'b'], 'b')).toBeNull();
    expect(getNextEmailId(['only'], 'only')).toBeNull();
  });

  it('returns null when the current message is not in the list', () => {
    expect(getNextEmailId(['a', 'b'], 'missing')).toBeNull();
    expect(getNextEmailId([], 'a')).toBeNull();
  });
});

describe('idsFromSections', () => {
  it('flattens pinned-then-date sections into tap order', () => {
    expect(
      idsFromSections([
        { data: [{ id: 'pinned' }] },
        { data: [{ id: 'today-1' }, { id: 'today-2' }] },
      ]),
    ).toEqual(['pinned', 'today-1', 'today-2']);
  });
});

describe('visible message snapshot', () => {
  beforeEach(() => {
    setVisibleMessageIds([]);
  });

  it('copies the published ids so later callers cannot mutate the snapshot', () => {
    const incoming = ['a', 'b'];
    setVisibleMessageIds(incoming);
    incoming.push('c');
    expect(getVisibleMessageIds()).toEqual(['a', 'b']);
  });

  it('resolves the next visible id from the latest snapshot', () => {
    setVisibleMessageIds(['a', 'b', 'c']);
    expect(getNextVisibleMessageId('b')).toBe('c');
    expect(getNextVisibleMessageId('c')).toBeNull();
  });
});
