import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { interpolate } from '@weldsuite/i18n/provider';
import { SIGN_EVENT_TYPES, type SignEventDto } from '@weldsuite/app-api-client/schemas/weldsign';
import { describeEvent } from './activity';
import { canCorrectEmail, isSigningNow } from './recipients';

const strings = en.weldsign.overview.activity;

function event(overrides: Partial<SignEventDto> = {}): SignEventDto {
  return {
    id: 'evt_1',
    type: 'signed',
    recipientId: 'rcp_1',
    recipientName: 'Ann',
    actorName: null,
    actorEmail: null,
    ip: null,
    createdAt: '2026-10-24T10:00:00.000Z',
    details: null,
    ...overrides,
  };
}

const lineOf = (overrides: Partial<SignEventDto>) => describeEvent(event(overrides), strings, interpolate);

describe('describeEvent', () => {
  it('has a sentence for every event type, in English and in Dutch', () => {
    for (const type of SIGN_EVENT_TYPES) {
      expect(lineOf({ type })?.text, type).toBeTruthy();
      expect(nl.weldsign.overview.activity.events[type], type).toBeTruthy();
    }
    expect(Object.keys(nl.weldsign.overview.activity.events).sort()).toEqual(Object.keys(strings.events).sort());
  });

  it('names the recipient', () => {
    expect(lineOf({ type: 'signed' })?.text).toBe('Signed by Ann');
    expect(lineOf({ type: 'opened' })?.text).toBe('Opened by Ann');
    expect(lineOf({ type: 'code_failed' })?.text).toBe('Wrong code entered by Ann');
    expect(lineOf({ type: 'delivered' })?.text).toBe('Signed PDF emailed to Ann');
  });

  it('falls back to "someone" when the recipient is unknown', () => {
    expect(lineOf({ type: 'opened', recipientName: null })?.text).toBe('Opened by someone');
  });

  it('shows a decline or void reason on its own line', () => {
    expect(lineOf({ type: 'declined', details: { reason: 'Wrong amount' } })?.reason).toBe('Reason: Wrong amount');
    expect(lineOf({ type: 'voided', recipientName: null, details: { reason: 'Sent twice' } })?.reason).toBe('Reason: Sent twice');
    expect(lineOf({ type: 'declined', details: { reason: '  ' } })?.reason).toBeNull();
    expect(lineOf({ type: 'declined', details: { reason: 42 } })?.reason).toBeNull();
  });

  it('says whether a reminder was automatic or sent by someone', () => {
    expect(lineOf({ type: 'reminded' })?.text).toBe('Automatic reminder sent to Ann');
    const byHand = lineOf({ type: 'reminded', actorName: 'Gert' });
    expect(byHand?.text).toBe('Reminder sent to Ann');
    expect(byHand?.by).toBe('by Gert');
  });

  it('shows the old and new email of a correction', () => {
    expect(lineOf({ type: 'recipient_corrected', details: { from: 'a@old.test', to: 'a@new.test' } })?.text).toBe(
      'Email of Ann changed from a@old.test to a@new.test',
    );
    expect(lineOf({ type: 'recipient_corrected', details: { from: 'a@old.test' } })?.text).toBe('Email of Ann corrected');
    expect(lineOf({ type: 'recipient_corrected', details: null })?.text).toBe('Email of Ann corrected');
  });

  it('credits the member only for what a member does', () => {
    expect(lineOf({ type: 'sent', actorName: 'Gert' })?.by).toBe('by Gert');
    expect(lineOf({ type: 'voided', actorName: null, actorEmail: 'gert@weldsuite.test' })?.by).toBe('by gert@weldsuite.test');
    // The signer's own actions are about them, not "by" them.
    expect(lineOf({ type: 'signed', actorName: 'Ann' })?.by).toBeNull();
  });

  it('skips a type it does not know', () => {
    expect(lineOf({ type: 'teleported' as SignEventDto['type'] })).toBeNull();
  });
});

describe('recipient rules', () => {
  it('a signer is "signing now" while sent or opened', () => {
    expect(isSigningNow({ role: 'signer', status: 'sent' })).toBe(true);
    expect(isSigningNow({ role: 'signer', status: 'opened' })).toBe(true);
    expect(isSigningNow({ role: 'signer', status: 'pending' })).toBe(false);
    expect(isSigningNow({ role: 'signer', status: 'signed' })).toBe(false);
    expect(isSigningNow({ role: 'signer', status: 'declined' })).toBe(false);
    expect(isSigningNow({ role: 'cc', status: 'sent' })).toBe(false);
  });

  it('an email can be corrected until the recipient has signed or declined', () => {
    expect(canCorrectEmail({ status: 'pending' })).toBe(true);
    expect(canCorrectEmail({ status: 'sent' })).toBe(true);
    expect(canCorrectEmail({ status: 'opened' })).toBe(true);
    expect(canCorrectEmail({ status: 'signed' })).toBe(false);
    expect(canCorrectEmail({ status: 'declined' })).toBe(false);
  });
});
