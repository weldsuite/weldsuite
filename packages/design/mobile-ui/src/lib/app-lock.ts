/**
 * The rules of the app lock (`contexts/AppLockContext.tsx`), kept free of
 * React and native modules so they can be tested directly.
 */

export type LockMethod = 'faceId' | 'touchId' | 'fingerprint' | 'biometrics';

/**
 * The lock's text, in the app's language (the library holds no translations).
 * `faceId` … `biometrics` name the method in a sentence ("Lock with Face ID").
 */
export interface AppLockCopy {
  /** "WeldPass is locked". */
  title: string;
  /** Under the title: what unlocking gives access to. */
  description: string;
  /** The button on the lock screen. */
  unlock: string;
  /** The system prompt's reason when unlocking. */
  prompt: string;
  /** The system prompt's cancel button. */
  cancel: string;
  faceId: string;
  touchId: string;
  fingerprint: string;
  biometrics: string;
  /** Required lock on a phone with no screen lock at all: the screen that asks for one. */
  noScreenLockTitle?: string;
  noScreenLockDescription?: string;
  /** The button that opens the phone's settings from that screen. */
  openSettings?: string;
}

/** How long the app may sit in the background before it asks again. */
export const DEFAULT_LOCK_GRACE_MS = 60_000;

/** Whether coming back to the app asks for Face ID / the passcode again. */
export function shouldLockOnReturn(backgroundedAt: number | null, now: number, graceMs: number): boolean {
  return backgroundedAt != null && now - backgroundedAt > graceMs;
}

/**
 * Whether a `confirm()` (before a reveal or a copy) is still covered by the
 * previous one: within `windowMs`, so one Face ID covers a reveal and the
 * copy straight after it. A window of 0 asks every time.
 */
export function confirmationStillValid(confirmedAt: number | null, now: number, windowMs: number): boolean {
  return windowMs > 0 && confirmedAt != null && now >= confirmedAt && now - confirmedAt <= windowMs;
}

/** `LocalAuthentication.AuthenticationType` values, as numbers. */
export const AUTHENTICATION_TYPE = { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 } as const;

/** Which method the system prompt will use, for the lock's wording. */
export function lockMethodFor(types: readonly number[], os: string): LockMethod {
  if (types.includes(AUTHENTICATION_TYPE.FACIAL_RECOGNITION)) return os === 'ios' ? 'faceId' : 'biometrics';
  if (types.includes(AUTHENTICATION_TYPE.FINGERPRINT)) return os === 'ios' ? 'touchId' : 'fingerprint';
  return 'biometrics';
}

/** How the method is named in a sentence ("Lock with Face ID"). */
export function lockMethodLabel(copy: Pick<AppLockCopy, LockMethod>, method: LockMethod): string {
  return copy[method];
}

/** `LocalAuthentication.SecurityLevel.NONE`: no passcode, PIN, pattern or biometrics. */
export const SECURITY_LEVEL_NONE = 0;

/**
 * Whether the lock can be used: an optional lock needs enrolled biometrics
 * (WeldHR's switch); a required lock settles for any screen lock, since the
 * system prompt falls back to the device passcode.
 */
export function canUseLock(
  mode: 'optional' | 'required',
  device: { hasHardware: boolean; enrolled: boolean; securityLevel: number },
): boolean {
  if (mode === 'required') return device.securityLevel > SECURITY_LEVEL_NONE;
  return device.hasHardware && device.enrolled;
}
