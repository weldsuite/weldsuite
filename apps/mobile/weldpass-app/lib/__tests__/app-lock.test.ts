import {
  AUTHENTICATION_TYPE,
  canUseLock,
  confirmationStillValid,
  lockMethodFor,
  lockMethodLabel,
  shouldLockOnReturn,
} from '@weldsuite/mobile-ui/lib/app-lock';

import { en } from '@/lib/i18n/locales/en';
import { nl } from '@/lib/i18n/locales/nl';

describe('the app lock (shared with WeldHR)', () => {
  it('asks again only after the grace period in the background', () => {
    expect(shouldLockOnReturn(null, 100_000, 60_000)).toBe(false);
    expect(shouldLockOnReturn(40_000, 100_000, 60_000)).toBe(false);
    expect(shouldLockOnReturn(40_000, 100_001, 60_000)).toBe(true);
  });

  it('lets one confirmation cover a reveal and the copy right after it', () => {
    expect(confirmationStillValid(null, 5_000, 10_000)).toBe(false);
    expect(confirmationStillValid(1_000, 5_000, 10_000)).toBe(true);
    expect(confirmationStillValid(1_000, 11_001, 10_000)).toBe(false);
    // A window of 0 asks every time; a clock that went backwards never counts.
    expect(confirmationStillValid(1_000, 1_000, 0)).toBe(false);
    expect(confirmationStillValid(5_000, 1_000, 10_000)).toBe(false);
  });

  it('names the method the phone will use', () => {
    expect(lockMethodFor([AUTHENTICATION_TYPE.FACIAL_RECOGNITION], 'ios')).toBe('faceId');
    expect(lockMethodFor([AUTHENTICATION_TYPE.FINGERPRINT], 'ios')).toBe('touchId');
    expect(lockMethodFor([AUTHENTICATION_TYPE.FINGERPRINT], 'android')).toBe('fingerprint');
    expect(lockMethodFor([AUTHENTICATION_TYPE.FACIAL_RECOGNITION], 'android')).toBe('biometrics');
    expect(lockMethodFor([], 'android')).toBe('biometrics');
    expect(lockMethodLabel(en.lock, 'faceId')).toBe('Face ID');
    expect(lockMethodLabel(nl.lock, 'fingerprint')).toBe('vingerafdruk');
  });

  it("is required in WeldPass on any phone with a screen lock, WeldHR's switch needs biometrics", () => {
    const passcodeOnly = { hasHardware: true, enrolled: false, securityLevel: 1 };
    const noLockAtAll = { hasHardware: true, enrolled: false, securityLevel: 0 };
    const faceId = { hasHardware: true, enrolled: true, securityLevel: 3 };
    expect(canUseLock('required', passcodeOnly)).toBe(true);
    expect(canUseLock('required', noLockAtAll)).toBe(false);
    expect(canUseLock('optional', passcodeOnly)).toBe(false);
    expect(canUseLock('optional', faceId)).toBe(true);
  });
});
