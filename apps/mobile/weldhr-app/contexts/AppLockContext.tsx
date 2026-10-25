/**
 * Optional Face ID / fingerprint lock.
 *
 * WeldHR holds payslips, bank details and sick reports, and phones get handed
 * around. When the member turns the lock on (Me → Settings) the app asks for
 * biometrics (or the device passcode) on launch and after it has been in the
 * background for a while. Off by default, and unavailable in the browser
 * preview and on devices without enrolled biometrics.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Lock } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { BRAND } from '@/constants/brand';
import { useI18n, type Translations } from '@/lib/i18n';

const STORAGE_KEY = '@weldsuite/weldhr:app-lock';
/** Coming back within this window does not ask again. */
const GRACE_MS = 60_000;

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

export type LockMethod = 'faceId' | 'touchId' | 'fingerprint' | 'biometrics';

interface AppLockValue {
  /** Biometrics are enrolled on this device, so the lock can be offered. */
  available: boolean;
  method: LockMethod;
  enabled: boolean;
  setEnabled: (enabled: boolean) => Promise<void>;
}

const AppLockContext = createContext<AppLockValue>({
  available: false,
  method: 'biometrics',
  enabled: false,
  setEnabled: async () => {},
});

export function useAppLock(): AppLockValue {
  return useContext(AppLockContext);
}

/** How the method is named in a sentence ("Lock with Face ID"). */
export function lockMethodLabel(t: Translations, method: LockMethod): string {
  return t.lock[method];
}

export function AppLockProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useI18n();
  const [available, setAvailable] = useState(false);
  const [method, setMethod] = useState<LockMethod>('biometrics');
  const [enabled, setEnabledState] = useState(false);
  const [locked, setLocked] = useState(false);
  const [ready, setReady] = useState(Platform.OS === 'web');
  const backgroundedAt = useRef<number | null>(null);
  const prompting = useRef(false);

  useEffect(() => {
    const auth = localAuth();
    if (!auth) {
      setReady(true);
      return;
    }
    void (async () => {
      try {
        const [hardware, enrolled, types, stored] = await Promise.all([
          auth.hasHardwareAsync(),
          auth.isEnrolledAsync(),
          auth.supportedAuthenticationTypesAsync(),
          AsyncStorage.getItem(STORAGE_KEY),
        ]);
        const canLock = hardware && enrolled;
        setAvailable(canLock);
        if (types.includes(auth.AuthenticationType.FACIAL_RECOGNITION)) {
          setMethod(Platform.OS === 'ios' ? 'faceId' : 'biometrics');
        } else if (types.includes(auth.AuthenticationType.FINGERPRINT)) {
          setMethod(Platform.OS === 'ios' ? 'touchId' : 'fingerprint');
        }
        const on = canLock && stored === 'on';
        setEnabledState(on);
        setLocked(on);
      } catch {
        // No lock rather than no app.
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const unlock = useCallback(async () => {
    const auth = localAuth();
    if (!auth || prompting.current) return;
    prompting.current = true;
    try {
      const result = await auth.authenticateAsync({ promptMessage: t.lock.prompt, cancelLabel: t.common.cancel });
      if (result.success) setLocked(false);
    } finally {
      prompting.current = false;
    }
  }, [t]);

  // Ask straight away when the lock screen appears.
  useEffect(() => {
    if (locked) void unlock();
  }, [locked, unlock]);

  useEffect(() => {
    if (!enabled) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        backgroundedAt.current = Date.now();
      } else if (state === 'active' && backgroundedAt.current != null) {
        if (Date.now() - backgroundedAt.current > GRACE_MS) setLocked(true);
        backgroundedAt.current = null;
      }
    });
    return () => subscription.remove();
  }, [enabled]);

  const setEnabled = useCallback(
    async (next: boolean) => {
      const auth = localAuth();
      if (!auth) return;
      // Turning it on proves the member can unlock before it can lock them out.
      if (next) {
        const result = await auth.authenticateAsync({ promptMessage: t.lock.prompt, cancelLabel: t.common.cancel });
        if (!result.success) return;
      }
      setEnabledState(next);
      try {
        await AsyncStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
      } catch {
        // Best effort: the switch still applies for this session.
      }
    },
    [t],
  );

  const value = useMemo(() => ({ available, method, enabled, setEnabled }), [available, method, enabled, setEnabled]);

  // Nothing renders until the stored setting is read, so payslips never flash
  // before the lock on a cold start. The lock itself is a native Modal so it
  // also covers screens presented as modals (leave/new, expense/new, sick).
  return (
    <AppLockContext.Provider value={value}>
      {ready ? children : <Blank />}
      <Modal
        visible={ready && locked}
        animationType="none"
        presentationStyle="fullScreen"
        statusBarTranslucent
        onRequestClose={() => {}}
      >
        <LockScreen onUnlock={unlock} />
      </Modal>
    </AppLockContext.Provider>
  );
}

function Blank() {
  const { colors } = useTheme();
  return <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]} />;
}

function LockScreen({ onUnlock }: Readonly<{ onUnlock: () => void }>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <View style={[styles.lock, { backgroundColor: colors.background }]}>
      <View style={[styles.lockIcon, { backgroundColor: 'rgba(13, 148, 136, 0.12)' }]}>
        <Lock size={32} color={BRAND} />
      </View>
      <Text style={[styles.lockTitle, { color: colors.text }]}>{t.lock.title}</Text>
      <Text style={[styles.lockText, { color: colors.mutedForeground }]}>{t.lock.description}</Text>
      <Pressable
        onPress={onUnlock}
        accessibilityRole="button"
        style={({ pressed }) => [styles.unlock, { opacity: pressed ? 0.85 : 1 }]}
      >
        <Text style={styles.unlockText}>{t.lock.unlock}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  lock: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  lockIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  lockTitle: { fontSize: 22, fontWeight: '700' },
  lockText: { fontSize: 15, textAlign: 'center' },
  unlock: { marginTop: 16, backgroundColor: BRAND, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 40 },
  unlockText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
