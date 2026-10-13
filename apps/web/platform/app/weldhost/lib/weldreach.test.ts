import { describe, expect, it } from 'vitest';
import { ApiError } from '@weldsuite/api-client';
import { hostErrorMessage, isManagedByWeldReach } from './weldreach';

const tw = {
  domainInUse: 'Disconnect this domain in WeldReach first.',
  recordManagedError: 'This record is managed by WeldReach.',
};

const conflict = (code: string, message = 'server text') =>
  new ApiError(message, 409, { error: { code, message } });

describe('isManagedByWeldReach', () => {
  it('is true only for managedBy weldreach', () => {
    expect(isManagedByWeldReach({ managedBy: 'weldreach' })).toBe(true);
    expect(isManagedByWeldReach({ managedBy: null })).toBe(false);
    expect(isManagedByWeldReach({})).toBe(false);
  });
});

describe('hostErrorMessage', () => {
  it('translates the domain-in-use 409', () => {
    expect(hostErrorMessage(conflict('DOMAIN_IN_USE_BY_WELDREACH'), 'fallback', tw)).toBe(tw.domainInUse);
  });

  it('translates the managed-record 409', () => {
    expect(hostErrorMessage(conflict('DNS_RECORD_MANAGED_BY_WELDREACH'), 'fallback', tw)).toBe(tw.recordManagedError);
  });

  it('keeps the server message of any other 409', () => {
    expect(hostErrorMessage(conflict('SOMETHING_ELSE', 'Name is taken'), 'fallback', tw)).toBe('Name is taken');
  });

  it('ignores the code on other statuses', () => {
    const err = new ApiError('Forbidden', 403, { error: { code: 'DOMAIN_IN_USE_BY_WELDREACH' } });
    expect(hostErrorMessage(err, 'fallback', tw)).toBe('Forbidden');
  });

  it('survives a body without a code', () => {
    expect(hostErrorMessage(new ApiError('Conflict', 409, undefined), 'fallback', tw)).toBe('Conflict');
    expect(hostErrorMessage(new ApiError('Conflict', 409, { error: 'text' }), 'fallback', tw)).toBe('Conflict');
  });

  it('falls back for something that is not an error', () => {
    expect(hostErrorMessage('boom', 'fallback', tw)).toBe('fallback');
    expect(hostErrorMessage(new Error(''), 'fallback', tw)).toBe('fallback');
  });
});
