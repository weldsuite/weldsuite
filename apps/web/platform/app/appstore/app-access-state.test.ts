import { describe, expect, it } from 'vitest';
import {
  accessBadgeTone,
  canInstallApp,
  canRequestAccess,
  getAppAccessInfo,
  parseAppAccessState,
} from './app-access-state';

describe('app store access state', () => {
  it('reads the optional catalog fields defensively', () => {
    expect(getAppAccessInfo({})).toEqual({ requiresApproval: false, status: 'none' });
    expect(getAppAccessInfo({ requiresApproval: true, accessStatus: 'requested' })).toEqual({
      requiresApproval: true,
      status: 'requested',
    });
    expect(getAppAccessInfo({ requiresApproval: true, accessStatus: 'nonsense' }).status).toBe('none');
    expect(parseAppAccessState(null)).toBe('none');
  });

  it('offers a request only when nothing is pending or granted', () => {
    expect(['none', 'rejected', 'revoked'].map((s) => canRequestAccess(parseAppAccessState(s)))).toEqual([
      true,
      true,
      true,
    ]);
    expect(['requested', 'approved', 'suspended'].map((s) => canRequestAccess(parseAppAccessState(s)))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('only installs an on-request app once approved', () => {
    expect(canInstallApp({ requiresApproval: false, status: 'none' })).toBe(true);
    expect(canInstallApp({ requiresApproval: true, status: 'requested' })).toBe(false);
    expect(canInstallApp({ requiresApproval: true, status: 'suspended' })).toBe(false);
    expect(canInstallApp({ requiresApproval: true, status: 'approved' })).toBe(true);
  });

  it('colours pending amber and suspended red', () => {
    expect(accessBadgeTone('requested')).toBe('warning');
    expect(accessBadgeTone('suspended')).toBe('danger');
    expect(accessBadgeTone('revoked')).toBe('danger');
    expect(accessBadgeTone('none')).toBe('neutral');
  });
});
