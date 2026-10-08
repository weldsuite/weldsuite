import { describe, expect, it } from 'vitest';
import { cureText, expiryText, expiryUrgency } from './certificate-model';

const expiry = {
  expiredAgo: 'Expired {count} days ago',
  expiredYesterday: 'Expired yesterday',
  expiresToday: 'Expires today',
  expiresTomorrow: 'Expires tomorrow',
  expiresIn: 'Expires in {count} days',
};
const cure = { daysLeft: '{count} days left', oneDayLeft: '1 day left', dueToday: 'Last day', pastBy: 'Past by {count} days' };

describe('expiryText', () => {
  it('words the days left on a certificate', () => {
    expect(expiryText(expiry, 45)).toBe('Expires in 45 days');
    expect(expiryText(expiry, 1)).toBe('Expires tomorrow');
    expect(expiryText(expiry, 0)).toBe('Expires today');
    expect(expiryText(expiry, -1)).toBe('Expired yesterday');
    expect(expiryText(expiry, -20)).toBe('Expired 20 days ago');
  });
});

describe('cureText', () => {
  it('words the time left to cure a missing certificate', () => {
    expect(cureText(cure, 30)).toBe('30 days left');
    expect(cureText(cure, 1)).toBe('1 day left');
    expect(cureText(cure, 0)).toBe('Last day');
    expect(cureText(cure, -4)).toBe('Past by 4 days');
  });
});

describe('expiryUrgency', () => {
  it('is expired once past, soon within 30 days, later beyond', () => {
    expect(expiryUrgency(-1)).toBe('expired');
    expect(expiryUrgency(0)).toBe('soon');
    expect(expiryUrgency(30)).toBe('soon');
    expect(expiryUrgency(31)).toBe('later');
  });
});
