/**
 * Face ID / fingerprint / passcode lock over the whole app.
 *
 * Two modes:
 * - `optional` (WeldHR): off until the person switches it on; the choice is
 *   kept under `storageKey`. Offered only with enrolled biometrics.
 * - `required` (WeldPass): always on while signed in and can't be switched
 *   off. A phone without any screen lock can't use the app; it shows
 *   `noScreenLockTitle` instead.
 *
 * The app asks on launch and after it has been in the background for longer
 * than `graceMs`. `confirm()` asks again before something sensitive (a reveal,
 * a copy); one confirmation covers the next `confirmWindowMs`.
 *
 * The rules are in `lib/app-lock.ts`. Text comes from the app (`copy`).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Linking, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Lock } from 'lucide-react-native';
import { useTheme } from './ThemeContext';
import {
  DEFAULT_LOCK_GRACE_MS,
  canUseLock,
  confirmationStillValid,
  lockMethodFor,
  shouldLockOnReturn,
  type AppLockCopy,
  type LockMethod,
} from '../lib/app-lock';

export { lockMethodLabel, type AppLockCopy, type LockMethod } from '../lib/app-lock';

type LocalAuth = typeof import('expo-local-authentication');

/** Loaded lazily so the browser preview and older binaries never touch the native module. */
function localAuth(): LocalAuth | null {
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose, see above
    return require('expo-local-authentication') as LocalAuth;
  } catch {
    return null;
  }
}

export interface AppLockValue {
  /** The lock can be used on this device (see `canUseLock`). */
  available: boolean;
  method: LockMethod;
  /** The lock is on: always in `required` mode, the person's choice in `optional` mode. */
  enabled: boolean;
  required: boolean;
  /** Showing the lock screen right now. */
  locked: boolean;
  /** `optional` mode only: switch the lock on (after one successful prompt) or off. */
  setEnabled: (enabled: boolean) => Promise<void>;
  /**
   * Ask again before something sensitive. Resolves true when confirmed (or
   * the lock is off), false when the person cancelled.
   */
  confirm: (prompt?: string) => Promise<boolean>;
}

const AppLockContext = createContext<AppLockValue>({
  available: false,
  method: 'biometrics',
  enabled: false,
  required: false,
  locked: false,
  setEnabled: () => Promise.resolve(),
  confirm: () => Promise.resolve(true),
});

export function useAppLock(): AppLockValue {
  return useContext(AppLockContext);
}

export interface AppLockProviderProps {
  children: ReactNode;
  copy: AppLockCopy;
  /** The unlock button and the icon. */
  accentColor: string;
  /** Default `optional`. */
  mode?: 'optional' | 'required';
  /** `optional` mode: where the on/off choice is kept. */
  storageKey?: string;
  /** Default 60 s. */
  graceMs?: number;
  /** How long one confirmation covers the next `confirm()` (default 0: ask every time). */
  confirmWindowMs?: number;
  /**
   * Nothing to protect yet (signed out): the lock never shows. When it turns
   * false during a run (the person just signed in), the app stays unlocked.
   */
  disabled?: boolean;
  /**
   * Replaces the system prompt, e.g. reading a key that is itself behind
   * Face ID, so unlocking the app and opening its data is one prompt.
   * Resolving null falls back to the system prompt.
   */
  authenticate?: (prompt: string) => Promise<boolean | null>;
  /** After every unlock (launch, or back after the grace period). */
  onUnlock?: () => void;
}

