/**
 * Settings → Autofill (ADR PASS-010, phase 4C): whether WeldPass is the
 * phone's autofill provider, and the way to the system screen that turns it
 * on. Native autofill reads the offline copy, so the row only appears where
 * the phone keeps one. Hidden in builds without the native side.
 */

import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text } from 'react-native';
import { KeySquare } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { Group, GroupRow } from '@/components/Group';
import { useOffline } from '@/contexts/OfflineContext';
import { brandFor } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';
import { weldPassNative } from '@/modules/weldpass-native';

export function AutofillSettings() {
  const { t } = useI18n();
  const { theme } = useTheme();
  const offline = useOffline();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const brand = brandFor(theme);

  const refresh = useCallback(() => {
    void weldPassNative?.autofillEnabled?.().then(setEnabled).catch(() => setEnabled(null));
  }, []);

  useEffect(() => {
    refresh();
    // Back from the system settings: show the new state.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  if (!weldPassNative?.autofillEnabled || offline.status === 'off') return null;

  let subtitle = enabled ? t.settings.autofillOn : t.settings.autofillOff;
  if (offline.status === 'unavailable' || offline.status === 'disabled' || offline.status === 'revoked') {
    subtitle = t.settings.autofillNeedsCopy;
  }

  return (
    <Group title={t.settings.autofill}>
      <GroupRow
        icon={<KeySquare size={20} color={brand} />}
        title={t.settings.autofill}
        subtitle={subtitle}
        value={
          enabled ? (
            t.common.on
          ) : (
            <Pressable
              onPress={() => weldPassNative?.openAutofillSettings?.()}
              accessibilityRole="button"
              hitSlop={8}
              testID="autofill-turn-on"
            >
              <Text style={[styles.link, { color: brand }]}>{t.settings.autofillTurnOn}</Text>
            </Pressable>
          )
        }
      />
    </Group>
  );
}

const styles = StyleSheet.create({
  link: { fontSize: 15, fontWeight: '600' },
});
