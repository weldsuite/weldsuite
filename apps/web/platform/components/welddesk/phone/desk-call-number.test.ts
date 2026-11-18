import { describe, expect, it } from 'vitest';
import { callableNumber, callerFromTimeline, dialableNumber, pickOutboundNumber } from './desk-call-number';

describe('dialableNumber', () => {
  it.each([
    ['+31612345678', '+31612345678'],
    ['+31 6 1234 5678', '+31612345678'],
    ['(020) 123-4567', '0201234567'],
    ['  06-12345678 ', '0612345678'],
  ])('reduces %s to what the dialer takes', (value, expected) => {
    expect(dialableNumber(value)).toBe(expected);
  });

  it.each([null, undefined, '', 'Ann Caller', '12345', 'ann@example.com', '+31 abc 5678'])('rejects %s', (value) => {
    expect(dialableNumber(value)).toBeNull();
  });
});

describe('callableNumber', () => {
  it('takes the caller number a phone conversation is named after', () => {
    expect(callableNumber({ channel: 'phone', name: '+31612345678' }, null)).toBe('+31612345678');
  });

  it('falls back on the contact of a phone conversation that has a name', () => {
    expect(callableNumber({ channel: 'phone', name: 'Ann' }, { mobilePhone: '+31699887766' })).toBe('+31699887766');
  });

  it('ignores the name of a conversation that is not a phone one', () => {
    expect(callableNumber({ channel: 'messenger', name: '+31612345678' }, null)).toBeNull();
  });

  it('prefers the mobile number of the contact, then the direct one', () => {
    expect(callableNumber({ channel: 'email', name: 'Ann' }, { mobilePhone: '+31611111111', directPhone: '+31200000000' })).toBe('+31611111111');
    expect(callableNumber({ channel: 'email', name: 'Ann' }, { mobilePhone: null, directPhone: '+31200000000' })).toBe('+31200000000');
  });
});

describe('pickOutboundNumber', () => {
  it('prefers the default number that may call out', () => {
    expect(
      pickOutboundNumber([
        { phoneNumber: '+1', isDefault: false },
        { phoneNumber: '+2', isDefault: true },
      ]),
    ).toBe('+2');
  });

  it('skips numbers that are inactive or may not call out', () => {
    expect(
      pickOutboundNumber([
        { phoneNumber: '+1', isDefault: true, allowOutbound: false },
        { phoneNumber: '+2', status: 'pending' },
        { phoneNumber: '+3', status: 'active' },
      ]),
    ).toBe('+3');
  });

  it('is null without a usable number', () => {
    expect(pickOutboundNumber(undefined)).toBeNull();
    expect(pickOutboundNumber([])).toBeNull();
  });
});

describe('the number of a phone conversation, in order', () => {
  const started = (fromNumber: unknown, toNumber?: unknown) => ({ metadata: { event: 'call_started', fromNumber, toNumber } });

  it('takes the newest timeline message with a valid caller number first', () => {
    const messages = [started('+31600000001'), { metadata: null }, started('+31600000002'), started('not a number')];
    expect(callerFromTimeline(messages)?.fromNumber).toBe('+31600000002');
    expect(callableNumber({ channel: 'phone', name: '+31611111111' }, { mobilePhone: '+31622222222' }, messages)).toBe('+31600000002');
  });

  it('then the name when it is a number, even for a matched caller with a contact', () => {
    expect(callableNumber({ channel: 'phone', name: '+31611111111' }, { mobilePhone: '+31622222222' }, [{ metadata: null }])).toBe('+31611111111');
    expect(callableNumber({ channel: 'phone', name: '+31611111111' }, { mobilePhone: '+31622222222' }, undefined)).toBe('+31611111111');
  });

  it('then the linked contact, and nothing when there is none', () => {
    expect(callableNumber({ channel: 'phone', name: 'Ann Caller' }, { mobilePhone: '+31622222222' }, [])).toBe('+31622222222');
    expect(callableNumber({ channel: 'phone', name: 'Ann Caller' }, null, [started(null)])).toBeNull();
  });

  it('reads the timeline for phone conversations only', () => {
    expect(callableNumber({ channel: 'email', name: 'Ann' }, null, [started('+31600000001')])).toBeNull();
  });

  it('reports the number the customer called', () => {
    expect(callerFromTimeline([started('+31600000001', '+31 20 000 0002')])).toEqual({ fromNumber: '+31600000001', toNumber: '+31200000002' });
  });
});

describe('pickOutboundNumber with the number the customer called', () => {
  const numbers = [
    { phoneNumber: '+31200000001', isDefault: true },
    { phoneNumber: '+31200000002' },
    { phoneNumber: '+31200000003', allowOutbound: false },
  ];

  it('prefers it when it is one of the outbound numbers', () => {
    expect(pickOutboundNumber(numbers, '+31200000002')).toBe('+31200000002');
  });

  it('falls back on the default when it is not ours or may not call out', () => {
    expect(pickOutboundNumber(numbers, '+31999999999')).toBe('+31200000001');
    expect(pickOutboundNumber(numbers, '+31200000003')).toBe('+31200000001');
    expect(pickOutboundNumber(numbers, null)).toBe('+31200000001');
  });
});
