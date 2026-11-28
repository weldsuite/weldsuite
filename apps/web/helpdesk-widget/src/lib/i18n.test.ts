import { describe, expect, it } from 'vitest';
import { detectLocale, fill, sentAgoText, t } from './i18n';

const NOW = new Date('2026-11-27T15:00:00Z').getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('sentAgoText', () => {
  it('says "Just now" for the first minute', () => {
    expect(sentAgoText(ago(0), NOW)).toBe(t.thread.justNow);
    expect(sentAgoText(ago(59_000), NOW)).toBe('Just now');
  });

  it('counts minutes, then hours, in the short form', () => {
    expect(sentAgoText(ago(2 * MINUTE), NOW)).toBe('2m ago');
    expect(sentAgoText(ago(59 * MINUTE), NOW)).toBe('59m ago');
    expect(sentAgoText(ago(3 * HOUR), NOW)).toBe('3h ago');
  });

  it('says "yesterday" for one day and counts days up to a week', () => {
    expect(sentAgoText(ago(DAY + HOUR), NOW)).toBe('yesterday');
    expect(sentAgoText(ago(4 * DAY), NOW)).toBe('4d ago');
  });

  it('shows the date from a week on', () => {
    expect(sentAgoText('2026-11-17T10:00:00Z', NOW)).toBe('Nov 17');
  });
});

describe('detectLocale', () => {
  it('picks Dutch for any nl variant and English otherwise', () => {
    expect(detectLocale(['nl-BE', 'en'])).toBe('nl');
    expect(detectLocale(['en-US'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });
});

describe('fill', () => {
  it('fills known placeholders and leaves unknown ones', () => {
    expect(fill('{name} · {when} {other}', { name: 'You', when: 'Just now' })).toBe('You · Just now {other}');
  });
});
