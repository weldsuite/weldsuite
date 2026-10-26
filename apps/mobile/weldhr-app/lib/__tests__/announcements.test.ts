import { ageOf, bodyPreview, sortAnnouncements } from '../announcements';

/** Wednesday 18 March 2026 at `hh:mm`, local time, as an ISO timestamp. */
const at = (hhmm: string, dayOfMonth = 18) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 2, dayOfMonth, h, m).toISOString();
};
const now = new Date(at('15:00')).getTime();

describe('sortAnnouncements', () => {
  it('lists pinned ones first, then the newest', () => {
    const list = [
      { id: 'old', pinned: false, publishedAt: at('09:00', 10) },
      { id: 'pinned-old', pinned: true, publishedAt: at('09:00', 1) },
      { id: 'new', pinned: false, publishedAt: at('09:00', 17) },
      { id: 'pinned-new', pinned: true, publishedAt: at('09:00', 12) },
    ];
    expect(sortAnnouncements(list).map((a) => a.id)).toEqual(['pinned-new', 'pinned-old', 'new', 'old']);
  });

  it('leaves the list it was given alone', () => {
    const list = [
      { id: 'a', pinned: false, publishedAt: at('09:00', 1) },
      { id: 'b', pinned: false, publishedAt: at('09:00', 2) },
    ];
    sortAnnouncements(list);
    expect(list.map((a) => a.id)).toEqual(['a', 'b']);
  });
});

describe('bodyPreview', () => {
  it('puts the text on one line', () => {
    expect(bodyPreview('Dear all,\n\nThe office is   closed\non Friday.')).toBe('Dear all, The office is closed on Friday.');
  });

  it('cuts a long text with an ellipsis', () => {
    const preview = bodyPreview('word '.repeat(100), 20);
    expect(preview).toBe('word word word word…');
    expect(bodyPreview('short', 20)).toBe('short');
  });
});

describe('ageOf', () => {
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

  it('says just now for the first minute, and for a clock that is slightly ahead', () => {
    expect(ageOf(minutesAgo(0), now)).toEqual({ kind: 'now' });
    expect(ageOf(minutesAgo(-5), now)).toEqual({ kind: 'now' });
  });

  it('counts minutes up to an hour, then hours within today', () => {
    expect(ageOf(minutesAgo(12), now)).toEqual({ kind: 'minutes', count: 12 });
    expect(ageOf(at('13:30'), now)).toEqual({ kind: 'hours', count: 1 });
    expect(ageOf(at('09:00'), now)).toEqual({ kind: 'hours', count: 6 });
  });

  it('goes by calendar day from yesterday on, however few hours ago it was', () => {
    // 23:30 yesterday is only 15.5 hours before 15:00 today, but it is yesterday.
    expect(ageOf(at('23:30', 17), now)).toEqual({ kind: 'yesterday' });
    expect(ageOf(at('08:00', 15), now)).toEqual({ kind: 'days', count: 3 });
    expect(ageOf(at('08:00', 12), now)).toEqual({ kind: 'days', count: 6 });
  });

  it('shows the date from a week on', () => {
    expect(ageOf(at('08:00', 11), now)).toEqual({ kind: 'date' });
    expect(ageOf(at('08:00', 1), now)).toEqual({ kind: 'date' });
  });
});