export function AppLockProvider({
  children,
  copy,
  accentColor,
  mode = 'optional',
  storageKey,
  graceMs = DEFAULT_LOCK_GRACE_MS,
  confirmWindowMs = 0,
  disabled = false,
  authenticate,
  onUnlock,
}: Readonly<AppLockProviderProps>) {
  const required = mode === 'required';
  const [available, setAvailable] = useState(false);
  const [method, setMethod] = useState<LockMethod>('biometrics');
  const [chosen, setChosen] = useState(false);
  const [locked, setLocked] = useState(required);
  const [ready, setReady] = useState(Platform.OS === 'web');
  const backgroundedAt = useRef<number | null>(null);
  const confirmedAt = useRef<number | null>(null);
  const prompting = useRef(false);
  const wasDisabled = useRef(disabled);
  const enabled = required ? available : chosen;

  const readDevice = useCallback(async () => {
    const auth = localAuth();
    if (!auth) return;
    const [hasHardware, enrolled, types, securityLevel] = await Promise.all([
      auth.hasHardwareAsync(),
      auth.isEnrolledAsync(),
      auth.supportedAuthenticationTypesAsync(),
      auth.getEnrolledLevelAsync(),
    ]);
    setAvailable(canUseLock(mode, { hasHardware, enrolled, securityLevel }));
    setMethod(lockMethodFor(types, Platform.OS));
  }, [mode]);

  useEffect(() => {
    if (!localAuth()) {
      setLocked(false);
      setReady(true);
      return;
    }
    void (async () => {
      try {
        await readDevice();
        if (!required && storageKey) {
          const on = (await AsyncStorage.getItem(storageKey)) === 'on';
          setChosen(on);
          setLocked(on);
        }
      } catch {
        // An optional lock fails open (no lock rather than no app); a
        // required one stays shut and asks again on the next attempt.
        if (!required) setLocked(false);
      } finally {
        setReady(true);
      }
    })();
  }, [readDevice, required, storageKey]);

  // Signed in during this run: the person just proved who they are.
  useEffect(() => {
    if (wasDisabled.current && !disabled) {
      setLocked(false);
      confirmedAt.current = Date.now();
    }
    wasDisabled.current = disabled;
  }, [disabled]);

  const prompt = useCallback(
    async (message: string): Promise<boolean> => {
      if (authenticate) {
        const answered = await authenticate(message);
        if (answered !== null) return answered;
      }
      const auth = localAuth();
      if (!auth) return true;
      const result = await auth.authenticateAsync({ promptMessage: message, cancelLabel: copy.cancel });
      return result.success;
    },
    [authenticate, copy.cancel],
  );

  const unlock = useCallback(async () => {
    if (prompting.current) return;
    prompting.current = true;
    try {
      if (required) await readDevice();
      if (await prompt(copy.prompt)) {
        confirmedAt.current = Date.now();
        setLocked(false);
        onUnlock?.();
      }
    } catch {
      // Stays locked; the button asks again.
    } finally {
      prompting.current = false;
    }
  }, [copy.prompt, onUnlock, prompt, readDevice, required]);

  const showLock = ready && locked && enabled && !disabled;
  const noScreenLock = ready && required && !available && !disabled && Platform.OS !== 'web';

  // Ask straight away when the lock screen appears.
  useEffect(() => {
    if (showLock) void unlock();
  }, [showLock, unlock]);

  useEffect(() => {
    if (!enabled && !required) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        backgroundedAt.current = Date.now();
      } else if (state === 'active') {
        if (shouldLockOnReturn(backgroundedAt.current, Date.now(), graceMs)) setLocked(true);
        backgroundedAt.current = null;
        // A screen lock set up in Settings while the app waited.
        if (required) void readDevice().catch(() => {});
      }
    });
    return () => subscription.remove();
  }, [enabled, graceMs, readDevice, required]);

  const setEnabled = useCallback(
    async (next: boolean) => {
      if (required || !localAuth()) return;
      // Turning it on proves the person can unlock before it can lock them out.
      if (next && !(await prompt(copy.prompt))) return;
      setChosen(next);
      if (!storageKey) return;
      try {
        await AsyncStorage.setItem(storageKey, next ? 'on' : 'off');
      } catch {
        // Best effort: the switch still applies for this session.
      }
    },
    [copy.prompt, prompt, required, storageKey],
  );

  const confirm = useCallback(
    async (message?: string): Promise<boolean> => {
      if (!enabled || disabled) return true;
      if (confirmationStillValid(confirmedAt.current, Date.now(), confirmWindowMs)) return true;
      try {
        if (!(await prompt(message ?? copy.prompt))) return false;
      } catch {
        return false;
      }
      confirmedAt.current = Date.now();
      return true;
    },
    [confirmWindowMs, copy.prompt, disabled, enabled, prompt],
  );

  const value = useMemo<AppLockValue>(
    () => ({ available, method, enabled, required, locked: showLock || noScreenLock, setEnabled, confirm }),
    [available, method, enabled, required, showLock, noScreenLock, setEnabled, confirm],
  );

  // Nothing renders until the device is read, so data never flashes before
  // the lock on a cold start. The lock is a native Modal so it also covers
  // screens presented as modals.
  return (
    <AppLockContext.Provider value={value}>
      {ready ? children : <Blank />}
      <Modal
        visible={showLock || noScreenLock}
        animationType="none"
        presentationStyle="fullScreen"
        statusBarTranslucent
        onRequestClose={() => {}}
      >
        {noScreenLock ? (
          <LockScreen
            accentColor={accentColor}
            title={copy.noScreenLockTitle ?? copy.title}
            description={copy.noScreenLockDescription ?? copy.description}
            action={copy.openSettings ?? copy.unlock}
            onPress={() => void Linking.openSettings()}
          />
        ) : (
          <LockScreen
            accentColor={accentColor}
            title={copy.title}
            description={copy.description}
            action={copy.unlock}
            onPress={() => void unlock()}
          />
        )}
      </Modal>
    </AppLockContext.Provider>
  );
}

function Blank() {
  const { colors } = useTheme();
  return <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]} />;
}

/** `#rrggbb` at 12 % for the icon's circle; anything else gets a neutral grey. */
function soft(color: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return 'rgba(120, 120, 128, 0.12)';
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, 0.12)`;
}

function LockScreen({
  accentColor,
  title,
  description,
  action,
  onPress,
}: Readonly<{ accentColor: string; title: string; description: string; action: string; onPress: () => void }>) {
  const { colors } = useTheme();
  return (
    <View style={[styles.lock, { backgroundColor: colors.background }]}>
      <View style={[styles.lockIcon, { backgroundColor: soft(accentColor) }]}>
        <Lock size={32} color={accentColor} />
      </View>
      <Text style={[styles.lockTitle, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.lockText, { color: colors.mutedForeground }]}>{description}</Text>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        style={({ pressed }) => [styles.unlock, { backgroundColor: accentColor, opacity: pressed ? 0.85 : 1 }]}
      >
        <Text style={styles.unlockText}>{action}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  lock: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  lockIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  lockTitle: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  lockText: { fontSize: 15, textAlign: 'center' },
  unlock: { marginTop: 16, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 40 },
  unlockText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
